# Tasks — `quotation-product-iva`

Implementation work units derived from `proposal.md`, `specs/quotations/spec.md` (8 ADDED requirements / 29 scenarios), and `design.md`. Backend-only; DRAFT + SENT immutability. No apply, migration run, commit, push, PR, archive, or review/RDD state is created by this artifact.

## Review Workload Forecast

| Field                   | Value                                                                                                                                                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Estimated changed lines | 600–900 (schema + migration ~30, domain entities + tax types ~180, repository mapping ~40, product service widening ~30, quotation service snapshot/recompute ~150, DTO ~60, controller deprecation ~15, PDF service + template ~60, co-located tests ~300–450)                  |
| 400-line budget risk    | High                                                                                                                                                                                                                                                                             |
| Chained PRs recommended | Yes                                                                                                                                                                                                                                                                              |
| Suggested split         | PR 1 (WU1: schema + migration + domain tax types/entities + repository round-trip) → PR 2 (WU2: product service widening + quotation service snapshot/reprice + response shape + DTO validation) → PR 3 (WU3: conditional PDF aggregate + deprecation signal + controller tests) |
| Delivery strategy       | ask-on-risk (resolved: chained PRs)                                                                                                                                                                                                                                              |
| Chain strategy          | stacked-to-main                                                                                                                                                                                                                                                                  |

```text
Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High
```

The user resolved the `ask-on-risk` gate by selecting chained PRs with the `stacked-to-main` strategy. No `size:exception` is authorized. PR 1 (WU1) targets `main`; PR 2 (WU2) is built on PR 1 and must be retargeted/rebased to `main` after PR 1 merges; PR 3 (WU3) follows the same pattern after PR 2. Each work unit remains autonomous with a clear start state, finished state, verification plan, and clean-revertable rollback boundary. This planning session intentionally stops before implementation.

---

## WU1 — Persistence & domain snapshot core (PR 1 candidate)

Start: `main` without the three snapshot columns. Finish: schema/migration/domain math/repository round-trip compile and pass; no behavior change on existing endpoints yet. Rollback: revert WU1 commits; nullable columns may remain (old code ignores them). Verification: focused `pnpm test src/quotations/domain` + `src/quotations/infrastructure`.

### T1.1 — RED: domain specs for snapshot invariants and rounding

- [x] Extend `src/quotations/domain/quotation-item.entity.spec.ts` (RED first): pin base/amount math for IVA_16, IVA_8, IVA_0, IVA_EXENTO, and `chargeProductTaxes=false`; half-up rounding (11600c→10000c, 900c@IVA_16→776c/124c); completeness requires all three fields non-null with `false` as a valid non-null boolean; base re-derivation after quantity/price/promotion change; CUSTOM classification retention. Extend `src/quotations/domain/quotation.entity.spec.ts`: represented-only deterministic buckets (`IVA_16`, `IVA_8`, `IVA_0`, `IVA_EXENTO`, `NOT_TAXABLE`), separate zero buckets, `NOT_TAXABLE` precedence over stored IVA rate, one null field → `[]`, empty quotation → `[]`, `Σ breakdown = totalCents − Σ taxableBaseCents`, unchanged inclusive totals, WU1 correction: legacy wire retention (`taxRate`/`taxCents` present, no `ivaBreakdown` property) with `computeIvaBreakdown()` pinned as an internal capability, snapshot + legacy `_taxRate` preservation across `send`/`cancel`. Run and confirm failure. <!-- sdd-owner: implementation -->

Acceptance: both specs fail with missing API/behavior errors; no production code changed yet.
Dependencies: none.

### T1.2 — GREEN: domain tax types and entity snapshot behavior

- [x] Create `src/quotations/domain/quotation-tax.types.ts` with `QuotationIvaClassification` (5 values incl. response-only `NOT_TAXABLE`), `QuotationIvaRateClassification` union, deterministic bucket order, and integer rate-percent mapping. Implement `snapshotTaxClassification`, `recomputeTaxableBase`, `hasCompleteTaxSnapshot`, `effectiveIvaClassification`, `includedIvaCents` on `src/quotations/domain/quotation-item.entity.ts` (nullable-tolerant for legacy rows; integer-only, non-negative money guards). Implement `computeIvaBreakdown()` (all-or-nothing, map-on-first-representation) as an INTERNAL domain capability in `src/quotations/domain/quotation.entity.ts` — WU1 correction: `toResponse()` keeps the legacy wire (`taxRate`/`taxCents`); `ivaBreakdown` activation and the legacy-field removal are deferred to T2.3; preserve `_taxRate` through `send`/`cancel` copy constructors. Rename the domain mutation to `setDeprecatedTaxRate(rate)` retaining the `0..1` invariant and `ensureDraft()` guard. Run `pnpm test src/quotations/domain` until green. <!-- sdd-owner: implementation -->

Acceptance: T1.1 specs pass; integer math matches the design examples table; no floating-point tax expression; existing domain specs still pass.
Dependencies: T1.1.

### T1.3 — Migration: additive nullable snapshot columns

- [x] Add `taxableBaseCents Int?`, `ivaRateClassification IvaRate?`, `chargeProductTaxesSnapshot Boolean?` to `QuotationItem` in `prisma/schema.prisma`; keep `Quotation.taxRate` and the `IvaRate` enum untouched; no defaults, no indexes, no data updates. Generate `prisma/migrations/<timestamp>_add_quotation_item_tax_snapshot/migration.sql` with three additive nullable `ADD COLUMN` statements only. Run `pnpm build` (or the project's prisma client generation step) to regenerate the typed client. <!-- sdd-owner: implementation -->

Acceptance: migration SQL is additive-only with nullable columns and no default/index/data statements; generated client types include the three nullable fields; existing rows conceptually remain null (no backfill).
Dependencies: none (parallel with T1.1/T1.2).

### T1.4 — Repository mapping + integration round-trip

- [x] Extend `src/quotations/infrastructure/prisma-quotation.repository.integration.spec.ts` (RED): round-trip complete snapshots, all three zero-tax meanings, all-null historic rows preserved verbatim, and legacy root `taxRate` round-trip. Then implement the mapping (GREEN) in `src/quotations/infrastructure/prisma-quotation.repository.ts`: include the three fields in `quotationItem.createMany` rows; map Prisma `IvaRate | null` to the domain rate union preserving nulls; keep root `taxRate` mapping in both directions. Run the integration spec until green. <!-- sdd-owner: implementation -->

Acceptance: nulls round-trip exactly; complete snapshots survive save/reload; root `taxRate` round-trips; integration spec green.
Dependencies: T1.2, T1.3.

---

## WU2 — Snapshot orchestration & response contract (PR 2 candidate)

Start: WU1 merged (or stacked). Finish: `addItem`/recompute snapshot pipeline live, `ivaBreakdown[]` on all read paths, deprecated PATCH isolated and non-influencing. Rollback: revert WU2 commits; WU1 columns remain ignored by old code. Verification: focused `pnpm test src/products src/quotations/application src/quotations/dto`.

### T2.1 — RED + GREEN: product service tax metadata widening

- [x] RED: extend `src/products/products.service-pos-helpers.spec.ts` — both product and variant branches of `getProductInfoForSale` return `{ ivaRate, chargeProductTaxes }` sourced from the parent `product` (variant rows never queried for tax). GREEN: widen `getProductInfoForSale` in `src/products/products.service.ts` (additive fields; existing callers unaffected). Run focused products specs until green. <!-- sdd-owner: implementation -->

Acceptance: variant call returns parent-product tax fields; pre-existing `getProductInfoForSale` specs pass unmodified except for the new assertions.
Dependencies: T1.3 (client types).

### T2.2 — RED + GREEN: addItem snapshot and DRAFT reprice resnapshot

- [x] RED: extend `src/quotations/application/quotations.service.spec.ts` — `addItem` snapshots all three fields; variant line inherits parent; non-DRAFT add rejected before persistence; successful PRICE_LIST reprice re-snapshots classification and re-derives base; product edits reflect only during DRAFT repricing; CUSTOM lines keep classification but get a new post-discount base; SENT/EXPIRED reads perform no product lookup; incomplete historic rows stay incomplete until a DRAFT write completes them. GREEN: implement in `src/quotations/application/quotations.service.ts` — status check before product lookup; seed the request-local `getProductInfoForSale` dedup cache `(productId, variantId)` with the addItem result; recompute order per design (remove promotions → resolve prices → resnapshot resolved PRICE_LIST lines → evaluate/apply promotions → prune opt-ins → re-derive `taxableBaseCents` for every non-null-classification line); persistence only after full recompute. Run the spec until green. <!-- sdd-owner: implementation -->

Acceptance: `lineTotalCents`/`subtotalCents`/`discountCents`/`totalCents` unchanged for the same line set; metadata lookups deduplicated per recompute; SENT paths never call the products service.
Dependencies: T1.2, T1.4, T2.1.

### T2.3 — DTO: validated `ivaBreakdown[]` contract (wire activation)

- [x] Activate the new wire contract in this task: convert `src/quotations/dto/quotation-response.dto.ts` from interface to a structurally equivalent class; add `QuotationIvaBreakdownEntryDto` (`@IsEnum(QuotationIvaClassification)`, `@IsInt() @Min(0)`) and `ivaBreakdown` with `@IsArray() @ValidateNested({ each: true }) @Type(...)`; AND in the same deployable change wire `ivaBreakdown: quotation.computeIvaBreakdown()` into `toResponse()` and remove the legacy `taxRate`/`taxCents` response fields (entity + DTO + service casts together), so the new wire contract activates only once its snapshot producer pipeline (T2.2) can populate it. Add/extend a co-located DTO spec using `plainToInstance` + `validate`: reject invalid classification, fractional/negative amounts, non-array values; accept represented-only arrays incl. zero-amount buckets; plus an externally observable service test proving `ivaBreakdown` appears and legacy fields disappear on read paths. Do not widen request DTOs; keep `src/quotations/dto/set-tax-rate.dto.ts` untouched. <!-- sdd-owner: implementation -->

Acceptance: closed 5-value enum enforced; response activation ships with the T2.2 producer pipeline in one deployable unit (no field-less `ivaBreakdown: []` regression for ordinary items); bootstrap `whitelist`/`forbidNonWhitelisted` behavior unchanged; DTO spec green.
Dependencies: T1.2.

### T2.4 — TRIANGULATE: aggregate invariant and legacy isolation

- [x] Add triangulation cases in `src/quotations/application/quotations.service.spec.ts` and `src/quotations/domain/quotation.entity.spec.ts`: for mixed-discount fixtures, `Σ ivaBreakdown.amountCents = totalCents − Σ taxableBaseCents` post-discount; a root `taxRate` differing from every line snapshot does not move any total; deprecated `setTaxRate` service path persists only root `taxRate` and leaves the next breakdown/PDF input byte-identical. Run until green. <!-- sdd-owner: implementation -->

Acceptance: invariant (a) pinned by tests; legacy root column provably excluded from response and recompute.
Dependencies: T2.2, T2.3.

---

## WU3 — Conditional PDF aggregate & deprecation signal (PR 3 candidate)

Start: WU1+WU2 stacked. Finish: one conditional `IVA incluido` PDF row; `Deprecation: true` header on the legacy PATCH. Rollback: revert WU3; PDF returns to no IVA row; header disappears; route stays callable. Verification: focused `pnpm test src/pdf-generation src/quotations/controllers`.

### T3.1 — RED + GREEN: PDF prop mapping and template row

- [ ] RED: extend `src/pdf-generation/pdf-generation.service.spec.ts` — `buildQuotationProps` sets `includedIvaCents = Σ ivaBreakdown.amountCents` when items exist and breakdown is non-empty, else `null`; assert non-zero aggregate, zero aggregate (`0` is available), and `null` on incomplete/empty breakdown. Extend `src/pdf-generation/templates/quotation/quotation-a4.document.spec.tsx` — exactly one `IVA incluido` row when `includedIvaCents !== null` (uses `!== null`, not truthiness); `$0.00` renders for a complete all-zero-tax quote; row omitted entirely on `null`; no classification label, no rate percentage, no per-line tax; existing Subtotal/Descuentos/TOTAL rows and layout unchanged. GREEN: add `includedIvaCents: number | null` to `QuotationDocumentProps.totals` in the PDF service and the conditional row before the divider/total card in `src/pdf-generation/templates/quotation/quotation-a4.document.tsx`. Run both specs until green. <!-- sdd-owner: implementation -->

Acceptance: all four PDF requirement scenarios pinned; template receives no classification/rate data at all.
Dependencies: T2.2 (breakdown available on read paths).

### T3.2 — RED + GREEN: deprecation header on legacy PATCH

- [ ] RED: extend `src/quotations/controllers/quotations.controller.spec.ts` — `PATCH /quotations/drafts/:id/tax-rate` response carries `Deprecation: true`; DRAFT-only 409 preserved on SENT/EXPIRED; before/after assertion proves PATCH changes neither the next GET `ivaBreakdown` nor the PDF aggregate input. GREEN: add `@Header('Deprecation', 'true')` to the existing handler in `src/quotations/controllers/quotations.controller.ts`; route, `SetQuotationTaxRateDto`, guards, and service call otherwise unchanged. Run until green. <!-- sdd-owner: implementation -->

Acceptance: endpoint still callable and persists root `taxRate`; no `Sunset` header; authorization/tenant guards untouched.
Dependencies: T2.4.

### T3.3 — Full-slice verification

- [ ] Run `pnpm test` (full suite: existing + new co-located specs) and `pnpm build`; confirm no sale/CFDI/IEPS/frontend suite requires behavior changes. Record focused test commands and exact results for each work unit per the work-unit evidence contract. <!-- sdd-owner: implementation -->

Acceptance: full suite green; build clean; no uncommitted scenario in the 29-scenario traceability matrix left unverified.
Dependencies: T3.1, T3.2.

---

## Work-unit summary

| WU  | Title                                          | Tasks     | PR candidate | Clean-revertable                                                          |
| --- | ---------------------------------------------- | --------- | ------------ | ------------------------------------------------------------------------- |
| 1   | Persistence & domain snapshot core             | T1.1–T1.4 | PR 1         | Yes (nullable columns ignored by reverted code)                           |
| 2   | Snapshot orchestration & response contract     | T2.1–T2.4 | PR 2         | Yes (single revert; response-contract break is confirmed in the proposal) |
| 3   | Conditional PDF aggregate & deprecation signal | T3.1–T3.3 | PR 3         | Yes (re-additive; route stays callable after revert)                      |

Scenario traceability: all 29 scenarios in `specs/quotations/spec.md` map to the seams listed in `design.md` § Verification strategy; no task touches IEPS, CFDI, sale-side tax, frontend, backfill, variant tax fields, tenant scoping, controller authorization, or removal of the deprecated endpoint/DTO/root column.
