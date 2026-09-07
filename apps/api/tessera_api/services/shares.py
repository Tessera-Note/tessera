"""Ссылки общего доступа.

Содержимое, уходящее по ссылке, проходит подготовку, и она обязательна.
Вложениям выписываются отдельные токены — иначе картинки в открытой странице
не показываются вовсе, — а пометки комментариев снимаются: комментарии это
внутреннее обсуждение, и постороннему не полагается знать ни где они, ни
сколько их.
"""

from __future__ import annotations

import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import bad_request, forbidden, not_found
from tessera_api.infrastructure.models import Page, Share, Space, User, Workspace
from tessera_api.infrastructure.repositories import SpaceMemberRepo
from tessera_api.services.page_access import PageAccessService
from tessera_api.services.paging import moment_cursor, portion, read_moment_cursor
from tessera_api.services.tokens import TokenService

#: Длина ключа ссылки. Ключ и есть учётные данные того, кто открывает страницу
#: без входа, поэтому берётся у криптографического источника.
KEY_BYTES = 24

#: Узлы, у которых есть вложение. Совпадают с перечнем выгрузки: там тот же
#: вопрос — какие узлы ссылаются на файлы в хранилище.
ATTACHMENT_NODES = ("attachment", "image", "video", "audio", "pdf", "excalidraw", "drawio")

#: Пометка обсуждения. Снимается перед выдачей наружу.
COMMENT_MARK = "comment"

#: Начала адресов, которые считаются нашими вложениями. Остальное не трогается:
#: в документе бывают внешние картинки, и подписывать чужой адрес незачем.
FILE_PREFIXES = ("/files/", "/api/files/")

#: Сколько страниц отдаётся в дереве открытой ветви. Тот же предел, что у
#: печати: ветвь на тысячу страниц не столько показывается, сколько роняет
#: браузер.
MAX_TREE_PAGES = 200


@dataclass(frozen=True, slots=True)
class SharePage:
    """Страница перечня ссылок и курсор для следующей."""

    items: list[tuple[Share, Page, Space, User | None]]
    next_cursor: str | None


class ShareService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._access = PageAccessService(session)
        self._members = SpaceMemberRepo(session)

    async def create(
        self,
        *,
        page: Page,
        user_id: uuid.UUID,
        include_sub_pages: bool = False,
        search_indexing: bool = False,
    ) -> Share:
        # Открывать страницу наружу может тот, кто вправе её править: чтение
        # для этого мало, иначе читатель раздаёт чужое содержимое.
        await self._access.validate_can_edit(page, user_id)

        # Ограниченная страница наружу не отдаётся ни при каких правах. Иначе
        # ограничение обходится в один щелчок: страницу, закрытую от всего
        # пространства, публичная ссылка открывает всему интернету.
        if await self._access.has_restricted_ancestor(page):
            raise bad_request("error.share.cannot_share_a_restricted_page")

        if not await self.sharing_allowed(page):
            raise forbidden("error.share.public_sharing_is_disabled")

        existing = (
            await self._session.execute(
                select(Share)
                .where(Share.page_id == page.id)
                .where(Share.deleted_at.is_(None))
            )
        ).scalar_one_or_none()
        if existing is not None:
            return existing

        share_id = uuid.uuid4()
        self._session.add(
            Share(
                id=share_id,
                key=secrets.token_urlsafe(KEY_BYTES),
                page_id=page.id,
                include_sub_pages=include_sub_pages,
                search_indexing=search_indexing,
                creator_id=user_id,
                space_id=page.space_id,
                workspace_id=page.workspace_id,
            )
        )
        await self._session.commit()
        return await self._session.get(Share, share_id)

    async def sharing_allowed(self, page: Page) -> bool:
        """Разрешена ли публикация в этом пространстве.

        Запрет ставится и на рабочее пространство, и на отдельное space, и
        любого из двух достаточно: настройка заводится ровно затем, чтобы
        участник не мог отдать содержимое наружу.
        """
        row = (
            await self._session.execute(
                select(Workspace.settings, Space.settings)
                .select_from(Workspace)
                .join(Space, Space.workspace_id == Workspace.id)
                .where(Workspace.id == page.workspace_id)
                .where(Space.id == page.space_id)
            )
        ).first()
        if row is None:
            return False
        return not any(
            isinstance(settings, dict)
            and isinstance(settings.get("sharing"), dict)
            and settings["sharing"].get("disabled") is True
            for settings in row
        )

    async def mine(
        self,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> SharePage:
        """Действующие ссылки в пространствах, где человек состоит.

        Экран заводят ради одного вопроса: что из нашего сейчас открыто наружу.
        Поэтому перечисляются не свои ссылки, а все в доступных пространствах —
        ссылку мог завести кто угодно с правом правки, и увидеть её должен
        каждый, кто эти страницы читает.

        Право проверяется постранично: строка несёт название страницы, и
        закрытая страница попадать сюда не должна даже своему пространству.

        Постраничность курсорная, от свежих к старым, и курсор берётся у
        последней **прочитанной** строки, а не у последней показанной: права
        выбрасывают строки уже после выборки, и курсор по показанному терял бы
        отброшенный хвост страницы навсегда.
        """
        space_ids = await self._members.space_ids_for(user_id)
        if not space_ids:
            return SharePage(items=[], next_cursor=None)

        wanted = portion(limit)
        stmt = (
            # Автор внешним соединением: удалённая учётная запись не должна
            # уносить строку из перечня — ссылка-то осталась открытой.
            select(Share, Page, Space, User)
            .join(Page, Page.id == Share.page_id)
            .join(Space, Space.id == Page.space_id)
            .outerjoin(User, User.id == Share.creator_id)
            .where(Share.deleted_at.is_(None))
            .where(Share.workspace_id == workspace_id)
            .where(Page.deleted_at.is_(None))
            .where(Space.deleted_at.is_(None))
            .where(Page.space_id.in_(space_ids))
        )

        after = read_moment_cursor(cursor)
        if after is not None:
            moment, last_id = after
            stmt = stmt.where(
                text("(shares.created_at, shares.id) < (:cursor_at, :cursor_id)").bindparams(
                    cursor_at=moment, cursor_id=last_id
                )
            )

        stmt = stmt.order_by(Share.created_at.desc(), Share.id.desc()).limit(wanted + 1)
        rows = (await self._session.execute(stmt)).all()

        has_more = len(rows) > wanted
        read = rows[:wanted]

        allowed: list[tuple[Share, Page, Space, User | None]] = []
        for share, page, space, creator in read:
            if (await self._access.rights(page, user_id)).can_view:
                allowed.append((share, page, space, creator))

        last = read[-1][0] if read else None
        return SharePage(
            items=allowed,
            next_cursor=moment_cursor(last.created_at, last.id) if has_more and last else None,
        )

    async def for_page(self, page: Page, user_id: uuid.UUID) -> Share | None:
        """Ссылка страницы, если она заведена.

        Право чтения, а не правки: тому, кто страницу видит, полагается знать,
        что она открыта наружу. Скрывать это от читателя значило бы, что
        содержимое уходит к посторонним незаметно для тех, кто его пишет.
        """
        await self._access.validate_can_view(page, user_id)
        return (
            await self._session.execute(
                select(Share)
                .where(Share.page_id == page.id)
                .where(Share.deleted_at.is_(None))
            )
        ).scalar_one_or_none()

    async def revoke(self, page: Page, user_id: uuid.UUID) -> None:
        await self._access.validate_can_edit(page, user_id)

        await self._session.execute(
            update(Share)
            .where(Share.page_id == page.id)
            .where(Share.deleted_at.is_(None))
            .values(deleted_at=datetime.now(UTC))
        )
        await self._session.commit()

    async def resolve(self, key: str) -> tuple[Share, Page]:
        """Открыть страницу по ключу без входа.

        Права здесь не проверяются: ключ и есть право. Но проверяется, что
        страница жива, а ссылка не отозвана, иначе отозванная ссылка
        продолжала бы отдавать содержимое.
        """
        share = (
            await self._session.execute(
                select(Share).where(Share.key == key).where(Share.deleted_at.is_(None))
            )
        ).scalar_one_or_none()
        if share is None or share.page_id is None:
            raise not_found("error.share.share_not_found")

        page = await self._session.get(Page, share.page_id)
        if page is None or page.deleted_at is not None:
            # Страница удалена, а ссылка осталась. Отдавать нечего, и делать
            # вид, что ссылка цела, нельзя.
            raise not_found("error.share.share_not_found")

        # Запрет публикации закрывает и уже заведённые ссылки. Иначе выключатель
        # не выключает: он лишь мешает завести новую, а прежние продолжают
        # отдавать содержимое наружу.
        if not await self.sharing_allowed(page):
            raise not_found("error.share.share_not_found")

        # Ограничение, поставленное после публикации, закрывает ссылку. Проверка
        # при заведении сама по себе ничего не даёт: страницу закрывают именно
        # тогда, когда содержимое стало чувствительным, а ссылка уже роздана.
        if await self._access.has_restricted_ancestor(page):
            raise not_found("error.share.share_not_found")

        return share, page

    async def shared_page(self, key: str, page_id_or_slug: str) -> Page:
        """Подстраница по той же ссылке.

        Открывается только если ссылка распространена на потомков и страница
        действительно потомок: иначе ключ одной страницы открывал бы любую
        страницу пространства.
        """
        share, root = await self.resolve(key)

        page = await self._access.load_page(page_id_or_slug, share.workspace_id)
        if page.id == root.id:
            return page

        if not share.include_sub_pages:
            raise not_found("error.share.share_not_found")

        if not await self._is_descendant(page.id, root.id):
            raise not_found("error.share.share_not_found")

        # Закрытая подстраница не отдаётся, даже если ветвь опубликована целиком.
        if await self._access.has_restricted_ancestor(page):
            raise not_found("error.share.share_not_found")
        return page

    async def _is_descendant(self, page_id: uuid.UUID, root_id: uuid.UUID) -> bool:
        from sqlalchemy import text as sql_text

        rows = await self._session.execute(
            sql_text(
                """
                WITH RECURSIVE up AS (
                    SELECT id, parent_page_id, 0 AS depth
                    FROM pages WHERE id = :page_id
                    UNION ALL
                    SELECT p.id, p.parent_page_id, up.depth + 1
                    FROM pages p JOIN up ON p.id = up.parent_page_id
                    WHERE up.depth < 100
                )
                SELECT 1 FROM up WHERE id = :root_id LIMIT 1
                """
            ),
            {"page_id": page_id, "root_id": root_id},
        )
        return rows.first() is not None

    async def update(
        self,
        *,
        share_id: uuid.UUID,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        include_sub_pages: bool | None = None,
        search_indexing: bool | None = None,
    ) -> Share:
        """Изменить настройки ссылки.

        Право то же, что у заведения: правка страницы. Читателю здесь делать
        нечего — распространить ссылку на подстраницы значит открыть наружу то,
        чего в исходной ссылке не было.
        """
        share = await self._session.get(Share, share_id)
        if share is None or share.deleted_at is not None or share.workspace_id != workspace_id:
            raise not_found("error.share.share_not_found")

        page = await self._session.get(Page, share.page_id)
        if page is None or page.deleted_at is not None:
            raise not_found("error.share.shared_page_not_found")
        await self._access.validate_can_edit(page, user_id)

        values: dict = {}
        if include_sub_pages is not None:
            values["include_sub_pages"] = include_sub_pages
        if search_indexing is not None:
            values["search_indexing"] = search_indexing
        if not values:
            return share

        await self._session.execute(
            update(Share).where(Share.id == share.id).values(**values)
        )
        await self._session.commit()
        return await self._session.get(Share, share.id)

    async def tree(self, key: str) -> tuple[Share, Page, list[Page]]:
        """Ветвь, открытая ссылкой: корень и его потомки.

        Ограниченные страницы в дерево не попадают, и вместе с ними — их
        потомки: страница, закрытая от пространства, не должна становиться
        видимой снаружи из-за того, что открыт её предок.

        Ссылка без распространения на подстраницы отдаёт один корень. Дерево в
        этом случае не пустое, а состоит из одной страницы: пустое читалось бы
        клиентом как «ветвь недоступна».
        """
        share, root = await self.resolve(key)
        if not share.include_sub_pages:
            return share, root, [root]

        rows = (
            (
                await self._session.execute(
                    select(Page)
                    .where(Page.space_id == root.space_id)
                    .where(Page.workspace_id == share.workspace_id)
                    .where(Page.deleted_at.is_(None))
                    .order_by(Page.position.asc(), Page.created_at.asc())
                )
            )
            .scalars()
            .all()
        )

        by_parent: dict[uuid.UUID | None, list[Page]] = {}
        for one in rows:
            by_parent.setdefault(one.parent_page_id, []).append(one)

        branch: list[Page] = []
        queue: list[Page] = [root]
        while queue and len(branch) < MAX_TREE_PAGES:
            current = queue.pop(0)
            if await self._access.has_restricted_ancestor(current):
                # Ветка целиком: потомки закрытой страницы наружу не идут.
                continue
            branch.append(current)
            queue.extend(by_parent.get(current.id, []))

        return share, root, branch

    async def search(self, key: str, query: str, *, limit: int = 20) -> list[dict]:
        """Поиск внутри открытой ветви.

        Отдельно от общего поиска, и обязательно отдельно: у того отбор идёт по
        пространствам человека, а здесь человека нет. Отбор задаётся ссылкой —
        только страницы её ветви, только пока ссылка цела, и ничего сверх того.
        """
        from tessera_api.services.search import SEARCH_CONFIG, build_tsquery

        expression = build_tsquery(query)
        if not expression:
            return []

        share, _root, branch = await self.tree(key)
        allowed = [one.id for one in branch]
        if not allowed:
            return []

        rows = await self._session.execute(
            text(
                f"""
                SELECT id, slug_id, title,
                       ts_rank(tsv, to_tsquery('{SEARCH_CONFIG}', f_unaccent(:q))) AS rank,
                       ts_headline('{SEARCH_CONFIG}', coalesce(text_content, ''),
                           to_tsquery('{SEARCH_CONFIG}', f_unaccent(:q)),
                           'MinWords=9, MaxWords=10, MaxFragments=3') AS highlight
                FROM pages
                WHERE workspace_id = :workspace_id
                  AND deleted_at IS NULL
                  AND id = ANY(:allowed)
                  AND tsv @@ to_tsquery('{SEARCH_CONFIG}', f_unaccent(:q))
                ORDER BY rank DESC
                LIMIT :limit
                """  # noqa: S608 — имя конфигурации из константы, не из ввода
            ),
            {
                "q": expression,
                "workspace_id": share.workspace_id,
                "allowed": allowed,
                "limit": limit,
            },
        )
        return [
            {
                "id": row[0],
                "slugId": row[1],
                "title": row[2],
                "rank": float(row[3] or 0),
                "highlight": row[4],
            }
            for row in rows.all()
        ]

    async def public_content(self, page: Page, tokens: TokenService) -> dict | None:
        """Содержимое страницы в виде, пригодном для выдачи наружу.

        Две правки, и обе обязательны. Вложениям выписываются токены, иначе
        картинки и файлы в открытой странице просто не показываются: маршрут
        выдачи закрыт, а вошедшего нет. Пометки обсуждений снимаются, потому
        что комментарии — внутренняя переписка: постороннему не полагается
        знать ни где они стоят, ни сколько их, ни их идентификаторы.
        """
        content = page.content
        if not isinstance(content, dict):
            return content

        minted: dict[str, str] = {}

        def token_for(raw: object) -> str | None:
            key = str(raw or "")
            if not key:
                return None
            if key not in minted:
                try:
                    attachment_id = uuid.UUID(key)
                except ValueError:
                    return None
                minted[key] = tokens.issue_attachment(
                    attachment_id=attachment_id,
                    page_id=page.id,
                    workspace_id=page.workspace_id,
                )
            return minted[key]

        def visit(node: object) -> object:
            if isinstance(node, list):
                return [visit(one) for one in node]
            if not isinstance(node, dict):
                return node

            copy = dict(node)
            marks = copy.get("marks")
            if isinstance(marks, list):
                left = [
                    mark
                    for mark in marks
                    if not (isinstance(mark, dict) and mark.get("type") == COMMENT_MARK)
                ]
                if left:
                    copy["marks"] = left
                else:
                    copy.pop("marks", None)

            if copy.get("type") in ATTACHMENT_NODES:
                attrs = dict(copy.get("attrs") or {})
                token = token_for(attrs.get("attachmentId"))
                if token:
                    for field in ("src", "url"):
                        attrs[field] = _public_url(attrs.get(field), token)
                copy["attrs"] = attrs

            if isinstance(copy.get("content"), list):
                copy["content"] = [visit(one) for one in copy["content"]]
            return copy

        return visit(content)


def _public_url(value: object, token: str) -> object:
    """Адрес вложения в публичной форме. Чужие адреса не трогаются."""
    if not isinstance(value, str) or not value.startswith(FILE_PREFIXES):
        return value
    public = value.replace("/files/", "/files/public/", 1)
    separator = "&" if "?" in public else "?"
    return f"{public}{separator}jwt={token}"
