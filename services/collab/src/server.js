/**
 * Page content conversion.
 *
 * A separate service on Node, because the editor node schema is described by
 * Tiptap extensions in TypeScript and must have no other implementation. A
 * second description of the same schema is a class of error that never shows up
 * as a failure: the document is saved, and a node missing from the second
 * schema is dropped silently on the next parse.
 *
 * The dependencies are declared at the root of the monorepo and are not
 * duplicated here: the lockfile belongs to the package manager, and adding a
 * `package.json` with dependencies of its own here would force it to
 * regenerate.
 *
 * The service knows nothing about the database or about permissions. It
 * receives a document and returns a document; everything to do with access was
 * decided before the call got here.
 */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { attachCollab, closeCollab, createCollabServer, startSweep } from './collab.js';
import { docxFromJson } from './docx.js';
import { htmlFromPdf } from './pdf.js';

import {
  addUniqueIdsToDoc,
  htmlToMarkdown,
  markdownToHtml,
  tiptapExtensions,
} from './extensions.js';

const require = createRequire(import.meta.url);
// The server build: the ordinary one requires a browser environment and refuses
// with a message saying exactly that.
const { generateHTML, generateJSON } = require('@tiptap/html/server');
const { generateText } = require('@tiptap/core');

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '0.0.0.0';

/** The body size limit. A page document is measured in kilobytes; anything
 * noticeably larger is a mistake of the caller rather than a large page. */
const MAX_BODY = 8 * 1024 * 1024;

/**
 * The PDF parse has a limit of its own.
 *
 * A whole file arrives here in base64, and the shared limit of eight megabytes
 * would cut off an ordinary book. The value is agreed with the import limit on
 * the application side (`FILE_IMPORT_SIZE_LIMIT`, 200 MB by default), with room
 * for the growth that encoding adds.
 */
const MAX_PDF_BODY = Number(process.env.MAX_PDF_BODY || 280 * 1024 * 1024);

function jsonFromHtml(html) {
  const document = generateJSON(html || '', tiptapExtensions);
  try {
    // The nodes are given stable identifiers: comments and link anchors hold
    // on to them. A failure here is no reason to lose the document — without
    // the identifiers it stays correct, the anchors just have to be placed
    // again.
    return addUniqueIdsToDoc(document, tiptapExtensions);
  } catch {
    return document;
  }
}

const handlers = {
  'markdown-to-json': async (body) => ({
    content: jsonFromHtml(await markdownToHtml(body.markdown || '')),
  }),
  'html-to-json': async (body) => ({ content: jsonFromHtml(body.html || '') }),
  'json-to-html': async (body) => ({
    html: generateHTML(body.content || emptyDocument(), tiptapExtensions),
  }),
  'json-to-markdown': async (body) => ({
    markdown: htmlToMarkdown(
      generateHTML(body.content || emptyDocument(), tiptapExtensions),
    ),
  }),
  'json-to-text': async (body) => ({
    text: generateText(body.content || emptyDocument(), tiptapExtensions),
  }),
  // The contents of the file travel in base64: the answer of this service is
  // always JSON, and a binary answer would require a second kind of answer for
  // the sake of one route.
  'json-to-docx': async (body) => ({
    docx: (await docxFromJson(body.content || emptyDocument(), body.images)).toString(
      'base64',
    ),
  }),
  // The file arrives in base64 for the same reason the DOCX leaves in it: the
  // service has one kind of body, and a binary one would require a second for
  // the sake of one route.
  'pdf-to-html': async (body) => ({ html: await htmlFromPdf(body.pdf || '') }),
};

/** The PDF parse has a body limit of its own: a whole file arrives here. */
const LIMITS = { 'pdf-to-html': MAX_PDF_BODY };

function emptyDocument() {
  return { type: 'doc', content: [] };
}

async function readBody(request, limit = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      throw new Error('body too large');
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

export function createTransformServer(stats = () => ({ connections: 0, documents: 0 })) {
  return createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      // Readiness is checked by an orchestrator that has neither a token nor
      // any content: the answer carries nothing but a sign of life.
      send(response, 200, { status: 'ok' });
      return;
    }

    if (request.method === 'GET' && request.url === '/stats') {
      // The counters of the editing channel. They live here rather than on the
      // server half: this process holds the connections and the documents, and
      // asking the neighbour about them would mean answering from the memory of
      // another process.
      send(response, 200, stats());
      return;
    }

    const name = (request.url || '').replace(/^\/transform\//, '').split('?')[0];
    const handler = handlers[name];
    if (request.method !== 'POST' || !handler) {
      send(response, 404, { error: 'unknown endpoint' });
      return;
    }

    try {
      const body = await readBody(request, LIMITS[name] ?? MAX_BODY);
      send(response, 200, await handler(body));
    } catch (error) {
      // Parsing someone else's document refuses on broken input, and that is
      // an ordinary outcome rather than a breakage of the service: the message
      // goes to the caller and the process keeps running.
      send(response, 400, { error: String(error?.message || error) });
    }
  });
}

// The server comes up only when this file is the entry point itself. There used
// to be a `NODE_ENV !== 'test'` check here: it relies on a variable the test
// runner does not set, so importing the file in a test took a real port. On a
// machine where that port was already held by a neighbour, it brought down the
// whole test file with an error that had nothing to do with the tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The collaborative editing channel comes up on the same port: it has the
  // same editor node schema and the same process, and a second port would mean
  // a second service with the same code inside.
  const { hocuspocus } = createCollabServer();

  const server = createTransformServer(() => ({
    connections: hocuspocus.getConnectionsCount(),
    documents: hocuspocus.getDocumentsCount(),
  }));
  attachCollab(server, hocuspocus);
  const stopSweep = startSweep(hocuspocus);

  server.listen(PORT, HOST, () => {
    console.log(`Content conversion is listening on ${HOST}:${PORT}`);
    console.log(`Collaborative editing is listening on ${HOST}:${PORT}/collab`);
  });

  const stop = async () => {
    // The order is the reverse of the start: first we stop checking
    // permissions, then we close the connections, and only then the server
    // itself. Otherwise the sweep finds connections that are already closed.
    stopSweep();
    try {
      await closeCollab(hocuspocus);
    } catch (error) {
      console.error(error);
    }
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
