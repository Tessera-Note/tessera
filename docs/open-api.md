# External API

The application routes are available with a personal API key. The key arrives in
the `Authorization: Bearer <key>` header and inherits the permissions of the
person who created it: the page access check goes the same way as it does for a
request from the browser.

The same header also carries an ordinary sign-in token. There is no way to tell
them apart by looking — the kind is recorded inside the signed part — so
`api/guards.py` first tries to read a token and then a key.

## Format

The response is returned as it is, without a wrapper. A failure arrives as
`{code, message, params}`, where `code` is a stable key such as
`error.auth.session_expired`. What a person should see is the translation of the
code, not `message`: `message` is English and meant for a developer.

Actions are `POST` requests with a body rather than REST by method. Uploading and
serving files return their natural response, not JSON.

Lists are paginated: the cursor is a composite key, and the end of a list is
shown by an empty `nextCursor`, not by a short page. Permission filtering drops
rows after the query, so a page is sometimes shorter than the one requested.

## Managing keys

`/api/api-keys`: list, create, rename, revoke. A key is stored as a hash and
returned in full exactly once, when it is created.

## What is available

| Area | Path |
|---|---|
| spaces, pages, tree, trash, history | `/api/spaces`, `/api/pages` |
| comments, labels, favourites | `/api/comments`, `/api/labels`, `/api/favorites` |
| attachments and files | `/api/attachments`, `/api/files` |
| search and public links | `/api/search`, `/api/share` |
| workspace, members, groups, invitations | `/api/workspace`, `/api/groups` |
| templates and bases | `/api/templates`, `/api/bases` |
| import and export | `/api/file-tasks`, export handlers in `api/exports.py` |
| assistant | `/api/ai` |

The full list is assembled from the controllers in
`apps/api/tessera_api/api`.

## Rate limiting

There is no global limit. Separate limits sit on sign-in, MFA, `/ai`, `/mcp`,
export and PDF rendering. A request with a key is counted by the same counter as
a request from a person.

## MCP

The same key works for MCP at `/mcp` — a separate protocol over JSON-RPC.
Details are in `docs/ai-context/mcp.md`.
