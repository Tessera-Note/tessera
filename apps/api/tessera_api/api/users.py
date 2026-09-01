"""Маршруты своей учётной записи.

Путь и имена полей взяты из v1: сверка двух версий идёт одинаковыми запросами.

Человек правит только себя. Чужую запись правят через маршруты рабочего
пространства, где стоит проверка роли; отдельного «правь кого угодно» здесь нет
и быть не должно.
"""

from __future__ import annotations

import json
import re

import msgspec
from litestar import Controller, Request, post
from litestar.di import NamedDependency
from sqlalchemy import text, update
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
    #: Предпочтения показа. Имена полей из v1: одна база на обе версии, и
    #: человек, переключивший ширину в одной, видит её и в другой.
    fullPageWidth: bool | None = None  # noqa: N815 — имя поля из v1
    pageEditMode: str | None = None  # noqa: N815 — имя поля из v1
    editorToolbar: bool | None = None  # noqa: N815 — имя поля из v1
    #: Переключатели уведомлений. Каждый отвечает за свой вид.
    notificationPageUpdates: bool | None = None  # noqa: N815 — имя поля из v1
    notificationPageUserMention: bool | None = None  # noqa: N815 — имя поля из v1
    notificationCommentUserMention: bool | None = None  # noqa: N815 — имя поля из v1
    notificationCommentCreated: bool | None = None  # noqa: N815 — имя поля из v1
    notificationCommentResolved: bool | None = None  # noqa: N815 — имя поля из v1
    notificationPagePermissionGranted: bool | None = None  # noqa: N815 — имя поля из v1
    notificationPageApprovalRequested: bool | None = None  # noqa: N815 — имя поля из v1
    notificationPageVerificationUpdates: bool | None = None  # noqa: N815 — имя поля из v1


#: Поле запроса и ключ настроек, за который оно отвечает. Ключи из v1.
NOTIFICATION_KEYS = {
    "notificationPageUpdates": "page.updated",
    "notificationPageUserMention": "page.userMention",
    "notificationCommentUserMention": "comment.userMention",
    "notificationCommentCreated": "comment.created",
    "notificationCommentResolved": "comment.resolved",
    "notificationPagePermissionGranted": "page.permissionGranted",
    "notificationPageApprovalRequested": "page.approvalRequested",
    "notificationPageVerificationUpdates": "page.verificationUpdates",
}


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

        preferences = {
            "fullPageWidth": data.fullPageWidth,
            "editorToolbar": data.editorToolbar,
        }
        if data.pageEditMode is not None:
            mode = data.pageEditMode.strip().lower()
            if mode not in ("read", "edit"):
                raise bad_request("error.user.page_edit_mode_invalid")
            preferences["pageEditMode"] = mode

        notifications = {
            NOTIFICATION_KEYS[field]: value
            for field, value in (
                ("notificationPageUpdates", data.notificationPageUpdates),
                ("notificationPageUserMention", data.notificationPageUserMention),
                ("notificationCommentUserMention", data.notificationCommentUserMention),
                ("notificationCommentCreated", data.notificationCommentCreated),
                ("notificationCommentResolved", data.notificationCommentResolved),
                (
                    "notificationPagePermissionGranted",
                    data.notificationPagePermissionGranted,
                ),
                (
                    "notificationPageApprovalRequested",
                    data.notificationPageApprovalRequested,
                ),
                (
                    "notificationPageVerificationUpdates",
                    data.notificationPageVerificationUpdates,
                ),
            )
            if value is not None
        }
        settings_patch = {
            name: value for name, value in preferences.items() if value is not None
        }

        if settings_patch or notifications:
            # Слияние делает база: чтение, слияние в приложении и запись целиком
            # затирали бы соседний переключатель, если два экрана открыты разом.
            await db_session.execute(
                text(
                    """
                    UPDATE users
                    SET settings = coalesce(settings, '{}'::jsonb)
                        || jsonb_build_object(
                            'preferences',
                            coalesce(settings->'preferences', '{}'::jsonb)
                                || cast(:preferences AS jsonb),
                            'notifications',
                            coalesce(settings->'notifications', '{}'::jsonb)
                                || cast(:notifications AS jsonb)
                        )
                    WHERE id = :user_id
                    """
                ),
                {
                    "preferences": json.dumps(settings_patch),
                    "notifications": json.dumps(notifications),
                    "user_id": principal.user_id,
                },
            )

        if values:
            await db_session.execute(
                update(User).where(User.id == principal.user_id).values(**values)
            )

        if values or settings_patch or notifications:
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
            settings=user.settings,
        )
