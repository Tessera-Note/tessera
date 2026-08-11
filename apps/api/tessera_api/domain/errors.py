"""Каталог отказов.

Отказ несёт устойчивый код, который служит ключом перевода на клиенте. Правило
перенесено из v1 вместе с ловушкой: **код не должен оканчиваться суффиксом
формы множественного числа** (`_one`, `_few`, `_many`, `_other`), иначе i18next
разбирает его как форму числа и перевода не находит.
"""

from __future__ import annotations

from litestar.exceptions import HTTPException
from litestar.status_codes import (
    HTTP_400_BAD_REQUEST,
    HTTP_401_UNAUTHORIZED,
    HTTP_403_FORBIDDEN,
    HTTP_404_NOT_FOUND,
    HTTP_409_CONFLICT,
)

ERROR_MESSAGES: dict[str, str] = {
    "error.auth.invalid_credentials": "Email or password does not match",
    "error.auth.account_deactivated": "This account is deactivated",
    "error.auth.session_expired": "The session has expired, sign in again",
    "error.auth.current_password_is_incorrect": "Current password is incorrect",
    "error.auth.password_too_short": "Password must be at least 8 characters",
    "error.workspace.setup_already_done": "This workspace is already set up",
    "error.workspace.owner_required": "Only the workspace owner can do this",
    "error.common.admin_required": "This action requires administrator rights",
    "error.workspace.you_cannot_change_yourself": "You cannot change your own membership",
    "error.workspace.unknown_role": "Unknown role",
    "error.workspace.last_owner": "The workspace must keep at least one active owner",
    "error.common.workspace_not_found": "Workspace not found",
    "error.common.user_not_found": "User not found",
    "error.space.space_not_found": "Space not found",
    "error.space.access_denied": "You do not have access to this space",
}


class AppError(HTTPException):
    """Отказ с кодом.

    Тело ответа повторяет v1: `code` для перевода, `message` как запасной
    вариант для тех отказов, у которых перевода ещё нет.
    """

    def __init__(self, code: str, status_code: int, params: dict | None = None) -> None:
        message = ERROR_MESSAGES.get(code, code)
        super().__init__(
            status_code=status_code,
            detail=message,
            extra={"code": code, **({"params": params} if params else {})},
        )
        self.code = code


def bad_request(code: str, params: dict | None = None) -> AppError:
    return AppError(code, HTTP_400_BAD_REQUEST, params)


def unauthorized(code: str, params: dict | None = None) -> AppError:
    return AppError(code, HTTP_401_UNAUTHORIZED, params)


def forbidden(code: str, params: dict | None = None) -> AppError:
    return AppError(code, HTTP_403_FORBIDDEN, params)


def not_found(code: str, params: dict | None = None) -> AppError:
    return AppError(code, HTTP_404_NOT_FOUND, params)


def conflict(code: str, params: dict | None = None) -> AppError:
    return AppError(code, HTTP_409_CONFLICT, params)
