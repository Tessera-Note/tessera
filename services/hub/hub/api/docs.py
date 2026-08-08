"""Документация, лицензия и поддержка."""

from __future__ import annotations

from litestar import Controller, get
from litestar.di import NamedDependency
from litestar.exceptions import NotFoundException
from litestar.response import Template

from hub.config import Settings
from hub.infrastructure.repositories import DocPageRepo
from hub.rendering import markdown_to_html

LICENSE_SLUG = "license"
SUPPORT_SLUG = "support"


class DocsController(Controller):
    """Отдает страницы, на которые ссылается интерфейс продукта.

    Все ссылки интерфейса ведут сюда, наружу приложение за документацией не
    ходит.
    """

    tags = ["docs"]
    include_in_schema = False

    async def _page(self, slug: str, repo: DocPageRepo, settings: Settings) -> Template:
        page = await repo.get(slug)
        if page is None:
            raise NotFoundException(detail=f"страница {slug} не найдена")
        return Template(
            template_name="page.html",
            context={
                "product_name": settings.product_name,
                "base_url": settings.public_url.rstrip("/"),
                "support_email": settings.support_email,
                "title": page.title,
                "body_html": markdown_to_html(page.body),
                "updated_at": page.updated_at,
            },
        )

    @get("/docs", summary="Список документации")
    async def index(
        self, doc_page_repo: NamedDependency[DocPageRepo], settings: NamedDependency[Settings]
    ) -> Template:
        pages = await doc_page_repo.list_by_section("guide")
        return Template(
            template_name="index.html",
            context={
                "product_name": settings.product_name,
                "base_url": settings.public_url.rstrip("/"),
                "pages": [{"slug": p.slug, "title": p.title} for p in pages],
            },
        )

    @get("/docs/{slug:str}", summary="Страница документации")
    async def page(
        self,
        slug: str,
        doc_page_repo: NamedDependency[DocPageRepo],
        settings: NamedDependency[Settings],
    ) -> Template:
        return await self._page(slug, doc_page_repo, settings)

    @get("/license", summary="Лицензия")
    async def license_page(
        self, doc_page_repo: NamedDependency[DocPageRepo], settings: NamedDependency[Settings]
    ) -> Template:
        return await self._page(LICENSE_SLUG, doc_page_repo, settings)

    @get("/support", summary="Поддержка")
    async def support_page(
        self, doc_page_repo: NamedDependency[DocPageRepo], settings: NamedDependency[Settings]
    ) -> Template:
        return await self._page(SUPPORT_SLUG, doc_page_repo, settings)
