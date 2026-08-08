# Open API Spaces and Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove and document that all documented Space and Page operations work through an open-source API key, adding only the missing compatibility harness rather than duplicating existing controllers.

**Architecture:** `SpaceController` and `PageController` are already registered in `CoreModule` and protected by `JwtAuthGuard`. Phase 1 resolves an API-key JWT to the key creator, so the existing controllers and CASL/page-access rules are the single implementation path. Add a standalone Node smoke test that calls the live API and removes every temporary resource it creates, plus a local reference that maps the supported routes to their existing controllers.

**Tech Stack:** NestJS, Passport JWT, Fastify, Node.js `fetch`, Docker Compose, PostgreSQL, Redis.

---

## File structure

- Create: `scripts/verify-open-api-spaces-pages.mjs` — live compatibility harness. It uses `TESSERA_API_URL` and `TESSERA_API_KEY`, validates the official response envelope, and cleans up its temporary space.
- Create: `docs/open-api/spaces-pages.md` — concise endpoint map, authentication requirements, request shapes, pagination and lifecycle semantics.
- Modify: `docs/superpowers/specs/2026-07-14-open-api-spaces-pages-design.md` — correct the architecture after confirming the controllers already exist in the open-source tree.

### Task 1: Establish the API-key compatibility boundary

**Files:**
- Modify: `docs/superpowers/specs/2026-07-14-open-api-spaces-pages-design.md:45-50`
- Test: `apps/server/src/core/auth/strategies/jwt.strategy.ts`
- Test: `apps/server/src/core/space/space.controller.ts`
- Test: `apps/server/src/core/page/page.controller.ts`

- [ ] **Step 1: Verify that the existing routes remain in the open-source modules**

Run:

```powershell
rg -n "@Controller\('spaces'\)|@Post\('(info|create|update|delete|members)'" apps/server/src/core/space/space.controller.ts
rg -n "@Controller\('pages'\)|@Post\('(info|create|update|delete|restore|recent|trash|history|sidebar-pages|move-to-space|duplicate|move|breadcrumbs)'" apps/server/src/core/page/page.controller.ts
```

Expected: all Space and Page routes listed in the approved design are found; no Enterprise import is required.

- [ ] **Step 2: Verify the API-key authentication path before adding the harness**

Run:

```powershell
rg -n "JwtType.API_KEY|validateApiKey" apps/server/src/core/auth/strategies/jwt.strategy.ts apps/server/src/core/api-key/api-key.service.ts
```

Expected: `JwtStrategy` delegates API-key payloads to `ApiKeyService.validateApiKey`, which returns `{ user, workspace }` used by the existing guarded controllers.

- [ ] **Step 3: Record the no-duplication architecture correction**

Replace the Architecture paragraph in the design with:

```markdown
The open-source `SpaceController` and `PageController` already expose every
endpoint in scope. Phase 1 makes these routes available to API keys through the
shared JWT guard, so this phase must not create duplicate controllers or DTOs.
It adds an executable compatibility harness and concise API reference proving
the existing routes work with API keys. The global response interceptor already
normalizes successful results to `{ success, status, data }`.
```

- [ ] **Step 4: Check the documentation diff**

Run: `git diff --check -- docs/superpowers/specs/2026-07-14-open-api-spaces-pages-design.md`

Expected: no output and exit code 0.

- [ ] **Step 5: Commit the architecture correction**

```powershell
git add docs/superpowers/specs/2026-07-14-open-api-spaces-pages-design.md
git commit -m "docs: clarify open API controller reuse"
```

### Task 2: Add a live Spaces and Pages compatibility harness

**Files:**
- Create: `scripts/verify-open-api-spaces-pages.mjs`
- Test: `scripts/verify-open-api-spaces-pages.mjs`

- [ ] **Step 1: Write the failing missing-configuration check**

Create the script with the following top-level validation and execute it without environment variables:

```js
const baseUrl = process.env.TESSERA_API_URL?.replace(/\/$/, '');
const apiKey = process.env.TESSERA_API_KEY;

if (!baseUrl || !apiKey) {
  throw new Error(
    'Set TESSERA_API_URL and TESSERA_API_KEY before running this verification.',
  );
}
```

Run: `node scripts/verify-open-api-spaces-pages.mjs`

Expected: failure with `Set TESSERA_API_URL and TESSERA_API_KEY before running this verification.`

- [ ] **Step 2: Add a response-envelope helper**

Add the helper below. It makes all test calls use the public `Bearer` contract and rejects malformed or failed envelopes without printing the API key.

```js
async function post(path, body = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || payload.success !== true || payload.status !== response.status) {
    throw new Error(`${path} failed with HTTP ${response.status}`);
  }
  return payload.data;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
```

- [ ] **Step 3: Implement the Space lifecycle assertions**

Append this sequence. The suffix prevents collisions and `spaceId` is retained for cleanup:

```js
const suffix = `open-api-${Date.now()}`;
let spaceId;

const spaces = await post('/spaces', { limit: 1 });
assert(Array.isArray(spaces.items), 'spaces list must contain items');
assert(spaces.meta?.limit === 1, 'spaces list must return pagination metadata');

const space = await post('/spaces/create', {
  name: suffix,
  slug: suffix,
  description: 'Temporary Open API compatibility verification',
});
spaceId = space.id;
assert(spaceId, 'space creation must return an id');

const spaceInfo = await post('/spaces/info', { spaceId });
assert(spaceInfo.id === spaceId, 'space info must return the created space');

const updatedSpace = await post('/spaces/update', {
  spaceId,
  name: `${suffix}-updated`,
  description: 'Updated by the Open API compatibility verification',
});
assert(updatedSpace.name === `${suffix}-updated`, 'space update must persist the name');

const members = await post('/spaces/members', { spaceId, limit: 20 });
assert(Array.isArray(members.items), 'space members must be paginated');
```

- [ ] **Step 4: Implement Page lifecycle and navigation assertions**

Append this sequence after the Space checks:

```js
const page = await post('/pages/create', {
  spaceId,
  title: 'Open API root page',
  content: { type: 'doc', content: [{ type: 'paragraph' }] },
  format: 'json',
});
assert(page.id, 'page creation must return an id');

const pageInfo = await post('/pages/info', { pageId: page.id, format: 'json' });
assert(pageInfo.id === page.id, 'page info must return the created page');

const updatedPage = await post('/pages/update', {
  pageId: page.id,
  title: 'Open API updated page',
  format: 'json',
});
assert(updatedPage.title, 'page update must return the page');

const sidebar = await post('/pages/sidebar-pages', { spaceId, limit: 20 });
assert(Array.isArray(sidebar.items), 'sidebar pages must be paginated');

const breadcrumbs = await post('/pages/breadcrumbs', { pageId: page.id });
assert(Array.isArray(breadcrumbs), 'breadcrumbs must be an array');

const duplicate = await post('/pages/duplicate', { pageId: page.id });
assert(duplicate.id, 'page duplication must return an id');

await post('/pages/move', { pageId: duplicate.id, parentPageId: page.id, index: 0 });
await post('/pages/delete', { pageId: duplicate.id });

const trash = await post('/pages/trash', { spaceId, limit: 20 });
assert(Array.isArray(trash.items), 'trash must be paginated');

const restored = await post('/pages/restore', { pageId: duplicate.id });
assert(restored.id === duplicate.id, 'page restore must return the deleted page');

const history = await post('/pages/history', { pageId: page.id, limit: 20 });
assert(Array.isArray(history.items), 'page history must be paginated');

const recent = await post('/pages/recent', { spaceId, limit: 20 });
assert(Array.isArray(recent.items), 'recent pages must be paginated');
```

- [ ] **Step 5: Add cleanup that runs after success and failure**

Wrap the lifecycle in `try`/`finally`, preserving any original failure while removing the temporary space:

```js
try {
  // Space and Page lifecycle assertions from Steps 3 and 4.
  console.log('Open API spaces and pages verification passed.');
} finally {
  if (spaceId) {
    try {
      await post('/spaces/delete', { spaceId });
    } catch (cleanupError) {
      console.error('Temporary verification space could not be removed.');
      throw cleanupError;
    }
  }
}
```

- [ ] **Step 6: Run the harness against the local Docker service**

Create a temporary API key in Settings, then run without echoing the key:

```powershell
$env:TESSERA_API_URL = 'http://localhost:3000/api'
$env:TESSERA_API_KEY = '<temporary key>'
node scripts/verify-open-api-spaces-pages.mjs
Remove-Item Env:TESSERA_API_KEY
```

Expected: `Open API spaces and pages verification passed.` and no temporary verification space remains.

- [ ] **Step 7: Commit the executable harness**

```powershell
git add scripts/verify-open-api-spaces-pages.mjs
git commit -m "test: verify open API spaces and pages"
```

### Task 3: Publish the supported route contract

**Files:**
- Create: `docs/open-api/spaces-pages.md`
- Test: `scripts/verify-open-api-spaces-pages.mjs`

- [ ] **Step 1: Document authentication and common response behavior**

Start the file with:

```markdown
# Open API: Spaces and Pages

All routes are relative to `/api`, use `POST`, and require
`Authorization: Bearer <API_KEY>`. API keys inherit the permissions of the
user who created them. Successful responses use:

```json
{ "success": true, "status": 200, "data": {} }
```

List routes accept `limit` (1--100, default 20), `cursor`, and
`beforeCursor`. They return `{ items, meta }`, where `meta` contains `limit`,
`hasNextPage`, `hasPrevPage`, `nextCursor`, and `prevCursor`.
```

- [ ] **Step 2: Document every Space route with its request body**

Add this table:

```markdown
| Route | Required body fields | Purpose |
| --- | --- | --- |
| `/spaces` | none | List spaces available to the API-key user. |
| `/spaces/info` | `spaceId` | Read a space and the caller membership. |
| `/spaces/create` | `name`, `slug` | Create a space. |
| `/spaces/update` | `spaceId` | Update the supplied name, slug, description, or settings fields. |
| `/spaces/delete` | `spaceId` | Delete a manageable space. |
| `/spaces/members` | `spaceId` | List members. |
| `/spaces/members/add` | `spaceId`, `role`, plus `userIds` or `groupIds` | Add members. |
| `/spaces/members/remove` | `spaceId`, plus exactly one of `userId` or `groupId` | Remove a member. |
| `/spaces/members/change-role` | `spaceId`, `role`, plus exactly one of `userId` or `groupId` | Change a member role. |
```

- [ ] **Step 3: Document every Page route and lifecycle semantics**

Add this table:

```markdown
| Route | Required body fields | Purpose |
| --- | --- | --- |
| `/pages/info` | `pageId` | Read a page; optional `format` is `json`, `markdown`, or `html`. |
| `/pages/create` | `spaceId` | Create a root or child page; optional `parentPageId`, `title`, `content`, and `format`. |
| `/pages/update` | `pageId` | Update page content or metadata. |
| `/pages/delete` | `pageId` | Move a page to trash; `permanentlyDelete: true` requires space administration. |
| `/pages/restore` | `pageId` | Restore a trashed page. |
| `/pages/recent` | none | List recent pages; `spaceId` limits the result. |
| `/pages/trash` | `spaceId` | List trashed pages in a space. |
| `/pages/history` | `pageId` | List page history. |
| `/pages/history/info` | `historyId` | Read a history entry. |
| `/pages/sidebar-pages` | `spaceId` or `pageId` | List root pages or child pages. |
| `/pages/move-to-space` | `pageId`, `spaceId` | Move a page tree to another editable space. |
| `/pages/duplicate` | `pageId` | Duplicate in place; optional `spaceId` copies to another editable space. |
| `/pages/move` | `pageId` | Reorder or re-parent a page using the controller DTO fields. |
| `/pages/breadcrumbs` | `pageId` | Read the page hierarchy. |
```

- [ ] **Step 4: Add a safe runnable example**

Append:

```markdown
```bash
curl -X POST http://localhost:3000/api/spaces \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"limit":20}'
```

Do not commit real API keys. Revoke temporary keys after manual testing.
```

- [ ] **Step 5: Verify documentation and the production build**

Run:

```powershell
git diff --check
corepack pnpm --filter ./apps/server run build
```

Expected: no diff-check output and a successful Nest build.

- [ ] **Step 6: Commit the contract reference**

```powershell
git add docs/open-api/spaces-pages.md
git commit -m "docs: document open API spaces and pages"
```

## Self-review

- The plan covers every approved Space and Page route, including members, history, tree navigation, moving, duplication, trash, and restore.
- It preserves existing controllers, global response envelopes, JWT authentication, CASL, and page-level permissions instead of creating a parallel API.
- The harness creates only uniquely named temporary data and removes the temporary space in `finally`.
- No Enterprise-only source code is copied; the implementation uses this fork's existing routes.
