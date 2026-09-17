/**
 * Assembling a Word document.
 *
 * Here rather than in Python, for the same reason as everything else in this
 * service: the serializer walks the document by the editor node schema, and a
 * second description of that schema would lose nodes silently. The serializer
 * itself lives in `packages/editor-ext` and is shared with the earlier
 * version — it did not have to be rewritten.
 *
 * **The images arrive ready.** The attachment storage and the permissions on it
 * live on the Python side: there it is checked that an attachment belongs to
 * the space of the page, and its content is read from there as well. Reaching
 * into the storage from here would mean a second place deciding which file may
 * go into a document.
 */

import { createRequire } from 'node:module';

import { tiptapExtensions } from './extensions.js';

const require = createRequire(import.meta.url);

const { pageNodeToDocxBuffer } = require('@tessera/editor-ext');
const { getSchema } = require('@tiptap/core');
const { Node } = require('@tiptap/pm/model');

/** An empty image. The serializer skips one, while `null` would break the parse. */
const MISSING = new Uint8Array(0);

/**
 * A ProseMirror node from JSON.
 *
 * An unknown node does not bring the export down: it is unwrapped in place, the
 * leaf is dropped, and the parse is repeated. The earlier version does the
 * same. Otherwise one node from a different version of the editor would cost a
 * person the whole document.
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
    // The node is unknown: its children stay in place and it disappears
    // itself. That way the text from a callout or a column still reaches the
    // file, even when the callout itself is not in the schema.
    if (Array.isArray(cleaned.content)) content.push(...cleaned.content);
  }
  return { ...json, content };
}

/**
 * Assemble a Word document. Returns the contents of the file.
 *
 * `images` maps an address in the document to content in base64. The key is the
 * address specifically: the serializer knows about an image only what is
 * written in the node.
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
