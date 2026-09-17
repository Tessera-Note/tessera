/**
 * Simultaneous editing of one page by several connections.
 *
 * Why. Collaborative editing was being checked with two tabs while the question
 * was about ten: do the edits converge, does the result reach the database, and
 * does the service stay alive. That cannot be checked by eye — ten tabs cannot
 * be typed into at once by hand, and a divergence shows up precisely in
 * simultaneity.
 *
 * What it does. It opens N connections to the editing channel of the stand with
 * the same protocol as the browser (`@hocuspocus/provider`), and each one adds
 * its own paragraphs in rounds, with no pauses between the connections. Then it
 * compares three things:
 *
 * 1. all the connections see one and the same document (a divergence would mean
 *    a lost edit);
 * 2. the document holds exactly as many added paragraphs as were sent (not a
 *    single edit was lost in the merge);
 * 3. after disconnecting and a pause for saving, the same thing is in the
 *    database — that is, the neighbour wrote the merged document rather than the
 *    last one it saw.
 *
 * What it does not check. All the connections come from one account: accounts
 * must not be created on the stand, and ten different people cannot be
 * portrayed here. It differs from ten real people in two things — the names in
 * the presence list and the number of permission checks in the service's walk.
 * The merging of the edits itself does not depend on the number of accounts.
 *
 * Run from the machine where the stand is up:
 *
 *     docker cp scripts/stand-session.py tessera-v2-api:/tmp/stand-session.py
 *     docker exec tessera-v2-api python /tmp/stand-session.py > /tmp/token
 *     TESSERA_TOKEN=$(cat /tmp/token) node scripts/collab-load.mjs <slugId>
 *
 * The variables: `TESSERA_URL` (default `http://localhost:8080`), `CLIENTS`
 * (10), `ROUNDS` (5), `HOLD_MS` (0 — keep the connections open after the edits,
 * to look at the presence list by eye).
 */

import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';

const BASE = process.env.TESSERA_URL || 'http://localhost:8080';
const TOKEN = process.env.TESSERA_TOKEN;
const CLIENTS = Number(process.env.CLIENTS || 10);
const ROUNDS = Number(process.env.ROUNDS || 5);
const HOLD_MS = Number(process.env.HOLD_MS || 0);

/** How long to wait for the neighbour to save. Its threshold is ten seconds. */
const SAVE_WAIT_MS = 20000;

const slug = process.argv[2];

if (!TOKEN || !slug) {
  console.error('TESSERA_TOKEN and the short name of the page as an argument are required');
  process.exit(1);
}

/** A call to the application on behalf of an open session. */
async function api(path, body) {
  const answer = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body ?? {})
  });
  if (!answer.ok) throw new Error(`${path}: ${answer.status} ${await answer.text()}`);
  return answer.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The text of the document without markup: the connections compare by it. */
function shape(document_) {
  return document_.getXmlFragment('default').toString();
}

/** How many paragraphs of this run are already in the document. */
function marked(text, mark) {
  return text.split(mark).length - 1;
}

const page = await api('/api/pages/info', { pageId: slug });
console.log(`page: ${page.title} (${page.id})`);

const name = `page.${page.id}`;
const mark = `load-${Date.now()}`;

const clients = [];
const synced = [];
for (let index = 0; index < CLIENTS; index += 1) {
  const { token } = await api('/api/auth/collab-token');
  const document_ = new Y.Doc();
  // Each connection has its own socket: the provider creates one itself when a
  // ready one is not passed. One socket for all would fold ten connections into
  // one.
  synced.push(
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`connection ${index} never arrived`)),
        30000
      );
      const provider = new HocuspocusProvider({
        // The document name also goes as an argument of the address: the proxy
        // pins the connection to a replica by it, and without it the service
        // refuses the connection.
        url: `${BASE.replace(/^http/, 'ws')}/collab?documentName=${encodeURIComponent(name)}`,
        name,
        document: document_,
        token,
        onSynced: () => {
          clearTimeout(timer);
          resolve();
        },
        onAuthenticationFailed: ({ reason }) => {
          clearTimeout(timer);
          reject(new Error(`connection ${index}: ${reason}`));
        }
      });
      // A connection announces itself in awareness the same way the browser
      // does: that is where both the foreign cursors and the presence list come
      // from. Without this the run would be visible in neither.
      provider.setAwarenessField('user', {
        id: `load-${index}`,
        name: `Connection ${index}`,
        color: `hsl(${(index * 47) % 360} 70% 55%)`,
        avatarUrl: null
      });
      clients.push({ index, provider, document: document_ });
    })
  );
}

await Promise.all(synced);
console.log(`connections established: ${clients.length}`);

const before = marked(shape(clients[0].document), mark);

for (let round = 0; round < ROUNDS; round += 1) {
  // No pauses between the connections: a divergence shows up precisely in
  // simultaneity, and taken in turn even a broken merge converges.
  for (const one of clients) {
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText(`${mark} connection ${one.index} round ${round}`)]);
    one.document.getXmlFragment('default').push([paragraph]);
  }
  await sleep(100);
}

const expected = before + CLIENTS * ROUNDS;
await sleep(3000);

const shapes = clients.map((one) => shape(one.document));
const same = new Set(shapes).size === 1;
const counted = marked(shapes[0], mark);

console.log(`paragraphs sent: ${CLIENTS * ROUNDS}`);
console.log(`seen by the connections: ${counted} (expected ${expected})`);
console.log(`documents match: ${same ? 'yes' : 'NO'}`);

if (!same) {
  const sizes = shapes.map((one) => one.length);
  console.log(`document lengths: ${sizes.join(', ')}`);
}

if (HOLD_MS > 0) {
  console.log(`holding the connections for ${HOLD_MS / 1000} s...`);
  await sleep(HOLD_MS);
}

for (const one of clients) {
  one.provider.destroy();
}

console.log(`waiting ${SAVE_WAIT_MS / 1000} s for the save...`);
await sleep(SAVE_WAIT_MS);

const stored = await api('/api/pages/info', { pageId: slug });
const storedText = JSON.stringify(stored.content);
const inDatabase = marked(storedText, mark);
console.log(`paragraphs of this run in the database: ${inDatabase}`);

const verdict = same && counted === expected && inDatabase === CLIENTS * ROUNDS;
console.log(verdict ? 'RESULT: converges' : 'RESULT: divergence');
process.exit(verdict ? 0 : 1);
