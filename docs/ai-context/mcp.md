# MCP

## The route

`api/mcp.py`, a single handler on the path `/mcp` — outside the common `/api`
prefix, as the protocol requires. The tools themselves are implemented in
`services/mcp.py`.

JSON-RPC over HTTP: version negotiation, listing the tools, calling a tool. A
tool failure comes back as a result rather than as a protocol error — otherwise
the client considers the whole session broken.

## Authentication

By API key. The call has exactly the permissions of the person the key belongs
to: the page access check goes the same way as in HTTP.

Its own rate limit: there is no global limit on `/mcp`.

## Tools

63 of them. The groups.

| Group | Examples |
| --- | --- |
| spaces and pages | `list_spaces`, `list_pages`, `get_page`, `create_page`, `update_page`, `move_page`, `duplicate_page`, `restore_page`, `list_trash` |
| search | `search_workspace`, `search_semantic`, `search_attachments`, `search_everything`, `search_web` |
| discussion and labels | `list_page_comments`, `create_comment`, `update_comment`, `list_labels`, `add_page_labels`, `find_pages_by_label` |
| attachments and export | `upload_attachment`, `get_attachment_info`, `export_page` |
| templates | `get_template`, `create_template`, `update_template`, `delete_template`, `use_template` |
| bases | `list_bases`, `create_base`, `convert_page_to_base`, `export_base_csv`, properties, rows and views |
| the rest | `list_favorites`, `add_favorite`, `list_page_history`, `get_page_version`, `reindex_embeddings` |

## The rule when adding a tool

A tool is one more point of the same contract. A new tool that serves page
content must pass `services/page_access.py`, not only the check of membership in
a space.

The converse holds too: a rule added in HTTP has to be checked here as well.
