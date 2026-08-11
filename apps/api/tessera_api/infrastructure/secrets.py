"""Хранение секретов, которые приложению надо уметь прочитать обратно.

Пароли так не хранят: их сверяют по необратимому отпечатку. Здесь другое —
секрет TOTP и ключи внешних провайдеров нужны в открытом виде на каждой
проверке, поэтому они шифруются, а не хешируются.

Формат совпадает с v1 (`ee/ai/ai-secret.util.ts`) до байта: `v1:iv:tag:данные`,
все три части в base64, шифр AES-256-GCM, ключ — SHA-256 от `APP_SECRET`. Совпа
дение обязательно: на время перехода обе версии читают одну базу, и секрет,
записанный одной, должен читаться другой.
"""

from __future__ import annotations

import base64
import hashlib
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

#: Версия формата. Отдельным полем, чтобы формат можно было сменить, не гадая
#: о раскладке старых записей.
PREFIX = "v1"

#: Длина вектора инициализации. Двенадцать байт — то, что рекомендовано для
#: GCM и что использует v1.
IV_LENGTH = 12


def _key(app_secret: str) -> bytes:
    if not app_secret:
        raise RuntimeError("APP_SECRET обязателен для хранения секретов")
    return hashlib.sha256(app_secret.encode()).digest()


def encrypt_secret(plain: str, app_secret: str) -> str:
    iv = os.urandom(IV_LENGTH)
    sealed = AESGCM(_key(app_secret)).encrypt(iv, plain.encode(), None)
    # `cryptography` отдаёт данные и метку подлинности одной строкой, а v1
    # хранит их порознь. Метка последние шестнадцать байт.
    data, tag = sealed[:-16], sealed[-16:]
    return ":".join(
        (
            PREFIX,
            base64.b64encode(iv).decode(),
            base64.b64encode(tag).decode(),
            base64.b64encode(data).decode(),
        )
    )


def decrypt_secret(payload: str | None, app_secret: str) -> str | None:
    """Расшифровать. Возвращает `None` на любом непригодном значении.

    Не исключение: `APP_SECRET` могли сменить, и тогда прочитать старые записи
    нечем. Падать на каждом запросе из-за этого нельзя — вызывающий должен
    иметь возможность обойтись без секрета, а не отказать целиком.
    """
    if not payload:
        return None

    parts = payload.split(":")
    if len(parts) != 4 or parts[0] != PREFIX:
        return None

    try:
        _, iv_raw, tag_raw, data_raw = parts
        iv = base64.b64decode(iv_raw)
        sealed = base64.b64decode(data_raw) + base64.b64decode(tag_raw)
        return AESGCM(_key(app_secret)).decrypt(iv, sealed, None).decode()
    except (ValueError, InvalidTag, UnicodeDecodeError):
        return None
