# Search Pagination Security Design

## Goal

Make textual search and search suggestions return only authorized pages while
enforcing bounded request sizes, without changing their HTTP response shapes.

## Scope

- Validate main-search `limit` as 1–100 and `offset` as an integer >= 0.
- Validate suggestion `limit` as 1–25.
- Apply page-level access filtering before ordering and pagination for
  authenticated page search and page suggestions.
- Preserve public-share scoping and apply the main-search bounds to it.
- Leave the Typesense enterprise implementation and client API contracts
  unchanged.

## Design

`SearchDTO` and `SearchSuggestionDTO` own their respective validation ranges.
Their existing service defaults remain 25 and 10 when callers omit `limit`.

For authenticated PostgreSQL search, `SearchService` will incorporate the
existing restricted-ancestor access rule into the Kysely page query.  A page is
eligible only when no restricted ancestor lacks a direct or group permission
for the requesting user.  The resulting authorized query is then ordered by
rank and paginated, preventing empty or undersized pages caused by a later
in-memory filter.

Suggestions use the same query-time access predicate for page candidates
before their per-category limit is applied. User and group suggestions have no
page-level rule but receive the bounded suggestion limit as well.

Public share search remains constrained to the share root or its allowed,
non-restricted descendants. It does not use an authenticated-user predicate.

## Errors And Compatibility

Invalid pagination values are rejected by the existing global validation pipe
with Nest's normal 400 response. Responses remain `{ items }`; callers do not
need frontend changes. Existing search and share authorization behavior is
otherwise preserved.

## Verification

Add focused service tests that prove a restricted page cannot displace an
authorized result from an offset/limit page, suggestions do not consume their
limit with inaccessible pages, and DTO validation rejects values outside the
specified bounds. Run the relevant server test suite once after all changes.
