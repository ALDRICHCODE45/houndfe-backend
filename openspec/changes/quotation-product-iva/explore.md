# Exploration: Product IVA on Quotations

## Scope and resolved decision gate

This exploration covers a narrow replacement of the quotation-wide editable tax rate with product-derived IVA for quotations. It excludes IEPS, CFDI generation, sales-tax behavior, retroactive changes to sent quotations, push/PR work, and implementation. No `protect-confirmed-sales` archive was read.

The product decisions below are confirmed, so the pre-proposal decision gate is resolved. This exploration records the agreed product contract only; it does not create a proposal, specification, design, or tasks.

## Current quotation pricing and tax flow

1. `POST /quotations/drafts/:id/items` reaches `QuotationsService.addItem()` (`src/quotations/application/quotations.service.ts`). It calls `ProductsService.getProductInfoForSale(productId, variantId)` and stores only product/variant IDs and names, quantity, and the resolved unit price on a `QuotationItem`.
2. Every price-affecting draft mutation calls `recomputePricingAndPromotions()`: it clears promotion discounts, re-resolves non-custom price-list lines, evaluates promotions with `context: 'QUOTATION'`, and applies resulting discounts. It does not resolve product tax attributes.
3. `Quotation.recomputeTotals()` calculates pre-discount subtotal, promotion discount, and total from stored line prices. `Quotation.toResponse()` exposes the persisted root `taxRate` and computes `taxCents` as `round(totalCents * taxRate / (1 + taxRate))`, which assumes a tax-inclusive total.
4. `PATCH /quotations/drafts/:id/tax-rate` accepts any decimal 0–1 and persists it through `Quotation.setTaxRate()` / `QuotationsService.setTaxRate()`. It does not recompute pricing or promotions. The root column default is 0.16.
5. The quotation A4 PDF maps only subtotal, discounts, total, and display line pricing. It deliberately has no IVA row; comments say IVA is informational and already included in total. Thus `taxRate` and `taxCents` are currently API-only fields, not PDF inputs.

## Product and variant IVA semantics

- `Product` owns `chargeProductTaxes`, `ivaRate`, and `iepsRate`; `ivaRate` defaults to `IVA_16` and `chargeProductTaxes` defaults to true (`prisma/schema.prisma`, `src/products/domain/product.entity.ts`).
- `IvaRate` explicitly models `IVA_16`, `IVA_8`, `IVA_0`, and `IVA_EXENTO`. Both zero values map to 0%, but `IVA_EXENTO` has separate `isExempt` semantics (`src/products/domain/value-objects/iva-rate.value-object.ts`).
- `Variant` has no IVA or tax-enable fields. `ProductsService.getProductInfoForSale()` validates a variant against its parent and resolves its price, but returns no tax data. Current variants therefore have no independent tax behavior in persistence or the quotation lookup seam; any quotation tax behavior must derive from the parent product unless a later scope explicitly adds variant tax attributes.
- `chargeProductTaxes` and `ivaRate` currently influence product creation, update, persistence, and purchase-cost calculation, but this exploration found no quotation or sale consumption of either field.

## Persistence and snapshot behavior

- `Quotation.taxRate` is a root `Float` added by migration `20260806084103_add_tax_rate_to_quotations`; `QuotationItem` has no IVA-rate, tax-enable, taxable-base, or tax-amount snapshot columns.
- Quote lines persist product/variant IDs plus product/variant names, unit price, price-source metadata, promotion metadata, and quantity. Repository save uses delete-and-create for all item rows (`src/quotations/infrastructure/prisma-quotation.repository.ts`).
- Root subtotal/discount/total are persisted, but normal response totals are recalculated from item state in `Quotation.toResponse()`.
- Product and variant names and prices are line snapshots once stored. However, customer name/email and seller name for the response/PDF are read live on every request, and no rendered-PDF blob is stored. Therefore a sent quotation is immutable for line data through public draft mutations, but it is not a complete presentation snapshot.
- For the intended first slice, product tax data must be stored on quotation lines (or otherwise frozen before `SENT`) if sent quotation tax totals and any tax presentation are to remain independent of later product edits. Resolving current product tax data during a sent quote read would violate that goal.

## Sent quotation immutability

- Aggregate mutations, including `setTaxRate`, call `ensureDraft()` and public service methods reject non-DRAFT quotations. `send()` returns a new `SENT` aggregate containing the existing lines and values.
- The quotation PDF preview route accepts DRAFT, SENT, and EXPIRED quotes and renders the response it receives. The send flow renders the DRAFT response before changing status to SENT.
- Sent and expired quotations cannot be deleted; cancellation is still supported. No proposal should rewrite existing sent quotation rows or reconstruct their tax from changed products.

## Presentation and PDF behavior

- `PdfGenerationService.buildQuotationProps()` passes only basic line amounts and `subtotalCents`, `discountCents`, and `totalCents` to `QuotationA4Document`.
- `QuotationA4Document` renders product/variant names, quantity × unit price, line total, subtotal, discount, and grand total. It has no line-level tax detail, no IVA total, no tax-rate label, and no rate breakdown.
- The confirmed first-slice contract adds classification-level IVA amounts to the API response, while the PDF displays only one aggregate included-IVA amount. The PDF must not display a classification or rate breakdown.
- PDF unit tests cover renderability, seller/customer/expiry behavior, no payment fields, and template mapping. They do not assert IVA behavior or mixed-rate disclosure.

## Test seams

| Seam                                        | Current coverage                                                                                 | Needed first-slice coverage                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Quotation` / `QuotationItem` domain        | Entity and item unit specs cover totals, discounts, lifecycle, and send state.                   | Line tax snapshot invariants; mixed IVA totals; `chargeProductTaxes=false`; `IVA_0` vs `IVA_EXENTO`; rounding policy once chosen; SENT immutability.              |
| `QuotationsService.addItem()` and recompute | Service specs mock `ProductsService`, repository, promotion engine, mailer, and PDF service.     | Product tax metadata propagation on add/reprice; mixed product/variant quote calculation; DRAFT-only behavior; ensure no live product lookup changes a sent line. |
| `PrismaQuotationRepository`                 | PostgreSQL-backed integration spec covers save/reload, filters, and tenant isolation.            | New line tax fields round-trip and historic sent-row preservation.                                                                                                |
| Controller / DTO                            | Controller specs verify delegation; `SetQuotationTaxRateDto` has no focused spec.                | Removed/replaced tax-rate endpoint contract and classification-level IVA amount response shape.                                                                   |
| PDF service/template                        | Unit tests pin quotation prop mapping/template rendering; integration checks PDF infrastructure. | One aggregate included-IVA amount only, no classification/rate breakdown, and stored tax snapshots for sent quote PDFs.                                           |

## Confirmed product decisions

1. Quotation unit prices are IVA-inclusive. IVA calculation is informational within the stored line and quotation amounts and MUST preserve the existing grand total.
2. `chargeProductTaxes=false` forces a zero IVA amount regardless of the product's configured `ivaRate`. Its snapshot/API classification MUST remain distinct from both `IVA_0` and `IVA_EXENTO`; the eventual implementation may select the explicit persisted identifier without collapsing those three meanings.
3. The first slice API exposes IVA amounts at classification level. The quotation PDF shows only the aggregate included IVA amount and no classification or rate breakdown.
4. A variant inherits its parent product's tax behavior; variants do not introduce an independent tax classification or tax-enable override in this slice.

## Resolved pre-proposal decision gate

All product decisions that blocked proposal work are now confirmed. The remaining choice of calculation precision and rounding point is an implementation-design detail, not a product-decision gate; it must preserve inclusive prices, the existing grand total, and the stored line tax snapshot.

External fiscal research would not materially reduce ambiguity in this first-slice product contract because the confirmed decisions define its quotation behavior and exclude CFDI and broader fiscal compliance. Such research may be appropriate if later scope adds regulated fiscal-document requirements.

## Suggested narrow boundary

Replace the DRAFT-wide tax override with parent-product IVA resolution at line creation/repricing, persist the resolved tax classification and calculation inputs per quotation item, calculate API classification-level IVA amounts from those snapshots without changing inclusive grand totals, and preserve the snapshots after SENT. Render only the aggregate included IVA amount in the PDF. Do not extend the slice to IEPS, CFDI, sales, existing sent-row rewriting, implementation, push, or PR work.
