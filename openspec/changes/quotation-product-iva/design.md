# Design — Product-derived IVA snapshots for quotations

## Decision summary

Quotation IVA will be a write-time line snapshot, not a live product lookup and not a root-level override. Each `QuotationItem` persists the parent product's IVA classification pair plus its post-discount IVA-exclusive base. The quotation aggregate derives a represented-only breakdown from those persisted values. Prices and grand totals remain IVA-inclusive and unchanged.

The compatibility boundary is intentional:

- `Quotation.taxRate` and `PATCH /quotations/drafts/:id/tax-rate` remain temporarily.
- The deprecated endpoint still validates, remains DRAFT-only, and persists the legacy column.
- The legacy column is excluded from totals, `ivaBreakdown`, and PDF rendering.
- `taxRate` and `taxCents` are removed from quotation responses.
- Historic lines are not backfilled. Any incomplete line disables the entire breakdown and PDF IVA row.

This design covers all eight added requirements and their 29 scenarios without adding IEPS, CFDI, sale-side tax changes, frontend work, historic backfill, or variant-level overrides.

## Architecture

The existing quotation aggregate remains the source of truth. Responsibilities are divided as follows:

| Layer                         | Responsibility                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Product application service   | Resolve current parent-product `ivaRate` and `chargeProductTaxes`; variants contribute identity and price only.                    |
| Quotation item entity         | Own the nullable persisted snapshot, compute the post-discount taxable base with integer arithmetic, and classify a complete line. |
| Quotation aggregate           | Reject non-DRAFT mutations, aggregate complete lines into represented-only IVA buckets, and project the response.                  |
| Quotation application service | Orchestrate snapshot creation, DRAFT repricing/resnapshotting, final post-promotion base derivation, and persistence.              |
| Prisma repository             | Round-trip all three nullable snapshot columns and continue round-tripping legacy root `taxRate`.                                  |
| Controller/DTO boundary       | Keep the legacy PATCH route with a deprecation header and expose a closed, validated breakdown contract.                           |
| PDF service/template          | Convert a non-empty complete breakdown into one nullable aggregate amount and render exactly one conditional row.                  |

No read path resolves product tax data. `findOne`, `findAll`, PDF preview, and SENT/EXPIRED rendering operate only on repository-loaded snapshots.

## Domain and persistence model

### Persisted shape

Add these nullable fields to `QuotationItem`:

```prisma
model QuotationItem {
  // existing fields
  taxableBaseCents           Int?
  ivaRateClassification      IvaRate?
  chargeProductTaxesSnapshot Boolean?
}
```

The migration is additive only:

- PostgreSQL columns are nullable and have no defaults.
- Existing rows remain `NULL`; there is no data update or background backfill.
- No new enum value is added to Prisma `IvaRate`.
- No index is added because the fields are read with the existing `quotationId` item lookup and are not query filters.
- `Quotation.taxRate Float @default(0.16)` remains unchanged.

The snapshot is complete only when all three fields are non-null. In particular, `chargeProductTaxesSnapshot=false` still requires a non-null `ivaRateClassification`; the pair preserves what the parent product said while the boolean determines the effective `NOT_TAXABLE` bucket.

### Domain types

Introduce a quotation-owned runtime string enum, separate from Prisma types:

```ts
enum QuotationIvaClassification {
  IVA_16 = 'IVA_16',
  IVA_8 = 'IVA_8',
  IVA_0 = 'IVA_0',
  IVA_EXENTO = 'IVA_EXENTO',
  NOT_TAXABLE = 'NOT_TAXABLE',
}

type QuotationIvaRateClassification =
  'IVA_16' | 'IVA_8' | 'IVA_0' | 'IVA_EXENTO';
```

`NOT_TAXABLE` is a response classification only. It is never stored in the Prisma `IvaRate` column.

`QuotationItemProps`, `QuotationItem.create`, and `QuotationItem.fromPersistence` accept the three snapshot fields. Defaults are `null` only to permit historic rows. New quotation lines must be created by the application service with non-null product metadata.

`QuotationItem` exposes focused methods/getters:

- `snapshotTaxClassification(rate, chargeProductTaxes)` stores the current parent-product pair.
- `recomputeTaxableBase()` derives and stores the base from the line's final post-discount inclusive total.
- `hasCompleteTaxSnapshot` checks all three fields explicitly with `!== null`.
- `effectiveIvaClassification` returns `NOT_TAXABLE` when the boolean is false; otherwise it returns the stored rate classification.
- `includedIvaCents` returns `lineTotalCents - taxableBaseCents` for a complete line and `null` otherwise.

The snapshot fields remain internal persistence/domain data; they are not added to each line's public response in this slice. The public tax contract is the root `ivaBreakdown`.

### Repository mapping

`PrismaQuotationRepository.save()` includes all three fields in each `quotationItem.createMany` row. `toDomain()` maps Prisma `IvaRate | null` to the domain rate union and preserves nulls exactly.

The repository continues to map root `taxRate` in both create/update and load directions. All aggregate copy constructors (`send`, `cancel`, and any future status-copy path) must also carry the current legacy `_taxRate`; otherwise a status transition could silently reset a previously persisted compatibility value to `0.16`.

The existing tenant-scoped root lookup and item relation remain unchanged. Snapshot columns do not create a new repository or cross-tenant query path.

## Integer and rounding policy

All IVA calculations use non-negative integer cents. There is no floating-point multiplier and no independently rounded tax formula.

For each line, first compute the final inclusive line amount after promotions:

```text
inclusiveLineCents = unitPriceCents × quantity
```

`unitPriceCents` is already the post-discount per-unit value in the current aggregate. Then derive the exclusive base once per line:

```text
ratePercent = IVA_16 → 16, IVA_8 → 8, IVA_0/IVA_EXENTO → 0

effectiveRatePercent = chargeProductTaxesSnapshot ? ratePercent : 0
divisor = 100 + effectiveRatePercent

taxableBaseCents = floor((inclusiveLineCents × 100 + floor(divisor / 2)) / divisor)
includedIvaCents = inclusiveLineCents - taxableBaseCents
```

This is round-half-up division for non-negative cents. It is equivalent to rounding `inclusiveLineCents / (1 + rate)` but avoids decimal rate arithmetic. Multiplying a PostgreSQL `Int`-range amount by 100 remains within JavaScript's safe integer range; entity methods continue to reject non-integer or negative monetary inputs.

Examples:

| Inclusive line | Snapshot                   |    Base | Included IVA |
| -------------: | -------------------------- | ------: | -----------: |
|        11,600c | IVA_16, charged            | 10,000c |       1,600c |
|        10,800c | IVA_8, charged             | 10,000c |         800c |
|           900c | IVA_16, charged            |    776c |         124c |
|           900c | IVA_0 or IVA_EXENTO        |    900c |           0c |
|           900c | `chargeProductTaxes=false` |    900c |           0c |

The line-level base is rounded once after quantity and promotions are final. Buckets use exact integer addition only. IVA is always derived as the remainder, so for every complete quotation:

```text
Σ includedIvaCents
= Σ lineTotalCents - Σ taxableBaseCents
= totalCents - Σ taxableBaseCents
```

No IVA value is added to `unitPriceCents`, `lineTotalCents`, `subtotalCents`, `discountCents`, or `totalCents`.

## Snapshot and repricing flow

### Add item

`ProductsService.getProductInfoForSale(productId, variantId)` is widened with required fields:

```ts
{
  // existing product, variant, price, image fields
  ivaRate: 'IVA_16' | 'IVA_8' | 'IVA_0' | 'IVA_EXENTO';
  chargeProductTaxes: boolean;
}
```

Both the variant and non-variant branches source those fields from the already-loaded parent `product`. The variant row is never queried for tax metadata.

`QuotationsService.addItem` keeps its status check before the product lookup, then passes the metadata into `Quotation.addItem`. A newly created line therefore has a classification snapshot before it enters recompute. If an add stacks quantity onto an existing line, the existing line identity remains; a PRICE_LIST line is re-snapshotted by the repricing flow, while a CUSTOM line retains its prior classification snapshot and only has its base re-derived.

The service persists only after the full recompute succeeds, so no pre-promotion taxable base is committed.

### DRAFT recompute

`recomputePricingAndPromotions` remains private and DRAFT mutation callers remain unchanged. Its expanded order is:

1. Remove prior promotion-sourced discounts.
2. Resolve prices for non-sticky (`PRICE_LIST`) lines.
3. For each line that actually receives a resolved price, read current product metadata through `getProductInfoForSale` and update the classification pair.
4. Evaluate promotions with `context: 'QUOTATION'`.
5. Apply per-line promotion results.
6. Prune invalid manual promotion opt-ins as today.
7. Recompute `taxableBaseCents` for every line that has a non-null classification pair, using the final post-discount line amount.

Product metadata calls in step 3 are deduplicated within one recompute by `(productId, variantId)` and executed before mutating the corresponding snapshots. `addItem` seeds that request-local cache with its initial `getProductInfoForSale` result, avoiding a duplicate lookup for the newly added line.

A PRICE_LIST line is re-snapshotted only when repricing produced a price. A CUSTOM line remains sticky: its unit price and tax classification are not re-resolved, but quantity/promotion changes still re-derive its taxable base from the stored pair. This preserves the confirmed distinction between “DRAFT reprice” and a general live-tax refresh.

A legacy DRAFT can become complete when all of its PRICE_LIST lines successfully pass through this flow, or when remaining incomplete/custom lines are replaced. Failure to complete every line continues to produce the safe empty-breakdown behavior.

### SENT, EXPIRED, and CANCELLED behavior

All public mutation methods retain the existing DRAFT checks. The deprecated root-tax endpoint also remains DRAFT-only.

`Quotation.send()` copies the existing `QuotationItem` instances and their snapshots into the SENT aggregate; it does not call recompute or a product service. Reads and PDF rendering do not call product services. An admin product edit therefore cannot alter a SENT/EXPIRED breakdown.

Sending an incomplete legacy DRAFT is not newly blocked: it can still become SENT, but its response has `ivaBreakdown: []` and its PDF omits IVA. This avoids fabricating fiscal data or widening the send contract.

## Breakdown aggregation and response contract

`Quotation.computeIvaBreakdown()` follows an all-or-nothing rule:

1. If there are no items, return `[]`.
2. If any item is missing any snapshot field, return `[]`.
3. Otherwise visit every line once, map `chargeProductTaxesSnapshot=false` to `NOT_TAXABLE`, and add `includedIvaCents` to that represented bucket.
4. Return only represented buckets in deterministic order: `IVA_16`, `IVA_8`, `IVA_0`, `IVA_EXENTO`, `NOT_TAXABLE`.

The map is created on first representation, not pre-seeded. This preserves zero-valued entries for represented `IVA_0`, `IVA_EXENTO`, and `NOT_TAXABLE` lines without fabricating absent buckets.

`Quotation.toResponse()`:

- adds `ivaBreakdown` from `computeIvaBreakdown()`;
- removes root `taxRate`;
- removes root `taxCents`;
- leaves existing inclusive totals and item projections unchanged.

Every service read path already goes through `Quotation.toResponse()` or the service's enriched wrapper, so detail, list, mutation responses, send rendering, and PDF preview receive the same breakdown.

### DTO validation

Convert `QuotationResponseDto` from an interface to a structurally equivalent class and add a nested DTO:

```ts
class QuotationIvaBreakdownEntryDto {
  @IsEnum(QuotationIvaClassification)
  classification: QuotationIvaClassification;

  @IsInt()
  @Min(0)
  amountCents: number;
}

class QuotationResponseDto {
  // existing fields

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuotationIvaBreakdownEntryDto)
  ivaBreakdown: QuotationIvaBreakdownEntryDto[];
}
```

The enum is closed over exactly five public values. A focused DTO spec uses `plainToInstance` plus `validate` to prove nested invalid classifications, fractional amounts, negative amounts, and non-array values are rejected. Nest's global `whitelist`, `forbidNonWhitelisted`, and transform settings remain unchanged; request DTO behavior is not widened.

## Legacy tax-rate deprecation

The compatibility write path is retained but isolated:

- Rename the domain mutation to an explicit compatibility name such as `setDeprecatedTaxRate(rate)` while retaining the same `0..1` invariant and `ensureDraft()` guard.
- Keep `QuotationsService.setTaxRate` as the endpoint-facing adapter. It loads the tenant-scoped quotation, rejects non-DRAFT status, updates only `_taxRate`, saves, and returns the normal response.
- Keep `SetQuotationTaxRateDto` and its existing `@IsNumber`, `@Min(0)`, and `@Max(1)` validation.
- Keep the Prisma root-column mapping in both directions.
- Do not invoke recompute, mutate any line snapshot, or expose the root value in `toResponse()`.

The controller method receives a static standard header:

```ts
@Header('Deprecation', 'true')
@Patch('drafts/:id/tax-rate')
```

No `Sunset` header is emitted because no removal date is confirmed. Controller tests pin `Deprecation: true`, successful persistence, and the existing 409 behavior. A before/after assertion proves PATCH changes neither the next GET breakdown nor the PDF aggregate.

## Conditional PDF rendering

Extend `QuotationDocumentProps.totals` with:

```ts
includedIvaCents: number | null;
```

`PdfGenerationService.buildQuotationProps()` maps it as follows:

```text
if items.length > 0 and ivaBreakdown.length > 0:
  includedIvaCents = Σ ivaBreakdown.amountCents
else:
  includedIvaCents = null
```

For a complete non-empty quotation, at least one represented bucket exists even when every amount is zero. Therefore `0` means “complete, render $0.00,” while `null` means “unknown or empty, omit the row.” The PDF service never reads products and never reconstructs line tax.

`QuotationA4Document` adds one conditional totals row before the existing divider/total card:

```text
IVA incluido    $<aggregate>
```

The condition is `includedIvaCents !== null`, not a truthiness check. The template receives no classifications or rates, so it cannot render a per-rate, percentage, or per-line disclosure. Existing Subtotal, Descuentos, and TOTAL rows retain their calculations and layout.

## File-level change map

| File                                                                          | Designed change                                                                                                                             |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `prisma/schema.prisma`                                                        | Add the three nullable `QuotationItem` snapshot columns; retain root `taxRate`.                                                             |
| `prisma/migrations/<timestamp>_add_quotation_item_tax_snapshot/migration.sql` | Add nullable columns only; no defaults, indexes, enum changes, or data updates.                                                             |
| `src/products/products.service.ts`                                            | Return parent `ivaRate` and `chargeProductTaxes` from both branches of `getProductInfoForSale`.                                             |
| `src/quotations/domain/quotation-tax.types.ts`                                | Define domain/API classification enum, rate union, order, and integer rate mapping.                                                         |
| `src/quotations/domain/quotation-item.entity.ts`                              | Store/map snapshots; derive base and included IVA; preserve nullable legacy rows.                                                           |
| `src/quotations/domain/quotation.entity.ts`                                   | Aggregate represented buckets; remove response `taxRate`/`taxCents`; retain compatibility root state and preserve it through status copies. |
| `src/quotations/application/quotations.service.ts`                            | Snapshot on add, re-snapshot resolved PRICE_LIST lines, derive all bases after promotions, and keep isolated legacy persistence.            |
| `src/quotations/infrastructure/prisma-quotation.repository.ts`                | Round-trip the new item columns and unchanged root `taxRate`.                                                                               |
| `src/quotations/dto/quotation-response.dto.ts`                                | Add validated nested breakdown DTO and remove legacy response fields.                                                                       |
| `src/quotations/controllers/quotations.controller.ts`                         | Emit `Deprecation: true` while retaining route, guards, DTO, and service call.                                                              |
| `src/pdf-generation/pdf-generation.service.ts`                                | Map a complete breakdown to nullable aggregate IVA props.                                                                                   |
| `src/pdf-generation/templates/quotation/quotation-a4.document.tsx`            | Conditionally render one `IVA incluido` row.                                                                                                |
| Co-located specs                                                              | Cover domain math, orchestration, mapping, deprecation, DTO validation, and PDF behavior.                                                   |

## Verification strategy and scenario traceability

### Domain tests

`quotation-item.entity.spec.ts` pins:

- IVA_16, IVA_8, IVA_0, IVA_EXENTO, and `chargeProductTaxes=false` base/amount math;
- line-level half-up rounding and the 1000c with 10% discount fixture;
- all three completeness fields, including `false` as a valid non-null boolean;
- base re-derivation after quantity, price, and promotion changes;
- CUSTOM classification retention with base re-derivation.

`quotation.entity.spec.ts` pins:

- represented-only deterministic buckets;
- separate zero buckets and NOT_TAXABLE precedence over a stored IVA rate;
- single-class aggregation and mixed-rate addition;
- one null field on one line returning `[]` for the whole quotation;
- empty quotation returning `[]`;
- `Σ breakdown = totalCents - Σ taxableBaseCents`;
- unchanged inclusive totals and omission of response `taxRate`/`taxCents`;
- snapshot and legacy-root preservation across `send` and `cancel`.

### Application and product tests

`products.service` specs assert both product and variant calls return tax metadata from the parent product.

`quotations.service.spec.ts` covers:

- addItem snapshots all three fields;
- variant inheritance;
- non-DRAFT add rejection before persistence;
- successful PRICE_LIST reprice refreshes classification and base;
- product metadata changes are reflected only during DRAFT repricing;
- CUSTOM lines are not reclassified but receive a new base after final discount;
- SENT/EXPIRED reads perform no product lookup;
- incomplete historic rows remain incomplete unless a DRAFT write explicitly completes them;
- deprecated PATCH persists only root `taxRate` and leaves breakdown/PDF input unchanged.

### Repository, controller, DTO, and PDF tests

`prisma-quotation.repository.integration.spec.ts` round-trips complete snapshots, all three zero-tax meanings, and all-null historic rows. It also queries the root row directly after deprecated PATCH to prove `taxRate` remains persisted despite being absent from the response.

`quotations.controller.spec.ts` pins the exact deprecation header and DRAFT-only 409 behavior without changing authorization or tenant guards. The DTO spec validates the closed enum and integer non-negative amount contract.

`pdf-generation.service.spec.ts` inspects rendered props for non-zero aggregate, zero aggregate, and `null` on incomplete/empty breakdowns. `quotation-a4.document.spec.tsx` pins exactly one `IVA incluido` row, no percentage/classification labels, zero rendering, omission on `null`, and unchanged existing totals rows.

The requirement/scenario coverage is:

| Requirement                                  | Scenarios | Primary seams                                     |
| -------------------------------------------- | --------: | ------------------------------------------------- |
| Line Tax Snapshot at Line Creation           |         4 | product service, application service, item entity |
| Line Tax Snapshot at Reprice                 |         2 | recompute orchestration, SENT read tests          |
| IVA Breakdown Response Shape                 |         5 | quotation aggregate, response DTO                 |
| Three Distinct Zero-Tax Classifications      |         3 | item classification, aggregate buckets            |
| Discount Handling Preserves Inclusive Totals |         3 | integer math, promotion recompute                 |
| Conditional PDF Aggregate IVA Line           |         4 | PDF prop mapper and template                      |
| Deprecated Tax-Rate Endpoint                 |         4 | controller, service, repository                   |
| Null Snapshot Legacy Semantics               |         4 | repository load, aggregate, PDF mapper            |
| **Total**                                    |    **29** |                                                   |

Final implementation verification is `pnpm test` followed by `pnpm build`. No sale, CFDI, IEPS, frontend, or backfill suite should require behavior changes.

## Rollout and rollback

1. Apply the additive nullable-column migration. It is safe for the currently deployed code because old code ignores the columns.
2. Deploy generated Prisma client and application code together.
3. Smoke-test one DRAFT line for each represented zero-tax meaning, one mixed taxable quote, one historic SENT quote, deprecated PATCH, and both complete/incomplete PDFs.
4. Monitor deprecated endpoint traffic through the existing HTTP observability path; the response header gives callers a migration signal without selecting a removal date.

Code rollback can occur while leaving the nullable columns in place. The prior code ignores them and continues using root `taxRate`. A later schema rollback may drop only the three additive columns; no restoration or reverse backfill is needed.

## Risks and mitigations

| Risk                                                    | Mitigation                                                                                                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rounding drifts from the aggregate invariant            | Derive one rounded base per final line and define IVA as the exact remainder; never round a second tax expression.                                                             |
| A zero aggregate is confused with unavailable data      | PDF uses `includedIvaCents: number \| null`: `0` is available and renders `$0.00`; `null` is unavailable and omits the IVA row.                                                |
| Historic data is partially presented                    | Any null snapshot field disables the entire breakdown and PDF row.                                                                                                             |
| Product edits alter sent documents                      | Product metadata is read only in DRAFT add/reprice; all reads use stored snapshots.                                                                                            |
| Variant tax behavior diverges                           | Both product-info branches return tax fields from the parent `product`; no variant tax field exists.                                                                           |
| Legacy PATCH becomes a hidden tax input                 | Rename the domain compatibility mutation, exclude root tax from response/recompute/PDF, and test before/after breakdown equality.                                              |
| Recompute adds repeated catalog reads                   | Deduplicate `getProductInfoForSale` by product/variant within one recompute and seed the cache from addItem.                                                                   |
| Repository status transitions reset compatibility state | Pass `_taxRate` through every aggregate copy and integration-test its round trip.                                                                                              |
| API consumers still expect `taxRate`/`taxCents`         | Treat removal as the confirmed response-contract break while retaining the write endpoint and emitting `Deprecation: true`.                                                    |
| Implementation exceeds the 400-line review budget       | The proposal forecasts 600–900 lines; under `ask-on-risk`, the parent must pause for a delivery decision before implementation rather than infer chaining or `size:exception`. |

## Explicit exclusions

This design does not add or modify IEPS, CFDI, sale/payment tax calculations, refund/reporting behavior, frontend code, historic row backfills, stored PDF blobs, variant tax fields, controller authorization, tenant scoping, or removal of the deprecated endpoint/DTO/root column.
