"""Маршруты страниц, комментариев, меток и поиска."""

from __future__ import annotations

import uuid

import msgspec
from litestar import Controller, Request, get, post
from litestar.di import NamedDependency
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.guards import PUBLIC, Principal
from tessera_api.services.backlinks import BacklinkService
from tessera_api.services.comments import CommentService
from tessera_api.services.history import PageHistoryService
from tessera_api.services.labels import FavoriteService, LabelService
from tessera_api.services.notification_mail import NotificationMailer
from tessera_api.services.page_access import PageAccessService
from tessera_api.services.pages import PageService
from tessera_api.services.realtime import RealtimeService
from tessera_api.services.search import SearchService
from tessera_api.services.shares import ShareService


class CreatePageRequest(msgspec.Struct):
    spaceId: uuid.UUID  # noqa: N815 — имя поля из v1
    title: str | None = None
    content: dict | None = None
    parentPageId: uuid.UUID | None = None  # noqa: N815 — имя поля из v1


class UpdatePageRequest(msgspec.Struct):
    pageId: str  # noqa: N815 — имя поля из v1
    title: str | None = None
    content: dict | None = None
    icon: str | None = None


class PageIdRequest(msgspec.Struct):
    pageId: str  # noqa: N815 — имя поля из v1


class TreeRequest(msgspec.Struct):
    spaceId: uuid.UUID  # noqa: N815 — имя поля из v1
    parentPageId: uuid.UUID | None = None  # noqa: N815 — имя поля из v1


class SearchRequest(msgspec.Struct):
    query: str
    spaceId: uuid.UUID | None = None  # noqa: N815 — имя поля из v1
    limit: int = 20


class CommentRequest(msgspec.Struct):
    pageId: str  # noqa: N815 — имя поля из v1
    content: dict
    parentCommentId: uuid.UUID | None = None  # noqa: N815 — имя поля из v1
    selection: str | None = None


class LabelRequest(msgspec.Struct):
    pageId: str  # noqa: N815 — имя поля из v1
    names: list[str]


def _page_view(page, rights=None) -> dict:
    """Вид страницы для клиента.

    `canEdit` отдаётся вместе со страницей: без него клиент показывает
    редактор тому, кто править не может, и правка отваливается на сохранении.
    """
    body = {
        "id": page.id,
        "slugId": page.slug_id,
        "title": page.title,
        "icon": page.icon,
        "content": page.content,
        "parentPageId": page.parent_page_id,
        "spaceId": page.space_id,
        "creatorId": page.creator_id,
        "createdAt": page.created_at,
        "updatedAt": page.updated_at,
    }
    if rights is not None:
        body["canEdit"] = rights.can_edit
        body["restricted"] = rights.restricted
    return body


class PageController(Controller):
    path = "/api/pages"

    @post("/info")
    async def info(
        self, data: PageIdRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> dict:
        principal: Principal = request.scope["principal"]
        access = PageAccessService(db_session)

        page = await access.load_page(data.pageId, principal.workspace_id)
        rights = await access.validate_can_view(page, principal.user_id)
        return _page_view(page, rights)

    @post("/backlinks")
    async def backlinks(
        self, data: PageIdRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> list[dict]:
        """Страницы, ссылающиеся на эту.

        Выдача фильтруется по правам: обратная ссылка раскрывает название и
        адрес источника, а источник может лежать в закрытой ветке.
        """
        principal: Principal = request.scope["principal"]
        access = PageAccessService(db_session)

        page = await access.load_page(data.pageId, principal.workspace_id)
        await access.validate_can_view(page, principal.user_id)
        return await BacklinkService(db_session).incoming(page, principal.user_id)

    @post("/create")
    async def create(
        self,
        data: CreatePageRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        page = await PageService(db_session, realtime).create(
            user_id=principal.user_id,
            workspace_id=principal.workspace_id,
            space_id=data.spaceId,
            title=data.title,
            content=data.content,
            parent_page_id=data.parentPageId,
        )
        return _page_view(page)

    @post("/update")
    async def update(
        self,
        data: UpdatePageRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        page = await PageAccessService(db_session).load_page(data.pageId, principal.workspace_id)
        updated = await PageService(db_session, realtime).update(
            page=page,
            user_id=principal.user_id,
            title=data.title,
            content=data.content,
            icon=data.icon,
        )
        return _page_view(updated)

    @post("/delete")
    async def delete(
        self,
        data: PageIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        page = await PageAccessService(db_session).load_page(data.pageId, principal.workspace_id)
        await PageService(db_session, realtime).move_to_trash(page, principal.user_id)
        return {"status": "ok"}

    @post("/tree")
    async def tree(
        self,
        data: TreeRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> list[dict]:
        principal: Principal = request.scope["principal"]
        pages = await PageService(db_session, realtime).children(
            data.parentPageId, data.spaceId, principal.user_id
        )
        return [_page_view(page) for page in pages]


class SearchController(Controller):
    path = "/api/search"

    @post()
    async def search(
        self, data: SearchRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> list[dict]:
        principal: Principal = request.scope["principal"]
        hits = await SearchService(db_session).search_pages(
            data.query,
            user_id=principal.user_id,
            workspace_id=principal.workspace_id,
            space_id=data.spaceId,
            limit=min(data.limit, 50),
        )
        return [
            {
                "id": hit.page_id,
                "slugId": hit.slug_id,
                "title": hit.title,
                "spaceId": hit.space_id,
                "highlight": hit.highlight,
                "rank": hit.rank,
            }
            for hit in hits
        ]


class CommentController(Controller):
    path = "/api/comments"

    @post("/list")
    async def list_comments(
        self,
        data: PageIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        mailer: NamedDependency[NotificationMailer],
    ) -> list[dict]:
        principal: Principal = request.scope["principal"]
        page = await PageAccessService(db_session).load_page(data.pageId, principal.workspace_id)
        found = await CommentService(db_session, realtime, mailer).list_for_page(
            page, principal.user_id
        )
        return [
            {
                "id": c.id,
                "content": c.content,
                "creatorId": c.creator_id,
                "parentCommentId": c.parent_comment_id,
                "selection": c.selection,
                "resolvedAt": c.resolved_at,
                "createdAt": c.created_at,
            }
            for c in found
        ]

    @post("/create")
    async def create(
        self,
        data: CommentRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        mailer: NamedDependency[NotificationMailer],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        page = await PageAccessService(db_session).load_page(data.pageId, principal.workspace_id)
        comment = await CommentService(db_session, realtime, mailer).create(
            page=page,
            user_id=principal.user_id,
            content=data.content,
            parent_comment_id=data.parentCommentId,
            selection=data.selection,
        )
        return {"id": comment.id, "content": comment.content}


class LabelController(Controller):
    path = "/api/labels"

    @get()
    async def list_labels(
        self, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> list[dict]:
        principal: Principal = request.scope["principal"]
        found = await LabelService(db_session).list_all(principal.workspace_id)
        return [{"id": label.id, "name": label.name} for label in found]

    @post("/attach")
    async def attach(
        self, data: LabelRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> list[dict]:
        principal: Principal = request.scope["principal"]
        page = await PageAccessService(db_session).load_page(data.pageId, principal.workspace_id)
        attached = await LabelService(db_session).attach(page, data.names, principal.user_id)
        return [{"id": label.id, "name": label.name} for label in attached]


class FavoriteController(Controller):
    path = "/api/favorites"

    @get()
    async def list_favorites(
        self, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> list[dict]:
        principal: Principal = request.scope["principal"]
        found = await FavoriteService(db_session).list_for_user(
            principal.user_id, principal.workspace_id
        )
        return [{"id": f.id, "pageId": f.page_id, "type": f.type} for f in found]

    @post("/add")
    async def add(
        self, data: PageIdRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> dict:
        principal: Principal = request.scope["principal"]
        page = await PageAccessService(db_session).load_page(data.pageId, principal.workspace_id)
        await FavoriteService(db_session).add_page(page, principal.user_id)
        return {"status": "ok"}

    @post("/remove")
    async def remove(
        self, data: PageIdRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> dict:
        principal: Principal = request.scope["principal"]
        # Права намеренно не проверяются: снять свою запись человек должен
        # мочь и после того, как доступ к странице у него отобрали.
        await FavoriteService(db_session).remove_page(uuid.UUID(data.pageId), principal.user_id)
        return {"status": "ok"}


class ShareRequest(msgspec.Struct):
    pageId: str  # noqa: N815 — имя поля из v1
    includeSubPages: bool = False  # noqa: N815 — имя поля из v1
    searchIndexing: bool = False  # noqa: N815 — имя поля из v1


class ShareKeyRequest(msgspec.Struct):
    key: str
    pageId: str | None = None  # noqa: N815 — имя поля из v1


class HistoryController(Controller):
    path = "/api/pages/history"

    @post("/list")
    async def list_versions(
        self, data: PageIdRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> list[dict]:
        principal: Principal = request.scope["principal"]
        page = await PageAccessService(db_session).load_page(
            data.pageId, principal.workspace_id
        )
        versions = await PageHistoryService(db_session).list_for_page(
            page, principal.user_id
        )
        return [
            {
                "id": v.id,
                "version": v.version,
                "title": v.title,
                "lastUpdatedById": v.last_updated_by_id,
                "createdAt": v.created_at,
            }
            for v in versions
        ]

    @post("/get")
    async def get_version(
        self, data: dict, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> dict:
        principal: Principal = request.scope["principal"]
        version = await PageHistoryService(db_session).get_version(
            uuid.UUID(str(data["versionId"])), principal.user_id, principal.workspace_id
        )
        return {
            "id": version.id,
            "version": version.version,
            "title": version.title,
            "content": version.content,
            "createdAt": version.created_at,
        }


class ShareController(Controller):
    path = "/api/share"

    @post("/create")
    async def create(
        self, data: ShareRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> dict:
        principal: Principal = request.scope["principal"]
        page = await PageAccessService(db_session).load_page(
            data.pageId, principal.workspace_id
        )
        share = await ShareService(db_session).create(
            page=page,
            user_id=principal.user_id,
            include_sub_pages=data.includeSubPages,
            search_indexing=data.searchIndexing,
        )
        return {
            "id": share.id,
            "key": share.key,
            "includeSubPages": share.include_sub_pages,
        }

    @post("/revoke")
    async def revoke(
        self, data: PageIdRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> dict:
        principal: Principal = request.scope["principal"]
        page = await PageAccessService(db_session).load_page(
            data.pageId, principal.workspace_id
        )
        await ShareService(db_session).revoke(page, principal.user_id)
        return {"status": "ok"}

    @post("/open", opt={PUBLIC: True})
    async def open_shared(
        self, data: ShareKeyRequest, db_session: NamedDependency[AsyncSession]
    ) -> dict:
        """Открыть страницу по ссылке без входа.

        Публичный по назначению: ссылка и заводится ради тех, у кого учётной
        записи нет. Учётными данными служит ключ, права не проверяются, но
        проверяется, что ссылка не отозвана, страница жива, а запрошенная
        подстраница действительно потомок открытой.
        """
        service = ShareService(db_session)
        if data.pageId:
            page = await service.shared_page(data.key, data.pageId)
        else:
            _, page = await service.resolve(data.key)

        return {
            "id": page.id,
            "slugId": page.slug_id,
            "title": page.title,
            "content": page.content,
            "updatedAt": page.updated_at,
        }
