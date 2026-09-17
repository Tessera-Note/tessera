# Security and corporate features

## Signing in through a provider

`api/sso.py` (13 routes), `services/sso.py`, `services/sso_providers.py`,
`services/saml.py`, `services/oidc.py`, `services/ldap.py`.

Three kinds of providers: SAML (signatures through `signxml`), OIDC, LDAP
(`ldap3`). The provider's response is received on a root path rather than under
`/api`: the protocol itself requires that.

A workspace can require signing in through a provider only. For that case there
is an emergency password sign-in — it is switched on by a setting and is closed
by default.

## SCIM

`api/scim.py` (16 routes), `api/scim_tokens.py`, services `scim_users.py`,
`scim_groups.py`, `scim_filter.py`, `scim_schemas.py`, `scim_tokens.py`.

A token is 256 bits from `secrets.token_urlsafe`, stored as a hash and compared
in constant time. There is deliberately no rate limiter on the SCIM routes:
guessing such a token over the network is no threat, and four open routes serve
a static description of the protocol.

SCIM failures deliberately stay in English: they are read by an identity
management system rather than by a person, and the format of a failure is set by
the protocol.

## Second factor

`api/mfa.py` (11 routes), `services/mfa.py`. Time-based one-time codes and
backup codes. Its own rate limit.

## Audit

`api/audit.py` (three routes), `services/audit.py`. The retention period is a
workspace setting, from 0 to 3650 days. The client address in an audit record
depends on `TRUST_PROXY_HOPS`.

## Page verification

`api/page_verification.py` (nine routes), `services/page_verification.py`. A
page gets a verification state and a deadline, and an hourly pass over the
deadlines sends notifications.

## Secrets

- never log sign-in tokens, `APP_SECRET`, AI provider keys, SMTP passwords,
  SCIM tokens or `COLLAB_INTERNAL_TOKEN`
- AI provider keys are encrypted with AES-256-GCM from `APP_SECRET`
  (`infrastructure/secrets.py`), and only a masked preview is served outward
- an open route is marked explicitly and explained: it is a change to the
  authentication surface
