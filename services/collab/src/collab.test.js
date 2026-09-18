/**
 * Tests of the collaborative editing channel.
 *
 * A real WebSocket connection is raised in full: the Hocuspocus protocol is not
 * only the messages but also the order of the hooks, and substituting the
 * server would be testing the substitute. The server half is substituted by a
 * local HTTP one: it has its own tests in Python, and what matters here is
 * exactly what was sent to it and how the answer was parsed.
 *
 * The fixtures are deliberately Cyrillic: non-ASCII content passing through the
 * channel costs nothing extra to check here.
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
  replicaFromEnv,
  sweepOnce,
  textOf,
} from './collab.js';

const require = createRequire(import.meta.url);
const { HocuspocusProvider } = require('@hocuspocus/provider');
const WebSocket = require('ws');

const PAGE_ID = '11111111-1111-4111-8111-111111111111';
const USER = { id: '22222222-2222-4222-8222-222222222222', name: 'Проверяющий' };

/** The substituted server half: it remembers the requests and answers as told. */
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
      response.end(
        JSON.stringify({ code: value?.code || 'not_found', ...(value?.params ? { params: value.params } : {}) }),
      );
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

/** Raise the pair "server half and channel" and run a check against them. */
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
    // The connections are dropped by force. `close` waits for each one to
    // close, and here they are held both by the editing socket and by the
    // keep-alive connection of the HTTP client: without this the test hangs
    // instead of finishing.
    http.closeAllConnections?.();
    fake.closeAllConnections?.();
    await new Promise((resolve) => http.close(resolve));
    await new Promise((resolve) => fake.close(resolve));
  }
}

/**
 * Connect with the client provider and wait for the outcome.
 *
 * The provider manages the socket itself: given one from outside it does not
 * connect without an explicit `attach`, and the test would silently wait for an
 * event that never comes.
 */
function connect(
  port,
  {
    token = 'token',
    documentName = `page.${PAGE_ID}`,
    // The document name also goes as an argument of the address: the proxy pins
    // the connection to a replica by it, and the server compares it with the
    // name from the protocol.
    address = `ws://127.0.0.1:${port}/collab?documentName=${encodeURIComponent(documentName)}`,
  } = {},
) {
  return new Promise((resolve) => {
    const messages = [];
    let provider;

    // A wait limit of our own: without it a refusal the client does not report
    // hangs the test instead of failing it.
    const guard = setTimeout(() => resolve({ ok: false, reason: 'no answer', provider, messages }), 5000);
    const done = (value) => {
      clearTimeout(guard);
      resolve(value);
    };

    provider = new HocuspocusProvider({
      url: address,
      WebSocketPolyfill: WebSocket,
      name: documentName,
      token,
      // Reconnecting is off: the test waits for one outcome rather than for
      // endless attempts after a refusal.
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
    /* already closed */
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
  // The ownership mark: a single replica, the document is always ours.
  '/api/internal/collab/owner': { body: { owned: true, ttlMs: 30000, renewEveryMs: 10000 } },
  '/api/internal/collab/owner/renew': { body: { lost: [], renewEveryMs: 10000 } },
  '/api/internal/collab/owner/release': { body: { released: true } },
};

test('the document name is parsed only in the known form', () => {
  assert.equal(pageIdOf(`page.${PAGE_ID}`), PAGE_ID);
  assert.equal(pageIdOf('page.'), null);
  assert.equal(pageIdOf('чужое'), null);
  assert.equal(pageIdOf(null), null);
});

test('the flat text is taken from the document', () => {
  const json = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Текст страницы' }] }],
  };
  assert.match(textOf(json), /Текст страницы/);
});

test('a broken document does not break the text computation', () => {
  // An empty string is not a loss: the text search recovers with the next save,
  // while a failure here would cut the whole save short.
  assert.equal(textOf({ type: 'выдуманный' }), '');
});

test('a connection asks the server half about the permissions', async () => {
  await withChannel(AUTHORIZED, async ({ port, seen }) => {
    const result = await connect(port);
    assert.equal(result.ok, true);
    close(result);

    const asked = seen.find((one) => one.path === '/api/internal/collab/authorize');
    assert.ok(asked, 'the permissions were not asked about');
    assert.equal(asked.body.documentName, `page.${PAGE_ID}`);
    assert.equal(asked.body.token, 'token');
  });
});

test('the document name in the address must match the name in the protocol', async () => {
  // The proxy pins a connection to a replica by the address, while the document
  // is opened by the protocol message. Names that diverged would bring the
  // connection to a replica the document does not live on.
  await withChannel(AUTHORIZED, async ({ port, seen }) => {
    const other = 'page.33333333-3333-4333-8333-333333333333';
    const result = await connect(port, {
      address: `ws://127.0.0.1:${port}/collab?documentName=${encodeURIComponent(other)}`,
    });
    assert.equal(result.ok, false, 'the connection opened with a foreign name in the address');
    close(result);
    assert.equal(
      seen.some((one) => one.path === '/api/internal/collab/authorize'),
      false,
      'the permissions were asked about even though the name in the address did not match',
    );
  });
});

test('with no name in the address the connection does not open', async () => {
  // Without the argument the proxy would put the connection on the replica of
  // an empty name — not on the one the document lives on.
  await withChannel(AUTHORIZED, async ({ port }) => {
    const result = await connect(port, { address: `ws://127.0.0.1:${port}/collab` });
    assert.equal(result.ok, false, 'the connection opened with no name in the address');
    close(result);
  });
});

test('the rollout flag admits a connection with no name and logs it', async (t) => {
  // Tabs opened before an update connect by the old address. With a single
  // replica they can be let through, but every such connection must stay in the
  // log: it is how one sees that the old tabs are still alive.
  const logged = t.mock.method(console, 'log', () => {});
  await withChannel(
    AUTHORIZED,
    async ({ port }) => {
      const result = await connect(port, { address: `ws://127.0.0.1:${port}/collab` });
      assert.equal(result.ok, true, 'with the flag on, a connection with no name did not open');
      close(result);
    },
    { allowUnnamed: true },
  );

  const lines = logged.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(
    lines.some((one) => one.includes('the allowance for connections with no document name in the address is on')),
    'the enabled allowance was not announced at startup',
  );
  const admitted = lines.find((one) => one.includes('a connection with no name in the address was admitted by the rollout flag'));
  assert.ok(admitted, 'the admitted connection was not written to the log');
  assert.ok(admitted.includes(`page.${PAGE_ID}`), 'the record does not name the document');
  assert.match(admitted, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'the record has no time in it');
});

test('with the rollout flag a name mismatch is still a refusal', async () => {
  await withChannel(
    AUTHORIZED,
    async ({ port, seen }) => {
      const other = 'page.33333333-3333-4333-8333-333333333333';
      const result = await connect(port, {
        address: `ws://127.0.0.1:${port}/collab?documentName=${encodeURIComponent(other)}`,
      });
      assert.equal(result.ok, false, 'the connection opened with a foreign name in the address');
      close(result);
      assert.equal(
        seen.some((one) => one.path === '/api/internal/collab/authorize'),
        false,
        'the permissions were asked about even though the name in the address did not match',
      );
    },
    { allowUnnamed: true },
  );
});

test('with the rollout flag an empty name in the address is a mismatch too', async () => {
  // The argument is there but empty: that is not an old tab but a broken
  // address, and the proxy would pin it by an empty key.
  await withChannel(
    AUTHORIZED,
    async ({ port }) => {
      const result = await connect(port, { address: `ws://127.0.0.1:${port}/collab?documentName=` });
      assert.equal(result.ok, false, 'the connection opened with an empty name in the address');
      close(result);
    },
    { allowUnnamed: true },
  );
});

test('the rollout flag is enabled only by an explicit value', () => {
  for (const value of ['', 'false', '0', 'yes', 'TRUE ']) {
    assert.equal(allowUnnamedFromEnv(value), false, `the value "${value}" enabled the allowance`);
  }
  assert.equal(allowUnnamedFromEnv('true'), true);
  assert.equal(allowUnnamedFromEnv('1'), true);

  const saved = process.env.COLLAB_ALLOW_UNNAMED_DOCUMENT;
  delete process.env.COLLAB_ALLOW_UNNAMED_DOCUMENT;
  try {
    assert.equal(allowUnnamedFromEnv(), false, 'with no variable set the allowance is on');
  } finally {
    if (saved !== undefined) process.env.COLLAB_ALLOW_UNNAMED_DOCUMENT = saved;
  }
});

test('the shared secret travels in a header of its own', async () => {
  await withChannel(AUTHORIZED, async ({ port, seen }) => {
    const result = await connect(port);
    close(result);
    assert.equal(seen[0].token, 'test-internal-token');
  });
});

test('a refusal from the server half closes the connection', async () => {
  await withChannel(
    { '/api/internal/collab/authorize': { status: 403, code: 'error.page.access_denied' } },
    async ({ port }) => {
      const result = await connect(port);
      assert.equal(result.ok, false, 'the connection opened with no permission');
      close(result);
    },
  );
});

test('the document loads from the state rather than from the json when the state is there', async () => {
  const answers = {
    ...AUTHORIZED,
    '/api/internal/collab/document': {
      body: {
        // The state of an empty document: what matters is that it is preferred
        // over the json.
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

test('an unparsed body does not break the connection and explains the reason', async () => {
  // A node the schema does not have: that happens after an import from another
  // system and after a rollback of the application version. Before, the
  // connection was dropped and a person saw a blank sheet with not a word about
  // the reason.
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
    assert.ok(notice, 'the reason never arrived');
    assert.ok(notice.reason.length > 0);
    close(result);
  });
});

test('an unparsed body is not saved over the page', async () => {
  // The document in memory is empty because the body did not parse. A write
  // would erase exactly the content the parse failed over.
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

    // The save is called directly: waiting for the document to unload by time
    // would mean holding the test for a minute for the sake of one call.
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
      // Immediately: otherwise the write is deferred for the debounce, and the
      // test finishes before the save is even attempted.
    }, true);

    assert.equal(
      seen.some((one) => one.path === '/api/internal/collab/store'),
      false,
      'an empty document went into the write',
    );
  });
});

test('a parsed body goes into the write by the same path', async () => {
  // The companion of the previous test: without it that one would pass even
  // with saving broken for any other reason.
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
    assert.ok(stored, 'the parsed document never went into the write');
    assert.match(stored.body.text, /Обычный текст/);
  });
});

test('the permission sweep revokes access and closes the connection', async () => {
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
    // The message goes out before the close: without it the editor on the
    // screen stays editable, and what is typed goes nowhere.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(
      result.messages.some((one) => one.type === 'access.revoked'),
      'the client never got the revocation message',
    );
    close(result);
  });
});

test('the sweep downgrades to read-only without a reconnect', async () => {
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
    assert.ok(changed, 'the client never got the permission-change message');
    assert.equal(changed.canEdit, false);
    close(result);
  });
});

test('an unreachable server half does not take access away', async () => {
  const answers = {
    ...AUTHORIZED,
    '/api/internal/collab/rights': { status: 500, code: 'oops' },
  };
  await withChannel(answers, async ({ port, hocuspocus }) => {
    const result = await connect(port);
    await sweepOnce(hocuspocus);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // A temporary database failure is no reason to throw a person out of the
    // document and lose what they typed: the next pass repeats the check.
    assert.equal(
      result.messages.some((one) => one.type === 'access.revoked'),
      false,
    );
    close(result);
  });
});

test('a page that disappeared revokes everyone', async () => {
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

test('a foreign upgrade path is closed', async () => {
  await withChannel(AUTHORIZED, async ({ port }) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/чужое`);
    const outcome = await new Promise((resolve) => {
      socket.on('error', () => resolve('refused'));
      socket.on('open', () => resolve('opened'));
    });
    assert.equal(outcome, 'refused');
  });
});

test('a secret with Cyrillic text is refused before the call', async () => {
  // An HTTP header admits visible Latin characters only. Without this check the
  // failure comes from the depths of the client as a message about a
  // ByteString, which tells nobody the reason.
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

/**
 * The ownership marks standing in for the application: shared by two replicas.
 *
 * The Redis rules are tested on the Python side against a real Redis. What
 * matters here is what the service does with the answers — admits, refuses,
 * renews, releases, and drops a document that was taken over.
 */
function ownerStore({ ttlMs = 30000, renewEveryMs = 10000, releases = true } = {}) {
  const marks = new Map();
  const released = [];
  const alive = (name) => {
    const mark = marks.get(name);
    if (mark && mark.until > Date.now()) return mark;
    marks.delete(name);
    return null;
  };
  const take = (name, replica) => {
    const mark = alive(name);
    if (mark && mark.owner !== replica) return mark.owner;
    marks.set(name, { owner: replica, until: Date.now() + ttlMs });
    return null;
  };
  return {
    marks,
    released,
    alive,
    answers: {
      '/api/internal/collab/owner': ({ documentName, replica }) => {
        const other = take(documentName, replica);
        return other
          ? { status: 409, code: 'error.collaboration.document_owned_elsewhere', params: { owner: other } }
          : { body: { owned: true, ttlMs, renewEveryMs } };
      },
      '/api/internal/collab/owner/renew': ({ documents, replica }) => ({
        body: {
          renewEveryMs,
          lost: documents
            .map((name) => ({ documentName: name, owner: take(name, replica) }))
            .filter((one) => one.owner),
        },
      }),
      '/api/internal/collab/owner/release': ({ documentName, replica }) => {
        released.push({ documentName, replica });
        // A replica that fell over cannot release the mark: such a run disables
        // releasing.
        if (releases && alive(documentName)?.owner === replica) marks.delete(documentName);
        return { body: { released: true } };
      },
    },
  };
}

/** Two replicas with a shared application: each has its own port and name. */
async function withReplicas(answers, run) {
  const { server: fake, seen } = backend(answers);
  const backendPort = await listen(fake);
  process.env.API_URL = `http://127.0.0.1:${backendPort}`;
  process.env.COLLAB_INTERNAL_TOKEN = 'test-internal-token';

  const replicas = [];
  for (const name of ['r1', 'r2']) {
    const { hocuspocus } = createCollabServer({ replica: name });
    const http = createServer((_, response) => response.end());
    attachCollab(http, hocuspocus);
    replicas.push({ name, hocuspocus, http, port: await listen(http) });
  }
  try {
    await run({ replicas, seen });
  } finally {
    for (const one of replicas) {
      await closeCollab(one.hocuspocus, { timeoutMs: 500 }).catch(() => {});
      one.http.closeAllConnections?.();
      await new Promise((resolve) => one.http.close(resolve));
    }
    fake.closeAllConnections?.();
    await new Promise((resolve) => fake.close(resolve));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The service log with no output: the lines are collected for the test. */
function captureLog(t) {
  const calls = t.mock.method(console, 'log', () => {});
  return () => calls.mock.calls.map((call) => String(call.arguments[0]));
}

const DOCUMENT = `page.${PAGE_ID}`;

test('the replica name is the explicit one from the environment, otherwise the host name', async () => {
  const { hostname } = await import('node:os');
  assert.equal(replicaFromEnv('replica-a'), 'replica-a');
  assert.equal(replicaFromEnv('  '), hostname());
  assert.equal(replicaFromEnv(''), hostname());
});

test('a document open on one replica is not served by another', async (t) => {
  const lines = captureLog(t);
  const store = ownerStore();
  await withReplicas({ ...AUTHORIZED, ...store.answers }, async ({ replicas: [first, second] }) => {
    const held = await connect(first.port);
    assert.equal(held.ok, true, 'the first replica did not open the document');

    const refused = await connect(second.port);
    assert.equal(refused.ok, false, 'the second replica opened a document taken by the first');
    assert.equal(store.alive(DOCUMENT)?.owner, 'r1', 'the mark left a live owning replica');
    close(refused);
    close(held);
  });
  assert.ok(
    lines().some((one) => one.includes(`${DOCUMENT}: the document is open on replica r1`)),
    'the log does not name the owning replica',
  );
});

test('after the owning replica falls over the document opens on another once the lifetime runs out', async () => {
  // A replica that fell over neither renews nor releases: the lifetime is
  // short, the renewal is rarer than the run, and releasing is disabled.
  const store = ownerStore({ ttlMs: 300, renewEveryMs: 60000, releases: false });
  await withReplicas({ ...AUTHORIZED, ...store.answers }, async ({ replicas: [first, second] }) => {
    const held = await connect(first.port);
    assert.equal(held.ok, true);
    close(held);

    const early = await connect(second.port);
    assert.equal(early.ok, false, 'the document was served before the mark lifetime ran out');
    close(early);

    await sleep(400);

    const later = await connect(second.port);
    assert.equal(later.ok, true, 'once the lifetime ran out the document still did not open');
    assert.equal(store.alive(DOCUMENT)?.owner, 'r2');
    close(later);
  });
});

test('a single replica: the renewal holds the mark, the unload releases it', async () => {
  const store = ownerStore({ ttlMs: 300, renewEveryMs: 100 });
  await withReplicas({ ...AUTHORIZED, ...store.answers }, async ({ replicas: [first, second] }) => {
    const held = await connect(first.port);
    assert.equal(held.ok, true);

    // Three times the lifetime: without the renewal the mark would have expired
    // long ago.
    await sleep(900);
    assert.equal(store.alive(DOCUMENT)?.owner, 'r1', 'the renewal did not hold the mark');
    const other = await connect(second.port);
    assert.equal(other.ok, false);
    close(other);

    close(held);
    for (let step = 0; step < 40 && !store.released.some((one) => one.replica === 'r1'); step += 1) {
      await sleep(50);
    }
    assert.ok(store.released.some((one) => one.replica === 'r1'), 'the unload did not release the mark');
    assert.equal(store.alive(DOCUMENT), null);

    const again = await connect(first.port);
    assert.equal(again.ok, true, 'the same replica did not open the document again');
    close(again);
  });
});

test('an unavailable mark store means a refusal with its own reason in the log', async (t) => {
  const lines = captureLog(t);
  const answers = {
    ...AUTHORIZED,
    '/api/internal/collab/owner': { status: 503, code: 'error.collaboration.owner_store_unavailable' },
  };
  await withChannel(answers, async ({ port }) => {
    const result = await connect(port);
    assert.equal(result.ok, false, 'with no mark store the connection opened');
    close(result);
  });
  const written = lines();
  assert.ok(written.some((one) => one.includes('the ownership mark store (Redis) is unavailable')));
  assert.ok(
    !written.some((one) => one.includes('the document is open on replica')),
    'unavailability was recorded as a taken document',
  );
});

test('a taken-over mark closes the connections and writes no state', async (t) => {
  const lines = captureLog(t);
  const store = ownerStore({ renewEveryMs: 100 });
  await withReplicas({ ...AUTHORIZED, ...store.answers }, async ({ replicas: [first], seen }) => {
    const held = await connect(first.port);
    assert.equal(held.ok, true);

    // The mark went to another replica while this one still holds the document.
    store.marks.set(DOCUMENT, { owner: 'r2', until: Date.now() + 30000 });
    await sleep(400);

    const document = first.hocuspocus.documents.get(DOCUMENT);
    assert.equal(document?.getConnectionsCount() ?? 0, 0, 'connections to the taken-over document are alive');
    close(held);
    await sleep(200);
    assert.equal(
      seen.some((one) => one.path === '/api/internal/collab/store'),
      false,
      'the state of the taken-over document went into the write',
    );
  });
  assert.ok(lines().some((one) => one.includes('the ownership mark is held by replica r2')));
});

test('the renewal goes in batches, and every part of the list is renewed', async () => {
  const store = ownerStore({ renewEveryMs: 100 });
  const second = 'page.44444444-4444-4444-8444-444444444444';
  await withChannel(
    { ...AUTHORIZED, ...store.answers },
    async ({ port, seen }) => {
      const first = await connect(port);
      const other = await connect(port, { documentName: second });
      assert.equal(first.ok && other.ok, true);

      await sleep(350);

      const renewals = seen.filter((one) => one.path === '/api/internal/collab/owner/renew');
      assert.ok(renewals.length >= 2, 'there were no renewals');
      assert.ok(
        renewals.every((one) => one.body.documents.length === 1),
        'one request carried more documents than the batch size allows',
      );
      const renewed = new Set(renewals.flatMap((one) => one.body.documents));
      assert.deepEqual([...renewed].sort(), [DOCUMENT, second].sort());
      close(first);
      close(other);
    },
    { replica: 'r1', renewBatch: 1 },
  );
});

test('a taken-over document that has not unloaded yet accepts no new connections', async (t) => {
  const lines = captureLog(t);
  const store = ownerStore({ renewEveryMs: 100 });
  const starter = 'page.55555555-5555-4555-8555-555555555555';
  await withChannel(
    { ...AUTHORIZED, ...store.answers },
    async ({ port, hocuspocus, seen }) => {
      // A direct connection holds the document in memory with no socket — the
      // same way an unload that has not finished does.
      const direct = await hocuspocus.openDirectConnection(DOCUMENT, {});
      store.marks.set(DOCUMENT, { owner: 'r2', until: Date.now() + 30000 });

      // Taking another document starts the renewal timer, and the renewal sees
      // the takeover of a document the replica still holds.
      const running = await connect(port, { documentName: starter });
      assert.equal(running.ok, true);
      await sleep(300);
      assert.ok(lines().some((one) => one.includes(`${DOCUMENT}: the ownership mark is held by replica r2`)));

      // The owner released the document, but the stale copy is still in the
      // memory of this replica.
      store.marks.delete(DOCUMENT);
      const again = await connect(port);
      assert.equal(again.ok, false, 'the connection continued a stale document');
      assert.ok(lines().some((one) => one.includes(`${DOCUMENT}: the document is still unloading after the ownership mark was taken over`)));
      close(again);

      await direct.disconnect();
      close(running);
      await sleep(200);
      assert.equal(
        seen.some((one) => one.path === '/api/internal/collab/store' && one.body.pageId === PAGE_ID),
        false,
        'stale state went into the write',
      );
    },
    { replica: 'r1' },
  );
});
