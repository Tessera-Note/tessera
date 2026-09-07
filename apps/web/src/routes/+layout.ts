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
export const load: LayoutLoad = async ({ data, url, fetch }) => {
  // Довод адреса — для листа печати: у браузера печати нет ни входа, ни куки,
  // и без этого подписи от приложения уходят на лист по-английски. Для
  // остальных экранов его нет, и язык берётся у человека.
  const wanted = data?.session?.user.locale ?? url.searchParams.get('locale') ?? browserLocale();
  const locale = normalizeLocale(wanted);
  return { ...data, locale, dictionary: await loadDictionary(locale, fetch) };
};

function browserLocale(): string | null {
  return typeof navigator === 'undefined' ? null : navigator.language;
}
