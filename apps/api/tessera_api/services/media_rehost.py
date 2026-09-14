"""Перенос внешних картинок на уже написанных страницах.

Перенос в своё хранилище работает для нового содержимого: помощник и редактор
кладут файл во вложения сразу (`media_fetch.py`). Страницы, написанные до
этого, остались со ссылками на чужие серверы: сегодня они открываются, завтра
адрес меняется, а на закрытом контуре не видны вовсе.

Проход заведён отдельным заданием очереди, а не маршрутом: он обходит страницы
пространства и скачивает каждую найденную картинку, то есть длится минутами, а
обращение столько не ждёт.

Работа идёт кусками и продолжается следующим заданием. Предел задания — десять
минут (`JOB_TIMEOUT`), а одно скачивание ждёт до двадцати секунд: проход по
вики с сотней внешних картинок в предел не укладывается, и снятое по времени
задание начиналось бы заново. Курсор по идентификатору страницы делает
продолжение дешёвым, а повтор — безвредным: перенесённая картинка уже своя и
второй раз не скачивается.

Отчёт уходит в журнал аудита, по записи на кусок. Своего экрана у прохода нет,
и заводить его ради одной строки незачем: журнал уже показывает, кто и когда
запустил, а подробности — сколько перенеслось и что не скачалось — лежат в
самой записи. Мёртвый адрес это и есть главный итог: по нему скачивать нечего,
и страницу правит человек.

Двоичное состояние страницы снимается вместе с содержимым: сосед по
совместному редактированию предпочитает его JSON, и оставленное вернуло бы
прежние адреса при следующем открытии страницы.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from sqlalchemy import Text, cast, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.infrastructure.models import Page
from tessera_api.infrastructure.queue import JobQueue
from tessera_api.infrastructure.storage import Storage
from tessera_api.services.attachments import AttachmentService
from tessera_api.services.audit import AuditEvent, AuditResource, AuditService
from tessera_api.services.media_fetch import external_images, move_images
from tessera_api.services.pages import extract_text

logger = logging.getLogger(__name__)

#: Сколько страниц с внешними картинками разбирается за один такт. Предел
#: задания десять минут, одно скачивание ждёт до двадцати секунд: запас нужен
#: на страницу с десятком мёртвых адресов подряд.
MAX_PAGES_PER_RUN = 25

#: Сколько страниц читается из базы за раз. Отбор запросом отсеивает не всё, и
#: тела страниц незачем держать в памяти все сразу.
CHUNK = 50

#: Сколько отказов попадает в отчёт. Перечень читает человек, и список из
#: тысячи мёртвых адресов ему не помогает — счётчик рядом называет остальные.
MAX_REPORTED_FAILURES = 50


class MediaRehostService:
    def __init__(
        self,
        session: AsyncSession,
        storage: Storage,
        queue: JobQueue | None = None,
    ) -> None:
        self._session = session
        self._storage = storage
        self._queue = queue

    async def run(
        self,
        *,
        workspace_id: uuid.UUID,
        user_id: uuid.UUID,
        size_limit: int,
        after: uuid.UUID | None = None,
    ) -> dict[str, Any]:
        """Разобрать очередной кусок страниц пространства.

        Страницы в корзине тоже обходятся: их ещё вернут, и вернуть их
        полагается с рабочими картинками.

        Отказ по одной странице не отменяет остальные: проход по вики
        останавливать из-за одного недоступного источника незачем, а повтор
        задания начал бы кусок сначала.

        Возвращает отчёт куска. Поле `next` — с какой страницы продолжать;
        пусто означает, что пространство обойдено до конца.
        """
        attachments = AttachmentService(self._session, self._storage, self._queue)

        pages = 0
        moved = 0
        failed = 0
        failures: list[dict] = []
        cursor = after
        done = False

        while pages < MAX_PAGES_PER_RUN:
            chunk = await self._candidates(workspace_id, after=cursor)
            if not chunk:
                done = True
                break

            for page in chunk:
                cursor = page.id
                found: list[str] = []
                external_images(page.content, found)
                if not found:
                    continue

                result = await self._one(
                    page=page,
                    user_id=user_id,
                    workspace_id=workspace_id,
                    attachments=attachments,
                    size_limit=size_limit,
                )
                pages += 1
                moved += result["moved"]
                failed += len(result["failures"])
                for one in result["failures"]:
                    if len(failures) < MAX_REPORTED_FAILURES:
                        failures.append({"pageId": str(page.id), **one})
                if pages >= MAX_PAGES_PER_RUN:
                    break

        report = {
            "pages": pages,
            "moved": moved,
            "failed": failed,
            "failures": failures,
            "next": None if done else (str(cursor) if cursor is not None else None),
        }
        await AuditService(self._session).log(
            event=AuditEvent.WORKSPACE_IMAGES_REHOSTED,
            resource_type=AuditResource.WORKSPACE,
            resource_id=workspace_id,
            user_id=user_id,
            workspace_id=workspace_id,
            metadata=report,
        )
        await self._session.commit()
        return report

    async def _one(
        self,
        *,
        page: Page,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        attachments: AttachmentService,
        size_limit: int,
    ) -> dict[str, Any]:
        """Одна страница. Отказ здесь не отменяет остальной проход."""
        try:
            result = await move_images(
                content=page.content,
                page_id=str(page.id),
                user_id=user_id,
                workspace_id=workspace_id,
                attachments=attachments,
                size_limit=size_limit,
            )
        except Exception as error:  # noqa: BLE001 — одна страница не отменяет проход
            logger.info("Картинки страницы %s не перенесены: %s", page.id, error)
            return {"moved": 0, "failures": [{"code": "error.media.not_stored"}]}

        if result.moved:
            await self._session.execute(
                update(Page)
                .where(Page.id == page.id)
                .values(
                    content=result.content,
                    text_content=extract_text(result.content),
                    ydoc=None,
                )
            )
        return {"moved": result.moved, "failures": result.failures}

    async def _candidates(
        self, workspace_id: uuid.UUID, *, after: uuid.UUID | None
    ) -> list[Page]:
        """Страницы, в теле которых вообще есть узел картинки.

        Отбор запросом, а не разбором каждой страницы: адрес лежит в свойствах
        узла, отдельного столбца под него нет, и читать тела всей вики ради
        того, чтобы отбросить большинство, дороже. Разбор всё равно идёт
        следом — запрос отсеивает, но не решает.

        Порядок по идентификатору, а не по времени: он единственный здесь
        строгий, и продолжение с середины не пропустит страницу и не разберёт
        её дважды.
        """
        stmt = (
            select(Page)
            .where(Page.workspace_id == workspace_id)
            .where(Page.content.isnot(None))
            .where(cast(Page.content, Text).like('%"image"%'))
            .order_by(Page.id.asc())
            .limit(CHUNK)
        )
        if after is not None:
            stmt = stmt.where(Page.id > after)
        return list((await self._session.execute(stmt)).scalars().all())
