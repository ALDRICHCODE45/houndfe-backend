# Payment Methods (Catalog) Specification

## Purpose

Define the tenant-scoped **payment method catalog** for the POS surface
(`frontend-houndfe`): a configurable list of branded tender methods
(name + base category + optional subtitle) that tenants administer,
the read-only projection the POS uses to render a selector, the
optional `paymentMethodId` accepted on charge and add-payment
requests, and how the custom name reaches sale detail, the
`PAYMENT_RECEIVED` timeline, and the receipt PDF.

The catalog is a **new** bounded concept. `PaymentDetail` stores bank
transfer instructions (CLABE / account) and is not a tender-method
catalog; `SalePaymentMethod` (the canonical Prisma enum `CASH |
CARD_CREDIT | CARD_DEBIT | TRANSFER | CREDIT`) is unchanged. The
catalog persists its own enum (`CASH | CARD_CREDIT | CARD_DEBIT |
TRANSFER` — `CREDIT` is excluded by design) and writes the custom
name as a snapshot into `SalePayment.metadataJson.catalog`. The
catalog row is never a foreign key from `SalePayment`.

## Requirements

### Requirement: PaymentMethod Model

The system MUST persist a `PaymentMethod` row per tenant with the
following fields: `id` (uuid), `tenantId` (FK to `Tenant`, cascade
on delete), `name` (required string, unique per tenant),
`category` (enum `PaymentMethodCategory`, one of `CASH`,
`CARD_CREDIT`, `CARD_DEBIT`, `TRANSFER` — `CREDIT` MUST NOT be a
valid value), `subtitle` (optional string), `isActive` (boolean,
default `true`), `metadataJson` (optional, extensible JSON), and
`createdAt` / `updatedAt`. The Prisma table MUST be named
`payment_methods` and the model MUST declare
`@@unique([tenantId, name])` so the same display name cannot exist
twice inside a tenant. The system MUST index on `tenantId` so list
and active-record lookups stay tenant-scoped and cheap. The system
MUST NOT alter `SalePaymentMethod` or `SalePayment.method`; the
canonical enum column is unchanged.

#### Scenario: New PaymentMethod persists with default isActive

- GIVEN tenant T has no prior `PaymentMethod`
- WHEN the admin creates one with valid fields
- THEN a `PaymentMethod` row is created with `isActive=true`,
  `createdAt` set to now, and `tenantId=T`

#### Scenario: Duplicate name inside the same tenant is rejected

- GIVEN tenant T already has a `PaymentMethod` with `name="Mercado Pago"`
- WHEN an admin attempts to create another `PaymentMethod` in T with
  `name="Mercado Pago"` (any category)
- THEN the request is rejected with `409 DUPLICATE_NAME`
- AND no row is created

#### Scenario: Same name across different tenants is allowed

- GIVEN tenant T1 has a `PaymentMethod` with `name="Mercado Pago"`
- WHEN tenant T2 admin creates a `PaymentMethod` with
  `name="Mercado Pago"`
- THEN the request succeeds and a second row is created with
  `tenantId=T2`

#### Scenario: Deleting a tenant cascades PaymentMethod rows

- GIVEN tenant T has at least one `PaymentMethod`
- WHEN tenant T is deleted
- THEN all `PaymentMethod` rows where `tenantId=T` are removed via the
  onDelete cascade

#### Scenario: CREDIT is not a valid catalog category

- GIVEN any caller in any tenant
- WHEN the caller attempts to create or update a `PaymentMethod` with
  `category="credit"` (or `"CREDIT"`)
- THEN the request is rejected by validation
- AND the row is not created or modified

### Requirement: PaymentMethod Field Validation

The system MUST validate incoming `PaymentMethod` payloads before
persistence. `name` MUST be a non-empty string after trim with a
maximum length of 60 characters. `category` MUST be one of `cash`,
`card_credit`, `card_debit`, `transfer` (never `credit`).
`subtitle` MAY be omitted; when supplied it MUST be a string with a
maximum length of 120 characters after trim; when omitted it MUST
be stored as `NULL`. The system MUST trim `name` and `subtitle`
before persistence so stored values are not padded with whitespace.

#### Scenario: Empty name is rejected

- GIVEN a request with `name=""` or `name="   "`
- WHEN validation runs
- THEN the request is rejected with `400` and a field-level error
  identifying `name`
- AND no row is created or modified

#### Scenario: Name over the maximum length is rejected

- GIVEN a request with a `name` longer than 60 characters after trim
- WHEN validation runs
- THEN the request is rejected with `400 NAME_TOO_LONG`

#### Scenario: Invalid category is rejected

- GIVEN a request with `category="credit"`, `category="CRYPTO"`, or
  any value outside the four allowed base categories
- WHEN validation runs
- THEN the request is rejected with `400 INVALID_CATEGORY`

#### Scenario: Subtitle is optional and capped

- GIVEN a request with a `subtitle` of 121+ characters after trim
- WHEN validation runs
- THEN the request is rejected with `400 SUBTITLE_TOO_LONG`
- AND a request with no `subtitle` field is accepted (stored as `NULL`)

#### Scenario: Name is sanitized before persistence

- GIVEN a request with `name="   Mercado Pago   "`
- WHEN the row is persisted
- THEN the stored `name` is `"Mercado Pago"` (leading/trailing
  whitespace removed)

### Requirement: PaymentMethod Admin CRUD Endpoints

The system MUST expose admin CRUD endpoints under
`/admin/payment-methods`, each guarded by
`JwtAuthGuard + TenantContextGuard + PermissionsGuard` and scoped via
`@RequirePermissions(['<action>', 'PaymentMethod'])`. The endpoints
MUST be tenant-scoped via `TenantPrismaService` + CLS; cross-tenant
access MUST return `404` (not `403`). Delete MUST be logical (set
`isActive=false`) — never hard delete. Update MUST be able to flip
`isActive` from `false` back to `true` so a deactivated method can
be re-activated without recreating it. The list endpoint MUST return
rows ordered by `updatedAt DESC`. The exact table of routes is:

| Method | Path                              | Required permission      |
|--------|-----------------------------------|--------------------------|
| POST   | `/admin/payment-methods`          | `create:PaymentMethod`   |
| GET    | `/admin/payment-methods`          | `read:PaymentMethod`     |
| GET    | `/admin/payment-methods/:id`      | `read:PaymentMethod`     |
| PATCH  | `/admin/payment-methods/:id`      | `update:PaymentMethod`   |
| DELETE | `/admin/payment-methods/:id`      | `delete:PaymentMethod`   |

#### Scenario: Create returns the new record

- GIVEN an admin caller with `create:PaymentMethod`
- WHEN `POST /admin/payment-methods` is called with valid fields
- THEN the response is `201` with the created `PaymentMethod`
  including `id`, `tenantId`, `isActive=true`, and timestamps

#### Scenario: List returns all tenant records

- GIVEN tenant T has 3 active and 2 inactive `PaymentMethod` rows
- WHEN `GET /admin/payment-methods` is called from tenant T
- THEN the response includes all 5 rows, ordered by `updatedAt DESC`

#### Scenario: Get by id returns one record

- GIVEN a `PaymentMethod` PM1 belonging to tenant T
- WHEN `GET /admin/payment-methods/:PM1.id` is called from tenant T
- THEN the response is `200` with PM1's projection

#### Scenario: Update mutates only the supplied fields

- GIVEN a `PaymentMethod` with `subtitle="Link"`
- WHEN `PATCH /admin/payment-methods/:id` is called with
  `{ subtitle: "QR" }`
- THEN the response shows `subtitle="QR"` and other fields remain
  unchanged
- AND `updatedAt` is bumped to the request time

#### Scenario: Delete performs a logical delete

- GIVEN an active `PaymentMethod` PM1
- WHEN `DELETE /admin/payment-methods/:PM1.id` is called
- THEN the response is `204`
- AND the row's `isActive` becomes `false`
- AND the row remains in the database (auditable history)

#### Scenario: Re-activate a deactivated method

- GIVEN a `PaymentMethod` PM1 with `isActive=false`
- WHEN `PATCH /admin/payment-methods/:PM1.id` is called with
  `{ isActive: true }`
- THEN the response is `200` with `isActive=true`
- AND PM1 becomes selectable for new charges again

#### Scenario: Cross-tenant GET by id returns 404

- GIVEN `PaymentMethod` PM1 belongs to tenant T1
- WHEN a caller authenticated in tenant T2 calls
  `GET /admin/payment-methods/:PM1.id`
- THEN the response is `404` (no data leak)

#### Scenario: Cross-tenant UPDATE returns 404

- GIVEN `PaymentMethod` PM1 belongs to tenant T1
- WHEN a caller authenticated in tenant T2 calls
  `PATCH /admin/payment-methods/:PM1.id`
- THEN the response is `404`
- AND PM1's fields are unchanged

#### Scenario: Cross-tenant DELETE returns 404

- GIVEN `PaymentMethod` PM1 belongs to tenant T1
- WHEN a caller authenticated in tenant T2 calls
  `DELETE /admin/payment-methods/:PM1.id`
- THEN the response is `404`
- AND PM1's `isActive` is unchanged

### Requirement: PaymentMethod RBAC Permissions

The system MUST register four permissions for `PaymentMethod` in
`PERMISSION_REGISTRY`, all auto-seeded by `PermissionSeeder` on
`OnApplicationBootstrap`:

- `read:PaymentMethod` — `View payment methods`
- `create:PaymentMethod` — `Create payment methods`
- `update:PaymentMethod` — `Update payment methods`
- `delete:PaymentMethod` — `Delete (logical) payment methods`

The system MUST extend `AppSubjects` in
`src/auth/authorization/domain/permission.ts` with `'PaymentMethod'`.
The system MUST add `'PaymentMethod'` to `TENANT_SCOPED_MODELS` so
`TenantPrismaService` auto-injects `tenantId` on every read and
write. Any role granted one of these permissions MAY operate the
corresponding CRUD endpoint — there is no role-based restriction
beyond the CASL permission itself. Granting is performed via the
existing `PATCH /admin/roles/:id/permissions` endpoint like any
other permission.

#### Scenario: Permissions auto-seed at boot

- GIVEN the application starts with the new code deployed
- WHEN `PermissionSeeder.onApplicationBootstrap` runs
- THEN four new rows appear in the `Permission` table with
  `subject='PaymentMethod'` and `action` ∈
  `{read, create, update, delete}`

#### Scenario: Missing permission is rejected

- GIVEN a caller authenticated in tenant T with role R that has
  `create:PaymentMethod` but NOT `delete:PaymentMethod`
- WHEN the caller calls `DELETE /admin/payment-methods/:id`
- THEN the request is rejected by `PermissionsGuard`

#### Scenario: Permission is grantable to any role

- GIVEN role R1 with `read:PaymentMethod`
- WHEN `PATCH /admin/roles/:R1.id/permissions` is called with the
  matching `Permission.id`
- THEN R1's granted permissions include the new entry
- AND the role can read `PaymentMethod` immediately on the next
  request

### Requirement: Tenant Isolation of PaymentMethod Reads and Writes

All `PaymentMethod` reads and writes MUST be filtered by the
caller's tenant. The repository MUST use `TenantPrismaService` so
every Prisma operation automatically carries the active tenantId,
and MUST additionally pass explicit `where: { id, tenantId }` (and
`tenantId` on `create`) as defense in depth, mirroring the
`PaymentDetail` precedent. Cross-tenant access MUST always be `404`
— never `403` — so presence/absence is indistinguishable across
tenants.

#### Scenario: Admin list is tenant-scoped

- GIVEN tenants T1 and T2 each have 2 `PaymentMethod` rows
- WHEN a caller authenticated in T1 calls `GET /admin/payment-methods`
- THEN the response includes only the T1 rows (2 records)

#### Scenario: Tenant allowlist omission is prevented by spec

- GIVEN the new module is deployed
- WHEN the change verification runs
- THEN `'PaymentMethod'` is present in `TENANT_SCOPED_MODELS`
- AND repository reads/writes outside the allowlist pattern are not
  accepted in review

### Requirement: POS Read Projection of Active Catalog Methods

The system MUST expose a tenant-scoped read-only endpoint that
returns the caller's **active** (`isActive=true`)
`PaymentMethod` rows, projected as
`{ id, name, category, subtitle }` (with `subtitle` absent or
`null` when unset). The endpoint MUST require the same read
permission used by POS surfaces (read on `Sale` or equivalent,
mirroring `GET /sales/pos-catalog`). The endpoint MUST NOT return
rows from other tenants, MUST NOT return inactive rows, and MUST
NOT expose `metadataJson`. The endpoint MUST be safe to call
repeatedly and MUST NOT require a `paymentMethodId` parameter.

#### Scenario: Active methods are returned for the caller's tenant

- GIVEN tenant T has 2 active and 1 inactive `PaymentMethod` rows
- WHEN the POS caller calls the projection endpoint
- THEN the response is `200` with exactly the 2 active rows,
  each shaped as `{ id, name, category, subtitle? }`

#### Scenario: Tenant isolation holds

- GIVEN tenant T1 has 1 active `PaymentMethod`
- AND tenant T2 has 1 active `PaymentMethod`
- WHEN a caller in T1 calls the projection endpoint
- THEN only T1's row appears in the response

#### Scenario: Missing read permission is rejected

- GIVEN a caller authenticated in tenant T without the required read
  permission
- WHEN the caller calls the projection endpoint
- THEN the request is rejected by the permission guard
- AND no `PaymentMethod` reads occur

## Verification Surface

- `prisma/schema.prisma` — new `PaymentMethodCategory` enum (four
  values, no `CREDIT`), new `PaymentMethod` model, indices, FK to
  `Tenant`. `SalePaymentMethod` is unchanged.
- `prisma/migrations/<ts>_add_payment_methods/migration.sql` —
  additive; creates `payment_methods` only.
- `src/shared/tenant/tenant-scoped-models.constant.ts` —
  `'PaymentMethod'` entry present.
- `src/auth/authorization/domain/permission.ts` — `'PaymentMethod'`
  in `AppSubjects`; four entries in `PERMISSION_REGISTRY`.
- `src/auth/authorization/infrastructure/permission.seeder.ts` —
  re-run on boot, assert four new permission rows present.
- `src/admin/payment-methods/**` — entity, repository port, Prisma
  adapter, DTOs, controller, service, module; mirroring
  `admin/payment-details/` shape.
- `src/admin/admin.module.ts` — imports the new module.
- POS projection controller / service in `src/sales/**` — returns
  active catalog rows as `{ id, name, category, subtitle }`.
- Test files: co-located Jest unit specs for the new module, plus
  optional `*.integration.spec.ts` for the Prisma adapter.

## Notes for Implementation

- Exact POS projection route string (e.g. `GET /sales/payment-methods`
  vs `GET /admin/payment-methods?activeOnly`) is a design-time
  decision and is not constrained by this spec beyond the behavior
  (active, tenant-scoped, `read:Sale`-gated, shape
  `{ id, name, category, subtitle }`).
- The new module MAY import the `PAYMENT_METHOD_REPOSITORY` symbol
  into `SalesModule` so the sales service resolves
  `paymentMethodId → { category, name, subtitle }` without owning
  catalog persistence. A dedicated resolver use-case port is also
  acceptable. Either way the sales service MUST NOT bypass tenant
  scoping when resolving.