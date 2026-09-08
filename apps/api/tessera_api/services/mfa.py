"""Второй фактор входа.

Одноразовые коды по RFC 6238 считаются здесь, стандартной библиотекой: это
HMAC-SHA1 от номера тридцатисекундного окна и усечение до шести цифр. Отдельная
библиотека ради тридцати строк не нужна, а иметь алгоритм под рукой полезно —
все отклонения от значений по умолчанию видны сразу.

Значения по умолчанию менять нельзя. Шесть цифр, тридцать секунд и SHA-1 умеют
все приложения-аутентификаторы; часть из них читает параметры из QR-кода, но
нестандартные молча игнорирует, и человек получает коды, которые не подходят.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import quote

from sqlalchemy import insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import bad_request, forbidden, not_found
from tessera_api.infrastructure.models import User, UserMfa, Workspace
from tessera_api.infrastructure.secrets import decrypt_secret, encrypt_secret
from tessera_api.services.audit import AuditEvent, AuditResource, AuditService

#: Параметры одноразовых кодов. См. оговорку в описании модуля.
TOTP_DIGITS = 6
TOTP_PERIOD = 30
TOTP_ALGORITHM = "SHA1"

#: Допуск в один шаг в обе стороны. Часы на телефоне и на сервере расходятся, и
#: без допуска человек с расхождением в несколько секунд не войдёт никогда.
#: Больше одного шага брать не стоит: каждый шаг это тридцать секунд, которые
#: код остаётся действительным.
TOTP_WINDOW = 1

#: Длина секрета в байтах. Двадцать — то, что кладут в base32 приложения.
SECRET_BYTES = 20

BACKUP_CODE_LENGTH = 8
BACKUP_CODE_COUNT = 10

#: Алфавит резервных кодов без символов, которые путаются при переписывании с
#: бумаги: нуля и буквы O, единицы и букв I и L.
BACKUP_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

#: Ниже этого числа оставшихся кодов стоит предупредить.
LOW_BACKUP_CODES = 3

METHOD_TOTP = "totp"


def generate_totp_secret() -> str:
    """Новый секрет в base32, как его ждут приложения."""
    return base64.b32encode(secrets.token_bytes(SECRET_BYTES)).decode().rstrip("=")


def _counter_code(secret: str, counter: int) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8), casefold=True)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    truncated = struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF
    return str(truncated % (10**TOTP_DIGITS)).zfill(TOTP_DIGITS)


def verify_totp(secret: str, code: str, *, now: float | None = None) -> bool:
    """Проверить одноразовый код.

    Возвращает ложь на любом мусоре, а не бросает: код приходит от человека, и
    нечитаемое значение это обычный неверный ввод, а не поломка.

    Сравнение постоянного времени. Разница во времени ответа на «первая цифра
    не та» и «все цифры те, кроме последней» позволяет подобрать код заметно
    быстрее перебора.
    """
    cleaned = "".join(code.split()) if code else ""
    if len(cleaned) != TOTP_DIGITS or not cleaned.isdigit():
        return False

    moment = time.time() if now is None else now
    counter = int(moment // TOTP_PERIOD)
    matched = False
    for shift in range(-TOTP_WINDOW, TOTP_WINDOW + 1):
        try:
            expected = _counter_code(secret, counter + shift)
        except (ValueError, TypeError):
            return False
        # Цикл не прерывается: ранний выход выдал бы разницей во времени, на
        # каком именно шаге совпало, то есть расхождение часов.
        if hmac.compare_digest(expected, cleaned):
            matched = True
    return matched


def build_totp_uri(secret: str, email: str, issuer: str) -> str:
    """Ссылка otpauth для QR-кода.

    Издатель и метка становятся названием записи в приложении, поэтому в метку
    идёт почта: у человека бывает несколько учётных записей в одном продукте.
    """
    label = quote(f"{issuer}:{email}", safe="")
    return (
        f"otpauth://totp/{label}?secret={secret}&issuer={quote(issuer, safe='')}"
        f"&algorithm={TOTP_ALGORITHM}&digits={TOTP_DIGITS}&period={TOTP_PERIOD}"
    )


def generate_backup_codes() -> list[str]:
    """Набор резервных кодов в открытом виде. Показывается один раз."""
    return [
        "".join(secrets.choice(BACKUP_ALPHABET) for _ in range(BACKUP_CODE_LENGTH))
        for _ in range(BACKUP_CODE_COUNT)
    ]


def normalize_backup_code(code: str) -> str:
    return (code or "").replace(" ", "").replace("-", "").upper()


def hash_backup_code(code: str) -> str:
    """Отпечаток резервного кода для хранения.

    В базе лежат только отпечатки: резервный код это второй фактор, и утечка
    таблицы не должна давать возможность войти. Соли нет намеренно — код
    случаен и достаточно длинен, а детерминированный отпечаток позволяет найти
    совпадение, не перебирая все коды человека.
    """
    return hashlib.sha256(normalize_backup_code(code).encode()).hexdigest()


def find_backup_code(stored: list[str], code: str) -> int:
    """Найти совпавший отпечаток. Возвращает его место или -1.

    Обход полный, без раннего выхода: он выдал бы место совпадения разницей во
    времени ответа.
    """
    candidate = hash_backup_code(code)
    found = -1
    for index, one in enumerate(stored or []):
        if hmac.compare_digest(one or "", candidate) and found == -1:
            found = index
    return found


@dataclass(frozen=True, slots=True)
class MfaStatus:
    enabled: bool
    method: str
    backup_codes_left: int
    backup_codes_low: bool
    enforced: bool


class MfaService:
    def __init__(self, session: AsyncSession, app_secret: str) -> None:
        self._session = session
        self._app_secret = app_secret

    async def _record(self, user_id: uuid.UUID) -> UserMfa | None:
        return (
            await self._session.execute(select(UserMfa).where(UserMfa.user_id == user_id))
        ).scalar_one_or_none()

    async def status(self, user: User, workspace: Workspace) -> MfaStatus:
        record = await self._record(user.id)
        enabled = bool(record and record.is_enabled)
        left = len(record.backup_codes or []) if enabled and record else 0
        return MfaStatus(
            enabled=enabled,
            method=record.method if record else METHOD_TOTP,
            backup_codes_left=left,
            backup_codes_low=enabled and left <= LOW_BACKUP_CODES,
            enforced=bool(workspace.enforce_mfa),
        )

    async def setup(self, user: User, issuer: str) -> dict:
        """Завести секрет и отдать ссылку для QR-кода.

        Секрет пишется сразу, но пока не включённым: без записи проверить код
        на следующем запросе будет нечем, а включать до проверки нельзя —
        человек рискует запереть себя, не сохранив секрет в приложении.
        """
        record = await self._record(user.id)
        if record is not None and record.is_enabled:
            raise bad_request("error.mfa.already_enabled")

        secret = generate_totp_secret()
        sealed = encrypt_secret(secret, self._app_secret)

        if record is None:
            await self._session.execute(
                insert(UserMfa).values(
                    id=uuid.uuid4(),
                    user_id=user.id,
                    workspace_id=user.workspace_id,
                    method=METHOD_TOTP,
                    secret=sealed,
                    is_enabled=False,
                )
            )
        else:
            await self._session.execute(
                update(UserMfa)
                .where(UserMfa.id == record.id)
                .values(secret=sealed, method=METHOD_TOTP, is_enabled=False)
            )
        await self._session.commit()

        return {"secret": secret, "uri": build_totp_uri(secret, user.email, issuer)}

    async def enable(self, user: User, code: str) -> dict:
        """Включить второй фактор, проверив код.

        Резервные коды выдаются здесь же и показываются один раз: без них
        потерянный телефон означает потерянную учётную запись.
        """
        record = await self._record(user.id)
        if record is None or not record.secret:
            raise bad_request("error.mfa.not_set_up")
        if record.is_enabled:
            raise bad_request("error.mfa.already_enabled")

        secret = decrypt_secret(record.secret, self._app_secret)
        if secret is None or not verify_totp(secret, code):
            raise bad_request("error.mfa.invalid_code")

        codes = generate_backup_codes()
        await self._session.execute(
            update(UserMfa)
            .where(UserMfa.id == record.id)
            .values(is_enabled=True, backup_codes=[hash_backup_code(one) for one in codes])
        )
        await AuditService(self._session).log(
            event=AuditEvent.MFA_ENABLED,
            resource_type=AuditResource.MFA,
            resource_id=user.id,
            user_id=user.id,
            workspace_id=user.workspace_id,
        )
        await self._session.commit()
        return {"backupCodes": codes}

    async def disable(self, user: User, workspace: Workspace, code: str) -> None:
        """Выключить второй фактор.

        Код требуется и здесь: без него угнанная сессия снимала бы защиту, ради
        которой её и включали.

        При включённом требовании рабочего пространства выключить нельзя вовсе:
        иначе требование обходится каждым, кому оно неудобно.
        """
        if workspace.enforce_mfa:
            raise forbidden("error.mfa.enforced_by_workspace")

        record = await self._record(user.id)
        if record is None or not record.is_enabled:
            raise bad_request("error.mfa.not_enabled")

        if not await self.verify(user, code):
            raise bad_request("error.mfa.invalid_code")

        await self._session.execute(
            update(UserMfa)
            .where(UserMfa.id == record.id)
            .values(is_enabled=False, secret=None, backup_codes=None)
        )
        await AuditService(self._session).log(
            event=AuditEvent.MFA_DISABLED,
            resource_type=AuditResource.MFA,
            resource_id=user.id,
            user_id=user.id,
            workspace_id=workspace.id,
        )
        await self._session.commit()

    async def reset(self, actor: User, target_user_id: uuid.UUID, workspace: Workspace) -> None:
        """Снять второй фактор администратором.

        Нужно ровно для одного случая: человек потерял и телефон, и резервные
        коды. Кода здесь не спрашивают — его неоткуда взять, — поэтому право
        отдано администратору рабочего пространства, а событие обязано попадать
        в журнал.
        """
        from tessera_api.domain.roles import is_workspace_admin

        if not is_workspace_admin(actor.role):
            raise forbidden("error.common.admin_required")

        target = await self._session.get(User, target_user_id)
        if target is None or target.workspace_id != workspace.id:
            raise not_found("error.user.not_found")

        record = await self._record(target_user_id)
        if record is None:
            return
        await self._session.execute(
            update(UserMfa)
            .where(UserMfa.id == record.id)
            .values(is_enabled=False, secret=None, backup_codes=None)
        )
        await AuditService(self._session).log(
            event=AuditEvent.MFA_RESET,
            resource_type=AuditResource.MFA,
            resource_id=target_user_id,
            user_id=actor.id,
            workspace_id=workspace.id,
        )
        await self._session.commit()

    async def regenerate_backup_codes(self, user: User, code: str) -> dict:
        """Выдать новый набор резервных кодов взамен прежнего.

        Прежние перестают работать все разом: набор заменяется целиком, иначе
        выданный когда-то и потерянный код остался бы годным.
        """
        record = await self._record(user.id)
        if record is None or not record.is_enabled:
            raise bad_request("error.mfa.not_enabled")
        if not await self.verify(user, code):
            raise bad_request("error.mfa.invalid_code")

        codes = generate_backup_codes()
        await self._session.execute(
            update(UserMfa)
            .where(UserMfa.id == record.id)
            .values(backup_codes=[hash_backup_code(one) for one in codes])
        )
        await self._session.commit()
        return {"backupCodes": codes}

    async def verify(self, user: User, code: str) -> bool:
        """Проверить код: одноразовый либо резервный.

        Совпавший резервный код тут же вычёркивается. Одноразовость и есть
        весь его смысл: оставленный в списке, он превращается во второй
        пароль, записанный на бумаге.
        """
        record = await self._record(user.id)
        if record is None or not record.is_enabled or not record.secret:
            return False

        secret = decrypt_secret(record.secret, self._app_secret)
        if secret is not None and verify_totp(secret, code):
            return True

        stored = list(record.backup_codes or [])
        position = find_backup_code(stored, code)
        if position == -1:
            return False

        del stored[position]
        await self._session.execute(
            update(UserMfa)
            .where(UserMfa.id == record.id)
            .values(backup_codes=stored, updated_at=datetime.now(UTC))
        )
        await self._session.commit()
        return True

    async def is_enrolled(self, user: User) -> bool:
        """Заведён ли у человека второй фактор.

        Отдельно от `is_required`: включённый лично фактор и требование
        пространства ведут к разным шагам входа — ввод кода против настройки.
        """
        record = await self._record(user.id)
        return bool(record is not None and record.is_enabled)

