"""Шаблоны страниц.

Шаблон это отдельная запись, а не страница: применение создаёт обычную
страницу и никакой связи с шаблоном не оставляет. Так в v1, и менять это здесь
не надо — колонки, которая хранила бы связь, в базе нет.

Область видимости ровно одна и кодируется `space_id`: пусто — шаблон рабочего
пространства, иначе шаблон одного пространства. От неё зависит и кто его видит,
и кто может править.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import delete, insert, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import bad_request, forbidden, not_found
from tessera_api.domain.roles import can_write_space, is_workspace_admin
from tessera_api.infrastructure.models import Page, Space, Template, User, Workspace
from tessera_api.infrastructure.repositories import SpaceMemberRepo
from tessera_api.services.pages import PageService, extract_text

#: Пустой документ. Подставляется вместо отсутствующего содержимого: `None` в
#: колонке означал бы шаблон, который редактор открыть не может.
EMPTY_DOC: dict[str, Any] = {"type": "doc", "content": [{"type": "paragraph"}]}

MAX_TITLE = 255
MAX_DESCRIPTION = 2000

#: Путь к признаку, разрешающему обычным участникам заводить шаблоны
#: пространств. Хранится в настройках рабочего пространства, как в v1.
MEMBER_TEMPLATES_SETTING = ("templates", "allowMemberTemplates")


def _member_templates_allowed(workspace: Workspace) -> bool:
    settings = workspace.settings or {}
    for key in MEMBER_TEMPLATES_SETTING:
        if not isinstance(settings, dict):
            return False
        settings = settings.get(key)
        if settings is None:
            return False
    return bool(settings)


class TemplateService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._members = SpaceMemberRepo(session)

    async def _load(self, template_id: uuid.UUID, workspace_id: uuid.UUID) -> Template:
        found = await self._session.get(Template, template_id)
        if found is None or found.deleted_at is not None or found.workspace_id != workspace_id:
            raise not_found("error.template.not_found")
        return found

    async def _authorize_scope(
        self,
        *,
        user: User,
        workspace: Workspace,
        space_id: uuid.UUID | None,
        edit: bool,
    ) -> None:
        """Проверить права на область видимости шаблона.

        Области две, и правила у них разные.

        Шаблон рабочего пространства: править может только администратор
        рабочего пространства, читать — любой вошедший в него. Такой шаблон
        виден всем, и раздача права его менять сравнима с раздачей права менять
        настройки.

        Шаблон пространства: править может тот, кто может править страницы в
        нём, но обычному участнику это разрешено только при включённом
        признаке в настройках рабочего пространства. Читать — любой участник
        пространства.
        """
        if space_id is None:
            if edit and not is_workspace_admin(user.role):
                raise forbidden("error.common.admin_required")
            return

        space = await self._session.get(Space, space_id)
        if space is None or space.deleted_at is not None or space.workspace_id != workspace.id:
            raise not_found("error.space.not_found")

        role = await self._members.role_in_space(user.id, space_id)
        if role is None:
            raise forbidden("error.space.access_denied")
        if not edit:
            return

        if not can_write_space(role):
            raise forbidden("error.space.write_denied")

        # Признак проверяется только для обычного участника: у администратора
        # рабочего пространства право и так есть, и запирать его признаком,
        # который он же и переключает, бессмысленно.
        if not is_workspace_admin(user.role) and not _member_templates_allowed(workspace):
            raise forbidden("error.template.member_templates_disabled")

    def _view(self, template: Template, *, with_content: bool = False) -> dict:
        body = {
            "id": template.id,
            "title": template.title,
            "description": template.description,
            "icon": template.icon,
            "spaceId": template.space_id,
            "creatorId": template.creator_id,
            "createdAt": template.created_at,
            "updatedAt": template.updated_at,
        }
        if with_content:
            body["content"] = template.content
        return body

    async def list(self, user: User, workspace_id: uuid.UUID) -> list[dict]:
        """Шаблоны, доступные человеку.

        Видимость режется запросом, а не после выборки: иначе постраничная
        выдача считала бы страницы по недоступным записям, и страницы выходили
        бы разной длины.

        Содержимое здесь не отдаётся никогда. Список открывают ради выбора, а
        содержимое каждого шаблона в нём — это лишние килобайты на каждый
        показ списка.
        """
        space_ids = await self._members.space_ids_for(user.id)

        stmt = (
            select(Template)
            .where(Template.workspace_id == workspace_id)
            .where(Template.deleted_at.is_(None))
            .order_by(Template.updated_at.desc())
        )
        if space_ids:
            stmt = stmt.where(
                or_(Template.space_id.is_(None), Template.space_id.in_(space_ids))
            )
        else:
            stmt = stmt.where(Template.space_id.is_(None))

        found = (await self._session.execute(stmt)).scalars().all()
        return [self._view(one) for one in found]

    async def info(
        self, template_id: uuid.UUID, user: User, workspace: Workspace
    ) -> dict:
        template = await self._load(template_id, workspace.id)
        await self._authorize_scope(
            user=user, workspace=workspace, space_id=template.space_id, edit=False
        )
        return self._view(template, with_content=True)

    def _check_text(self, title: str | None, description: str | None) -> None:
        if title is not None and not title.strip():
            raise bad_request("error.template.title_required")
        if title is not None and len(title) > MAX_TITLE:
            raise bad_request("error.template.title_too_long")
        if description is not None and len(description) > MAX_DESCRIPTION:
            raise bad_request("error.template.description_too_long")

    async def create(
        self,
        *,
        user: User,
        workspace: Workspace,
        title: str,
        description: str | None = None,
        icon: str | None = None,
        content: dict | None = None,
        space_id: uuid.UUID | None = None,
    ) -> dict:
        self._check_text(title, description)
        await self._authorize_scope(
            user=user, workspace=workspace, space_id=space_id, edit=True
        )

        body = content or EMPTY_DOC
        template_id = uuid.uuid4()
        await self._session.execute(
            insert(Template).values(
                id=template_id,
                title=title.strip(),
                description=description,
                icon=icon,
                content=body,
                text_content=extract_text(body),
                space_id=space_id,
                workspace_id=workspace.id,
                creator_id=user.id,
                last_updated_by_id=user.id,
            )
        )
        await self._session.commit()
        return self._view(await self._session.get(Template, template_id), with_content=True)

    async def update(
        self,
        *,
        template_id: uuid.UUID,
        user: User,
        workspace: Workspace,
        title: str | None = None,
        description: str | None = None,
        icon: str | None = None,
        content: dict | None = None,
        space_id: uuid.UUID | None = None,
        move: bool = False,
    ) -> dict:
        """Изменить шаблон.

        `move` отделяет «область не меняем» от «переносим в рабочее
        пространство»: `space_id=None` без него означало бы первое, и перенести
        шаблон пространства в общие стало бы нечем.
        """
        self._check_text(title, description)
        template = await self._load(template_id, workspace.id)

        # Права на нынешнюю область — иначе перенос был бы способом забрать
        # чужой шаблон: хватило бы права на область, куда переносишь.
        await self._authorize_scope(
            user=user, workspace=workspace, space_id=template.space_id, edit=True
        )
        if move:
            await self._authorize_scope(
                user=user, workspace=workspace, space_id=space_id, edit=True
            )

        values: dict[str, Any] = {"last_updated_by_id": user.id}
        if title is not None:
            values["title"] = title.strip()
        if description is not None:
            values["description"] = description
        if icon is not None:
            values["icon"] = icon
        if content is not None:
            values["content"] = content
            # Плоский текст обновляется вместе с содержимым: разойдясь, они
            # дают шаблон, который не находится поиском по собственному тексту.
            values["text_content"] = extract_text(content)
        if move:
            values["space_id"] = space_id

        await self._session.execute(
            update(Template).where(Template.id == template.id).values(**values)
        )
        await self._session.commit()
        return self._view(await self._session.get(Template, template.id), with_content=True)

    async def delete(
        self, template_id: uuid.UUID, user: User, workspace: Workspace
    ) -> None:
        template = await self._load(template_id, workspace.id)
        await self._authorize_scope(
            user=user, workspace=workspace, space_id=template.space_id, edit=True
        )
        await self._session.execute(delete(Template).where(Template.id == template.id))
        await self._session.commit()

    async def use(
        self,
        *,
        template_id: uuid.UUID,
        user: User,
        workspace: Workspace,
        space_id: uuid.UUID,
        parent_page_id: uuid.UUID | None = None,
    ) -> dict:
        """Создать страницу из шаблона.

        Читать шаблон достаточно, чтобы им воспользоваться, но страница
        создаётся обычным путём, со всеми проверками права писать в целевое
        пространство: шаблон не даёт доступа туда, куда его нет.
        """
        template = await self._load(template_id, workspace.id)
        await self._authorize_scope(
            user=user, workspace=workspace, space_id=template.space_id, edit=False
        )

        page = await PageService(self._session).create(
            user_id=user.id,
            workspace_id=workspace.id,
            space_id=space_id,
            title=template.title,
            content=template.content or EMPTY_DOC,
            parent_page_id=parent_page_id,
        )
        if template.icon:
            # Значок переносится отдельным запросом: создание страницы его не
            # принимает, а заводить ради этого параметр в общем пути создания
            # значило бы менять подпись публичного метода ради одного вызова.
            await self._session.execute(
                update(Page).where(Page.id == page.id).values(icon=template.icon)
            )
            await self._session.commit()
            page = await self._session.get(Page, page.id)

        return {
            "id": page.id,
            "slugId": page.slug_id,
            "title": page.title,
            "icon": page.icon,
            "spaceId": page.space_id,
        }
