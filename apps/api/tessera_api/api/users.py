"""Маршруты своей учётной записи.

Путь и имена полей взяты из v1: сверка двух версий идёт одинаковыми запросами.

Человек правит только себя. Чужую запись правят через маршруты рабочего
пространства, где стоит проверка роли; отдельного «правь кого угодно» здесь нет
и быть не должно.
"""

from __future__ import annotations

import re

import msgspec
from litestar import Controller, Request, post
from litestar.di import NamedDependency
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from tessera_api.api.dto import UserView
from tessera_api.api.guards import Principal
from tessera_api.domain.errors import bad_request, not_found
from tessera_api.infrastructure.models import User
from tessera_api.infrastructure.repositories import UserRepo

#: Допустимый вид языка: `ru` или `ru-RU`.
#:
#: Проверка обязательна, и причина из v1: язык уходит в форматирование дат
#: письма, и произвольная строка там даёт отказ в обработчике очереди — письмо
#: просто не уходит, а отказ гасится повтором задания.
LOCALE = re.compile(r"^[a-z]{2}(-[A-Z]{2})?$")

#: Предел длины имени. Имя показывается в дереве, в упоминаниях и в письмах, и
#: строка на тысячу знаков ломает вёрстку всюду сразу.
MAX_NAME = 100


class UpdateUserRequest(msgspec.Struct):
    """Имена полей из v1: их шлёт уже написанный клиент."""

    name: str | None = None
    locale: str | None = None


class UserController(Controller):
    path = "/api/users"

    @post("/update")
    async def update_me(
        self,
        data: UpdateUserRequest,
        request: Request,
        db_session: NamedDependency[AsyncSession],
    ) -> UserView:
        """Изменить своё имя или язык.

        Поле, которого нет в запросе, не трогается: экран настроек шлёт то, что
        человек менял, и приведение отсутствующего к пустому стирало бы имя при
        смене языка.
        """
        principal: Principal = request.scope["principal"]

        values: dict = {}

        if data.name is not None:
            name = data.name.strip()
            if not name or len(name) > MAX_NAME:
                raise bad_request("error.user.name_invalid", {"limit": MAX_NAME})
            values["name"] = name

        if data.locale is not None:
            locale = data.locale.strip()
            if not LOCALE.match(locale):
                raise bad_request("error.user.locale_invalid")
            values["locale"] = locale

        if values:
            await db_session.execute(
                update(User).where(User.id == principal.user_id).values(**values)
            )
            await db_session.commit()

        user = await UserRepo(db_session).by_id(principal.user_id, principal.workspace_id)
        if user is None:
            raise not_found("error.common.user_not_found")

        return UserView(
            id=user.id,
            name=user.name,
            email=user.email,
            avatarUrl=user.avatar_url,
            role=user.role,
            locale=user.locale,
        )
