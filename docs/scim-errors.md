# SCIM failure codes

For the administrator of an identity provider (Okta, Entra ID, Keycloak and
others) who is setting up directory synchronization with Tessera.

Every synchronization failure arrives in the response body per RFC 7644:

```json
{
  "schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"],
  "status": "409",
  "scimType": "uniqueness",
  "detail": "[scim.user_external_id_taken] externalId \"a1b2\" ..."
}
```

At the start of `detail`, in square brackets, stands the **reason code**. It is
permanent: it does not depend on the language of the instance and it does not
change when the wording changes. The text after the code names the field and the
value the synchronization stumbled on. `scimType` is set by the protocol and
tells the provider whether to retry the request; the code tells a person what
exactly happened.

Parse the code, never the wording: the words after the code are currently
emitted in Russian by the application, and they are not part of the contract.

Codes are not reused: a reason that is removed does not hand its code to
another.

| Code | HTTP | `scimType` | What happened | What to do |
|---|---|---|---|---|
| `scim.workspace_missing` | 401 | — | The instance is not set up yet: there is no workspace. | Finish the initial setup of Tessera. |
| `scim.token_invalid` | 401 | — | The SCIM token was not found, was revoked or has expired. | Issue a new token in the Tessera settings and replace it at the provider. |
| `scim.schema_not_found` | 404 | — | A schema was requested that Tessera does not describe. | Check the address: the User and Group schemas of RFC 7643 are supported. |
| `scim.filter_unsupported` | 400 | `invalidValue` | The list filter is not supported. | Only the form `attribute eq "value"` is supported. |
| `scim.filter_attribute_unsupported` | 400 | `invalidValue` | A filter by an attribute Tessera does not search by. | For people: `userName`, `externalId`, `emails`; for groups: `displayName`, `externalId`. |
| `scim.user_not_found` | 404 | — | There is no person with that identifier in this workspace. | The provider refers to a deleted record: recreate the link at the provider. |
| `scim.user_name_missing` | 400 | `invalidValue` | Neither `userName` nor an email address is present. | Fill in `userName` or `emails` in the attribute mapping. |
| `scim.user_external_id_taken` | 409 | `uniqueness` | The `externalId` already belongs to another record. | Find the two records with one identifier at the provider. |
| `scim.user_email_bound_to_other_external_id` | 409 | `uniqueness` | The email address already belongs to a record linked to a different `externalId`. | These are two different people with one address, or a reconnected record: work out at the provider which of the two is right. |
| `scim.user_email_taken` | 409 | `uniqueness` | A change of the address to one taken by another record. | Free the address on the second record or correct it at the provider. |
| `scim.user_last_owner` | 400 | `mutability` | Deactivating or changing the role would leave the workspace with no owner. | Appoint another owner in Tessera first. |
| `scim.group_not_found` | 404 | — | There is no group with that identifier. | The provider refers to a deleted group: recreate the link at the provider. |
| `scim.group_name_missing` | 400 | `invalidValue` | An empty `displayName`. | Fill in the group name at the provider. |
| `scim.group_name_taken` | 409 | `uniqueness` | A group with that `displayName` already exists. | Rename one of the groups. |
| `scim.group_external_id_taken` | 409 | `uniqueness` | The `externalId` already belongs to another group. | Find the two groups with one identifier at the provider. |
| `scim.group_default_not_deletable` | 400 | `invalidValue` | An attempt to delete the default group. | Tessera needs the default group and it is not synchronized by deletion; exclude it from the synchronization scope. |

The list is compared against the code by the test
`apps/api/tests/test_scim_errors.py`: a code that exists in the application and
is not described here, and a code described here that does not occur in the
application, fail the test equally.
