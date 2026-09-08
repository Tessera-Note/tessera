"""Разбор чужих выгрузок.

Опорные примеры взяты из проверок v1 (`confluence-archive.spec.ts`): они
собраны на настоящих выгрузках, и выдумывать их заново значило бы проверять
свою же догадку об устройстве архива.
"""

from __future__ import annotations

import pytest

from tessera_api.services.import_archives import (
    extract_confluence_page,
    is_confluence_export,
    notion_path,
    parse_confluence_attachments,
    parse_confluence_tree,
    strip_notion_id,
    title_from_file_name,
)

INDEX_HTML = """
<html><body>
  <div id="main-content">
    <div class="pageSection">
      <h2>Available Pages:</h2>
      <ul>
        <li>
          <a href="Regламент_98765.html">Регламент</a>
          <ul>
            <li>
              <a href="%D0%9F%D1%80%D0%B8%D0%BB%D0%BE%D0%B6%D0%B5%D0%BD%D0%B8%D0%B5_11111.html"
                >Приложение</a
              >
            </li>
            <li>
              <a href="Poryadok_22222.html">Порядок</a>
              <ul><li><a href="Shag_33333.html">Шаг первый</a></li></ul>
            </li>
          </ul>
        </li>
        <li><a href="Slovar_44444.html">Словарь</a></li>
      </ul>
    </div>
  </div>
</body></html>"""

PAGE = """
<html><body>
  <div id="breadcrumb-section"><ol class="breadcrumb"><li>Пространство</li></ol></div>
  <h1 id="title-heading"><span id="title-text">Регламент резервного копирования</span></h1>
  <div id="main-content">
    <div class="page-metadata">Создано пользователем Иванов</div>
    <p>Дамп снимается ежедневно.</p>
    <ul><li>Остановить приложение</li></ul>
    <div class="pageSection group"><h2>Attachments:</h2></div>
  </div>
  <div id="footer">Экспортировано Confluence</div>
</body></html>"""

WITH_ATTACHMENTS = """
<div id="main-content">
  <p>Текст страницы</p>
  <div class="pageSection group">
    <div class="pageSectionHeader"><h2 id="attachments">Attachments:</h2></div>
    <div class="greybox" align="left">
      <img src="images/icons/bullet_blue.gif" height="8" width="8" alt=""/>
      <a href="attachments/65601/65602.png">схема.png</a> (image/png)
      <br/>
      <a href="attachments/65601/65603">заметки</a> (application/octet-stream)
      <br/>
      <a href="attachments/65601/65604.drawio">архитектура.drawio</a>
      (application/vnd.jgraph.mxfile)
      <br/>
    </div>
  </div>
</div>"""


class TestRecognition:
    def test_a_confluence_index_is_recognised(self) -> None:
        assert is_confluence_export(INDEX_HTML) is True

    def test_a_foreign_index_is_not_taken_for_an_export(self) -> None:
        """Признак из разметки, а не из имени: `index.html` есть в любом архиве."""
        assert is_confluence_export("<html><body><h1>Просто страница</h1></body></html>") is False

    def test_empty_input_does_not_break_the_check(self) -> None:
        assert is_confluence_export("") is False


class TestTree:
    def test_it_is_built_from_nested_lists_not_folders(self) -> None:
        tree = parse_confluence_tree(INDEX_HTML)

        assert len(tree) == 2
        assert tree[0]["title"] == "Регламент"
        assert [one["title"] for one in tree[0]["children"]] == ["Приложение", "Порядок"]
        assert tree[0]["children"][1]["children"][0]["title"] == "Шаг первый"
        assert tree[1]["title"] == "Словарь"

    def test_a_percent_encoded_link_is_decoded(self) -> None:
        """Имена файлов в архиве лежат как есть, а ссылки закодированы."""
        tree = parse_confluence_tree(INDEX_HTML)
        assert tree[0]["children"][0]["href"] == "Приложение_11111.html"

    def test_the_order_of_siblings_is_kept(self) -> None:
        tree = parse_confluence_tree(INDEX_HTML)
        assert [one["href"] for one in tree] == ["Regламент_98765.html", "Slovar_44444.html"]

    def test_a_repeated_page_is_dropped(self) -> None:
        doubled = INDEX_HTML.replace(
            "</ul>\n    </div>",
            '<li><a href="Slovar_44444.html">Словарь</a></li></ul></div>',
        )
        hrefs = [one["href"] for one in parse_confluence_tree(doubled)]
        assert len(set(hrefs)) == len(hrefs)

    def test_links_that_are_not_pages_are_skipped(self) -> None:
        html = """<div id="main-content"><ul>
          <li><a href="attachments/1/2.png">картинка</a></li>
          <li><a href="Stranica_1.html">страница</a></li>
        </ul></div>"""

        tree = parse_confluence_tree(html)
        assert len(tree) == 1
        assert tree[0]["href"] == "Stranica_1.html"

    def test_an_index_without_lists_gives_an_empty_tree(self) -> None:
        assert parse_confluence_tree('<div id="main-content"></div>') == []


class TestPage:
    def test_the_title_comes_from_title_text(self) -> None:
        assert extract_confluence_page(PAGE).title == "Регламент резервного копирования"

    def test_the_content_comes_from_main_content(self) -> None:
        html = extract_confluence_page(PAGE).html
        assert "Дамп снимается ежедневно" in html
        assert "Остановить приложение" in html

    def test_service_sections_are_cut_out(self) -> None:
        """Обвязка самой Confluence в страницу не переносится."""
        html = extract_confluence_page(PAGE).html
        assert "Создано пользователем" not in html
        assert "Attachments:" not in html
        assert "Экспортировано Confluence" not in html
        assert "Пространство" not in html

    def test_a_page_without_main_content_gives_empty_content(self) -> None:
        page = extract_confluence_page(
            "<html><head><title>Заголовок</title></head><body></body></html>"
        )
        assert page.html == ""
        assert page.title == "Заголовок"

    def test_empty_input_does_not_break_the_parse(self) -> None:
        page = extract_confluence_page("")
        assert (page.title, page.html) == ("", "")

    def test_the_attachment_list_does_not_reach_the_content(self) -> None:
        html = extract_confluence_page(WITH_ATTACHMENTS).html
        assert "Текст страницы" in html
        assert "схема.png" not in html


class TestFallbackTitle:
    @pytest.mark.parametrize(
        ("file_name", "expected"),
        [
            ("Регламент_98765.html", "Регламент"),
            ("Poryadok deystviy_12.html", "Poryadok deystviy"),
            ("Bez id.html", "Bez id"),
        ],
    )
    def test_the_title_is_taken_from_the_file_name(self, file_name: str, expected: str) -> None:
        assert title_from_file_name(file_name) == expected


class TestAttachments:
    def test_they_are_read_with_link_name_and_type(self) -> None:
        found = parse_confluence_attachments(WITH_ATTACHMENTS)

        assert len(found) == 3
        assert found[0].href == "attachments/65601/65602.png"
        assert found[0].file_name == "схема.png"
        assert found[0].mime_type == "image/png"

    def test_a_file_without_an_extension_keeps_its_real_name(self) -> None:
        """Обычный случай выгрузки Confluence Server."""
        found = parse_confluence_attachments(WITH_ATTACHMENTS)
        assert found[1].href == "attachments/65601/65603"
        assert found[1].file_name == "заметки"
        assert found[1].mime_type == "application/octet-stream"

    def test_a_drawio_attachment_is_known_by_its_type(self) -> None:
        found = parse_confluence_attachments(WITH_ATTACHMENTS)
        assert found[2].file_name == "архитектура.drawio"
        assert found[2].mime_type == "application/vnd.jgraph.mxfile"

    def test_without_a_type_in_brackets_the_type_is_empty(self) -> None:
        """Выдумывать `octet-stream` значило бы скрыть настоящий тип."""
        found = parse_confluence_attachments(
            '<div class="pageSection group"><h2>Attachments:</h2>'
            '<div class="greybox"><a href="attachments/1/2">файл</a></div></div>'
        )
        assert found[0].mime_type == ""

    def test_bullet_images_without_a_name_are_skipped(self) -> None:
        found = parse_confluence_attachments(WITH_ATTACHMENTS)
        assert all(one.file_name for one in found)

    def test_a_repeated_link_is_dropped(self) -> None:
        html = """<div class="pageSection group"><h2>Attachments:</h2><div class="greybox">
          <a href="attachments/1/2">файл</a> (text/plain)
          <a href="attachments/1/2">файл</a> (text/plain)
        </div></div>"""
        assert len(parse_confluence_attachments(html)) == 1

    def test_a_page_without_attachments_gives_an_empty_list(self) -> None:
        assert parse_confluence_attachments('<div id="main-content"><p>Текст</p></div>') == []

    def test_empty_input_does_not_break_the_parse(self) -> None:
        assert parse_confluence_attachments("") == []


class TestNotionNames:
    """Notion приписывает к каждому имени идентификатор из тридцати двух знаков."""

    @pytest.mark.parametrize(
        ("name", "expected"),
        [
            ("Регламент 1f2e3d4c5b6a7980a1b2c3d4e5f60718.md", "Регламент.md"),
            ("Порядок-1f2e3d4c5b6a7980a1b2c3d4e5f60718", "Порядок"),
            ("Заметки 324d-35ab", "Заметки"),
            ("Обычное имя.md", "Обычное имя.md"),
            ("", ""),
        ],
    )
    def test_the_identifier_is_stripped(self, name: str, expected: str) -> None:
        assert strip_notion_id(name) == expected

    def test_a_name_made_only_of_an_identifier_is_kept(self) -> None:
        """Пустое имя хуже исходного: страница осталась бы вовсе без названия."""
        only = "1f2e3d4c5b6a7980a1b2c3d4e5f60718"
        assert strip_notion_id(only) == only

    def test_every_part_of_the_path_is_cleaned(self) -> None:
        """Каталоги Notion несут идентификатор так же, как файлы."""
        path = (
            "Пространство 1f2e3d4c5b6a7980a1b2c3d4e5f60718/"
            "Раздел 0011223344556677889900aabbccddee/"
            "Страница aabbccddeeff00112233445566778899.md"
        )
        assert notion_path(path) == "Пространство/Раздел/Страница.md"
