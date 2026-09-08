"""Разметка писем.

Письмо уходит двумя частями сразу: простым текстом и разметкой. Первая нужна
там, где разметку не показывают — почта в терминале, читалка с речевым выводом,
клиент с выключенными стилями, — вторая там, где показывают, то есть почти
везде. Одна часть без другой означает либо письмо, которое где-то не читается,
либо письмо, которое везде выглядит запиской.

**Разметка простая намеренно.** Почтовые клиенты — это два десятка разных
движков, часть из которых не знает ни внешних таблиц стилей, ни `flex`, ни
современных единиц. Здесь таблица, встроенные стили и ничего сверх этого: так
письмо выглядит одинаково и в почте на телефоне, и в клиенте двадцатилетней
давности.

Шаблоны лежат строками рядом с кодом, а не файлами. Их два, и каждый короче
экрана; отдельный каталог с загрузчиком стоил бы больше, чем экономил, а
расхождение шаблона с кодом искалось бы в двух местах вместо одного.
"""

from __future__ import annotations

from jinja2 import Environment

#: Автоэкранирование обязательно: в письмо подставляются название страницы и имя
#: человека, а их пишет человек. Без экранирования разметка из названия
#: страницы попадает в письмо как разметка.
_ENV = Environment(autoescape=True, trim_blocks=True, lstrip_blocks=True)

#: Цвета и отступы. Вынесены в одно место: письмо собирается двумя шаблонами, и
#: подпись под ними обязана выглядеть одинаково.
_STYLE = {
    "page": "background:#f5f5f5;padding:24px 0;font-family:-apple-system,"
    "BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;",
    "card": "background:#ffffff;border-radius:8px;padding:32px;max-width:560px;"
    "margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.5;",
    "button": "display:inline-block;background:#1a1a1a;color:#ffffff;"
    "text-decoration:none;padding:10px 20px;border-radius:6px;font-size:15px;",
    "footer": "color:#767676;font-size:13px;margin-top:32px;",
    "item": "padding:12px 0;border-top:1px solid #ececec;",
    "muted": "color:#767676;font-size:13px;margin:2px 0 0;",
    "link": "color:#1a1a1a;font-weight:600;text-decoration:none;",
}

_LETTER = _ENV.from_string(
    """<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>{{ subject }}</title></head>
<body style="{{ style.page }}margin:0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td>
<div style="{{ style.card }}">
<p style="margin:0 0 16px;">{{ greeting }}</p>
<p style="margin:0 0 24px;">{{ body }}</p>
{% if url %}
<p style="margin:0 0 8px;"><a href="{{ url }}" style="{{ style.button }}">{{ action }}</a></p>
{% endif %}
<p style="{{ style.footer }}">{{ footer }}</p>
</div>
</td></tr></table>
</body>
</html>
"""
)

_DIGEST = _ENV.from_string(
    """<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>{{ subject }}</title></head>
<body style="{{ style.page }}margin:0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td>
<div style="{{ style.card }}">
<p style="margin:0 0 16px;">{{ greeting }}</p>
<p style="margin:0 0 24px;">{{ body }}</p>
{% for item in items %}
<div style="{{ style.item }}">
<a href="{{ item.url }}" style="{{ style.link }}">{{ item.title }}</a>
<p style="{{ style.muted }}">{{ item.note }}</p>
</div>
{% endfor %}
<p style="{{ style.footer }}">{{ footer }}</p>
</div>
</td></tr></table>
</body>
</html>
"""
)


def letter_html(
    *,
    subject: str,
    greeting: str,
    body: str,
    action: str,
    url: str,
    footer: str,
) -> str:
    """Обычное письмо: одно событие и одна ссылка."""
    return _LETTER.render(
        subject=subject,
        greeting=greeting,
        body=body,
        action=action,
        url=url,
        footer=footer,
        style=_STYLE,
    )


def digest_html(
    *,
    subject: str,
    greeting: str,
    body: str,
    items: list[dict],
    footer: str,
) -> str:
    """Сводка: список правок за промежуток.

    Список, а не одна ссылка: сводка и заводится ради того, чтобы двенадцать
    правок пришли одним письмом вместо двенадцати.
    """
    return _DIGEST.render(
        subject=subject,
        greeting=greeting,
        body=body,
        items=items,
        footer=footer,
        style=_STYLE,
    )
