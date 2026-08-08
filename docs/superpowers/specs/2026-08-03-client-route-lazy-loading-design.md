# Client Route Lazy Loading Design

## Goal

Reduce the initial browser bundle by loading route pages only when their routes
are visited, without changing navigation, authorization, or deployment behavior.

## Scope

- Convert page-level imports in `apps/client/src/App.tsx` to dynamic imports
  consumed through `React.lazy`.
- Keep global providers, routing infrastructure, layouts, redirects, hooks, and
  the 404 component eagerly available.
- Wrap routed lazy content in one neutral loading boundary.
- Preserve every existing URL and the cloud/self-hosted conditional routes.
- Let Vite derive chunks from dynamic imports; do not add manual chunk groups.

## Design

Each route page becomes a lazy component whose dynamic import resolves the
module's default export. `App` retains the current route tree and conditions,
so the only behavioral difference is when a page module is downloaded.

A single `Suspense` boundary surrounds `Routes`. Its fallback is a small,
centered loading indicator built from an existing UI primitive. Layouts remain
eager because they form the common application shell and shared-route context.

Lazy-import failures follow the existing application error behavior. This
change does not add retry logic, route prefetching, or new dependencies.

## Compatibility

Route paths, redirects, authentication flows, cloud flags, shared pages, and
settings nesting remain unchanged. No server or API contract changes.

## Verification

After all implementation work, run the focused client tests and one production
build. Compare the main entry chunk with the prior baseline of approximately
3.48 MB (1.04 MB gzip) and verify that route-specific chunks are emitted.
