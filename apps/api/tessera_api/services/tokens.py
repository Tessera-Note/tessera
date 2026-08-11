"""Токены доступа.

Формат сохранён от v1: тот же алгоритм, те же поля, тот же срок. На время
перехода обе версии смотрят в одну базу, и токен, выданный одной, обязан
приниматься другой — иначе переключение выкидывает всех вошедших.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import jwt

ALGORITHM = "HS256"

#: Срок жизни токена доступа. Тот же, что в v1 по умолчанию.
DEFAULT_EXPIRES = timedelta(days=30)

#: Срок токена совместного редактирования. Короче доступа: соединение живёт
#: сеанс работы, а не месяц, и утёкший токен должен протухнуть быстро.
COLLAB_EXPIRES = timedelta(hours=24)


class TokenType:
    """Вид токена.

    Проверяется при разборе: токен сброса пароля не должен приниматься как
    токен доступа. В v1 это разделение уже есть, и ослаблять его на переходе
    нельзя.
    """

    ACCESS = "access"
    EXCHANGE = "exchange"
    #: Токен для сервиса совместного редактирования. Отдельный вид намеренно:
    #: он живёт в другом процессе, и токен доступа, попавший туда, дал бы этому
    #: процессу право ходить в основное приложение от имени человека.
    COLLAB = "collab"


@dataclass(frozen=True, slots=True)
class TokenPayload:
    """Разобранное содержимое токена."""

    user_id: uuid.UUID
    workspace_id: uuid.UUID
    session_id: uuid.UUID | None
    token_type: str


class TokenService:
    def __init__(self, secret: str) -> None:
        self._secret = secret

    def issue_access(
        self,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        session_id: uuid.UUID,
        expires: timedelta = DEFAULT_EXPIRES,
    ) -> str:
        now = datetime.now(UTC)
        return jwt.encode(
            {
                "sub": str(user_id),
                "workspaceId": str(workspace_id),
                "sessionId": str(session_id),
                "type": TokenType.ACCESS,
                "iat": int(now.timestamp()),
                "exp": int((now + expires).timestamp()),
            },
            self._secret,
            algorithm=ALGORITHM,
        )

    def issue_collab(self, user_id: uuid.UUID, workspace_id: uuid.UUID) -> str:
        """Токен для подключения к сеансу совместного редактирования.

        Сессии здесь нет: сервис редактирования держит соединение сам и в базу
        за проверкой не ходит. Поэтому срок короткий, а вид токена отдельный.
        """
        now = datetime.now(UTC)
        return jwt.encode(
            {
                "sub": str(user_id),
                "workspaceId": str(workspace_id),
                "type": TokenType.COLLAB,
                "iat": int(now.timestamp()),
                "exp": int((now + COLLAB_EXPIRES).timestamp()),
            },
            self._secret,
            algorithm=ALGORITHM,
        )

    def read(self, token: str, expected_type: str = TokenType.ACCESS) -> TokenPayload | None:
        """Разобрать токен.

        Возвращает `None` вместо исключения: негодный токен это состояние
        запроса, а не поломка сервера. Исключение здесь превращало бы
        отклонённые учётные данные в пятисотый ответ, и это ровно то, что
        чинили в v1.
        """
        try:
            claims = jwt.decode(token, self._secret, algorithms=[ALGORITHM])
        except jwt.PyJWTError:
            return None

        if claims.get("type") != expected_type:
            return None

        try:
            session_raw = claims.get("sessionId")
            return TokenPayload(
                user_id=uuid.UUID(claims["sub"]),
                workspace_id=uuid.UUID(claims["workspaceId"]),
                session_id=uuid.UUID(session_raw) if session_raw else None,
                token_type=claims["type"],
            )
        except (KeyError, ValueError):
            # Токен подписан нами, но содержит не то, что мы кладём. Это не
            # обычный отказ, но и падать на нём нельзя.
            return None
