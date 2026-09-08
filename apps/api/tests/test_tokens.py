"""Токены.

База не нужна: проверяется разбор и разделение видов.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import jwt
import pytest

from tessera_api.services.tokens import ALGORITHM, TokenService, TokenType

SECRET = "x" * 40


@pytest.fixture
def service() -> TokenService:
    return TokenService(SECRET)


class TestAccessToken:
    def test_round_trip(self, service: TokenService) -> None:
        user_id, workspace_id, session_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()

        payload = service.read(service.issue_access(user_id, workspace_id, session_id))

        assert payload is not None
        assert payload.user_id == user_id
        assert payload.workspace_id == workspace_id
        assert payload.session_id == session_id

    def test_foreign_signature_is_rejected(self, service: TokenService) -> None:
        """Токен, подписанный чужим ключом, не принимается.

        Без проверки подписи любой мог бы выписать себе токен от чужого имени.
        """
        forged = jwt.encode(
            {
                "sub": str(uuid.uuid4()),
                "workspaceId": str(uuid.uuid4()),
                "type": TokenType.ACCESS,
                "exp": int((datetime.now(UTC) + timedelta(days=1)).timestamp()),
            },
            "чужой-ключ-достаточной-длины-для-подписи",
            algorithm=ALGORITHM,
        )
        assert service.read(forged) is None

    def test_expired_token_is_rejected(self, service: TokenService) -> None:
        expired = jwt.encode(
            {
                "sub": str(uuid.uuid4()),
                "workspaceId": str(uuid.uuid4()),
                "type": TokenType.ACCESS,
                "exp": int((datetime.now(UTC) - timedelta(minutes=1)).timestamp()),
            },
            SECRET,
            algorithm=ALGORITHM,
        )
        assert service.read(expired) is None

    def test_broken_token_returns_none(self, service: TokenService) -> None:
        """Негодный токен это состояние запроса, а не поломка сервера.

        Исключение здесь превращало бы отклонённые учётные данные в пятисотый
        ответ.
        """
        assert service.read("не-токен") is None
        assert service.read("") is None


class TestCollabToken:
    def test_collab_token_is_not_an_access_token(self, service: TokenService) -> None:
        """Виды токенов не взаимозаменяемы.

        Сервис редактирования живёт отдельным процессом. Токен доступа,
        попавший туда, дал бы ему право ходить в приложение от имени человека,
        а токен редактирования, принятый как доступ, открыл бы ему всё API.
        """
        collab = service.issue_collab(uuid.uuid4(), uuid.uuid4())

        assert service.read(collab) is None
        assert service.read(collab, TokenType.COLLAB) is not None

    def test_access_token_is_not_a_collab_token(self, service: TokenService) -> None:
        access = service.issue_access(uuid.uuid4(), uuid.uuid4(), uuid.uuid4())

        assert service.read(access, TokenType.COLLAB) is None

    def test_collab_token_expires_sooner(self, service: TokenService) -> None:
        """Соединение живёт сеанс работы, а не месяц."""
        collab = jwt.decode(
            service.issue_collab(uuid.uuid4(), uuid.uuid4()),
            SECRET,
            algorithms=[ALGORITHM],
        )
        access = jwt.decode(
            service.issue_access(uuid.uuid4(), uuid.uuid4(), uuid.uuid4()),
            SECRET,
            algorithms=[ALGORITHM],
        )
        assert collab["exp"] < access["exp"]
