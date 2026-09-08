"""Вход и сессии."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import bcrypt
from sqlalchemy import insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import bad_request, not_found, unauthorized
from tessera_api.infrastructure.models import User, UserSession
from tessera_api.infrastructure.repositories import UserRepo, WorkspaceRepo
from tessera_api.services.audit import AuditEvent, AuditResource, AuditService
from tessera_api.services.mfa import MfaService
from tessera_api.services.realtime import RealtimeService
from tessera_api.services.tokens import DEFAULT_EXPIRES, TokenService


def _verify_password(plain: str, hashed: str | None) -> bool:
    """Сверить пароль.

    Отсутствие пароля у записи это обычное состояние: так заведён тот, кто
    входит через провайдера. Сверка обязана выполнить работу и в этом случае,
    иначе время ответа отличается и по нему различимы заведённые и незаведённые
    адреса.
    """
    candidate = hashed or "$2b$12$" + "." * 53
    try:
        return bcrypt.checkpw(plain.encode(), candidate.encode())
    except ValueError:
        return False


@dataclass(frozen=True, slots=True)
class LoginOutcome:
    """Чем кончилась сверка пароля.

    Либо вход завершён и есть токен доступа, либо нужен второй фактор и есть
    промежуточный токен. Одновременно не бывает: пароль сам по себе не должен
    открывать вход там, где заведён второй фактор.
    """

    user: User
    access_token: str | None = None
    mfa_token: str | None = None
    #: Второй фактор у человека уже заведён — нужен код.
    has_mfa: bool = False
    #: Второго фактора нет, но рабочее пространство его требует — нужна
    #: настройка до выдачи сессии.
    needs_setup: bool = False


class AuthService:
    def __init__(
        self,
        session: AsyncSession,
        users: UserRepo,
        workspaces: WorkspaceRepo,
        tokens: TokenService,
        realtime: RealtimeService | None = None,
        app_secret: str = "",
    ) -> None:
        self._session = session
        self._users = users
        self._workspaces = workspaces
        self._tokens = tokens
        # Нужен второму фактору: секрет приложения расшифровывает секрет TOTP.
        # Пустое значение означает сборку без второго фактора — так собирают
        # службу там, где входа паролем нет вовсе.
        self._app_secret = app_secret
        self._audit = AuditService(session)
        # `None` означает «канал не трогать». Так собирают службу проверки;
        # контроллеры передают настоящий, иначе выход не закрывает соединение.
        self._realtime = realtime

    async def _close_channel(self, session_ids: list[uuid.UUID]) -> None:
        """Разорвать соединения отозванных сессий.

        Отметка сессии отозванной не разрывает уже открытый сокет: он прошёл
        проверку при подключении и живёт дальше сам по себе. Без этого вызова
        вышедший на чужой машине продолжает получать события — то есть выход
        не выходит ровно в том смысле, ради которого его нажимают.
        """
        if self._realtime is not None and session_ids:
            await self._realtime.drop_sessions(session_ids)

    async def login(
        self,
        email: str,
        password: str,
        workspace_id: uuid.UUID,
        *,
        user_agent: str | None = None,
        ip: str | None = None,
    ) -> LoginOutcome:
        # Принуждение к входу через провайдера проверяется до сверки пароля.
        # После неё отказ различал бы верный пароль и неверный там, где пароль
        # вообще не должен приниматься.
        workspace = await self._workspaces.by_id(workspace_id)
        if workspace is None:
            # Отказ, а не продолжение. Дальше по этому значению решается, нужен
            # ли второй фактор, и «пространства нет» не должно означать «фактор
            # не спрашиваем».
            raise not_found("error.common.workspace_not_found")
        if workspace.enforce_sso:
            raise bad_request("error.auth.this_workspace_has_enforced_sso_login")

        user = await self._users.by_email(email, workspace_id)

        # Один и тот же отказ на несуществующий адрес и на неверный пароль.
        # Разные ответы позволяют перебрать, кто здесь заведён.
        if user is None or not _verify_password(password, user.password):
            raise unauthorized("error.auth.invalid_credentials")

        if user.deactivated_at is not None:
            raise unauthorized("error.auth.account_deactivated")

        await self._session.execute(
            update(User).where(User.id == user.id).values(last_login_at=datetime.now(UTC))
        )

        # Второй фактор проверяется до выдачи сессии. Пропуск этого шага
        # означает вход по одному паролю у того, кто фактор включил, — то
        # есть отмену второго фактора без ведома человека.
        enrolled = await MfaService(self._session, self._app_secret).is_enrolled(user)
        if enrolled or workspace.enforce_mfa:
            return LoginOutcome(
                user=user,
                mfa_token=self._tokens.issue_mfa(user.id, workspace_id),
                has_mfa=enrolled,
                needs_setup=not enrolled,
            )

        token = await self.open_session_for(
            user, workspace_id, user_agent=user_agent, ip=ip
        )
        return LoginOutcome(user=user, access_token=token)

    async def open_session_for(
        self,
        user: User,
        workspace_id: uuid.UUID,
        *,
        user_agent: str | None = None,
        ip: str | None = None,
    ) -> str:
        """Выдать сессию тому, чью личность подтвердил кто-то другой.

        Для входа через провайдера: пароля здесь нет и сверять нечего, личность
        подтверждена OIDC, SAML или каталогом. Всё остальное — сессия, журнал,
        токен — обязано совпадать с парольным входом, иначе выход, отзыв и
        аудит работают для одних вошедших и не работают для других.

        Отметка последнего входа сюда не входит: её ставит сопоставление с
        учётной записью, и второй раз она не нужна.

        Автор события журнала передаётся явно. Маршрут открытый, и обычный
        источник автора — разобранный токен запроса — на этом шаге ещё пуст:
        событие ушло бы без автора.
        """
        session_id = await self._open_session(user, workspace_id, user_agent)
        await self._audit.log(
            event=AuditEvent.USER_LOGGED_IN,
            resource_type=AuditResource.USER,
            resource_id=user.id,
            user_id=user.id,
            workspace_id=workspace_id,
            ip=ip,
        )
        await self._session.commit()
        return self._tokens.issue_access(user.id, workspace_id, session_id)

    async def _open_session(
        self,
        user: User,
        workspace_id: uuid.UUID,
        user_agent: str | None,
    ) -> uuid.UUID:
        """Завести сессию.

        Сессия записывается в базу, а не выводится из токена: без неё выход не
        отзывает ничего, и человек, вышедший на чужой машине, остаётся
        вошедшим. В v1 это разделение уже есть.
        """
        session_id = uuid.uuid4()
        await self._session.execute(
            insert(UserSession).values(
                id=session_id,
                user_id=user.id,
                workspace_id=workspace_id,
                user_agent=user_agent,
                expires_at=datetime.now(UTC) + DEFAULT_EXPIRES,
            )
        )
        return session_id

    async def change_password(
        self,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        old_password: str,
        new_password: str,
        current_session_id: uuid.UUID | None,
    ) -> None:
        """Сменить пароль.

        Все прочие сессии отзываются: пароль меняют в том числе тогда, когда
        подозревают, что им завладели, и оставить чужую сессию живой значит
        не сделать ровно того, ради чего пароль меняли.
        """
        user = await self._users.by_id(user_id, workspace_id)
        if user is None:
            raise not_found("error.common.user_not_found")

        if not _verify_password(old_password, user.password):
            raise bad_request("error.auth.current_password_is_incorrect")

        await self._session.execute(
            update(User).where(User.id == user_id).values(password=hash_password(new_password))
        )

        revoke = (
            update(UserSession)
            .where(UserSession.user_id == user_id)
            .where(UserSession.workspace_id == workspace_id)
            .where(UserSession.revoked_at.is_(None))
        )
        if current_session_id is not None:
            # Своя сессия остаётся: иначе человек, сменивший пароль, тут же
            # выбрасывается и решает, что смена не прошла.
            revoke = revoke.where(UserSession.id != current_session_id)
        # Идентификаторы возвращаются запросом отзыва, а не выбираются до него:
        # между выборкой и правкой успела бы появиться новая сессия, и она
        # осталась бы отозванной в базе, но живой на канале.
        revoked = list(
            (
                await self._session.execute(
                    revoke.values(revoked_at=datetime.now(UTC)).returning(UserSession.id)
                )
            )
            .scalars()
            .all()
        )

        await self._audit.log(
            event=AuditEvent.USER_PASSWORD_CHANGED,
            resource_type=AuditResource.USER,
            resource_id=user_id,
            user_id=user_id,
            workspace_id=workspace_id,
        )
        await self._session.commit()
        await self._close_channel(revoked)

    async def logout(self, session_id: uuid.UUID) -> None:
        """Отозвать сессию.

        Отзыв на стороне сервера обязателен: локальная очистка на клиенте
        оставляет сессию живой, и человек считает себя вышедшим, не будучи им.
        Этот случай в v1 был настоящим.
        """
        await self._session.execute(
            update(UserSession)
            .where(UserSession.id == session_id)
            .where(UserSession.revoked_at.is_(None))
            .values(revoked_at=datetime.now(UTC))
        )
        await self._session.commit()
        await self._close_channel([session_id])

    async def sessions(self, user_id: uuid.UUID, current_id: uuid.UUID | None) -> list[dict]:
        """Живые сеансы человека.

        Показываются только свои и только живые: отозванные и просроченные не
        дают человеку ничего, кроме длинного списка, в котором не найти нужное.
        Текущий помечается — по нему видно, какой сеанс не надо закрывать.
        """
        rows = (
            await self._session.execute(
                select(UserSession)
                .where(UserSession.user_id == user_id)
                .where(UserSession.revoked_at.is_(None))
                .where(UserSession.expires_at > datetime.now(UTC))
                .order_by(UserSession.last_active_at.desc())
            )
        ).scalars().all()
        return [
            {
                "id": one.id,
                "deviceName": one.device_name,
                "userAgent": one.user_agent,
                "lastActiveAt": one.last_active_at,
                "createdAt": one.created_at,
                "expiresAt": one.expires_at,
                "isCurrent": one.id == current_id,
            }
            for one in rows
        ]

    async def revoke_session(
        self, session_id: uuid.UUID, user_id: uuid.UUID, current_id: uuid.UUID | None
    ) -> None:
        """Отозвать свой сеанс.

        Только свой: чужие сеансы закрывает отключение человека, а не это
        действие. Текущий отзывать нельзя — для выхода есть выход, и отзыв
        собственного сеанса здесь читался бы как выход по ошибке.
        """
        if current_id is not None and session_id == current_id:
            raise bad_request("error.auth.cannot_revoke_current_session")

        found = await self._session.get(UserSession, session_id)
        if found is None or found.user_id != user_id or found.revoked_at is not None:
            raise not_found("error.auth.session_not_found")

        await self._session.execute(
            update(UserSession)
            .where(UserSession.id == session_id)
            .values(revoked_at=datetime.now(UTC))
        )
        await self._session.commit()
        await self._close_channel([session_id])

    async def revoke_other_sessions(
        self, user_id: uuid.UUID, current_id: uuid.UUID | None
    ) -> int:
        """Закрыть все сеансы, кроме текущего.

        Текущий сохраняется намеренно: человек нажимает это, чтобы выгнать
        чужого, а не чтобы выйти самому.
        """
        stmt = (
            select(UserSession.id)
            .where(UserSession.user_id == user_id)
            .where(UserSession.revoked_at.is_(None))
        )
        if current_id is not None:
            stmt = stmt.where(UserSession.id != current_id)
        ids = list((await self._session.execute(stmt)).scalars())
        if not ids:
            return 0

        await self._session.execute(
            update(UserSession)
            .where(UserSession.id.in_(ids))
            .values(revoked_at=datetime.now(UTC))
        )
        await self._session.commit()
        await self._close_channel(ids)
        return len(ids)

    async def session_is_live(self, session_id: uuid.UUID) -> bool:
        """Действует ли сессия прямо сейчас.

        Проверяется при каждом запросе: иначе отозванная сессия продолжает
        работать до истечения срока токена, то есть выход не выходит.
        """
        found = await self._session.get(UserSession, session_id)
        if found is None or found.revoked_at is not None:
            return False
        return found.expires_at > datetime.now(UTC)


def hash_password(plain: str) -> str:
    """Хеш пароля тем же способом, что в v1: иначе прежние пароли не подойдут."""
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt(rounds=12)).decode()


__all__ = ["AuthService", "hash_password", "timedelta"]
