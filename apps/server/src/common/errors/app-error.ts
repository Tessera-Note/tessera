import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

/**
 * Отказ с машиночитаемым кодом.
 *
 * Сообщения об отказах приходили с сервера готовым текстом на русском, а
 * клиент показывает именно их, предпочитая локализованному запасному
 * варианту. В итоге человек с любой из двенадцати локалей видел русскую
 * строку, а заведенный рядом ключ перевода не отображался почти никогда.
 *
 * Наружу теперь уходит код. Клиент переводит по коду, а человекочитаемый
 * текст остается для журнала и внешних потребителей API: правка формулировки
 * больше не ломает перевод, а перевод не зависит от языка серверного кода.
 *
 * Код одновременно служит ключом перевода. Второй таблицы соответствий не
 * заводится намеренно: она неизбежно разошлась бы с кодами, и разойтись могла
 * бы молча.
 */

/** Подстановки в текст отказа. Уходят наружу вместе с кодом. */
export type ErrorParams = Record<string, string | number>;

/**
 * Коды отказов и английский текст к ним.
 *
 * Текст здесь запасной: он попадает в журнал и в ответ для тех, кто читает
 * API напрямую. Человеку в интерфейсе показывается перевод по коду.
 */
export const ErrorMessage = {
  'error.audit.retention_invalid':
    'Audit retention must be a whole number of days, zero or more',
  'error.base.csv_row_limit': 'CSV export is limited to {{limit}} rows',
  'error.import.docx_empty': 'The document file is empty',
  'error.import.docx_unreadable': 'The Word document could not be parsed',
  'error.import.pdf_empty': 'The PDF file is empty',
  'error.import.pdf_unreadable': 'The PDF file could not be parsed',
  'error.import.pdf_no_text_layer':
    'This PDF has no text layer: it is a scan or an image-only document',
  'error.auth.email_not_verified':
    'Please verify your email address. Check your inbox for the verification link.',
  'error.mcp.cells_required': 'The cells argument is required',
  'error.mcp.argument_must_be_object':
    'The {{argument}} argument must be an object of the form { "key": value }',

  'error.mfa.session_expired': 'The confirmation session has expired',
  'error.mfa.code_invalid': 'The code is not correct',
  'error.mfa.user_not_found': 'User not found',
  'error.mfa.not_enabled_for_user':
    'Two-factor authentication is not enabled for this user',
  'error.mfa.not_enabled': 'Two-factor authentication is not enabled',
  'error.mfa.already_enabled': 'Two-factor authentication is already enabled',
  'error.mfa.setup_not_started': 'Two-factor setup has not been started',
  'error.mfa.password_invalid': 'The password is not correct',

  'error.scim.token_limit':
    'The limit of {{limit}} active tokens is reached. Revoke the ones you no longer need',
  'error.scim.token_not_found': 'SCIM token not found',

  'error.sso.google_not_configured':
    'Google sign-in is not configured: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set',
  'error.sso.google_unavailable': 'Google is not responding',
  'error.sso.workspace_not_found': 'Workspace not found',
  'error.sso.login_session_expired':
    'The sign-in session was not found or has expired',
  'error.sso.not_confirmed': 'Sign-in through the provider was not confirmed',
  'error.sso.no_subject': 'The provider did not return an identifier',
  'error.sso.email_not_verified': 'The email address is not verified',
  'error.sso.no_email': 'The provider did not return an email address',
  'error.sso.no_response': 'The provider did not return a response',
  'error.sso.directory_unavailable':
    'The user directory is unavailable. Contact your administrator',
  'error.sso.directory_no_stable_id':
    'The directory does not provide a stable user identifier. Contact your administrator',
  'error.sso.directory_no_email': 'This directory account has no email address',
  'error.sso.directory_ambiguous':
    'The directory configuration is ambiguous. Contact your administrator',
  'error.sso.credentials_invalid': 'Wrong username or password',
  'error.sso.client_secret_missing':
    'The provider has no client secret configured',
  'error.sso.issuer_invalid': 'The issuer address is not valid',
  'error.sso.issuer_not_https': 'The issuer address must start with https',
  'error.sso.provider_unreachable':
    'The sign-in provider is not responding or is misconfigured',
  'error.sso.provider_unavailable': 'The sign-in provider is unavailable',
  'error.sso.provider_ambiguous':
    'The sign-in provider configuration is ambiguous',
  'error.sso.account_unavailable': 'The account is unavailable',
  'error.sso.identity_conflict':
    'An account with this email is already linked to the provider under a different identifier. Contact your administrator',
  'error.sso.signup_disabled':
    'This provider does not create new accounts. Contact your administrator',
  'error.sso.provider_not_found': 'Sign-in provider not found',
  'error.sso.ldaps_starttls_conflict':
    'An ldaps address already encrypts the connection, enabling StartTLS separately is not allowed',
  'error.sso.filter_invalid':
    'The search filter is not written correctly and cannot be parsed',
  'error.sso.provider_type_unknown': 'Unknown sign-in provider type',
  'error.sso.provider_fields_required':
    'Provider type {{type}} requires: {{fields}}',
  'error.sso.user_not_found': 'User not found',
  'error.sso.user_has_no_links': 'This user has no sign-in provider links',
} as const;

export type ErrorCode = keyof typeof ErrorMessage;

/** Подставить значения в запасной текст. */
function render(code: ErrorCode, params?: ErrorParams): string {
  const template: string = ErrorMessage[code];
  if (!params) return template;

  return template.replace(/\{\{(\w+)\}\}/g, (whole, name) =>
    name in params ? String(params[name]) : whole,
  );
}

function body(code: ErrorCode, params?: ErrorParams) {
  return params
    ? { message: render(code, params), code, params }
    : { message: render(code), code };
}

export function badRequest(code: ErrorCode, params?: ErrorParams) {
  return new BadRequestException(body(code, params));
}

export function unauthorized(code: ErrorCode, params?: ErrorParams) {
  return new UnauthorizedException(body(code, params));
}

export function notFound(code: ErrorCode, params?: ErrorParams) {
  return new NotFoundException(body(code, params));
}

export function forbidden(code: ErrorCode, params?: ErrorParams) {
  return new ForbiddenException(body(code, params));
}

export function conflict(code: ErrorCode, params?: ErrorParams) {
  return new ConflictException(body(code, params));
}

export function serviceUnavailable(code: ErrorCode, params?: ErrorParams) {
  return new ServiceUnavailableException(body(code, params));
}
