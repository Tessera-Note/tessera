# Realtime Session Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure that only the server publishes page-tree Socket.IO events and that a revoked session cannot use a realtime connection.

**Architecture:** Socket.IO handshakes validate the access token's backing `userSessions` record, matching HTTP JWT validation. Authorized page operations publish the existing `refetchRootTreeNodeEvent` from the server; clients retain local optimistic updates but never publish tree changes.

**Tech Stack:** NestJS, Socket.IO, Kysely, Jest/ts-jest, React 19, Jotai, TanStack Query, Vitest.

---

## File Structure

- `apps/server/src/ws/ws.gateway.ts`: validates active sessions at connection time and ignores browser tree messages.
- `apps/server/src/ws/ws.service.ts`: emits server-only tree refreshes and closes sockets of revoked sessions.
- `apps/server/src/core/session/session.service.ts`: disconnects sockets after session revocation.
- `apps/server/src/core/page/page.controller.ts`: emits refreshes after successful authorized mutations.
- `apps/client/src/features/websocket/use-tree-socket.ts`: discards stale state for a server-refreshed tree.
- `apps/server/src/ws/ws.gateway.spec.ts`, `ws.service.spec.ts`, and `core/session/session.service.spec.ts`: regression coverage.

### Task 1: Validate the backing session during Socket.IO handshake

**Files:**

- Create: `apps/server/src/ws/ws.gateway.spec.ts`
- Modify: `apps/server/src/ws/ws.gateway.ts:24-89`

- [ ] **Step 1: Write failing session tests**

```ts
it('rejects an access token whose session was revoked', async () => {
  tokenService.verifyJwt.mockResolvedValue(accessPayload);
  userSessionRepo.findActiveById.mockResolvedValue(undefined);

  await gateway.handleConnection(client);

  expect(client.emit).toHaveBeenCalledWith('Unauthorized');
  expect(client.disconnect).toHaveBeenCalled();
});

it('joins rooms when the token has an active matching session', async () => {
  tokenService.verifyJwt.mockResolvedValue(accessPayload);
  userSessionRepo.findActiveById.mockResolvedValue(activeSession);

  await gateway.handleConnection(client);

  expect(client.data.sessionId).toBe(activeSession.id);
  expect(client.join).toHaveBeenCalled();
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter server test -- ws/ws.gateway.spec.ts --runInBand`

Expected: the revoked-session assertion fails because the gateway checks only the JWT signature.

- [ ] **Step 3: Implement the minimal handshake validation**

```ts
const session = await this.userSessionRepo.findActiveById(token.sessionId);
if (!session || session.userId !== token.sub || session.workspaceId !== token.workspaceId) {
  throw new UnauthorizedException();
}
client.data.sessionId = session.id;
```

Inject `UserSessionRepo`; require an access-token `sessionId` before joining rooms.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm --filter server test -- ws/ws.gateway.spec.ts --runInBand`

Expected: both handshake tests pass.

- [ ] **Step 5: Commit**

Run: `git add apps/server/src/ws/ws.gateway.ts apps/server/src/ws/ws.gateway.spec.ts && git commit -m "fix(ws): validate active sessions on connection"`

### Task 2: Reject browser-originated tree events

**Files:**

- Modify: `apps/server/src/ws/ws.gateway.ts:78-85`
- Test: `apps/server/src/ws/ws.gateway.spec.ts`

- [ ] **Step 1: Write a failing trust-boundary test**

```ts
it('does not relay a client-sent tree event', async () => {
  await gateway.handleMessage(client, {
    operation: 'deleteTreeNode',
    spaceId: 'space-id',
    payload: { node: { id: 'page-id' } },
  });

  expect(wsService.handleTreeEvent).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter server test -- ws/ws.gateway.spec.ts --runInBand`

Expected: it fails because `handleMessage` forwards tree operations.

- [ ] **Step 3: Keep only trusted base realtime messages**

```ts
async handleMessage(client: Socket, data: unknown): Promise<void> {
  if (this.baseRealtime.isBaseEvent(data)) {
    await this.baseRealtime.handleInbound(client, data);
  }
}
```

- [ ] **Step 4: Verify GREEN and commit**

Run: `pnpm --filter server test -- ws/ws.gateway.spec.ts --runInBand`

Run: `git add apps/server/src/ws/ws.gateway.ts apps/server/src/ws/ws.gateway.spec.ts && git commit -m "fix(ws): reject client-originated tree events"`

### Task 3: Publish trusted refreshes and disconnect revoked sockets

**Files:**

- Create: `apps/server/src/ws/ws.service.spec.ts`
- Create: `apps/server/src/core/session/session.service.spec.ts`
- Modify: `apps/server/src/ws/ws.service.ts:18-63`
- Modify: `apps/server/src/core/session/session.service.ts:84-101`

- [ ] **Step 1: Write failing WebSocket service tests**

```ts
it('publishes a root-tree refresh to the space room', () => {
  service.emitTreeRefresh('space-id');

  expect(server.to).toHaveBeenCalledWith('space-space-id');
  expect(room.emit).toHaveBeenCalledWith('message', {
    operation: 'refetchRootTreeNodeEvent',
    spaceId: 'space-id',
  });
});

it('disconnects every socket for a revoked session', async () => {
  server.fetchSockets.mockResolvedValue([matchingSocket, otherSocket]);
  await service.disconnectSession('session-id');

  expect(matchingSocket.disconnect).toHaveBeenCalledWith(true);
  expect(otherSocket.disconnect).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter server test -- ws/ws.service.spec.ts --runInBand`

Expected: the new methods do not exist.

- [ ] **Step 3: Implement server-only helpers**

```ts
emitTreeRefresh(spaceId: string): void {
  this.server.to(getSpaceRoomName(spaceId)).emit('message', {
    operation: 'refetchRootTreeNodeEvent',
    spaceId,
  });
}

async disconnectSession(sessionId: string): Promise<void> {
  for (const socket of await this.server.fetchSockets()) {
    if (socket.data.sessionId === sessionId) socket.disconnect(true);
  }
}
```

- [ ] **Step 4: Add the session service regression**

```ts
it('disconnects a session after revoking it', async () => {
  await service.revokeSession('session-id', 'user-id', 'workspace-id');
  expect(wsService.disconnectSession).toHaveBeenCalledWith('session-id');
});
```

- [ ] **Step 5: Implement and verify**

Inject `WsService` into `SessionService`; call `disconnectSession` after `revokeById`. For revoke-all, load the user's active sessions before revocation, exclude the current session ID, revoke, then disconnect each captured ID.

Run: `pnpm --filter server test -- ws/ws.service.spec.ts core/session/session.service.spec.ts --runInBand`

Expected: all new service tests pass.

- [ ] **Step 6: Commit**

Run: `git add apps/server/src/ws/ws.service.ts apps/server/src/ws/ws.service.spec.ts apps/server/src/core/session/session.service.ts apps/server/src/core/session/session.service.spec.ts && git commit -m "fix(session): disconnect revoked realtime sessions"`

### Task 4: Synchronize page trees from authorized server operations

**Files:**

- Create: `apps/server/src/core/page/page.controller.spec.ts`
- Modify: `apps/server/src/core/page/page.controller.ts:202-305,307-370,372-410,707-737`
- Modify: `apps/client/src/features/page/tree/hooks/use-tree-mutation.ts`
- Modify: `apps/client/src/features/page/queries/page-query.ts`
- Modify: `apps/client/src/features/page/components/page-import-modal.tsx`
- Modify: `apps/client/src/features/page/tree/components/space-tree-row.tsx`
- Modify: `apps/client/src/features/page/tree/components/space-tree-node-menu.tsx`
- Modify: `apps/client/src/features/editor/title-editor.tsx`
- Modify: `apps/client/src/features/editor/components/mention/mention-list.tsx`
- Modify: `apps/client/src/features/websocket/use-tree-socket.ts`

- [ ] **Step 1: Write failing controller delegation tests**

```ts
await controller.update({ pageId: page.id, title: 'Renamed' }, user);

expect(wsService.emitTreeRefresh).toHaveBeenCalledWith(page.spaceId);
```

Cover successful create, update, soft delete, restore, and move. Add a move-to-space case that expects refreshes for both source and destination spaces.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter server test -- core/page/page.controller.spec.ts --runInBand`

Expected: no page controller action calls `emitTreeRefresh`.

- [ ] **Step 3: Emit only after successful authorized mutations**

Inject `WsService` into `PageController`. Immediately after each successful page mutation, call `emitTreeRefresh(page.spaceId)`. For `move-to-space`, publish both spaces. Do not emit in a failure path.

```ts
const updatedPage = await this.pageService.update(page, updatePageDto, user);
this.wsService.emitTreeRefresh(updatedPage.spaceId);
return { ...updatedPage, permissions };
```

- [ ] **Step 4: Remove client tree broadcasts**

Delete imports, hook calls, and `emit({ operation: ...TreeNode })` or page `updateOne` blocks from every listed client file. Preserve optimistic updates, query-cache writes, navigation, and notifications.

- [ ] **Step 5: Clear stale local state when the server refreshes a space**

```ts
case 'refetchRootTreeNodeEvent':
  setTreeData((prev) => prev.filter((node) => node.spaceId !== event.spaceId));
  break;
```

The existing query subscription refetches `root-sidebar-pages`, and `SpaceTree` rebuilds the new tree.

- [ ] **Step 6: Verify GREEN and commit**

Run: `pnpm --filter server test -- core/page/page.controller.spec.ts ws/ws.gateway.spec.ts ws/ws.service.spec.ts core/session/session.service.spec.ts --runInBand`

Run: `pnpm --filter client test -- src/features/page/tree/model/tree-model.test.ts`

Run: `git add apps/server/src/core/page/page.controller.ts apps/server/src/core/page/page.controller.spec.ts apps/client/src/features/page apps/client/src/features/editor apps/client/src/features/websocket/use-tree-socket.ts && git commit -m "fix(realtime): publish page tree updates from server"`

### Task 5: Document and verify

**Files:**

- Modify: `docs/ai-context/identity-access.md`
- Modify: `docs/ai-context/collaboration-realtime.md`

- [ ] **Step 1: Update stable context**

Document active-session validation for Socket.IO, immediate disconnect after revocation, ignored browser-originated tree events, and server-published root refreshes.

- [ ] **Step 2: Run static and behavioral verification**

Run: `pnpm --filter client lint`

Run: `pnpm --filter server test -- --runInBand`

Run: `pnpm --filter client test`

Run: `pnpm --filter client build`

Expected: each command exits with status 0. If the TanStack ESLint package remains incomplete, restore dependencies with `pnpm install --frozen-lockfile` before rerunning lint.

- [ ] **Step 3: Commit documentation**

Run: `git add docs/ai-context/identity-access.md docs/ai-context/collaboration-realtime.md && git commit -m "docs: document realtime session security"`

## Plan Self-Review

- Tasks 1 through 3 cover rejected handshakes, immediate revocation disconnection, and forged-event rejection.
- Task 4 preserves multi-tab synchronization while moving its authority to successful server mutations.
- Task 5 records stable behavior and runs all project-required checks.
- The shared method names are `emitTreeRefresh`, `disconnectSession`, and `sessionId` throughout the plan.
