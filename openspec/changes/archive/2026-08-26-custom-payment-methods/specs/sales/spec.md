# Delta for sales

## Purpose

This delta extends the sales domain with two new requirements for
the **custom payment methods** change: charge-side resolution and
snapshotting of a catalog row referenced by `paymentMethodId`, and
exposure of the custom name on sale detail, the `PAYMENT_RECEIVED`
timeline event, and the receipt PDF. The canonical `SalePaymentMethod`
enum and the existing charge/sale-detail contracts are unchanged
except where the new requirements add explicit optional fields or
behavior.

## ADDED Requirements

### Requirement: Charge Resolves a Custom Method and Snapshots the Catalog

The system MUST accept an optional `paymentMethodId` (uuid) on
`ChargeSaleDto` and on each `ChargePaymentEntryDto`. When the field
is present, the system MUST resolve the referenced `PaymentMethod`
scoped to the caller's tenant, MUST reject the request if the row
does not exist, does not belong to the tenant, or is inactive
(`isActive=false`), and MUST verify that if a base-category `method`
is also supplied on the same entry, it matches the row's
`category` exactly (case-insensitive). The persisted
`SalePayment.method` MUST be the resolved base category. The system
MUST write a catalog snapshot to `SalePayment.metadataJson` under
the dedicated key `catalog` with the shape
`{ paymentMethodId, name, subtitle? }` (subtitle omitted when null).
Requests without `paymentMethodId` MUST behave exactly as today —
no `catalog` key is written.

#### Scenario: Charge with valid active paymentMethodId persists snapshot

- GIVEN tenant T has an active `PaymentMethod` PM with
  `name="Mercado Pago"`, `category="transfer"`, `subtitle="Link"`,
  `isActive=true`
- WHEN a caller in T charges a draft sale with a payment entry
  `{ method: "transfer", amountCents: 1000, paymentMethodId: PM.id }`
- THEN a `SalePayment` row is created with `method="TRANSFER"`,
  `amountCents=1000`, and
  `metadataJson.catalog = { paymentMethodId: PM.id, name: "Mercado Pago", subtitle: "Link" }`

#### Scenario: Charge with mismatched method is rejected

- GIVEN tenant T has an active `PaymentMethod` PM with
  `category="transfer"`
- WHEN a caller in T charges with
  `{ method: "cash", amountCents: 1000, paymentMethodId: PM.id }`
- THEN the request is rejected with `400 PAYMENT_METHOD_CATEGORY_MISMATCH`
- AND no `SalePayment` is written

#### Scenario: Charge with inactive paymentMethodId is rejected

- GIVEN tenant T has a `PaymentMethod` PM with `isActive=false`
- WHEN a caller in T charges with
  `{ method: "transfer", amountCents: 1000, paymentMethodId: PM.id }`
- THEN the request is rejected with `409 INACTIVE_PAYMENT_METHOD`
- AND no `SalePayment` is written

#### Scenario: Charge with foreign-tenant paymentMethodId is rejected

- GIVEN `PaymentMethod` PM1 belongs to tenant T1
- WHEN a caller in tenant T2 charges with
  `paymentMethodId: PM1.id`
- THEN the request is rejected with `404 PAYMENT_METHOD_NOT_FOUND`
- AND no `SalePayment` is written

#### Scenario: Charge with unknown paymentMethodId is rejected

- GIVEN no `PaymentMethod` exists with the supplied id
- WHEN a caller charges with that `paymentMethodId`
- THEN the request is rejected with `404 PAYMENT_METHOD_NOT_FOUND`

#### Scenario: Charge without paymentMethodId behaves as today

- GIVEN any caller
- WHEN the caller charges with `{ method, amountCents }` and no
  `paymentMethodId`
- THEN the resulting `SalePayment` has no `catalog` key in
  `metadataJson` and behaves identically to the pre-change behavior

#### Scenario: Charge entry without paymentMethodId keeps legacy reference

- GIVEN a caller supplies
  `{ method: "cash", amountCents: 1000, reference: "TX-1" }`
- WHEN the charge is persisted
- THEN the resulting `SalePayment` has
  `metadataJson.reference = "TX-1"` (or the row's `reference`
  column populated, matching today's behavior) and no `catalog` key

### Requirement: Sale Detail and Timeline Expose the Custom Method Name

The system MUST extend `SaleDetailPaymentDto` with optional fields
`paymentMethodId`, `paymentMethodName`, and
`paymentMethodSubtitle`, populated from the snapshot at
`metadataJson.catalog` when present. The system MUST surface these
fields on the `PAYMENT_RECEIVED` timeline event in
`build-sale-timeline.ts`. The system MUST render the custom name
(and `subtitle` when present) on the receipt PDF template
`pdf-generation/templates/shared/payments-list.tsx`, preferring
the snapshot over the base-category label map. When the snapshot
is absent (legacy rows, base-category-only charges), the existing
base-category label MUST remain the fallback.

#### Scenario: Custom name appears on sale detail

- GIVEN a `SalePayment` with
  `metadataJson.catalog = { paymentMethodId, name: "Mercado Pago", subtitle: "Link" }`
- WHEN a caller reads `GET /sales/:id` (sale detail)
- THEN the corresponding entry in `payments[]` includes
  `paymentMethodId`, `paymentMethodName = "Mercado Pago"`, and
  `paymentMethodSubtitle = "Link"`
- AND `method` remains `"TRANSFER"` (the base category)

#### Scenario: Custom name appears on the PAYMENT_RECEIVED timeline

- GIVEN the same `SalePayment` as above
- WHEN the sale timeline is built
- THEN the `PAYMENT_RECEIVED` event exposes the custom name (and
  subtitle when present) to clients
- AND the base-category label is still resolvable as a fallback

#### Scenario: Custom name appears on the receipt PDF

- GIVEN a sale with a custom-method `SalePayment`
- WHEN the receipt PDF is rendered
- THEN the payments list displays the custom name (and subtitle
  when present) instead of the base-category label

#### Scenario: Legacy rows fall back to base-category label

- GIVEN a `SalePayment` without a `catalog` key in `metadataJson`
- WHEN the sale detail, timeline, or receipt is rendered
- THEN the base-category label is used
- AND `paymentMethodId / paymentMethodName / paymentMethodSubtitle`
  are absent or `null` on the wire

## Verification Surface

- `src/sales/sales.service.ts` — `ChargePaymentEntry` carries
  `paymentMethodId?`; `normalizeChargeRequestPayments` copies the
  field; `toCanonicalChargePayments` resolves and snapshots.
- `src/sales/domain/sale.repository.ts` — `PersistedChargePayment`
  gains optional `metadataJson`.
- `src/sales/infrastructure/prisma-sale.repository.ts` —
  `persistChargeConfirmation` writes `metadataJson`;
  `findOneWithRelations` mapper surfaces catalog fields from
  `metadataJson.catalog`.
- `src/sales/dto/charge-sale.dto.ts` — optional
  `@IsUUID() paymentMethodId` on `ChargePaymentEntryDto`.
- `src/sales/dto/sale-detail-response.dto.ts` — optional
  `paymentMethodId / paymentMethodName / paymentMethodSubtitle`.
- `src/sales/domain/build-sale-timeline.ts` — `PAYMENT_RECEIVED`
  event carries the custom name.
- `pdf-generation/templates/shared/payments-list.tsx` — prefers
  `metadataJson.catalog.name` (+ `subtitle`) over base-category
  label.
- Test files: co-located Jest unit specs for the sales-service
  charge threading and the sale-detail / timeline / receipt
  exposure.