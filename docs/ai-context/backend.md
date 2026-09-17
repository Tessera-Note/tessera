# Application

## Framework

Litestar 2 on Python 3.13, asynchronous. The application is assembled in
`apps/api/tessera_api/app.py`: the controllers are listed there, the
dependencies are declared, and `jwt_guard` and the failure handler are installed.
Settings are read once, while the application is being assembled, in
`config.py`.

Every route lives under `/api`, except the few that must answer on the root path
(`/robots.txt`, the public link, `/mcp`, and the callbacks of a sign-in
provider).

## Layers

```
api/            path, method, status, DTO, extraction of the principal
services/       rules, transactions, events, queues
domain/         entities, roles, catalogue of failure codes
infrastructure/ database, Redis, storage, mail, queues, external services
```

`api` knows `services`, `services` knows `domain` and `infrastructure`. There
are no reverse edges.

## Authentication

`api/guards.py` holds `jwt_guard` and the marker of a public route.

- the session is kept in a cookie, and the token is signed with `APP_SECRET`
- the parsed principal is placed into `request.scope["principal"]`: user,
  workspace, role
- a public route is marked with `opt={PUBLIC: True}`. That changes the
  authentication surface and is done deliberately
- the workspace is determined by the request host name

## Failures

The catalogue of codes is in `domain/errors.py`, and the handler is installed in
`app.py`. What leaves the server is `{code, message, params}`, and the screen
translates by code instead of showing `message`.

A trap: a code must not end with a plural-form suffix (`_one`, `_few`, `_many`,
`_other`) — the parser would take the tail for a form and find no translation.

## Shape of the routes

Actions are `POST` requests with a body rather than REST by method, and the
screens are written for exactly that.

The largest groups are pages together with comments, labels and favourites
(`api/pages.py`), spaces and groups (`api/spaces.py`), bases (`api/bases.py`),
SCIM (`api/scim.py`), and sign-in with MFA.

## Permissions

Access to page content is checked by `services/page_access.py`. Space membership
is not enough: access to every restricted ancestor is required, and the nearest
restricted ancestor decides the write permission.

The same rule must hold in HTTP, in collaborative editing, in listings, in
notifications, in events and in the MCP tools.

## Rate limiting

`infrastructure/throttle.py`. There is no global limit; separate limits sit on
sign-in, MFA, the AI chat, export, MCP, PDF rendering and the sign-in providers.
The client address is taken with `TRUST_PROXY_HOPS` in mind.

## Internal collaboration routes

`api/collab.py`, path `/api/internal/collab`, seven handlers: `authorize`,
`document`, `store`, `rights` and the document ownership mark — `owner`,
`owner/renew`, `owner/release` (`services/collab_owner.py`, Redis). They are
public to the guard but protected by the shared secret `COLLAB_INTERNAL_TOKEN`;
the list of public routes is checked by `tests/test_public_routes.py`.
Permission decisions, document writes and the ownership mark belong to this
side, not to the Node neighbour.

## Background jobs

Definitions in `jobs.py`, the worker entry point in `worker.py`, the plumbing in
`infrastructure/queue.py`, an arq queue on top of Redis. The split is
deliberate: `jobs.py` imports without an environment.

Mail, history, mentions, backlinks, indexing for AI, notifications and
maintenance go through the queue.
