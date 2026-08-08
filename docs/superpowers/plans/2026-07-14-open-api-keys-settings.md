# Open API Keys Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the existing account and workspace API-key settings pages in the open-source edition.

**Architecture:** The client already contains the API-key pages, routes, and HTTP service. Remove only the feature-gate metadata on the two settings-sidebar entries, leaving page and server authorization unchanged.

**Tech Stack:** React, TypeScript, Vitest, TanStack Router, existing Tessera feature hooks.

---

### Task 1: Make the settings links unconditional

**Files:**
- Modify: `apps/client/src/components/settings/settings-sidebar.tsx`
- Test: `apps/client/src/components/settings/settings-sidebar.test.tsx`

- [ ] **Step 1: Write the failing test**

Add a sidebar test that renders the settings navigation with API-key feature access disabled and asserts that both paths are still present:

```tsx
expect(screen.getByRole('link', { name: 'API Keys' })).toHaveAttribute(
  'href',
  '/settings/account/api-keys',
);
expect(screen.getByRole('link', { name: 'API Keys' })).toHaveAttribute(
  'href',
  '/settings/api-keys',
);
```

- [ ] **Step 2: Run the targeted client test and verify failure**

Run: `corepack pnpm --filter ./apps/client test settings-sidebar`

Expected: the account and workspace API-key entries are not rendered while `Feature.API_KEYS` is disabled.

- [ ] **Step 3: Remove only the two `Feature.API_KEYS` properties**

In `settings-sidebar.tsx`, change the API-key entries to:

```ts
{
  icon: IconKey,
  title: 'API Keys',
  path: '/settings/account/api-keys',
},
```

and:

```ts
{
  icon: IconKey,
  title: 'API Keys',
  path: '/settings/api-keys',
},
```

Do not alter the rest of the feature gating or the workspace admin checks.

- [ ] **Step 4: Run the targeted test and client build**

Run: `corepack pnpm --filter ./apps/client test settings-sidebar`

Expected: PASS.

Run: `corepack pnpm --filter ./apps/client run build`

Expected: build completes with exit code 0.

- [ ] **Step 5: Validate the flow in the authenticated browser**

Open both settings routes. Confirm the account page permits creating/revoking a key and that the workspace page retains its administrator-only behavior.

- [ ] **Step 6: Commit**

```bash
git add apps/client/src/components/settings/settings-sidebar.tsx \
  apps/client/src/components/settings/settings-sidebar.test.tsx \
  docs/superpowers/plans/2026-07-14-open-api-keys-settings.md
git commit -m "feat: expose API key settings"
```
