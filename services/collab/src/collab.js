/**
 * The collaborative editing channel.
 *
 * The Hocuspocus protocol over Yjs, the path `/collab`, the document name
 * `page.<id>` — all as in the earlier version: the client is not rewritten, it
 * connects to another process over the same protocol.
 *
 * The state of the document and the editor node schema live here. Permissions
 * and database writes live on the Python side, and every question about them
 * goes there. The split is not a matter of taste: the node schema is described
 * by Tiptap extensions, and a second description of it loses nodes silently,
 * while permissions described twice diverge.
 */

import { createRequire } from 'node:module';
import { hostname } from 'node:os';

import { WebSocketServer } from 'ws';

import {
  authorize,
  claimDocument,
  loadDocument,
  releaseDocument,
  renewDocuments,
  rights,
  storeDocument,
} from './backend.js';
import { tiptapExtensions } from './extensions.js';

const require = createRequire(import.meta.url);

const { Hocuspocus } = require('@hocuspocus/server');
const { TiptapTransformer } = require('@hocuspocus/transformer');
const { generateText } = require('@tiptap/core');
const Y = require('yjs');

/** The name of the document field in Yjs. Shared with the client. */
const FIELD = 'default';

/** The document name: `page.<page identifier>`. */
const DOCUMENT_PREFIX = 'page.';

/**
 * How long after the last edit to save, and how long the saving may be put off.
 * The values come from the earlier version: more often means a queue of waiting
 * transactions on one row, less often means a wider window for losing edits if
 * the process falls over.
 */
const DEBOUNCE_MS = Number(process.env.COLLAB_DEBOUNCE_MS || 10000);
const MAX_DEBOUNCE_MS = Number(process.env.COLLAB_MAX_DEBOUNCE_MS || 45000);

/**
 * How often the permissions of already open connections are re-checked.
 *
 * A connection is checked once, while a session lasts for hours. Without the
 * sweep, a person who was removed from a space keeps writing into the open
 * document until they close the tab themselves.
 */
const SWEEP_INTERVAL_MS = Number(process.env.COLLAB_SWEEP_INTERVAL_MS || 30000);

/** The service messages of the channel. The client parses them in `onStateless`. */
export const ACCESS_REVOKED = 'access.revoked';
export const ACCESS_CHANGED = 'access.changed';
export const DOCUMENT_UNREADABLE = 'document.unreadable';

/** The close code used when access is revoked. The same as in the earlier version. */
const FORBIDDEN = { code: 4403, reason: 'Forbidden' };

export function pageIdOf(documentName) {
  if (typeof documentName !== 'string' || !documentName.startsWith(DOCUMENT_PREFIX)) {
    return null;
  }
  return documentName.slice(DOCUMENT_PREFIX.length) || null;
}

/**
 * The flat text of a document.
 *
 * Computed here rather than on the Python side: it follows from the same node
 * schema, and a second computation of it would diverge from the first on
 * exactly the nodes this service exists for. An empty string on a refused parse
 * is not a loss: the text search recovers with the next save.
 */
export function textOf(json) {
  try {
    return generateText(json, tiptapExtensions);
  } catch {
    return '';
  }
}

/**
 * Who edited the document since the last save.
 *
 * The server half needs the list: whoever edited becomes a watcher of the page,
 * and the update feed is built from the same people. It is kept by document
 * name and cleared together with the save: otherwise the same person would end
 * up in every following save until the document is unloaded from memory.
 */
class Contributors {
  constructor() {
    this.byDocument = new Map();
  }

  add(documentName, userId) {
    if (!userId) return;
    let known = this.byDocument.get(documentName);
    if (!known) {
      known = new Set();
      this.byDocument.set(documentName, known);
    }
    known.add(userId);
  }

  consume(documentName) {
    const known = this.byDocument.get(documentName);
    if (!known) return [];
    this.byDocument.delete(documentName);
    return [...known];
  }

  forget(documentName) {
    this.byDocument.delete(documentName);
  }
}

function log(message) {
  console.log(`[collab] ${message}`);
}

/**
 * Revoking access for one connection.
 *
 * The message goes out before the close: `close` sends the client only the
 * reason string, and a revocation cannot be told from an ordinary disconnect by
 * it. Without an explicit message the editor on the screen stays editable, and
 * what is typed goes into the local document, that is, nowhere.
 */
function revoke(connection, documentName, reason) {
  try {
    connection.sendStateless(JSON.stringify({ type: ACCESS_REVOKED, reason }));
  } catch {
    // The socket may have closed between the sweep and the send; not an error.
  }
  try {
    connection.close(FORBIDDEN);
  } catch {
    // The same as above.
  }
  log(`a connection was disconnected from ${documentName}: ${reason}`);
}

/**
 * Downgrading to read-only, and giving the write permission back.
 *
 * The value is computed anew on every pass rather than only lowered: a
 * restored permission must come back without a reconnect.
 */
function applyReadOnly(connection, readOnly, documentName) {
  if (connection.readOnly === readOnly) return;
  connection.readOnly = readOnly;
  try {
    connection.sendStateless(JSON.stringify({ type: ACCESS_CHANGED, canEdit: !readOnly }));
  } catch {
    // See `revoke`.
  }
  log(`${documentName}: the connection was switched to ${readOnly ? 'read-only' : 'editing'} mode`);
}

/**
 * The allowance for connections with no document name in the address.
 *
 * Only for the duration of a rollout, and only with a single replica: tabs
 * opened before an update connect by the old address, with no argument, and
 * without the allowance they stop synchronizing until a reload. With two
 * replicas the allowance is dangerous — the proxy puts such a connection on a
 * replica other than the one the document lives on. So it is off by default,
 * and every admitted connection is written to the log.
 */
export function allowUnnamedFromEnv(value = process.env.COLLAB_ALLOW_UNNAMED_DOCUMENT) {
  return value === 'true' || value === '1';
}

/**
 * The replica name for the ownership mark of a document.
 *
 * The host name by default: for a container that is its identifier, so two
 * replicas differ with no configuration. An explicit name is needed when the
 * replicas run outside containers on one host.
 */
export function replicaFromEnv(value = process.env.COLLAB_REPLICA_ID) {
  return (typeof value === 'string' && value.trim()) || hostname();
}

/** The failure codes of the ownership mark. The same ones the application serves. */
const OWNED_ELSEWHERE = 'error.collaboration.document_owned_elsewhere';
const OWNER_STORE_UNAVAILABLE = 'error.collaboration.owner_store_unavailable';

/**
 * How many documents go in one renewal request. A replica may have any number
 * of open documents, while a request to the application must stay short; the
 * application renews the whole list it was sent.
 */
const RENEW_BATCH = 500;

export function createCollabServer({
  allowUnnamed = allowUnnamedFromEnv(),
  replica = replicaFromEnv(),
  renewBatch = RENEW_BATCH,
} = {}) {
  const contributors = new Contributors();

  if (allowUnnamed) {
    log('the allowance for connections with no document name in the address is on: only with a single replica');
  }

  /**
   * The ownership mark of the documents of this replica.
   *
   * A Yjs document lives in the memory of one replica, and opened on two at
   * once it diverges silently. The mark is held by the application in Redis:
   * take it on connect, renew it while the document is open, release it on
   * unload. The renewal period comes in the answer to the take — the lifetime
   * and the period live in the settings of the application, and there is no
   * second copy of them here.
   */
  const ownership = { renewEveryMs: null, timer: null, running: false };
  /** Documents whose mark another replica took over: do not save those. */
  const lost = new Set();

  async function claim(documentName) {
    if (lost.has(documentName) && hocuspocus.documents.has(documentName)) {
      // A taken-over document is still in memory: the connections are closed
      // and the unload has not finished. Taking the mark now, the replica would
      // continue from stale state and would save it over the edits of the
      // owner. The client connects again once the document is unloaded.
      log(`${documentName}: the document is still unloading after the ownership mark was taken over, connection refused`);
      throw new Error('document is still unloading after ownership was lost');
    }
    let answer;
    try {
      answer = await claimDocument(documentName, replica);
    } catch (error) {
      if (error?.code === OWNED_ELSEWHERE) {
        log(
          `${documentName}: the document is open on replica ${error.params?.owner ?? 'unknown'}, connection refused`,
        );
      } else if (error?.code === OWNER_STORE_UNAVAILABLE) {
        log(`${documentName}: the ownership mark store (Redis) is unavailable, connection refused`);
      } else {
        log(
          `${documentName}: the ownership mark was not taken (${error?.message || error}), connection refused`,
        );
      }
      throw error;
    }
    lost.delete(documentName);
    startRenewal(Number(answer?.renewEveryMs) || null);
  }

  function startRenewal(everyMs) {
    if (!everyMs) return;
    if (ownership.timer && ownership.renewEveryMs === everyMs) return;
    if (ownership.timer) clearInterval(ownership.timer);
    ownership.renewEveryMs = everyMs;
    ownership.timer = setInterval(renewOnce, everyMs);
    ownership.timer.unref();
  }

  function stopRenewal() {
    if (ownership.timer) clearInterval(ownership.timer);
    ownership.timer = null;
    ownership.renewEveryMs = null;
  }

  async function renewOnce() {
    if (ownership.running) return;
    const names = [...hocuspocus.documents.keys()];
    if (names.length === 0) {
      // There are no open documents — nothing to renew; the next take will
      // start the timer again.
      stopRenewal();
      return;
    }
    ownership.running = true;
    try {
      for (let start = 0; start < names.length; start += renewBatch) {
        const answer = await renewDocuments(names.slice(start, start + renewBatch), replica);
        for (const one of answer?.lost ?? []) {
          dropLost(one.documentName, one.owner);
        }
      }
    } catch (error) {
      // Unavailability is no reason to drop the connections: the mark lives out
      // its lifetime, and the next pass renews it. If the document moves to
      // another replica in the meantime, the next answer returns it in the list
      // of the lost.
      log(`the ownership marks were not renewed: ${error?.message || error}`);
    } finally {
      ownership.running = false;
    }
  }

  /**
   * Another replica took the mark over: the document is no longer ours here.
   *
   * The connections are closed and the save is skipped: writing state that has
   * diverged from the owning replica would erase its edits. The client
   * reconnects and lands on the owner, or gets a refusal asking it to reload
   * the page.
   */
  function dropLost(documentName, owner) {
    const document = hocuspocus.documents.get(documentName);
    if (!document) return;
    lost.add(documentName);
    log(
      `${documentName}: the ownership mark is held by replica ${owner}, connections closed, saving skipped`,
    );
    for (const connection of document.getConnections()) {
      try {
        connection.close();
      } catch {
        // The connection may have closed by itself; not an error.
      }
    }
  }

  /**
   * The documents that could not be parsed, and the reason for each.
   *
   * That happens when the body contains a node the editor schema does not have:
   * after an import from another system, and after a rollback of the
   * application version. A record here does two things: it forbids saving — an
   * empty document in memory would erase the whole page — and it gives the
   * reason to whoever connects, instead of a blank sheet with not a word on it.
   */
  const unreadable = new Map();

  const hocuspocus = new Hocuspocus({
    debounce: DEBOUNCE_MS,
    maxDebounce: MAX_DEBOUNCE_MS,
    // A log of our own instead of the standard one: that one writes every
    // connection line by line and, on a dozen tabs, turns the log into a
    // stream.
    quiet: true,

    async onAuthenticate({ documentName, token, connectionConfig, requestParameters }) {
      // The document name arrives twice: as an argument of the address and in
      // the first protocol message. The proxy pins a connection to a replica by
      // the address — it does not parse messages — while the document is opened
      // by the message. Diverging, they would bring the connection to a replica
      // the document does not live on, and the edits of two replicas on one
      // document would not converge, silently. So a mismatch, like a missing
      // argument, is a refusal. A missing argument is let through only by the
      // rollout allowance (`allowUnnamedFromEnv`), and every such connection
      // stays in the log.
      const named = requestParameters?.get('documentName') ?? null;
      if (named === null && allowUnnamed) {
        log(
          `${documentName}: a connection with no name in the address was admitted by the rollout flag, ${new Date().toISOString()}`,
        );
      } else if (named !== documentName) {
        log(`${documentName}: the name in the connection address did not match the document name`);
        throw new Error('document name mismatch');
      }
      const answer = await authorize(token, documentName);
      // The mark comes after the permissions: someone with no access does not
      // pin a document to a replica.
      await claim(documentName);
      if (!answer?.canEdit) {
        connectionConfig.readOnly = true;
      }
      return { user: answer.user, pageId: answer.pageId };
    },

    async onLoadDocument({ documentName }) {
      const pageId = pageIdOf(documentName);
      if (!pageId) return new Y.Doc();

      const answer = await loadDocument(pageId);

      if (answer?.ydoc) {
        // The binary state comes first: it holds the history of edits, which
        // the JSON does not, and restoring from JSON loses the unfinished edits
        // of open tabs.
        const document = new Y.Doc();
        Y.applyUpdate(document, new Uint8Array(Buffer.from(answer.ydoc, 'base64')));
        return document;
      }

      if (answer?.content) {
        try {
          const document = TiptapTransformer.toYdoc(answer.content, FIELD, tiptapExtensions);
          // It parsed: the earlier "unreadable" record is removed. Otherwise a
          // page repaired by an edit to its body would stay locked until the
          // process restarts.
          unreadable.delete(documentName);
          return document;
        } catch (error) {
          const reason = String(error?.message || error);
          unreadable.set(documentName, reason);
          log(`${documentName}: the body was not parsed, ${reason}`);
          // An empty document rather than a refused connection: the client
          // reads a refusal as a dropped connection and reconnects without end.
          // Nothing is lost by it — saving is forbidden below for such a
          // document.
          return new Y.Doc();
        }
      }

      unreadable.delete(documentName);
      return new Y.Doc();
    },

    /**
     * Tell whoever connected that the body of the page was not parsed.
     *
     * To every connection separately rather than by a broadcast over the
     * document: people connect at different times, and a broadcast would only
     * reach those who were already there.
     */
    async connected({ documentName, connection }) {
      const reason = unreadable.get(documentName);
      if (!reason) return;
      try {
        connection.sendStateless(JSON.stringify({ type: DOCUMENT_UNREADABLE, reason }));
      } catch {
        // See `revoke`: the connection may have closed while the answer was on
        // its way.
      }
    },

    async onStoreDocument({ documentName, document, context }) {
      const pageId = pageIdOf(documentName);
      if (!pageId) return;

      if (unreadable.has(documentName)) {
        // The body did not parse, and the document in memory is empty. A write
        // would erase the whole page — exactly the content the parse failed
        // over. No edits are lost here: there is nothing to edit, the document
        // is empty.
        log(`${documentName}: saving skipped, the body was not parsed`);
        return;
      }

      if (lost.has(documentName)) {
        // Another replica holds the mark: its state is newer, and writing this
        // one would erase its edits. See `dropLost`.
        log(`${documentName}: saving skipped, the mark is owned by another replica`);
        return;
      }

      const json = TiptapTransformer.fromYdoc(document, FIELD);
      const state = Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64');
      const editors = contributors.consume(documentName);

      let answer;
      try {
        answer = await storeDocument({
          pageId,
          userId: context?.user?.id,
          content: json,
          text: textOf(json),
          ydoc: state,
          contributors: editors,
        });
      } catch (error) {
        // Those who edited go back into the list: otherwise they disappear from
        // the watchers of the page, and there would be nobody left to repeat
        // the save.
        for (const one of editors) contributors.add(documentName, one);
        throw error;
      }

      if (answer?.saved) {
        document.broadcastStateless(
          JSON.stringify({
            type: 'page.updated',
            updatedAt: answer.updatedAt,
            lastUpdatedById: context?.user?.id,
            lastUpdatedBy: context?.user,
          }),
        );
      }
    },

    async onChange({ documentName, context }) {
      contributors.add(documentName, context?.user?.id);
    },

    async afterUnloadDocument({ documentName }) {
      contributors.forget(documentName);
      // The "unreadable" record goes away with the document: on the next
      // opening the body is read anew, and it may have changed.
      unreadable.delete(documentName);
      // The ownership mark is released on unload, so that the document does not
      // wait for the lifetime to run out. A taken-over one is not ours to
      // release: it belongs to another replica, and the application will not
      // release someone else's.
      if (lost.delete(documentName)) return;
      try {
        await releaseDocument(documentName, replica);
      } catch (error) {
        log(`${documentName}: the ownership mark was not released (${error?.message || error}), it will expire by its lifetime`);
      }
    },
  });

  return { hocuspocus, contributors };
}

/**
 * One pass of the permission re-check.
 *
 * One check per person rather than per connection: one person may have several
 * tabs with the same page, and asking about the permissions for each one means
 * multiplying the database queries by the number of tabs.
 */
export async function sweepOnce(hocuspocus) {
  for (const document of hocuspocus.documents.values()) {
    const connections = document.getConnections();
    if (connections.length === 0) continue;

    const byUser = new Map();
    for (const connection of connections) {
      const userId = connection.context?.user?.id;
      if (!userId) {
        // The context is set by `onAuthenticate`, and a connection without one
        // cannot exist. If one has appeared, the permissions of an unknown
        // person cannot be checked, and leaving it unchecked is worse still.
        revoke(connection, document.name, 'a connection with no user');
        continue;
      }
      const known = byUser.get(userId);
      if (known) known.push(connection);
      else byUser.set(userId, [connection]);
    }

    if (byUser.size === 0) continue;

    let answer;
    try {
      answer = await rights(document.name, [...byUser.keys()]);
    } catch (error) {
      // An unreachable server half is no reason to take access away: it is a
      // temporary failure, while a revocation throws a person out of the
      // document and loses what they typed.
      log(`the permissions for ${document.name} were not checked: ${error?.message || error}`);
      continue;
    }

    if (answer?.gone) {
      for (const connection of connections) {
        revoke(connection, document.name, 'the page was not found');
      }
      continue;
    }

    for (const [userId, userConnections] of byUser) {
      const verdict = answer?.users?.[userId];
      if (!verdict || !verdict.allowed) {
        for (const connection of userConnections) {
          revoke(connection, document.name, 'access to the page was revoked');
        }
        continue;
      }
      for (const connection of userConnections) {
        applyReadOnly(connection, !verdict.canEdit, document.name);
      }
    }
  }
}

/** The re-check timer. The passes do not overlap: a slow database would stretch the sweep. */
export function startSweep(hocuspocus, intervalMs = SWEEP_INTERVAL_MS) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await sweepOnce(hocuspocus);
    } catch (error) {
      log(`the permission sweep was interrupted: ${error?.message || error}`);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Stopping the channel: wait for the documents to unload and close the
 * connections.
 *
 * Simply closing the sockets is not possible: saving in Hocuspocus is deferred,
 * and dropping a connection before the document is unloaded loses the last
 * edits. So the connections are closed first, and the wait runs until not a
 * single document is left in memory.
 */
export function closeCollab(hocuspocus, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    if (hocuspocus.getDocumentsCount() === 0) {
      resolve();
      return;
    }

    // A wait limit is mandatory: a document whose save never goes through would
    // hang the shutdown of the process forever.
    const guard = setTimeout(resolve, timeoutMs);
    hocuspocus.configuration.extensions.push({
      async afterUnloadDocument({ instance }) {
        if (instance.getDocumentsCount() === 0) {
          clearTimeout(guard);
          resolve();
        }
      },
    });
    hocuspocus.closeConnections();
  });
}

/**
 * Accepting connections on the `/collab` path.
 *
 * The upgrade is intercepted by hand: the HTTP for content conversion works on
 * the same port, and the sockets must not be handed to it, nor the other way
 * round.
 */
export function attachCollab(httpServer, hocuspocus) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url, `ws://${request.headers.host || 'localhost'}/`).pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname !== '/collab') {
      // A foreign path is closed at once: a socket left hanging on an unknown
      // path holds a connection and gives neither an answer nor a refusal.
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (websocket) => {
      hocuspocus.handleConnection(websocket, request);
    });
  });

  return wss;
}
