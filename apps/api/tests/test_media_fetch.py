"""Перенос внешней картинки в своё хранилище.

Проверяется два предмета. Первый — осторожность: адрес приходит снаружи, а
запрос по нему делает сервер изнутри контура, где рядом стоят база, хранилище и
служебные адреса облака. Второй — честность отказа: адрес, который не открылся,
должен быть назван, а не заменён молча пустой рамкой.
"""

from __future__ import annotations

import uuid

import httpx
import pytest
from sqlalchemy import insert
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.infrastructure.models import Page
from tessera_api.services.attachments import AttachmentService
from tessera_api.services.media_fetch import (
    FetchRefused,
    external_images,
    fetch_image,
    move_images,
    name_from,
)
from tests.conftest import needs_database
from tests.test_attachment_search import StorageDouble

#: Настоящий класс клиента. Нужен подмене: она заводит клиента сама.
REAL_CLIENT = httpx.AsyncClient

#: Годная картинка: заголовок PNG, дальше неважно.
PIXEL = b"\x89PNG\r\n\x1a\n" + b"\x00" * 40


def client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)


def answer(**values):
    def handler(request: httpx.Request) -> httpx.Response:  # noqa: ARG001
        return httpx.Response(**values)

    return handler


class TestAddressGuard:
    """Адрес проверяется до запроса, а не после."""

    async def test_only_http_is_accepted(self) -> None:
        with pytest.raises(FetchRefused) as refused:
            await fetch_image("file:///etc/passwd", size_limit=1000)
        assert refused.value.code == "error.media.scheme_not_allowed"

    @pytest.mark.parametrize(
        "url",
        [
            "http://127.0.0.1/картинка.png",
            "http://localhost/картинка.png",
            "http://169.254.169.254/latest/meta-data",
            "http://10.0.0.5/картинка.png",
            "http://192.168.1.10/картинка.png",
        ],
    )
    async def test_inside_the_perimeter_is_refused(self, url: str) -> None:
        """Адресом нельзя заставить сервер сходить внутрь контура.

        Служебный адрес облака (`169.254.169.254`) в перечне не случайно: с
        него начинается всякий разбор такой уязвимости.
        """
        with pytest.raises(FetchRefused) as refused:
            await fetch_image(url, size_limit=1000)
        assert refused.value.code == "error.media.address_not_allowed"

    async def test_an_unknown_host_is_named(self) -> None:
        with pytest.raises(FetchRefused) as refused:
            await fetch_image("https://такого-узла-точно-нет.invalid/a.png", size_limit=1000)
        assert refused.value.code == "error.media.host_not_resolved"


class TestFetching:
    async def test_an_image_comes_back_with_a_name(self) -> None:
        http = client(answer(status_code=200, content=PIXEL, headers={"content-type": "image/png"}))
        fetched = await fetch_image(
            "https://example.com/постер.png", size_limit=1000, client=http
        )
        assert fetched.data == PIXEL
        assert fetched.file_name == "постер.png"
        assert fetched.content_type == "image/png"

    async def test_a_dead_link_is_refused_with_its_code(self) -> None:
        """Ровно тот случай, ради которого всё это заведено: помощник сочиняет
        правдоподобный адрес, которого нет."""
        http = client(answer(status_code=404, text="not found"))
        with pytest.raises(FetchRefused) as refused:
            await fetch_image("https://example.com/нет.png", size_limit=1000, client=http)
        assert refused.value.code == "error.media.not_reachable"
        assert "404" in refused.value.detail

    async def test_a_page_instead_of_an_image_is_refused(self) -> None:
        # Частый ответ источников: вместо файла отдаётся страница с ним.
        http = client(
            answer(status_code=200, text="<html>", headers={"content-type": "text/html"})
        )
        with pytest.raises(FetchRefused) as refused:
            await fetch_image("https://example.com/страница", size_limit=1000, client=http)
        assert refused.value.code == "error.media.not_an_image"

    async def test_a_large_file_is_refused_by_the_limit(self) -> None:
        http = client(
            answer(status_code=200, content=b"x" * 5000, headers={"content-type": "image/png"})
        )
        with pytest.raises(FetchRefused) as refused:
            await fetch_image("https://example.com/большая.png", size_limit=1000, client=http)
        assert refused.value.code == "error.media.too_large"

    async def test_an_empty_body_is_refused(self) -> None:
        http = client(answer(status_code=200, content=b"", headers={"content-type": "image/png"}))
        with pytest.raises(FetchRefused) as refused:
            await fetch_image("https://example.com/пустая.png", size_limit=1000, client=http)
        assert refused.value.code == "error.media.not_reachable"

    async def test_a_redirect_is_followed(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/first.png":
                return httpx.Response(302, headers={"location": "https://example.com/second.png"})
            return httpx.Response(200, content=PIXEL, headers={"content-type": "image/png"})

        fetched = await fetch_image(
            "https://example.com/first.png", size_limit=1000, client=client(handler)
        )
        assert fetched.data == PIXEL

    async def test_a_redirect_inside_the_perimeter_is_refused(self) -> None:
        """Перенаправление на петлевой адрес — известный обход проверки первого
        адреса, поэтому проверяется каждый шаг."""

        def handler(request: httpx.Request) -> httpx.Response:  # noqa: ARG001
            return httpx.Response(302, headers={"location": "http://127.0.0.1/secret"})

        with pytest.raises(FetchRefused) as refused:
            await fetch_image(
                "https://example.com/first.png", size_limit=1000, client=client(handler)
            )
        assert refused.value.code == "error.media.address_not_allowed"

    async def test_a_redirect_loop_ends(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:  # noqa: ARG001
            return httpx.Response(302, headers={"location": "https://example.com/loop.png"})

        with pytest.raises(FetchRefused) as refused:
            await fetch_image(
                "https://example.com/loop.png", size_limit=1000, client=client(handler)
            )
        assert refused.value.code == "error.media.not_reachable"


class TestName:
    """Имя файла: из адреса, расширение — из типа содержимого."""

    def test_the_extension_comes_from_the_content_type(self) -> None:
        # У Wikimedia путь оканчивается на `Special:FilePath/Имя`, и расширения
        # в адресе нет вовсе. Без него хранилище отдаёт файл потоком байтов.
        assert name_from(
            "https://example.com/Special:FilePath/Постер", "image/jpeg"
        ).endswith(".jpg")

    def test_an_existing_extension_is_kept(self) -> None:
        assert name_from("https://example.com/постер.png", "image/png") == "постер.png"

    def test_an_address_without_a_path_still_gets_a_name(self) -> None:
        assert name_from("https://example.com", "image/png") == "image.png"


class TestWalking:
    """Сбор внешних адресов из тела документа."""

    def test_only_addresses_with_a_scheme_are_taken(self) -> None:
        content = {
            "type": "doc",
            "content": [
                {"type": "image", "attrs": {"src": "https://example.com/чужая.png"}},
                # Своё вложение: файл уже в хранилище, трогать его нельзя.
                {"type": "image", "attrs": {"src": "/api/files/abc/своя.png"}},
                {"type": "paragraph", "content": [{"type": "text", "text": "текст"}]},
            ],
        }
        found: list[str] = []
        external_images(content, found)
        assert found == ["https://example.com/чужая.png"]

    def test_nested_images_are_found(self) -> None:
        content = {
            "type": "doc",
            "content": [
                {
                    "type": "blockquote",
                    "content": [
                        {"type": "image", "attrs": {"src": "http://example.com/вложенная.png"}}
                    ],
                }
            ],
        }
        found: list[str] = []
        external_images(content, found)
        assert found == ["http://example.com/вложенная.png"]


@needs_database
class TestMoving:
    """Перенос картинок документа в своё хранилище.

    Проверяется то, ради чего это заведено: в теле остаётся свой адрес и
    идентификатор вложения, а адрес, который не открылся, возвращается
    перечнем — по нему помощник исправляет свои ссылки.
    """

    async def _page(self, session: AsyncSession, workspace, owner, space) -> Page:
        page_id = uuid.uuid4()
        await session.execute(
            insert(Page).values(
                id=page_id,
                slug_id=uuid.uuid4().hex[:10],
                title="С картинками",
                space_id=space.id,
                workspace_id=workspace.id,
                creator_id=owner.id,
                is_base=False,
            )
        )
        await session.commit()
        return await session.get(Page, page_id)

    def _client(self, **values):  # noqa: ANN003, ANN201 — подмена конструктора
        """Подмена `httpx.AsyncClient`: перенос заводит клиента сам.

        Доводы принимаются и отбрасываются: важна не их передача, а то, что
        запрос уходит в подменённый транспорт, а не в сеть.
        """

        def handler(request: httpx.Request) -> httpx.Response:  # noqa: ARG001
            return httpx.Response(200, content=PIXEL, headers={"content-type": "image/png"})

        # Настоящий класс берётся до подмены: обращение через модуль вернуло бы
        # саму подмену, и вызов ушёл бы в бесконечность.
        return REAL_CLIENT(
            transport=httpx.MockTransport(handler),
            follow_redirects=False,
            headers=values.get("headers"),
        )

    async def test_the_body_keeps_our_address_and_the_attachment(
        self, session: AsyncSession, workspace, owner, space, monkeypatch
    ) -> None:
        page = await self._page(session, workspace, owner, space)
        storage = StorageDouble()
        monkeypatch.setattr("tessera_api.services.media_fetch.httpx.AsyncClient", self._client)

        content = {
            "type": "doc",
            "content": [{"type": "image", "attrs": {"src": "https://example.com/постер.png"}}],
        }
        moved = await move_images(
            content=content,
            page_id=str(page.id),
            user_id=owner.id,
            workspace_id=workspace.id,
            attachments=AttachmentService(session, storage, None),
            size_limit=1024 * 1024,
        )

        assert moved.moved == 1
        assert moved.failures == []
        attrs = moved.content["content"][0]["attrs"]
        assert attrs["src"].startswith("/api/files/")
        assert attrs["attachmentId"]
        # Файл действительно лёг в хранилище, а не только в запись.
        assert storage.files

    async def test_one_address_is_moved_once(
        self, session: AsyncSession, workspace, owner, space, monkeypatch
    ) -> None:
        """Помощник охотно повторяет ссылку: десять одинаковых картинок стали бы
        десятью файлами."""
        page = await self._page(session, workspace, owner, space)
        storage = StorageDouble()
        monkeypatch.setattr("tessera_api.services.media_fetch.httpx.AsyncClient", self._client)

        same = {"type": "image", "attrs": {"src": "https://example.com/один.png"}}
        moved = await move_images(
            content={"type": "doc", "content": [same, dict(same)]},
            page_id=str(page.id),
            user_id=owner.id,
            workspace_id=workspace.id,
            attachments=AttachmentService(session, storage, None),
            size_limit=1024 * 1024,
        )

        assert moved.moved == 1
        assert len(storage.files) == 1
        first, second = moved.content["content"]
        assert first["attrs"]["src"] == second["attrs"]["src"]

    async def test_a_refused_address_is_named_and_the_rest_still_move(
        self, session: AsyncSession, workspace, owner, space, monkeypatch
    ) -> None:
        """Страница с девятью картинками из десяти лучше страницы без единой."""
        page = await self._page(session, workspace, owner, space)
        storage = StorageDouble()
        monkeypatch.setattr("tessera_api.services.media_fetch.httpx.AsyncClient", self._client)

        content = {
            "type": "doc",
            "content": [
                {"type": "image", "attrs": {"src": "http://127.0.0.1/секрет.png"}},
                {"type": "image", "attrs": {"src": "https://example.com/живая.png"}},
            ],
        }
        moved = await move_images(
            content=content,
            page_id=str(page.id),
            user_id=owner.id,
            workspace_id=workspace.id,
            attachments=AttachmentService(session, storage, None),
            size_limit=1024 * 1024,
        )

        assert moved.moved == 1
        assert moved.failures[0]["url"] == "http://127.0.0.1/секрет.png"
        assert moved.failures[0]["code"] == "error.media.address_not_allowed"
        # Отвергнутый адрес остаётся как был: подменять его нечем.
        assert moved.content["content"][0]["attrs"]["src"] == "http://127.0.0.1/секрет.png"
        assert moved.content["content"][1]["attrs"]["src"].startswith("/api/files/")

    async def test_a_body_without_images_is_left_alone(
        self, session: AsyncSession, workspace, owner, space
    ) -> None:
        page = await self._page(session, workspace, owner, space)
        content = {"type": "doc", "content": [{"type": "paragraph"}]}

        moved = await move_images(
            content=content,
            page_id=str(page.id),
            user_id=owner.id,
            workspace_id=workspace.id,
            attachments=AttachmentService(session, StorageDouble(), None),
            size_limit=1024 * 1024,
        )

        assert moved.moved == 0
        assert moved.content is content
