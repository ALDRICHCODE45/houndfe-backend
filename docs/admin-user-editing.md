# Edit account email and tenant roles atomically

`PATCH /admin/users/:id` updates an existing account profile and, optionally,
its complete role set in the selected tenant. Email identifies the global account;
roles remain tenant-local. Existing name-only clients remain compatible.

## Request and response

```json
{
  "name": "Updated name",
  "email": "person@example.com",
  "roleIds": ["11111111-1111-4111-8111-111111111111"]
}
```

| Field | Contract |
| --- | --- |
| `name` | Required nonempty string; stored trimmed. |
| `email` | Optional string, trimmed and lowercased before email validation and global uniqueness checking. |
| `roleIds` | Optional, nonempty array of unique UUIDs; replaces the entire local role set in the selected tenant. |

Omitted fields remain unchanged. Explicit `null`, malformed fields, empty or
duplicate role sets, and extra DTO fields return 400. Do not coerce numbers or
objects into strings. Success retains the profile response:
`{id,email,name,isActive,createdAt}`. Password and refresh-token fields are never
returned. To read roles, use `GET /admin/users/:id`, whose response is `{user,roles}`.

## Authorization and tenant scope

- Every update requires `update:User`. Any supplied `roleIds`, even an unchanged
  set, additionally requires `update:TenantMembership` and a selected tenant.
- `read:Role` remains separately required to read the role catalog. This endpoint
  does not widen catalog access.
- The target must belong to the selected tenant, including when the actor is a
  superadmin. A global superadmin without a selected tenant may edit profiles,
  but cannot submit roles.
- Non-superadmins cannot edit a globally privileged target. The exact login
  predicate is a role with `tenantId:null` and either system role name
  `Super Admin` or a `manage:all` permission; a matching name alone is not enough.
- All requested roles must belong exactly to the selected tenant. Unknown,
  foreign or global roles are rejected. Existing global/foreign-role memberships
  in that tenant block role replacement rather than being silently removed.
  Profile-only edits do not mutate these memberships.

Authorization uses the ability attached by PermissionsGuard before mutation, not
an ability reconstructed from requested roles. Self-demotion may succeed using
that snapshot. Effective grants are the union of all memberships matching exactly
`{userId,tenantId}`; effective output is deduplicated and sorted. DeliveryRoute
ownership and manager rules are applied after this union.

## Atomicity and errors

The transaction first locks the target user using the same PostgreSQL TEXT-key
row lock as OTP, then validates target scope, roles and email uniqueness. Only
selected profile fields are written. Matching membership IDs and every other
tenant's memberships are preserved; only removed local roles are deleted and
new local roles inserted. Password, activity and refresh fields are not replaced
from a stale entity.

| Result | Meaning |
| --- | --- |
| 400 | Invalid DTO or unsupported tenant role set. |
| 401 | Unauthenticated request, or a non-superadmin without tenant context (rejected by the guard). |
| 403 | Missing mutation permission, forbidden role-edit context, or protected target. |
| 404 | Target missing or outside the selected tenant. |
| 409 | Global email collision or racing database uniqueness conflict. |

Validation failures and persistence errors do not partially update profile,
memberships or OTP. Uniqueness races are translated only after transaction rollback.

## Sessions and OTP boundary

An actual stored-email change marks PENDING/ACTIVE OTP challenges FAILED under
the same user lock. Challenge history and rate budgets remain intact. Delayed
successful delivery cannot reactivate the challenge; reverting the email through
this managed endpoint cannot revive it. An unchanged email does not invalidate OTP.
See the [OTP guide](auth-email-otp.md) for the distinction from raw email changes
and current-email MAC binding.

Existing final sessions and refresh remain valid; this is not immediate session
revocation. Subsequent permission-guarded requests reload database permissions.
Concurrent actor revocation is not serialized against the request's ability
snapshot. There is no new last-admin safeguard, permission-subset hierarchy,
email ownership proof, account recovery flow or create-user policy change.

## Verification limits

Unit tests cover DTOs, trusted snapshot forwarding, authorization, tenant scope,
role union, response secrecy, selective persistence, OTP invalidation and simulated
transaction rollback. A deferred-delivery regression uses the real OTP repository
completion method with mocked persistence. These tests do not prove PostgreSQL
lock scheduling, live email delivery or deployment readiness. Push, deployment
and live acceptance remain owner-controlled; no schema or OTP production changes
are required by this endpoint.
