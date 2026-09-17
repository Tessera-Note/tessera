---
name: post-scope-review
description: The mandatory checklist before declaring any task finished. Applies after a fix, a feature or a refactor, before the word "done" in the answer to the user. It covers stub-hunter, the domain reviewer, a pattern grep for the same class of bug, a test coverage check, lint and a test run.
---

# Post-scope review

Run it after finishing any scope and before telling the user it is done. A step
may be skipped only if it is clearly not applicable, and then the report says so
with the words "not applicable".

## Step 1. stub-hunter

Run the `stub-hunter` agent over the changed production files.

Findings in the changed files are a blocker. A TODO, a FIXME, a debug `print` or
`console.log`, a stub instead of an implementation, an empty `except`, a route
with no guard. Fix them in the same session.

Findings in the rest of the code go into the report for reference; do not fix
them unasked.

## Step 2. The domain reviewer

| What you touched | Who to run |
|---|---|
| the schema, models, repositories, queries | `schema-reviewer` |
| user-facing strings, the locale dictionaries | `i18n-reviewer` |
| neither | not applicable, say so explicitly |

## Step 3. A pattern grep for the same class of bug

The most important step; it must not be cut short.

If the task fixed a specific class of problem, find every other place in the
repository with the same pattern. One fix in one place almost never closes the
class as a whole.

In this repository the same contract is usually implemented in several entry
points. So all of them have to be checked, not only the one where the bug was
found.

| Class of change | Where else to look |
|---|---|
| the page access check | the controller in `api/`, the MCP tools (`api/mcp.py`), the events in `services/realtime.py`, collaborative editing (`services/collab.py` and `services/collab`), search, export, public links, the AI context |
| the workspace filter | repositories, MCP, search, embeddings |
| rate limiting | the `/ai`, `/mcp`, `/pdf-export` routes |
| a failure code | the catalogue in `domain/errors.py` and the twelve dictionaries, plus `error-codes.test.ts` |
| updating the page tree | the local screen state, the call to the server, the Socket.IO event. All three must stay consistent |
| cleanup when access is lost | favourites, watchers, shares, embeddings |
| an effect after content is saved | the queues for history, mentions, backlinks, AI indexing, notifications |

How to do it: `Grep` by the signature of the pattern, or a separate
general-purpose agent with the task of finding the analogues. The result goes
into the report even when there are no analogues.

## Step 4. Test coverage gap

For every new public function, new conditional branch and new exception path,
check that a test exists.

- the application: `apps/api/tests`, run with `uv run --project apps/api pytest
  -k <substring>`
- the screens: next to the code, `*.test.ts`, run with `pnpm --filter
  @tessera/web test -- <path>`
- collaborative editing: `services/collab/src/*.test.js`, run with `node --test
  services/collab/src/*.test.js`

Check separately whether the tests against the database went into skips: without
`DATABASE_URL` they are marked `skipped`, and a green run then proves nothing.

If there is no test, add it in the same session. Do not rework the existing test
infrastructure while doing so.

## Step 5. Lint and tests

| What you touched | Commands |
|---|---|
| the application | `uv run --project apps/api ruff check .`, `uv run --project apps/api pytest` |
| the screens | `pnpm --filter @tessera/web lint`, `pnpm --filter @tessera/web check`, `pnpm --filter @tessera/web test` |
| collaborative editing | `node --test services/collab/src/*.test.js` |
| the extensions package | `pnpm --filter @tessera/editor-ext build` |
| a cross-layer task | everything listed above |

Neither the application lint nor the screens lint rewrites files: both commands
only check. Formatting is run separately and deliberately.

There must be no red tests in the final report. If a test was failing before
your changes, say so separately and show that the failure is unrelated to the
task.

## Step 6. The context for agents

Check whether behavior, architecture, a module boundary, a command,
configuration or a recurring pattern changed. If so, update the relevant file in
`docs/ai-context/` in the same task. If not, write in the report that the
assessment was made and no update is needed.

## Step 7. Checking your own claims

Re-read everything written in this same change: the comments in the code, the
commit message, the answer to the user.

Every claim about behavior is checked the way code is. The telltale words:
"must", "always", "never", "guarantees", "see below", "this is impossible".

In one session a comment promised three times what the code did not have:
password agreement that is not required; a decision made once, which was not;
a note page in an export that was never built. Every time it was written by the
same person who made the change, and every time it was caught later, by someone
else's eyes.

Do it as a step here rather than at the end of the answer: at the end it gets
forgotten.

## The format of the block in the answer

```
Post-scope review
1. stub-hunter: <result>
2. Domain reviewer: <which one, the result or not applicable>
3. Pattern grep: <what was searched for, how many places were found, what was done>
4. Test coverage: <which tests were added, or why none are needed>
5. Lint and tests: <the commands and their result>
6. docs/ai-context: <which file was updated, or why it is not needed>
7. Own claims: <what was re-read, what was corrected>
```

## What counts as a blocker

Fix it in the same session; do not report readiness.

- the same class of bug found somewhere else
- a test that does not work or that fails
- a mismatch between the database schema and the code
- a stub or debug output in production code
- a new path that serves content without a permission check

## What is not a blocker

Mention it in the report and do not fix it without confirmation: stylistic
remarks, deferred refactoring, findings in files the task never touched.
