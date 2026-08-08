export const AUTH_THROTTLER = 'auth';
export const AI_CHAT_THROTTLER = 'ai-chat';
export const EXPORT_THROTTLER = 'export';
/**
 * Отдельный счетчик для входа через каталог.
 *
 * Общий лимит по адресу за корпоративным NAT делится всеми сотрудниками,
 * а перебор пароля через нас накручивает счетчик неудач в каталоге и
 * блокирует настоящую учетную запись. Поэтому нужен второй счетчик,
 * привязанный к провайдеру и имени пользователя.
 */
export const LDAP_LOGIN_THROTTLER = 'ldap-login';
