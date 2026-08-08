import {
  DEFAULT_AI_LANGUAGE,
  editRefusalNotice,
  languageFromLocale,
} from './ai-language.util';

describe('languageFromLocale', () => {
  it('maps a supported locale to its language name', () => {
    expect(languageFromLocale('pt-BR')).toBe('Brazilian Portuguese (pt-BR)');
    expect(languageFromLocale('en-US')).toBe('English');
    expect(languageFromLocale('ja-JP')).toBe('Japanese');
  });

  it('falls back to Portuguese when the user has no locale', () => {
    expect(languageFromLocale(null)).toBe(DEFAULT_AI_LANGUAGE);
    expect(languageFromLocale(undefined)).toBe(DEFAULT_AI_LANGUAGE);
    expect(languageFromLocale('')).toBe(DEFAULT_AI_LANGUAGE);
  });

  it('tolerates a bare or unexpected region tag', () => {
    expect(languageFromLocale('pt')).toBe('Brazilian Portuguese (pt-BR)');
    expect(languageFromLocale('pt_PT')).toBe('Brazilian Portuguese (pt-BR)');
    expect(languageFromLocale('en-GB')).toBe('English');
  });

  it('falls back rather than passing an unknown language through', () => {
    expect(languageFromLocale('xx-YY')).toBe(DEFAULT_AI_LANGUAGE);
  });
});

describe('editRefusalNotice', () => {
  it('writes in Portuguese for pt locales', () => {
    expect(editRefusalNotice('pt-BR', 1)).toContain('não foi aplicada');
    expect(editRefusalNotice('pt', 1)).toContain('não foi aplicada');
  });

  /**
   * Незаданная локаль это не португальский. `insertUser` ставит новым
   * учетным записям `en-US`, и отказ на португальском к языку интерфейса
   * отношения не имел.
   */
  it('без локали пишет по-английски', () => {
    expect(editRefusalNotice(null, 1)).toContain('was not applied');
    expect(editRefusalNotice(undefined, 1)).toContain('was not applied');
  });

  it('writes in English for other locales', () => {
    expect(editRefusalNotice('en-US', 1)).toContain('was not applied');
  });

  it('pluralises and reports the count', () => {
    const notice = editRefusalNotice('pt-BR', 3);
    expect(notice).toContain('3 edições');
    expect(notice).toContain('não foram aplicadas');
  });

  it('renders as a warning callout the editor understands', () => {
    expect(editRefusalNotice('pt-BR', 1).startsWith('> [!WARNING]')).toBe(true);
  });
});
