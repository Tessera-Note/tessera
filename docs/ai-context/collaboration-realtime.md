# Collaborative editing and events

## Two channels

They must not be substituted for one another.

| Channel | Transport | What it carries | Where it lives |
| --- | --- | --- | --- |
| `/collab` | Hocuspocus over WebSocket, documents `page.<pageId>` | document content | `services/collab` |
| `/socket.io` | Socket.IO | page tree, pages, comments, notifications | `services/realtime.py`, `api/realtime.py` |

## The collaboration service

`services/collab` on Node is the closed exception to the "runtime in Python"
rule. The reason: it owns the editor node schema (Tiptap extensions) and the
Hocuspocus protocol, and a second description of either in Python would drop
document nodes silently, with no error at all.

The exception is limited to those two subjects. Authorization decisions and
database writes stay in Python: the neighbour asks for them over internal
routes.

| Route | What for |
| --- | --- |
| `/api/internal/collab/authorize` | whether to admit this person to this document |
| `/api/internal/collab/document` | return the current state of the document |
| `/api/internal/collab/store` | save the state |
| `/api/internal/collab/rights` | what permissions the person has on the page |

The routes are public to the guard and protected by the shared secret
`COLLAB_INTERNAL_TOKEN`. The value travels in an HTTP header, hence Latin
letters and digits only.

## Pinning to a replica

A document lives in the memory of the `services/collab` process, so every
connection to it must land in the same process. The client passes the document
name as a query argument (`collabAddress(name)` in
`lib/features/editor/collab.ts` → `/collab?documentName=page.<id>`), the proxy
picks the replica by it (`hash $arg_documentName consistent` in
`deploy/nginx/*`), and the service compares the argument with the name from the
protocol in `onAuthenticate`, refusing the connection when they differ or when
the argument is missing. The proxy does not parse the first protocol message —
pinning by it is not possible.

The set of replicas is changed by restarting the proxy, not by `reload`: a
re-read configuration does not break open connections.

## Save thresholds

The service reads four thresholds: `COLLAB_DEBOUNCE_MS`,
`COLLAB_MAX_DEBOUNCE_MS`, `COLLAB_BACKEND_TIMEOUT_MS`,
`COLLAB_SWEEP_INTERVAL_MS`. They decide how often the state goes off to be
saved and when a document is unloaded from memory.

The document name in the connection address (`?documentName=`) must match the
name from the protocol; a missing argument is a refusal too (`onAuthenticate` in
`services/collab/src/collab.js`). There is one exception:
`COLLAB_ALLOW_UNNAMED_DOCUMENT=true` admits connections without the argument —
tabs opened before an update. Only with a single replica; every admitted
connection is written to the log with the document name and the time, and
mismatched names are refused even with the flag on. Before a second replica the
flag is turned off.

A document is open on one replica only, and an ownership mark in Redis holds it.
The mark is managed by the application (`services/collab_owner.py`, routes
`/api/internal/collab/owner`, `owner/renew`, `owner/release` under the same
shared secret); the key is `collab:owner:<document name>` and the value is the
replica name (`COLLAB_REPLICA_ID`, the host name by default). The service takes
the mark in `onAuthenticate` after the permission check, renews all open
documents on a timer with the period from the response, and releases it in
`afterUnloadDocument`. The lifetime and the period are application settings
`COLLAB_OWNER_TTL_MS` (30000) and `COLLAB_OWNER_RENEW_MS` (10000), and the renew
period must be shorter than the lifetime. A refusal for a document owned
elsewhere (409, `error.collaboration.document_owned_elsewhere`, with the owner
name) and one for an unreachable Redis (503,
`error.collaboration.owner_store_unavailable`) are written to the log as
different lines. A mark taken over by another replica comes back from the renew
call in the list of lost documents: the replica closes the connections for such
a document and does not save it.

## The service image

The base has glibc rather than Alpine: PDF parsing goes through the native module
`@docmost/pdf-inspector`, which has no musl build. On Alpine it fails with
"Cannot find native binding" on the very first call.

The package is declared in the root `package.json`: the `services` directory is
not part of the pnpm workspace, and the package manager does not read a manifest
there.

## Losing the connection

The editor screen (`apps/web/src/lib/features/editor/Editor.svelte`) holds three
rules, and each one stands on its own reason.

- **The document is assembled from two sources**: the server and the browser
  store (`y-indexeddb`, the record name is the same — `page.<pageId>`). The store
  keeps edits typed with no connection: without it they live only in the tab's
  memory and disappear when it reloads. Seeding the body waits for both sources
  (`seedDecision` in `collab.ts`) — deciding on one gives a page with its
  content doubled.
- **While the collaborative document has not arrived, `DocumentView` is shown**
  with the body that came with the page itself. Otherwise, with
  `services/collab` unreachable, the whole wiki looks empty.
- **The token is requested before every handshake** (`token` as a function
  argument, not a string). It lives for a day and a tab lives longer; with an
  expired one the channel refuses, and the tab would stay disconnected forever.

The channel state is computed by `nextStatus`: the library retries and reports
`connecting` on every attempt, and without that rule the message about a lost
connection would be overwritten by the word "loading".

A refusal from the service (`onAuthenticationFailed`: the name in the address did
not match — a tab opened before an update — or the permissions were not
confirmed) is shown as a prominent `ConnectionRefused.svelte` block with a
reload button. On a refusal the socket stays open and the channel state looks
healthy, so without the block the tab would seem fine. The block is removed by
`onAuthenticated` if the channel passes the check later.

## Presence

Who else has the page open comes from the awareness of the same channel: the
foreign-cursor extension announces itself (`CollaborationCaret`, the `user`
argument), and `onAwarenessChange` on the connection reads it. There is
deliberately no second source — a call to the server would lag behind, and the
list would hold a person whose cursor is no longer in the text.

Parsing is in `lib/features/editor/presence.ts` (`presentPeople`): your own tab
is dropped by `clientId`, and several tabs of one person are merged by account
identifier. Display is `lib/components/page/PagePresence.svelte`, at the bottom
of the sheet; an empty list is not drawn at all.

## Events

`services/realtime.py` broadcasts events through Redis. The screen subscribes in
`lib/features/realtime/socket.ts`.

A change to the tree must do three things consistently: update the local screen
state, call the server and emit an event. Skipping any of them desyncs the tabs.

## The title is edited outside the collaborative document

The title and the icon are saved with an ordinary request rather than through
Yjs. There is no silent overwrite: the server broadcasts
`page:heading:updated`, an open tab updates them without a reload, and saving
over someone else's change is refused — the editor sends the title it saw
(`expected_title` in `PageService.update`), and a mismatch answers
`error.page.title_changed_elsewhere`.
