import { loadDictionary, normalizeLocale } from '$lib/i18n';
import type { LayoutLoad } from './$types';

/**
 * Язык и словарь до первой отрисовки.
 *
 * Загрузка здесь, а не в разметке: словарь, подгруженный после отрисовки, даёт
 * вспышку английского текста на экране человека, который его не читает.
 *
 * Загрузчик общий для сервера и браузера: на сервере словарь берётся из
 * сборки, в браузере — своим куском, и обе стороны получают один и тот же
 * набор строк.
 */
export const load: LayoutLoad = async ({ data, fetch }) => {
  const locale = normalizeLocale(data?.session?.user.locale ?? browserLocale());
  return { ...data, locale, dictionary: await loadDictionary(locale, fetch) };
};

function browserLocale(): string | null {
  return typeof navigator === 'undefined' ? null : navigator.language;
}
