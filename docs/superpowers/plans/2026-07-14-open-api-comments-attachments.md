# Open API Comments and Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate and document API-key access to existing comments, files, images, avatars, and icons endpoints.

**Architecture:** Existing guarded controllers already implement these routes. Add a safe live harness and reference documentation; do not duplicate controllers or copy Enterprise code.

**Tech Stack:** NestJS, Node.js fetch/FormData, Docker Compose.

---

### Task 1: Build a live compatibility harness

**Files:**
- Create: `scripts/verify-open-api-comments-attachments.mjs`

- [ ] Read `apps/server/src/core/comment/comment.controller.ts` and `apps/server/src/core/attachment/attachment.controller.ts` to use the exact request fields and multipart endpoints.
- [ ] Create a Node 18+ script that requires `TESSERA_API_URL` and `TESSERA_API_KEY`, creates a temporary space/page, then creates, lists, reads, updates, and deletes a comment through `/comments/*`.
- [ ] Upload a small in-memory text fixture to the existing file route and image fixture to the existing image route using `FormData`; assert response envelopes and returned metadata without logging the API key.
- [ ] Exercise the existing avatar/icon upload, read, and icon removal routes with temporary fixture data where the controller permits the API-key user.
- [ ] Always delete the temporary space in `finally`; aggregate cleanup and primary failures.
- [ ] Run `node --check scripts/verify-open-api-comments-attachments.mjs`, run it without environment values to prove safe configuration errors, then execute it against the local Docker API using a temporary key.
- [ ] Commit only the script as `test: verify open API comments and attachments`.

### Task 2: Publish the route contract

**Files:**
- Create: `docs/open-api/comments-attachments.md`

- [ ] Document bearer authentication, response envelope and multipart upload requirements.
- [ ] Add endpoint tables for all comment, file, image, avatar, and icon operations found in the two controllers, including required body/form fields and permission behavior.
- [ ] Include a curl example without a real API key and state that API keys must never be committed.
- [ ] Run `git diff --check` and `corepack pnpm --filter ./apps/server run build`.
- [ ] Commit only the reference as `docs: document open API comments and attachments`.
