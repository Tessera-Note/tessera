/**
 * Сборка документа Word.
 *
 * Здесь, а не на Python, по той же причине, что и остальное в этом сервисе:
 * сериализатор обходит документ по схеме узлов редактора, и второе описание
 * этой схемы теряло бы узлы молча. Сам сериализатор живёт в
 * `packages/editor-ext` и общий с v1 — переписывать его не потребовалось.
 *
 * **Картинки приходят готовыми.** Хранилище вложений и права на них живут на
 * стороне Python: там проверено, что вложение принадлежит пространству
 * страницы, и оттуда же прочитано его содержимое. Ходить в хранилище отсюда
 * значило бы завести второе место, решающее, какой файл можно положить в
 * документ.
 */

import { createRequire } from 'node:module';

import { tiptapExtensions } from './extensions.js';

const require = createRequire(import.meta.url);

const { pageNodeToDocxBuffer } = require('@tessera/editor-ext');
const { getSchema } = require('@tiptap/core');
const { Node } = require('@tiptap/pm/model');

/** Пустая картинка. Сериализатор такую пропускает, а `null` уронил бы разбор. */
const MISSING = new Uint8Array(0);

/**
 * Узел ProseMirror из JSON.
 *
 * Неизвестный узел не роняет выгрузку: он разворачивается на месте, а лист
 * выбрасывается, и разбор повторяется. Так же в v1. Иначе один узел из чужой
 * версии редактора лишал бы человека всего документа.
 */
export function nodeFromJson(json) {
  const schema = getSchema(tiptapExtensions);
  try {
    return Node.fromJSON(schema, json);
  } catch (error) {
    if (!String(error?.message || '').includes('Unknown node type')) {
      throw error;
    }
    return Node.fromJSON(schema, stripUnknown(json, schema));
  }
}

function stripUnknown(json, schema) {
  if (!json || typeof json !== 'object') return json;
  if (!Array.isArray(json.content)) return json;

  const content = [];
  for (const child of json.content) {
    const cleaned = stripUnknown(child, schema);
    if (!cleaned || typeof cleaned !== 'object') continue;
    if (cleaned.type === 'text' || schema.nodes[cleaned.type]) {
      content.push(cleaned);
      continue;
    }
    // Узел неизвестен: его дети остаются на месте, сам он исчезает. Так текст
    // из врезки или колонки доезжает до файла, даже если самой врезки в схеме
    // нет.
    if (Array.isArray(cleaned.content)) content.push(...cleaned.content);
  }
  return { ...json, content };
}

/**
 * Собрать документ Word. Возвращает содержимое файла.
 *
 * `images` — соответствие адреса в документе и содержимого в base64. Ключом
 * служит именно адрес: сериализатор знает о картинке только то, что записано в
 * узле.
 */
export async function docxFromJson(json, images = {}) {
  const doc = nodeFromJson(json);

  const decoded = new Map();
  for (const [src, value] of Object.entries(images || {})) {
    if (typeof value !== 'string' || !value) continue;
    decoded.set(src, new Uint8Array(Buffer.from(value, 'base64')));
  }

  return pageNodeToDocxBuffer(doc, (src) => decoded.get(src) || MISSING);
}
