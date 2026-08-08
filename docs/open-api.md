# Open API

This fork enables Tessera's existing open-source HTTP controllers for personal
API keys. Use `Authorization: Bearer <API_KEY>` with the `/api` prefix. Keys
inherit the permissions of the user who created them.

Successful JSON responses use `{ "data": ..., "success": true, "status": 200 }`.
File uploads and downloads return their native HTTP payloads instead. List
routes use the existing cursor fields: `limit`, `cursor`, and `beforeCursor`.

## Verified resource groups

- API keys: list, create, rename, revoke.
- Spaces and pages: CRUD, members, trees, moves, duplication, history, trash,
  restore, breadcrumbs and recent pages.
- Comments and attachments: comment CRUD, file upload/info, image upload,
  avatar and space icon handling.
- Search and shares: search, suggestions, public-share lifecycle and lookup.
- User, workspace and groups: profile, workspace information/members and group
  CRUD.
- Import and export: page/space export, Markdown import and file-task list.

## Compatibility verifiers

Run from the repository root after setting the two environment variables:

```powershell
$env:TESSERA_API_URL = 'http://localhost:3000/api'
$env:TESSERA_API_KEY = 'your-temporary-key'
node scripts/verify-open-api-spaces-pages.mjs
node scripts/verify-open-api-comments-attachments.mjs
node scripts/verify-open-api-search-shares.mjs
node scripts/verify-open-api-workspace-groups.mjs
node scripts/verify-open-api-import-export.mjs
node scripts/verify-open-api-system.mjs
node scripts/verify-open-api-invites.mjs
```

The verifiers create and clean up their own temporary data. Never commit a real
API key.

For membership mutations, use a dedicated second test account:

```powershell
$env:TESSERA_SECOND_USER_ID = 'second-test-user-uuid'
node scripts/verify-open-api-multi-user.mjs
node scripts/verify-open-api-workspace-members.mjs
```

## Endpoints that need a separate actor or external delivery

Workspace invitations use an `example.invalid` address and are revoked by the
verifier. Member role changes and group/space member mutations are covered by
the multi-user verifier using a temporary second account. API keys can call
them when their creator has the required administrator permission.
