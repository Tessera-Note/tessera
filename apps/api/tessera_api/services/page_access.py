"""Права на страницу.

Правило v1, перенесённое дословно: **любая выдача содержимого страницы обязана
пройти здесь**, а не ограничиться проверкой членства в пространстве. Членство
даёт доступ к пространству, но не к странице с ограниченным доступом.

Ограничение наследуется от ближайшего ограниченного предка: страница внутри
закрытого раздела закрыта, даже если своей отметки у неё нет. Обратное означало
бы, что достаточно создать подстраницу, чтобы обойти ограничение родителя.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import forbidden, not_found
from tessera_api.domain.roles import SPACE_RANK, SpaceRole, can_write_space
from tessera_api.infrastructure.models import GroupUser, Page, PageAccess, PagePermission
from tessera_api.infrastructure.repositories import SpaceMemberRepo

#: Уровень доступа страницы. `open` означает «как у пространства».
ACCESS_OPEN = "open"
ACCESS_RESTRICTED = "restricted"


@dataclass(frozen=True, slots=True)
class PageRights:
    """Что человек может делать со страницей."""

    can_view: bool
    can_edit: bool
    restricted: bool


class PageAccessService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._members = SpaceMemberRepo(session)

    async def _restricted_ancestor(self, page: Page) -> PageAccess | None:
        """Ближайший ограниченный предок, считая саму страницу.

        Обход вверх по дереву делает база: тянуть предков по одному значило бы
        столько запросов, сколько уровней вложенности, а дерево страниц бывает
        глубоким.
        """
        stmt = text(
            """
            WITH RECURSIVE ancestors AS (
                SELECT id, parent_page_id, 0 AS depth
                FROM pages
                WHERE id = :page_id
                UNION ALL
                SELECT p.id, p.parent_page_id, a.depth + 1
                FROM pages p
                JOIN ancestors a ON p.id = a.parent_page_id
                WHERE a.depth < 100
            )
            SELECT pa.id
            FROM ancestors a
            JOIN page_access pa ON pa.page_id = a.id
            WHERE pa.access_level = :restricted
            ORDER BY a.depth ASC
            LIMIT 1
            """
        )
        row = (
            await self._session.execute(
                stmt, {"page_id": page.id, "restricted": ACCESS_RESTRICTED}
            )
        ).first()
        if row is None:
            return None
        return await self._session.get(PageAccess, row[0])

    async def _explicit_role(
        self, user_id: uuid.UUID, page_access_id: uuid.UUID
    ) -> str | None:
        """Роль, выданная человеку на ограниченной странице.

        Считается и прямая, и доставшаяся через группу, берётся сильнейшая:
        членство в группе с меньшими правами не должно урезать собственные.
        """
        direct = (
            select(PagePermission.role)
            .where(PagePermission.page_access_id == page_access_id)
            .where(PagePermission.user_id == user_id)
        )
        via_group = (
            select(PagePermission.role)
            .join(GroupUser, GroupUser.group_id == PagePermission.group_id)
            .where(PagePermission.page_access_id == page_access_id)
            .where(GroupUser.user_id == user_id)
        )
        roles = [
            row[0] for row in (await self._session.execute(direct.union(via_group))).all()
        ]
        if not roles:
            return None
        return max(roles, key=lambda role: SPACE_RANK.get(role, 0))

    async def rights(self, page: Page, user_id: uuid.UUID) -> PageRights:
        """Что человек может делать с этой страницей."""
        space_role = await self._members.role_in_space(user_id, page.space_id)
        if space_role is None:
            # Нет доступа к пространству — нет и к странице. Проверять дальше
            # незачем: права на страницу выдаются внутри пространства.
            return PageRights(can_view=False, can_edit=False, restricted=False)

        restriction = await self._restricted_ancestor(page)
        if restriction is None:
            return PageRights(
                can_view=True,
                can_edit=can_write_space(space_role),
                restricted=False,
            )

        explicit = await self._explicit_role(user_id, restriction.id)
        if explicit is None:
            # Ограничение действует: членства в пространстве недостаточно.
            return PageRights(can_view=False, can_edit=False, restricted=True)

        return PageRights(
            can_view=True,
            can_edit=SPACE_RANK.get(explicit, 0) >= SPACE_RANK[SpaceRole.WRITER],
            restricted=True,
        )

    async def validate_can_view(self, page: Page, user_id: uuid.UUID) -> PageRights:
        rights = await self.rights(page, user_id)
        if not rights.can_view:
            raise forbidden("error.page.access_denied")
        return rights

    async def validate_can_edit(self, page: Page, user_id: uuid.UUID) -> PageRights:
        rights = await self.rights(page, user_id)
        if not rights.can_view:
            raise forbidden("error.page.access_denied")
        if not rights.can_edit:
            raise forbidden("error.page.edit_denied")
        return rights

    async def filter_viewable(
        self, page_ids: list[uuid.UUID], user_id: uuid.UUID
    ) -> list[uuid.UUID]:
        """Оставить из списка только доступные страницы.

        Нужна там, где страницы отдаются пачкой: поиск, дерево, обратные
        ссылки. Фильтровать на клиенте нельзя — к моменту фильтрации
        содержимое уже отдано.
        """
        if not page_ids:
            return []

        allowed: list[uuid.UUID] = []
        for page_id in page_ids:
            page = await self._session.get(Page, page_id)
            if page is None or page.deleted_at is not None:
                continue
            if (await self.rights(page, user_id)).can_view:
                allowed.append(page_id)
        return allowed

    async def load_page(
        self, page_id_or_slug: str, workspace_id: uuid.UUID
    ) -> Page:
        """Найти страницу по идентификатору или короткому имени."""
        try:
            page_id = uuid.UUID(page_id_or_slug)
            stmt = select(Page).where(Page.id == page_id)
        except ValueError:
            stmt = select(Page).where(Page.slug_id == page_id_or_slug)

        page = (
            await self._session.execute(
                stmt.where(Page.workspace_id == workspace_id).where(Page.deleted_at.is_(None))
            )
        ).scalar_one_or_none()
        if page is None:
            raise not_found("error.page.page_not_found")
        return page
