# Screens

## Framework

SvelteKit 2 and Svelte 5 on runes, built with Vite 8, styled with Tailwind 4.
The adapter is `adapter-node`: this is a Node process, not static output.

The reason for the adapter is recorded in `apps/web/svelte.config.js`: some
routes require server rendering, and instance settings are read from the
environment at startup instead of being baked into the build.

## Code organization

```
src/routes/            routes, grouped by shells
src/lib/api/           client, base, session, failure parsing
src/lib/features/<domain>/services/   calls to the server and domain logic
src/lib/components/    ai, layout, page, search, space, ui
src/lib/stores/        shared state on runes
src/lib/i18n/          dictionaries, substitution, plural forms
```

Route groups: `(app)` requires a session, `(auth)` shows the sign-in forms,
`(share)` serves a public link, `(render)` serves PDF rendering.

## The order of calls to the server

A component never calls `fetch`. The order is `lib/api/client` →
`lib/features/<domain>/services` → component.

- `credentials: 'include'` is mandatory and already set: the session lives in a
  cookie
- the `/api` prefix is written in the path itself; the base does not add it
- a failure arrives as a code and is expanded by the dictionary. Showing
  `message` from the server would mean English text for a person on any of the
  twelve locales

## The server side

`hooks.server.ts` parses the cookie on every request and puts the session into
`event.locals`. The cookie has to be copied from the incoming request to the
outgoing one: the server does not add it by itself, and without that the page
always looks signed out.

The application address for the server side comes from `API_INTERNAL_URL` and
never reaches the browser. Public values are declared as `PUBLIC_*`.

## State

- screen state on runes: `$state`, `$derived`, `$effect`
- shared state in `lib/stores/*.svelte.ts` and in `*.svelte.ts` modules inside a
  feature
- there is no server-state library in the project: data arrives from the route
  loader or from a `services` module

The page tree is a special case: a change must update the local state, call the
server and emit an event, all consistently. Skipping any of the three desyncs
the open tabs.

## Lazy loading

Heavy parts load on demand inside the page: the editor, diagrams, history.
Excalidraw is mounted separately and stays a React component — `react` and
`react-dom` are in the dependencies for its sake.

A reader without edit permission gets the read-only variant and does not open a
collaborative editing connection.

## Localization

Dictionaries are `static/locales/<locale>.json`, twelve languages. Translation
reaches a component from the store: `import { locale } from
'$lib/stores/i18n.svelte'`, then `const t = $derived(locale.t)`. Details are in
`.claude/skills/i18n/SKILL.md`.

Proofreading by native speakers goes through `scripts/locale-review.mjs`. The
table export gives only the strings changed since the last pass. The import
compares substitutions against the source and writes nothing when they diverge.
The "read up to this commit" mark is `docs/i18n-review-marks.json`. Crowdin is
off deliberately; the reason is in `docs/future-roadmap.md`.

## Static files

`static/` is copied into the build as it is. The Excalidraw fonts are put there
by a build step (`apps/web/scripts/copy-excalidraw-assets.mjs`): the instance
serves them itself, because the exported SVG refers to `/excalidraw-assets/` and
there is no internet access.
