"""Открыть сеанс на локальном стенде второй версии.

Нужен для проверки экранов глазами. Учётную запись на стенде заводить нельзя, а
пароль в форму агент не вводит: сеанс выдаётся тем же путём, каким его выдаёт
вход через провайдера — `AuthService.open_session_for`. Пароль здесь не
участвует и не проверяется.

Запускается **внутри контейнера стенда**:

    docker cp scripts/stand-session.py tessera-v2-api:/tmp/stand-session.py
    docker exec tessera-v2-api python /tmp/stand-session.py

Токен печатается в стандартный вывод и есть учётные данные: перенаправлять его
следует в файл, а не в чат и не в журнал. Сеанс закрывается из интерфейса
выходом либо отзывом в настройках учётной записи.

**Только стенд.** Скрипт отказывается работать, если `APP_URL` не указывает на
локальную машину: на боевом узле выдача сеанса в обход входа недопустима.
"""

from __future__ import annotations

import asyncio
import os
import sys
from urllib.parse import urlparse

from sqlalchemy import select

from tessera_api.infrastructure.database import Database
from tessera_api.infrastructure.models import User
from tessera_api.infrastructure.repositories import UserRepo, WorkspaceRepo
from tessera_api.services.auth import AuthService
from tessera_api.services.tokens import TokenService

#: Узлы, которые считаются стендом. Боевой домен сюда не попадает.
LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1")


def _is_stand() -> bool:
    host = urlparse(os.environ.get("APP_URL", "")).hostname
    return host in LOCAL_HOSTS


async def main() -> None:
    if not _is_stand():
        print("APP_URL не указывает на стенд: сеанс не выдан", file=sys.stderr)
        raise SystemExit(1)

    # Подключение строится тем же классом, что и в приложении: строка в
    # окружении записана драйвером v1, и своя сборка движка спотыкается о неё.
    database = Database(os.environ["DATABASE_URL"])
    try:
        async with database.session() as session:
            # Первый заведённый человек: на стенде он один, и это владелец
            # рабочего пространства.
            user = (
                await session.execute(
                    select(User)
                    .where(User.deleted_at.is_(None))
                    .order_by(User.created_at)
                    .limit(1)
                )
            ).scalar_one()
            # Служба собирается так же, как в маршруте входа. Канал событий
            # не передаётся: он нужен выходу, а не выдаче.
            service = AuthService(
                session,
                UserRepo(session),
                WorkspaceRepo(session),
                TokenService(os.environ["APP_SECRET"]),
            )
            token = await service.open_session_for(
                user, user.workspace_id, user_agent="stand-review"
            )
            print(token)
    finally:
        await database.dispose()


asyncio.run(main())
