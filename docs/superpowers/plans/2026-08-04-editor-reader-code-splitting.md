# Editor and reader code-splitting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep editor and reader dependency graphs out of the page route chunks until a successfully resolved page needs to render them.

**Architecture:** The page query and all authorization/error views remain eager in their route modules. `FullEditor`, page history, and `ReadonlyPageEditor` become independently imported React components rendered behind local Suspense boundaries only after their data is present. Vite creates the chunks from these imports; no custom chunk rules are needed.

**Tech Stack:** React 19 lazy/Suspense, React Router, Vite/Rolldown, Vitest, Testing Library, Mantine.

---

## File structure

- Modify: `apps/client/src/pages/page/page.tsx` — defer the editable page renderer and history modal after the page query succeeds.
- Modify: `apps/client/src/pages/share/shared-page.tsx` — defer the shared read-only renderer after the share query succeeds.
- Modify: `apps/client/src/App.spec.tsx` — retain the existing app-route lazy test and add mocks that prove the new module boundaries render after import resolution.
- Modify: `docs/ai-context/frontend.md` — describe the page content lazy boundaries.

### Task 1: Defer workspace page content

**Files:**
- Modify: `apps/client/src/pages/page/page.tsx:1-25,117-180`
- Test: `apps/client/src/App.spec.tsx`

- [ ] **Step 1: Add the failing lazy-module assertion**

Extend the existing test setup with an import spy for the page renderer and a route render that reaches a resolved page. Mock `usePageQuery`, `useGetSpaceBySlugQuery`, feature flags, and page-header dependencies so the assertion is limited to the deferred component:

```tsx
vi.mock("@/features/editor/full-editor", () => ({
  FullEditor: ({ pageId }: { pageId: string }) => (
    <div data-testid="full-editor">{pageId}</div>
  ),
}));

it("loads the workspace editor after page data resolves", async () => {
  // render the page route with a resolved editable page fixture
  expect(await screen.findByTestId("full-editor")).toHaveTextContent("page-1");
});
```

- [ ] **Step 2: Replace eager page-content imports with lazy components**

In `apps/client/src/pages/page/page.tsx`, retain `React` and declare named-export adapters beside the other page-level constants:

```tsx
const FullEditor = React.lazy(async () => {
  const module = await import("@/features/editor/full-editor");
  return { default: module.FullEditor };
});

const HistoryModal = React.lazy(() =>
  import("@/features/page-history/components/history-modal"),
);
```

Remove the eager imports and their memoized wrappers. In the successful non-base branch, wrap only the renderer and history modal in a Mantine-compatible, labelled fallback:

```tsx
<React.Suspense fallback={<div aria-label={t("Loading page content")} />}>
  <FullEditor key={page.id} /* existing props unchanged */ />
  <HistoryModal pageId={page.id} />
</React.Suspense>
```

Do not defer `PageHeader`, the page query, the title, `Helmet`, missing-page views, or `BaseView`: they preserve navigation and authorization behavior while the content chunk downloads.

- [ ] **Step 3: Commit the workspace page boundary**

```bash
git add apps/client/src/pages/page/page.tsx apps/client/src/App.spec.tsx
git commit -m "perf(client): lazy-load workspace page content"
```

### Task 2: Defer shared read-only content

**Files:**
- Modify: `apps/client/src/pages/share/shared-page.tsx:1-80`
- Test: `apps/client/src/App.spec.tsx`

- [ ] **Step 1: Add the failing shared-renderer assertion**

Mock the shared page query with a resolved share fixture, then render its public route and assert that the mocked reader appears only after the lazy import resolves:

```tsx
vi.mock("@/features/editor/readonly-page-editor", () => ({
  default: ({ pageId }: { pageId?: string }) => (
    <div data-testid="readonly-page-editor">{pageId}</div>
  ),
}));

it("loads the shared reader after share data resolves", async () => {
  // render a resolved /share/:shareId/p/:pageSlug fixture
  expect(await screen.findByTestId("readonly-page-editor")).toHaveTextContent("page-1");
});
```

- [ ] **Step 2: Convert the shared reader import to a local lazy boundary**

Remove the eager `ReadonlyPageEditor` import and add:

```tsx
const ReadonlyPageEditor = React.lazy(
  () => import("@/features/editor/readonly-page-editor"),
);
```

Wrap the existing reader invocation—not the `Helmet`, redirect effect, `Container`, or branding condition—in:

```tsx
<React.Suspense fallback={<div aria-label={t("Loading page content")} />}>
  <ReadonlyPageEditor /* existing props unchanged */ />
</React.Suspense>
```

The share query must still complete before this boundary is reached so existing 401/403/404 behavior and `noindex` metadata are unchanged.

- [ ] **Step 3: Commit the shared-reader boundary**

```bash
git add apps/client/src/pages/share/shared-page.tsx apps/client/src/App.spec.tsx
git commit -m "perf(client): lazy-load shared page reader"
```

### Task 3: Document and perform final validation

**Files:**
- Modify: `docs/ai-context/frontend.md:4-8`

- [ ] **Step 1: Document the stable lazy-loading boundary**

Add a concise `frontend.md` sentence stating that the page and share route modules keep data/error handling eager but load `FullEditor`, history and `ReadonlyPageEditor` only after a resolved page needs content rendering.

- [ ] **Step 2: Run the final focused validation once**

Run:

```bash
pnpm --filter client test -- src/App.spec.tsx
pnpm --filter client build
```

Expected: Vitest passes, TypeScript succeeds, and Vite reports distinct asynchronously loaded page editor/reader chunks. This is the only planned test/build execution, honoring the user's request to avoid repeated local validation during edits. Diagnose any resulting failure from its output before retrying.

- [ ] **Step 3: Inspect the final diff and commit documentation**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and only the documented implementation files are changed.

```bash
git add docs/ai-context/frontend.md
git commit -m "docs: document deferred page content loading"
```
