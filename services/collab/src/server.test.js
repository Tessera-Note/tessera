/**
 * Проверки преобразования.
 *
 * Главное здесь — обратный ход: документ, прошедший туда и обратно, обязан
 * сохранить содержимое. Потеря узла не проявляется отказом, она проявляется
 * пропавшим куском страницы через неделю после импорта.
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

test('разметка markdown доходит до документа', withServer(async (server) => {
  const { body } = await call(server, '/transform/markdown-to-json', {
    markdown: '# Заголовок\n\nАбзац с **жирным**.\n\n- раз\n- два\n',
  });
  const types = body.content.content.map((one) => one.type);
  assert.ok(types.includes('heading'), 'заголовок потерян');
  assert.ok(types.includes('paragraph'), 'абзац потерян');
  assert.ok(types.includes('bulletList'), 'список потерян');
}));

test('обратный ход сохраняет содержимое', withServer(async (server) => {
  const markdown = '# Правила\n\nПервый абзац.\n\n- раз\n- два\n';
  const forward = await call(server, '/transform/markdown-to-json', { markdown });
  const back = await call(server, '/transform/json-to-markdown', {
    content: forward.body.content,
  });
  assert.match(back.body.markdown, /# Правила/);
  assert.match(back.body.markdown, /Первый абзац/);
  assert.match(back.body.markdown, /раз/);
}));

test('узлы получают устойчивые идентификаторы', withServer(async (server) => {
  const { body } = await call(server, '/transform/markdown-to-json', {
    markdown: 'Первый абзац.\n\nВторой абзац.\n',
  });
  const ids = body.content.content
    .filter((one) => one.type === 'paragraph')
    .map((one) => one.attrs?.id);
  assert.equal(ids.length, 2);
  assert.ok(ids.every(Boolean), 'без идентификаторов не держатся комментарии');
  assert.notEqual(ids[0], ids[1]);
}));

test('таблица переживает преобразование', withServer(async (server) => {
  const html = '<table><tbody><tr><th>Ключ</th><td>Значение</td></tr></tbody></table>';
  const forward = await call(server, '/transform/html-to-json', { html });
  const back = await call(server, '/transform/json-to-html', {
    content: forward.body.content,
  });
  assert.match(back.body.html, /<table/);
  assert.match(back.body.html, /Значение/);
}));

test('плоский текст берётся из всех узлов', withServer(async (server) => {
  const forward = await call(server, '/transform/markdown-to-json', {
    markdown: '# Заголовок\n\n- пункт внутри списка\n',
  });
  const { body } = await call(server, '/transform/json-to-text', {
    content: forward.body.content,
  });
  assert.match(body.text, /Заголовок/);
  assert.match(body.text, /пункт внутри списка/);
}));

test('пустой документ не роняет преобразование', withServer(async (server) => {
  const { status, body } = await call(server, '/transform/json-to-markdown', {});
  assert.equal(status, 200);
  assert.equal(typeof body.markdown, 'string');
}));

test('битый документ даёт отказ, а не падение', withServer(async (server) => {
  const { status } = await call(server, '/transform/json-to-html', {
    content: { type: 'выдуманный-узел' },
  });
  assert.equal(status, 400);

  // Сервис продолжает работать: отказ разбора это обычный исход.
  const after = await call(server, '/transform/markdown-to-json', { markdown: 'текст' });
  assert.equal(after.status, 200);
}));

test('неизвестный путь отвечает отказом', withServer(async (server) => {
  const { status } = await call(server, '/transform/выдуманное', {});
  assert.equal(status, 404);
}));

test('документ Word собирается из содержимого', async () => {
  const { docxFromJson } = await import('./docx.js');
  const buffer = await docxFromJson({
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Заголовок' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Текст страницы' }] },
    ],
  });
  // Файл Word это zip: подпись видна первыми двумя знаками.
  assert.equal(buffer.subarray(0, 2).toString(), 'PK');
  assert.ok(buffer.length > 1000);
});

test('неизвестный узел не роняет выгрузку', async () => {
  // Узел из чужой версии редактора не повод оставить человека без документа:
  // он разворачивается на месте, текст внутри доезжает до файла.
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

test('картинка попадает в документ содержимым, а не адресом', async () => {
  const { docxFromJson } = await import('./docx.js');
  // Наименьший настоящий PNG: сериализатор читает размеры из содержимого, и
  // выдуманные байты он молча пропустил бы.
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
  assert.ok(withImage.length > without.length, 'содержимое картинки не попало в файл');
});

test('счётчики канала отдаются отдельным маршрутом', async () => {
  // Числа приходят от того, кто держит соединения. Заглушка здесь именно
  // затем, чтобы проверять передачу, а не работу Hocuspocus.
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

test('без счётчиков маршрут отвечает нулями, а не отказом', async () => {
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
