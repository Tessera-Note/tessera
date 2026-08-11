"""Хранилище вложений.

Проверяется на настоящем каталоге, а не на подделке файловой системы: защита от
выхода за пределы корня опирается на разрешение путей операционной системой, и
подделка проверяла бы подделку.

Драйвер S3 здесь не проверяется: для него нужен живой MinIO, и это проверка
развёртывания, а не кода. Общее для обоих драйверов — сборка ключа и очистка
имени — проверяется здесь.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from tessera_api.config import _parse_size
from tessera_api.infrastructure.storage import (
    LocalStorage,
    attachment_key,
    create_storage,
    file_extension,
    image_key,
    sanitize_file_name,
)


class TestFileNames:
    @pytest.mark.parametrize(
        ("given", "expected"),
        [
            ("отчёт.pdf", "отчёт.pdf"),
            ("../../etc/passwd", "passwd"),
            ("..\\..\\windows\\system32", "system32"),
            ("a/b/c.txt", "c.txt"),
            ("  пробелы .txt  ", "пробелы .txt"),
            ("", "file"),
            ("...", "file"),
            ("файл\x00обрыв.txt", "файл_обрыв.txt"),
            ("два\nстроки.txt", "два_строки.txt"),
        ],
    )
    def test_dangerous_names_lose_their_teeth(self, given: str, expected: str) -> None:
        """Разделители пути убираются, имя остаётся именем.

        Имя приходит от загрузившего и попадает и в ключ объекта, и в заголовок
        ответа. Разделитель, доживший до ключа, означает запись куда угодно.
        """
        assert sanitize_file_name(given) == expected

    def test_long_name_is_cut(self) -> None:
        assert len(sanitize_file_name("я" * 400 + ".txt")) == 255

    @pytest.mark.parametrize(
        ("given", "expected"),
        [("файл.PDF", ".pdf"), ("файл", ""), ("a.tar.gz", ".gz"), ("x." + "y" * 40, "")],
    )
    def test_extension(self, given: str, expected: str) -> None:
        assert file_extension(given) == expected


class TestKeys:
    def test_attachment_key_starts_with_the_workspace(self) -> None:
        """Первым сегментом всегда рабочее пространство.

        По нему уборка удалённого пространства сносит его вложения одним
        обходом по префиксу, не перебирая строки.
        """
        workspace = uuid.uuid4()
        key = attachment_key(workspace, uuid.uuid4(), "файл.txt")
        assert key.startswith(f"{workspace}/files/")

    def test_attachment_key_neutralises_the_file_name(self) -> None:
        key = attachment_key(uuid.uuid4(), uuid.uuid4(), "../../../etc/passwd")
        assert ".." not in key
        assert key.endswith("/passwd")

    def test_image_key_uses_the_folder_of_its_kind(self) -> None:
        workspace = uuid.uuid4()
        assert image_key(workspace, "avatar", "a.png") == f"{workspace}/avatars/a.png"
        assert image_key(workspace, "space-icon", "a.png") == f"{workspace}/space-logos/a.png"

    def test_unknown_kind_is_refused(self) -> None:
        with pytest.raises(ValueError, match="вид вложения"):
            image_key(uuid.uuid4(), "не-бывает", "a.png")


class TestLocalStorage:
    async def test_round_trip(self, tmp_path: Path) -> None:
        storage = LocalStorage(str(tmp_path))
        payload = "привет".encode()
        await storage.put("w/files/a/b.txt", payload)
        assert await storage.exists("w/files/a/b.txt")
        assert await storage.get("w/files/a/b.txt") == payload

    async def test_delete_is_idempotent(self, tmp_path: Path) -> None:
        """Повторное удаление не отказ.

        Уборка может пройти дважды: такт периодической задачи повторяется
        после перезапуска реплики.
        """
        storage = LocalStorage(str(tmp_path))
        await storage.put("w/a.txt", b"x")
        await storage.delete("w/a.txt")
        await storage.delete("w/a.txt")
        assert not await storage.exists("w/a.txt")

    @pytest.mark.parametrize(
        "key", ["../secret.txt", "w/../../secret.txt", "/etc/passwd", "w/./../../x"]
    )
    async def test_key_outside_the_root_is_refused(self, tmp_path: Path, key: str) -> None:
        """Ключ обязан оставаться внутри корня.

        Ключ собирается приложением, и снаружи прийти не должен. Проверка
        стоит копейки, а её отсутствие превращает любую будущую ошибку сборки
        ключа в чтение произвольного файла.
        """
        storage = LocalStorage(str(tmp_path))
        with pytest.raises(ValueError, match="за пределы"):
            await storage.get(key)

    async def test_prefix_removal_takes_the_whole_subtree(self, tmp_path: Path) -> None:
        storage = LocalStorage(str(tmp_path))
        for name in ("w/files/1/a.txt", "w/files/2/b.txt", "w/avatars/c.png"):
            await storage.put(name, b"x")

        removed = await storage.delete_prefix("w/files")
        assert removed == 2
        assert not await storage.exists("w/files/1/a.txt")
        assert await storage.exists("w/avatars/c.png")

    async def test_missing_prefix_is_not_an_error(self, tmp_path: Path) -> None:
        storage = LocalStorage(str(tmp_path))
        assert await storage.delete_prefix("нет-такого") == 0


class TestDriverChoice:
    def _settings(self, **overrides):  # noqa: ANN202 — минимальная подделка настроек
        from tessera_api.config import Settings

        base = {
            "database_url": "postgresql://t:x@127.0.0.1:5432/t",
            "redis_url": "redis://127.0.0.1:6379",
            "app_secret": "x" * 32,
            "app_url": "http://localhost:3000",
            "port": 3000,
            "host": "0.0.0.0",
            "debug": False,
            "trust_proxy_hops": 1,
        }
        base.update(overrides)
        return Settings(**base)

    def test_local_by_default(self, tmp_path: Path) -> None:
        storage = create_storage(self._settings(storage_local_path=str(tmp_path)))
        assert isinstance(storage, LocalStorage)

    def test_s3_without_bucket_is_refused(self) -> None:
        with pytest.raises(RuntimeError, match="AWS_S3_BUCKET"):
            create_storage(self._settings(storage_driver="s3"))

    def test_unknown_driver_is_refused(self) -> None:
        """Опечатка в имени драйвера обязана ронять старт.

        Молчаливый откат к каталогу на диске означал бы, что вложения пишутся
        не туда, куда рассчитывали, и обнаруживается это потерей файлов при
        следующем развёртывании.
        """
        with pytest.raises(RuntimeError, match="неизвестный STORAGE_DRIVER"):
            create_storage(self._settings(storage_driver="s4"))


class TestSizeLimit:
    @pytest.mark.parametrize(
        ("given", "expected"),
        [
            ("50mb", 50 * 1024**2),
            ("1gb", 1024**3),
            ("512kb", 512 * 1024),
            ("1024", 1024),
            ("1.5mb", int(1.5 * 1024**2)),
        ],
    )
    def test_sizes_are_parsed(self, given: str, expected: int) -> None:
        assert _parse_size(given) == expected

    @pytest.mark.parametrize("given", ["много", "50 гигов", "mb", ""])
    def test_unparseable_size_refuses_startup(self, given: str) -> None:
        """Отказ на старте, а не молчаливое умолчание.

        Предел размера, неожиданно ставший другим, обнаруживается отказами
        загрузки у людей, а не в журнале.
        """
        with pytest.raises(RuntimeError, match="FILE_UPLOAD_SIZE_LIMIT"):
            _parse_size(given)
