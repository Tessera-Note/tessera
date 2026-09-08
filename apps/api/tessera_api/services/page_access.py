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
from tessera_api.infrastructure.models import Page, Space
from tessera_api.infrastructure.repositories import SpaceMemberRepo

#: Уровень доступа, записываемый при ограничении страницы.
#:
#: Ограничение определяется **наличием** строки в `page_access`, а не значением
#: этой колонки: так устроен v1, и так безопаснее — неизвестное значение
#: закрывает страницу, а не открывает её. Значение пишется ради читаемости
#: данных и совместимости, но ни одна проверка доступа на него не смотрит.
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

    async def _restriction_chain(
        self, page: Page, user_id: uuid.UUID
    ) -> list[tuple[uuid.UUID, list[str]]]:
        """Ограниченные предки от ближайшего к дальнему и роли человека на них.

        Возвращает по одной записи на каждого ограниченного предка, считая саму
        страницу: идентификатор ограничения и роли, доставшиеся человеку прямо
        либо через группу. Пустой список ролей означает, что на этом предке
        прав нет.

        Проверять надо **каждого** ограниченного предка, а не ближайшего.
        Иначе страница внутри двух вложенных ограничений открывается тому, кому
        дали право на внутреннем и не давали на внешнем: внешнее ограничение
        обходится созданием подстраницы с собственным ограничением. Роль при
        этом берётся с ближайшего — она описывает именно эту ветку.

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
            SELECT
                pa.id AS access_id,
                COALESCE(
                    array_agg(pp.role) FILTER (WHERE pp.id IS NOT NULL),
                    ARRAY[]::varchar[]
                ) AS roles
            FROM ancestors a
            JOIN page_access pa ON pa.page_id = a.id
            LEFT JOIN page_permissions pp
                   ON pp.page_access_id = pa.id
                  AND (
                        pp.user_id = :user_id
                     OR pp.group_id IN (
                            SELECT gu.group_id
                            FROM group_users gu
                            WHERE gu.user_id = :user_id
                        )
                  )
            GROUP BY a.depth, pa.id
            ORDER BY a.depth ASC
            """
        )
        rows = (
            await self._session.execute(stmt, {"page_id": page.id, "user_id": user_id})
        ).all()
        return [(row.access_id, list(row.roles or [])) for row in rows]

    @staticmethod
    def _strongest(roles: list[str]) -> str:
        """Сильнейшая из ролей.

        Сильнейшая, а не первая: членство в группе с меньшими правами не должно
        урезать собственные. Сравнение идёт по рангу, а не по алфавиту, — для
        нынешних двух значений алфавит совпадает с рангом случайно, и третье
        значение сломало бы такое сравнение молча.
        """
        return max(roles, key=lambda role: SPACE_RANK.get(role, 0))

    async def rights(self, page: Page, user_id: uuid.UUID) -> PageRights:
        """Что человек может делать с этой страницей."""
        space_role = await self._members.role_in_space(user_id, page.space_id)
        if space_role is None:
            # Нет доступа к пространству — нет и к странице. Проверять дальше
            # незачем: права на страницу выдаются внутри пространства.
            return PageRights(can_view=False, can_edit=False, restricted=False)

        chain = await self._restriction_chain(page, user_id)
        if not chain:
            return PageRights(
                can_view=True,
                can_edit=can_write_space(space_role),
                restricted=False,
            )

        if any(not roles for _, roles in chain):
            # Хотя бы на одном ограниченном предке прав нет. Членства в
            # пространстве недостаточно, и права на ближайшем предке тоже:
            # иначе внешнее ограничение обходилось бы внутренним.
            return PageRights(can_view=False, can_edit=False, restricted=True)

        nearest = self._strongest(chain[0][1])
        return PageRights(
            can_view=True,
            can_edit=SPACE_RANK.get(nearest, 0) >= SPACE_RANK[SpaceRole.WRITER],
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

    async def validate_can_comment(self, page: Page, user_id: uuid.UUID) -> PageRights:
        """Кто вправе писать в обсуждение страницы.

        Правило v1: пишущий комментирует всегда, читатель — только если это
        разрешено настройкой пространства. Умолчание «нельзя»: право читать
        закрытое пространство раздают шире, чем право что-либо в нём оставлять,
        и обсуждение здесь не исключение.
        """
        rights = await self.validate_can_view(page, user_id)
        if rights.can_edit:
            return rights

        space = await self._session.get(Space, page.space_id)
        settings = (space.settings if space is not None else None) or {}
        comments = settings.get("comments") if isinstance(settings, dict) else None
        if not (isinstance(comments, dict) and comments.get("allowViewerComments") is True):
            raise forbidden("error.page.comment_denied")
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

    async def has_restricted_ancestor(self, page: Page) -> bool:
        """Ограничена ли страница или любой её предок.

        Без привязки к человеку: вопрос не «кому она открыта», а «закрыта ли
        она вообще». Этим проверяется, можно ли отдавать её наружу по ссылке.
        """
        found = (
            await self._session.execute(
                text(
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
                    SELECT 1
                    FROM ancestors a
                    JOIN page_access pa ON pa.page_id = a.id
                    LIMIT 1
                    """
                ),
                {"page_id": page.id},
            )
        ).first()
        return found is not None

    async def space_has_restrictions(self, space_id: uuid.UUID) -> bool:
        """Есть ли в пространстве хоть одна ограниченная страница.

        Дешёвый первый шаг отбора получателей рассылки. В подавляющем
        большинстве пространств ограничений нет вовсе, и один этот запрос
        избавляет от обхода предков на каждом событии.

        Ответ кешируется вызывающим, а не здесь: срок жизни кеша — решение
        того, кто им пользуется, и прятать его сюда значило бы навязать один
        срок всем.
        """
        found = (
            await self._session.execute(
                text(
                    """
                    SELECT 1
                    FROM page_access pa
                    JOIN pages p ON p.id = pa.page_id
                    WHERE p.space_id = :space_id
                      AND p.deleted_at IS NULL
                    LIMIT 1
                    """
                ),
                {"space_id": space_id},
            )
        ).first()
        return found is not None

    async def viewers_of(self, page: Page) -> set[uuid.UUID] | None:
        """Кому эту страницу можно показывать.

        `None` означает, что ограничений нет и показывать можно всему
        пространству. Пустое множество — что нельзя никому: это законный
        ответ, а не признак ошибки, и путать их нельзя. Именно поэтому здесь
        не список.

        Считается так же, как `rights`, и по той же причине: право нужно на
        **каждом** ограниченном предке, поэтому множества пересекаются. Взяв
        объединение, мы бы отдали страницу тому, кому дали право на внутреннем
        ограничении и не давали на внешнем.

        Нужно рассылке. Отправить событие всей комнате пространства и
        рассчитывать, что лишние его выбросят, нельзя: событие несёт заголовок
        страницы или тело комментария, то есть само по себе является выдачей
        содержимого.
        """
        chain = (
            await self._session.execute(
                text(
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
                    SELECT pa.id AS access_id
                    FROM ancestors a
                    JOIN page_access pa ON pa.page_id = a.id
                    ORDER BY a.depth ASC
                    """
                ),
                {"page_id": page.id},
            )
        ).all()
        if not chain:
            return None

        allowed: set[uuid.UUID] | None = None
        for row in chain:
            rows = (
                await self._session.execute(
                    text(
                        """
                        SELECT pp.user_id AS user_id
                        FROM page_permissions pp
                        WHERE pp.page_access_id = :access_id
                          AND pp.user_id IS NOT NULL
                        UNION
                        SELECT gu.user_id AS user_id
                        FROM page_permissions pp
                        JOIN group_users gu ON gu.group_id = pp.group_id
                        WHERE pp.page_access_id = :access_id
                          AND pp.group_id IS NOT NULL
                        """
                    ),
                    {"access_id": row.access_id},
                )
            ).all()
            here = {one.user_id for one in rows}
            allowed = here if allowed is None else (allowed & here)
            if not allowed:
                # Пересечение уже пусто, дальше оно пустым и останется.
                return set()

        # Права на страницу выдаются внутри пространства, и выбывший из
        # пространства теряет их вместе с ним. Запись в `page_permissions` при
        # этом остаётся, поэтому пересечение с составом пространства
        # обязательно.
        members = await self._members.members_of(page.space_id)
        return (allowed or set()) & members

    async def load_page(self, page_id_or_slug: str, workspace_id: uuid.UUID) -> Page:
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
