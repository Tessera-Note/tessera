---
name: litestar-module
description: The pattern for server code on Litestar in this project. Applies when adding a route, a controller, a service or a DTO, and when working with authentication, permissions, queues and events on the apps/api side.
---

# A server module

## When to apply this

A route or a new controller is being added, a DTO, a guard or a permission check
is changing, or a job is being put on a queue.

## How it is built

Litestar 2 on Python 3.13. The application is assembled in
`apps/api/tessera_api/app.py`: that is where the controllers are listed, the
dependencies are declared, and `jwt_guard` and the failure handler stand.

The layers point one way.

```
api/            controllers, msgspec DTOs, guards
services/       business logic
domain/         entities and rules, without input or output
infrastructure/ database, Redis, storage, mail, queues
```

`api` knows `services`, and `services` knows `domain` and `infrastructure`.
There are no reverse edges: a service does not import a controller, and `domain`
imports nothing from `infrastructure`.

## The division of duties

| Layer | Responsible for | Does not do |
|---|---|---|
| the controller | the path, the method, the status, the DTO, extracting the principal | business rules, database queries |
| the service | rules, transactions, events, queues, storage | parsing the request |
| the repository | SQLAlchemy queries, selection limits | rules and external effects |

## The controller

```python
class NotificationController(Controller):
    path = "/api/notifications"

    @post("/unread-count")
    async def unread_count(
        self,
        request: Request,
        db_session: NamedDependency[AsyncSession],
        realtime: NamedDependency[RealtimeService],
    ) -> dict:
        principal: Principal = request.scope["principal"]
        count = await NotificationService(db_session, realtime).unread_count(
            principal.user_id, principal.workspace_id
        )
        return {"count": count}
```

The conventions of the project

- actions are shaped as a `POST` with a body rather than as REST by method. The
  screens are built for exactly that. Follow the neighbouring controllers
- the user and the workspace are taken from `request.scope["principal"]`. There
  is no need to parse the header by hand, `jwt_guard` does it
- protected by default. An open route is marked `opt={PUBLIC: True}`, and that is
  a change to the authentication surface: do it deliberately and explain it
- dependencies are declared in `app.py` and reach the handler through
  `NamedDependency`
- a failure is raised through the catalogue in `domain/errors.py`, by code rather
  than with ready text. The text for a person is expanded by the dictionary on
  the screen
- a page of another workspace is served as "not found" rather than "no access",
  so that identifiers cannot be enumerated

## DTOs

`msgspec.Struct` structures in the body of the controller or in `api/dto.py`. The
field names repeat what the screens send, camel case included: a divergence
breaks the parsing silently. Where a name violates the Python style, `# noqa:
N815` is placed with a reason.

Set numeric bounds explicitly rather than relying on the good sense of the
caller.

## Failures

The catalogue of codes is in `apps/api/tessera_api/domain/errors.py`. A code is a
translation key on the screen.

The trap: **a code must not end with a plural form suffix** (`_one`, `_few`,
`_many`, `_other`) — the parser would take it for a number form and would not
find the translation.

A new code is created in the catalogue and in all twelve dictionaries at once,
otherwise a person sees a raw key. The correspondence is checked by
`apps/web/src/lib/i18n/error-codes.test.ts`.

## Permissions

- access to page content only through `services/page_access.py`. Space
  membership is not enough: access to every restricted ancestor is required, and
  the nearest restricted ancestor decides the write permission
- one and the same rule must hold in HTTP, in collaborative editing, in the
  lists, in the notifications, in the Socket.IO events and in the MCP tools. If
  you added a check in one place, check the others

## Rate limiting

There is no global limit over all routes. Separate limits are configured for
sign-in, the AI chat, MCP and PDF rendering through
`infrastructure/throttle.py`. A new route in those areas must get the same
check.

The client address is taken with `TRUST_PROXY_HOPS` in mind: the whole
`X-Forwarded-For` chain cannot be trusted, since the address is substituted by a
header.

## Queues and events

Long and deferred effects go to arq. The job definitions are in `jobs.py`, the
worker entry point in `worker.py`, the plumbing in `infrastructure/queue.py`. The
split is deliberate: `jobs.py` is imported without the environment, while
`worker.py` requires ready settings.

Do not move into an HTTP request what is currently executed on a queue (history,
mentions, backlinks, AI indexing, watchers, notifications) without assessing
idempotency and latency.

## Tests

The tests are in `apps/api/tests`, pytest with `asyncio_mode = auto`. Part of
them run against a real database and are skipped without `DATABASE_URL` — the
skip is visible in the output.

```
uv run --project apps/api pytest
uv run --project apps/api pytest -k <substring>
```

The tests on a real database run inside a transaction that is rolled back and
leave nothing behind. It is done that way because the related rows are enforced
by foreign keys, and on a stub an ordering mistake is not visible at all.

## Antipatterns

- a database query inside a controller
- an import from `infrastructure` inside `domain`
- returning a dictionary describing an error instead of a failure from the
  catalogue
- ready failure text instead of a code
- a new content-serving route that does not go through the page access check
- mixing the channels: the tree and the notifications go over Socket.IO, the
  document content over Hocuspocus on `/collab`
- lazy loading of a relationship in an async session: it answers with a failure,
  and the relationship is requested through `selectinload`
