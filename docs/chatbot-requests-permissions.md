# Chatbot request permissions

Permissions for the in-system human intervention inbox (contract v1 §2.5,
`docs/proposals/human-intervention-backend-proposal.md`). The frontend
registers the same codes in `ability.ts`, the role screen and its tests.

## Permission table

New subjects use the existing actions only (`read`, `update`); `AppActions` is
not extended. `manage` is never registered or seeded on these subjects: in CASL
it is a wildcard, so only the super admin's `manage:all` implies them.

| Capability            | Code (`action:subject`)                          | What it enables                                                                                                                     |
| --------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| View                  | `read:ChatbotRequest`                            | Inbox, history, detail without the conversation, counters, read-only view of requests claimed by others                             |
| Attend                | `update:ChatbotRequest`                          | Claim, release own, resolve, reply, chat, send media, template, finish, reschedule. The backend also requires `read:ChatbotRequest` |
| Reassign              | `update:ChatbotRequestAssignment`                | Reassign or release someone else's requests, force "hand back to the bot"                                                           |
| Conversation history  | `read:ChatbotConversation`                       | Bot conversation, media and audio. Without it, a live agent sees only the messages of their own session                             |
| Escalations           | `read:ChatbotEscalation`                         | Receive "about to expire", "expired" and "unanswered for 15 min" notifications                                                      |
| Full phone            | `read:CustomerPhone`                             | See the unmasked phone number in every response and event                                                                           |
| Settings              | `read:ChatbotSettings`, `update:ChatbotSettings` | Read and edit business hours, closed days, timeouts and scheduling of the active tenant                                             |
| Apply to all branches | `update:ChatbotSettingsAllBranches`              | Copy the settings to every branch where the user holds this same permission                                                         |

The rows live in `src/auth/authorization/domain/permission.ts`.
`PermissionSeeder` upserts them on every API boot; it links no role to them.

## Default grants

Owner choice (task log L2), per tenant role:

| Role        | Grants                                                                     |
| ----------- | -------------------------------------------------------------------------- |
| Manager     | Every permission above except `update:ChatbotSettingsAllBranches` (8 rows) |
| Cashier     | `read:ChatbotRequest`, `update:ChatbotRequest`, `read:ChatbotConversation` |
| Super Admin | Covered by `manage:all`; the seed also links every row to the global role  |

Grants can be changed per role afterwards from the role screen.

A super admin needs a `TenantMembership` row in each tenant they work in:
inside a tenant, abilities come only from memberships, so without one the new
routes answer `403 Tenant membership required` (the seed creates these rows for
the seeded tenants; tenants created later get none).

- **Fresh databases:** `prisma/seed.ts` grants these lists to every tenant's
  `Manager` and `Cashier` roles.
- **Existing databases** (production): the roles already exist, so run the
  grant script below once.

`prisma/chatbot-requests-permissions.spec.ts` keeps the seed and the script on
the same lists.

## Granting on an existing database

`scripts/ops/grant-chatbot-request-permissions.cjs` adds the missing
`RolePermission` rows to each tenant's roles named `Manager` and `Cashier`.

- Dry run by default: reads only and prints the plan.
- `--apply` upserts the rows in one transaction. It is idempotent and never
  deletes or revokes anything.
- `--tenant <slug>` limits it to one tenant.
- A tenant without a `Manager` or `Cashier` role is reported and skipped; no
  role is created.
- It fails closed (`FAILED PERMISSION_MISSING`) if the API has not booted with
  this release yet, because the `Permission` rows come from `PermissionSeeder`.
- It prints the database target as `host:port/db`, never the credentials.

Production steps, after the release is deployed and the API has booted once:

```sh
# inside the API container, from the app root (/app)
node scripts/ops/grant-chatbot-request-permissions.cjs           # review the plan
node scripts/ops/grant-chatbot-request-permissions.cjs --apply   # write it
```

Output per tenant (illustrative):

```text
tenant centro
  Manager: would add read:ChatbotRequest
  Cashier: already has read:ChatbotRequest
Would add <n> role permission(s) across <m> tenant(s).
```

Running it again after `--apply` reports every row as `already has` and adds
nothing.

The pure planning part has offline tests:
`node --test scripts/ops/grant-chatbot-request-permissions.test.cjs`.

## Active user check

Staff routes use
`JwtAuthGuard → TenantContextGuard → ActiveUserGuard → PermissionsGuard`.
`ActiveUserGuard` (`src/auth/guards/active-user.guard.ts`) checks the current
`User.isActive` and the membership in the token's tenant on every request, so a
deactivated user or one removed from the tenant loses access before the 15-minute
access token expires:

| Situation                                                   | Response |
| ----------------------------------------------------------- | -------- |
| No authenticated user                                       | 401      |
| Token without a tenant                                      | 403      |
| User deleted or inactive                                    | 401      |
| No membership in the token's tenant (super admins included) | 403      |

`HumanDecisionActiveReviewerGuard` now extends it but keeps its original
contract (it checks `isActive` only), so the existing human-decision routes
behave as before.
