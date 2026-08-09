import {
  DEFAULT_MAIL_LOCALE,
  MAIL_LOCALES,
  MAIL_TEXT_KEYS,
  mailText,
  mailTextRaw,
} from './mail-text';

/**
 * Письма собираются на сервере, где i18next клиента недоступен, а новая
 * зависимость в рантайме запрещена. Каталог свой, и держится он на трех
 * правилах: неизвестный язык дает английский, подстановки заполняются, ключ
 * есть во всех ведущихся языках.
 */
describe('Тексты писем', () => {
  it('язык получателя выбирает свой текст', () => {
    expect(mailText('ru-RU', 'mail.action.open_page')).toBe('Открыть страницу');
    expect(mailText('uk-UA', 'mail.action.open_page')).toBe(
      'Відкрити сторінку',
    );
    expect(mailText('en-US', 'mail.action.open_page')).toBe('Open page');
  });

  /** Локалей двенадцать, а ведется три: остальным понятный английский. */
  it.each([['de-DE'], ['ja-JP'], ['неизвестно'], [null], [undefined]])(
    'язык %s дает английский',
    (locale) => {
      expect(mailText(locale as any, 'mail.action.open_page')).toBe(
        'Open page',
      );
    },
  );

  it('подстановки заполняются на каждом языке', () => {
    for (const locale of MAIL_LOCALES) {
      const text = mailText(locale, 'mail.page_mention.body', {
        actor: 'Иван',
        page: 'Инструкция',
      });

      expect(text).toContain('Иван');
      expect(text).toContain('Инструкция');
      expect(text).not.toContain('{{');
    }
  });

  it('незаполненная подстановка остается видимой', () => {
    expect(
      mailText('en-US', 'mail.page_mention.body', { actor: 'Иван' }),
    ).toContain('{{page}}');
  });

  /**
   * Ключ, заведенный не во всех языках, дает письмо вперемешку: часть строк
   * переведена, часть нет. Заметить это можно только такой проверкой.
   */
  it.each(MAIL_LOCALES)('%s содержит все ключи каталога', (locale) => {
    const missing = MAIL_TEXT_KEYS.filter(
      (key) => !mailTextRaw(locale, key)?.trim(),
    );

    expect(missing).toEqual([]);
  });

  it('подстановки одинаковы во всех языках', () => {
    const names = (text: string) =>
      (text.match(/\{\{(\w+)\}\}/g) ?? []).sort().join(',');

    const mismatched = MAIL_TEXT_KEYS.filter((key) =>
      MAIL_LOCALES.some(
        (locale) =>
          names(mailTextRaw(locale, key) ?? '') !==
          names(mailTextRaw(DEFAULT_MAIL_LOCALE, key) ?? ''),
      ),
    );

    expect(mismatched).toEqual([]);
  });
});
