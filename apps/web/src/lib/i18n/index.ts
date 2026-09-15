/**
 * Перевод.
 *
 * Ключ — английская фраза, как в v1. Правило перенесено вместе со словарями:
 * тысяча девятьсот девяносто один ключ уже заведён именно так, и смена схемы
 * ключей означала бы переперевод всех двенадцати языков.
 *
 * **Словари лежат среди статики и загружаются по одному.** Так же в v1, и по
 * той же причине: каждый файл весит около мегабайта, а языков двенадцать.
 * Первая попытка держала их в графе модулей — сервер разработки исчерпал
 * четыре гигабайта памяти и упал, ещё не приняв ни одного запроса. Отдельным
 * файлом словарь ещё и кешируется браузером, а не переезжает в каждую сборку.
 *
 * Своя реализация, а не библиотека. Требований три: подстановка вида
 * `{{name}}`, формы множественного числа для славянских языков и запасной
 * язык. Первое и третье — десяток строк; второе ни одна из рассмотренных
 * библиотек не делает так, как уже заведено в словарях.
 */

export type Dictionary = Record<string, string>;

/** Язык, на который переводится всё, чего нет в остальных. */
export const FALLBACK_LOCALE = 'en-US';

/** Языки и их названия на них самих: список выбора читает человек. */
export const LOCALE_NAMES: Record<string, string> = {
  'de-DE': 'Deutsch',
  'en-US': 'English',
  'es-ES': 'Español',
  'fr-FR': 'Français',
  'it-IT': 'Italiano',
  'ja-JP': '日本語',
  'ko-KR': '한국어',
  'nl-NL': 'Nederlands',
  'pt-BR': 'Português',
  'ru-RU': 'Русский',
  'uk-UA': 'Українська',
  'zh-CN': '中文'
};

export const LOCALE_CODES = Object.keys(LOCALE_NAMES);

const loaded = new Map<string, Dictionary>();

/** Языки со славянскими формами числа: у них четыре формы вместо двух. */
const SLAVIC = new Set(['ru-RU', 'uk-UA']);

export type Values = Record<string, string | number>;

/**
 * Форма числа для языка.
 *
 * Английские правила простые: один и остальное. Славянские — три формы для
 * целых и четвёртая для дробных, и различие не косметическое: «1 страница»,
 * «2 страницы», «5 страниц», «1,5 страницы».
 */
export function pluralForm(locale: string, count: number): 'one' | 'few' | 'many' | 'other' {
  // Правила языка, а не самодельная арифметика: у дробного числа в русском и
  // украинском своя форма («1,5 дня»), а во французском и португальском ноль
  // стоит в единственном числе. Самодельный расчёт отдавал «через 1,5 дней» и
  // «0 fichiers traités».
  const category = new Intl.PluralRules(locale).select(count);
  if (SLAVIC.has(locale)) {
    return category === 'one' || category === 'few' || category === 'many' ? category : 'other';
  }
  // У остальных языков словарь держит две формы. Дробные и большие числа, у
  // которых язык знает свою категорию (`many` во французском), идут в `other`.
  return category === 'one' ? 'one' : 'other';
}

/** Подставить значения вида `{{name}}`. Неизвестное имя остаётся видимым. */
export function fill(template: string, values?: Values): string {
  if (!values) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole
  );
}

export function normalizeLocale(candidate: string | null | undefined): string {
  if (!candidate) return FALLBACK_LOCALE;
  if (candidate in LOCALE_NAMES) return candidate;
  // Браузер шлёт `ru`, `ru-BY`, `en-GB`. Язык важнее страны: перевод на
  // русский лучше английского запасного, даже если страна другая.
  const language = candidate.split('-')[0].toLowerCase();
  return (
    LOCALE_CODES.find((one) => one.split('-')[0].toLowerCase() === language) ?? FALLBACK_LOCALE
  );
}

/**
 * Загрузить словарь языка. Повторный вызов берёт уже загруженный.
 *
 * Загрузчик передаётся вызывающим: на сервере это `fetch` из загрузчика
 * маршрута, который умеет читать свою же статику без похода в сеть, в браузере
 * — обычный. Отказ загрузки не роняет страницу: ключи и есть английские фразы,
 * и без словаря интерфейс остаётся английским, а не пустым.
 */
export async function loadDictionary(
  candidate: string,
  fetcher: typeof fetch = fetch
): Promise<Dictionary> {
  const locale = normalizeLocale(candidate);
  const known = loaded.get(locale);
  if (known) return known;

  try {
    const response = await fetcher(`/locales/${locale}.json`);
    if (!response.ok) return {};
    const dictionary = (await response.json()) as Dictionary;
    loaded.set(locale, dictionary);
    return dictionary;
  } catch {
    return {};
  }
}

/**
 * Перевести ключ по загруженному словарю.
 *
 * Ненайденный ключ отдаётся как есть — он и есть английская фраза. Это не
 * заглушка, а свойство схемы: незаведённый ключ показывается по-английски, а
 * не пустотой, и это же делает загрузку словаря необязательной для отрисовки.
 */
export function translate(
  dictionary: Dictionary,
  locale: string,
  key: string,
  values?: Values
): string {
  if (values && typeof values.count === 'number') {
    const plural = `${key}_${pluralForm(normalizeLocale(locale), values.count)}`;
    const found = dictionary[plural];
    if (found) return fill(found, values);
  }
  return fill(dictionary[key] ?? key, values);
}

/** Переводчик, привязанный к языку и словарю. Разметка зовёт его одним ключом. */
export function translator(dictionary: Dictionary, locale: string) {
  return (key: string, values?: Values) => translate(dictionary, locale, key, values);
}
