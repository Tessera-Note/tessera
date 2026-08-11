"""Отправка писем.

Два способа отправки и ни одного молчаливого. Драйвер `log` пишет письмо в
журнал и годится для развёртывания без почты; `smtp` отправляет по-настоящему.

Правило, стоившее v1 отдельного разбора: **отказ отправки не должен теряться**.
Письмо, которое не ушло, а выглядит ушедшим, оставляет человека ждать ссылку,
которой не будет.
"""

from __future__ import annotations

import logging
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class MailSettings:
    driver: str
    from_address: str
    from_name: str
    host: str | None = None
    port: int = 587
    username: str | None = None
    password: str | None = None
    secure: bool = False


class MailService:
    def __init__(self, settings: MailSettings) -> None:
        self._settings = settings

    @property
    def enabled(self) -> bool:
        """Уйдёт ли письмо на самом деле.

        Вызывающий обязан это знать: без настоящей отправки ссылку сброса надо
        показать иначе, а не делать вид, что письмо отправлено.
        """
        return self._settings.driver == "smtp" and bool(self._settings.host)

    def send(self, *, to: str, subject: str, body: str) -> None:
        if not self.enabled:
            # Драйвер `log`. Тело письма пишется целиком: в развёртывании без
            # почты это единственный способ добраться до ссылки сброса.
            logger.info(
                "Письмо не отправлено (драйвер log). Кому: %s. Тема: %s\n%s",
                to,
                subject,
                body,
            )
            return

        message = EmailMessage()
        message["From"] = f"{self._settings.from_name} <{self._settings.from_address}>"
        message["To"] = to
        message["Subject"] = subject
        message.set_content(body)

        # Отказ не глушится: он всплывает наружу и обрабатывается вызывающим.
        # Проглоченный здесь, он превратил бы неотправленное письмо в
        # успешный ответ.
        if self._settings.secure:
            server = smtplib.SMTP_SSL(self._settings.host, self._settings.port, timeout=20)
        else:
            server = smtplib.SMTP(self._settings.host, self._settings.port, timeout=20)

        with server:
            if not self._settings.secure:
                server.starttls()
            if self._settings.username:
                server.login(self._settings.username, self._settings.password or "")
            server.send_message(message)
