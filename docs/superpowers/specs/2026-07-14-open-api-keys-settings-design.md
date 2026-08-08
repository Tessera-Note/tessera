# Open API keys in settings

## Goal

Make the existing API-key settings pages available in the open-source edition of
this Tessera fork, using the API-key endpoints implemented in Open API phase 1.

## Scope

- Show **API Keys** in Account settings for authenticated users.
- Show **API Keys** in Workspace settings for workspace administrators.
- Reuse the existing pages and API client under `apps/client/src/ee/api-key`.
- Keep the workspace page's existing administrator restriction.
- Do not copy Enterprise server code or introduce a licensing bypass outside the
  two navigation entries.

## Design

The client already registers both routes and the existing UI uses
`/api/api-keys`, `/create`, `/update`, and `/revoke`. The sidebar hides the two
links by associating them with `Feature.API_KEYS`; feature checks deny that
feature in the OSS edition.

Remove that feature requirement from only these two sidebar entries. The routes
and UI remain unchanged, so users see the established create, reveal-once,
rename, list, and revoke flows. Authorization continues to be enforced by the
API-key controller and the workspace UI's existing admin guard.

## Verification

1. Build the client.
2. In a logged-in browser session, confirm both sidebar links appear.
3. Create an account API key, use it for an authenticated API request, revoke
   it, and confirm the same request is rejected.
4. Confirm the workspace page remains inaccessible to a non-administrator.
