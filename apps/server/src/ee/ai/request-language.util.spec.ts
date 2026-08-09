import { languageForRequest } from './request-language.util';

/**
 * Замерено на живом случае: «которые» давало русский ответ, «которіе» с одной
 * украинской буквой давало украинский. Такая зависимость от опечатки
 * непредсказуема, поэтому на смешанном тексте решает локаль.
 */
describe('languageForRequest', () => {
  it('чистый русский запрос дает русский, несмотря на украинскую локаль', () => {
    expect(
      languageForRequest('создай страницу с фильмами которые в прокате', 'uk-UA'),
    ).toBe('Russian');
  });

  it('чистый украинский запрос дает украинский при русской локали', () => {
    expect(
      languageForRequest('створи сторінку з фільмами у прокаті', 'ru-RU'),
    ).toBe('Ukrainian');
  });

  /**
   * Ровно случай пользователя: русская фраза с одной украинской буквой.
   * Одна такая буква это промах по клавише, а не смена языка, поэтому
   * решают слова, и ответ не зависит от опечатки.
   */
  it.each(['uk-UA', 'ru-RU'])(
    'опечатка в русской фразе языка не меняет, локаль %s',
    (locale) => {
      expect(
        languageForRequest(
          'создай страницу с фильмами которіе в прокате',
          locale,
        ),
      ).toBe('Russian');
    },
  );

  /**
   * Настоящий смешанный текст: признаки обоих языков в силе. Тут решает
   * локаль, потому что выбрать нечем.
   */
  it.each([
    ['uk-UA', 'Ukrainian'],
    ['ru-RU', 'Russian'],
  ])('по-настоящему смешанный текст решается локалью %s', (locale, expected) => {
    expect(
      languageForRequest('що це таке и что это такое, если або', locale),
    ).toBe(expected);
  });

  it('кириллица без различающих букв отдает решение локали', () => {
    expect(languageForRequest('привет как дела', 'uk-UA')).toBe('Ukrainian');
    expect(languageForRequest('привет как дела', 'ru-RU')).toBe('Russian');
  });

  it('текст без кириллицы решается локалью', () => {
    expect(languageForRequest('create a page with films', 'ru-RU')).toBe(
      'Russian',
    );
  });

  it('пустое сообщение решается локалью', () => {
    expect(languageForRequest('', 'de-DE')).toBe('German');
  });

  it('без локали язык по умолчанию', () => {
    expect(languageForRequest('hello', null)).toBe('English');
  });
});
