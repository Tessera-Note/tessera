---
name: svelte-feature
description: The pattern for client code in this project. Applies when adding a screen, a component or a call to the server, and when working with state, the cache and real-time events on the apps/web side.
---

# A client feature

## When to apply this

A component, a page, a route, a call to the server or the handling of a real-time
event is being added.

## The order of work

For a feature with a call to the server, move strictly in this order.

```
lib/features/<domain>/services/<subject>.ts   data types and functions over the server
lib/components/<domain>/*.svelte              markup
routes/(app)/<path>/+page.server.ts           loading data for server rendering
routes/(app)/<path>/+page.svelte              assembling the screen
```

A component does not call `fetch` directly and does not parse answers. The call
lives in `services`, and the shared transport in `lib/api/client.ts`.

## Calling the server

```ts
import { post } from '$lib/api/client';

export type Attachment = { id: string; fileName: string };

export async function attachmentInfo(attachmentId: string): Promise<Attachment> {
  return post<Attachment>('/api/files/info', { attachmentId });
}
```

- the transport is in `lib/api/client.ts`, and the application address comes from
  `lib/api/base.ts`. The `/api` prefix is written in the path itself; the base
  does not add it
- `credentials: 'include'` is mandatory and already set: sign-in is held in a
  cookie
- calls are shaped as a `POST` with a body, following the application
  controllers
- **a failure is parsed by its code, not by its text.** The server serves
  `{code, message, params}`, and the screen translates by the code. Showing
  `message` means showing English text to a person on any of the twelve locales
- do not swallow a failure: it surfaces as an `ApiError`, and the caller decides
  whether to show it

## Server rendering

The server loaders (`+page.server.ts`, `+layout.server.ts`, `hooks.server.ts`)
run in the Node process and do not attach the cookie themselves: it has to be
carried over from the incoming request. Without that a server-rendered page
always looks "not signed in".

The application address for the server side comes from `API_INTERNAL_URL` and
never reaches the browser. Public values are declared as `PUBLIC_*`.

## State

- screen state is on Svelte 5 runes: `$state`, `$derived`, `$effect`
- shared state goes in `lib/stores/*.svelte.ts` and in `*.svelte.ts` modules
  inside the feature
- there is no server-state library in the project. Data arrives from the route
  loader or from a `services` module

The page tree is a special case. A change must consistently do three things:
update the local state, call the server and emit an event. Skipping any step
desyncs the tabs.

## Components

- styling with Tailwind. Do not introduce another approach to styles
- shared primitives are in `lib/components/ui`; reuse them rather than creating
  your own
- component files in capitalized camel case (`CopyButton.svelte`), logic modules
  in kebab case (`order-key.ts`)
- any user-facing text goes through a translation: `import { locale } from
  '$lib/stores/i18n.svelte'`, then `const t = $derived(locale.t)`. See the `i18n`
  skill

## Routes

The route groups separate the shells: `(app)` requires sign-in, `(auth)` shows
the sign-in forms, `(share)` serves a public link, `(render)` serves PDF
rendering.

The heavy parts load on demand inside the page already: the editor, the diagrams,
the history. A reader without edit permission gets the read-only variant and does
not open a collaborative editing connection. That is deliberate; do not break it.

## Real time

Two independent channels.

- Socket.IO (`lib/features/realtime/socket.ts`): the tree, pages, comments,
  notifications
- Hocuspocus on `/collab`: the document content

Do not substitute one for the other. The event about a page being renamed goes
over the first channel, the text of the page over the second.

## Verification

```
pnpm --filter @tessera/web check      # svelte-check
pnpm --filter @tessera/web test       # Vitest
pnpm --filter @tessera/web lint       # prettier --check
```

The tests sit next to the code: `*.test.ts` for ordinary modules,
`*.dom.test.ts` and `*.svelte.test.ts` where a DOM is needed.

After interface changes, open the page in a browser and click through the
scenario. A type check checks the code, not whether the screen works.

## Antipatterns

- `fetch` inside a component
- showing `message` from a failure instead of the translation by code
- text hard-wired into a component that already takes a translation nearby
- a new approach to styles instead of Tailwind
- a "universal" component with a dozen boolean flags instead of two separate
  ones
- updating the page tree locally only, with no call to the server and no event
- reading the private environment from code that ends up in the browser
