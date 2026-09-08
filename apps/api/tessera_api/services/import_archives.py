"""Разбор чужих выгрузок: Confluence и Notion.

Своя выгрузка задаёт дерево каталогами, и разбирать в ней нечего. Чужие
устроены иначе, и каждая по-своему.

**Confluence** кладёт все страницы плоско в корень архива, а иерархию пишет
вложенными списками в `index.html`. Построить дерево по каталогам поэтому
нельзя. Сама страница лежит внутри `#main-content` вперемешку с обвязкой
самой Confluence — хлебными крошками, подписью автора, списком вложений.

**Notion** дерево задаёт каталогами, но к каждому имени приписывает
тридцатидвухзначный идентификатор: `Регламент 1f2e....md`. Без его срезания
страницы приезжают с идентификатором в заголовке, а ссылки между ними никуда
не ведут.

Разбор написан на стандартном разборщике HTML, а не на стороннем: сторонний
был бы новой зависимостью в рантайме. Правила и опорные примеры взяты из v1
(`ee/confluence-import/confluence-archive.ts` и его проверки) — они собраны на
настоящих выгрузках, и выдумывать их заново значило бы гадать.

Качество разбора самого содержимого страницы этим модулем не решается: HTML
страницы уходит в тот же путь, что и при обычном ввозе HTML.
"""

from __future__ import annotations

import posixpath
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from urllib.parse import unquote

#: Разделы Confluence, которые не являются содержимым страницы.
SERVICE_SECTIONS = (
    ("class", "pageSection group"),
    ("class", "page-metadata"),
    ("class", "footer-body"),
    ("class", "breadcrumb-section"),
    ("id", "footer"),
    ("id", "breadcrumb-section"),
)

#: Теги, у которых нет закрывающего.
VOID_TAGS = frozenset(
    {
        "area",
        "base",
        "br",
        "col",
        "embed",
        "hr",
        "img",
        "input",
        "link",
        "meta",
        "source",
        "track",
        "wbr",
    }
)


def _classes(attrs: dict[str, str]) -> set[str]:
    return set((attrs.get("class") or "").split())


def _is_service(attrs: dict[str, str]) -> bool:
    """Служебный ли это раздел выгрузки."""
    names = _classes(attrs)
    for kind, value in SERVICE_SECTIONS:
        if kind == "id" and attrs.get("id") == value:
            return True
        if kind == "class" and set(value.split()) <= names:
            return True
    return False


@dataclass
class _Node:
    """Узел дерева страниц выгрузки."""

    href: str
    title: str
    children: list[_Node] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class ConfluencePage:
    """Заголовок и содержимое одной страницы выгрузки."""

    title: str
    html: str


@dataclass(frozen=True, slots=True)
class ConfluenceAttachment:
    """Вложение из раздела «Attachments».

    Confluence Server кладёт файлы под числовыми именами без расширения
    (`attachments/65601/65602`), а настоящее имя и тип пишет рядом со ссылкой.
    Без этого разбора вложение попадает в страницу под числовым именем.
    """

    href: str
    file_name: str
    mime_type: str


class _Reader(HTMLParser):
    """Разборщик, который помнит, внутри чего он находится.

    Полного дерева не строит: всё нужное решается по стопке открытых тегов, а
    дерево на стандартном разборщике вышло бы вдвое длиннее и ничего бы не
    добавило.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[tuple[str, dict[str, str]]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {name: (value or "") for name, value in attrs}
        self.on_open(tag, values)
        if tag not in VOID_TAGS:
            self.stack.append((tag, values))

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.on_open(tag, {name: (value or "") for name, value in attrs})

    def handle_endtag(self, tag: str) -> None:
        for at in range(len(self.stack) - 1, -1, -1):
            if self.stack[at][0] == tag:
                closed = self.stack[at:]
                del self.stack[at:]
                for name, values in reversed(closed):
                    self.on_close(name, values)
                return

    def inside(self, tag: str, *, attr: str | None = None, value: str | None = None) -> bool:
        for name, attrs in self.stack:
            if name != tag:
                continue
            if attr is None:
                return True
            if attr == "class" and value in _classes(attrs):
                return True
            if attr != "class" and attrs.get(attr) == value:
                return True
        return False

    def on_open(self, tag: str, attrs: dict[str, str]) -> None: ...

    def on_close(self, tag: str, attrs: dict[str, str]) -> None: ...


class _MarkerReader(_Reader):
    """Ищет признаки выгрузки Confluence."""

    def __init__(self) -> None:
        super().__init__()
        self.main = False
        self.section = False
        self.page_link = False

    def on_open(self, tag: str, attrs: dict[str, str]) -> None:
        if attrs.get("id") == "main-content":
            self.main = True
        if "pageSection" in _classes(attrs):
            self.section = True
        page_link = tag == "a" and attrs.get("href", "").lower().endswith(".html")
        if page_link and (
            self.inside("div", attr="id", value="main-content")
            or self.inside("div", attr="class", value="pageSection")
        ):
            self.page_link = True


def is_confluence_export(index_html: str) -> bool:
    """Выгрузка ли это Confluence.

    Признак берётся из разметки, а не из имени файла: `index.html` есть в
    любом архиве, а `#main-content` вместе со списком страниц — примета
    выгрузки пространства.
    """
    if not index_html:
        return False
    reader = _MarkerReader()
    reader.feed(index_html)
    return reader.main and (reader.section or reader.page_link)


class _TreeReader(_Reader):
    """Собирает дерево страниц по вложенным спискам."""

    def __init__(self) -> None:
        super().__init__()
        self.roots: list[_Node] = []
        #: Списки, открытые сейчас. Каждый — перечень своих узлов.
        self.levels: list[list[_Node]] = []
        #: Узел, чьи потомки собираются в следующем вложенном списке.
        self.parents: list[_Node | None] = []
        self.current: _Node | None = None
        self.seen: set[str] = set()
        self.text: list[str] = []

    def on_open(self, tag: str, attrs: dict[str, str]) -> None:
        if tag == "ul":
            # Вложенный список принадлежит последнему открытому пункту.
            self.parents.append(self.current)
            self.levels.append([])
            return

        if tag == "a" and self.levels:
            href = unquote(attrs.get("href", ""))
            if not href.lower().endswith((".html", ".htm")) or href in self.seen:
                self.current = None
                self.text = []
                return
            self.seen.add(href)
            self.current = _Node(href=href, title="")
            self.text = []
            self.levels[-1].append(self.current)

    def handle_data(self, data: str) -> None:
        if self.current is not None and self.inside("a"):
            self.text.append(data)

    def on_close(self, tag: str, attrs: dict[str, str]) -> None:
        if tag == "a" and self.current is not None:
            self.current.title = "".join(self.text).strip()
            self.text = []
            return

        if tag == "ul" and self.levels:
            done = self.levels.pop()
            owner = self.parents.pop() if self.parents else None
            if owner is None:
                self.roots.extend(done)
            else:
                owner.children.extend(done)
            # Дальше пункты набирает список уровнем выше.
            self.current = owner


def parse_confluence_tree(index_html: str) -> list[dict]:
    """Дерево страниц из `index.html`.

    Иерархия задана вложенными списками: все страницы лежат в корне архива
    плоско, и по каталогам дерево не построить.
    """
    if not index_html:
        return []
    reader = _TreeReader()
    reader.feed(index_html)

    def shape(node: _Node) -> dict:
        return {
            "href": node.href,
            "title": node.title,
            "children": [shape(one) for one in node.children],
        }

    return [shape(one) for one in reader.roots]


class _PageReader(_Reader):
    """Достаёт заголовок и содержимое `#main-content`."""

    def __init__(self) -> None:
        super().__init__()
        self.title = ""
        self.doc_title = ""
        self.parts: list[str] = []
        #: Глубина стопки в миг открытия `#main-content`.
        self.depth: int | None = None
        #: Глубина, ниже которой всё отбрасывается: служебный раздел.
        self.skip: int | None = None

    def _capturing(self) -> bool:
        return self.depth is not None and self.skip is None

    def on_open(self, tag: str, attrs: dict[str, str]) -> None:
        if attrs.get("id") == "main-content" and self.depth is None:
            self.depth = len(self.stack)
            return

        if self._capturing() and _is_service(attrs):
            self.skip = len(self.stack)
            return

        if self._capturing():
            self.parts.append(self._open_tag(tag, attrs))

    def _open_tag(self, tag: str, attrs: dict[str, str]) -> str:
        written = "".join(f' {name}="{value}"' for name, value in attrs.items())
        return f"<{tag}{written}{' /' if tag in VOID_TAGS else ''}>"

    def handle_data(self, data: str) -> None:
        if self.inside("span", attr="id", value="title-text"):
            self.title += data
        elif self.inside("title"):
            self.doc_title += data
        if self._capturing():
            self.parts.append(data)

    def on_close(self, tag: str, attrs: dict[str, str]) -> None:
        if self.skip is not None and len(self.stack) <= self.skip:
            self.skip = None
            return
        if self.depth is not None and len(self.stack) < self.depth:
            self.depth = None
            return
        if self._capturing() and tag not in VOID_TAGS:
            self.parts.append(f"</{tag}>")


def extract_confluence_page(html: str) -> ConfluencePage:
    """Заголовок и содержимое страницы выгрузки."""
    if not html:
        return ConfluencePage(title="", html="")

    reader = _PageReader()
    reader.feed(html)
    title = reader.title.strip() or reader.doc_title.strip()
    return ConfluencePage(title=title, html="".join(reader.parts).strip())


class _AttachmentReader(_Reader):
    """Разбирает раздел «Attachments».

    Имя лежит текстом ссылки, тип — в скобках сразу за ней. Разбирать надо до
    вырезания служебных разделов: сам раздел вложений и есть служебный.
    """

    def __init__(self) -> None:
        super().__init__()
        self.found: list[ConfluenceAttachment] = []
        self.seen: set[str] = set()
        self.href: str | None = None
        self.text: list[str] = []
        #: Ссылка, для которой ещё ждём тип в скобках.
        self.pending: tuple[str, str] | None = None

    def _in_section(self) -> bool:
        return self.inside("div", attr="class", value="pageSection") and self.inside(
            "div", attr="class", value="group"
        )

    def on_open(self, tag: str, attrs: dict[str, str]) -> None:
        if tag != "a" or not self._in_section():
            return
        href = attrs.get("href", "")
        if not href or href in self.seen:
            self.href = None
            return
        self.href = href
        self.text = []

    def handle_data(self, data: str) -> None:
        if self.href is not None and self.inside("a"):
            self.text.append(data)
            return
        if self.pending is None:
            return
        # Тип идёт сразу за ссылкой в скобках; его отсутствие — обычный случай.
        found = re.match(r"\s*\(([^)]*)\)", data)
        href, name = self.pending
        self.pending = None
        self.seen.add(href)
        self.found.append(
            ConfluenceAttachment(
                href=href, file_name=name, mime_type=(found.group(1).strip() if found else "")
            )
        )

    def on_close(self, tag: str, attrs: dict[str, str]) -> None:
        if tag != "a" or self.href is None:
            return
        name = "".join(self.text).strip()
        href, self.href, self.text = self.href, None, []
        # Картинки-маркеры без подписи вложениями не являются.
        if name:
            self.pending = (href, name)


def parse_confluence_attachments(html: str) -> list[ConfluenceAttachment]:
    """Вложения страницы из раздела «Attachments»."""
    if not html:
        return []
    reader = _AttachmentReader()
    reader.feed(html)
    # Ссылка в самом конце раздела остаётся без разобранного типа.
    if reader.pending is not None:
        href, name = reader.pending
        if href not in reader.seen:
            reader.found.append(ConfluenceAttachment(href=href, file_name=name, mime_type=""))
    return reader.found


def title_from_file_name(file_name: str) -> str:
    """Заголовок из имени файла Confluence.

    Файлы называются `Заголовок_1234567.html`. Запасной путь: заголовок в
    самой странице бывает не всегда.
    """
    base = re.sub(r"\.html?$", "", file_name, flags=re.IGNORECASE)
    return re.sub(r"_\d+$", "", base).replace("_", " ").strip()


#: Тридцатидвухзначный идентификатор Notion в конце имени, с разделителем и без.
NOTION_ID = re.compile(r"[ -]?[a-z0-9]{32}$", re.IGNORECASE)
#: Короткая форма, которую Notion приписывает при совпадении названий.
NOTION_SHORT_ID = re.compile(r" [a-f0-9]{4}-[a-f0-9]{4}$", re.IGNORECASE)


def strip_notion_id(name: str) -> str:
    """Убрать идентификатор Notion из имени файла или каталога.

    Notion приписывает его к каждому имени, и без срезания он попадает и в
    заголовок страницы, и в имя ветви дерева.
    """
    stem, dot, suffix = name.rpartition(".")
    base = stem if dot else name
    cleaned = NOTION_SHORT_ID.sub("", NOTION_ID.sub("", base)).strip()
    if not cleaned:
        # Имя состояло из одного идентификатора: пустое имя хуже исходного.
        return name
    return f"{cleaned}.{suffix}" if dot else cleaned


def notion_path(path: str) -> str:
    """Путь внутри архива без идентификаторов Notion — во всех его частях."""
    return posixpath.join(*(strip_notion_id(one) for one in path.split("/"))) if path else path
