#!/usr/bin/env node
/**
 * Копирует шрифты Excalidraw в статику приложения.
 *
 * Без этого редактор и экспортированные SVG тянут шрифты со стороннего CDN.
 * Экземпляр работает без выхода в интернет, поэтому файлы раздаются самим
 * приложением, и путь `/excalidraw-assets/` обязан отдаваться. Пользуются им
 * оба: сам редактор через `window.EXCALIDRAW_ASSET_PATH` и выгрузка SVG,
 * подменяющая в разметке адрес unpkg. Обе установки в `ExcalidrawEditor.svelte`.
 *
 * Вызывается из сборки `@tessera/web`, а не хуком `prebuild`: pnpm 10 по
 * умолчанию не запускает pre- и post-скрипты.
 *
 * Лежит внутри `apps/web`, а не в общем `scripts/`, потому что образ экранов
 * копирует только `apps/web` и `packages`. Из общего каталога скрипт в образ
 * не попадал, и сборка вставала на `Cannot find module`.
 *
 * Каталог пакета ищется резолвингом от манифеста `apps/web`, а не сложением
 * путей: pnpm держит зависимость ссылкой внутрь `node_modules/.pnpm`, и её
 * место зависит от раскладки, а не от имени пакета. Резолвится сам пакет, а не
 * его `package.json`: поле `exports` подпуть к манифесту не открывает, и
 * попытка взять его отвечает ERR_PACKAGE_PATH_NOT_EXPORTED.
 *
 * Скрипт идемпотентен: повторный запуск переписывает каталог назначения.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..');
const webManifest = join(web, 'package.json');
const target = join(web, 'static', 'excalidraw-assets', 'fonts');

function resolveFonts() {
  const require = createRequire(webManifest);
  // Точка входа лежит внутри `dist`, поэтому корень пакета ищется подъёмом
  // вверх до каталога, у которого есть искомые шрифты.
  let dir = dirname(require.resolve('@excalidraw/excalidraw'));
  for (let depth = 0; depth < 5; depth += 1) {
    const fonts = join(dir, 'dist', 'prod', 'fonts');
    if (existsSync(fonts)) {
      return fonts;
    }
    dir = dirname(dir);
  }
  throw new Error('каталог шрифтов не найден внутри пакета');
}

let source;
try {
  source = resolveFonts();
} catch (error) {
  // Причина печатается своя, а не общая: отсутствующий пакет и пакет без
  // шрифтов лечатся по-разному, а одно сообщение на оба случая отправило бы
  // читающего ставить уже установленные зависимости.
  console.error(`[excalidraw-assets] ${error.message}`);
  console.error('[excalidraw-assets] если пакет не установлен, выполнить: pnpm install');
  process.exit(1);
}

await rm(target, { recursive: true, force: true });
await mkdir(dirname(target), { recursive: true });
await cp(source, target, { recursive: true });

console.log(`[excalidraw-assets] шрифты скопированы в ${target}`);
