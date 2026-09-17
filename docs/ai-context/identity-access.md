# Sign-in and access

## Sign-in

`api/auth.py`, `services/auth.py`. The routes cover sign-in, instance setup, the
"setup required" flag, the session list, revoking one session and all of them,
sign-out, password change, forgotten password, password reset, invitation check,
the collaboration token, and information about yourself.

- the password is stored as a bcrypt hash
- the session is kept in a cookie, and the token is signed with `APP_SECRET`
- sessions are listable and revocable one by one, `services/tokens.py`
- the workspace is determined by the request host name

Instance setup writes seven related rows. The order between them is enforced by
the database foreign keys rather than by the code: the reference to the default
space is set after the space itself is created.

### Matching a person when signing in through a provider

`SsoIdentityService.resolve` (`services/sso.py`) looks a person up in this
order: the link by provider identifier, then the immutable key, then the email
address. The key is a claim that an administrator picked at the provider
(`auth_providers.match_claim_name`, the "immutable claim for matching" field);
the value is stored next to the link (`auth_accounts.match_claim_value`) and is
written to older links on an ordinary sign-in. The key is there for the case
where both the identifier and the email changed at the provider at once: both
earlier lookups miss then. A match by key outweighs the link and moves it to the
new identifier (`user.sso_relinked`); two links with the same key are a refusal,
`error.sso.identity_conflict`. The claim must be one that a person cannot edit at
the provider, otherwise it becomes a way into someone else's account.

Without the key such a sign-in creates a new record, but not silently: if an
active member has the same name, `user.sso_possible_duplicate` goes into the
audit log, and an administrator resolves it with the "this is the same person"
action on the members screen (`SsoProviderService.merge_duplicate`,
`POST /api/sso/merge`). The duplicate's links move to the earlier record, the
duplicate is deactivated by the ordinary `set_active` with its sessions revoked,
and `user.sso_merged` goes into the log.

The uniqueness of the "person, provider" pair in `auth_accounts` does not take
soft deletion into account. That is why `_link` revives a removed link instead of
inserting a second row: otherwise a sign-in after "unlink" would fail on it.

## Roles

`domain/roles.py`.

| Level | Roles |
| --- | --- |
| workspace | `owner`, `admin`, `member` |
| space | `admin`, `writer`, `reader` |
| page | individual permissions on top of the space, `services/page_permissions.py` |

A workspace must keep at least one active owner. You cannot change your own
role.

## Page permissions

`services/page_access.py` assembles the permissions along the ancestor chain.
Space membership is not enough: access to every restricted ancestor is required,
and the nearest restricted ancestor decides the write permission.

Any new way of serving page content must go through that path — including
search, export, public links, the AI context and the MCP tools.

A page from another workspace is served as "not found" rather than "no access":
otherwise identifiers could be enumerated.

## API keys

`api/api_keys.py`, `services/api_keys.py`. Four routes: list, create, edit,
revoke. A key is stored as a hash and returned in full exactly once, when it is
created.

## Invitations

`api/invitations.py`. An invitation lives as a token, and accepting it creates a
workspace member.

## Groups and spaces

`api/spaces.py` holds spaces, groups and the personal space. Space members are
set both one by one and through groups.

When access is lost, the related rows are removed in the same transaction:
favourites and watchers. A new access link must do the same.
