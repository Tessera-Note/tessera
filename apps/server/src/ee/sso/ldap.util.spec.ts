import {
  buildLdapUserFilter,
  escapeLdapFilterValue,
  LDAP_DEFAULT_USER_FILTER,
} from './ldap.util';

/**
 * Экранирование значения фильтра по RFC 4515.
 *
 * Шаблон фильтра задает администратор, а имя подставляется в него текстом.
 * Без экранирования имя меняет смысл всего фильтра, и поиск начинает
 * возвращать посторонние записи.
 */
describe('escapeLdapFilterValue', () => {
  it('звездочка экранируется', () => {
    expect(escapeLdapFilterValue('*')).toBe('\\2a');
  });

  it('открывающая скобка экранируется', () => {
    expect(escapeLdapFilterValue('(')).toBe('\\28');
  });

  it('закрывающая скобка экранируется', () => {
    expect(escapeLdapFilterValue(')')).toBe('\\29');
  });

  it('обратная косая экранируется', () => {
    expect(escapeLdapFilterValue('\\')).toBe('\\5c');
  });

  it('нулевой символ экранируется', () => {
    expect(escapeLdapFilterValue('\0')).toBe('\\00');
  });

  it('обычные символы не трогаются', () => {
    expect(escapeLdapFilterValue('petrov@tessera.com')).toBe(
      'petrov@tessera.com',
    );
  });

  it('кириллица проходит без изменений', () => {
    expect(escapeLdapFilterValue('Пётр')).toBe('Пётр');
  });

  it('пустое значение остается пустым', () => {
    expect(escapeLdapFilterValue('')).toBe('');
  });
});

describe('buildLdapUserFilter', () => {
  it('без шаблона берется значение по умолчанию', () => {
    expect(buildLdapUserFilter(null, 'petrov')).toBe('(mail=petrov)');
    expect(buildLdapUserFilter('   ', 'petrov')).toBe('(mail=petrov)');
    expect(LDAP_DEFAULT_USER_FILTER).toBe('(mail={{username}})');
  });

  it('имя подставляется в шаблон', () => {
    expect(buildLdapUserFilter('(uid={{username}})', 'petrov')).toBe(
      '(uid=petrov)',
    );
  });

  // Шаблон может ссылаться на имя дважды.
  it('заполняются все вхождения плейсхолдера', () => {
    expect(
      buildLdapUserFilter('(|(uid={{username}})(mail={{username}}))', 'petrov'),
    ).toBe('(|(uid=petrov)(mail=petrov))');
  });

  /**
   * Ключевой случай: без экранирования такое имя превращает фильтр в
   * перечисление всех записей каталога.
   */
  it('попытка инъекции обезвреживается', () => {
    const filter = buildLdapUserFilter(
      '(mail={{username}})',
      '*)(objectClass=*',
    );

    expect(filter).toBe('(mail=\\2a\\29\\28objectClass=\\2a)');
    expect(filter).not.toContain('*)');
    expect(filter).not.toContain('(objectClass');
  });

  it('скобки в имени не рвут фильтр', () => {
    expect(buildLdapUserFilter('(cn={{username}})', 'Ivanov (IT)')).toBe(
      '(cn=Ivanov \\28IT\\29)',
    );
  });
});
