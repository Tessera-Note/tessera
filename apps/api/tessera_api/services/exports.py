"""Выгрузка страниц.

Одна страница отдаётся файлом, ветвь и пространство — архивом. Разница не в
удобстве: в архиве страницы ссылаются друг на друга, и ссылки надо переписать
на пути внутри архива, а в одиночном файле переписывать не на что.

**Отбор страниц транзитивный.** Страница попадает в архив, только если доступна
она сама **и** уже попал её родитель. Иначе доступный потомок закрытой страницы
всплывает в корне архива, и сама структура выдаёт факт существования закрытой
ветви.

**Содержимое перед выдачей правится в четырёх местах.** Упоминания людей
получают нынешние имена, упоминания страниц разворачиваются в ссылки, ссылки на
страницы архива становятся путями внутри него, адреса вложений — путями к
приложенным файлам. Всё это делается здесь, на выходе, а не в самой странице:
тело страницы хранится и в JSON, и в двоичном состоянии совместного
редактирования, и правка одного только JSON вернулась бы назад при следующем
открытии.
"""

from __future__ import annotations

import contextlib
import io
import json
import logging
import posixpath
import re
import unicodedata
import uuid
import zipfile
from dataclasses import dataclass
from urllib.parse import quote, unquote

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import bad_request, not_found
from tessera_api.infrastructure.content import ContentClient
from tessera_api.infrastructure.models import Attachment, Page, Space, User
from tessera_api.infrastructure.storage import Storage
from tessera_api.services.page_access import PageAccessService

logger = logging.getLogger(__name__)

FORMAT_MARKDOWN = "markdown"
FORMAT_HTML = "html"
FORMATS = (FORMAT_MARKDOWN, FORMAT_HTML)

EXTENSIONS = {FORMAT_MARKDOWN: ".md", FORMAT_HTML: ".html"}

#: Имя файла с порядком, значками и родством. Имя и состав те же, что в v1:
#: архив одной версии обязан ввозиться в другую.
METADATA_NAME = "tessera-metadata.json"

#: Узлы, у которых есть приложенный файл. Список тот же, что в v1
#: (`attachment-node-types.ts`): по нему собираются файлы для архива.
ATTACHMENT_NODES = ("attachment", "image", "video", "audio", "pdf", "excalidraw", "drawio")

#: Куда складываются приложенные файлы внутри архива, рядом со страницей.
FILES_FOLDER = "files"

#: Сколько страниц выгружать в один архив. Предел не от скупости: архив
#: собирается в памяти, и пространство на десять тысяч страниц уронило бы
#: процесс вместо того, чтобы отдать файл.
MAX_PAGES = 5_000

#: Ссылка на страницу вики: `/s/<пространство>/p/<адрес>` и короткая форма без
#: пространства, с доменом и без.
#:
#: Хвост адреса не сужен до латиницы, в отличие от v1. Название страницы бывает
#: на любом языке, и адрес с ним в вики открывается: страница ищется по коду в
#: конце. Сужение молча оставляло бы такие ссылки непереписанными, то есть
#: ведущими из архива наружу.
INTERNAL_LINK = re.compile(r"^(https?://)?([^/]+)?(/s/([^/]+)/)?p/([^/?#]+?)/?$")

#: Что нельзя класть в имя файла. Разделители пути — в первую очередь: название
#: страницы задаёт человек, и косая черта в нём завела бы каталог.
_UNSAFE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

_UNTITLED = "untitled"


def safe_name(title: str | None, fallback: str = _UNTITLED) -> str:
    """Название страницы, годное в имя файла.

    Замена, а не отказ: страница с косой чертой в названии — обычное дело, и
    ронять из-за неё выгрузку нельзя.
    """
    cleaned = _UNSAFE.sub("-", (title or "").strip())
    return cleaned[:120].strip(". ") or fallback


def unique_name(name: str, taken: set[str]) -> str:
    """Имя, ещё не занятое среди соседей.

    Две страницы с одинаковым названием — обычное дело, а два файла с
    одинаковым именем в одном каталоге архива значат, что второй затрёт
    первый, и одна страница молча пропадёт из выгрузки.
    """
    if name not in taken:
        taken.add(name)
        return name
    index = 1
    while f"{name} ({index})" in taken:
        index += 1
    chosen = f"{name} ({index})"
    taken.add(chosen)
    return chosen


def slug_of(title: str | None) -> str:
    """Опознаваемая часть адреса страницы.

    Косметика: страница ищется по хвостовому коду, а эта часть нужна человеку,
    чтобы ссылку было видно глазами. Поэтому здесь нет ни транслитерации, ни
    таблиц соответствия — только выброшенные разделители.
    """
    text = unicodedata.normalize("NFKC", (title or _UNTITLED)[:70]).lower()
    return re.sub(r"-{2,}", "-", re.sub(r"[^\w]+", "-", text, flags=re.UNICODE)).strip("-")


def extract_slug_id(text: str) -> str:
    """Код страницы из куска адреса вида `название-код`."""
    parts = (text or "").split("-")
    return parts[-1] if len(parts) > 1 else (text or "")


def relative_link(current: str, target: str) -> str:
    """Путь к другой странице архива относительно текущей."""
    return posixpath.relpath(target, posixpath.dirname(current) or ".")


def link_name(path: str) -> str:
    """Название страницы, восстановленное из пути внутри архива."""
    return unquote(posixpath.splitext(path.split("/")[-1])[0])


@dataclass(frozen=True, slots=True)
class Exported:
    """Готовая выгрузка: имя файла, тип и содержимое."""

    file_name: str
    media_type: str
    data: bytes


@dataclass(slots=True)
class _Placed:
    """Страница, получившая место в архиве."""

    page: Page
    path: str


def collect(content: dict | None) -> tuple[set[uuid.UUID], set[uuid.UUID], set[uuid.UUID]]:
    """Идентификаторы, встреченные в документе: люди, страницы, вложения.

    Один обход вместо трёх: узлы одни и те же, а документ бывает большим.
    """
    users: set[uuid.UUID] = set()
    pages: set[uuid.UUID] = set()
    files: set[uuid.UUID] = set()

    def visit(node: object) -> None:
        if not isinstance(node, dict):
            return
        attrs = node.get("attrs") or {}
        kind = node.get("type")
        if kind == "mention":
            target = users if attrs.get("entityType") == "user" else pages
            _add(target, attrs.get("entityId"))
        elif kind in ATTACHMENT_NODES:
            _add(files, attrs.get("attachmentId"))
        for child in node.get("content") or []:
            visit(child)

    visit(content)
    return users, pages, files


def _add(target: set[uuid.UUID], raw: object) -> None:
    with contextlib.suppress(TypeError, ValueError):
        target.add(uuid.UUID(str(raw)))


@dataclass(frozen=True, slots=True)
class LinkTarget:
    """Куда ведёт упоминание страницы, если оно доступно человеку."""

    slug_id: str
    title: str | None
    space_slug: str | None


class Rewriter:
    """Правка документа перед выдачей.

    Один проход по дереву. Четыре правки делаются вместе не ради скорости, а
    потому что все четыре — узловые: разнесённые по отдельным проходам, они
    трижды копировали бы дерево ради одного и того же обхода.
    """

    def __init__(
        self,
        *,
        names: dict[uuid.UUID, str],
        targets: dict[uuid.UUID, LinkTarget],
        paths: dict[str, str],
        current: str,
        base_url: str,
        bundled: set[uuid.UUID],
    ) -> None:
        self._names = names
        self._targets = targets
        self._paths = paths
        self._current = current
        self._base_url = base_url.rstrip("/")
        self._bundled = bundled

    def apply(self, content: dict | None) -> dict | None:
        if not content:
            return content
        return self._node(content)

    def _node(self, node: dict) -> dict:
        copy = dict(node)
        kind = copy.get("type")

        if kind == "mention":
            replaced = self._mention(copy)
            if replaced is not None:
                return replaced
        elif kind in ATTACHMENT_NODES:
            copy = self._attachment(copy)

        if copy.get("marks"):
            copy["marks"], text = self._marks(copy["marks"], copy.get("text"))
            if text is not None:
                copy["text"] = text

        if copy.get("content"):
            copy["content"] = [
                self._node(one) if isinstance(one, dict) else one for one in copy["content"]
            ]
        return copy

    def _mention(self, node: dict) -> dict | None:
        attrs = dict(node.get("attrs") or {})
        entity = attrs.get("entityType")

        if entity == "user":
            with contextlib.suppress(TypeError, ValueError):
                name = self._names.get(uuid.UUID(str(attrs.get("entityId"))))
                if name:
                    attrs["label"] = name
            node = dict(node)
            node["attrs"] = attrs
            return node

        if entity != "page":
            return None

        # Упоминание страницы вне вики не значит ничего: узла с таким видом в
        # чужом редакторе нет. Разворачивается в ссылку, а недоступное — в
        # обычный текст: ссылка на закрытую страницу выдала бы её название и
        # адрес.
        title = attrs.get("label") or _UNTITLED
        target = None
        with contextlib.suppress(TypeError, ValueError):
            target = self._targets.get(uuid.UUID(str(attrs.get("entityId"))))

        if target is None:
            return {"type": "text", "text": title}

        title = target.title or title
        href = self._page_href(target)
        if href is None:
            return {"type": "text", "text": title}
        return {"type": "text", "text": title, "marks": [{"type": "link", "attrs": {"href": href}}]}

    def _page_href(self, target: LinkTarget) -> str | None:
        local = self._paths.get(target.slug_id)
        if local is not None:
            return relative_link(self._current, local)
        if not self._base_url or not target.space_slug:
            # Ни пути внутри архива, ни адреса снаружи. Ссылка «в никуда» хуже
            # текста: по ней уходят и попадают на страницу отказа.
            return None
        return f"{self._base_url}/s/{target.space_slug}/p/{slug_of(target.title)}-{target.slug_id}"

    def _attachment(self, node: dict) -> dict:
        attrs = dict(node.get("attrs") or {})
        identifier = None
        with contextlib.suppress(TypeError, ValueError):
            identifier = uuid.UUID(str(attrs.get("attachmentId")))
        if identifier is None or identifier not in self._bundled:
            # Файла в архиве нет: либо его не просили, либо он недоступен.
            # Адрес остаётся прежним и ведёт в вики, где право проверят.
            return node
        for field in ("src", "url"):
            value = attrs.get(field)
            if isinstance(value, str):
                attrs[field] = _local_file(value)
        node = dict(node)
        node["attrs"] = attrs
        return node

    def _marks(self, marks: list, text: str | None) -> tuple[list, str | None]:
        changed = []
        for mark in marks:
            if not isinstance(mark, dict) or mark.get("type") != "link":
                changed.append(mark)
                continue
            attrs = dict(mark.get("attrs") or {})
            href = attrs.get("href")
            if not isinstance(href, str):
                changed.append(mark)
                continue

            local = self._local_href(href)
            if local is None:
                if self._base_url and href.startswith("/"):
                    # Ссылка внутрь вики на страницу, которой в архиве нет.
                    # Относительная, она из файла никуда не ведёт.
                    attrs["href"] = f"{self._base_url}{href}"
                    changed.append({**mark, "attrs": attrs})
                else:
                    changed.append(mark)
                continue

            attrs["href"] = local
            attrs["target"] = "_self"
            changed.append({**mark, "attrs": attrs})
            if text is not None and text == href:
                # Ссылка была показана самим адресом. Внутри архива адрес
                # превращается в путь к файлу, и читать его человеку незачем.
                text = link_name(local)
        return changed, text

    def _local_href(self, href: str) -> str | None:
        found = INTERNAL_LINK.match(href)
        if found is None:
            return None
        local = self._paths.get(extract_slug_id(found.group(5)))
        return None if local is None else relative_link(self._current, local)


def _local_file(url: str) -> str:
    """Адрес вложения, переписанный на путь внутри архива."""
    for prefix in ("/api/files/", "/files/"):
        if url.startswith(prefix):
            return f"{FILES_FOLDER}/{url[len(prefix):]}"
    return url


class ExportService:
    def __init__(
        self,
        session: AsyncSession,
        content: ContentClient,
        *,
        storage: Storage | None = None,
        base_url: str = "",
    ) -> None:
        self._session = session
        self._content = content
        self._storage = storage
        self._base_url = base_url
        self._access = PageAccessService(session)

    # --- наружу -----------------------------------------------------------

    async def export_page(
        self,
        page: Page,
        user_id: uuid.UUID,
        fmt: str,
        *,
        include_children: bool = False,
        include_attachments: bool = False,
    ) -> Exported:
        _assert_format(fmt)
        await self._access.validate_can_view(page, user_id)

        if not include_children and not include_attachments:
            body = await self._single(page, user_id, fmt)
            return Exported(
                file_name=f"{safe_name(page.title)}{EXTENSIONS[fmt]}",
                media_type="text/html" if fmt == FORMAT_HTML else "text/markdown",
                data=body.encode("utf-8"),
            )

        placed = await self._branch(page, user_id, fmt)
        archive = await self._archive(placed, user_id, fmt, include_attachments)
        return Exported(
            file_name=f"{safe_name(page.title)}.zip",
            media_type="application/zip",
            data=archive,
        )

    async def export_space(
        self,
        space_id: uuid.UUID,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        fmt: str,
        *,
        include_attachments: bool = False,
    ) -> Exported:
        _assert_format(fmt)

        space = await self._session.get(Space, space_id)
        if space is None or space.deleted_at is not None or space.workspace_id != workspace_id:
            raise not_found("error.space.space_not_found")

        placed = await self._tree(space_id, workspace_id, user_id, fmt)
        if not placed:
            raise bad_request("error.export.nothing_to_export")

        archive = await self._archive(placed, user_id, fmt, include_attachments)
        return Exported(
            file_name=f"{safe_name(space.name, space.slug)}-space-export.zip",
            media_type="application/zip",
            data=archive,
        )

    # --- отбор страниц ----------------------------------------------------

    async def _tree(
        self, space_id: uuid.UUID, workspace_id: uuid.UUID, user_id: uuid.UUID, fmt: str
    ) -> list[_Placed]:
        pages = (
            (
                await self._session.execute(
                    select(Page)
                    .where(Page.space_id == space_id)
                    .where(Page.workspace_id == workspace_id)
                    .where(Page.deleted_at.is_(None))
                    .order_by(Page.position.asc().nulls_last(), Page.created_at.asc())
                    .limit(MAX_PAGES)
                )
            )
            .scalars()
            .all()
        )
        return await self._place(pages, None, "", user_id, fmt)

    async def _branch(self, root: Page, user_id: uuid.UUID, fmt: str) -> list[_Placed]:
        """Страница со всем, что под ней.

        Право уже проверено у самого корня; потомки проверяются по одному, и
        закрытая ветвь обрывается целиком.
        """
        pages = (
            (
                await self._session.execute(
                    select(Page)
                    .where(Page.space_id == root.space_id)
                    .where(Page.deleted_at.is_(None))
                    .order_by(Page.position.asc().nulls_last(), Page.created_at.asc())
                    .limit(MAX_PAGES)
                )
            )
            .scalars()
            .all()
        )
        taken: set[str] = set()
        name = unique_name(safe_name(root.title, root.slug_id), taken)
        placed = [_Placed(page=root, path=f"{name}{EXTENSIONS[fmt]}")]
        placed.extend(await self._place(pages, root.id, f"{name}/", user_id, fmt))
        return placed

    async def _place(
        self,
        pages: list[Page],
        parent_id: uuid.UUID | None,
        prefix: str,
        user_id: uuid.UUID,
        fmt: str,
    ) -> list[_Placed]:
        """Разложить страницы по каталогам архива, обходя дерево сверху.

        Обход именно сверху и именно с обрывом ветви: доступный потомок
        закрытой страницы, всплывший в корне, выдал бы существование закрытой
        ветви и её родство.
        """
        children: dict[uuid.UUID | None, list[Page]] = {}
        for page in pages:
            children.setdefault(page.parent_page_id, []).append(page)

        placed: list[_Placed] = []

        async def walk(current: uuid.UUID | None, at: str) -> None:
            taken: set[str] = set()
            for page in children.get(current, []):
                if not (await self._access.rights(page, user_id)).can_view:
                    continue
                name = unique_name(safe_name(page.title, page.slug_id), taken)
                placed.append(_Placed(page=page, path=f"{at}{name}{EXTENSIONS[fmt]}"))
                await walk(page.id, f"{at}{name}/")

        await walk(parent_id, prefix)
        return placed

    # --- сборка -----------------------------------------------------------

    async def _single(self, page: Page, user_id: uuid.UUID, fmt: str) -> str:
        """Одна страница файлом.

        Путей внутри архива нет, и словарь путей пуст намеренно: переписывать
        ссылки не на что, а упоминания страниц разворачиваются в обычные
        адреса вики.
        """
        names, targets = await self._context([page], user_id)
        rewriter = Rewriter(
            names=names,
            targets=targets,
            paths={},
            current="",
            base_url=self._base_url,
            bundled=set(),
        )
        return await self._render(page, rewriter.apply(page.content), fmt)

    async def _archive(
        self, placed: list[_Placed], user_id: uuid.UUID, fmt: str, include_attachments: bool
    ) -> bytes:
        bundled = (
            await self._accessible_attachments(placed, user_id) if include_attachments else {}
        )
        # Имена людей и упомянутые страницы читаются один раз на весь архив.
        # Внутри цикла это был бы запрос на страницу, то есть тысячи запросов
        # там, где хватает двух.
        names, targets = await self._context([one.page for one in placed], user_id)
        paths = {one.page.slug_id: quote(one.path) for one in placed}

        buffer = io.BytesIO()
        listing: dict[str, dict] = {}
        by_id = {one.page.id: one.path for one in placed}

        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            written: set[str] = set()
            for one in placed:
                rewriter = Rewriter(
                    names=names,
                    targets=targets,
                    paths=paths,
                    current=quote(one.path),
                    base_url=self._base_url,
                    bundled=set(bundled),
                )
                content = rewriter.apply(one.page.content)
                archive.writestr(one.path, await self._render(one.page, content, fmt))

                if bundled:
                    await self._write_files(archive, one, bundled, written)

                parent = one.page.parent_page_id
                listing[one.path] = {
                    "pageId": str(one.page.id),
                    "slugId": one.page.slug_id,
                    "icon": one.page.icon,
                    "position": one.page.position,
                    "parentPath": by_id.get(parent) if parent is not None else None,
                    "createdAt": _moment(one.page.created_at),
                    "updatedAt": _moment(one.page.updated_at),
                }

            # Оглавление кладётся всегда, даже пустое: его отсутствие ввоз
            # читает как «архив не наш» и теряет значки с порядком.
            archive.writestr(
                METADATA_NAME,
                json.dumps({"source": "tessera", "pages": listing}, ensure_ascii=False, indent=2),
            )
        return buffer.getvalue()

    async def _write_files(
        self,
        archive: zipfile.ZipFile,
        one: _Placed,
        bundled: dict[uuid.UUID, Attachment],
        written: set[str],
    ) -> None:
        """Положить рядом со страницей её вложения.

        Рядом, а не в общий каталог: адрес внутри страницы переписан на путь
        относительно неё самой, и общий каталог пришлось бы адресовать вверх по
        дереву на неизвестное заранее число уровней.
        """
        folder = posixpath.dirname(one.path)
        _, _, files = collect(one.page.content)
        for identifier in files:
            attachment = bundled.get(identifier)
            if attachment is None:
                continue
            name = safe_name(attachment.file_name, str(identifier))
            path = posixpath.join(
                folder, FILES_FOLDER, str(attachment.id), name
            )
            if path in written:
                continue
            try:
                data = await self._storage.get(attachment.file_path)
            except Exception:  # noqa: BLE001 — потерянный файл не отменяет выгрузку
                logger.warning("Вложение %s не прочитано, пропущено", attachment.id)
                continue
            archive.writestr(path, data)
            written.add(path)

    async def _context(
        self, pages: list[Page], user_id: uuid.UUID
    ) -> tuple[dict[uuid.UUID, str], dict[uuid.UUID, LinkTarget]]:
        """Всё, что для правки документов надо прочитать из базы."""
        users: set[uuid.UUID] = set()
        mentioned: set[uuid.UUID] = set()
        for page in pages:
            found_users, found_pages, _ = collect(page.content)
            users |= found_users
            mentioned |= found_pages
        return await self._names(users), await self._targets(mentioned, user_id)

    async def _names(self, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
        if not ids:
            return {}
        found = (
            (await self._session.execute(select(User).where(User.id.in_(ids)))).scalars().all()
        )
        # Человек без имени остаётся с замороженным значением: пустое имя в
        # выгрузке хуже устаревшего.
        return {one.id: one.name for one in found if one.name}

    async def _targets(
        self, ids: set[uuid.UUID], user_id: uuid.UUID
    ) -> dict[uuid.UUID, LinkTarget]:
        """Упомянутые страницы, из которых человеку видна каждая.

        Недоступные не попадают сюда вовсе: упоминание развернётся в текст, и
        ни название, ни адрес закрытой страницы наружу не уйдут.
        """
        if not ids:
            return {}

        allowed = set(await self._access.filter_viewable(list(ids), user_id))
        if not allowed:
            return {}

        rows = (
            await self._session.execute(
                select(Page, Space.slug)
                .join(Space, Space.id == Page.space_id)
                .where(Page.id.in_(allowed))
                .where(Page.deleted_at.is_(None))
            )
        ).all()
        return {
            page.id: LinkTarget(slug_id=page.slug_id, title=page.title, space_slug=slug)
            for page, slug in rows
        }

    async def _render(self, page: Page, content: dict | None, fmt: str) -> str:
        """Отдать страницу в запрошенном виде.

        Название добавляется первым заголовком: в самой странице оно живёт
        отдельным полем, а в файле отдельного поля нет, и без заголовка
        выгруженная страница начинается сразу с текста.
        """
        body = dict(content or {"type": "doc", "content": []})
        if page.title:
            head = {
                "type": "heading",
                "attrs": {"level": 1},
                "content": [{"type": "text", "text": page.title}],
            }
            body["content"] = [head, *(body.get("content") or [])]

        if fmt == FORMAT_HTML:
            inner = await self._content.json_to_html(body)
            title = _escape(page.title or _UNTITLED)
            return (
                "<!DOCTYPE html>\n<html>\n<head>\n"
                f'<meta charset="utf-8">\n<title>{title}</title>\n'
                f"</head>\n<body>{inner}</body>\n</html>"
            )
        return await self._content.json_to_markdown(body)

    async def _accessible_attachments(
        self, placed: list[_Placed], user_id: uuid.UUID
    ) -> dict[uuid.UUID, Attachment]:
        """Вложения, которые можно положить в архив.

        Право проверяется по странице-владельцу, а не по пространству: файл,
        приложенный к закрытой странице, доступен ровно тем, кому доступна она.
        Ссылку на такой файл можно вставить и в открытую страницу — тогда в
        вики он не открывается, и в архиве его быть тоже не должно.
        """
        if self._storage is None:
            raise bad_request("error.export.attachments_unavailable")

        wanted: set[uuid.UUID] = set()
        for one in placed:
            wanted |= collect(one.page.content)[2]
        if not wanted:
            return {}

        found = (
            (
                await self._session.execute(
                    select(Attachment)
                    .where(Attachment.id.in_(wanted))
                    .where(Attachment.deleted_at.is_(None))
                )
            )
            .scalars()
            .all()
        )

        owners = {one.page_id for one in found if one.page_id is not None}
        allowed = set(await self._access.filter_viewable(list(owners), user_id))
        return {one.id: one for one in found if one.page_id in allowed}


def _assert_format(fmt: str) -> None:
    if fmt not in FORMATS:
        raise bad_request("error.export.unknown_format", {"allowed": ", ".join(FORMATS)})


def _moment(value: object) -> str | None:
    return value.isoformat() if hasattr(value, "isoformat") else None


def _escape(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )
