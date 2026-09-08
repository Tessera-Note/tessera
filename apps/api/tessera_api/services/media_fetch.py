"""Перенос внешней картинки в своё хранилище.

Зачем. Ссылка на чужой сервер живёт своей жизнью: сегодня она открывается,
завтра адрес меняется, а на закрытом контуре её не видно вовсе. Помощник же
охотно сочиняет правдоподобные адреса, которых не существует, и страница
выходит с рядом пустых рамок — проверено на выдаче Wikimedia, где половина
придуманных им адресов отвечает 404.

Поэтому картинка не остаётся ссылкой: она скачивается и кладётся вложением
страницы, а в теле остаётся свой адрес. Не скачалась — это отказ, и отказ
называется вслух: человеку сообщением, помощнику перечнем в ответе инструмента,
чтобы он исправил свои ссылки, а не оставил пустые рамки.

Осторожность здесь не лишняя. Адрес приходит снаружи, а запрос по нему делает
сервер изнутри контура, где рядом стоят база, хранилище и служебные адреса
облака. Поэтому:

- разрешены только `http` и `https`;
- имя разрешается в адреса **до** запроса, и частные, петлевые, служебные и
  многоадресные диапазоны отвергаются;
- проверка повторяется на каждом перенаправлении, а не только на первом:
  перенаправление на `127.0.0.1` — известный способ обойти проверку начального
  адреса;
- размер ограничен, и предел проверяется по ходу чтения, а не после: заявленная
  длина может лгать;
- тип содержимого обязан быть картинкой.

Свой `User-Agent` обязателен: без него часть источников отвечает 403, и
исправная ссылка выглядит мёртвой.
"""

from __future__ import annotations

import ipaddress
import logging
import mimetypes
import posixpath
import socket
import uuid
from dataclasses import dataclass
from urllib.parse import quote, unquote, urlparse

import httpx

from tessera_api.services.attachments import AttachmentService

logger = logging.getLogger(__name__)

#: Сколько ждать ответа и сколько всего. Медленный источник не повод держать
#: запись страницы: помощник ждёт ответа инструмента, а человек — сохранения.
CONNECT_TIMEOUT = 5.0
TOTAL_TIMEOUT = 20.0

#: Сколько перенаправлений проходится. Больше — признак петли, а не пути.
MAX_REDIRECTS = 5

#: Чем подписывается запрос. Без подписи Wikimedia и часть CDN отвечают 403 —
#: проверено живым запросом. Адреса в подписи нет намеренно: она уходит на
#: чужие серверы, и указывать в ней своё развёртывание незачем.
USER_AGENT = "Tessera/2 (self-hosted wiki)"

#: Что принимается. Только картинки: остальное кладут вложением руками, и
#: скачивание произвольного файла по чужой ссылке — не то, чего просили.
ALLOWED_PREFIX = "image/"

#: Имя файла, когда из адреса его вывести нечем.
FALLBACK_NAME = "image"


@dataclass(frozen=True, slots=True)
class Fetched:
    """Скачанный файл."""

    data: bytes
    file_name: str
    content_type: str


class FetchRefused(Exception):
    """Отказ переноса. Несёт код для человека и подробность для помощника.

    Код — обычный ключ словаря, как у прочих отказов приложения. Подробность
    английская и в словарь не идёт: её читает модель, а не человек.
    """

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


def _refuse_private(host: str) -> None:
    """Отвергнуть имя, которое разрешается во внутренний адрес.

    Разрешение делается здесь, до запроса: `httpx` пошёл бы по имени, и проверка
    после ответа была бы проверкой уже случившегося обращения.
    """
    try:
        found = socket.getaddrinfo(host, None)
    except OSError as error:
        raise FetchRefused(
            "error.media.host_not_resolved", f"host {host!r} does not resolve"
        ) from error

    for family, *_rest in found:  # noqa: B007 — семейство не нужно, нужен адрес
        address = _rest[-1][0]
        try:
            parsed = ipaddress.ip_address(address)
        except ValueError:
            continue
        if (
            parsed.is_private
            or parsed.is_loopback
            or parsed.is_link_local
            or parsed.is_multicast
            or parsed.is_reserved
            or parsed.is_unspecified
        ):
            raise FetchRefused(
                "error.media.address_not_allowed",
                f"host {host!r} resolves to a non-public address {address}",
            )


def _check(url: str) -> str:
    """Проверить адрес и вернуть имя узла."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise FetchRefused(
            "error.media.scheme_not_allowed", f"scheme {parsed.scheme!r} is not http(s)"
        )
    if not parsed.hostname:
        raise FetchRefused("error.media.address_not_allowed", "url has no host")
    _refuse_private(parsed.hostname)
    return parsed.hostname


def name_from(url: str, content_type: str) -> str:
    """Имя файла из адреса, а расширение — из типа содержимого.

    Из адреса, потому что оно осмысленно; расширение из типа, потому что в
    адресе его может не быть вовсе (`Special:FilePath/…`), а без расширения
    хранилище отдаёт файл потоком байтов, и браузер его не показывает.
    """
    path = unquote(urlparse(url).path or "")
    base = posixpath.basename(path).strip() or FALLBACK_NAME
    guessed = mimetypes.guess_extension(content_type.split(";")[0].strip()) or ""
    if guessed and not base.lower().endswith(guessed.lower()):
        base = f"{posixpath.splitext(base)[0] or FALLBACK_NAME}{guessed}"
    return base[:200]


async def fetch_image(
    url: str, *, size_limit: int, client: httpx.AsyncClient | None = None
) -> Fetched:
    """Скачать картинку по внешнему адресу.

    Отказ — исключение `FetchRefused`: вызывающий решает, показать его человеку
    или вернуть модели. Молчаливой замены на пустоту здесь нет: пустая рамка на
    странице неотличима от потерянной картинки.
    """
    _check(url)

    own = client is None
    http = client or httpx.AsyncClient(
        timeout=httpx.Timeout(TOTAL_TIMEOUT, connect=CONNECT_TIMEOUT),
        follow_redirects=False,
        headers={"User-Agent": USER_AGENT, "Accept": "image/*,*/*;q=0.5"},
    )

    try:
        current = url
        for _ in range(MAX_REDIRECTS + 1):
            # Потоком, а не целиком: тело читается по частям, и предел размера
            # проверяется по ходу. Заявленная длина может лгать, а прочитанное
            # уже занято в памяти.
            async with http.stream("GET", current) as response:
                if response.is_redirect:
                    target = response.headers.get("location")
                    if not target:
                        raise FetchRefused(
                            "error.media.not_reachable", "redirect without a location"
                        )
                    current = str(httpx.URL(current).join(target))
                    # Проверка на каждом шаге: перенаправление внутрь контура —
                    # это обход проверки начального адреса, а не особый случай.
                    _check(current)
                    continue

                if response.status_code >= 400:
                    raise FetchRefused(
                        "error.media.not_reachable",
                        f"{url} answered {response.status_code}",
                    )

                content_type = (response.headers.get("content-type") or "").lower()
                if not content_type.startswith(ALLOWED_PREFIX):
                    raise FetchRefused(
                        "error.media.not_an_image",
                        f"{url} answered with {content_type or 'no content type'}, not an image",
                    )

                chunks: list[bytes] = []
                read = 0
                async for chunk in response.aiter_bytes():
                    read += len(chunk)
                    if read > size_limit:
                        raise FetchRefused(
                            "error.media.too_large",
                            f"{url} is over the {size_limit} byte limit",
                        )
                    chunks.append(chunk)

                data = b"".join(chunks)
                if not data:
                    raise FetchRefused(
                        "error.media.not_reachable", f"{url} answered with an empty body"
                    )

                return Fetched(
                    data=data,
                    file_name=name_from(current, content_type),
                    content_type=content_type.split(";")[0].strip(),
                )

        raise FetchRefused("error.media.not_reachable", f"{url} redirects in a loop")
    except FetchRefused:
        raise
    except httpx.HTTPError as error:
        raise FetchRefused(
            "error.media.not_reachable", f"{url} is not reachable: {error}"
        ) from error
    finally:
        if own:
            await http.aclose()


@dataclass(frozen=True, slots=True)
class Moved:
    """Итог переноса картинок одной страницы.

    `failures` — то, ради чего это заведено отдельным полем: перечень
    непереносимых адресов уходит помощнику в ответе инструмента, и он
    исправляет свои ссылки вместо того, чтобы оставить на странице пустые рамки.
    """

    content: dict
    moved: int
    failures: list[dict]


def external_images(content: object, found: list[str]) -> None:
    """Собрать внешние адреса картинок из тела документа.

    Внешний — это со схемой. Свои адреса относительные (`/api/files/...`), и
    трогать их нельзя: файл уже в хранилище.
    """
    if isinstance(content, dict):
        if content.get("type") == "image":
            src = (content.get("attrs") or {}).get("src")
            if isinstance(src, str) and "://" in src:
                found.append(src)
        for value in content.values():
            external_images(value, found)
        return
    if isinstance(content, list):
        for one in content:
            external_images(one, found)


def _with_local(content: object, replaced: dict[str, dict]) -> object:
    """Подставить свои адреса вместо внешних."""
    if isinstance(content, dict):
        made = {key: _with_local(value, replaced) for key, value in content.items()}
        attrs = made.get("attrs")
        if made.get("type") == "image" and isinstance(attrs, dict):
            local = replaced.get(str(attrs.get("src") or ""))
            if local is not None:
                made["attrs"] = {**attrs, **local}
        return made
    if isinstance(content, list):
        return [_with_local(one, replaced) for one in content]
    return content


async def move_images(
    *,
    content: dict,
    page_id: str,
    user_id: uuid.UUID,
    workspace_id: uuid.UUID,
    attachments: AttachmentService,
    size_limit: int,
) -> Moved:
    """Перенести все внешние картинки документа в своё хранилище.

    Порядок здесь важен: страница должна уже существовать, потому что вложение
    принадлежит странице и права проверяются по ней. Поэтому вызывается это
    после записи страницы, а не до.

    Один и тот же адрес переносится один раз: помощник охотно повторяет ссылку
    в перечне, и десять одинаковых картинок стали бы десятью файлами.

    Отказ по одному адресу не отменяет остальные: страница с девятью картинками
    из десяти лучше страницы без единой.
    """
    found: list[str] = []
    external_images(content, found)
    if not found:
        return Moved(content=content, moved=0, failures=[])

    replaced: dict[str, dict] = {}
    failures: list[dict] = []
    seen: set[str] = set()

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(TOTAL_TIMEOUT, connect=CONNECT_TIMEOUT),
        follow_redirects=False,
        headers={"User-Agent": USER_AGENT, "Accept": "image/*,*/*;q=0.5"},
    ) as client:
        for url in found:
            if url in seen:
                continue
            seen.add(url)
            try:
                fetched = await fetch_image(url, size_limit=size_limit, client=client)
                saved = await attachments.upload_page_file(
                    page_id_or_slug=page_id,
                    file_name=fetched.file_name,
                    data=fetched.data,
                    user_id=user_id,
                    workspace_id=workspace_id,
                    size_limit=size_limit,
                )
            except FetchRefused as refused:
                failures.append({"url": url, "code": refused.code, "detail": refused.detail})
                continue
            except Exception as error:  # noqa: BLE001 — одна картинка не отменяет страницу
                logger.info("Картинка %s не перенесена: %s", url, error)
                failures.append(
                    {"url": url, "code": "error.media.not_stored", "detail": str(error)}
                )
                continue

            replaced[url] = {
                "src": f"/api/files/{saved.id}/{quote(saved.file_name)}",
                "attachmentId": str(saved.id),
            }

    if not replaced:
        return Moved(content=content, moved=0, failures=failures)
    made = _with_local(content, replaced)
    return Moved(
        # Обход возвращает `object`, а на входе был документ: словарь на выходе
        # остаётся словарём, и приведение здесь честнее, чем глушение проверки.
        content=made if isinstance(made, dict) else content,
        moved=len(replaced),
        failures=failures,
    )
