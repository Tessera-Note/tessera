/**
 * Выбранный язык и его словарь.
 *
 * Словарь держится здесь, а не загружается каждым экраном: он один на
 * страницу, и второй его загрузчик означал бы второй мегабайт в памяти.
 */

import { FALLBACK_LOCALE, loadDictionary, normalizeLocale, translator } from '$lib/i18n';
import type { Dictionary } from '$lib/i18n';

class LocaleStore {
  current = $state<string>(FALLBACK_LOCALE);
  dictionary = $state<Dictionary>({});

  /** Поставить язык и словарь. Словарь загружает вызывающий: загрузка ждётся. */
  apply(locale: string, dictionary: Dictionary) {
    this.current = normalizeLocale(locale);
    this.dictionary = dictionary;
    if (typeof document !== 'undefined') {
      // Язык страницы отвечает выбранному: без него проверка доступности и
      // перенос слов читают русский текст английскими правилами.
      document.documentElement.lang = this.current;
    }
  }

  /** Сменить язык на лету. Словарь подгружается своим файлом. */
  async set(candidate: string | null | undefined) {
    const locale = normalizeLocale(candidate);
    this.apply(locale, await loadDictionary(locale));
  }

  get t() {
    return translator(this.dictionary, this.current);
  }
}

export const locale = new LocaleStore();
