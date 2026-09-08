/**
 * Выбранный язык и его словарь.
 *
 * Словарь держится здесь, а не загружается каждым экраном: он один на
 * страницу, и второй его загрузчик означал бы второй мегабайт в памяти.
 */

import { setMediaErrorLabels } from '@tessera/editor-ext';
import { FALLBACK_LOCALE, loadDictionary, normalizeLocale, translator } from '$lib/i18n';
import type { Dictionary } from '$lib/i18n';

class LocaleStore {
  current = $state<string>(FALLBACK_LOCALE);
  dictionary = $state<Dictionary>({});

  /**
   * Поставить язык и словарь. Словарь загружает вызывающий: загрузка ждётся.
   *
   * **Записанное здесь не перечитывается.** Вызывают этот метод из эффекта
   * слоя, а эффект, прочитавший то, что сам записал, подписывается на
   * собственную запись: Svelte считает это бесконечным обновлением и снимает
   * всю ветвь эффектов. Снимается она молча, вместе со всем деревом ниже, и
   * приложение остаётся с той разметкой, что была на первой отрисовке.
   */
  apply(locale: string, dictionary: Dictionary) {
    const wanted = normalizeLocale(locale);
    this.current = wanted;
    this.dictionary = dictionary;
    if (typeof document !== 'undefined') {
      // Язык страницы отвечает выбранному: без него проверка доступности и
      // перенос слов читают русский текст английскими правилами.
      document.documentElement.lang = wanted;
    }
    this.#publishMediaErrors(dictionary, wanted);
  }

  /**
   * Отдать общему пакету подписи отказов при загрузке файла.
   *
   * Пакет общий с v1, словаря он не знает и держит подписи в своей
   * переменной. Без этой передачи отказ «файл не открылся» всегда
   * показывается по-английски, на каком бы языке ни была вики.
   *
   * Словарь и язык приходят доводами, а не берутся из полей: см. `apply`.
   */
  #publishMediaErrors(dictionary: Dictionary, locale: string) {
    const t = translator(dictionary, locale);
    setMediaErrorLabels({
      missing: t('This file no longer exists. It may have been deleted.'),
      forbidden: t("You don't have access to this file."),
      failed: t('Failed to load this file.')
    });
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
