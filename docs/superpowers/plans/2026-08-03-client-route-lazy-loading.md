# Client Route Lazy Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the initial client entry bundle by loading page modules only when their routes are visited.

**Architecture:** Replace page-level static imports in `App.tsx` with `React.lazy` dynamic imports while keeping layouts, shared hooks, redirects infrastructure, and the 404 component eager. A single `Suspense` boundary around `Routes` renders a small Mantine loading indicator until the selected page chunk resolves.

**Tech Stack:** React 19, React Router, Mantine, Vite/Rolldown, Vitest.

## Global Constraints

- Preserve every existing route path, redirect, nested settings route, and cloud/self-hosted condition.
- Keep `Layout`, `ShareLayout`, `Navigate`, global hooks, and `Error404` eagerly imported.
- Use only dynamic imports derived by Vite; do not add manual chunk groups or dependencies.
- Use one neutral, centered loading fallback with an existing Mantine primitive.
- Do not run tests or builds during implementation; run client tests and one production build only at final verification.
- Compare the final entry chunk against the previous baseline of approximately 3.48 MB (1.04 MB gzip).

---

### Task 1: Lazy-load all route page modules

**Files:**
- Modify: `apps/client/src/App.tsx`
- Create: `apps/client/src/App.spec.tsx`
- Modify: `docs/ai-context/frontend.md`

**Interfaces:**
- Consumes: default exports from the existing modules under `apps/client/src/pages` and `apps/client/src/ee/**/pages`.
- Produces: the unchanged `App(): JSX.Element` route tree, with page components created by `lazy(() => import(path))`.

- [ ] **Step 1: Add a route-loading test before production changes**

```tsx
vi.mock("@/hooks/use-track-origin", () => ({ useTrackOrigin: vi.fn() }));
vi.mock("@/ee/hooks/use-redirect-to-cloud-select.tsx", () => ({
  useRedirectToCloudSelect: vi.fn(),
}));

it("renders a lazy route page through the shared suspense boundary", async () => {
  render(
    <MemoryRouter initialEntries={["/login"]}>
      <App />
    </MemoryRouter>,
  );

  expect(await screen.findByRole("heading", { name: /login/i })).toBeVisible();
});
```

Use the existing test providers or targeted mocks required by the login page. The test must exercise the real lazy import from `App`, not replace the lazy component with a synchronous stub.

- [ ] **Step 2: Replace page imports with lazy declarations**

```tsx
import { lazy, Suspense } from "react";
import { Center, Loader } from "@mantine/core";

const LoginPage = lazy(() => import("@/pages/auth/login"));
const Home = lazy(() => import("@/pages/dashboard/home"));
const Page = lazy(() => import("@/pages/page/page"));
```

Apply this form to every component used as a route page, including auth, shared pages, workspace/settings pages, EE pages, templates, bases, AI, favorites, labels, and redirects. Keep the two layout components and `Error404` as static imports.

- [ ] **Step 3: Add the shared loading boundary**

```tsx
<Suspense
  fallback={
    <Center h="100vh">
      <Loader size="sm" />
    </Center>
  }
>
  <Routes>{/* unchanged route tree */}</Routes>
</Suspense>
```

Do not change route ordering, paths, route nesting, conditions, or element props.

- [ ] **Step 4: Document the stable route-loading pattern**

Add a compact statement to `docs/ai-context/frontend.md`: route pages in `App.tsx` use `React.lazy` and one shared `Suspense` boundary; layouts and routing infrastructure remain eager.

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/App.tsx apps/client/src/App.spec.tsx docs/ai-context/frontend.md
git commit -m "perf(client): lazy-load route pages"
```

### Task 2: Final verification and bundle comparison

**Files:**
- Verify: `apps/client/src/App.spec.tsx`
- Verify: `apps/client/dist/assets/*`

- [ ] **Step 1: Run client tests once**

```bash
pnpm --filter client test -- App.spec.tsx
```

Expected: the lazy-route test passes.

- [ ] **Step 2: Run the production build once**

```bash
pnpm --filter client build
```

Expected: TypeScript and Vite build succeed; route-specific JavaScript chunks are listed and the initial entry chunk is smaller than approximately 3.48 MB (1.04 MB gzip).

- [ ] **Step 3: Inspect the branch**

```bash
git status --short
git log --oneline main..HEAD
```

Expected: only committed lazy-route, test, and frontend-context changes are present.

