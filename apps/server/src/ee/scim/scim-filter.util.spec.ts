import {
  parseScimUserFilter,
  UnsupportedScimFilterError,
} from './scim-filter.util';

describe('parseScimUserFilter', () => {
  it('пустой фильтр дает пустой разбор', () => {
    expect(parseScimUserFilter(undefined)).toEqual({});
    expect(parseScimUserFilter('   ')).toEqual({});
  });

  it('userName разбирается', () => {
    expect(parseScimUserFilter('userName eq "petrov@tessera.com"')).toEqual({
      userName: 'petrov@tessera.com',
    });
  });

  it('externalId разбирается', () => {
    expect(parseScimUserFilter('externalId eq "ext-42"')).toEqual({
      externalId: 'ext-42',
    });
  });

  it('emails.value разбирается как адрес', () => {
    expect(parseScimUserFilter('emails.value eq "a@b.com"')).toEqual({
      email: 'a@b.com',
    });
  });

  // Провайдеры пишут имя атрибута как угодно, спецификация этого не запрещает.
  it('имя атрибута нечувствительно к регистру', () => {
    expect(parseScimUserFilter('USERNAME eq "a@b.com"')).toEqual({
      userName: 'a@b.com',
    });
  });

  it('оператор eq нечувствителен к регистру', () => {
    expect(parseScimUserFilter('userName EQ "a@b.com"')).toEqual({
      userName: 'a@b.com',
    });
  });

  /**
   * Неподдерживаемое отвергается, а не игнорируется. Молча отброшенный
   * фильтр вернул бы весь каталог там, где спрашивали одну запись.
   */
  it('другой оператор отвергается', () => {
    expect(() => parseScimUserFilter('userName sw "a"')).toThrow(
      UnsupportedScimFilterError,
    );
  });

  it('составной фильтр отвергается', () => {
    expect(() =>
      parseScimUserFilter('userName eq "a@b.com" and active eq true'),
    ).toThrow(UnsupportedScimFilterError);
  });

  it('неподдерживаемый атрибут отвергается', () => {
    expect(() => parseScimUserFilter('title eq "manager"')).toThrow(
      UnsupportedScimFilterError,
    );
  });

  /**
   * Пустое значение это законный фильтр, которому не соответствует никто.
   * Отбросить его нельзя: запрос одной записи вернул бы весь каталог.
   */
  it('пустое значение разбирается, а не отбрасывается', () => {
    expect(parseScimUserFilter('userName eq ""')).toEqual({ userName: '' });
    expect(parseScimUserFilter('externalId eq ""')).toEqual({ externalId: '' });
  });

  it('значение без кавычек отвергается', () => {
    expect(() => parseScimUserFilter('userName eq a@b.com')).toThrow(
      UnsupportedScimFilterError,
    );
  });
});
