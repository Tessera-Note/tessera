#!/usr/bin/env node
/**
 * Копирует шрифты Excalidraw в статику клиента.
 *
 * Без этого редактор и экспортированные SVG тянут шрифты со стороннего CDN.
 * Экземпляр работает без выхода в интернет, поэтому файлы раздаются самим
 * приложением, а путь к ним задан через window.EXCALIDRAW_ASSET_PATH.
 *
 * Скрипт идемпотентен: повторный запуск переписывает каталог назначения.
 */
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = join(
  root,
  "node_modules",
  "@excalidraw",
  "excalidraw",
  "dist",
  "prod",
  "fonts",
);
const target = join(root, "apps", "client", "public", "excalidraw-assets", "fonts");

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(source))) {
  console.error(
    `[excalidraw-assets] не найден каталог шрифтов ${source}. Установить зависимости: pnpm install`,
  );
  process.exit(1);
}

await rm(target, { recursive: true, force: true });
await mkdir(dirname(target), { recursive: true });
await cp(source, target, { recursive: true });

console.log(`[excalidraw-assets] шрифты скопированы в ${target}`);
