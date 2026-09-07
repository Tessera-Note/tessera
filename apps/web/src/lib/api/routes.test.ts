/**
 * Каждый адрес, который зовёт клиент, есть на сервере.
 *
 * Заведена после дефекта: значки пространства грузились на
 * `/api/files/upload-image`, а маршрут живёт на `/api/attachments/upload-image`.
 * Оба контроллера объявлены в одном файле сервера с разными путями, и разница
 * не видна ни при чтении, ни при сборке — только отказом 404 в браузере, у
 * человека.
 *
 * Проверка читает исходники сервера: маршруты объявлены декораторами, и
 * исполнимого их перечня не существует. Тот же способ применён к ключам
 * интерфейса и к кодам отказов.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Корень исходников клиента: этот файл лежит в `src/lib/api`. */
const SRC = join(HERE, '..', '..');
const API = join(HERE, '..', '..', '..', '..', 'api', 'tessera_api', 'api');

/**
 * Путь контроллера действует до следующего контроллера в том же файле.
 *
 * Путь бывает записан именем (`path = BASE_PATH`): у SCIM он объявлен рядом
 * константой, потому что стоит и в маршрутах, и в собственных ответах
 * протокола. Имя разбирается отдельно — без этого весь контроллер считался бы
 * набором адресов без префикса, то есть проверка молча пропускала бы его.
 */
const CONTROLLER_PATH = /^[ \t]+path = (?:"([^"]+)"|([A-Z_][A-Z0-9_]*))/gm;

/** Строковая константа модуля: `BASE_PATH = "/api/scim/v2"`. */
const MODULE_CONSTANT = /^([A-Z_][A-Z0-9_]*) = "([^"]+)"/gm;

/**
 * Обработчик и его пути.
 *
 * Путей бывает несколько: канал MCP объявлен как `@post(["/mcp", "/api/mcp"])`
 * — у него два полных адреса и пустой префикс контроллера, потому что общий
 * префикс превратил бы второй в `/mcp/api/mcp`. Разбирать надо оба, иначе
 * обращение по второму читается как обращение в никуда.
 *
 * Перенос строки между скобкой и адресом разрешён намеренно: длинные
 * объявления записаны в несколько строк (`@get(\n  "/img/{kind}/{name}",\n
 * opt={PUBLIC: True},\n)`), и разбор по одной строке их пропускал. Пропущенный
 * маршрут — это ложная тревога у проверки, то есть повод её отключить.
 */
const HANDLER = /@(?:post|get|put|patch|delete)\(\s*(\[[^\]]*\]|"[^"]*")/g;

/** Все адреса, объявленные сервером. Подстановки обрезаются по первой скобке. */
function serverRoutes(): Set<string> {
  const found = new Set<string>();

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__pycache__') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.py')) continue;

      const text = readFileSync(full, 'utf8');

      // Файл разбирается целиком, а не по строкам: объявление обработчика
      // бывает многострочным. Префикс обработчика — последний путь
      // контроллера, объявленный выше него.
      const constants = new Map([...text.matchAll(MODULE_CONSTANT)].map((one) => [one[1], one[2]]));
      const bases = [...text.matchAll(CONTROLLER_PATH)]
        .map((one) => ({
          at: one.index,
          path: one[1] ?? constants.get(one[2] ?? '')
        }))
        // Имя, которого нет среди строковых констант файла, пропускается:
        // домысливать за него путь — значит выдумывать маршруты.
        .filter((one): one is { at: number; path: string } => one.path !== undefined);

      for (const handler of text.matchAll(HANDLER)) {
        const above = bases.filter((one) => one.at < handler.index);
        const base = above.length > 0 ? above[above.length - 1].path : '';

        for (const piece of handler[1].match(/"([^"]*)"/g) ?? []) {
          const route = (base + piece.slice(1, -1)).replace('//', '/');
          found.add(route.replace(/\/$/, '') || base);
        }
      }
    }
  };

  walk(API);
  return found;
}

/**
 * Адреса, которые зовёт клиент.
 *
 * Вместе с признаком, дописывается ли к адресу значение. Признак решает всё:
 * адрес, к которому дописывают, законно совпадает с маршрутом по началу, а
 * законченный обязан совпасть целиком. Без этого различия маршрут выдачи файла
 * `/api/files/{id}/{name}` принимал бы любую опечатку под `/api/files/`.
 */
function clientCalls(): { path: string; file: string; dynamic: boolean }[] {
  const calls: { path: string; file: string; dynamic: boolean }[] = [];
  const address = /['"`](\/api\/[a-z0-9/_-]*)|\$\{apiBase\(\)\}(\/api\/[a-z0-9/_-]*)/g;

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|svelte)$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
      if (entry.name.includes('.test.')) continue;

      // Пояснения выброшены: адреса в них — рассказ о маршруте, а не
      // обращение к нему, и разбирать их как вызовы значит ловить самого себя.
      const text = readFileSync(full, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');

      for (const match of text.matchAll(address)) {
        const found = match[1] ?? match[2];
        const path = found.replace(/\/$/, '');
        if (!path) continue;

        // Что стоит сразу за адресом: подстановка означает, что адрес
        // продолжается значением, а кавычка — что он закончен.
        const after = text.slice(match.index + match[0].length);
        const dynamic = after.startsWith('${') || found.endsWith('/');

        calls.push({ path, file: full.slice(SRC.length + 1), dynamic });
      }
    }
  };

  walk(SRC);
  return calls;
}

const routes = serverRoutes();
const calls = clientCalls();

/**
 * Знает ли сервер такой адрес.
 *
 * Совпадение бывает трёх видов. Точное — обычный вызов. По началу маршрута —
 * там, где клиент дописывает значения: выдача файла (`/api/files/{id}/{name}`)
 * и картинки (`/api/attachments/img/{kind}/{name}`). И наоборот, по началу
 * адреса — когда в коде записана только общая часть, а хвост подставляется
 * рядом.
 *
 * Опечатку это не пропускает: `/api/files/upload-image` не совпадает ни с
 * одним маршрутом, не начинается ни с одного и ни один маршрут с него не
 * начинается — именно так и был найден дефект, ради которого проверка заведена.
 */
function known(path: string, dynamic: boolean): boolean {
  if (routes.has(path)) return true;

  for (const route of routes) {
    // Записана только общая часть, а хвост подставляется рядом.
    if (route.startsWith(`${path}/`)) return true;

    // Совпадение по началу — только для адреса, к которому дописывают
    // значение. Законченному адресу оно не даётся: иначе опечатка в
    // `/api/files/upload-image` сошла бы за выдачу файла.
    if (!dynamic) continue;
    const fixed = route.split('{')[0].replace(/\/$/, '');
    if (fixed && fixed !== route && path.startsWith(fixed)) return true;
  }
  return false;
}

describe('адреса сервера', () => {
  it('проверка что-то находит', () => {
    // Опора остальных: пустые множества дали бы зелёный результат на пустоте.
    expect(routes.size).toBeGreaterThan(150);
    expect(calls.length).toBeGreaterThan(80);
    expect(routes.has('/api/pages/info')).toBe(true);
    expect(routes.has('/api/attachments/upload-image')).toBe(true);
    // Путь этого контроллера записан именем: без разбора имени он и его
    // маршруты выпадали из перечня целиком.
    expect(routes.has('/api/scim/v2/Users')).toBe(true);
  });

  it('каждый адрес клиента объявлен сервером', () => {
    const missing = [
      ...new Set(calls.filter((one) => !known(one.path, one.dynamic)).map((one) => one.path))
    ];
    expect(missing.sort()).toEqual([]);
  });

  it('называет файл, где стоит негодный адрес', () => {
    // Смысл в сообщении: без файла искать опечатку по сотне обращений долго.
    const guilty = calls.filter((one) => !known(one.path, one.dynamic));
    expect(guilty.map((one) => `${one.file}: ${one.path}`)).toEqual([]);
  });
});
