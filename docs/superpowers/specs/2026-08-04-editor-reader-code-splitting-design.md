# Editor and reader code-splitting design

## Goal

Reduce JavaScript loaded before a page is displayed by loading the rich editor
only when it is needed. The scope covers normal workspace pages and shared
pages, while preserving existing page rendering, permissions and collaboration.

## Current boundary

`pages/page/page.tsx` imports `FullEditor` eagerly. `FullEditor` imports the
Tiptap-based `PageEditor` regardless of the page permission or the selected
edit mode. `pages/share/shared-page.tsx` also imports `ReadonlyPageEditor`
eagerly. Consequently, the editor dependency graph is part of the route chunk
even for read-only visits.

## Design

### Page view

The page container remains responsible for fetching data, handling missing or
unauthorized pages, rendering metadata and rendering the eager page header.
It dynamically imports the page-content renderer after the page query has
resolved. A small, layout-preserving loading state is shown while that chunk is
requested.

`FullEditor` will become a composition boundary: its shared container, title,
byline and read-only presentation remain available to the page renderer; the
editable Tiptap/collaboration component is dynamically imported only when
`editable` and the current page edit mode require it. Existing editor atoms,
the Hocuspocus connection and editor menus therefore remain unavailable to
users merely reading a page.

### Shared pages

`SharedPage` retains its data retrieval, redirects, robots metadata and
branding behavior. Its `ReadonlyPageEditor` is dynamically imported after a
successful share query, with the same non-disruptive loading state. The
rendered document and share access checks remain server-authoritative and are
not moved into the lazy component.

### Heavy extensions

This change relies on Vite's dynamic-import chunking at the renderer boundary;
it does not introduce custom manual chunks or make individual Tiptap extensions
lazy. That avoids delaying editor commands or creating multiple loading states
inside a document. Build output will identify any remaining large extension
chunk for a later, focused optimization.

## Error handling and compatibility

Existing page-level error boundaries continue to catch lazy-import failures.
No API, route, permission, share URL, editor state, or WebSocket contract
changes. The standard `Suspense` fallback must be accessible and must not
replace the existing not-found or authorization views once the query finishes.

## Validation

Add focused client tests proving that page and shared-page renderers load
through their lazy boundaries and preserve the existing visible content after
resolution. Run the relevant tests and the client build once at the end, in
line with the user's preference to avoid repeated test execution during edits.

## Documentation

Update `docs/ai-context/frontend.md` to describe the page-editor lazy boundary
and its purpose. No change is required to collaboration protocol documentation,
because the connection behavior is unchanged.
