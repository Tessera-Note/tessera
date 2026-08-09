import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * Правила словарей, а не их текущее состояние.
 *
 * Три расхождения жили в словарях незамеченными: значения в синтаксисе ICU,
 * который i18next без плагина выводит буквально фигурными скобками; формы few
 * и many у русского и украинского, из-за отсутствия которых count=3 и count=7
 * проваливались в английский; и ключи, используемые в коде, но не заведенные в
 * en-US, откуда их забирает Crowdin.
 *
 * Проверка ловит именно возвращение этих трех, а не фиксирует числа: числа
 * меняются с каждой строкой интерфейса, правила нет.
 */
const LOCALES_DIR = path.resolve(__dirname, "../public/locales");
const SOURCE = "en-US";

/** Языки со своими переводами. Остальные ведет Crowdin из источника. */
const MAINTAINED = ["ru-RU", "uk-UA"];

/** Категории, которые Intl.PluralRules дает русскому и украинскому. */
const SLAVIC_FORMS = ["one", "few", "many", "other"];

const ICU_SYNTAX = /\{\s*\w+\s*,\s*(plural|select|selectordinal)\s*,/;
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

function readLocale(locale: string): Record<string, string> {
  return JSON.parse(
    fs.readFileSync(path.join(LOCALES_DIR, locale, "translation.json"), "utf8"),
  );
}

const locales = fs.readdirSync(LOCALES_DIR).sort();
const source = readLocale(SOURCE);

describe("словари i18next", () => {
  it("локали на месте", () => {
    expect(locales).toContain(SOURCE);
    expect(locales.length).toBeGreaterThanOrEqual(12);
  });

  it.each(locales)("%s разбирается и не содержит пустых значений", (locale) => {
    const dict = readLocale(locale);

    expect(Object.keys(dict).length).toBeGreaterThan(0);
    expect(Object.entries(dict).filter(([, v]) => !String(v).trim())).toEqual(
      [],
    );
  });

  /**
   * Плагина i18next-icu в проекте нет, и добавлять его нельзя: новая
   * зависимость в рантайме запрещена. Значение в синтаксисе ICU человек видит
   * буквально, вместе со скобками и невставленным счетчиком.
   */
  it.each(locales)("%s не содержит синтаксиса ICU", (locale) => {
    const dict = readLocale(locale);
    const icu = Object.entries(dict)
      .filter(([, value]) => ICU_SYNTAX.test(String(value)))
      .map(([key]) => key);

    expect(icu).toEqual([]);
  });

  /**
   * Потерянная в переводе подстановка это потерянное на экране значение:
   * имя, число, срок. Лишняя подстановка допустима только у счетчика, он
   * передается всегда, когда ключ разбирается по формам числа.
   */
  it.each(locales)("%s не теряет подстановок источника", (locale) => {
    const dict = readLocale(locale);
    const names = (s: string) =>
      new Set((s.match(/\{\{(\w+)\}\}/g) ?? []).map((m) => m.slice(2, -2)));

    const broken = Object.keys(dict)
      .filter((key) => key in source)
      .filter((key) => {
        const expected = names(String(source[key]));
        const actual = names(String(dict[key]));
        const lost = [...expected].filter((name) => !actual.has(name));
        const extra = [...actual].filter(
          (name) => !expected.has(name) && name !== "count",
        );
        return lost.length > 0 || extra.length > 0;
      });

    expect(broken).toEqual([]);
  });

  /**
   * Ключ и есть английская фраза, поэтому отсутствие в источнике не ломает
   * английский интерфейс, и заметить его можно только такой проверкой. Но в
   * Crowdin такая строка не попадает и не переводится ни на один язык.
   */
  it("каждый ключ из кода заведен в источнике", () => {
    const srcDir = path.resolve(__dirname);
    const used = new Set<string>();
    const call = /\bt\(\s*(["'])((?:\\.|(?!\1).)*)\1/g;

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (
          /\.tsx?$/.test(entry.name) &&
          !entry.name.endsWith(".d.ts")
        ) {
          const text = fs.readFileSync(full, "utf8");
          for (const match of text.matchAll(call)) {
            used.add(match[2].replace(/\\"/g, '"').replace(/\\'/g, "'"));
          }
        }
      }
    };
    walk(srcDir);

    const missing = [...used].filter(
      (key) =>
        !(key in source) &&
        !SLAVIC_FORMS.some((form) => `${key}_${form}` in source),
    );

    expect(missing).toEqual([]);
  });

  /**
   * `Intl.PluralRules` для русского и украинского дает four категорий. Когда
   * нужного суффикса нет, i18next падает на базовый ключ, а он написан под
   * одну форму, поэтому три числа из четырех выглядят неграмотно.
   */
  it.each(MAINTAINED)(
    "%s имеет формы few и many у плюральных основ",
    (locale) => {
      const dict = readLocale(locale);
      const stems = new Set(
        Object.keys(source)
          .filter((key) => PLURAL_SUFFIX.test(key))
          .map((key) => key.replace(PLURAL_SUFFIX, "")),
      );

      const incomplete = [...stems].filter((stem) =>
        SLAVIC_FORMS.some((form) => !(`${stem}_${form}` in dict)),
      );

      expect(incomplete).toEqual([]);
    },
  );

  /**
   * Сервер отдает с отказом код, и этот же код служит ключом перевода. Код без
   * ключа означает, что человек увидит английский запасной текст с сервера,
   * причем молча: ни сборка, ни линт этого не заметят.
   */
  it("каждый код отказа сервера заведен в источнике", () => {
    const catalogue = fs.readFileSync(
      path.resolve(__dirname, "../../server/src/common/errors/app-error.ts"),
      "utf8",
    );
    const codes = [...catalogue.matchAll(/'(error\.[\w.]+)':/g)].map(
      (match) => match[1],
    );

    expect(codes.length).toBeGreaterThan(0);
    expect(codes.filter((code) => !(code in source))).toEqual([]);
  });

  /**
   * Код, оканчивающийся на суффикс формы числа, i18next разберет как плюраль:
   * `error.common.there_must_be_at_least_one` он ищет как форму `one` основы
   * `error.common.there_must_be_at_least`. Ловушка тихая, поэтому проверяется
   * правилом, а не памятью.
   */
  it("код отказа не оканчивается суффиксом формы числа", () => {
    const trapped = Object.keys(source)
      .filter((key) => key.startsWith("error."))
      .filter((key) => PLURAL_SUFFIX.test(key));

    expect(trapped).toEqual([]);
  });

  it.each(MAINTAINED)("%s покрывает источник целиком", (locale) => {
    const dict = readLocale(locale);
    const missing = Object.keys(source).filter((key) => !(key in dict));

    expect(missing).toEqual([]);
  });
});
