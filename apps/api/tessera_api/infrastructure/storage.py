"""Хранилище вложений.

Два драйвера, как в v1: каталог на диске и хранилище, совместимое с протоколом
S3 (в развёртывании это MinIO рядом в compose). Выбор делает `STORAGE_DRIVER`.

Ключ объекта **никогда не приходит от клиента**. Он собирается здесь из
идентификатора рабочего пространства и идентификатора вложения; имя файла
попадает только в последний сегмент и очищается. Ключ, пришедший снаружи,
означал бы чтение и запись где угодно в хранилище — включая чужое рабочее
пространство.
"""

from __future__ import annotations

import logging
import posixpath
import re
import unicodedata
from pathlib import Path

from aiobotocore.session import get_session

logger = logging.getLogger(__name__)

#: Что остаётся в имени файла. Всё прочее заменяется подчёркиванием: имя
#: попадает в ключ объекта и в заголовок ответа, а туда не должны попадать ни
#: разделители пути, ни управляющие символы.
_SAFE_NAME = re.compile(r"[^\w.\- ]", re.UNICODE)

#: Предел длины имени. Тот же, что в v1.
MAX_FILE_NAME = 255


def sanitize_file_name(name: str) -> str:
    """Очистить имя файла.

    Разделители пути убираются до очистки: `../..%2fetc` и подобное обязано
    перестать быть путём, а не стать им после нормализации.
    """
    text = unicodedata.normalize("NFC", name or "").strip()
    text = text.replace("\\", "/").split("/")[-1]
    text = _SAFE_NAME.sub("_", text)
    text = text.strip(". ") or "file"
    return text[:MAX_FILE_NAME]


def file_extension(name: str) -> str:
    suffix = Path(sanitize_file_name(name)).suffix.lower()
    return suffix if len(suffix) <= 16 else ""


class Storage:
    """Общее поведение драйверов."""

    async def put(self, key: str, data: bytes, content_type: str | None = None) -> None:
        raise NotImplementedError

    async def get(self, key: str) -> bytes:
        raise NotImplementedError

    async def delete(self, key: str) -> None:
        raise NotImplementedError

    async def exists(self, key: str) -> bool:
        raise NotImplementedError

    async def delete_prefix(self, prefix: str) -> int:
        raise NotImplementedError


class LocalStorage(Storage):
    """Каталог на диске.

    Годится для одного экземпляра. При нескольких репликах каталог обязан быть
    общим, иначе вложение, загруженное одной репликой, не найдёт другая.
    """

    def __init__(self, root: str) -> None:
        self._root = Path(root).resolve()

    def _path(self, key: str) -> Path:
        """Путь внутри корня и только внутри него.

        Проверка обязательна даже при том, что ключ собирается приложением:
        она стоит копейки, а её отсутствие превращает любую будущую ошибку в
        сборке ключа в чтение произвольного файла.
        """
        candidate = (self._root / key).resolve()
        if candidate != self._root and self._root not in candidate.parents:
            raise ValueError(f"ключ выходит за пределы хранилища: {key!r}")
        return candidate

    async def put(self, key: str, data: bytes, content_type: str | None = None) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    async def get(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    async def delete(self, key: str) -> None:
        path = self._path(key)
        # Отсутствие файла не отказ: уборка обязана быть идемпотентной, а
        # такт может пройти дважды.
        path.unlink(missing_ok=True)

    async def exists(self, key: str) -> bool:
        return self._path(key).is_file()

    async def delete_prefix(self, prefix: str) -> int:
        root = self._path(prefix)
        if not root.is_dir():
            return 0
        removed = 0
        for path in sorted(root.rglob("*"), reverse=True):
            if path.is_file():
                path.unlink(missing_ok=True)
                removed += 1
            elif path.is_dir():
                path.rmdir()
        root.rmdir()
        return removed


class S3Storage(Storage):
    """Хранилище по протоколу S3.

    Соединение открывается на операцию. Клиент `aiobotocore` это контекстный
    менеджер, и держать его открытым на всё время жизни приложения означало бы
    держать сессию, которую нечем переоткрыть после разрыва.
    """

    def __init__(
        self,
        *,
        endpoint: str | None,
        bucket: str,
        region: str,
        access_key_id: str | None,
        secret_access_key: str | None,
        force_path_style: bool = True,
    ) -> None:
        self._bucket = bucket
        self._session = get_session()
        self._config = {
            "region_name": region,
            "aws_access_key_id": access_key_id,
            "aws_secret_access_key": secret_access_key,
        }
        if endpoint:
            self._config["endpoint_url"] = endpoint
        if force_path_style:
            from botocore.config import Config

            self._config["config"] = Config(s3={"addressing_style": "path"})

    def _client(self):  # noqa: ANN202 — контекстный менеджер aiobotocore
        return self._session.create_client("s3", **self._config)

    async def put(self, key: str, data: bytes, content_type: str | None = None) -> None:
        extra = {"ContentType": content_type} if content_type else {}
        async with self._client() as client:
            await client.put_object(Bucket=self._bucket, Key=key, Body=data, **extra)

    async def get(self, key: str) -> bytes:
        async with self._client() as client:
            response = await client.get_object(Bucket=self._bucket, Key=key)
            async with response["Body"] as stream:
                return await stream.read()

    async def delete(self, key: str) -> None:
        async with self._client() as client:
            # S3 не отличает удаление отсутствующего от удаления существующего
            # и в обоих случаях отвечает успехом. Это ровно то поведение,
            # которое нужно уборке.
            await client.delete_object(Bucket=self._bucket, Key=key)

    async def exists(self, key: str) -> bool:
        async with self._client() as client:
            try:
                await client.head_object(Bucket=self._bucket, Key=key)
            except Exception:  # noqa: BLE001 — отсутствие объекта это не отказ
                return False
            return True

    async def delete_prefix(self, prefix: str) -> int:
        removed = 0
        async with self._client() as client:
            paginator = client.get_paginator("list_objects_v2")
            async for page in paginator.paginate(Bucket=self._bucket, Prefix=prefix):
                keys = [{"Key": item["Key"]} for item in page.get("Contents", [])]
                if not keys:
                    continue
                # Пачками по тысяче: столько принимает delete_objects, и
                # обход по одному ключу на большом пространстве занял бы часы.
                for start in range(0, len(keys), 1000):
                    batch = keys[start : start + 1000]
                    await client.delete_objects(
                        Bucket=self._bucket, Delete={"Objects": batch}
                    )
                    removed += len(batch)
        return removed


def create_storage(settings) -> Storage:  # noqa: ANN001 — Settings, без обратной связи
    """Собрать драйвер по настройкам.

    Неизвестное имя драйвера — отказ на старте. Молчаливый откат к каталогу на
    диске означал бы, что развёртывание с опечаткой в `STORAGE_DRIVER` пишет
    вложения не туда, куда рассчитывали, и обнаруживается это потерей файлов
    при следующем развёртывании.
    """
    driver = (settings.storage_driver or "local").lower()
    if driver == "local":
        return LocalStorage(settings.storage_local_path)
    if driver == "s3":
        if not settings.s3_bucket:
            raise RuntimeError("STORAGE_DRIVER=s3 требует AWS_S3_BUCKET")
        return S3Storage(
            endpoint=settings.s3_endpoint,
            bucket=settings.s3_bucket,
            region=settings.s3_region,
            access_key_id=settings.s3_access_key_id,
            secret_access_key=settings.s3_secret_access_key,
            force_path_style=settings.s3_force_path_style,
        )
    raise RuntimeError(f"неизвестный STORAGE_DRIVER: {settings.storage_driver!r}")


#: Разделы хранилища по виду вложения. Имена совпадают с v1: одно развёртывание
#: обслуживает обе версии на время перехода, и раздел обязан быть тем же.
FOLDER_BY_TYPE = {
    "avatar": "avatars",
    "workspace-icon": "workspace-logos",
    "space-icon": "space-logos",
    "file": "files",
    "chat": "chat-files",
}


def attachment_key(workspace_id, attachment_id, file_name: str) -> str:
    """Ключ объекта вложения страницы.

    Первым сегментом всегда рабочее пространство: по нему уборка удалённого
    пространства сносит его вложения одним обходом по префиксу.
    """
    return posixpath.join(
        str(workspace_id), "files", str(attachment_id), sanitize_file_name(file_name)
    )


def image_key(workspace_id, kind: str, file_name: str) -> str:
    """Ключ объекта картинки: аватара или логотипа."""
    folder = FOLDER_BY_TYPE.get(kind)
    if folder is None:
        raise ValueError(f"неизвестный вид вложения: {kind!r}")
    return posixpath.join(str(workspace_id), folder, sanitize_file_name(file_name))
