"""Разметка страниц.

Содержимое страниц хранится в Markdown и превращается в HTML при отдаче.
Источник содержимого внутренний (сид и администратор базы), поэтому HTML в
исходнике разрешен, а сторонний ввод сюда не попадает.
"""

from __future__ import annotations

from markdown_it import MarkdownIt

_renderer = MarkdownIt("commonmark", {"linkify": True}).enable("table")


def markdown_to_html(text: str) -> str:
    """Отрендерить Markdown в HTML."""
    return _renderer.render(text or "")
