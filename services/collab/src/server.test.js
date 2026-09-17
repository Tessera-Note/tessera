/**
 * Tests of the conversion.
 *
 * The main thing here is the round trip: a document that went there and back
 * must keep its content. A lost node does not show up as a failure, it shows up
 * as a missing piece of a page a week after the import.
 *
 * The fixtures are deliberately Cyrillic: non-ASCII content surviving the round
 * trip costs nothing extra to check here.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createTransformServer } from './server.js';

async function call(server, path, body) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function withServer(run) {
  return async () => {
    const server = createTransformServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      await run(server);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

test('markdown markup reaches the document', withServer(async (server) => {
  const { body } = await call(server, '/transform/markdown-to-json', {
    markdown: '# Заголовок\n\nАбзац с **жирным**.\n\n- раз\n- два\n',
  });
  const types = body.content.content.map((one) => one.type);
  assert.ok(types.includes('heading'), 'the heading is lost');
  assert.ok(types.includes('paragraph'), 'the paragraph is lost');
  assert.ok(types.includes('bulletList'), 'the list is lost');
}));

test('the round trip keeps the content', withServer(async (server) => {
  const markdown = '# Правила\n\nПервый абзац.\n\n- раз\n- два\n';
  const forward = await call(server, '/transform/markdown-to-json', { markdown });
  const back = await call(server, '/transform/json-to-markdown', {
    content: forward.body.content,
  });
  assert.match(back.body.markdown, /# Правила/);
  assert.match(back.body.markdown, /Первый абзац/);
  assert.match(back.body.markdown, /раз/);
}));

test('the nodes are given stable identifiers', withServer(async (server) => {
  const { body } = await call(server, '/transform/markdown-to-json', {
    markdown: 'Первый абзац.\n\nВторой абзац.\n',
  });
  const ids = body.content.content
    .filter((one) => one.type === 'paragraph')
    .map((one) => one.attrs?.id);
  assert.equal(ids.length, 2);
  assert.ok(ids.every(Boolean), 'without identifiers the comments do not hold');
  assert.notEqual(ids[0], ids[1]);
}));

test('a table survives the conversion', withServer(async (server) => {
  const html = '<table><tbody><tr><th>Ключ</th><td>Значение</td></tr></tbody></table>';
  const forward = await call(server, '/transform/html-to-json', { html });
  const back = await call(server, '/transform/json-to-html', {
    content: forward.body.content,
  });
  assert.match(back.body.html, /<table/);
  assert.match(back.body.html, /Значение/);
}));

test('the flat text is taken from every node', withServer(async (server) => {
  const forward = await call(server, '/transform/markdown-to-json', {
    markdown: '# Заголовок\n\n- пункт внутри списка\n',
  });
  const { body } = await call(server, '/transform/json-to-text', {
    content: forward.body.content,
  });
  assert.match(body.text, /Заголовок/);
  assert.match(body.text, /пункт внутри списка/);
}));

test('an empty document does not break the conversion', withServer(async (server) => {
  const { status, body } = await call(server, '/transform/json-to-markdown', {});
  assert.equal(status, 200);
  assert.equal(typeof body.markdown, 'string');
}));

test('a broken document gives a refusal rather than a crash', withServer(async (server) => {
  const { status } = await call(server, '/transform/json-to-html', {
    content: { type: 'выдуманный-узел' },
  });
  assert.equal(status, 400);

  // The service keeps running: a refused parse is an ordinary outcome.
  const after = await call(server, '/transform/markdown-to-json', { markdown: 'текст' });
  assert.equal(after.status, 200);
}));

test('an unknown path answers with a refusal', withServer(async (server) => {
  const { status } = await call(server, '/transform/выдуманное', {});
  assert.equal(status, 404);
}));

test('a Word document is assembled from the content', async () => {
  const { docxFromJson } = await import('./docx.js');
  const buffer = await docxFromJson({
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Заголовок' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Текст страницы' }] },
    ],
  });
  // A Word file is a zip: the signature shows in the first two characters.
  assert.equal(buffer.subarray(0, 2).toString(), 'PK');
  assert.ok(buffer.length > 1000);
});

test('an unknown node does not break the export', async () => {
  // A node from a different version of the editor is no reason to leave a
  // person without a document: it is unwrapped in place, and the text inside
  // still reaches the file.
  const { docxFromJson } = await import('./docx.js');
  const buffer = await docxFromJson({
    type: 'doc',
    content: [
      {
        type: 'выдуманный',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Внутри' }] }],
      },
    ],
  });
  assert.equal(buffer.subarray(0, 2).toString(), 'PK');
});

test('an image reaches the document as content rather than as an address', async () => {
  const { docxFromJson } = await import('./docx.js');
  // The smallest real PNG: the serializer reads the dimensions from the
  // content, and invented bytes would be skipped silently.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const src = '/api/files/11111111-1111-4111-8111-111111111111/точка.png';
  const withImage = await docxFromJson(
    { type: 'doc', content: [{ type: 'image', attrs: { src } }] },
    { [src]: png.toString('base64') },
  );
  const without = await docxFromJson({
    type: 'doc',
    content: [{ type: 'image', attrs: { src } }],
  });
  assert.ok(withImage.length > without.length, 'the image content did not reach the file');
});

test('the channel counters are served by a route of their own', async () => {
  // The numbers come from whoever holds the connections. The stub is here
  // precisely to check the handing over rather than the work of Hocuspocus.
  const server = createTransformServer(() => ({ connections: 3, documents: 2 }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/stats`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { connections: 3, documents: 2 });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('with no counters the route answers with zeros rather than a refusal', async () => {
  const server = createTransformServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/stats`);
    assert.deepEqual(await response.json(), { connections: 0, documents: 0 });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
