/**
 * Правила словарей, а не их текущее состояние.
 *
 * Перенесены из первой версии вместе с поводом: там
 * три расхождения жили в словарях незамеченными — синтаксис ICU, который
 * показывается человеку буквально со скобками; отсутствующие формы `few` и
 * `many` у русского и украинского, из-за которых три числа из четырёх
 * проваливались в английский; и ключи, живущие в коде, но не заведённые в
 * источнике, откуда их забирает переводчик.
 *
 * Проверяются именно правила, а не числа: числа меняются с каждой строкой
 * интерфейса, правила — нет.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FALLBACK_LOCALE, LOCALE_NAMES, pluralForm, translate } from './index';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = join(HERE, '..', '..', '..', 'static', 'locales');
const CODE_DIR = join(HERE, '..', '..');

/** Языки со своими переводами. Остальные ведёт переводчик из источника. */
const MAINTAINED = ['ru-RU', 'uk-UA'];

/** Категории, которые правила языка дают русскому и украинскому. */
const SLAVIC_FORMS = ['one', 'few', 'many', 'other'];

const ICU_SYNTAX = /\{\s*\w+\s*,\s*(plural|select|selectordinal)\s*,/;
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/**
 * Код, который выводит тексты или отдаёт коды отказов: экраны, приложение с
 * письмами, служба редактирования, внутренний сервис, расширения редактора.
 * Проверки и документация сюда не входят — ключ, нужный только им, человеку не
 * нужен.
 */
const REPO_DIR = join(HERE, '..', '..', '..', '..', '..');
const USAGE_ROOTS = [
  'apps/web/src',
  'apps/api/tessera_api',
  'services/collab/src',
  'services/hub',
  'packages/editor-ext/src'
];
const USAGE_FILE = /\.(ts|tsx|svelte|js|mjs|py|html|jinja|j2|txt)$/;
const SKIPPED_DIRS = new Set([
  'node_modules',
  '__pycache__',
  '.venv',
  'dist',
  'build',
  '.svelte-kit',
  'tests'
]);

function usageFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) found.push(...usageFiles(join(dir, entry.name)));
      continue;
    }
    const name = entry.name;
    if (!USAGE_FILE.test(name) || name.includes('.test.') || name.startsWith('test_')) continue;
    found.push(join(dir, name));
  }
  return found;
}

/**
 * Строка без подстановок: `{{name}}` вырезается перед проверкой скобок.
 *
 * Иначе любая законная подстановка выглядит как обрывок разметки.
 */
const WITHOUT_PLACEHOLDERS = /\{\{[^}]*\}\}/g;

/**
 * Непарная скобка в значении: след разметки самого файла словаря.
 *
 * Считается парность, а не положение. Скобки в тексте законны и встречаются:
 * `[max: 50]` в подсказке про адреса, пример `{ "key": value }` в сообщении
 * MCP, — но там они парные. Обрывок слияния всегда непарный: в форке таких
 * нашлось семь, в двух видах — хвост `},{` у шести языков и одиночная `{` у
 * китайского.
 */
function unbalanced(value: string): boolean {
  const text = value.replace(WITHOUT_PLACEHOLDERS, '');
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']']
  ]) {
    let depth = 0;
    for (const character of text) {
      if (character === open) depth += 1;
      else if (character === close) depth -= 1;
      if (depth < 0) return true;
    }
    if (depth !== 0) return true;
  }
  return false;
}

function readLocale(locale: string): Record<string, string> {
  return JSON.parse(readFileSync(join(SOURCE_DIR, `${locale}.json`), 'utf8'));
}

const locales = readdirSync(SOURCE_DIR)
  .filter((one) => one.endsWith('.json'))
  .map((one) => one.replace('.json', ''))
  .sort();

const source = readLocale(FALLBACK_LOCALE);

function names(text: string): Set<string> {
  return new Set((text.match(/\{\{(\w+)\}\}/g) ?? []).map((one) => one.slice(2, -2)));
}

/** Все файлы кода, где может встретиться обращение к переводу. */
function codeFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...codeFiles(full));
    } else if (/\.(svelte|ts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Наборы подписей, которые человек видит рядом друг с другом.
 *
 * Внутри набора перевод обязан различать их. Совпадение не ломает ничего
 * машинно и потому живёт долго: во французском `Table` и `Board` были оба
 * «Tableau», и переключатель представлений базы предлагал два одинаковых
 * пункта, из которых один вёл в таблицу, а другой в канбан.
 */
const SIDE_BY_SIDE: Record<string, string[]> = {
  'представления базы': ['Table', 'Board', 'Calendar']
};

describe('подписи в одном наборе различимы', () => {
  it.each(locales)('%s', (locale) => {
    const dictionary = readLocale(locale);
    for (const [what, keys] of Object.entries(SIDE_BY_SIDE)) {
      const shown = keys.map((key) => dictionary[key] ?? key);
      expect(new Set(shown).size, `${what}: ${shown.join(', ')}`).toBe(keys.length);
    }
  });
});

describe('состав словарей', () => {
  it('локали на месте', () => {
    expect(locales).toContain(FALLBACK_LOCALE);
    expect(locales.length).toBeGreaterThanOrEqual(12);
  });

  it('перечень в коде совпадает с файлами', () => {
    expect(Object.keys(LOCALE_NAMES).sort()).toEqual(locales);
  });

  it('у каждого языка есть название на нём самом', () => {
    // Список языков показывается человеку, который своего в нём не найдёт,
    // если названия нет.
    expect(Object.keys(LOCALE_NAMES).sort()).toEqual(locales);
  });

  it.each(locales)('%s разбирается и не содержит пустых значений', (locale) => {
    const dictionary = readLocale(locale);
    expect(Object.keys(dictionary).length).toBeGreaterThan(0);
    expect(Object.entries(dictionary).filter(([, value]) => !String(value).trim())).toEqual([]);
  });

  it.each(locales)('%s не содержит синтаксиса ICU', (locale) => {
    // Разбора ICU здесь нет и не будет: это была бы новая зависимость. Значение
    // в таком синтаксисе человек видит буквально, со скобками и невставленным
    // счётчиком.
    const dictionary = readLocale(locale);
    const icu = Object.entries(dictionary)
      .filter(([, value]) => ICU_SYNTAX.test(String(value)))
      .map(([key]) => key);
    expect(icu).toEqual([]);
  });

  it.each(locales)('%s не теряет подстановок источника', (locale) => {
    // Потерянная подстановка это потерянное на экране значение: имя, число,
    // срок. Лишняя допустима только у счётчика: он передаётся всегда, когда
    // ключ разбирается по формам числа.
    const dictionary = readLocale(locale);
    const broken = Object.keys(dictionary)
      .filter((key) => key in source)
      .filter((key) => {
        const expected = names(String(source[key]));
        const actual = names(String(dictionary[key]));
        const lost = [...expected].filter((one) => !actual.has(one));
        const extra = [...actual].filter((one) => !expected.has(one) && one !== 'count');
        return lost.length > 0 || extra.length > 0;
      });
    expect(broken).toEqual([]);
  });

  it.each(locales)('%s не содержит обрывков разметки файла', (locale) => {
    // Семь словарей форка несли на краю значения обрывок разметки: у шести
    // хвост `},{`, у китайского одиночная `{`. Разбору JSON это не мешает, и
    // заметить такое можно только на экране, где хвост стоит прямо в
    // заголовке раздела.
    const dictionary = readLocale(locale);
    const broken = Object.entries(dictionary)
      .filter(([, value]) => unbalanced(String(value)))
      .map(([key]) => key);
    expect(broken).toEqual([]);
  });

  it.each(MAINTAINED)('%s имеет формы few и many у плюральных основ', (locale) => {
    // Когда нужной формы нет, перевод падает на основу, а она написана под
    // одну форму: три числа из четырёх выглядят неграмотно.
    const dictionary = readLocale(locale);
    const stems = new Set(
      Object.keys(source)
        .filter((key) => PLURAL_SUFFIX.test(key))
        .map((key) => key.replace(PLURAL_SUFFIX, ''))
    );
    const incomplete = [...stems].filter((stem) =>
      SLAVIC_FORMS.some((form) => !(`${stem}_${form}` in dictionary))
    );
    expect(incomplete).toEqual([]);
  });

  it('каждый ключ из кода заведён в источнике', () => {
    // Ключ и есть английская фраза, поэтому отсутствие в источнике не ломает
    // английский интерфейс, и заметить его можно только такой проверкой. Но к
    // переводчику такая строка не попадает и не переводится ни на один язык.
    const used = new Set<string>();
    const call = /\bt\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g;

    for (const file of codeFiles(CODE_DIR)) {
      if (file.endsWith('.test.ts')) continue;
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(call)) {
        used.add(match[2].replace(/\\"/g, '"').replace(/\\'/g, "'"));
      }
    }

    const missing = [...used].filter(
      (key) => !(key in source) && !SLAVIC_FORMS.some((form) => `${key}_${form}` in source)
    );
    expect(missing).toEqual([]);
  });

  it('подписи из описей заведены в источнике', () => {
    // Второй способ попадания ключа в перевод: не `t('текст')`, а `t(one.label)`
    // — подпись берётся из описи в службе. Правило выше их не видит, потому что
    // ищет вызовы, и пять таких ключей жили в русском и украинском, минуя
    // источник: переводчик их не получал, а девять локалей показывали
    // английский.
    //
    // Описи живут и в компонентах, не только в службах: палитра цвета статуса
    // и виды выноски объявлены прямо в `.svelte`. Поэтому разбор идёт по всем
    // файлам, а поле опознаётся в любом месте строки — в описи из трёх полей
    // подпись стоит не первой.
    const fields = /(?:^|[{,\s])(?:label|hint|name)\s*:\s*'((?:[^'\\]|\\.)+)'/gm;

    const used = new Set<string>();
    for (const file of codeFiles(CODE_DIR)) {
      if (file.endsWith('.test.ts')) continue;
      for (const match of readFileSync(file, 'utf8').matchAll(fields)) {
        const value = match[1].replace(/\\'/g, "'");
        // Служебные значения без букв подписью не бывают.
        if (/[A-Za-z]/.test(value)) used.add(value);
      }
    }

    // Имя расширения редактора это `name: 'autoJoiner'` — тоже поле `name`, но
    // не подпись: подпись в этом коде всегда английская фраза с заглавной, а
    // имя узла или расширения всегда одно слово со строчной.
    const phrase = (key: string) => !/^[a-z]/.test(key);

    const missing = [...used].filter((key) => phrase(key) && !(key in source));
    expect(missing.sort()).toEqual([]);
  });

  it('проверка подписей из описей что-то находит', () => {
    // Опора предыдущей: пустое множество подтверждало бы полноту на пустоте.
    const fields = /(?:^|[{,\s])(?:label|hint|name)\s*:\s*'((?:[^'\\]|\\.)+)'/gm;

    let found = 0;
    for (const file of codeFiles(CODE_DIR)) {
      if (file.endsWith('.test.ts')) continue;
      found += [...readFileSync(file, 'utf8').matchAll(fields)].length;
    }
    expect(found).toBeGreaterThan(30);
  });

  it('проверка ключей из кода что-то находит', () => {
    // Опора предыдущей проверки: пустое множество ключей дало бы зелёный
    // результат на пустоте, то есть подтверждало бы, что ничего не потеряно,
    // потому что нечего терять.
    const call = /\bt\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g;
    let count = 0;
    for (const file of codeFiles(CODE_DIR)) {
      if (file.endsWith('.test.ts')) continue;
      count += [...readFileSync(file, 'utf8').matchAll(call)].length;
    }
    expect(count).toBeGreaterThan(5);
  });

  /**
   * Нужен ли ключ коду из свода `corpus`.
   *
   * Ключ ищется целой строкой в кавычках, а не куском: кусок находил «Print» в
   * `IconPrinter` и «Action» в `BlockActions`, и лишний ключ проходил. Ключ-слово
   * со строчной буквы (`member`, `days`) совпадает со значениями в коде — ролью,
   * единицей срока, — поэтому засчитывается только в вызове перевода. Коды с
   * точкой (`error.*`) приходят с сервера строкой и под это правило не попадают.
   */
  /** Хвост кода перед ключом, когда ключ стоит доводом перевода. */
  const CALL_BEFORE = /\b(?:t|translate)\(\s*$/;

  const usedKey = (corpus: string, key: string) => {
    const word = /^[a-z]/.test(key) && !key.includes('.');
    for (const mark of ["'", '"', '`']) {
      // Ключ с кавычкой внутри записан в коде с обратной косой: `'Don\'t'`.
      const literal = mark + key.split(mark).join(`\\${mark}`) + mark;
      for (let at = corpus.indexOf(literal); at !== -1; at = corpus.indexOf(literal, at + 1)) {
        if (!word || CALL_BEFORE.test(corpus.slice(Math.max(0, at - 40), at))) return true;
      }
    }
    return false;
  };

  it('каждый ключ источника нужен коду', () => {
    // Обратная сторона правила «каждый ключ из кода заведён в источнике».
    // Ключ, которого код не выводит, копится молча: так в словарях второй
    // версии оказалось больше тысячи строк первой. Ключ ищется строкой во всём
    // коде, который выводит тексты или отдаёт коды отказов, для форм числа —
    // по основе. Строка находится и там, где ключ передаётся через опись или
    // приходит кодом отказа с сервера: и то и другое в коде записано строкой.
    const corpus = USAGE_ROOTS.flatMap((root) => usageFiles(join(REPO_DIR, root)))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    const stems = [...new Set(Object.keys(source).map((key) => key.replace(PLURAL_SUFFIX, '')))];
    const unused = stems.filter((stem) => !usedKey(corpus, stem));
    expect(unused.sort()).toEqual([]);
  });

  it('обратная сверка не засчитывает кусок чужой строки', () => {
    expect(usedKey('<IconPrinter />', 'Print')).toBe(false);
    expect(usedKey("t('Print PDF')", 'Print')).toBe(false);
    expect(usedKey("t('Print')", 'Print')).toBe(true);
    expect(usedKey("label: 'Print'", 'Print')).toBe(true);
    expect(usedKey('"error.page.page_not_found"', 'error.page.page_not_found')).toBe(true);
  });

  it('ключ-слово засчитывается только в вызове перевода', () => {
    expect(usedKey("role === 'member'", 'member')).toBe(false);
    expect(usedKey("t('member')", 'member')).toBe(true);
    expect(usedKey("{t(\n  'not searchable'\n)}", 'not searchable')).toBe(true);
    // Редактор переводит подписи своих блоков вторым именем того же вызова.
    expect(usedKey("needs.translate('days')", 'days')).toBe(true);
    // Ключ с точкой — не слово, хоть и со строчной: пример адреса в подсказке.
    expect(usedKey("placeholder: 'e.g Sales'", 'e.g Sales')).toBe(true);
  });

  it('кавычка внутри ключа не прячет его от сверки', () => {
    // В коде такой ключ записан с обратной косой, а в словаре — без неё.
    expect(usedKey("t('Don\\'t show again')", "Don't show again")).toBe(true);
    expect(usedKey('t("Don\'t show again")', "Don't show again")).toBe(true);
  });

  it('обратная сверка видит код приложения и экранов', () => {
    // Опора предыдущей: пустой свод кода нашёл бы каждый ключ «лишним», а свод
    // без приложения — все коды отказов. Проверяется, что в своде есть и то и
    // другое.
    const corpus = USAGE_ROOTS.flatMap((root) => usageFiles(join(REPO_DIR, root)))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    expect(corpus).toContain("t('Tabs: {{count}}'");
    expect(corpus).toContain('error.page.page_not_found');
  });
});

describe('формы числа', () => {
  it('английский различает один и остальное', () => {
    expect(pluralForm('en-US', 1)).toBe('one');
    expect(pluralForm('en-US', 2)).toBe('other');
    expect(pluralForm('en-US', 21)).toBe('other');
  });

  it('славянские языки различают три формы', () => {
    // «1 страница», «2 страницы», «5 страниц» — три разных слова.
    expect(pluralForm('ru-RU', 1)).toBe('one');
    expect(pluralForm('ru-RU', 2)).toBe('few');
    expect(pluralForm('ru-RU', 5)).toBe('many');
  });

  it('одиннадцать и двенадцать не единственное число', () => {
    // Ловушка правил: по последней цифре 11 выглядит как 1.
    expect(pluralForm('ru-RU', 11)).toBe('many');
    expect(pluralForm('ru-RU', 12)).toBe('many');
    expect(pluralForm('uk-UA', 111)).toBe('many');
  });

  it('двадцать один снова единственное', () => {
    expect(pluralForm('ru-RU', 21)).toBe('one');
    expect(pluralForm('ru-RU', 22)).toBe('few');
  });

  it('дробное число в славянских языках идёт в свою форму', () => {
    // «1,5 дня», а не «1,5 дней»: срок корзины принимает дробь.
    expect(pluralForm('ru-RU', 1.5)).toBe('other');
    expect(pluralForm('uk-UA', 2.5)).toBe('other');
    expect(pluralForm('ru-RU', 0)).toBe('many');
  });

  it('ноль во французском и португальском — единственное число', () => {
    expect(pluralForm('fr-FR', 0)).toBe('one');
    expect(pluralForm('pt-BR', 0)).toBe('one');
    expect(pluralForm('en-US', 0)).toBe('other');
    expect(pluralForm('de-DE', 0)).toBe('other');
  });

  it('категории вне двух форм идут в остальное', () => {
    // Французский знает `many` для миллионов, японский не знает `one` вовсе;
    // словарь держит у них только `_one` и `_other`.
    expect(pluralForm('fr-FR', 1_000_000)).toBe('other');
    expect(pluralForm('ja-JP', 1)).toBe('other');
    expect(pluralForm('en-US', 1.5)).toBe('other');
  });
});

describe('перевод', () => {
  const russian = readLocale('ru-RU');

  it('срок корзины с дробным числом согласован', () => {
    const key = 'Pages in trash will be permanently deleted after {{count}} days.';
    expect(translate(russian, 'ru-RU', key, { count: 1.5 })).toBe(
      'Страницы в корзине будут окончательно удалены через 1.5 дня.'
    );
    expect(translate(russian, 'ru-RU', key, { count: 5 })).toBe(
      'Страницы в корзине будут окончательно удалены через 5 дней.'
    );
  });

  it('неизвестный ключ отдаётся как есть', () => {
    // Ключ и есть английская фраза: незаведённый показывается по-английски, а
    // не пустотой.
    expect(translate(russian, 'ru-RU', 'Совершенно новый ключ')).toBe('Совершенно новый ключ');
  });

  it('подстановка работает', () => {
    expect(translate(source, 'en-US', '{{name}} invited you', { name: 'Анна' })).toContain('Анна');
  });

  it('неизвестная подстановка остаётся видимой', () => {
    // Пустота на её месте выглядит готовым текстом, и ошибку никто не заметит;
    // оставленная подстановка видна сразу.
    expect(translate(source, 'en-US', 'Здравствуйте, {{name}}')).toContain('{{name}}');
  });

  it('форма числа выбирается по значению', () => {
    const key = Object.keys(source).find((one) => one.endsWith('_many') || one.endsWith('_other'));
    expect(key, 'в источнике нет ни одной формы множественного числа').toBeDefined();

    const stem = key!.replace(PLURAL_SUFFIX, '');
    expect(translate(russian, 'ru-RU', stem, { count: 5 })).not.toBe(
      translate(russian, 'ru-RU', stem, { count: 1 })
    );
  });

  it('близкий язык берёт формы своего языка', () => {
    // Браузер шлёт `ru-BY`: формы числа у него славянские, а не английские.
    expect(pluralForm('ru-RU', 3)).toBe('few');
  });
});
