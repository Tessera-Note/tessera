"""Второй фактор входа.

Алгоритм сверяется с контрольными значениями RFC 6238, а не с собственным
представлением о нём: неверный TOTP означает, что не войдёт никто, и заметить
это по зелёным проверкам собственной реализации невозможно.
"""

from __future__ import annotations

import base64
import uuid

import pytest
from sqlalchemy import insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import AppError
from tessera_api.domain.roles import UserRole
from tessera_api.infrastructure.models import AuditLog, User, UserMfa, Workspace
from tessera_api.infrastructure.secrets import decrypt_secret, encrypt_secret
from tessera_api.services.mfa import (
    BACKUP_CODE_COUNT,
    TOTP_PERIOD,
    MfaService,
    _counter_code,
    build_totp_uri,
    find_backup_code,
    generate_backup_codes,
    generate_totp_secret,
    hash_backup_code,
    normalize_backup_code,
    verify_totp,
)
from tests.conftest import needs_database

APP_SECRET = "x" * 40

#: Секрет из приложения B RFC 6238: ASCII «12345678901234567890».
RFC_SECRET = base64.b32encode(b"12345678901234567890").decode().rstrip("=")

#: Контрольные значения RFC для SHA-1. В документе они восьмизначные, здесь
#: берутся последние шесть цифр — столько же, сколько показывает приложение.
RFC_VECTORS = [
    (59, "287082"),
    (1111111109, "081804"),
    (1111111111, "050471"),
    (1234567890, "005924"),
    (2000000000, "279037"),
    (20000000000, "353130"),
]


class TestTotpAgainstRfc:
    @pytest.mark.parametrize(("moment", "expected"), RFC_VECTORS)
    def test_code_matches_the_standard(self, moment: int, expected: str) -> None:
        """Своя реализация обязана совпадать с эталоном.

        Проверка собственного кода собственным же ожиданием подтвердила бы
        только внутреннюю согласованность. Ошибка в усечении или в порядке
        байтов даёт устойчиво неверные коды, и все приложения-аутентификаторы
        перестают подходить разом.
        """
        assert _counter_code(RFC_SECRET, moment // TOTP_PERIOD) == expected

    def test_window_accepts_one_step_in_each_direction(self) -> None:
        """Часы на телефоне и на сервере расходятся.

        Без допуска человек с расхождением в несколько секунд не войдёт
        никогда.
        """
        now = 1111111111
        step = now // TOTP_PERIOD
        for shift in (-1, 0, 1):
            assert verify_totp(RFC_SECRET, _counter_code(RFC_SECRET, step + shift), now=now)

    def test_window_stops_at_one_step(self) -> None:
        """Допуск шире одного шага удлиняет жизнь подсмотренного кода."""
        now = 1111111111
        step = now // TOTP_PERIOD
        for shift in (-2, 2, 10):
            assert not verify_totp(RFC_SECRET, _counter_code(RFC_SECRET, step + shift), now=now)

    @pytest.mark.parametrize(
        "code", ["", "12345", "1234567", "abcdef", "12 34 56", None, "12345a"]
    )
    def test_garbage_is_refused_without_raising(self, code) -> None:  # noqa: ANN001
        """Код приходит от человека: нечитаемое значение это неверный ввод.

        Исключение здесь превращало бы опечатку в пятисотый ответ.
        """
        assert verify_totp(RFC_SECRET, code) is False

    def test_spaces_are_ignored(self) -> None:
        """Из приложения код часто копируют с пробелом посередине."""
        now = 1111111111
        code = _counter_code(RFC_SECRET, now // TOTP_PERIOD)
        assert verify_totp(RFC_SECRET, f"{code[:3]} {code[3:]}", now=now)

    def test_generated_secret_is_usable(self) -> None:
        secret = generate_totp_secret()
        code = _counter_code(secret, int(1700000000 // TOTP_PERIOD))
        assert verify_totp(secret, code, now=1700000000)

    def test_uri_carries_the_parameters_apps_read(self) -> None:
        """Приложение читает параметры из ссылки.

        Пропущенные значения часть приложений подставляет по умолчанию, а
        часть — нет, и коды перестают подходить у половины людей.
        """
        uri = build_totp_uri("ABCD", "человек@example.com", "Tessera")
        assert uri.startswith("otpauth://totp/")
        for part in ("secret=ABCD", "algorithm=SHA1", "digits=6", "period=30", "issuer=Tessera"):
            assert part in uri


class TestBackupCodes:
    def test_set_is_generated_whole(self) -> None:
        codes = generate_backup_codes()
        assert len(codes) == BACKUP_CODE_COUNT
        assert len(set(codes)) == BACKUP_CODE_COUNT

    def test_alphabet_avoids_confusable_characters(self) -> None:
        """Коды переписывают с бумаги.

        Ноль и O, единица и I с L неразличимы в половине шрифтов, и человек
        вводит не то, что записал.
        """
        for code in generate_backup_codes():
            assert not set(code) & set("O0I1L")

    @pytest.mark.parametrize(
        ("given", "expected"), [("ab-cd ef", "ABCDEF"), (" abc ", "ABC"), ("", "")]
    )
    def test_normalisation(self, given: str, expected: str) -> None:
        assert normalize_backup_code(given) == expected

    def test_lookup_finds_the_match_regardless_of_formatting(self) -> None:
        codes = generate_backup_codes()
        stored = [hash_backup_code(one) for one in codes]
        assert find_backup_code(stored, codes[3].lower()) == 3
        assert find_backup_code(stored, f"{codes[3][:4]}-{codes[3][4:]}") == 3

    def test_unknown_code_is_not_found(self) -> None:
        stored = [hash_backup_code(one) for one in generate_backup_codes()]
        assert find_backup_code(stored, "НЕТТАКОГО") == -1

    def test_empty_store_is_not_found(self) -> None:
        assert find_backup_code([], "ЛЮБОЙ") == -1


class TestSecretStorage:
    def test_round_trip(self) -> None:
        sealed = encrypt_secret("секрет", APP_SECRET)
        assert decrypt_secret(sealed, APP_SECRET) == "секрет"

    def test_another_key_reads_nothing(self) -> None:
        sealed = encrypt_secret("секрет", APP_SECRET)
        assert decrypt_secret(sealed, "z" * 40) is None

    def test_tampered_payload_is_refused(self) -> None:
        """Метка подлинности обязана срабатывать.

        Без неё изменённые данные расшифровались бы в мусор, и приложение
        приняло бы его за секрет.
        """
        sealed = encrypt_secret("секрет", APP_SECRET)
        prefix, iv, tag, data = sealed.split(":")
        broken = ":".join((prefix, iv, tag, data[:-4] + "AAAA"))
        assert decrypt_secret(broken, APP_SECRET) is None

    @pytest.mark.parametrize("payload", [None, "", "мусор", "v2:a:b:c", "v1:a:b"])
    def test_unusable_payload_returns_nothing(self, payload) -> None:  # noqa: ANN001
        assert decrypt_secret(payload, APP_SECRET) is None

    def test_two_encryptions_differ(self) -> None:
        """Одинаковый секрет обязан шифроваться по-разному.

        Совпадающие записи выдали бы, что у двух людей один и тот же секрет.
        """
        assert encrypt_secret("одно и то же", APP_SECRET) != encrypt_secret(
            "одно и то же", APP_SECRET
        )


@needs_database
class TestLifecycle:
    async def _person(
        self, session: AsyncSession, workspace, *, role: str = UserRole.MEMBER
    ) -> User:
        person_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=person_id,
                email=f"mfa-{uuid.uuid4().hex[:8]}@example.com",
                name="Человек",
                role=role,
                workspace_id=workspace.id,
            )
        )
        await session.flush()
        return await session.get(User, person_id)

    async def _current_code(self, session: AsyncSession, user: User) -> str:
        record = (
            await session.execute(select(UserMfa).where(UserMfa.user_id == user.id))
        ).scalar_one()
        secret = decrypt_secret(record.secret, APP_SECRET)
        import time

        return _counter_code(secret, int(time.time() // TOTP_PERIOD))

    async def test_setup_stores_the_secret_encrypted(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """В базе лежит шифротекст, а не сам секрет.

        Секрет в открытом виде означает, что утечка таблицы это утечка второго
        фактора у всех сразу.
        """
        person = await self._person(session, workspace)
        result = await MfaService(session, APP_SECRET).setup(person, "Tessera")

        stored = (
            await session.execute(select(UserMfa).where(UserMfa.user_id == person.id))
        ).scalar_one()
        assert stored.secret != result["secret"]
        assert stored.secret.startswith("v1:")
        assert decrypt_secret(stored.secret, APP_SECRET) == result["secret"]

    async def test_setup_does_not_enable_yet(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Включать до проверки кода нельзя.

        Человек мог не сохранить секрет в приложении, и включённый фактор
        запер бы его снаружи.
        """
        person = await self._person(session, workspace)
        await MfaService(session, APP_SECRET).setup(person, "Tessera")

        status = await MfaService(session, APP_SECRET).status(person, workspace)
        assert status.enabled is False

    async def test_enable_requires_a_valid_code(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        person = await self._person(session, workspace)
        service = MfaService(session, APP_SECRET)
        await service.setup(person, "Tessera")

        with pytest.raises(AppError):
            await service.enable(person, "000000")

    async def test_enable_returns_backup_codes_once(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        person = await self._person(session, workspace)
        service = MfaService(session, APP_SECRET)
        await service.setup(person, "Tessera")
        result = await service.enable(person, await self._current_code(session, person))

        assert len(result["backupCodes"]) == BACKUP_CODE_COUNT
        stored = (
            await session.execute(select(UserMfa).where(UserMfa.user_id == person.id))
        ).scalar_one()
        # В базе только отпечатки: сами коды не хранятся нигде.
        assert set(stored.backup_codes) & set(result["backupCodes"]) == set()

    async def test_backup_code_works_once(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Одноразовость и есть весь смысл резервного кода.

        Оставленный в списке, он превращается во второй пароль, записанный на
        бумаге.
        """
        person = await self._person(session, workspace)
        service = MfaService(session, APP_SECRET)
        await service.setup(person, "Tessera")
        codes = (await service.enable(person, await self._current_code(session, person)))[
            "backupCodes"
        ]

        assert await service.verify(person, codes[0]) is True
        assert await service.verify(person, codes[0]) is False
        assert await service.verify(person, codes[1]) is True

    async def test_setup_twice_is_refused_when_enabled(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Повторная настройка при включённом факторе сбросила бы секрет.

        Человек с работающим приложением потерял бы доступ, ничего для этого
        не сделав.
        """
        person = await self._person(session, workspace)
        service = MfaService(session, APP_SECRET)
        await service.setup(person, "Tessera")
        await service.enable(person, await self._current_code(session, person))

        with pytest.raises(AppError):
            await service.setup(person, "Tessera")

    async def test_disable_requires_a_code(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Без кода угнанная сессия снимала бы защиту, ради которой её включали."""
        person = await self._person(session, workspace)
        service = MfaService(session, APP_SECRET)
        await service.setup(person, "Tessera")
        await service.enable(person, await self._current_code(session, person))

        with pytest.raises(AppError):
            await service.disable(person, workspace, "000000")

    async def test_disable_is_blocked_when_the_workspace_enforces_it(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Иначе требование обходит каждый, кому оно неудобно."""
        person = await self._person(session, workspace)
        service = MfaService(session, APP_SECRET)
        await service.setup(person, "Tessera")
        await service.enable(person, await self._current_code(session, person))

        await session.execute(
            update(Workspace).where(Workspace.id == workspace.id).values(enforce_mfa=True)
        )
        await session.flush()
        strict = await session.get(Workspace, workspace.id)

        with pytest.raises(AppError):
            await service.disable(person, strict, await self._current_code(session, person))

    async def test_regenerating_invalidates_the_previous_set(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        person = await self._person(session, workspace)
        service = MfaService(session, APP_SECRET)
        await service.setup(person, "Tessera")
        old = (await service.enable(person, await self._current_code(session, person)))[
            "backupCodes"
        ]
        fresh = (
            await service.regenerate_backup_codes(
                person, await self._current_code(session, person)
            )
        )["backupCodes"]

        assert set(old) & set(fresh) == set()
        assert await service.verify(person, old[0]) is False
        assert await service.verify(person, fresh[0]) is True

    async def test_reset_needs_an_administrator(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Сброс не спрашивает кода: его неоткуда взять.

        Поэтому право отдано администратору, а не любому вошедшему.
        """
        person = await self._person(session, workspace)
        stranger = await self._person(session, workspace)
        service = MfaService(session, APP_SECRET)
        await service.setup(person, "Tessera")
        await service.enable(person, await self._current_code(session, person))

        with pytest.raises(AppError):
            await service.reset(stranger, person.id, workspace)

        await service.reset(owner, person.id, workspace)
        assert (await service.status(person, workspace)).enabled is False

    async def test_reset_does_not_cross_workspaces(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        other = uuid.uuid4()
        await session.execute(insert(Workspace).values(id=other, name="Чужое"))
        stranger_id = uuid.uuid4()
        await session.execute(
            insert(User).values(
                id=stranger_id,
                email=f"o-{uuid.uuid4().hex[:8]}@example.com",
                name="Чужой",
                role=UserRole.MEMBER,
                workspace_id=other,
            )
        )
        await session.flush()

        with pytest.raises(AppError):
            await MfaService(session, APP_SECRET).reset(owner, stranger_id, workspace)

    async def test_enrolment_is_seen_by_login(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """На этом признаке вход решает, спрашивать ли код.

        Требование рабочего пространства проверяется входом отдельно, см.
        `tests/test_login_mfa.py`.
        """
        person = await self._person(session, workspace)
        service = MfaService(session, APP_SECRET)
        assert await service.is_enrolled(person) is False

        await service.setup(person, "Tessera")
        assert await service.is_enrolled(person) is False, "секрет заведён, но не подтверждён"

        await service.enable(person, await self._current_code(session, person))
        assert await service.is_enrolled(person) is True

    async def test_enabling_leaves_a_trace(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Второй фактор это способ входа: его появление и снятие видны в журнале."""
        person = await self._person(session, workspace)
        service = MfaService(session, APP_SECRET)
        await service.setup(person, "Tessera")
        await service.enable(person, await self._current_code(session, person))

        events = await self._events(session, workspace)
        assert "mfa.enabled" in events

    async def test_disabling_leaves_a_trace(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        person = await self._person(session, workspace)
        service = MfaService(session, APP_SECRET)
        await service.setup(person, "Tessera")
        await service.enable(person, await self._current_code(session, person))

        await service.disable(person, workspace, await self._current_code(session, person))

        assert "mfa.disabled" in await self._events(session, workspace)

    async def test_a_reset_by_an_admin_leaves_a_trace(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        """Самый важный след: снятие чужого фактора без кода."""
        person = await self._person(session, workspace)
        service = MfaService(session, APP_SECRET)
        await service.setup(person, "Tessera")
        await service.enable(person, await self._current_code(session, person))

        await service.reset(owner, person.id, workspace)

        assert "mfa.reset" in await self._events(session, workspace)

    async def _events(self, session: AsyncSession, workspace) -> set[str]:
        rows = (
            await session.execute(
                select(AuditLog.event).where(AuditLog.workspace_id == workspace.id)
            )
        ).scalars().all()
        return set(rows)

    async def test_verify_is_false_when_not_enabled(
        self, session: AsyncSession, workspace, owner
    ) -> None:
        person = await self._person(session, workspace)
        service = MfaService(session, APP_SECRET)
        await service.setup(person, "Tessera")

        # Секрет заведён, фактор не включён: код принимать нельзя.
        assert await service.verify(person, await self._current_code(session, person)) is False
