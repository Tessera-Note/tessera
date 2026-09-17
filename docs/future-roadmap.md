# Deferred work

The only document for deferred tasks, both functional and infrastructural. It
holds only what is still ahead: an item that gets implemented is removed from
the document in the same session in which it is closed.

State verified against the code on 17 September 2026.

Records of closed work stay in the repository history
(`git log -- docs/future-roadmap.md`).

## The dictionaries have not been proofread by native speakers

All twelve dictionaries were translated as part of the work and have not been
proofread by native speakers — worth knowing when accepting the result.

The tooling is there: `scripts/locale-review.mjs`, with the procedure in its
header. The table export gives a proofreader only the strings that appeared or
changed since the last pass. The import compares substitutions against the
English source and writes nothing when they diverge. The "read up to this
commit" mark is kept in `docs/i18n-review-marks.json` and is still empty: the
first pass for every language is a full one, 1144 strings (1156 for ru and uk,
with the plural forms; measured by `locale-review.mjs status` on 17 September
2026).

What is left is the proofreading itself: find a native speaker for each
language, export, import, set the mark.

Crowdin is off deliberately (6 September 2026) and will stay off until there are
outside translators. It holds none of the current translations, and the very
first pull from it would silently return twelve languages to English. How to
turn it on, if that decision changes, is written in `crowdin.yml` itself.

## Soft-deleted rows come back if the deployment is rolled back

Rows are deleted softly: the row stays with a `deleted_at` mark, for the sake of
incident analysis. An older deployment that reads some of those tables without
the mark brings four kinds of row back:

- **spaces** (`SpaceService.delete`) — selected without the mark
  (`getSpacesInWorkspace`, `getUserSpaceIdsQuery`, `findById`, `findBySlug` in
  the space repositories), so a deleted space is visible again to everyone who
  was a member — empty, with its pages in the trash;
- **public links** (`ShareService.revoke`) — found by key and by page without the
  mark (`share.repo.ts`), so a revoked link opens the page again;
- **space members** (`SpaceService.remove_member`) — roles are returned without
  the mark (`getUserSpaceRoles` in `space-member.repo.ts`), so a removed member
  gets access again;
- **comments** (`CommentService.delete`) — not filtered by the mark at all
  (`comment.repo.ts`).

The remaining seventeen tables with the mark were checked one by one: nothing
comes back from them.

This is closed by procedure and by the guard `deploy/rollback-check.sql`: links,
members and comments are deleted with SQL before the proxy configuration is
returned, and spaces are listed and then deleted through the older deployment
right after. Giving up soft deletion would remove the incident analysis it
exists for. The item is closed once an older deployment is no longer a rollback
path; until then the guard is mandatory on every rollback.

## `base_views` is ordered without an index on the order key

**Not critical: the volume per page is small.**

`apps/api/tessera_api/services/bases.py:1088` sorts base views by `position`,
and the table has one index — `idx_base_views_page_id` on `page_id`. It is the
only one of the four tables with an order key that has no index on it: `pages`,
`base_rows` and `base_properties` have theirs in `after-atlas.sql`. Noticed by
the schema reviewer on 16 September 2026.

Revisit when a base gets dozens of views per page. Right now there are a few,
and the sort runs over a handful of rows.

## Page permission cache: revisit when the tables fill up

The question was closed by measurement, not by argument: `canUserEditPage` ran
in 0.154 ms with `page_access` and `page_permissions` empty. A cache would
protect the query for less than its own Redis round trip, and it would buy a
window in which a revoked permission still works.

Half of the conditions have changed: the permission editing routes exist now, so
the tables will stop being empty. Revisit when real volumes accumulate there,
and measure again at the real tree depth instead of carrying the old estimate
over.

The scheme, if the answer changes: a generation mark, a key of the form
`perm:can-edit:g<mark>:<userId>:<pageId>`, and any permission change moves the
mark. The mark is global rather than per space: permission edits are rare, and a
global mark cannot be forgotten.

## The comments in the sources are in Russian

The documentation, the agent configuration, the deployment files and the
repository scripts are in English. The comments, docstrings and test names in
the sources are not: 21010 lines across 627 files — `apps/api` 13807 lines in
219 files, `apps/web` 6382 in 359, `services/collab` 540 in 11, `services/hub`
202 in 28, `packages/editor-ext` 79 in 10 (measured 17 September 2026, the
locale dictionaries excluded).

This was deliberately not done in one pass: the post-release policy allows
minimal diffs only, the project rule says comments stay in the language of the
file being edited, and a rewrite of that size touches production code without
changing any behavior. The decision needed is whether the sources move to
English at all; if they do, the cheap path is one directory per commit, with the
checks of that part after each.

## Observations, not defects

**The `SEARXNG_SECRET` variable in compose has no effect.** The SearXNG image
substitutes it by editing `/etc/searxng/settings.yml` at startup, and that file
is mounted read-only, so the substitution does not go through and the literal
from `deploy/searxng/settings.yml` stays. Acceptable while the service is not
published: the key signs the form state of SearXNG's own interface, which the
application does not use. If the service is ever published, the key has to move
to a writable volume, and the line in compose has to be either used or removed.

**The presence list keeps a tab that left until the awareness timeout expires.**
Visible after a page reload: the previous tab stays in the list as a separate
entry for a few seconds. It clears itself, and it can only be fixed on the
library side.

## What does not belong in this document

Tasks of the current session are tracked by task tooling, not here. Only what is
deferred deliberately and needs a separate decision goes in.
