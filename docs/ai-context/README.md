# Context for agents

This directory is the stable technical context of the repository. It complements
`AGENTS.md` and `CLAUDE.md`, but does not replace the code, the executable
configuration or the product documentation.

## Selective reading

| Task | Files to read |
| --- | --- |
| Understand the product, the applications or the main flow | `system-overview.md` |
| Change routes, authentication, permissions or the application layers | `backend.md`, `code-patterns.md` |
| Change sign-in, sessions, API keys, the workspace, groups or spaces | `identity-access.md`, `backend.md` |
| Change screens, routes, state, forms or calls to the server | `frontend.md`, `code-patterns.md` |
| Change pages, comments, attachments, public links or the tree | `content-workflows.md`, plus `identity-access.md` where permissions are involved |
| Change the editor, Yjs, Socket.IO, collaborative editing or history | `collaboration-realtime.md`, `content-workflows.md` |
| Change the schema, storage, queues or the environment | `data-runtime.md`, and `backend.md` if needed |
| Change storage, mail, import, export, background jobs or health checks | `integrations-jobs.md`, `data-runtime.md` |
| Change the tools, authentication or configuration of MCP | `mcp.md`, `backend.md` |
| Change AI, search, embeddings or chat | `ai-search.md`, and `mcp.md` if needed |
| Change bases or templates | `bases-templates.md`, `identity-access.md` |
| Change SSO, SCIM, MFA or page verification | `enterprise-security.md`, `identity-access.md` |
| Create or change tests, the build, lint, Docker or deployment | `verification-operations.md` |
| Look for the cause of a divergence that shows no symptom | `silent-divergence.md` |
| Make a change that crosses layers | Start with `system-overview.md` and read the files of the layers involved |

## Mandatory upkeep

- Every change must assess whether it touched behavior, architecture, a module
  boundary, a command, configuration or a recurring pattern.
- If it did, update the corresponding topic file in the same piece of work and
  say so in the final response.
- Do not update the context for internal edits that change none of the contracts
  listed above. State in the final response that the assessment was made.
- Prefer verifiable facts and paths in the code. Do not copy large blocks of
  code, exhaustive route listings or plans for current tasks here.

## Files

- `system-overview.md`: purpose, boundaries, parts of the set, entry points and
  flows.
- `backend.md`: Litestar, application layers, routes, authentication, workspace.
- `frontend.md`: SvelteKit and Svelte 5, routes, code organization, state, calls
  to the server.
- `data-runtime.md`: database, schema through Atlas, models, environment and
  runtime services.
- `identity-access.md`: authentication, sessions, API keys, workspaces, groups,
  spaces and authorization.
- `content-workflows.md`: pages, tree, comments, attachments, public links,
  history.
- `collaboration-realtime.md`: the Tiptap and Yjs editor, Hocuspocus, Socket.IO,
  saving a document.
- `integrations-jobs.md`: queues, storage, mail, import and export, health
  checks, telemetry.
- `ai-search.md`: text search, the assistant, chat, embeddings and what they
  require.
- `bases-templates.md`: bases, formulas, templates.
- `enterprise-security.md`: SSO, SCIM, MFA, audit, page verification.
- `mcp.md`: the MCP route, the JSON-RPC protocol, tools, authorization, limits.
- `code-patterns.md`: recurring implementation and test patterns in both layers.
- `verification-operations.md`: commands, checks, Docker, signing in to the
  stand, deployment.
- `silent-divergence.md`: how to look for divergences that do not show up as a
  failure.
