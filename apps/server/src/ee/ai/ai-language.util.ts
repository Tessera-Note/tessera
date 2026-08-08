/**
 * Model prompts name the target language in plain English rather than passing a
 * locale code, which models handle inconsistently.
 */
const LANGUAGE_NAMES: Record<string, string> = {
  'de-DE': 'German',
  'en-US': 'English',
  'es-ES': 'Spanish',
  'fr-FR': 'French',
  'it-IT': 'Italian',
  'ja-JP': 'Japanese',
  'ko-KR': 'Korean',
  'nl-NL': 'Dutch',
  'pt-BR': 'Brazilian Portuguese (pt-BR)',
  'ru-RU': 'Russian',
  'uk-UA': 'Ukrainian',
  'zh-CN': 'Simplified Chinese',
};

/**
 * Язык ответов агента при незаданной локали пользователя.
 *
 * Был португальский — наследие форка, а не решение продукта: локаль
 * интерфейса тут ни при чем, а `insertUser` ставит новым учетным записям
 * `en-US`. Отдельного списка языков для агента не заводится, язык берется
 * из той же локали пользователя через `languageFromLocale`.
 */
export const DEFAULT_AI_LANGUAGE = LANGUAGE_NAMES['en-US'];

/**
 * Shown when the permission system refuses an edit the model announced. Written
 * server-side rather than left to the model, which cannot be trusted to report
 * a failure it does not know about mid-response.
 */
export type EditRefusalKind = 'bad-reference' | 'not-found' | 'forbidden';

/**
 * Причина отказа называется точно.
 *
 * Общий текст «страницы нет или нет прав» отправлял человека проверять права
 * у страницы, которая существует и открыта всем: настоящей причиной был
 * формат идентификатора. Ложный след стоит дороже, чем отсутствие подсказки.
 */
export function editRefusalNotice(
  locale: string | null | undefined,
  count: number,
  kinds: EditRefusalKind[] = [],
): string {
  // Язык берется у пользователя, а по умолчанию английский, а не
  // португальский. `insertUser` ставит новым учетным записям `en-US`, и
  // отказ, приходивший на португальском при незаданной локали, к языку
  // интерфейса отношения не имел.
  const isPortuguese = (locale ?? 'en-US').toLowerCase().startsWith('pt');
  const unique = [...new Set(kinds)];
  const single = unique.length === 1 ? unique[0] : undefined;

  const reason = (() => {
    if (isPortuguese) {
      switch (single) {
        case 'bad-reference':
          return 'não foi possível identificar a página a partir do que foi informado. Envie o endereço da página no navegador.';
        case 'not-found':
          return 'a página não existe neste workspace.';
        case 'forbidden':
          return 'você não tem permissão para editá-la.';
        default:
          return 'a página não existe neste workspace ou você não tem permissão para editá-la.';
      }
    }

    switch (single) {
      case 'bad-reference':
        return 'the page could not be identified from what was provided. Send the page address from your browser.';
      case 'not-found':
        return 'the page does not exist in this workspace.';
      case 'forbidden':
        return 'you do not have permission to edit it.';
      default:
        return 'the page does not exist in this workspace, or you do not have permission to edit it.';
    }
  })();

  if (isPortuguese) {
    return count === 1
      ? `> [!WARNING]\n> A edição descrita acima **não foi aplicada**: ${reason}`
      : `> [!WARNING]\n> ${count} edições descritas acima **não foram aplicadas**: ${reason}`;
  }

  return count === 1
    ? `> [!WARNING]\n> The edit described above **was not applied**: ${reason}`
    : `> [!WARNING]\n> ${count} edits described above **were not applied**: ${reason}`;
}

export function languageFromLocale(locale?: string | null): string {
  if (!locale) return DEFAULT_AI_LANGUAGE;

  const exact = LANGUAGE_NAMES[locale];
  if (exact) return exact;

  // Tolerate a bare language tag such as `pt` or an unexpected region.
  const base = locale.split(/[-_]/)[0]?.toLowerCase();
  const match = Object.entries(LANGUAGE_NAMES).find(([key]) =>
    key.toLowerCase().startsWith(`${base}-`),
  );

  return match ? match[1] : DEFAULT_AI_LANGUAGE;
}
