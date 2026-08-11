"""Вход и сессии."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import bcrypt
from sqlalchemy import insert, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import bad_request, not_found, unauthorized
from tessera_api.infrastructure.models import User, UserSession
from tessera_api.infrastructure.repositories import UserRepo, WorkspaceRepo
from tessera_api.services.audit import AuditEvent, AuditResource, AuditService
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


class AuthService:
    def __init__(
        self,
        session: AsyncSession,
        users: UserRepo,
        workspaces: WorkspaceRepo,
        tokens: TokenService,
    ) -> None:
        self._session = session
        self._users = users
        self._workspaces = workspaces
        self._tokens = tokens
        self._audit = AuditService(session)

    async def login(
        self,
        email: str,
        password: str,
        workspace_id: uuid.UUID,
        *,
        user_agent: str | None = None,
        ip: str | None = None,
    ) -> tuple[str, User]:
        # Принуждение к входу через провайдера проверяется до сверки пароля.
        # После неё отказ различал бы верный пароль и неверный там, где пароль
        # вообще не должен приниматься.
        workspace = await self._workspaces.by_id(workspace_id)
        if workspace is not None and workspace.enforce_sso:
            raise bad_request("error.auth.this_workspace_has_enforced_sso_login")

        user = await self._users.by_email(email, workspace_id)

        # Один и тот же отказ на несуществующий адрес и на неверный пароль.
        # Разные ответы позволяют перебрать, кто здесь заведён.
        if user is None or not _verify_password(password, user.password):
            raise unauthorized("error.auth.invalid_credentials")

        if user.deactivated_at is not None:
            raise unauthorized("error.auth.account_deactivated")

        session_id = await self._open_session(user, workspace_id, user_agent)
        await self._session.execute(
            update(User).where(User.id == user.id).values(last_login_at=datetime.now(UTC))
        )
        await self._audit.log(
            event=AuditEvent.USER_LOGGED_IN,
            resource_type=AuditResource.USER,
            resource_id=user.id,
            user_id=user.id,
            workspace_id=workspace_id,
            ip=ip,
        )
        await self._session.commit()

        return self._tokens.issue_access(user.id, workspace_id, session_id), user

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
        await self._session.execute(revoke.values(revoked_at=datetime.now(UTC)))

        await self._audit.log(
            event=AuditEvent.USER_PASSWORD_CHANGED,
            resource_type=AuditResource.USER,
            resource_id=user_id,
            user_id=user_id,
            workspace_id=workspace_id,
        )
        await self._session.commit()

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
