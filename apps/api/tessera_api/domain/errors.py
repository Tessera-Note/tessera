"""Каталог отказов.

Отказ несёт устойчивый код, который служит ключом перевода на клиенте. Правило
перенесено из v1 вместе с ловушкой: **код не должен оканчиваться суффиксом
формы множественного числа** (`_one`, `_few`, `_many`, `_other`), иначе i18next
разбирает его как форму числа и перевода не находит.
"""

from __future__ import annotations

from litestar import Request, Response
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
    "error.auth.invalid_email": "Enter a valid email address",
    "error.workspace.setup_already_done": "This workspace is already set up",
    "error.workspace.owner_required": "Only the workspace owner can do this",
    "error.common.admin_required": "This action requires administrator rights",
    "error.workspace.you_cannot_change_yourself": "You cannot change your own membership",
    "error.workspace.unknown_role": "Unknown role",
    "error.workspace.last_owner": "The workspace must keep at least one active owner",
    "error.workspace.no_emails": "Provide at least one email address",
    "error.workspace.all_already_members": "Everyone on this list is already a member",
    "error.workspace.invitation_not_found": "Invitation not found",
    "error.workspace.invalid_invitation_token": "This invitation link is not valid",
    "error.workspace.invitation_already_accepted": "This invitation has already been accepted",
    "error.auth.invalid_or_expired_token": "This link is not valid or has expired",
    "error.sso.provider_disabled": "This sign-in provider is turned off",
    "error.sso.provider_not_found": "Sign-in provider not found",
    "error.audit.invalid_retention": "Retention must be between 0 and 3650 days",
    "error.ai.unknown_driver": "Unknown AI provider",
    "error.ai.not_configured": "The AI provider is not configured",
    "error.ai.embedding_dimension": (
        "The embedding model returns a different vector width than the index expects"
    ),
    "error.ai.embedding_failed": "The embedding provider refused the request",
    "error.ai.request_failed": "The AI provider refused the request",
    "error.ai.empty_query": "Ask a question first",
    "error.auth.this_workspace_has_enforced_sso_login": (
        "This workspace requires signing in through a provider"
    ),
    "error.sso.account_unavailable": "This account is unavailable",
    "error.sso.identity_conflict": (
        "This email is already linked to another account at the provider"
    ),
    "error.sso.signup_disabled": "This provider does not allow new accounts",
    "error.common.workspace_not_found": "Workspace not found",
    "error.common.user_not_found": "User not found",
    "error.space.space_not_found": "Space not found",
    "error.space.space_id_required": "A space must be given",
    "error.space.access_denied": "You do not have access to this space",
    "error.page.page_not_found": "Page not found",
    "error.page.access_denied": "You do not have access to this page",
    "error.page.edit_denied": "You cannot edit this page",
    "error.page.title_required": "The page needs a title or content",
    "error.page.parent_in_other_space": "The parent page is in another space",
    "error.page.parent_is_descendant": "A page cannot be moved into its own subtree",
    "error.comment.comment_not_found": "Comment not found",
    "error.comment.content_required": "The comment is empty",
    "error.comment.parent_on_other_page": "The parent comment is on another page",
    "error.comment.not_yours": "You can only change your own comments",
    "error.label.label_not_found": "Label not found",
    "error.label.name_required": "The label needs a name",
    "error.attachment.attachment_not_found": "Attachment not found",
    "error.page.version_not_found": "Page version not found",
    "error.share.share_not_found": "This link is not valid",
    "error.base.base_not_found": "Base not found",
    "error.base.property_not_found": "Property not found",
    "error.base.row_not_found": "Row not found",
    "error.base.view_not_found": "View not found",
    "error.base.unknown_property_type": "Unknown property type",
    "error.base.unknown_view_type": "Unknown view type",
    "error.base.primary_property": "The title property cannot be removed",
    "error.base.last_view": "A base must keep at least one view",
    "error.base.export_too_large": "This base is too large to export at once",
    "error.mcp.disabled": "The agent tools channel is turned off for this workspace",
    "error.mcp.tool_failed": "The tool could not complete",
    "error.content.transform_unavailable": "The content service is not responding",
    "error.content.transform_failed": "This content could not be converted",
    "error.import.unsupported_format": "This file format cannot be imported",
    "error.import.no_text": "No text could be read from this document",
    "error.import.no_text_layer": "This PDF has no text layer, only images",
    "error.import.broken_archive": "This archive could not be opened",
    "error.import.archive_too_large": "This archive unpacks to too much data",
    "error.import.nothing_to_import": "The archive has no importable files",
    "error.import.unknown_source": "Unknown archive kind",
    "error.import.unavailable": "Archive import is not available in this deployment",
    "error.import.failed": "The import could not be completed",
    "error.import.file_required": "No file was uploaded",
    "error.import.file_too_large": "This file is too large to import",
    "error.import.unsupported_archive": "Only zip archives can be imported",
    "error.import.task_not_found": "Import task not found",
    "error.export.unknown_format": "Unknown export format",
    "error.export.nothing_to_export": "There is nothing to export",
    "error.export.attachments_unavailable": "Attachments cannot be bundled in this deployment",
    "error.ai.tools_unsupported": "This AI provider cannot use tools",
    "error.ai.model_not_configured": "No model name is set for this AI provider",
    "error.ai_chat.chat_not_found": "Conversation not found",
    "error.ai_chat.disabled": "The assistant is turned off for this workspace",
    "error.ai_chat.message_not_found": "Message not found",
    "error.ai_chat.tool_not_allowed": "The agent is not allowed to use this tool",
    "error.ai_chat.unknown_decision": "Unknown decision",
    "error.ai_chat.plan_already_resolved": "This plan has already been decided",
}


class AppError(HTTPException):
    """Отказ с кодом.

    Тело ответа повторяет v1: `code` для перевода, `message` как запасной
    вариант для тех отказов, у которых перевода ещё нет. Форму собирает
    `app_error_response`: своё представление Litestar кладёт код внутрь `extra`,
    и клиент, ищущий его наверху, не находит ничего.
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


def app_error_response(request: Request, exception: AppError) -> Response:
    """Тело отказа в том же виде, что в v1.

    Своё представление Litestar даёт `{status_code, detail, extra}`, то есть
    прячет код внутрь `extra` и называет текст иначе. Клиент переводит по коду
    и ищет его наверху: без этой сборки перевода нет ни у одного отказа, и
    видно это только в интерфейсе, а не в проверках.

    Обрабатывается именно `AppError`, а не всякий `HTTPException`. У отказов
    разбора запроса и у ненайденного маршрута кода нет, и выдумывать его
    здесь — значит завести вторую таблицу кодов.
    """
    extra = exception.extra if isinstance(exception.extra, dict) else {}
    body: dict = {"message": exception.detail, "code": extra.get("code", "")}
    if extra.get("params"):
        body["params"] = extra["params"]
    return Response(body, status_code=exception.status_code)
