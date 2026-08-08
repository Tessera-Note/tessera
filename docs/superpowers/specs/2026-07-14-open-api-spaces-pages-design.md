# Open API: Spaces and Pages Design

## Goal

Expose the documented Tessera API for spaces and pages in the open-source
edition. API keys created in Phase 1 authenticate the requests and retain the
permissions of their creator.

## Scope

### Spaces

Implement the documented endpoints for listing and managing spaces:

- `POST /spaces`
- `POST /spaces/info`
- `POST /spaces/create`
- `POST /spaces/update`
- `POST /spaces/delete`
- `POST /spaces/members`
- `POST /spaces/members/add`
- `POST /spaces/members/remove`
- `POST /spaces/members/change-role`

### Pages

Implement the documented endpoints for page CRUD and navigation:

- `POST /pages/info`
- `POST /pages/create`
- `POST /pages/update`
- `POST /pages/delete`
- `POST /pages/restore`
- `POST /pages/recent`
- `POST /pages/trash`
- `POST /pages/history`
- `POST /pages/history/info`
- `POST /pages/sidebar-pages`
- `POST /pages/move-to-space`
- `POST /pages/duplicate`
- `POST /pages/move`
- `POST /pages/breadcrumbs`

The phase excludes comments, attachments, search, shares, imports, exports,
users, workspace administration, and groups.

## Architecture

The open-source `SpaceController` and `PageController` already expose every
endpoint in scope. Phase 1 makes these routes available to API keys through the
shared JWT guard, so this phase must not create duplicate controllers or DTOs.
It adds an executable compatibility harness and concise API reference proving
the existing routes work with API keys. The global response interceptor already
normalizes successful results to `{ success, status, data }`.

List endpoints use cursor pagination with `limit` constrained to 1--100 and a
default of 20. Cursor values are opaque base64 values. The response includes
`items` and `meta` with the official cursor fields.

## Authorization and lifecycle

Every route uses the existing JWT guard. A bearer API key resolves to its
creator and workspace, so each operation behaves as if that user made the
request in the UI. Existing space and page permission rules remain the source
of truth.

Deleting a page performs the existing soft-delete/trash behavior; restoring a
page reverses it when the creator still has permission. Deleting a space uses
the existing space deletion behavior and its safeguards.

## Compatibility and validation

Request DTOs and response payloads will follow the current official OpenAPI
reference. The implementation may reuse only code included in this fork or
other open-source upstream code under a compatible license; Enterprise-only
source is not copied.

Validation covers server and client builds, direct API calls authenticated by a
temporary key, permission-denied cases, cursor traversal, and page lifecycle
(create, update, move, duplicate, trash, restore).
