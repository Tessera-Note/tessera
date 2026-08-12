"""Сброс пароля по ссылке из письма."""

from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.domain.errors import bad_request
from tessera_api.infrastructure.models import User, UserSession, UserToken
from tessera_api.infrastructure.queue import JobName, JobQueue
from tessera_api.infrastructure.repositories import UserRepo
from tessera_api.services.audit import AuditEvent, AuditResource, AuditService
from tessera_api.services.auth import hash_password
from tessera_api.services.notification_mail import compose_plain

#: Вид токена. Проверяется при разборе: токен подтверждения почты не должен
#: приниматься как токен сброса пароля.
TOKEN_TYPE = "forgot_password"

#: Срок жизни ссылки. Короткий намеренно: ссылка лежит в почтовом ящике, и чем
#: дольше она действует, тем дольше доступ к ящику равен доступу к учётной
#: записи.
TOKEN_TTL = timedelta(hours=1)

MIN_PASSWORD_LENGTH = 8


class PasswordResetService:
    def __init__(self, session: AsyncSession, users: UserRepo, queue: JobQueue) -> None:
        self._session = session
        self._users = users
        self._queue = queue
        self._audit = AuditService(session)

    async def request(self, email: str, workspace_id: uuid.UUID, app_url: str) -> None:
        """Выслать ссылку сброса.

        Ответ одинаков и для заведённого адреса, и для незаведённого: разные
        ответы позволяют перебором узнать, кто здесь работает. Поэтому метод
        ничего не возвращает и не отличает эти случаи наружу.
        """
        user = await self._users.by_email(email, workspace_id)
        if user is None or user.deactivated_at is not None:
            return

        # Прежние токены гасятся: несколько живых ссылок означают несколько
        # способов войти, и отозвать их разом потом нечем.
        await self._session.execute(
            update(UserToken)
            .where(UserToken.user_id == user.id)
            .where(UserToken.type == TOKEN_TYPE)
            .where(UserToken.used_at.is_(None))
            .values(used_at=datetime.now(UTC))
        )

        token = secrets.token_urlsafe(32)
        await self._session.execute(
            insert(UserToken).values(
                id=uuid.uuid4(),
                token=token,
                type=TOKEN_TYPE,
                user_id=user.id,
                workspace_id=workspace_id,
                expires_at=datetime.now(UTC) + TOKEN_TTL,
            )
        )
        await self._session.commit()

        link = f"{app_url.rstrip('/')}/password-reset?token={token}"
        # Письмо уходит заданием, а не прямо здесь. Соединение с почтовым
        # сервером открывается с таймаутом в двадцать секунд, и внутри запроса
        # это двадцать секунд ожидания у человека, который нажал «сбросить
        # пароль». Отказ отправки при этом не теряется: он попадает в журнал
        # исполнителя, и задание повторяется трижды.
        letter = compose_plain(
            locale=user.locale,
            recipient_name=user.name or user.email,
            subject_key="mail.subject.password_reset",
            body_key="mail.forgot_password.body",
            action_key="mail.action.set_password",
            url=link,
            note_key="mail.forgot_password.note",
        )
        await self._queue.enqueue(
            JobName.SEND_EMAIL,
            to=user.email,
            subject=letter.subject,
            body=letter.body,
            html=letter.html,
        )

    async def reset(self, token: str, new_password: str, workspace_id: uuid.UUID) -> None:
        if len(new_password) < MIN_PASSWORD_LENGTH:
            raise bad_request("error.auth.password_too_short")

        found = (
            await self._session.execute(
                select(UserToken)
                .where(UserToken.token == token)
                .where(UserToken.type == TOKEN_TYPE)
            )
        ).scalar_one_or_none()

        # Один и тот же отказ на несуществующий, просроченный и использованный
        # токен: различать их значит рассказывать, какой из них существует.
        now = datetime.now(UTC)
        if (
            found is None
            or found.used_at is not None
            or found.expires_at is None
            or found.expires_at < now
        ):
            raise bad_request("error.auth.invalid_or_expired_token")

        await self._session.execute(
            update(User)
            .where(User.id == found.user_id)
            .values(password=hash_password(new_password))
        )

        # Токен гасится, а не удаляется: запись о том, что им воспользовались,
        # нужна при разборе происшествия.
        await self._session.execute(
            update(UserToken).where(UserToken.id == found.id).values(used_at=now)
        )

        # Все сессии отзываются. Пароль сбрасывают в том числе тогда, когда его
        # увели, и оставленная чужая сессия делает сброс бессмысленным.
        await self._session.execute(
            update(UserSession)
            .where(UserSession.user_id == found.user_id)
            .where(UserSession.revoked_at.is_(None))
            .values(revoked_at=now)
        )

        await self._audit.log(
            event=AuditEvent.USER_PASSWORD_CHANGED,
            resource_type=AuditResource.USER,
            resource_id=found.user_id,
            user_id=found.user_id,
            workspace_id=workspace_id,
        )
        await self._session.commit()

    async def verify(self, token: str) -> bool:
        """Годна ли ссылка. Экран смены пароля спрашивает это до ввода."""
        found = (
            await self._session.execute(
                select(UserToken)
                .where(UserToken.token == token)
                .where(UserToken.type == TOKEN_TYPE)
            )
        ).scalar_one_or_none()

        if found is None or found.used_at is not None or found.expires_at is None:
            return False
        return found.expires_at > datetime.now(UTC)
