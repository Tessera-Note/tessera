/**
 * Проверки канала совместного редактирования.
 *
 * Настоящее подключение по WebSocket поднимается целиком: протокол Hocuspocus
 * это не только сообщения, но и порядок хуков, и подмена сервера проверяла бы
 * подмену. Серверная половина подменена локальным HTTP: она проверяется своими
 * проверками на Python, а здесь важно, что именно ей отправлено и как разобран
 * ответ.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createRequire } from 'node:module';

import {
  allowUnnamedFromEnv,
  attachCollab,
  closeCollab,
  createCollabServer,
  pageIdOf,
  sweepOnce,
  textOf,
} from './collab.js';

const require = createRequire(import.meta.url);
const { HocuspocusProvider } = require('@hocuspocus/provider');
const WebSocket = require('ws');

const PAGE_ID = '11111111-1111-4111-8111-111111111111';
const USER = { id: '22222222-2222-4222-8222-222222222222', name: 'Проверяющий' };

/** Подменённая серверная половина: запоминает запросы и отвечает заданным. */
function backend(answers) {
  const seen = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    seen.push({ path: request.url, token: request.headers['x-internal-token'], body });

    const answer = answers[request.url];
    const value = typeof answer === 'function' ? answer(body) : answer;

    if (!value || value.status >= 400) {
      response.writeHead(value?.status || 404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: value?.code || 'not_found' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value.body ?? {}));
  });
  return { server, seen };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

/** Поднять пару «серверная половина и канал» и выполнить проверку на них. */
async function withChannel(answers, run, options = {}) {
  const { server: fake, seen } = backend(answers);
  const backendPort = await listen(fake);

  process.env.API_URL = `http://127.0.0.1:${backendPort}`;
  process.env.COLLAB_INTERNAL_TOKEN = 'test-internal-token';
  const { hocuspocus } = createCollabServer(options);

  const http = createServer((_, response) => response.end());
  attachCollab(http, hocuspocus);
  const port = await listen(http);

  try {
    await run({ port, seen, hocuspocus });
  } finally {
    await closeCollab(hocuspocus, { timeoutMs: 500 }).catch(() => {});
    // Соединения обрываются принудительно. `close` ждёт закрытия каждого, а
    // здесь их держат и сокет редактирования, и постоянное соединение клиента
    // HTTP: без этого проверка висит вместо того, чтобы закончиться.
    http.closeAllConnections?.();
    fake.closeAllConnections?.();
    await new Promise((resolve) => http.close(resolve));
    await new Promise((resolve) => fake.close(resolve));
  }
}

/**
 * Подключиться клиентским провайдером и дождаться исхода.
 *
 * Сокетом управляет сам провайдер: при переданном снаружи он не подключается
 * без явного `attach`, и проверка молча ждала бы события, которого не будет.
 */
function connect(
  port,
  {
    token = 'токен',
    documentName = `page.${PAGE_ID}`,
    // Имя документа идёт и доводом адреса: по нему прокси закрепляет
    // соединение за репликой, и сервер сверяет его с именем из протокола.
    address = `ws://127.0.0.1:${port}/collab?documentName=${encodeURIComponent(documentName)}`,
  } = {},
) {
  return new Promise((resolve) => {
    const messages = [];
    let provider;

    // Свой предел ожидания: без него отказ, о котором клиент не сообщает,
    // подвешивает проверку вместо того, чтобы её уронить.
    const guard = setTimeout(() => resolve({ ok: false, reason: 'ответа нет', provider, messages }), 5000);
    const done = (value) => {
      clearTimeout(guard);
      resolve(value);
    };

    provider = new HocuspocusProvider({
      url: address,
      WebSocketPolyfill: WebSocket,
      name: documentName,
      token,
      // Переподключение выключено: проверка ждёт один исход, а не бесконечные
      // попытки после отказа.
      maxAttempts: 1,
      onStateless: ({ payload }) => messages.push(JSON.parse(payload)),
      onSynced: () => done({ ok: true, provider, messages }),
      onAuthenticationFailed: ({ reason }) => done({ ok: false, reason, provider, messages }),
    });
  });
}

function close({ provider }) {
  try {
    provider?.destroy();
  } catch {
    /* уже закрыт */
  }
}

const AUTHORIZED = {
  '/api/internal/collab/authorize': {
    body: { pageId: PAGE_ID, workspaceId: 'w', canEdit: true, user: USER },
  },
  '/api/internal/collab/document': { body: { ydoc: null, content: null, title: 'Страница' } },
  '/api/internal/collab/store': { body: { saved: true, updatedAt: '2026-01-01T00:00:00Z' } },
  '/api/internal/collab/rights': {
    body: { gone: false, users: { [USER.id]: { allowed: true, canEdit: true } } },
  },
};

test('имя документа разбирается только в известном виде', () => {
  assert.equal(pageIdOf(`page.${PAGE_ID}`), PAGE_ID);
  assert.equal(pageIdOf('page.'), null);
  assert.equal(pageIdOf('чужое'), null);
  assert.equal(pageIdOf(null), null);
});

test('плоский текст берётся из документа', () => {
  const json = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Текст страницы' }] }],
  };
  assert.match(textOf(json), /Текст страницы/);
});

test('битый документ не роняет расчёт текста', () => {
  // Пустая строка это не потеря: поиск по тексту восстановится следующим
  // сохранением, а отказ здесь оборвал бы всё сохранение целиком.
  assert.equal(textOf({ type: 'выдуманный' }), '');
});

test('подключение спрашивает права у серверной половины', async () => {
  await withChannel(AUTHORIZED, async ({ port, seen }) => {
    const result = await connect(port);
    assert.equal(result.ok, true);
    close(result);

    const asked = seen.find((one) => one.path === '/api/internal/collab/authorize');
    assert.ok(asked, 'права не спрошены');
    assert.equal(asked.body.documentName, `page.${PAGE_ID}`);
    assert.equal(asked.body.token, 'токен');
  });
});

test('имя документа в адресе обязано совпадать с именем в протоколе', async () => {
  // Прокси закрепляет соединение за репликой по адресу, а документ
  // открывается по сообщению протокола. Разошедшиеся имена привели бы
  // соединение на реплику, где документ не живёт.
  await withChannel(AUTHORIZED, async ({ port, seen }) => {
    const other = 'page.33333333-3333-4333-8333-333333333333';
    const result = await connect(port, {
      address: `ws://127.0.0.1:${port}/collab?documentName=${encodeURIComponent(other)}`,
    });
    assert.equal(result.ok, false, 'соединение открылось с чужим именем в адресе');
    close(result);
    assert.equal(
      seen.some((one) => one.path === '/api/internal/collab/authorize'),
      false,
      'права спрошены, хотя имя в адресе не совпало',
    );
  });
});

test('без имени в адресе соединение не открывается', async () => {
  // Без довода прокси положил бы соединение на реплику пустого имени — не на
  // ту, где живёт документ.
  await withChannel(AUTHORIZED, async ({ port }) => {
    const result = await connect(port, { address: `ws://127.0.0.1:${port}/collab` });
    assert.equal(result.ok, false, 'соединение открылось без имени в адресе');
    close(result);
  });
});

test('флаг раскатки пускает подключение без имени и пишет его в журнал', async (t) => {
  // Вкладки, открытые до обновления, подключаются по старому адресу. При одной
  // реплике их можно пустить, но каждое такое подключение обязано остаться в
  // журнале: по нему видно, что старые вкладки ещё живы.
  const logged = t.mock.method(console, 'log', () => {});
  await withChannel(
    AUTHORIZED,
    async ({ port }) => {
      const result = await connect(port, { address: `ws://127.0.0.1:${port}/collab` });
      assert.equal(result.ok, true, 'с флагом соединение без имени не открылось');
      close(result);
    },
    { allowUnnamed: true },
  );

  const lines = logged.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(
    lines.some((one) => one.includes('без имени документа в адресе включён')),
    'включённый допуск не объявлен при запуске',
  );
  const admitted = lines.find((one) => one.includes('без имени в адресе допущено'));
  assert.ok(admitted, 'допущенное подключение не записано в журнал');
  assert.ok(admitted.includes(`page.${PAGE_ID}`), 'в записи нет документа');
  assert.match(admitted, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'в записи нет времени');
});

test('с флагом раскатки расхождение имён по-прежнему отказ', async () => {
  await withChannel(
    AUTHORIZED,
    async ({ port, seen }) => {
      const other = 'page.33333333-3333-4333-8333-333333333333';
      const result = await connect(port, {
        address: `ws://127.0.0.1:${port}/collab?documentName=${encodeURIComponent(other)}`,
      });
      assert.equal(result.ok, false, 'соединение открылось с чужим именем в адресе');
      close(result);
      assert.equal(
        seen.some((one) => one.path === '/api/internal/collab/authorize'),
        false,
        'права спрошены, хотя имя в адресе не совпало',
      );
    },
    { allowUnnamed: true },
  );
});

test('с флагом раскатки пустое имя в адресе — тоже расхождение', async () => {
  // Довод есть, но пустой: это не старая вкладка, а сломанный адрес, и прокси
  // закрепил бы его по пустому ключу.
  await withChannel(
    AUTHORIZED,
    async ({ port }) => {
      const result = await connect(port, { address: `ws://127.0.0.1:${port}/collab?documentName=` });
      assert.equal(result.ok, false, 'соединение открылось с пустым именем в адресе');
      close(result);
    },
    { allowUnnamed: true },
  );
});

test('флаг раскатки включается только явным значением', () => {
  for (const value of ['', 'false', '0', 'yes', 'TRUE ']) {
    assert.equal(allowUnnamedFromEnv(value), false, `значение «${value}» включило допуск`);
  }
  assert.equal(allowUnnamedFromEnv('true'), true);
  assert.equal(allowUnnamedFromEnv('1'), true);

  const saved = process.env.COLLAB_ALLOW_UNNAMED_DOCUMENT;
  delete process.env.COLLAB_ALLOW_UNNAMED_DOCUMENT;
  try {
    assert.equal(allowUnnamedFromEnv(), false, 'без переменной допуск включён');
  } finally {
    if (saved !== undefined) process.env.COLLAB_ALLOW_UNNAMED_DOCUMENT = saved;
  }
});

test('общий секрет уходит своим заголовком', async () => {
  await withChannel(AUTHORIZED, async ({ port, seen }) => {
    const result = await connect(port);
    close(result);
    assert.equal(seen[0].token, 'test-internal-token');
  });
});

test('отказ серверной половины закрывает подключение', async () => {
  await withChannel(
    { '/api/internal/collab/authorize': { status: 403, code: 'error.page.access_denied' } },
    async ({ port }) => {
      const result = await connect(port);
      assert.equal(result.ok, false, 'соединение открылось без права');
      close(result);
    },
  );
});

test('документ грузится из состояния, а не из json, когда состояние есть', async () => {
  const answers = {
    ...AUTHORIZED,
    '/api/internal/collab/document': {
      body: {
        // Состояние пустого документа: важно, что оно предпочтено json.
        ydoc: Buffer.from([0, 0]).toString('base64'),
        content: { type: 'doc', content: [] },
      },
    },
  };
  await withChannel(answers, async ({ port, seen }) => {
    const result = await connect(port);
    assert.equal(result.ok, true);
    close(result);
    const asked = seen.find((one) => one.path === '/api/internal/collab/document');
    assert.equal(asked.body.pageId, PAGE_ID);
  });
});

test('неразобранное тело не роняет подключение и объясняет причину', async () => {
  // Узел, которого нет в схеме: так бывает после ввоза из чужой системы и
  // после отката версии приложения. Прежде подключение обрывалось, и человек
  // видел пустой лист без единого слова о причине.
  const answers = {
    ...AUTHORIZED,
    '/api/internal/collab/document': {
      body: {
        ydoc: null,
        content: { type: 'doc', content: [{ type: 'узелИзБудущего' }] },
      },
    },
  };
  await withChannel(answers, async ({ port }) => {
    const result = await connect(port);
    assert.equal(result.ok, true);
    const notice = result.messages.find((one) => one.type === 'document.unreadable');
    assert.ok(notice, 'причина не пришла');
    assert.ok(notice.reason.length > 0);
    close(result);
  });
});

test('неразобранное тело не сохраняется поверх страницы', async () => {
  // Документ в памяти пуст, потому что тело не разобралось. Запись стёрла бы
  // ровно то содержимое, из-за которого разбор и не прошёл.
  const answers = {
    ...AUTHORIZED,
    '/api/internal/collab/document': {
      body: {
        ydoc: null,
        content: { type: 'doc', content: [{ type: 'узелИзБудущего' }] },
      },
    },
  };
  await withChannel(answers, async ({ port, seen, hocuspocus }) => {
    const result = await connect(port);
    assert.equal(result.ok, true);
    close(result);

    // Сохранение вызывается напрямую: ждать разгрузки документа по времени
    // значило бы держать проверку минуту ради одного вызова.
    const document = hocuspocus.documents.get(`page.${PAGE_ID}`);
    await hocuspocus.storeDocumentHooks(document, {
      instance: hocuspocus,
      clientsCount: 0,
      context: { user: USER },
      document,
      documentName: document.name,
      requestHeaders: {},
      requestParameters: new URLSearchParams(),
      socketId: 'проверка',
      transactionOrigin: null,
      // Немедленно: иначе запись откладывается на время debounce, и проверка
      // заканчивается раньше, чем сохранение вообще пробуют.
    }, true);

    assert.equal(
      seen.some((one) => one.path === '/api/internal/collab/store'),
      false,
      'пустой документ ушёл в запись',
    );
  });
});

test('разобранное тело тем же путём в запись уходит', async () => {
  // Спутник предыдущей проверки: без него та проходила бы и при сохранении,
  // сломанном по любой другой причине.
  const answers = {
    ...AUTHORIZED,
    '/api/internal/collab/document': {
      body: {
        ydoc: null,
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Обычный текст' }] }],
        },
      },
    },
  };
  await withChannel(answers, async ({ port, seen, hocuspocus }) => {
    const result = await connect(port);
    assert.equal(result.ok, true);
    close(result);

    const document = hocuspocus.documents.get(`page.${PAGE_ID}`);
    await hocuspocus.storeDocumentHooks(document, {
      instance: hocuspocus,
      clientsCount: 0,
      context: { user: USER },
      document,
      documentName: document.name,
      requestHeaders: {},
      requestParameters: new URLSearchParams(),
      socketId: 'проверка',
      transactionOrigin: null,
    }, true);

    const stored = seen.find((one) => one.path === '/api/internal/collab/store');
    assert.ok(stored, 'разобранный документ в запись не ушёл');
    assert.match(stored.body.text, /Обычный текст/);
  });
});

test('обход прав отзывает доступ и закрывает соединение', async () => {
  const answers = {
    ...AUTHORIZED,
    '/api/internal/collab/rights': {
      body: { gone: false, users: { [USER.id]: { allowed: false, canEdit: false } } },
    },
  };
  await withChannel(answers, async ({ port, hocuspocus }) => {
    const result = await connect(port);
    assert.equal(result.ok, true);

    await sweepOnce(hocuspocus);
    // Сообщение уходит до закрытия: без него редактор на экране остаётся
    // редактируемым, и набранное уходит в никуда.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(
      result.messages.some((one) => one.type === 'access.revoked'),
      'клиент не получил сообщения об отзыве',
    );
    close(result);
  });
});

test('обход понижает до чтения без переподключения', async () => {
  const answers = {
    ...AUTHORIZED,
    '/api/internal/collab/rights': {
      body: { gone: false, users: { [USER.id]: { allowed: true, canEdit: false } } },
    },
  };
  await withChannel(answers, async ({ port, hocuspocus }) => {
    const result = await connect(port);
    await sweepOnce(hocuspocus);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const changed = result.messages.find((one) => one.type === 'access.changed');
    assert.ok(changed, 'клиент не получил сообщения о смене права');
    assert.equal(changed.canEdit, false);
    close(result);
  });
});

test('недоступная серверная половина не отбирает доступ', async () => {
  const answers = {
    ...AUTHORIZED,
    '/api/internal/collab/rights': { status: 500, code: 'oops' },
  };
  await withChannel(answers, async ({ port, hocuspocus }) => {
    const result = await connect(port);
    await sweepOnce(hocuspocus);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Временный отказ базы не повод выкинуть человека из документа с потерей
    // набранного: следующий проход повторит проверку.
    assert.equal(
      result.messages.some((one) => one.type === 'access.revoked'),
      false,
    );
    close(result);
  });
});

test('пропавшая страница отзывает всех', async () => {
  const answers = {
    ...AUTHORIZED,
    '/api/internal/collab/rights': { body: { gone: true, users: {} } },
  };
  await withChannel(answers, async ({ port, hocuspocus }) => {
    const result = await connect(port);
    await sweepOnce(hocuspocus);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(result.messages.some((one) => one.type === 'access.revoked'));
    close(result);
  });
});

test('чужой путь апгрейда закрывается', async () => {
  await withChannel(AUTHORIZED, async ({ port }) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/чужое`);
    const outcome = await new Promise((resolve) => {
      socket.on('error', () => resolve('отказ'));
      socket.on('open', () => resolve('открыт'));
    });
    assert.equal(outcome, 'отказ');
  });
});

test('секрет с кириллицей отвергается до обращения', async () => {
  // Заголовок HTTP допускает только видимые знаки латиницы. Без этой проверки
  // отказ приходит из недр клиента сообщением про ByteString, по которому
  // причину не найти.
  const { authorize } = await import('./backend.js');
  const before = process.env.COLLAB_INTERNAL_TOKEN;
  process.env.COLLAB_INTERNAL_TOKEN = 'секрет';
  try {
    await assert.rejects(
      () => authorize('токен', `page.${PAGE_ID}`),
      (error) => error.code === 'collab.internal_token_invalid',
    );
  } finally {
    process.env.COLLAB_INTERNAL_TOKEN = before;
  }
});
