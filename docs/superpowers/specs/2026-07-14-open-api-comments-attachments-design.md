# Open API: Comments and Attachments Design

## Goal

Make the documented Comment and Attachment APIs available to open-source API
keys, including page files and images, user avatars, and page or space icons.

## Architecture

The open-source `CommentController` and `AttachmentController` already expose
the required guarded routes. API-key JWT authentication resolves to the key
creator, so the existing controllers, page access checks, storage service, and
workspace rules remain authoritative. This phase adds a compatibility harness
and public route reference; it does not copy Enterprise code or duplicate
controllers.

## Scope

- Comments: `/comments/create`, `/comments`, `/comments/info`,
  `/comments/update`, and `/comments/delete`.
- Files and images: `/files/upload`, `/files/info`, and
  `/attachments/upload-image`.
- Avatars and icons: the existing guarded avatar/icon upload, lookup, and
  `/attachments/remove-icon` routes supported by `AttachmentController`.

## Behavior and validation

All successful responses retain `{ success, status, data }`. API keys inherit
the creator's permissions, so users can only comment on and attach data to
pages they may access. The executable harness creates an isolated temporary
space and page, uploads small temporary fixtures, verifies the returned
metadata and URLs, removes temporary icons where supported, then deletes the
temporary space. It never writes API keys to disk.

## Out of scope

Search, sharing, imports, exports, workspace administration, groups, and
Enterprise-only attachment search remain separate phases.
