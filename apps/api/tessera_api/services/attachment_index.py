"""Извлечение текста вложений для поиска.

Разделение обязанностей то же, что в v1, и оно принципиально: **поисковый
вектор строит база триггером, приложение его не пишет никогда**. Любой новый
путь записи `text_content` получает согласованный вектор сам собой; приложение,
пишущее вектор руками, оставило бы вложение ненаходимым при первом же обходном
пути записи.

В вектор идёт только извлечённый текст. Имя файла туда не добавляется никогда:
иначе неразобранный файл находился бы поиском по имени и выглядел бы
проиндексированным.

Три состояния, а не два. «Ещё не обработано» и «разбору не подлежит» дают
пустой `text_content` одинаково, и без отдельной отметки повторный проход
бесконечно перебирал бы одни и те же картинки и архивы.
"""

from __future__ import annotations

import logging
import uuid

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.infrastructure.document_text import extract, kind_of
from tessera_api.infrastructure.models import Attachment
from tessera_api.infrastructure.storage import Storage

logger = logging.getLogger(__name__)


class IndexStatus:
    """Состояние разбора вложения. Значения совпадают с v1: колонка одна."""

    NOT_PROCESSED = "not_processed"
    EXTRACTED = "extracted"
    UNSUPPORTED = "unsupported"


#: Сколько байт файла читать. Файл читается в память целиком, и текстовый лог
#: на сотни мегабайт иначе уронил бы процесс.
MAX_INDEX_BYTES = 2 * 1024 * 1024

#: Сколько символов сохранять. Совпадает с границей, до которой триггер строит
#: вектор: хранить больше бессмысленно, в поиск это всё равно не попадёт.
MAX_TEXT_CHARS = 1_000_000


class AttachmentIndexService:
    """Разбор вложения и запись извлечённого текста."""

    def __init__(self, session: AsyncSession, storage: Storage) -> None:
        self._session = session
        self._storage = storage

    async def index(self, attachment_id: uuid.UUID) -> str | None:
        """Разобрать одно вложение. Возвращает новое состояние или `None`.

        `None` означает, что состояние не изменилось: вложения нет, оно удалено
        или файл не прочитался. Последнее — не повод помечать файл
        неподдерживаемым: недоступное хранилище это временная беда, а пометка
        навсегда исключила бы файл из поиска.
        """
        attachment = await self._session.get(Attachment, attachment_id)
        if attachment is None or attachment.deleted_at is not None:
            return None

        if kind_of(attachment.mime_type, attachment.file_ext) is None:
            # Решение о поддержке типа принимается здесь, а не при загрузке:
            # иначе неразбираемые файлы навсегда остаются в состоянии «не
            # обработано» и неотличимы от ещё не дошедших до разбора.
            await self._mark(attachment_id, IndexStatus.UNSUPPORTED, None)
            return IndexStatus.UNSUPPORTED

        try:
            raw = await self._storage.get(attachment.file_path)
        except Exception:  # noqa: BLE001 — повтор задачи должен иметь шанс
            logger.debug("Вложение %s не прочитано из хранилища", attachment_id)
            return None

        if len(raw) > MAX_INDEX_BYTES:
            if kind_of(attachment.mime_type, attachment.file_ext) != "text":
                # Обрезать PDF или DOCX посередине нельзя: ни один из них не
                # разбирается по куску.
                await self._mark(attachment_id, IndexStatus.UNSUPPORTED, None)
                return IndexStatus.UNSUPPORTED
            raw = raw[:MAX_INDEX_BYTES]

        text = extract(raw, mime=attachment.mime_type, extension=attachment.file_ext)
        if not text.strip():
            # У PDF из сканов текстового слоя нет. Отметить это один раз
            # дешевле, чем каждый проход заново открывать тот же файл.
            await self._mark(attachment_id, IndexStatus.UNSUPPORTED, None)
            return IndexStatus.UNSUPPORTED

        await self._mark(attachment_id, IndexStatus.EXTRACTED, text[:MAX_TEXT_CHARS])
        return IndexStatus.EXTRACTED

    async def _mark(self, attachment_id: uuid.UUID, status: str, text: str | None) -> None:
        await self._session.execute(
            update(Attachment)
            .where(Attachment.id == attachment_id)
            .values(index_status=status, text_content=text)
        )
        await self._session.commit()

    async def backfill(self, workspace_id: uuid.UUID, *, limit: int = 200) -> int:
        """Разобрать необработанные вложения рабочего пространства.

        Берутся только записи в «не обработано»: разобранные уже разобраны, а
        неподдерживаемые разбору не подлежат. Обход идёт по одной записи, и
        сбой на одном файле не отменяет остальные — иначе один битый архив
        останавливал бы индексацию всего пространства.
        """
        pending = (
            (
                await self._session.execute(
                    select(Attachment.id)
                    .where(Attachment.workspace_id == workspace_id)
                    .where(Attachment.deleted_at.is_(None))
                    .where(Attachment.index_status == IndexStatus.NOT_PROCESSED)
                    .order_by(Attachment.created_at.asc())
                    .limit(limit)
                )
            )
            .scalars()
            .all()
        )

        processed = 0
        for attachment_id in pending:
            try:
                if await self.index(attachment_id) is not None:
                    processed += 1
            except Exception:  # noqa: BLE001 — один файл не отменяет обход
                logger.debug("Вложение %s не разобрано", attachment_id, exc_info=True)
        return processed
