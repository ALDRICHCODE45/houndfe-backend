# Delta for sale-payments

## Purpose

This delta extends the sale-payments domain with four new
requirements for the **custom payment methods** change: add-payment
side resolution and snapshotting of a catalog row referenced by
`paymentMethodId`, idempotency-hash inclusion of `paymentMethodId`
to prevent silent collisions between two custom methods sharing a
base category, snapshot semantics for historical `SalePayment` rows
(never rewritten on rename/deactivation), and base-category refund
semantics for custom-method payments. The canonical
`SalePaymentMethod` enum and the existing add-payment / refund
contracts are unchanged except where the new requirements add
explicit behavior.

## ADDED Requirements

### Requirement: Add-Sale-Payment Resolves a Custom Method and Snapshots the Catalog

The system MUST accept an optional `paymentMethodId` (uuid) on
`AddSalePaymentDto` and on each `AddSalePaymentEntryDto`. The
resolution, validation, mismatch check, inactive rejection,
cross-tenant rejection, and snapshot semantics MUST be identical to
the charge flow (see Requirement: Charge Resolves a Custom Method
and Snapshots the Catalog). Requests without `paymentMethodId` MUST
behave exactly as today, including the existing bot reviewer path
which continues to stamp `metadataJson.origin`.

#### Scenario: Add payment with valid active paymentMethodId persists snapshot

- GIVEN a CONFIRMED sale S in tenant T
- AND tenant T has an active `PaymentMethod` PM with
  `category="cash"`, `name="Cash USD"`
- WHEN a caller in T calls `POST /sales/:S.id/payments` with
  `{ method: "cash", amountCents: 500, paymentMethodId: PM.id }`
- THEN a `SalePayment` row is created with `method="CASH"`,
  `amountCents=500`, and
  `metadataJson.catalog = { paymentMethodId: PM.id, name: "Cash USD" }`

#### Scenario: Add payment with inactive paymentMethodId is rejected

- GIVEN tenant T has a `PaymentMethod` PM with `isActive=false`
- WHEN a caller in T adds a payment referencing PM.id
- THEN the request is rejected with `409 INACTIVE_PAYMENT_METHOD`
- AND no `SalePayment` is written

#### Scenario: Bot reviewer path is unaffected

- GIVEN a bot-created sale is being confirmed by a human reviewer
- WHEN the reviewer confirms the receipt (existing path, hard-codes
  `method="transfer"` and stamps `metadataJson.origin`)
- THEN the resulting `SalePayment` has `method="TRANSFER"` and
  `metadataJson.origin = { kind: "bot", channel: <sale.channel> }`
- AND no `catalog` key is written by this path

### Requirement: Idempotency Hashes Include paymentMethodId

The system MUST include `paymentMethodId` in the charge idempotency
hash AND in the add-sale-payment idempotency hash when the field is
present on the entry. Identical payloads (same category, same
amount, same `paymentMethodId`) MUST produce the same hash and
replay safely. The same category + same amount + DIFFERENT
`paymentMethodId` MUST produce a different hash so two custom
methods sharing a base category do not collide. Requests without
`paymentMethodId` MUST hash exactly as today.

#### Scenario: Identical custom-method payload replays once

- GIVEN a charge request with
  `{ method: "transfer", amountCents: 1000, paymentMethodId: PM.id }`
  has already succeeded
- WHEN the same caller submits the same payload again with the same
  idempotency context
- THEN the original result is returned
- AND no duplicate `SalePayment` is created

#### Scenario: Same category, different paymentMethodId do not collide

- GIVEN two active custom methods PM-A and PM-B, both with
  `category="transfer"`
- WHEN a caller submits two distinct charge requests:
  `{ method: "transfer", amountCents: 1000, paymentMethodId: PM-A.id }`
  and
  `{ method: "transfer", amountCents: 1000, paymentMethodId: PM-B.id }`
- THEN the two requests produce different idempotency hashes
- AND both succeed and create distinct `SalePayment` rows
- AND the snapshot for each row carries its own `name` /
  `paymentMethodId`

#### Scenario: Legacy payloads keep their existing hash

- GIVEN a caller submits a charge with `{ method: "cash", amountCents: 1000 }`
  and no `paymentMethodId`
- WHEN the idempotency hash is computed
- THEN the hash is identical to the pre-change implementation
- AND the request replays idempotently against any prior identical
  legacy submission

### Requirement: Snapshot Semantics for Historical SalePayments

The system MUST snapshot the catalog `name` (and `subtitle` when
present) into `SalePayment.metadataJson.catalog` at the time of
charge or add-payment. The system MUST NOT rewrite historical
`SalePayment` rows when a `PaymentMethod` is later renamed,
deactivated, or logically deleted. The catalog `paymentMethodId`
recorded in the snapshot is an opaque reference (no live FK, no
backfill), so historical receipts continue to show the name the
customer saw at sale time.

#### Scenario: Renaming a catalog row does not rewrite history

- GIVEN a `SalePayment` SP1 was charged with
  `paymentMethodId: PM1.id` and snapshot `name="Mercado Pago"`
- WHEN an admin updates PM1 to `name="Mercado Pago v2"`
- THEN SP1's `metadataJson.catalog.name` remains `"Mercado Pago"`
- AND SP1's `metadataJson.catalog.paymentMethodId` remains
  `PM1.id` (opaque reference)

#### Scenario: Deactivating a catalog row does not rewrite history

- GIVEN SP1 exists with the snapshot above
- WHEN an admin deactivates PM1 (`isActive=false`)
- THEN SP1's snapshot is unchanged
- AND no new charges may reference PM1

### Requirement: Refunds on Custom-Method Payments Stay Base-Category

The system MUST keep `SaleRefund.method` a base `SalePaymentMethod`
enum value (`CASH | CARD_CREDIT | CARD_DEBIT | TRANSFER |
CREDIT`). `cancelSale` and the existing
`normalizeRefundMethod` MUST continue to operate on the persisted
base category of the original `SalePayment`, with no catalog
awareness required. The system MUST NOT introduce a `CUSTOM` enum
value on `SalePaymentMethod` or `SaleRefund.method`.

#### Scenario: Refund of a custom-method payment succeeds

- GIVEN a `SalePayment` SP1 with `method="TRANSFER"` and
  `metadataJson.catalog.name="Mercado Pago"`
- WHEN the sale is canceled
- THEN a `SaleRefund` row is created with `method="TRANSFER"`
- AND the total refunded matches the original payment amount

## Verification Surface

- `src/sales/sales.service.ts` — `CollectionPaymentEntry` carries
  `paymentMethodId?`; `normalizeCollectionRequestPayments` copies
  the field; `sortPaymentsForHash` includes it (covers both charge
  and add-payment idempotency hashes).
- `src/sales/dto/add-sale-payment.dto.ts` — optional
  `@IsUUID() paymentMethodId` on `AddSalePaymentEntryDto`.
- `extractLegacyReference` (in the sales service) MUST continue to
  read only `metadataJson.reference`; the new `catalog` key MUST
  NOT collide with that or with `metadataJson.origin`.
- Test files: co-located Jest unit specs for the idempotency-hash
  updates (identical replay, different `paymentMethodId` no
  collision, legacy payload unchanged).