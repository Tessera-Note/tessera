"""Пространства: заведение, правка, состав, удаление.

Правило, ради которого здесь всё написано: **пространство не остаётся без
администратора**. Снять последнего значит запереть пространство — правки настроек
и состава требуют администратора, а назначить нового изнутри уже некому.
Проверка стоит и на исключении, и на смене роли, потому что обойти её можно
любым из двух путей.
"""

from __future__ import annotations

import re
import unicodedata
import uuid

from sqlalchemy import delete, insert, or_, select, true, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import bad_request, forbidden, not_found
from tessera_api.domain.roles import (
    SPACE_RANK,
    SpaceRole,
    can_manage_space,
    is_workspace_admin,
)
from tessera_api.infrastructure.models import (
    Favorite,
    Group,
    GroupUser,
    Page,
    Space,
    SpaceMember,
    User,
    Watcher,
    Workspace,
)
from tessera_api.infrastructure.repositories import SpaceMemberRepo
from tessera_api.services.audit import AuditEvent, AuditResource, AuditService
from tessera_api.services.realtime import RealtimeService

#: Длина имени пространства. Имя стоит в боковой панели и в хлебных крошках.
MAX_NAME = 100

#: Длина короткого имени. Оно живёт в адресе страницы.
MAX_SLUG = 60

#: Сколько людей и групп принимается за один раз. Предел из v1: добавление
#: пачкой это удобство, а не способ переписать состав пространства одним
#: запросом.
MAX_BATCH = 25


def slugify(text: str | None) -> str:
    """Короткое имя из названия.

    Без транслитерации: кириллическое название даёт кириллическое короткое имя,
    и это верно — адрес всё равно кодируется браузером, а таблица соответствия
    была бы отдельным источником расхождений.
    """
    cleaned = unicodedata.normalize("NFKC", (text or "").strip()).lower()
    cleaned = re.sub(r"[^\w]+", "-", cleaned, flags=re.UNICODE)
    return re.sub(r"-{2,}", "-", cleaned).strip("-")[:MAX_SLUG]


#: Запрет публикации наружу и разрешение читателю комментировать. Пути те же,
#: что читают служба ссылок и проверка права комментировать: второе имя развело
#: бы запись с чтением, и переключатель перестал бы на что-либо влиять.
SHARING_DISABLED = ("sharing", "disabled")
VIEWER_COMMENTS = ("comments", "allowViewerComments")


def _flag(holder: Workspace | Space, path: tuple[str, str]) -> bool:
    """Признак из настроек рабочего пространства либо пространства."""
    settings: object = holder.settings or {}
    for key in path:
        if not isinstance(settings, dict):
            return False
        settings = settings.get(key)
        if settings is None:
            return False
    return bool(settings)


def space_flag(space: Space, path: tuple[str, str]) -> bool:
    """Признак настроек пространства. Наружу — для сборки ответа маршрутом."""
    return _flag(space, path)


def _set_flag(holder: Workspace | Space, path: tuple[str, str], value: bool) -> None:
    """Записать признак в JSON настроек.

    Словарь пересобирается целиком: правка вложенного словаря на месте не
    помечает поле изменённым, и SQLAlchemy такую правку не сохраняет.
    """
    section, field = path
    settings = dict(holder.settings or {})
    block = dict(settings.get(section) or {})
    block[field] = value
    settings[section] = block
    holder.settings = settings


class SpaceService:
    def __init__(self, session: AsyncSession, realtime: RealtimeService | None = None) -> None:
        self._session = session
        self._members = SpaceMemberRepo(session)
        self._audit = AuditService(session)
        # `None` означает «канал не трогать»: так собирают службу проверки.
        self._realtime = realtime

    async def _space(self, space_id: uuid.UUID, workspace_id: uuid.UUID) -> Space:
        space = await self._session.get(Space, space_id)
        if space is None or space.workspace_id != workspace_id or space.deleted_at is not None:
            raise not_found("error.space.space_not_found")
        return space

    async def _require_manager(self, space: Space, user_id: uuid.UUID) -> None:
        role = await self._members.role_in_space(user_id, space.id)
        if role is None:
            # «Не найдено», а не «отказано»: посторонний не должен по ответу
            # узнавать, что такое пространство существует.
            raise not_found("error.space.space_not_found")
        if not can_manage_space(role):
            raise forbidden("error.space.access_denied")

    async def personal(self, user_id: uuid.UUID, workspace_id: uuid.UUID) -> Space | None:
        """Личное пространство человека, если оно заведено."""
        return (
            await self._session.execute(
                select(Space)
                .where(Space.workspace_id == workspace_id)
                .where(Space.creator_id == user_id)
                # Сравнение с `true()`, а не `is_(True)`: у базы частичный
                # уникальный индекс с условием `is_personal`, и из проверки
                # `IS TRUE` PostgreSQL его условие не выводит — обход идёт по
                # соседнему индексу с фильтром.
                .where(Space.is_personal == true())
                .where(Space.deleted_at.is_(None))
            )
        ).scalar_one_or_none()

    async def create_personal(
        self, actor: User, workspace_id: uuid.UUID, *, name: str | None = None
    ) -> Space:
        """Завести личное пространство.

        Разрешение спрашивается у рабочего пространства: личные пространства
        включаются переключателем, и без него заводить их нельзя — иначе
        участники расходятся по своим углам вопреки решению администратора.

        Второе личное завести нельзя. Правило держит база частичным уникальным
        индексом, но проверка стоит и здесь: отказ базы дошёл бы до человека
        как пятисотый ответ, а не как объяснимая причина.
        """
        workspace = await self._session.get(Workspace, workspace_id)
        if workspace is None:
            raise not_found("error.common.workspace_not_found")
        if not _flag(workspace, ("spaces", "allowPersonal")):
            raise bad_request("error.space.personal_spaces_are_not_enabled")

        if await self.personal(actor.id, workspace_id) is not None:
            raise bad_request("error.space.you_already_have_a_personal_space")

        title = (name or "").strip() or f"{actor.name or actor.email}"
        # Место под счётчик отрезается заранее: `create` прогоняет короткое имя
        # через `slugify` заново, и приписанный к предельной длине суффикс он
        # срезал бы — тёзка получал бы отказ «адрес занят» вместо соседнего
        # адреса.
        base = (slugify(title) or "personal")[: MAX_SLUG - 4]
        short = base
        counter = 1
        while await self._slug_taken(short, workspace_id):
            short = f"{base}-{counter}"
            counter += 1

        try:
            return await self.create(actor, workspace_id, name=title, slug=short, personal=True)
        except IntegrityError as failure:
            # Кнопку нажали дважды, и второе нажатие обогнало первую запись.
            # Проверка выше этого не ловит: между нею и вставкой есть время.
            # Правило держит база, а человеку нужен внятный отказ, а не пятисотый.
            await self._session.rollback()
            raise bad_request("error.space.you_already_have_a_personal_space") from failure

    async def _slug_taken(
        self, slug: str, workspace_id: uuid.UUID, *, besides: uuid.UUID | None = None
    ) -> bool:
        stmt = (
            select(Space.id)
            .where(Space.workspace_id == workspace_id)
            .where(Space.slug == slug)
            .where(Space.deleted_at.is_(None))
        )
        if besides is not None:
            stmt = stmt.where(Space.id != besides)
        return (await self._session.execute(stmt.limit(1))).first() is not None

    async def create(
        self,
        actor: User,
        workspace_id: uuid.UUID,
        *,
        name: str,
        description: str | None = None,
        slug: str | None = None,
        personal: bool = False,
    ) -> Space:
        """Завести пространство.

        Заводит администратор рабочего пространства — так же, как в v1: обычный
        участник видит пространства, но не создаёт их.

        Заводящий сразу становится администратором пространства. Иначе оно
        появляется пустым и без хозяина, и распорядиться им некому.
        """
        # Личное пространство человек заводит себе сам, и права
        # администратора для этого не требуется: доступ к нему есть только у
        # него. Все прочие заводит администратор — так же, как в v1.
        if not personal and not is_workspace_admin(actor.role):
            raise forbidden("error.common.admin_required")

        clean = (name or "").strip()
        if not clean or len(clean) > MAX_NAME:
            raise bad_request("error.space.name_invalid")

        short = slugify(slug or clean)
        if not short:
            raise bad_request("error.space.slug_invalid")
        if await self._slug_taken(short, workspace_id):
            raise bad_request("error.space.slug_taken")

        space_id = uuid.uuid4()
        await self._session.execute(
            insert(Space).values(
                id=space_id,
                name=clean,
                slug=short,
                description=(description or "").strip() or None,
                creator_id=actor.id,
                workspace_id=workspace_id,
                is_personal=personal,
            )
        )
        await self._session.execute(
            insert(SpaceMember).values(
                id=uuid.uuid4(),
                user_id=actor.id,
                space_id=space_id,
                role=SpaceRole.ADMIN,
                added_by_id=actor.id,
            )
        )
        await self._audit.log(
            event=AuditEvent.SPACE_CREATED,
            resource_type=AuditResource.SPACE,
            resource_id=space_id,
            user_id=actor.id,
            workspace_id=workspace_id,
            space_id=space_id,
            metadata={"name": clean, "slug": short},
        )
        try:
            await self._session.commit()
        except IntegrityError as failure:
            # Двое заняли одно короткое имя разом: проверка выше этого не ловит,
            # между нею и записью есть время. Правило держит база, а человеку
            # нужен тот же внятный отказ, что и при обычном совпадении.
            await self._session.rollback()
            raise bad_request("error.space.slug_taken") from failure
        return await self._session.get(Space, space_id)

    async def update(
        self,
        actor: User,
        space_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        name: str | None = None,
        description: str | None = None,
        slug: str | None = None,
        disable_public_sharing: bool | None = None,
        allow_viewer_comments: bool | None = None,
    ) -> Space:
        """Поправить имя, короткое имя, описание или признаки безопасности.

        Поле, которого нет в запросе, не трогается: экран шлёт изменённое.
        """
        space = await self._space(space_id, workspace_id)
        await self._require_manager(space, actor.id)

        changed: list[str] = []

        if name is not None:
            clean = name.strip()
            if not clean or len(clean) > MAX_NAME:
                raise bad_request("error.space.name_invalid")
            if clean != space.name:
                space.name = clean
                changed.append("name")

        if slug is not None:
            short = slugify(slug)
            if not short:
                raise bad_request("error.space.slug_invalid")
            if short != space.slug:
                if await self._slug_taken(short, workspace_id, besides=space.id):
                    raise bad_request("error.space.slug_taken")
                # Короткое имя стоит в адресе каждой страницы пространства.
                # Прежние ссылки после смены перестают открываться, и это
                # осознанная цена правки, а не побочный эффект.
                space.slug = short
                changed.append("slug")

        if description is not None:
            space.description = description.strip() or None
            changed.append("description")

        for value, path in (
            (disable_public_sharing, SHARING_DISABLED),
            (allow_viewer_comments, VIEWER_COMMENTS),
        ):
            if value is None or _flag(space, path) == bool(value):
                continue
            _set_flag(space, path, bool(value))
            # В журнал уходит имя поля запроса, а не путь в JSON: журнал читает
            # человек, и «disabled» без раздела в нём ничего не значит.
            changed.append("disablePublicSharing" if path is SHARING_DISABLED else path[1])

        if not changed:
            return space

        await self._audit.log(
            event=AuditEvent.SPACE_UPDATED,
            resource_type=AuditResource.SPACE,
            resource_id=space.id,
            user_id=actor.id,
            workspace_id=workspace_id,
            space_id=space.id,
            changes={"fields": changed},
        )
        try:
            await self._session.commit()
        except IntegrityError as failure:
            # Та же гонка, что и при создании: имя заняли между проверкой и
            # записью. Отказ здесь тот же, что при обычном совпадении.
            await self._session.rollback()
            raise bad_request("error.space.slug_taken") from failure
        await self._session.refresh(space)
        return space

    async def delete(self, actor: User, space_id: uuid.UUID, workspace_id: uuid.UUID) -> None:
        """Удалить пространство вместе со страницами.

        Удаление мягкое и у пространства, и у страниц: строки остаются, выдача
        их не показывает. Жёсткое удаление уносило бы историю, комментарии и
        вложения без возможности разобрать происшествие.

        Последнее пространство не удаляется: рабочее пространство без единого
        space не даёт ни завести страницу, ни попасть куда-либо с домашнего
        экрана, а завести новое может только администратор.
        """
        space = await self._space(space_id, workspace_id)
        await self._require_manager(space, actor.id)

        alive = (
            await self._session.execute(
                select(Space.id)
                .where(Space.workspace_id == workspace_id)
                .where(Space.deleted_at.is_(None))
                .limit(2)
            )
        ).all()
        if len(alive) <= 1:
            raise bad_request("error.space.last_space")

        moment = _now()
        await self._session.execute(
            update(Space).where(Space.id == space.id).values(deleted_at=moment)
        )
        await self._session.execute(
            update(Page)
            .where(Page.space_id == space.id)
            .where(Page.deleted_at.is_(None))
            .values(deleted_at=moment)
        )
        await self._session.execute(
            update(SpaceMember)
            .where(SpaceMember.space_id == space.id)
            .where(SpaceMember.deleted_at.is_(None))
            .values(deleted_at=moment)
        )
        await self._audit.log(
            event=AuditEvent.SPACE_DELETED,
            resource_type=AuditResource.SPACE,
            resource_id=space.id,
            user_id=actor.id,
            workspace_id=workspace_id,
            space_id=space.id,
            metadata={"name": space.name, "slug": space.slug},
        )
        await self._session.commit()

        # Подписки и отметки снимаются у всех: доступ потеряли все разом.
        # Оставленные, они продолжали бы числиться в избранном и приводить
        # человека на удалённую страницу — тот же класс, что при выводе
        # человека из пространства, только шире.
        touched = await self._affected_users(space.id, include_removed=True)
        await self._forget_without_access(space.id, touched)
        await self._refresh_rooms(touched)

    async def members(
        self, space_id: uuid.UUID, workspace_id: uuid.UUID, user_id: uuid.UUID
    ) -> list[dict]:
        """Состав пространства: люди и группы с их ролями.

        Виден каждому, кто в пространстве состоит: без него нельзя ни выдать
        доступ к странице, ни понять, кто вообще эту страницу видит.
        """
        space = await self._space(space_id, workspace_id)
        if await self._members.role_in_space(user_id, space.id) is None:
            raise forbidden("error.space.access_denied")

        rows = (
            await self._session.execute(
                select(SpaceMember, User, Group)
                .outerjoin(User, User.id == SpaceMember.user_id)
                .outerjoin(Group, Group.id == SpaceMember.group_id)
                .where(SpaceMember.space_id == space.id)
                .where(SpaceMember.deleted_at.is_(None))
                .order_by(SpaceMember.group_id.is_(None), Group.name, User.name)
            )
        ).all()

        return [
            {
                "id": member.id,
                "role": member.role,
                "userId": member.user_id,
                "groupId": member.group_id,
                "name": (group.name if member.group_id else (person.name if person else None)),
                "email": None if member.group_id else (person.email if person else None),
                "type": "group" if member.group_id else "user",
            }
            for member, person, group in rows
        ]

    async def add_members(
        self,
        actor: User,
        space_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        role: str,
        user_ids: list[uuid.UUID] | None = None,
        group_ids: list[uuid.UUID] | None = None,
    ) -> int:
        """Добавить людей и группы пачкой.

        Чужие идентификаторы отбрасываются молча: перебор чужого рабочего
        пространства не должен давать разные ответы на «нет такого» и «есть, но
        не ваш». Уже состоящие пропускаются — повторное добавление это не
        ошибка, а обычный повтор действия.
        """
        space = await self._space(space_id, workspace_id)
        await self._require_manager(space, actor.id)

        if role not in SPACE_RANK:
            raise bad_request("error.space.unknown_role")

        users = list(dict.fromkeys(user_ids or []))
        groups = list(dict.fromkeys(group_ids or []))
        if not users and not groups:
            raise bad_request("error.space.provide_a_user_or_a_group")
        if len(users) + len(groups) > MAX_BATCH:
            raise bad_request("error.space.too_many_members")

        if users:
            users = list(
                (
                    await self._session.execute(
                        select(User.id)
                        .where(User.id.in_(users))
                        .where(User.workspace_id == workspace_id)
                        .where(User.deleted_at.is_(None))
                    )
                ).scalars()
            )
        if groups:
            groups = list(
                (
                    await self._session.execute(
                        select(Group.id)
                        .where(Group.id.in_(groups))
                        .where(Group.workspace_id == workspace_id)
                        .where(Group.deleted_at.is_(None))
                    )
                ).scalars()
            )

        existing_users = set(
            (
                await self._session.execute(
                    select(SpaceMember.user_id)
                    .where(SpaceMember.space_id == space.id)
                    .where(SpaceMember.user_id.isnot(None))
                    .where(SpaceMember.deleted_at.is_(None))
                )
            ).scalars()
        )
        existing_groups = set(
            (
                await self._session.execute(
                    select(SpaceMember.group_id)
                    .where(SpaceMember.space_id == space.id)
                    .where(SpaceMember.group_id.isnot(None))
                    .where(SpaceMember.deleted_at.is_(None))
                )
            ).scalars()
        )

        # Снятие мягкое, а уникальность пар «пространство — человек» и
        # «пространство — группа» на отметку не смотрит: вернуть снятого можно
        # только оживив его прежнюю строку, новая упёрлась бы в ограничение.
        removed = {
            (row.user_id, row.group_id): row.id
            for row in (
                await self._session.execute(
                    select(SpaceMember.id, SpaceMember.user_id, SpaceMember.group_id)
                    .where(SpaceMember.space_id == space.id)
                    .where(SpaceMember.deleted_at.isnot(None))
                )
            ).all()
        }

        added = 0
        for one in users:
            if one in existing_users:
                continue
            await self._put_member(space.id, removed.get((one, None)), role, actor.id, user_id=one)
            added += 1
        for one in groups:
            if one in existing_groups:
                continue
            await self._put_member(space.id, removed.get((None, one)), role, actor.id, group_id=one)
            added += 1

        if added:
            await self._audit.log(
                event=AuditEvent.SPACE_MEMBER_ADDED,
                resource_type=AuditResource.SPACE,
                resource_id=space.id,
                user_id=actor.id,
                workspace_id=workspace_id,
                space_id=space.id,
                metadata={"role": role, "added": added},
            )
        await self._session.commit()
        if added:
            await self._refresh_rooms(await self._affected_users(space.id))
        return added

    async def remove_member(
        self,
        actor: User,
        space_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        user_id: uuid.UUID | None = None,
        group_id: uuid.UUID | None = None,
    ) -> None:
        """Исключить человека или группу.

        Подписки и избранное тех, кто потерял доступ, снимаются здесь же: без
        этого исключённый продолжает получать письма о правках страниц, которых
        больше не видит.
        """
        space = await self._space(space_id, workspace_id)
        await self._require_manager(space, actor.id)

        member = await self._membership(space.id, user_id=user_id, group_id=group_id)
        if member.role == SpaceRole.ADMIN:
            await self._assert_not_last_admin(space.id, member.id)

        affected = await self._members_of(user_id=user_id, group_id=group_id)

        await self._session.execute(
            update(SpaceMember).where(SpaceMember.id == member.id).values(deleted_at=_now())
        )
        await self._audit.log(
            event=AuditEvent.SPACE_MEMBER_REMOVED,
            resource_type=AuditResource.SPACE,
            resource_id=space.id,
            user_id=actor.id,
            workspace_id=workspace_id,
            space_id=space.id,
            metadata={
                "userId": str(user_id) if user_id else None,
                "groupId": str(group_id) if group_id else None,
            },
        )
        await self._session.commit()

        await self._forget_without_access(space.id, affected)
        await self._refresh_rooms(affected)

    async def change_role(
        self,
        actor: User,
        space_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        role: str,
        user_id: uuid.UUID | None = None,
        group_id: uuid.UUID | None = None,
    ) -> None:
        """Сменить роль участника.

        Понижение последнего администратора запрещено по той же причине, что и
        исключение: пространство осталось бы без хозяина.
        """
        space = await self._space(space_id, workspace_id)
        await self._require_manager(space, actor.id)

        if role not in SPACE_RANK:
            raise bad_request("error.space.unknown_role")

        member = await self._membership(space.id, user_id=user_id, group_id=group_id)
        if member.role == SpaceRole.ADMIN and role != SpaceRole.ADMIN:
            await self._assert_not_last_admin(space.id, member.id)

        if member.role == role:
            return

        await self._session.execute(
            update(SpaceMember).where(SpaceMember.id == member.id).values(role=role)
        )
        await self._audit.log(
            event=AuditEvent.SPACE_MEMBER_ROLE_CHANGED,
            resource_type=AuditResource.SPACE,
            resource_id=space.id,
            user_id=actor.id,
            workspace_id=workspace_id,
            space_id=space.id,
            changes={"before": {"role": member.role}, "after": {"role": role}},
        )
        await self._session.commit()
        await self._refresh_rooms(await self._members_of(user_id=user_id, group_id=group_id))

    async def _membership(
        self,
        space_id: uuid.UUID,
        *,
        user_id: uuid.UUID | None,
        group_id: uuid.UUID | None,
    ) -> SpaceMember:
        if (user_id is None) == (group_id is None):
            # Ровно одно из двух: иначе непонятно, кого именно трогают.
            raise bad_request("error.space.provide_a_user_or_a_group")

        stmt = (
            select(SpaceMember)
            .where(SpaceMember.space_id == space_id)
            .where(SpaceMember.deleted_at.is_(None))
        )
        stmt = (
            stmt.where(SpaceMember.user_id == user_id)
            if user_id is not None
            else stmt.where(SpaceMember.group_id == group_id)
        )
        found = (await self._session.execute(stmt)).scalar_one_or_none()
        if found is None:
            raise not_found("error.space.space_membership_not_found")
        return found

    async def _assert_not_last_admin(self, space_id: uuid.UUID, besides: uuid.UUID) -> None:
        """Отказать, если после действия администраторов не останется.

        Считаются люди, а не строки состава: роль приходит и через группу, и
        счёт по строкам сказал бы, что администратор есть, когда единственная
        оставшаяся строка — группа без людей.

        Сравнивается «было» с «станет». Пространство, где администраторов нет
        и так, этим правилом не запирается: иначе починить его стало бы нельзя.
        """
        before = await self._members.admin_user_ids(space_id)
        if not before:
            return
        after = await self._members.admin_user_ids(space_id, without_membership=besides)
        if not after:
            raise bad_request("error.space.last_admin")

    async def _members_of(
        self, *, user_id: uuid.UUID | None, group_id: uuid.UUID | None
    ) -> list[uuid.UUID]:
        """Кого затронуло действие: сам человек либо состав группы."""
        if user_id is not None:
            return [user_id]
        if group_id is None:
            return []
        return list(
            (
                await self._session.execute(
                    select(GroupUser.user_id).where(GroupUser.group_id == group_id)
                )
            ).scalars()
        )

    async def _affected_users(
        self, space_id: uuid.UUID, *, include_removed: bool = False
    ) -> list[uuid.UUID]:
        stmt = (
            select(SpaceMember.user_id)
            .where(SpaceMember.space_id == space_id)
            .where(SpaceMember.user_id.isnot(None))
        )
        if not include_removed:
            stmt = stmt.where(SpaceMember.deleted_at.is_(None))
        return [one for one in (await self._session.execute(stmt)).scalars() if one]

    async def _put_member(
        self,
        space_id: uuid.UUID,
        removed_id: uuid.UUID | None,
        role: str,
        added_by_id: uuid.UUID,
        *,
        user_id: uuid.UUID | None = None,
        group_id: uuid.UUID | None = None,
    ) -> None:
        """Завести членство либо вернуть снятое его прежней строкой."""
        if removed_id is not None:
            await self._session.execute(
                update(SpaceMember)
                .where(SpaceMember.id == removed_id)
                .values(deleted_at=None, role=role, added_by_id=added_by_id)
            )
            return
        await self._session.execute(
            insert(SpaceMember).values(
                id=uuid.uuid4(),
                user_id=user_id,
                group_id=group_id,
                space_id=space_id,
                role=role,
                added_by_id=added_by_id,
            )
        )

    async def _forget_without_access(self, space_id: uuid.UUID, user_ids: list[uuid.UUID]) -> None:
        """Снять подписки и избранное у тех, кто потерял доступ.

        Проверяется именно потеря доступа, а не факт исключения: человек мог
        остаться в пространстве через группу, и снимать его подписки было бы
        неверно.
        """
        if not user_ids:
            return

        still = await self._members.members_of(space_id)
        lost = [one for one in user_ids if one not in still]
        if not lost:
            return

        pages = select(Page.id).where(Page.space_id == space_id)
        await self._session.execute(
            delete(Watcher).where(Watcher.user_id.in_(lost)).where(Watcher.page_id.in_(pages))
        )
        await self._session.execute(
            delete(Favorite)
            .where(Favorite.user_id.in_(lost))
            .where(or_(Favorite.space_id == space_id, Favorite.page_id.in_(pages)))
        )
        await self._session.commit()

    async def _refresh_rooms(self, user_ids: list[uuid.UUID]) -> None:
        """Привести комнаты канала событий в соответствие с правами.

        Перечень пространств вычисляется при подключении сокета и сам не
        пересматривается: без этого шага снятый участник продолжает получать
        события пространства до переподключения.
        """
        if self._realtime is None:
            return
        for one in user_ids:
            await self._realtime.resync_user(one)


def _now():  # noqa: ANN202 — время берётся одним способом во всей службе
    from datetime import UTC, datetime

    return datetime.now(UTC)
