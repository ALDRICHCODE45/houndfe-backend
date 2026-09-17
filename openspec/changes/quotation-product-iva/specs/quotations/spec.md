# Delta for Quotations — Product IVA

Domain inferred from proposal `Affected areas` (no explicit `Capabilities` section was present): the change is rooted in the `quotations` bounded context. The conditional PDF aggregate is documented here as a quotation-level requirement because the proposal scopes the canonical spec update to `openspec/specs/quotations/spec.md`. The `pdf-generation` canonical spec is untouched.

Pre-decisions locked from the parent brief: prices are IVA-inclusive; `chargeProductTaxes=false` is distinct from `IVA_0` and `IVA_EXENTO`; variants inherit parent-product tax behavior; API breakdown includes only represented classifications; PDF shows aggregate IVA only; incomplete tax snapshots produce an empty API breakdown and an omitted PDF IVA row; the legacy tax-rate endpoint is deprecated but remains temporarily callable and MUST NOT influence new IVA calculations. IEPS, CFDI, and sales-tax math are out of scope.

## ADDED Requirements

### Requirement: Line Tax Snapshot at Line Creation

**Status**: ADDED
**Priority**: P0

The system MUST capture the parent product's tax classification `(ivaRate, chargeProductTaxes)` on every `QuotationItem` at line creation, persisted as the columns `(ivaRateClassification, chargeProductTaxesSnapshot)` together with a recomputable `taxableBaseCents`. The snapshot MUST be read from the **current** parent product at the moment `addItem` runs. A product whose `chargeProductTaxes=false` MUST snapshot `chargeProductTaxesSnapshot=false` regardless of its `ivaRate`. Variant lines MUST inherit the parent product's snapshot — no variant-level tax field is introduced in this slice.

#### Scenario: addItem captures the parent product's tax snapshot

- **GIVEN** a DRAFT quotation and product P1 with `ivaRate=IVA_16`, `chargeProductTaxes=true`
- **WHEN** `POST /quotations/drafts/:id/items` adds P1
- **THEN** the persisted `QuotationItem` carries `ivaRateClassification=IVA_16` and `chargeProductTaxesSnapshot=true`
- **AND** `taxableBaseCents` equals the IVA-exclusive base derived from the line's post-discount inclusive amount at the snapshotted rate

#### Scenario: addItem snapshots chargeProductTaxes=false regardless of ivaRate

- **GIVEN** product P2 with `ivaRate=IVA_16`, `chargeProductTaxes=false`
- **WHEN** `POST /quotations/drafts/:id/items` adds P2
- **THEN** the persisted `QuotationItem` carries `chargeProductTaxesSnapshot=false`
- **AND** the line's IVA amount is 0

#### Scenario: Variant line inherits the parent product's snapshot

- **GIVEN** product P3 (parent) with `ivaRate=IVA_8`, `chargeProductTaxes=true`, and variant V1
- **WHEN** `POST /quotations/drafts/:id/items` adds P3 with `variantId=V1`
- **THEN** the persisted `QuotationItem` carries `ivaRateClassification=IVA_8` and `chargeProductTaxesSnapshot=true` read from P3 (NOT from V1)

#### Scenario: addItem on non-DRAFT is rejected (existing guard unchanged)

- **GIVEN** a quotation with status `SENT`
- **WHEN** `POST /quotations/drafts/:id/items` is called
- **THEN** the request is rejected with 409 and no snapshot row is created

---

### Requirement: Line Tax Snapshot at Reprice

**Status**: ADDED
**Priority**: P0

The system MUST re-snapshot `(ivaRateClassification, chargeProductTaxesSnapshot)` and re-derive `taxableBaseCents` when `recomputePricingAndPromotions` re-resolves a non-custom price-list line during DRAFT. SENT or EXPIRED quotations MUST NOT re-snapshot existing lines on any recompute path. No data migration MAY backfill historic rows.

#### Scenario: DRAFT recompute re-snapshots from the current parent product

- **GIVEN** a DRAFT quotation with a price-list line L referencing product P4 (`ivaRate=IVA_16`, `chargeProductTaxes=true`)
- **WHEN** `recomputePricingAndPromotions` runs after a price-list change
- **THEN** L.ivaRateClassification and L.chargeProductTaxesSnapshot reflect P4's **current** tax fields
- **AND** L.taxableBaseCents is re-derived from the new unit price

#### Scenario: SENT line snapshots are not re-resolved on read or recompute

- **GIVEN** a SENT quotation whose lines carry snapshots from product P5 at send time
- **AND** an admin later edits P5 to `ivaRate=IVA_8`, `chargeProductTaxes=false`
- **WHEN** any read or recompute path runs against this quotation
- **THEN** the line snapshots remain at P5's send-time values
- **AND** the API response and PDF use the stored snapshots, NOT P5's current values

---

### Requirement: IVA Breakdown Response Shape

**Status**: ADDED
**Priority**: P0

The system MUST expose `ivaBreakdown: { classification, amountCents }[]` on `GET /quotations/:id` and every other quotation read path. The array MUST contain **only** the classifications actually represented by snapshot-complete lines on the quotation. Zero-amount buckets (`IVA_0`, `IVA_EXENTO`, `NOT_TAXABLE`) MUST appear in the array **only when at least one snapshot-complete line carries that classification**. The array MUST NOT always return all five buckets. `ivaBreakdown[]` MUST be `[]` whenever any quotation line lacks a complete tax snapshot — never a fabricated aggregate zero, never a partial breakdown. The classification field MUST use a closed enum union validated with `class-validator`.

#### Scenario: Mixed classifications produce only the represented buckets

- **GIVEN** a quotation with three snapshot-complete lines (P-IVA16, P-IVA8, P-IVA0)
- **WHEN** `GET /quotations/:id` is called
- **THEN** `ivaBreakdown` contains exactly three entries: `IVA_16`, `IVA_8`, and `IVA_0`
- **AND** `IVA_EXENTO` and `NOT_TAXABLE` are absent (no line carries those classifications)

#### Scenario: Single-classification quotation returns one bucket

- **GIVEN** a quotation whose snapshot-complete lines all carry `IVA_16`
- **WHEN** `GET /quotations/:id` is called
- **THEN** `ivaBreakdown` contains exactly one entry: `{ classification: 'IVA_16', amountCents: <sum> }`

#### Scenario: Zero-amount bucket appears only when represented

- **GIVEN** a quotation with one `IVA_0` line and two `IVA_16` lines, all snapshot-complete
- **WHEN** `GET /quotations/:id` is called
- **THEN** `ivaBreakdown` contains two entries: `IVA_16` and `IVA_0` (with `IVA_0.amountCents = 0`)
- **AND** `IVA_EXENTO` and `NOT_TAXABLE` are absent

#### Scenario: Null snapshot on any line forces empty breakdown

- **GIVEN** a quotation where at least one line has any of `taxableBaseCents`, `ivaRateClassification`, or `chargeProductTaxesSnapshot` null
- **WHEN** `GET /quotations/:id` is called
- **THEN** `ivaBreakdown` is `[]`

#### Scenario: Aggregate equals grandTotal minus Σ taxableBaseCents

- **GIVEN** a quotation whose lines are all snapshot-complete
- **WHEN** `GET /quotations/:id` is called
- **THEN** `Σ ivaBreakdown.amountCents` equals `totalCents − Σ taxableBaseCents` (after discounts)

---

### Requirement: Three Distinct Zero-Tax Classifications

**Status**: ADDED
**Priority**: P0

The system MUST keep `IVA_0`, `IVA_EXENTO`, and `chargeProductTaxes=false` (rendered as `NOT_TAXABLE`) as separate classifications whenever each is represented by at least one snapshot-complete line. The API response MUST expose them as separate buckets; no implementation logic MAY collapse them, and no bucket MAY be fabricated for an absent classification.

#### Scenario: IVA_0 and IVA_EXENTO stay distinct when both represented

- **GIVEN** a quotation with one `IVA_0` line and one `IVA_EXENTO` line, both snapshot-complete
- **WHEN** `GET /quotations/:id` is called
- **THEN** `ivaBreakdown` contains both `IVA_0` and `IVA_EXENTO` as separate entries (each with `amountCents = 0`)

#### Scenario: chargeProductTaxes=false produces a NOT_TAXABLE bucket

- **GIVEN** a quotation with one line from a product with `chargeProductTaxes=false` (regardless of its `ivaRate`)
- **WHEN** `GET /quotations/:id` is called
- **THEN** `ivaBreakdown` contains a `NOT_TAXABLE` entry with `amountCents = 0`
- **AND** `NOT_TAXABLE` is distinct from `IVA_0` and `IVA_EXENTO`

#### Scenario: NOT_TAXABLE line does not contribute to any IVA_xx bucket

- **GIVEN** product P with `ivaRate=IVA_16`, `chargeProductTaxes=false`
- **WHEN** the line is added and `GET /quotations/:id` is called
- **THEN** the line contributes `0` to IVA aggregation
- **AND** the line is grouped under the `NOT_TAXABLE` bucket, NOT the `IVA_16` bucket

---

### Requirement: Discount Handling Preserves Inclusive Totals

**Status**: ADDED
**Priority**: P0

The system MUST compute classification against the post-discount line base so that line and grand totals remain IVA-inclusive and unchanged after recompute. Promotion discounts MUST reduce `taxableBaseCents` before classification; the line's inclusive unit price and `lineTotalCents` MUST stay equal to the previous inclusive values for the same quantity. The legacy root `taxRate` column MUST NOT participate in `lineTotalCents`, `subtotalCents`, `discountCents`, or the grand `totalCents`.

#### Scenario: Promotion discount reduces taxable base, line total unchanged

- **GIVEN** a DRAFT line with unit price 1000c (IVA-inclusive), 10% AUTOMATIC promotion, snapshot `IVA_16`
- **WHEN** recompute runs
- **THEN** `taxableBaseCents` is computed against the post-discount inclusive base divided by `(1 + rate)`
- **AND** `lineTotalCents` remains equal to the inclusive line total after discount (no double application of IVA)

#### Scenario: Σ breakdown equals grandTotal − Σ taxableBase after discounts

- **GIVEN** a quotation whose lines are all snapshot-complete and post-discount
- **WHEN** `GET /quotations/:id` is called
- **THEN** `Σ ivaBreakdown.amountCents` equals `totalCents − Σ taxableBaseCents`

#### Scenario: Legacy root taxRate column does not influence totals

- **GIVEN** a quotation whose root `taxRate` differs from every line's snapshotted rate
- **WHEN** `GET /quotations/:id` is called
- **THEN** `lineTotalCents`, `subtotalCents`, `discountCents`, and the grand `totalCents` are derived from the line snapshots and product pricing, NOT from the root `taxRate`

---

### Requirement: Conditional PDF Aggregate IVA Line

**Status**: ADDED
**Priority**: P0

The PDF rendering of a quotation MUST show **exactly one** IVA line labeled without classification or rate percentage **only when every line on the quotation is snapshot-complete and `Σ ivaBreakdown.amountCents` is computable**. The line MUST display the aggregate included-IVA amount (sum of all breakdown buckets). The PDF MUST NOT show a classification label, a per-rate breakdown, a rate percentage, or per-line tax amounts. If any line lacks a complete snapshot, the PDF MUST omit the IVA row entirely — never a fabricated aggregate zero, never a partial breakdown. The existing subtotal / discount / total layout MUST remain unchanged.

#### Scenario: All lines snapshot-complete → one aggregate IVA line rendered

- **GIVEN** a quotation with snapshot-complete lines whose breakdown sum is 16000c
- **WHEN** the `quotation-a4` PDF is rendered
- **THEN** the PDF contains exactly one IVA line showing `160.00` (or the configured currency formatting)
- **AND** the PDF does NOT contain a classification label, a rate percentage, or per-line tax amounts

#### Scenario: Any line missing snapshot → IVA row omitted entirely

- **GIVEN** a quotation where at least one line has a null snapshot field
- **WHEN** the `quotation-a4` PDF is rendered
- **THEN** the PDF does NOT contain any IVA row (no fabricated zero, no partial breakdown)

#### Scenario: Zero-IVA aggregate renders zero, still shows the row

- **GIVEN** a quotation whose snapshot-complete lines all carry zero-tax classifications (`IVA_0` / `IVA_EXENTO` / `NOT_TAXABLE`)
- **WHEN** the `quotation-a4` PDF is rendered
- **THEN** the PDF contains exactly one IVA line showing `0.00`
- **AND** the existing subtotal/discount/total layout is unchanged

#### Scenario: SENT PDF uses stored snapshots, not live product data

- **GIVEN** a SENT quotation with snapshot-complete lines
- **AND** an admin has since edited the referenced products' tax fields
- **WHEN** the `quotation-a4` PDF is rendered
- **THEN** the PDF aggregate uses the stored snapshot values, NOT the products' current values

---

### Requirement: Deprecated Tax-Rate Endpoint

**Status**: ADDED
**Priority**: P1

The system MUST keep the route, controller handler, and `SetQuotationTaxRateDto` for `PATCH /quotations/drafts/:id/tax-rate` in place. The endpoint MUST remain callable temporarily. Its payload MUST persist the legacy root `Quotation.taxRate` column on the row. The handler MUST NOT influence the new product-derived IVA calculation, the `ivaBreakdown[]` response, or the PDF aggregate. The response MUST emit a deprecation signal (response header) so any active caller can detect the upcoming removal. The endpoint MUST continue to call `ensureDraft()` and remain DRAFT-only. Removal of the route and DTO is a follow-up change.

#### Scenario: PATCH remains callable and persists root taxRate

- **GIVEN** a DRAFT quotation with current root `taxRate=0.16`
- **WHEN** `PATCH /quotations/drafts/:id/tax-rate` with `{ taxRate: 0.08 }`
- **THEN** the response is 200 and `Quotation.taxRate` is persisted as `0.08` on the row

#### Scenario: PATCH does not affect ivaBreakdown or PDF aggregate

- **GIVEN** a DRAFT quotation with snapshot-complete lines and a non-zero `ivaBreakdown` aggregate
- **WHEN** `PATCH /quotations/drafts/:id/tax-rate` is called with any value
- **THEN** `ivaBreakdown` returned on the next `GET /quotations/:id` is unchanged
- **AND** the PDF aggregate on the next render is unchanged

#### Scenario: Response carries a deprecation signal

- **GIVEN** a DRAFT quotation
- **WHEN** `PATCH /quotations/drafts/:id/tax-rate` is called
- **THEN** the response includes a deprecation signal in a response header (e.g., `Deprecation` or a project-equivalent header)

#### Scenario: PATCH on non-DRAFT is rejected

- **GIVEN** a quotation with status `SENT` or `EXPIRED`
- **WHEN** `PATCH /quotations/drafts/:id/tax-rate` is called
- **THEN** the request is rejected with 409 and no column write occurs

---

### Requirement: Null Snapshot Legacy Semantics

**Status**: ADDED
**Priority**: P0

The system MUST treat any `QuotationItem` whose `taxableBaseCents`, `ivaRateClassification`, or `chargeProductTaxesSnapshot` is null as **not snapshot-complete**. No code path MAY backfill historic SENT or EXPIRED rows. When at least one line on a quotation is not snapshot-complete (whether pre-migration or otherwise), the API MUST return `ivaBreakdown: []` and the PDF MUST omit the IVA row entirely — never a fabricated aggregate zero, never a partial breakdown.

#### Scenario: Pre-migration SENT quotation surfaces empty breakdown and omitted PDF row

- **GIVEN** a SENT quotation whose `QuotationItem` rows predate the migration (all snapshot fields null)
- **WHEN** `GET /quotations/:id` is called and the PDF is rendered
- **THEN** `ivaBreakdown` is `[]`
- **AND** the PDF omits the IVA row entirely

#### Scenario: No backfill runs for historic rows

- **GIVEN** a SENT or EXPIRED quotation with null snapshots
- **WHEN** any migration, recompute, or background job runs
- **THEN** the snapshot fields remain null
- **AND** no historical tax information is fabricated

#### Scenario: A single null line forces empty breakdown on the whole quotation

- **GIVEN** a DRAFT quotation with N snapshot-complete lines and exactly one line whose `ivaRateClassification` is null
- **WHEN** `GET /quotations/:id` is called
- **THEN** `ivaBreakdown` is `[]` (one null line disables the entire breakdown)

#### Scenario: Quotation becomes eligible after a DRAFT mutation completes every snapshot

- **GIVEN** a DRAFT quotation that previously had a null-snapshot line
- **WHEN** that line is replaced or repaired so every line is snapshot-complete
- **THEN** the next `GET /quotations/:id` returns the populated `ivaBreakdown` and the PDF renders the aggregate IVA line

---

## MODIFIED Requirements

None. The canonical `quotations` spec carries no existing requirement that references tax behavior; all tax-related rules are net-new. Snapshot and recompute behaviors are documented as ADDED requirements rather than modifications of `Add Item to Quotation` or `Promotion Recompute on Every Draft Mutation` because they add behavior without changing those requirements' existing semantics.

## REMOVED Requirements

None. The canonical `quotations` spec did not enumerate `taxCents`, `taxRate` on the response, or the `PATCH .../tax-rate` endpoint, so there is no requirement to remove. Removal of the response field and the eventual removal of the deprecated endpoint are tracked in the proposal's Compatibility / deprecation impact section.

## Notes on out-of-scope surfaces

- IEPS (including `Product.iepsRate`), CFDI emission, and `SalePayment` / sale-side tax math are explicitly out of scope; no requirement here constrains them.
- Variant-level tax fields are not added in this slice; variants inherit parent behavior at snapshot time only.
- The root `Quotation.taxRate` column is retained but unused by the domain; dropping it is a follow-up change.
