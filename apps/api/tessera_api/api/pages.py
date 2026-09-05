"""Маршруты страниц, комментариев, меток и поиска."""

from __future__ import annotations

import uuid

import msgspec
from litestar import Controller, Request, get, post
from litestar.di import NamedDependency
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.guards import PUBLIC, Principal
from tessera_api.domain.errors import bad_request, forbidden, not_found
from tessera_api.domain.roles import is_workspace_admin
from tessera_api.infrastructure.queue import JobQueue
from tessera_api.infrastructure.repositories import UserRepo
from tessera_api.infrastructure.storage import Storage
from tessera_api.services.attachment_index import AttachmentIndexService
from tessera_api.services.backlinks import BacklinkService
from tessera_api.services.comments import CommentService
from tessera_api.services.history import PageHistoryService
from tessera_api.services.labels import (
    FAVORITE_PAGE,
    FAVORITE_SPACE,
    FAVORITE_TEMPLATE,
    FavoriteService,
    LabelService,
)
from tessera_api.services.notification_mail import NotificationMailer
from tessera_api.services.notifications import WatcherService
from tessera_api.services.page_access import PageAccessService
from tessera_api.services.pages import PageService
from tessera_api.services.realtime import RealtimeService
from tessera_api.services.search import (
    AttachmentSearchService,
    SearchService,
    SuggestionService,
)
from tessera_api.services.shares import ShareService
from tessera_api.services.tokens import TokenService
from tessera_api.services.transclusion import ReferenceLink, TransclusionService


def _label_uuid(raw: str) -> uuid.UUID:
    """Идентификатор метки из тела запроса.

    По тем же основаниям, что и у страницы: негодное значение это отказ «не
    найдено», а не ошибка разбора и не пятисотый ответ.
    """
    try:
        return uuid.UUID(str(raw))
    except (TypeError, ValueError) as error:
        raise not_found("error.label.label_not_found") from error


def _version_uuid(raw: str) -> uuid.UUID:
    """Идентификатор версии из тела запроса.

    По тем же основаниям, что и у страницы: негодное значение это отказ «не
    найдено», а не ошибка разбора и не пятисотый ответ.
    """
    try:
        return uuid.UUID(str(raw))
    except (TypeError, ValueError) as error:
        raise not_found("error.page.version_not_found") from error


def _page_uuid(raw: str) -> uuid.UUID:
    """Идентификатор страницы из тела запроса.

    Негодное значение — отказ «не найдено», а не иная ошибка: разные отказы на
    «не существует» и «не разобрано» позволяют перебором нащупывать формат
    чужих идентификаторов.
    """
    try:
        return uuid.UUID(str(raw))
    except (TypeError, ValueError) as error:
        raise not_found("error.page.page_not_found") from error


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


class TrashRequest(msgspec.Struct):
    spaceId: uuid.UUID  # noqa: N815 — имя поля из v1
    limit: int = 50


class PageIdRequest(msgspec.Struct):
    pageId: str  # noqa: N815 — имя поля из v1


class DeletePageRequest(msgspec.Struct):
    pageId: str  # noqa: N815 — имя поля из v1
    #: Удалить насовсем, а не в корзину. Признак в теле, а не второй маршрут:
    #: предмет один и тот же, разница только в необратимости. Имя поля из v1.
    permanentlyDelete: bool = False  # noqa: N815 — имя поля из v1


class MoveRequest(msgspec.Struct):
    pageId: str  # noqa: N815 — имя поля из v1
    position: str | None = None
    parentPageId: str | None = None  # noqa: N815 — имя поля из v1
    #: Вынести в корень. Отдельным признаком, а не пустым родителем: пустое
    #: значение и «поле не передавали» иначе неразличимы.
    detach: bool = False


class MoveToSpaceRequest(msgspec.Struct):
    pageId: str  # noqa: N815 — имя поля из v1
    spaceId: str  # noqa: N815 — имя поля из v1


class DuplicateRequest(msgspec.Struct):
    pageId: str  # noqa: N815 — имя поля из v1
    spaceId: str | None = None  # noqa: N815 — имя поля из v1


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


class VersionRequest(msgspec.Struct):
    versionId: str  # noqa: N815 — имя поля из v1


class LabelRequest(msgspec.Struct):
    pageId: str  # noqa: N815 — имя поля из v1
    names: list[str]


class PageLabelsRequest(msgspec.Struct):
    pageId: str  # noqa: N815 — имя поля из v1


class DetachLabelRequest(msgspec.Struct):
    pageId: str  # noqa: N815 — имя поля из v1
    labelId: str  # noqa: N815 — имя поля из v1


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
        queue: NamedDependency[JobQueue],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        page = await PageService(db_session, realtime, queue).create(
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
        queue: NamedDependency[JobQueue],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        page = await PageAccessService(db_session).load_page(data.pageId, principal.workspace_id)
        updated = await PageService(db_session, realtime, queue).update(
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
        data: DeletePageRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        queue: NamedDependency[JobQueue],
        storage: NamedDependency[Storage],
    ) -> dict:
        """Убрать страницу в корзину либо удалить насовсем."""
        principal: Principal = request.scope["principal"]
        service = PageService(db_session, realtime, queue)

        if data.permanentlyDelete:
            await service.force_delete(
                _page_uuid(data.pageId), principal.user_id, storage=storage
            )
            return {"status": "ok"}

        page = await PageAccessService(db_session).load_page(data.pageId, principal.workspace_id)
        await service.move_to_trash(page, principal.user_id)
        return {"status": "ok"}

    @post("/restore")
    async def restore(
        self,
        data: PageIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        queue: NamedDependency[JobQueue],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        page = await PageService(db_session, realtime, queue).restore(
            _page_uuid(data.pageId), principal.user_id
        )
        return {"id": str(page.id), "slugId": page.slug_id, "title": page.title}

    @post("/move")
    async def move(
        self,
        data: MoveRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        queue: NamedDependency[JobQueue],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        page = await PageService(db_session, realtime, queue).move(
            _page_uuid(data.pageId),
            principal.user_id,
            position=data.position,
            parent_page_id=_page_uuid(data.parentPageId) if data.parentPageId else None,
            detach=data.detach,
        )
        return {
            "id": str(page.id),
            "position": page.position,
            "parentPageId": str(page.parent_page_id) if page.parent_page_id else None,
        }

    @post("/move-to-space")
    async def move_to_space(
        self,
        data: MoveToSpaceRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        queue: NamedDependency[JobQueue],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        page = await PageService(db_session, realtime, queue).move_to_space(
            _page_uuid(data.pageId), principal.user_id, _page_uuid(data.spaceId)
        )
        return {"id": str(page.id), "spaceId": str(page.space_id)}

    @post("/duplicate")
    async def duplicate(
        self,
        data: DuplicateRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        queue: NamedDependency[JobQueue],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        page = await PageService(db_session, realtime, queue).duplicate(
            _page_uuid(data.pageId),
            principal.user_id,
            space_id=_page_uuid(data.spaceId) if data.spaceId else None,
        )
        return {"id": str(page.id), "slugId": page.slug_id, "title": page.title}

    @post("/breadcrumbs")
    async def breadcrumbs(
        self,
        data: PageIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        queue: NamedDependency[JobQueue],
    ) -> list[dict]:
        principal: Principal = request.scope["principal"]
        page = await PageAccessService(db_session).load_page(
            data.pageId, principal.workspace_id
        )
        return await PageService(db_session, realtime, queue).breadcrumbs(
            page, principal.user_id
        )

    @post("/trash")
    async def trash(
        self,
        data: TrashRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        queue: NamedDependency[JobQueue],
    ) -> list[dict]:
        """Что лежит в корзине пространства.

        Пространство обязательно: общая корзина рабочего пространства
        перечисляла бы названия страниц из тех пространств, куда человек не
        входит.
        """
        principal: Principal = request.scope["principal"]
        pages = await PageService(db_session, realtime, queue).deleted_in_space(
            data.spaceId, principal.user_id, limit=data.limit
        )
        return [
            {
                **_page_view(page),
                "deletedAt": page.deleted_at,
                "deletedById": page.deleted_by_id,
            }
            for page in pages
        ]

    @post("/tree")
    async def tree(
        self,
        data: TreeRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        queue: NamedDependency[JobQueue],
    ) -> list[dict]:
        principal: Principal = request.scope["principal"]
        return await PageService(db_session, realtime, queue).sidebar(
            data.parentPageId, data.spaceId, principal.user_id
        )


class SuggestRequest(msgspec.Struct):
    """Подсказки. Имена полей из v1."""

    query: str = ""
    includeUsers: bool = True  # noqa: N815 — имя поля из v1
    includeGroups: bool = False  # noqa: N815 — имя поля из v1
    limit: int = 10


class SearchController(Controller):
    path = "/api/search"

    @post("/suggest")
    async def suggest(
        self, data: SuggestRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> dict:
        """Подсказки людей и групп для выбора.

        Виден любому вошедшему — так же, как в v1: без него нельзя ни упомянуть
        человека, ни выдать доступ. Пустой запрос отвечает пустотой, поэтому
        перечнем всех работающих маршрут не становится.
        """
        principal: Principal = request.scope["principal"]
        return await SuggestionService(db_session).suggest(
            data.query,
            principal.workspace_id,
            include_users=data.includeUsers,
            include_groups=data.includeGroups,
            limit=data.limit,
        )

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


class AttachmentSearchController(Controller):
    """Поиск по тексту, извлечённому из вложений.

    Отдельный маршрут, а не расширение поиска по страницам: у выдачи другой
    состав полей и другой смысл — находится файл, а не страница.
    """

    path = "/api/search-attachments"

    @post()
    async def search(
        self, data: SearchRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> list[dict]:
        principal: Principal = request.scope["principal"]
        hits = await AttachmentSearchService(db_session).search(
            data.query,
            user_id=principal.user_id,
            workspace_id=principal.workspace_id,
            space_id=data.spaceId,
            limit=min(data.limit, 50),
        )
        return [
            {
                "id": hit.attachment_id,
                "fileName": hit.file_name,
                "pageId": hit.page_id,
                "spaceId": hit.space_id,
                "highlight": hit.highlight,
                "rank": hit.rank,
            }
            for hit in hits
        ]

    @post("/indexing")
    async def start_indexing(
        self,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        storage: NamedDependency[Storage],
    ) -> dict:
        """Разобрать вложения, которые ещё не разбирались.

        Право администратора: проход читает файлы всего рабочего пространства,
        включая приложенные к закрытым страницам. Обычному участнику этого не
        полагается, даже при том, что наружу отдаётся одно число.
        """
        principal: Principal = request.scope["principal"]
        actor = await UserRepo(db_session).by_id(principal.user_id, principal.workspace_id)
        if actor is None:
            raise not_found("error.common.user_not_found")
        if not is_workspace_admin(actor.role):
            raise forbidden("error.common.admin_required")

        processed = await AttachmentIndexService(db_session, storage).backfill(
            principal.workspace_id
        )
        return {"processed": processed}


def _comment_view(comment, authors=None) -> dict:  # noqa: ANN001 — модели базы
    """Комментарий так, как его ждёт панель. Один вид на все маршруты.

    Имя и картинка автора идут вместе с комментарием: без них панель
    показывала одну дату, и понять, кто что написал, было нельзя. Второй
    запрос за именем по каждой строке был бы дороже самого перечня.
    """
    author = (authors or {}).get(comment.creator_id)
    return {
        "id": comment.id,
        "content": comment.content,
        "creatorId": comment.creator_id,
        "creatorName": author.name if author else None,
        "creatorAvatarUrl": author.avatar_url if author else None,
        "parentCommentId": comment.parent_comment_id,
        "selection": comment.selection,
        "resolvedAt": comment.resolved_at,
        "resolvedById": comment.resolved_by_id,
        "editedAt": comment.edited_at,
        "createdAt": comment.created_at,
        "pageId": comment.page_id,
    }


class CommentIdRequest(msgspec.Struct):
    commentId: str  # noqa: N815 — имя поля из v1


class UpdateCommentRequest(msgspec.Struct):
    commentId: str  # noqa: N815 — имя поля из v1
    content: dict


class ResolveCommentRequest(msgspec.Struct):
    commentId: str  # noqa: N815 — имя поля из v1
    resolved: bool = True


def _comment_uuid(raw: str) -> uuid.UUID:
    """Идентификатор комментария. Негодное значение — «не найдено»."""
    try:
        return uuid.UUID(str(raw))
    except (TypeError, ValueError) as error:
        raise not_found("error.comment.comment_not_found") from error


def _listing_view(page, space) -> dict:  # noqa: ANN001 — модели базы
    """Строка перечня страниц: название, адрес и пространство."""
    return {
        "id": page.id,
        "slugId": page.slug_id,
        "title": page.title,
        "icon": page.icon,
        "spaceId": page.space_id,
        "spaceSlug": space.slug,
        "spaceName": space.name,
        "updatedAt": page.updated_at,
        "createdAt": page.created_at,
    }


class RecentPagesRequest(msgspec.Struct):
    spaceId: str | None = None  # noqa: N815 — имя поля из v1
    limit: int | None = None


class CreatedByRequest(msgspec.Struct):
    userId: str | None = None  # noqa: N815 — имя поля из v1
    spaceId: str | None = None  # noqa: N815 — имя поля из v1
    limit: int | None = None


class WatcherController(Controller):
    """Подписка на страницу.

    Отдельным контроллером, а не в страницах: подписка это не содержимое, и
    правила у неё свои — подписаться может тот, кто страницу видит, а не тот,
    кто её правит.
    """

    path = "/api/pages"

    @post("/recent")
    async def recent(
        self,
        data: RecentPagesRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
    ) -> list[dict]:
        """Недавно изменённые страницы. Пустое пространство — по всем своим."""
        principal: Principal = request.scope["principal"]
        found = await PageService(db_session).recent(
            principal.user_id,
            principal.workspace_id,
            space_id=_page_uuid(data.spaceId) if data.spaceId else None,
            limit=data.limit or 20,
        )
        return [_listing_view(page, space) for page, space in found]

    @post("/created-by-user")
    async def created_by_user(
        self,
        data: CreatedByRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
    ) -> list[dict]:
        """Страницы, заведённые человеком. Пустой — свои."""
        principal: Principal = request.scope["principal"]
        author = _page_uuid(data.userId) if data.userId else principal.user_id
        found = await PageService(db_session).created_by(
            author,
            principal.user_id,
            principal.workspace_id,
            space_id=_page_uuid(data.spaceId) if data.spaceId else None,
            limit=data.limit or 50,
        )
        return [_listing_view(page, space) for page, space in found]

    @post("/backlinks-count")
    async def backlinks_count(
        self, data: PageIdRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> dict:
        principal: Principal = request.scope["principal"]
        access = PageAccessService(db_session)
        page = await access.load_page(data.pageId, principal.workspace_id)
        await access.validate_can_view(page, principal.user_id)
        return {"count": await BacklinkService(db_session).count(page, principal.user_id)}

    @post("/watch")
    async def watch(
        self, data: PageIdRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> dict:
        principal: Principal = request.scope["principal"]
        access = PageAccessService(db_session)
        page = await access.load_page(data.pageId, principal.workspace_id)
        await access.validate_can_view(page, principal.user_id)

        service = WatcherService(db_session)
        added = await service.watch_page(user_id=principal.user_id, page=page)
        if added:
            await db_session.commit()
        return await service.watches_page(principal.user_id, page.id)

    @post("/unwatch")
    async def unwatch(
        self, data: PageIdRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> dict:
        principal: Principal = request.scope["principal"]
        page = await PageAccessService(db_session).load_page(
            data.pageId, principal.workspace_id
        )
        # Право здесь не проверяется намеренно: отписаться человек должен мочь и
        # после того, как доступ к странице у него отобрали.
        await WatcherService(db_session).unwatch_page(principal.user_id, page.id)
        return {"isWatching": False, "isMuted": False}

    @post("/watch-status")
    async def watch_status(
        self, data: PageIdRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> dict:
        principal: Principal = request.scope["principal"]
        access = PageAccessService(db_session)
        page = await access.load_page(data.pageId, principal.workspace_id)
        await access.validate_can_view(page, principal.user_id)
        return await WatcherService(db_session).watches_page(principal.user_id, page.id)


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
        service = CommentService(db_session, realtime, mailer)
        found = await service.list_for_page(page, principal.user_id)
        authors = await service.authors(found)
        return [_comment_view(one, authors) for one in found]

    @post("/info")
    async def info(
        self,
        data: CommentIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        mailer: NamedDependency[NotificationMailer],
    ) -> dict:
        """Один комментарий. Право проверяется по его странице."""
        principal: Principal = request.scope["principal"]
        service = CommentService(db_session, realtime, mailer)
        found = await service.info(_comment_uuid(data.commentId), principal.user_id)
        return _comment_view(found, await service.authors([found]))

    @post("/update")
    async def update_comment(
        self,
        data: UpdateCommentRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        mailer: NamedDependency[NotificationMailer],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        service = CommentService(db_session, realtime, mailer)
        changed = await service.update(
            _comment_uuid(data.commentId), principal.user_id, data.content
        )
        return _comment_view(changed, await service.authors([changed]))

    @post("/delete")
    async def delete_comment(
        self,
        data: CommentIdRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        mailer: NamedDependency[NotificationMailer],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        await CommentService(db_session, realtime, mailer).delete(
            _comment_uuid(data.commentId), principal.user_id
        )
        return {"success": True}

    @post("/resolve")
    async def resolve_comment(
        self,
        data: ResolveCommentRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
        mailer: NamedDependency[NotificationMailer],
    ) -> dict:
        """Пометить обсуждение решённым или снять пометку."""
        principal: Principal = request.scope["principal"]
        service = CommentService(db_session, realtime, mailer)
        changed = await service.resolve(
            _comment_uuid(data.commentId), principal.user_id, data.resolved
        )
        return _comment_view(changed, await service.authors([changed]))

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


class LabelPagesRequest(msgspec.Struct):
    """Метка задаётся именем либо идентификатором. Имя приходит из адреса."""

    name: str | None = None
    labelId: str | None = None  # noqa: N815 — имя поля из v1
    spaceId: str | None = None  # noqa: N815 — имя поля из v1


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

    @post("/for-page")
    async def for_page(
        self, data: PageLabelsRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> list[dict]:
        """Метки самой страницы.

        Отдельно от списка меток рабочего пространства: тот перечисляет всё
        заведённое и служит выбору, а экран страницы показывает привязанное
        именно к ней.
        """
        principal: Principal = request.scope["principal"]
        page = await PageAccessService(db_session).load_page(data.pageId, principal.workspace_id)
        found = await LabelService(db_session).for_page(page, principal.user_id)
        return [{"id": label.id, "name": label.name} for label in found]

    @post("/pages")
    async def pages_with_label(
        self, data: LabelPagesRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> list[dict]:
        """Страницы с меткой. Путь и имя поля из v1.

        Незнакомое имя метки отвечает пустым списком, а не отказом: иначе по
        разнице ответов перебирается перечень заведённых меток.
        """
        principal: Principal = request.scope["principal"]
        found = await LabelService(db_session).pages_with(
            principal.workspace_id,
            principal.user_id,
            label_id=_label_uuid(data.labelId) if data.labelId else None,
            name=data.name,
            space_id=uuid.UUID(data.spaceId) if data.spaceId else None,
        )
        return [
            {
                "id": page.id,
                "slugId": page.slug_id,
                "title": page.title,
                "icon": page.icon,
                "spaceSlug": space.slug,
                "spaceName": space.name,
            }
            for page, space in found
        ]

    @post("/detach")
    async def detach(
        self, data: DetachLabelRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> dict:
        principal: Principal = request.scope["principal"]
        page = await PageAccessService(db_session).load_page(data.pageId, principal.workspace_id)
        await LabelService(db_session).detach(
            page, _label_uuid(data.labelId), principal.user_id
        )
        return {"status": "ok"}


class FavoriteRequest(msgspec.Struct):
    """Что отмечают. Имена полей из v1.

    Пустой вид означает страницу: так это работало до появления двух других
    видов, и клиент, который поля не шлёт, продолжает работать.
    """

    type: str | None = None
    pageId: str | None = None  # noqa: N815 — имя поля из v1
    spaceId: str | None = None  # noqa: N815 — имя поля из v1
    templateId: str | None = None  # noqa: N815 — имя поля из v1


def _favorite_uuid(raw: str | None) -> uuid.UUID:
    """Идентификатор отметки. Негодное значение — «не найдено», а не пятисотый."""
    try:
        return uuid.UUID(str(raw))
    except (TypeError, ValueError) as error:
        raise not_found("error.favorite.pageid_is_required") from error


class FavoriteController(Controller):
    path = "/api/favorites"

    @get()
    async def list_favorites(
        self, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> list[dict]:
        """Избранное со страницами и пространствами.

        Название и адрес отдаются рядом с идентификатором, чтобы экран
        избранного не запрашивал каждую страницу отдельно. Страница, к которой
        доступ снят или которая удалена, в список не попадает: отметка её
        переживает, а перечислять названия закрытого нельзя.
        """
        principal: Principal = request.scope["principal"]
        found = await FavoriteService(db_session).list_pages(
            principal.user_id, principal.workspace_id
        )
        return [
            {
                "id": favorite.id,
                "pageId": favorite.page_id,
                "type": favorite.type,
                "title": page.title,
                "slugId": page.slug_id,
                "icon": page.icon,
                # Идентификатор рядом с коротким именем: по нему экран
                # пространства отбирает своё, а короткое имя нужно ссылке.
                "spaceId": space.id,
                "spaceSlug": space.slug,
                "spaceName": space.name,
            }
            for favorite, page, space in found
        ]

    @get("/ids")
    async def favorite_ids(
        self, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> list[uuid.UUID]:
        """Только идентификаторы отмеченного.

        Экрану дерева нужна одна вещь: закрашивать ли звезду. Полный список с
        названиями ради этого — лишний обход прав на каждую строку и лишний
        объём на каждое открытие пространства.
        """
        principal: Principal = request.scope["principal"]
        found = await FavoriteService(db_session).list_for_user(
            principal.user_id, principal.workspace_id
        )
        return [one.page_id for one in found if one.page_id is not None]

    @get("/spaces")
    async def favorite_spaces(
        self, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> list[dict]:
        """Отмеченные пространства."""
        principal: Principal = request.scope["principal"]
        found = await FavoriteService(db_session).list_spaces(
            principal.user_id, principal.workspace_id
        )
        return [
            {
                "id": favorite.id,
                "spaceId": space.id,
                "type": favorite.type,
                "name": space.name,
                "slug": space.slug,
            }
            for favorite, space in found
        ]

    @get("/templates")
    async def favorite_templates(
        self, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> list[dict]:
        """Отмеченные шаблоны."""
        principal: Principal = request.scope["principal"]
        found = await FavoriteService(db_session).list_templates(
            principal.user_id, principal.workspace_id
        )
        return [
            {
                "id": favorite.id,
                "templateId": template.id,
                "type": favorite.type,
                "title": template.title,
                "icon": template.icon,
                "spaceId": template.space_id,
            }
            for favorite, template in found
        ]

    @post("/add")
    async def add(
        self, data: FavoriteRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> dict:
        """Отметить страницу, пространство или шаблон.

        Вид передаётся полем `type`, как в v1. Пустое поле означает страницу:
        так это и было до появления двух других видов, и клиент, который его не
        шлёт, продолжает работать.
        """
        principal: Principal = request.scope["principal"]
        service = FavoriteService(db_session)
        kind = (data.type or FAVORITE_PAGE).strip().lower()

        if kind == FAVORITE_SPACE:
            await service.add_space(_favorite_uuid(data.spaceId), principal.user_id)
        elif kind == FAVORITE_TEMPLATE:
            await service.add_template(_favorite_uuid(data.templateId), principal.user_id)
        elif kind == FAVORITE_PAGE:
            page = await PageAccessService(db_session).load_page(
                str(data.pageId or ""), principal.workspace_id
            )
            await service.add_page(page, principal.user_id)
        else:
            raise bad_request("error.favorite.invalid_favorite_type")
        return {"status": "ok"}

    @post("/remove")
    async def remove(
        self, data: FavoriteRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> dict:
        principal: Principal = request.scope["principal"]
        service = FavoriteService(db_session)
        kind = (data.type or FAVORITE_PAGE).strip().lower()

        # Права намеренно не проверяются ни в одном из трёх случаев: снять свою
        # запись человек должен мочь и после того, как доступ у него отобрали.
        # Разбор через общий помощник: голое `uuid.UUID` отвечало бы пятисотым
        # на опечатку, тогда как весь файл на негодный идентификатор отвечает
        # «не найдено».
        if kind == FAVORITE_SPACE:
            await service.remove_space(_favorite_uuid(data.spaceId), principal.user_id)
        elif kind == FAVORITE_TEMPLATE:
            await service.remove_template(
                _favorite_uuid(data.templateId), principal.user_id
            )
        elif kind == FAVORITE_PAGE:
            await service.remove_page(_page_uuid(data.pageId), principal.user_id)
        else:
            raise bad_request("error.favorite.invalid_favorite_type")
        return {"status": "ok"}


class ReferenceItem(msgspec.Struct):
    """Одна ссылка на чужой блок. Имена полей из v1."""

    sourcePageId: uuid.UUID  # noqa: N815 — имя поля из v1
    transclusionId: str  # noqa: N815 — имя поля из v1


class LookupRequest(msgspec.Struct):
    references: list[ReferenceItem] = msgspec.field(default_factory=list)


class ShareLookupRequest(msgspec.Struct):
    key: str
    references: list[ReferenceItem] = msgspec.field(default_factory=list)


class ReferencesRequest(msgspec.Struct):
    sourcePageId: uuid.UUID  # noqa: N815 — имя поля из v1
    transclusionId: str  # noqa: N815 — имя поля из v1


class UnsyncRequest(msgspec.Struct):
    referencePageId: uuid.UUID  # noqa: N815 — имя поля из v1
    sourcePageId: uuid.UUID  # noqa: N815 — имя поля из v1
    transclusionId: str  # noqa: N815 — имя поля из v1


class TransclusionController(Controller):
    """Включения: содержимое блоков, их места и отвязка.

    Отдельным контроллером, а не в общем: у включений своё правило доступа —
    право спрашивается у источника, а не у страницы, где показан блок.
    """

    path = "/api/pages/transclusion"

    @post("/lookup")
    async def lookup(
        self,
        data: LookupRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
    ) -> dict:
        """Содержимое включённых блоков.

        Одним запросом на всю страницу: включений на ней бывает десяток, и
        запрос на каждое превращал бы открытие страницы в десяток обращений.
        """
        principal: Principal = request.scope["principal"]
        items = await TransclusionService(db_session).lookup(
            [
                ReferenceLink(
                    source_page_id=one.sourcePageId, transclusion_id=one.transclusionId
                )
                for one in data.references
            ],
            principal.user_id,
            principal.workspace_id,
        )
        return {"items": items}

    @post("/references")
    async def references(
        self,
        data: ReferencesRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
    ) -> dict:
        """Где показан этот блок."""
        principal: Principal = request.scope["principal"]
        return await TransclusionService(db_session).references_of(
            data.sourcePageId,
            data.transclusionId,
            principal.user_id,
            principal.workspace_id,
        )

    @post("/unsync-reference")
    async def unsync(
        self,
        data: UnsyncRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        storage: NamedDependency[Storage],
    ) -> dict:
        """Отвязать блок, оставив его содержимое на странице.

        Узел ссылки заменяет клиент: документ живёт в общем сеансе правки, и
        запись мимо него разошлась бы с тем, что видят соседи.
        """
        principal: Principal = request.scope["principal"]
        return await TransclusionService(db_session).unsync(
            reference_page_id=data.referencePageId,
            source_page_id=data.sourcePageId,
            transclusion_id=data.transclusionId,
            user_id=principal.user_id,
            workspace_id=principal.workspace_id,
            storage=storage,
        )


class ShareRequest(msgspec.Struct):
    pageId: str  # noqa: N815 — имя поля из v1
    includeSubPages: bool = False  # noqa: N815 — имя поля из v1
    searchIndexing: bool = False  # noqa: N815 — имя поля из v1


class ShareKeyRequest(msgspec.Struct):
    key: str
    pageId: str | None = None  # noqa: N815 — имя поля из v1


class ShareUpdateRequest(msgspec.Struct):
    shareId: uuid.UUID  # noqa: N815 — имя поля из v1
    includeSubPages: bool | None = None  # noqa: N815 — имя поля из v1
    searchIndexing: bool | None = None  # noqa: N815 — имя поля из v1


class ShareSearchRequest(msgspec.Struct):
    key: str
    query: str


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
        self, data: VersionRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> dict:
        principal: Principal = request.scope["principal"]
        version = await PageHistoryService(db_session).get_version(
            _version_uuid(data.versionId), principal.user_id, principal.workspace_id
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
            "includeSubPages": bool(share.include_sub_pages),
        }

    @post("/")
    async def list_shares(
        self, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> list[dict]:
        """Действующие ссылки в доступных пространствах. Путь из v1."""
        principal: Principal = request.scope["principal"]
        found = await ShareService(db_session).mine(
            principal.user_id, principal.workspace_id
        )
        return [
            {
                "id": share.id,
                "key": share.key,
                "includeSubPages": bool(share.include_sub_pages),
                "searchIndexing": bool(share.search_indexing),
                "createdAt": share.created_at,
                "pageId": page.id,
                "pageTitle": page.title,
                "pageSlugId": page.slug_id,
                "spaceSlug": space.slug,
                "spaceName": space.name,
            }
            for share, page, space in found
        ]

    @post("/for-page")
    async def for_page(
        self, data: PageIdRequest, request: Request, db_session: NamedDependency[AsyncSession]
    ) -> dict | None:
        """Ссылка страницы, если она заведена. Путь и имя поля из v1."""
        principal: Principal = request.scope["principal"]
        page = await PageAccessService(db_session).load_page(
            data.pageId, principal.workspace_id
        )
        share = await ShareService(db_session).for_page(page, principal.user_id)
        if share is None:
            return None
        return {
            "id": share.id,
            "key": share.key,
            "includeSubPages": bool(share.include_sub_pages),
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
        self,
        data: ShareKeyRequest,
        db_session: NamedDependency[AsyncSession],
        tokens: NamedDependency[TokenService],
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

        share, _ = await service.resolve(data.key)
        return {
            "id": page.id,
            "slugId": page.slug_id,
            "title": page.title,
            "icon": page.icon,
            # Содержимое проходит подготовку: вложениям выписываются токены,
            # пометки обсуждений снимаются. Выдавать его как есть нельзя —
            # картинки не покажутся, а комментарии уедут постороннему.
            "content": await service.public_content(page, tokens),
            "updatedAt": page.updated_at,
            "share": {
                "id": share.id,
                "key": share.key,
                "includeSubPages": bool(share.include_sub_pages),
                "searchIndexing": bool(share.search_indexing),
                "pageId": share.page_id,
            },
        }

    @post("/update")
    async def update_share(
        self,
        data: ShareUpdateRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
    ) -> dict:
        """Изменить настройки ссылки: подстраницы и индексацию."""
        principal: Principal = request.scope["principal"]
        share = await ShareService(db_session).update(
            share_id=data.shareId,
            user_id=principal.user_id,
            workspace_id=principal.workspace_id,
            include_sub_pages=data.includeSubPages,
            search_indexing=data.searchIndexing,
        )
        return {
            "id": share.id,
            "key": share.key,
            "includeSubPages": bool(share.include_sub_pages),
            "searchIndexing": bool(share.search_indexing),
        }

    @post("/tree", opt={PUBLIC: True})
    async def tree(
        self, data: ShareKeyRequest, db_session: NamedDependency[AsyncSession]
    ) -> dict:
        """Дерево открытой ветви. Открыт по той же причине, что и `open`."""
        share, root, branch = await ShareService(db_session).tree(data.key)
        return {
            "share": {
                "id": share.id,
                "key": share.key,
                "includeSubPages": bool(share.include_sub_pages),
                "searchIndexing": bool(share.search_indexing),
                "pageId": share.page_id,
            },
            "rootId": root.id,
            "pageTree": [
                {
                    "id": one.id,
                    "slugId": one.slug_id,
                    "title": one.title,
                    "icon": one.icon,
                    "parentPageId": one.parent_page_id,
                    "position": one.position,
                }
                for one in branch
            ],
        }

    @post("/transclusion/lookup", opt={PUBLIC: True})
    async def share_lookup(
        self, data: ShareLookupRequest, db_session: NamedDependency[AsyncSession]
    ) -> dict:
        """Содержимое включённых блоков на опубликованной странице.

        Доступ задаёт ветвь публикации, а не права человека: человека здесь
        нет. Блок из страницы вне ветви не отдаётся — иначе одна опубликованная
        страница открывала бы куски любых других.
        """
        service = ShareService(db_session)
        _, _, branch = await service.tree(data.key)
        allowed = {one.id for one in branch}
        share, _ = await service.resolve(data.key)

        items = await TransclusionService(db_session).lookup_allowed(
            [
                ReferenceLink(
                    source_page_id=one.sourcePageId, transclusion_id=one.transclusionId
                )
                for one in data.references
            ],
            allowed,
            share.workspace_id,
        )
        return {"items": items}

    @post("/search", opt={PUBLIC: True})
    async def search_in_share(
        self, data: ShareSearchRequest, db_session: NamedDependency[AsyncSession]
    ) -> list[dict]:
        """Поиск внутри открытой ветви.

        Открыт по той же причине, что и сама ссылка, и отбор задаётся ею же:
        ключ определяет ветвь, за её пределы поиск не выходит.
        """
        return await ShareService(db_session).search(data.key, data.query)
