"""Метки страниц и избранное."""

from __future__ import annotations

import uuid

from sqlalchemy import delete, func, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import bad_request, not_found
from tessera_api.infrastructure.models import Favorite, Label, Page, PageLabel
from tessera_api.services.page_access import PageAccessService


class LabelService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._access = PageAccessService(session)

    async def list_all(self, workspace_id: uuid.UUID) -> list[Label]:
        stmt = (
            select(Label)
            .where(Label.workspace_id == workspace_id)
            .order_by(Label.name.asc())
        )
        return list((await self._session.execute(stmt)).scalars().all())

    async def ensure(self, name: str, workspace_id: uuid.UUID) -> Label:
        """Найти метку по имени или завести.

        Сопоставление без учёта регистра: «Регламент» и «регламент» это одна
        метка, иначе список меток заполняется дублями, отличающимися только
        написанием.
        """
        clean = (name or "").strip()
        if not clean:
            raise bad_request("error.label.name_required")

        existing = (
            await self._session.execute(
                select(Label)
                .where(Label.workspace_id == workspace_id)
                .where(func.lower(Label.name) == clean.lower())
            )
        ).scalar_one_or_none()
        if existing is not None:
            return existing

        label_id = uuid.uuid4()
        await self._session.execute(
            insert(Label).values(id=label_id, name=clean, workspace_id=workspace_id)
        )
        await self._session.commit()
        return await self._session.get(Label, label_id)

    async def attach(self, page: Page, names: list[str], user_id: uuid.UUID) -> list[Label]:
        # Метка меняет страницу, поэтому нужно право правки: иначе читатель
        # переклассифицирует чужие страницы.
        await self._access.validate_can_edit(page, user_id)

        attached: list[Label] = []
        for name in names:
            label = await self.ensure(name, page.workspace_id)
            already = (
                await self._session.execute(
                    select(PageLabel)
                    .where(PageLabel.page_id == page.id)
                    .where(PageLabel.label_id == label.id)
                )
            ).scalar_one_or_none()
            if already is None:
                await self._session.execute(
                    insert(PageLabel).values(
                        id=uuid.uuid4(), page_id=page.id, label_id=label.id
                    )
                )
            attached.append(label)

        await self._session.commit()
        return attached

    async def detach(self, page: Page, label_id: uuid.UUID, user_id: uuid.UUID) -> None:
        await self._access.validate_can_edit(page, user_id)

        await self._session.execute(
            delete(PageLabel)
            .where(PageLabel.page_id == page.id)
            .where(PageLabel.label_id == label_id)
        )
        await self._session.commit()

    async def for_page(self, page: Page, user_id: uuid.UUID) -> list[Label]:
        await self._access.validate_can_view(page, user_id)

        stmt = (
            select(Label)
            .join(PageLabel, PageLabel.label_id == Label.id)
            .where(PageLabel.page_id == page.id)
            .order_by(Label.name.asc())
        )
        return list((await self._session.execute(stmt)).scalars().all())

    async def pages_with(
        self, label_id: uuid.UUID, workspace_id: uuid.UUID, user_id: uuid.UUID
    ) -> list[Page]:
        """Страницы с меткой.

        Выдача фильтруется правами: метка не должна становиться способом
        узнать о существовании закрытых страниц.
        """
        label = await self._session.get(Label, label_id)
        if label is None or label.workspace_id != workspace_id:
            raise not_found("error.label.label_not_found")

        stmt = (
            select(Page)
            .join(PageLabel, PageLabel.page_id == Page.id)
            .where(PageLabel.label_id == label_id)
            .where(Page.deleted_at.is_(None))
            .order_by(Page.title.asc())
        )
        found = list((await self._session.execute(stmt)).scalars().all())

        visible: list[Page] = []
        for page in found:
            if (await self._access.rights(page, user_id)).can_view:
                visible.append(page)
        return visible


class FavoriteService:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._access = PageAccessService(session)

    async def list_for_user(self, user_id: uuid.UUID, workspace_id: uuid.UUID) -> list[Favorite]:
        stmt = (
            select(Favorite)
            .where(Favorite.user_id == user_id)
            .where(Favorite.workspace_id == workspace_id)
            .order_by(Favorite.created_at.desc())
        )
        return list((await self._session.execute(stmt)).scalars().all())

    async def add_page(self, page: Page, user_id: uuid.UUID) -> None:
        # В избранное берётся только то, что человек видит: иначе избранное
        # переживёт снятие доступа и останется ссылкой на закрытое.
        await self._access.validate_can_view(page, user_id)

        already = (
            await self._session.execute(
                select(Favorite)
                .where(Favorite.user_id == user_id)
                .where(Favorite.page_id == page.id)
            )
        ).scalar_one_or_none()
        if already is not None:
            return

        await self._session.execute(
            insert(Favorite).values(
                id=uuid.uuid4(),
                user_id=user_id,
                page_id=page.id,
                type="page",
                workspace_id=page.workspace_id,
            )
        )
        await self._session.commit()

    async def remove_page(self, page_id: uuid.UUID, user_id: uuid.UUID) -> None:
        """Снять из избранного.

        Права здесь не проверяются намеренно: убрать свою запись человек должен
        мочь и тогда, когда доступ к странице у него уже отобрали.
        """
        await self._session.execute(
            delete(Favorite)
            .where(Favorite.user_id == user_id)
            .where(Favorite.page_id == page_id)
        )
        await self._session.commit()
