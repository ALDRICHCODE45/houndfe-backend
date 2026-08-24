# Payment Details Specification

## Purpose

Define the `PaymentDetail` bounded concept: the tenant-scoped record of bank
accounts (CLABE / account number) that customers use to pay transfer-based
bot sales, the admin CRUD that maintains those records, the granular RBAC
that gates the CRUD, and the read-only projection the chatbot service uses
to tell the customer where to transfer.

`PaymentDetail` is a greenfield concept. No pre-existing model carries
`bankName`, `beneficiary`, `clabe`, or `accountNumber`; `SalePayment.reference`
is free-text and structured bank data must live in its own entity.

## Requirements

### Requirement: PaymentDetail Model

The system MUST persist a `PaymentDetail` record per tenant with the
following fields: `id` (uuid), `tenantId` (FK to `Tenant`, cascade on
delete), `bankName`, `beneficiary`, `clabe` (exactly 18 digits),
`accountNumber` (≥ 10 digits), `isActive` (boolean, default `true`),
`createdAt`, `updatedAt`. The system MUST enforce
`@@unique([tenantId, clabe])` so a tenant cannot register the same CLABE
twice; the same CLABE MAY exist in two different tenants (different
branches of the same bank). The system MUST index on `tenantId` to keep
list / active-record lookups tenant-scoped and cheap. The Prisma table
MUST be named `payment_detail` and the model MUST belong to the
`Tenant` relation set so cascade delete propagates.

#### Scenario: New PaymentDetail persists with default isActive

- GIVEN a tenant T with no prior `PaymentDetail`
- WHEN `POST /admin/payment-details` succeeds with valid fields
- THEN a `PaymentDetail` row is created with `isActive=true`, `createdAt`
  set to now, and `tenantId=T`

#### Scenario: Duplicate CLABE inside the same tenant is rejected

- GIVEN tenant T already has a `PaymentDetail` with `clabe=012345678901234567`
- WHEN an admin attempts `POST /admin/payment-details` with the same CLABE
- THEN the request is rejected with `409 DUPLICATE_CLABE`
- AND no row is created

#### Scenario: Same CLABE across different tenants is allowed

- GIVEN tenant T1 has `PaymentDetail` with `clabe=012345678901234567`
- WHEN tenant T2 admin attempts `POST /admin/payment-details` with the
  same CLABE
- THEN the request succeeds and a second row is created with
  `tenantId=T2`

#### Scenario: Deleting a tenant cascades PaymentDetail rows

- GIVEN tenant T has at least one `PaymentDetail`
- WHEN tenant T is deleted
- THEN all `PaymentDetail` rows where `tenantId=T` are removed via the
  onDelete cascade

### Requirement: PaymentDetail Field Validation

The system MUST validate incoming `PaymentDetail` payloads before
persistence. `clabe` MUST be exactly 18 digits; `accountNumber` MUST be
≥ 10 digits; `bankName` and `beneficiary` MUST be non-empty strings after
trim. The system MUST sanitize (trim) string fields before persistence so
stored values are not padded with whitespace.

#### Scenario: Invalid CLABE is rejected at the DTO

- GIVEN a request with `clabe=01234567890123456` (17 digits)
- WHEN `POST /admin/payment-details` runs validation
- THEN the request is rejected with `400 INVALID_CLABE`
- AND no row is created or modified

#### Scenario: Non-digit CLABE is rejected

- GIVEN a request with `clabe=01234567890123456A`
- WHEN `POST /admin/payment-details` runs validation
- THEN the request is rejected with `400 INVALID_CLABE`

#### Scenario: Short accountNumber is rejected

- GIVEN a request with `accountNumber=123456789` (9 digits)
- WHEN `POST /admin/payment-details` runs validation
- THEN the request is rejected with `400 INVALID_ACCOUNT_NUMBER`

#### Scenario: Empty bankName or beneficiary is rejected

- GIVEN a request with `bankName=""` or `beneficiary="   "`
- WHEN `POST /admin/payment-details` runs validation
- THEN the request is rejected with `400` and a field-level error
  identifying the offending field

### Requirement: PaymentDetail Admin CRUD Endpoints

The system MUST expose admin CRUD endpoints under `/admin/payment-details`,
each guarded by `JwtAuthGuard + TenantContextGuard + PermissionsGuard`
and scoped via `@RequirePermissions(['<action>', 'PaymentDetail'])`. The
endpoints MUST be tenant-scoped via `TenantPrismaService` + CLS; cross-tenant
access MUST return `404` (not `403`). Delete MUST be logical (set
`isActive=false`) — never hard delete. The list endpoint MUST include
both active and inactive rows so admins can audit history.

| Method | Path                              | Required permission      |
|--------|-----------------------------------|--------------------------|
| POST   | `/admin/payment-details`          | `create:PaymentDetail`   |
| GET    | `/admin/payment-details`          | `read:PaymentDetail`     |
| GET    | `/admin/payment-details/:id`      | `read:PaymentDetail`     |
| PATCH  | `/admin/payment-details/:id`      | `update:PaymentDetail`   |
| DELETE | `/admin/payment-details/:id`      | `delete:PaymentDetail`   |

#### Scenario: Create returns the new record

- GIVEN an admin caller with `create:PaymentDetail`
- WHEN `POST /admin/payment-details` is called with valid fields
- THEN the response is `201` with the created `PaymentDetail`
  including `id`, `tenantId`, `isActive=true`, and timestamps

#### Scenario: List returns all tenant records

- GIVEN tenant T has 3 active and 2 inactive `PaymentDetail` rows
- WHEN `GET /admin/payment-details` is called from tenant T
- THEN the response includes all 5 rows, ordered by `updatedAt DESC`

#### Scenario: Update mutates only the supplied fields

- GIVEN a `PaymentDetail` with `beneficiary="Old Name"`
- WHEN `PATCH /admin/payment-details/:id` is called with
  `{ beneficiary: "New Name" }`
- THEN the response shows `beneficiary="New Name"` and other fields
  remain unchanged
- AND `updatedAt` is bumped to the request time

#### Scenario: Delete performs a logical delete

- GIVEN an active `PaymentDetail`
- WHEN `DELETE /admin/payment-details/:id` is called
- THEN the response is `204`
- AND the row's `isActive` becomes `false`
- AND the row remains in the database (auditable history)

#### Scenario: Cross-tenant GET by id returns 404

- GIVEN `PaymentDetail` PD1 belongs to tenant T1
- WHEN a caller authenticated in tenant T2 calls
  `GET /admin/payment-details/:PD1.id`
- THEN the response is `404` (no data leak)

#### Scenario: Cross-tenant DELETE returns 404

- GIVEN `PaymentDetail` PD1 belongs to tenant T1
- WHEN a caller authenticated in tenant T2 calls
  `DELETE /admin/payment-details/:PD1.id`
- THEN the response is `404`
- AND PD1's `isActive` is unchanged

### Requirement: PaymentDetail RBAC Permissions

The system MUST register four permissions for `PaymentDetail` in
`PERMISSION_REGISTRY`, all auto-seeded by `PermissionSeeder` on
`OnApplicationBootstrap`:

- `read:PaymentDetail` — `View payment details`
- `create:PaymentDetail` — `Create payment details`
- `update:PaymentDetail` — `Update payment details`
- `delete:PaymentDetail` — `Delete (logical) payment details`

The system MUST extend `AppSubjects` in
`src/auth/authorization/domain/permission.ts` with `'PaymentDetail'`.
Any role granted one of these permissions MAY operate the corresponding
CRUD endpoint — there is no role-based restriction beyond the CASL
permission itself. Granting is performed via the existing
`PATCH /admin/roles/:id/permissions` endpoint like any other permission.

#### Scenario: Permission auto-seeds at boot

- GIVEN the application starts with the new code deployed
- WHEN `PermissionSeeder.onApplicationBootstrap` runs
- THEN four new rows appear in the `Permission` table with
  `subject='PaymentDetail'` and `action` ∈
  `{read, create, update, delete}`

#### Scenario: Missing permission is rejected

- GIVEN a caller authenticated in tenant T with role R that has
  `create:PaymentDetail` but NOT `delete:PaymentDetail`
- WHEN the caller calls `DELETE /admin/payment-details/:id`
- THEN the request is rejected by `PermissionsGuard`

#### Scenario: Permission is grantable to any role

- GIVEN role R1 with `read:PaymentDetail`
- WHEN `PATCH /admin/roles/:R1.id/permissions` is called with the
  matching `Permission.id`
- THEN R1's granted permissions include the new entry
- AND the role can read `PaymentDetail` immediately on the next request

### Requirement: Bot Reads Active Tenant Payment Detail

The system MUST expose `GET /chatbot-api/payment-details` for the chatbot
service, requiring the new `payment-details:read` scope. The endpoint
MUST return the active (`isActive=true`) `PaymentDetail` of the
credential's tenant. When multiple active rows exist for the same tenant
(data inconsistency, see Risks), the endpoint MUST return the most
recently updated row (ordered by `updatedAt DESC`). The endpoint MUST
NOT require any business field other than the auth/scope context and MUST
return the projection `{ id, bankName, beneficiary, clabe, accountNumber,
isActive, updatedAt }`. The endpoint MUST be audit-logged via the
existing `BotAuditInterceptor`.

#### Scenario: Active account is returned

- GIVEN tenant T has one `PaymentDetail` with `isActive=true`
- WHEN the bot calls `GET /chatbot-api/payment-details` with
  `payment-details:read`
- THEN the response is `200` with that record's projection

#### Scenario: No active account returns 404

- GIVEN tenant T has zero `PaymentDetail` rows with `isActive=true`
- WHEN the bot calls `GET /chatbot-api/payment-details`
- THEN the response is `404 NO_ACTIVE_PAYMENT_DETAIL`
- AND no record is leaked

#### Scenario: Multiple active accounts returns the newest

- GIVEN tenant T has two `PaymentDetail` rows with `isActive=true`
  (PD-A `updatedAt=yesterday`, PD-B `updatedAt=now`)
- WHEN the bot calls `GET /chatbot-api/payment-details`
- THEN the response is `200` with PD-B

#### Scenario: Missing scope is rejected

- GIVEN a service credential without `payment-details:read` (only
  `catalog:read`, for example)
- WHEN the bot calls `GET /chatbot-api/payment-details`
- THEN the request is rejected by `RequiredScopes`
- AND no DB read occurs

### Requirement: Tenant Isolation of PaymentDetail Reads

All `PaymentDetail` reads (admin and bot) MUST be filtered by the
caller's tenant via `TenantPrismaService`. The bot endpoint MUST derive
the tenant from the service credential's tenant scope. The admin endpoint
MUST derive the tenant from the JWT auth context (same as the rest of
the admin module). Cross-tenant access MUST always be `404` — never `403`
— so presence/absence is indistinguishable across tenants.

#### Scenario: Admin list is tenant-scoped

- GIVEN tenants T1 and T2 each have 2 `PaymentDetail` rows
- WHEN a caller authenticated in T1 calls `GET /admin/payment-details`
- THEN the response includes only the T1 rows (2 records)

#### Scenario: Bot read is credential-scoped

- GIVEN service credential SC1 is scoped to tenant T1 only and
  service credential SC2 is scoped to tenant T2 only
- WHEN SC1 calls `GET /chatbot-api/payment-details`
- THEN T2's `PaymentDetail` rows are never reachable

## Verification Surface

- `prisma/schema.prisma` — `PaymentDetail` model, indices, FK to Tenant.
- `prisma/migrations/<ts>_add_payment_detail/` — forward + reverse
  migration.
- `src/auth/authorization/domain/permission.ts` — `AppSubjects`
  includes `'PaymentDetail'`; `PERMISSION_REGISTRY` has the four CRUD
  entries.
- `src/auth/authorization/infrastructure/permission.seeder.ts` —
  re-run on boot smoke test, assert 4 new rows present.
- `src/admin/payment-details/admin-payment-detail.controller.ts` —
  CRUD routes with `@RequirePermissions`.
- `src/admin/payment-details/admin-payment-detail.service.ts` —
  business logic + tenant scoping.
- `src/admin/payment-details/dto/` — `CreatePaymentDetailDto`,
  `UpdatePaymentDetailDto`, `PaymentDetailResponseDto`.
- `src/admin/payment-details/infrastructure/prisma-payment-detail.repository.ts` —
  symbol-injected repository.
- `src/admin/admin.module.ts` — module wiring for the new module.
- `src/chatbot-api/presentation/chatbot-api.controller.ts` — new
  `GET /chatbot-api/payment-details` route with `@RequiredScopes('payment-details:read')`.
- `src/chatbot-api/application/chatbot-api.service.ts` — new
  `getActivePaymentDetail` method.
- `openspec/program/whatsapp-ai-chatbot/PROGRAM-CONTEXT.md` —
  endpoint table updated to reflect the new bot read endpoint.
- Test files: `src/admin/payment-details/**/*.spec.ts`,
  `src/chatbot-api/application/chatbot-api.service.spec.ts`,
  `src/auth/authorization/infrastructure/permission.seeder.spec.ts`
  (assert the four new permissions exist after boot).
