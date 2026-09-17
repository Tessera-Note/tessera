# Pages and content

## Pages

`api/pages.py` is the largest controller. Besides the pages themselves it holds
comments, labels and favourites.

What it covers: the tree with drag and drop, moving between spaces,
duplication, breadcrumbs, trash and restore, recents, version history,
backlinks, and including one page inside another
(`services/transclusion.py`).

Order in the tree is held by a fractional key (`position`). The collation of the
column and of the indexes is set to `C` — byte by byte. Under the database
collation `en_US.utf8` the character `h:` sorts before `h0`, and the eleventh row
of a list jumps to the top.

## Title and text

The page text lives in the collaborative document and travels over the `/collab`
channel. The title is edited with an ordinary call to the server, outside the
collaborative document.

## Comments

`services/comments.py`. Discussion threads, resolving a thread, watcher
comments. A separate route jumps to a comment from a link.

## Attachments

`api/attachments.py`, routes under `/api/attachments` and `/api/files`. Storage
sits behind `infrastructure/storage.py`.

The text of an attachment goes into search: `services/attachment_index.py`
parses plain text, Markdown, JSON, PDF and DOCX. An image, an archive and a
scanned PDF will never get into search — that rule lives on the server and must
not be repeated on the screen.

An image behind a foreign link is moved into attachments
(`services/media_fetch.py`): a link to someone else's server opens today and not
tomorrow, and in a closed network it does not open at all.

Pages written before that move became automatic are fixed by a pass in
`services/media_rehost.py`. An administrator starts it
(`POST /api/workspace/rehost-images`), the work runs as the
`workspace-rehost-images` job in chunks of `MAX_PAGES_PER_RUN` pages with a
cursor by identifier: the job limit is ten minutes, and a single download waits
twenty seconds. The result is the audit record `workspace.images_rehosted` with
the list of addresses that did not open: there is nothing to download from a dead
address, and a person fixes such a page.

## Embedded videos

A link to a video becomes a player instead of staying a link. Two places:

- `lib/features/editor/extensions/embed-paste.ts` recognizes a pasted address.
  Its priority is above parsing the clipboard as Markdown: that one takes the
  paste first and never lets the link reach the paste rules.
- `lib/features/editor/views/EmbedView.svelte` shows the `embed` node as a
  player, and an empty node (the one the menu item inserts) as a field for the
  address. Earlier the node was drawn as a link, and "embedding" embedded
  nothing.

Address parsing is shared by both — `getEmbedUrlAndProvider` from the extension
package, which also knows Vimeo and the other services. An unknown address is
marked as `iframe` by the parser, and such a link stays a link: otherwise any
pasted address would turn into an embedded window.

A video opens through `youtube-nocookie`: the ordinary address sets tracking
cookies before "play" is even pressed. The window permissions are restricted to
a list, and full-screen playback is kept.

On a printed sheet the node shows its title and address as a link instead of an
empty frame: a foreign window does not load in print. The print flag is set by
the sheet renderer (`lib/stores/print.svelte.ts`).

## Public links

`services/shares.py`. A link lives as a key and is served by the `(share)` route
shell. Resolving a link checks the permissions on the page itself and on its
ancestors.

## Import and export

`services/imports.py`, `services/import_archives.py`, `services/exports.py`,
`services/docx.py`, `services/docx_import.py`, `services/odt_import.py`,
`services/spreadsheet.py`.

Import: Markdown, HTML, DOCX, ODT, PDF, Confluence dumps, spreadsheet formats.
PDF parsing happens on the `services/collab` side: the quality of the parsing is
a property of the library, not of the language.

The page title is taken from the first heading of the document, and that heading
is then removed from the body by `drop_title_heading` — otherwise the same text
shows up both in the tree and as the first line of the page. The removal must be
in place on every path where the title comes from a heading: Markdown, HTML,
DOCX, PDF and a Confluence dump page. The comparison ignores case and extra
spaces; a heading that does not match the title stays part of the document.

Images travel with the document where the parser returns them: DOCX and ODT hand
over a list of images along with the markup, and the shared import path uploads
them as attachments and substitutes their addresses.

Export: Markdown, HTML, DOCX, PDF. PDF rendering is done by Gotenberg through
the `(render)` route of the screens.

## History

`services/history.py`. A version is written by a background job after the text is
saved. Mentions, backlinks, indexing for AI and notifications go the same way —
moving any of that into the request itself is not allowed without assessing
idempotency.
