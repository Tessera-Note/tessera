"""Выпуски продукта."""

from __future__ import annotations

from litestar import Controller, get
from litestar.di import NamedDependency
from litestar.exceptions import NotFoundException
from litestar.response import Template

from hub.config import Settings
from hub.domain.dto import LatestRelease
from hub.infrastructure.repositories import ReleaseRepo
from hub.rendering import markdown_to_html


class ReleasesController(Controller):
    """Отдает сведения о выпусках приложению и человеку.

    Приложение опрашивает `/api/releases/latest` и сравнивает версию со своей.
    Ссылка «что нового» в интерфейсе ведет на `/releases`.
    """

    tags = ["releases"]

    @get("/api/releases/latest", summary="Последний выпуск")
    async def latest(
        self, release_repo: NamedDependency[ReleaseRepo], settings: NamedDependency[Settings]
    ) -> LatestRelease:
        release = await release_repo.latest()
        if release is None:
            raise NotFoundException(detail="последний выпуск не зарегистрирован")
        return LatestRelease(
            tag_name=f"v{release.version}",
            version=release.version,
            notes=release.notes,
            published_at=release.published_at,
            release_url=f"{settings.public_url.rstrip('/')}/releases",
        )

    @get("/releases", summary="Список выпусков", include_in_schema=False)
    async def index(
        self, release_repo: NamedDependency[ReleaseRepo], settings: NamedDependency[Settings]
    ) -> Template:
        releases = await release_repo.list_all()
        return Template(
            template_name="releases.html",
            context={
                "product_name": settings.product_name,
                "base_url": settings.public_url.rstrip("/"),
                "releases": [
                    {
                        "version": item.version,
                        "published_at": item.published_at,
                        "is_latest": item.is_latest,
                        "notes_html": markdown_to_html(item.notes),
                    }
                    for item in releases
                ],
            },
        )
