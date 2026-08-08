# Search Pagination Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return only authorized, bounded page-search results without changing existing response contracts.

**Architecture:** Add a reusable query-time page-access predicate in `PagePermissionRepo`, then consume it in PostgreSQL search and suggestion queries before ordering and limits. DTO decorators enforce request bounds; controller routes and client service types remain unchanged.

**Tech Stack:** NestJS, class-validator, Kysely/PostgreSQL recursive CTEs, Jest.

## Global Constraints

- Main page search accepts `limit` 1–100 and `offset` >= 0; omitted values retain the 25-result default.
- Suggestions accept `limit` 1–25; omitted values retain the 10-result default.
- Restriction checks run before rank ordering, `limit`, and `offset`.
- Public share search remains confined to the share's permitted page set.
- Do not run tests during implementation; run the relevant server suite only once at final verification.

---

### Task 1: Expose a reusable query-time page-access predicate

**Files:**
- Modify: `apps/server/src/database/repos/page/page-permission.repo.ts`
- Test: `apps/server/src/database/repos/page/page-permission.repo.spec.ts`

**Interfaces:**
- Produces: `PagePermissionRepo.userCanAccessPagePredicate(userId: string, pageId: string): RawBuilder<SqlBool>`.
- Consumes: `page_access`, `page_permissions`, `group_users`, and recursive page ancestry.

- [ ] **Step 1: Write the failing repository test**

```ts
it('creates a predicate that rejects a page when any restricted ancestor lacks user or group permission', async () => {
  const predicate = repo.userCanAccessPagePredicate('user-1', 'pages.id');
  expect(predicate.sql).toContain('WITH RECURSIVE ancestors');
  expect(predicate.sql).toContain('page_permissions');
});
```

- [ ] **Step 2: Implement the predicate**

```ts
userCanAccessPagePredicate(userId: string, pageId: string): RawBuilder<SqlBool> {
  return sql<SqlBool>`NOT EXISTS (WITH RECURSIVE ancestors AS (...) SELECT 1 FROM ancestors ...)`;
}
```

The CTE begins at the candidate page ID, traverses its parents, and rejects the candidate when a restricted ancestor has neither a direct user permission nor a permission through a group containing `userId`.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/database/repos/page/page-permission.repo.ts apps/server/src/database/repos/page/page-permission.repo.spec.ts
git commit -m "feat(search): add query-time page access predicate"
```

### Task 2: Bound search DTO inputs

**Files:**
- Modify: `apps/server/src/core/search/dto/search.dto.ts`
- Test: `apps/server/src/core/search/dto/search.dto.spec.ts`

**Interfaces:**
- Produces: validated `SearchDTO.limit`, `SearchDTO.offset`, and `SearchSuggestionDTO.limit`.

- [ ] **Step 1: Write failing validation cases**

```ts
expect(await validate(new SearchDTO({ query: 'term', limit: 101 }))).not.toHaveLength(0);
expect(await validate(new SearchDTO({ query: 'term', offset: -1 }))).not.toHaveLength(0);
expect(await validate(new SearchSuggestionDTO({ query: 'term', limit: 26 }))).not.toHaveLength(0);
```

- [ ] **Step 2: Implement decorators**

```ts
@IsOptional() @IsInt() @Min(1) @Max(100) limit?: number;
@IsOptional() @IsInt() @Min(0) offset?: number;
@IsOptional() @IsInt() @Min(1) @Max(25) limit?: number;
```

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/core/search/dto/search.dto.ts apps/server/src/core/search/dto/search.dto.spec.ts
git commit -m "fix(search): bound pagination inputs"
```

### Task 3: Apply authorization before main-search pagination and suggestion limits

**Files:**
- Modify: `apps/server/src/core/search/search.service.ts`
- Create: `apps/server/src/core/search/search.service.spec.ts`
- Modify: `docs/ai-context/ai-search.md`

**Interfaces:**
- Consumes: `PagePermissionRepo.userCanAccessPagePredicate(userId, 'pages.id')`.
- Produces: existing `Promise<{ items: SearchResponseDto[] }>` and `{ users, groups, pages }` response shapes.

- [ ] **Step 1: Write failing service tests**

```ts
it('adds the user access predicate before main-search orderBy, limit, and offset', async () => {
  await service.searchPage({ query: 'runbook', limit: 25, offset: 25 }, auth);
  expect(query.limit).toHaveBeenCalledWith(25);
  expect(query.offset).toHaveBeenCalledWith(25);
  expect(pagePermissionRepo.filterAccessiblePageIds).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Implement query ordering**

```ts
if (opts.userId) {
  queryResults = queryResults.where(
    this.pagePermissionRepo.userCanAccessPagePredicate(opts.userId, 'pages.id'),
  );
}
queryResults = queryResults.orderBy('rank', 'desc').limit(limit).offset(offset);
```

Apply the same predicate to the page-suggestion query before `limit(limit)`. Remove the two post-query `filterAccessiblePageIds` filters. Keep the public-share branch's precomputed page-ID scope and `withSpace` selection behavior.

- [ ] **Step 3: Document and commit**

Add a compact statement to `docs/ai-context/ai-search.md`: PostgreSQL textual search and page suggestions apply page access inside the query before pagination/limits; main results cap at 100 and suggestions at 25.

```bash
git add apps/server/src/core/search/search.service.ts apps/server/src/core/search/search.service.spec.ts docs/ai-context/ai-search.md
git commit -m "fix(search): paginate only authorized pages"
```

### Task 4: Final verification

**Files:**
- Verify: `apps/server/src/core/search/**/*.spec.ts`
- Verify: `apps/server/src/database/repos/page/page-permission.repo.spec.ts`

- [ ] **Step 1: Run the focused server tests once**

```bash
pnpm --filter server test -- search.service.spec.ts page-permission.repo.spec.ts search.dto.spec.ts --runInBand
```

Expected: all affected search, DTO, and repository tests pass.

- [ ] **Step 2: Check the worktree**

```bash
git status --short
git log --oneline main..HEAD
```

Expected: only committed search-pagination changes are present.

