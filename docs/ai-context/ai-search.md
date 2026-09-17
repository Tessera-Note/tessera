# Search and the assistant

## Text search

`services/search.py`. Three subjects: pages, suggestions while typing,
attachments. Search runs on the PostgreSQL full-text index, and the triggers
that update `tsv` are declared in `after-atlas.sql`.

The results pass the permission check: a page you have no access to does not
appear among them. This is the same rule as in the HTTP output, and it must hold
here as well.

## The assistant

`services/ai.py`, `services/ai_chat.py`, `services/ai_settings.py`. Routes
`/api/ai` (three text-editing handlers), `/api/ai/chats` (nine chat handlers),
`/api/ai/settings` (five).

The provider is set by `AI_DRIVER` and is off until it is set. This is the only
call the set makes outside, apart from external SMTP.

Provider keys are stored encrypted (AES-256-GCM from `APP_SECRET`,
`infrastructure/secrets.py`). Only a masked preview is served outward — there
must be no path that returns a key in full.

A separate rate limit stands on all `/ai` routes: there is no global limit on
them.

## Embeddings

`services/embeddings.py`, `infrastructure/embeddings.py`. Stored in pgvector.
Indexing runs as a background job after the text is saved.

The width of the vector is tied to the model (`AI_EMBEDDING_MODEL`). Changing
the model requires both a schema change and reindexing: a vector of a different
width will not fit the existing index.

## Web search

`infrastructure/web_search.py` calls its own SearXNG. The assistant's
`search_web` tool uses it, and the set itself does not reach outside for that.

## Chat context

A chat can refer to a page and to an attachment. Everything that enters the
context passes the same access check as ordinary content output.
