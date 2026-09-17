# Recurring patterns

## The application

- a controller takes the principal from `request.scope["principal"]` and hands
  the work to a service straight away
- a service is created on the spot with a session and the dependencies it needs:
  `NotificationService(db_session, realtime, mailer)`
- dependencies are declared in `app.py` and reach a handler through
  `NamedDependency`
- a DTO is a `msgspec.Struct`; the field names repeat what the screens send,
  camel case included, and a style violation is marked `# noqa: N815` with a
  reason
- a failure is raised by a code from `domain/errors.py` rather than with ready
  text
- a database query lives in a repository and is always limited by the workspace
- a list that grows along with the workspace always has a limit

## The screens

- a call to the server lives in `lib/features/<domain>/services`, and a component
  calls a function from there
- a translation comes from the store: `const t = $derived(locale.t)`
- screen state is on runes; shared state goes in `*.svelte.ts`
- heavy things load on demand inside the page rather than in the route shell
- a failure is parsed by its code through `lib/api/failure.ts`

## Comments in the code

A comment explains what is not visible from the code: why this way was chosen,
what was measured, which failure it prevents. Comments like that are valuable in
this repository and are not deleted during edits as long as the behavior has not
changed.

Examples: why the screens use the Node adapter rather than static output; why
the collaboration service is built on glibc; why the proxy is needed even on your
own machine; why the collated indexes were taken out of Atlas's hands.

## Tests

- the application: `apps/api/tests`, pytest with `asyncio_mode = auto`
- the screens: next to the code, `*.test.ts`; where a DOM is needed —
  `*.dom.test.ts` and `*.svelte.test.ts`
- collaborative editing: `services/collab/src/*.test.js`, the Node built-in
  runner
- a test against a real database marks itself as skipped when there is no
  database

## One contract in several places

A rule introduced in one place almost always has to hold in several more. Check
all of them, not only the point where the flaw was found.

| Rule | Where else to look |
| --- | --- |
| page access | the controller, MCP, events, collaborative editing, search, export, public links, the AI context |
| belonging to a workspace | repositories, MCP, search, embeddings |
| rate limiting | sign-in, MFA, `/ai`, `/mcp`, `/pdf-export`, export |
| failure code | the catalogue in `domain/errors.py`, twelve dictionaries, `error-codes.test.ts` |
| updating the tree | local state, the call to the server, the event |
| an effect after the text is saved | history, mentions, backlinks, AI indexing, notifications |
