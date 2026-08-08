/**
 * Плейсхолдер в шаблоне фильтра поиска, который заполняет администратор.
 *
 * Подстановка разрешена только внутри фильтра и только для имени
 * пользователя. В базовый DN и в имена атрибутов имя не попадает: там
 * действует другая грамматика (RFC 4514), и правило экранирования отсюда
 * к ней неприменимо.
 */
export const LDAP_USERNAME_PLACEHOLDER = '{{username}}';

/** Шаблон по умолчанию, совпадает с подсказкой в форме настройки. */
export const LDAP_DEFAULT_USER_FILTER = `(mail=${LDAP_USERNAME_PLACEHOLDER})`;

/**
 * Экранирование значения для фильтра поиска по RFC 4515.
 *
 * Шаблон фильтра хранится строкой, и имя подставляется в него текстом.
 * Без экранирования имя вида `*)(objectClass=*` меняет смысл всего фильтра:
 * поиск начинает возвращать посторонние записи, и подобрать среди них ту,
 * чей пароль известен нападающему, становится делом перебора.
 *
 * Экранируются пять символов, каждый в форме обратной косой черты и двух
 * шестнадцатеричных цифр. Не-ASCII при этом не трогаем: каталог принимает
 * UTF-8, а побайтное экранирование понадобилось бы только при передаче
 * через транспорт, не выдерживающий восьмой бит.
 */
export function escapeLdapFilterValue(value: string): string {
  let escaped = '';
  for (const char of value) {
    switch (char) {
      case '*':
        escaped += '\\2a';
        break;
      case '(':
        escaped += '\\28';
        break;
      case ')':
        escaped += '\\29';
        break;
      case '\\':
        escaped += '\\5c';
        break;
      case '\0':
        escaped += '\\00';
        break;
      default:
        escaped += char;
    }
  }
  return escaped;
}

/**
 * Подстановка имени пользователя в шаблон фильтра.
 *
 * Экранирование делается до подстановки и применяется ко всем вхождениям
 * плейсхолдера: шаблон может ссылаться на имя дважды, например
 * `(|(uid={{username}})(mail={{username}}))`.
 */
export function buildLdapUserFilter(
  template: string | null | undefined,
  username: string,
): string {
  const filter = template?.trim() || LDAP_DEFAULT_USER_FILTER;
  return filter
    .split(LDAP_USERNAME_PLACEHOLDER)
    .join(escapeLdapFilterValue(username));
}
