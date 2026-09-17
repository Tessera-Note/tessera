/**
 * Calls to the server half.
 *
 * There is not a single permission decision or database write here: both are
 * described on the Python side and must have no second description. This file
 * only asks and passes the answer on.
 *
 * The secret travels in a header of its own rather than in `Authorization`:
 * that one carries the tokens of people, and two different ways of presenting
 * yourself must not be confused, not even by name.
 */

/**
 * The environment is read on every call rather than when the file is loaded.
 *
 * A value taken at load time ties the address to the order of imports: a file
 * imported before the environment is set remembers the default address forever.
 * In the tests that looks like a hung request to a host that does not exist,
 * and in a deployment like a call to the wrong place after a variable changed.
 */
function settings() {
  return {
    apiUrl: (process.env.API_URL || 'http://tessera-v2-api:3000').replace(/\/+$/, ''),
    token: process.env.COLLAB_INTERNAL_TOKEN || '',
    // How long to wait for an answer. The calls are short: one database query.
    timeoutMs: Number(process.env.COLLAB_BACKEND_TIMEOUT_MS || 10000),
  };
}

/**
 * A failure of the server half, with the code kept.
 *
 * The caller needs the code: "no access" closes the connection silently, while
 * an unreachable database is a temporary failure after which the client
 * reconnects.
 */
export class BackendError extends Error {
  constructor(status, code, message, params) {
    super(message || code || `HTTP ${status}`);
    this.name = 'BackendError';
    this.status = status;
    this.code = code;
    // The details of a failure: for a taken document, which replica holds it.
    this.params = params || {};
  }
}

async function call(path, payload) {
  const { apiUrl, token: internalToken, timeoutMs } = settings();

  if (!internalToken) {
    // Without the secret the internal routes are off on that side. The refusal
    // happens here rather than there: otherwise every connection would cost a
    // request over the network for the same answer.
    throw new BackendError(0, 'collab.internal_token_missing', 'COLLAB_INTERNAL_TOKEN is not set');
  }

  if (!/^[\x21-\x7e]+$/.test(internalToken)) {
    // An HTTP header admits visible Latin characters only. A secret with
    // Cyrillic text or a space breaks the call itself, and the failure comes
    // from the depths of the client as a message about a ByteString, which
    // tells nobody the reason.
    throw new BackendError(
      0,
      'collab.internal_token_invalid',
      'COLLAB_INTERNAL_TOKEN must consist of visible Latin characters',
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-token': internalToken,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    throw new BackendError(0, 'collab.backend_unreachable', String(error?.message || error));
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // The body did not parse: for a failure that does not matter, and for a
    // success it means the other end is not our route.
    body = null;
  }

  if (!response.ok) {
    throw new BackendError(response.status, body?.code, body?.message, body?.params);
  }
  return body;
}

export function authorize(token, documentName) {
  return call('/api/internal/collab/authorize', { token, documentName });
}

export function loadDocument(pageId) {
  return call('/api/internal/collab/document', { pageId });
}

export function storeDocument(payload) {
  return call('/api/internal/collab/store', payload);
}

export function rights(documentName, userIds) {
  return call('/api/internal/collab/rights', { documentName, userIds });
}

/**
 * The ownership mark of a document. The application decides: the lifetime and
 * the renewal period live in its settings, and Redis is on its side.
 */
export function claimDocument(documentName, replica) {
  return call('/api/internal/collab/owner', { documentName, replica });
}

export function renewDocuments(documents, replica) {
  return call('/api/internal/collab/owner/renew', { documents, replica });
}

export function releaseDocument(documentName, replica) {
  return call('/api/internal/collab/owner/release', { documentName, replica });
}
