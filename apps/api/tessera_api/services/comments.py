"""Комментарии к странице."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import bad_request, forbidden, not_found
from tessera_api.infrastructure.models import Comment, Page
from tessera_api.services.backlinks import extract_user_mentions
from tessera_api.services.notifications import NotificationService
from tessera_api.services.page_access import PageAccessService


class CommentService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._access = PageAccessService(session)

    async def list_for_page(self, page: Page, user_id: uuid.UUID) -> list[Comment]:
        # Комментарии несут содержимое страницы: цитаты, обсуждение решений.
        # Права проверяются те же, что и на саму страницу.
        await self._access.validate_can_view(page, user_id)

        stmt = (
            select(Comment)
            .where(Comment.page_id == page.id)
            .where(Comment.deleted_at.is_(None))
            .order_by(Comment.created_at.asc())
        )
        return list((await self._session.execute(stmt)).scalars().all())

    async def create(
        self,
        *,
        page: Page,
        user_id: uuid.UUID,
        content: dict,
        parent_comment_id: uuid.UUID | None = None,
        selection: str | None = None,
    ) -> Comment:
        # Комментировать может тот, кто видит страницу: право правки для этого
        # не нужно, читатель обсуждает, не меняя.
        await self._access.validate_can_view(page, user_id)

        if not content:
            raise bad_request("error.comment.content_required")

        if parent_comment_id is not None:
            parent = await self._session.get(Comment, parent_comment_id)
            if parent is None or parent.deleted_at is not None:
                raise not_found("error.comment.comment_not_found")
            # Ответ на комментарий чужой страницы связал бы обсуждения двух
            # страниц, и права одной перестали бы защищать другую.
            if parent.page_id != page.id:
                raise bad_request("error.comment.parent_on_other_page")

        comment_id = uuid.uuid4()
        self._session.add(
            Comment(
                id=comment_id,
                content=content,
                selection=selection,
                creator_id=user_id,
                page_id=page.id,
                parent_comment_id=parent_comment_id,
                workspace_id=page.workspace_id,
                space_id=page.space_id,
            )
        )
        created = await self._session.get(Comment, comment_id)

        # Уведомления заводятся в той же транзакции, что и комментарий: иначе
        # отказ на середине оставляет либо уведомление о том, чего нет, либо
        # комментарий, о котором никто не узнает.
        await NotificationService(self._session).notify_comment(
            page=page,
            comment=created,
            actor_id=user_id,
            mentioned_user_ids=extract_user_mentions(content),
        )
        await self._session.commit()
        return created

    async def update(self, comment_id: uuid.UUID, user_id: uuid.UUID, content: dict) -> Comment:
        comment = await self._require(comment_id)

        # Править можно только своё. Право правки страницы этого не даёт:
        # чужой комментарий это чужие слова, а не содержимое страницы.
        if comment.creator_id != user_id:
            raise forbidden("error.comment.not_yours")

        await self._session.execute(
            update(Comment)
            .where(Comment.id == comment_id)
            .values(
                content=content,
                edited_at=datetime.now(UTC),
                last_edited_by_id=user_id,
            )
        )
        await self._session.commit()
        return await self._session.get(Comment, comment_id)

    async def delete(self, comment_id: uuid.UUID, user_id: uuid.UUID) -> None:
        comment = await self._require(comment_id)

        page = await self._session.get(Page, comment.page_id)
        rights = await self._access.rights(page, user_id) if page else None

        # Удалить может автор или тот, кто правит страницу: последнему нужен
        # способ убрать чужой комментарий с рабочей страницы.
        if comment.creator_id != user_id and not (rights and rights.can_edit):
            raise forbidden("error.comment.not_yours")

        await self._session.execute(
            update(Comment).where(Comment.id == comment_id).values(deleted_at=datetime.now(UTC))
        )
        await self._session.commit()

    async def resolve(self, comment_id: uuid.UUID, user_id: uuid.UUID, resolved: bool) -> Comment:
        comment = await self._require(comment_id)

        page = await self._session.get(Page, comment.page_id)
        if page is None:
            raise not_found("error.page.page_not_found")
        await self._access.validate_can_view(page, user_id)

        await self._session.execute(
            update(Comment)
            .where(Comment.id == comment_id)
            .values(
                resolved_at=datetime.now(UTC) if resolved else None,
                resolved_by_id=user_id if resolved else None,
            )
        )
        await self._session.commit()
        return await self._session.get(Comment, comment_id)

    async def _require(self, comment_id: uuid.UUID) -> Comment:
        comment = await self._session.get(Comment, comment_id)
        if comment is None or comment.deleted_at is not None:
            raise not_found("error.comment.comment_not_found")
        return comment
