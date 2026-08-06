# Proposal: Customer Quotations (Cotizaciones)

## Intent

The legacy POS system had a "cotización" workflow that sales reps used to send pre-priced documents to customers before committing to a sale. The current renovation has no equivalent — a cashier who wants to send a customer a price quote either invoices them (irreversible, consumes stock, prints a folio) or hand-writes the numbers. This change adds a first-class **Quotation** bounded context so reps can build a priced document, apply promotions, switch price lists, override prices, attach an optional expiry, render a PDF, and email it to the customer — all without touching the sale/inventory/payment machinery.

## Scope

### In Scope
- New `Quotation` lifecycle: `DRAFT → SENT → {EXPIRED | CANCELLED}` (no conversion to sale in this slice).
- Item, customer, price list, and per-item price override operations, mirroring the POS sale draft ergonomics.
- Promotion evaluation through the existing POS promotion engine port (same engine, quote-shaped cart).
- PDF generation via a new `quotation-a4` template registered in the existing `pdf-generation` registry (no engine changes).
- Email delivery via the existing `MAILER` port (Resend adapter, dev-logger fallback).
- Per-customer "Create quotation" entry point. Quotation stays linked to the customer in the UI.
- Expiry/deadline field (optional). Past-deadline quotations auto-transition to `EXPIRED` on read (lazy, no cron).
- Strict TDD: every layer has unit specs; no front-end wiring in this slice.

### Out of Scope (Non-Goals)
- Conversion of a quotation to a sale (follow-up change — touches inventory, payment, folio).
- Stock reservation / soft-hold for quoted items.
- WhatsApp or SMS delivery (email only).
- Customer-facing acceptance portal / public accept/reject link.
- Multi-currency support (uses the customer price list currency).
- QuickBooks / external accounting export.
- Frontend UI implementation (API + PDF + email only).

## Capabilities

### New Capabilities
- `quotations` — full bounded context: domain entity, repository, service, NestJS module, controllers, DTOs, Prisma models, promotion evaluation, PDF render, email send, lifecycle guards.

### Modified Capabilities
- `pdf-generation` — delta: register `quotation-a4` format key + React template; service learns a new `renderQuotationPdf(quotationId, format)` entry point. Engine, registry pattern, and font registration stay untouched.
- `pos-promotion-engine` — delta: add a `context: 'QUOTATION' | 'SALE'` discriminant to `PosEvalInput` so the engine can gate promotion targeting rules that should NOT apply to quotes (engine otherwise stays generic). This is the minimum needed to honor the **OPEN_DECISION** on promotion scope.

## Approach

New bounded context at `src/quotations/` mirroring the Sales hexagonal layout: `domain/` (`Quotation`, `QuotationItem`, `quotation.repository.ts`, `quotation.errors.ts`), `application/` (`QuotationsService`, ports for render/email), `infrastructure/` (`PrismaQuotationRepository`), `dto/`, `controllers/` (drafts, items, queries, send). New Prisma models `Quotation`, `QuotationItem`, `QuotationPromotionApplied`, `QuotationPromotionVeto`, `QuotationPromotionOptIn` — same shape as sale equivalents, no cross-table FKs to `Sale*`. PDF render reuses the existing `@react-pdf/renderer` registry: a new `quotation-a4` template mounts the same `<Document>`/`<Page>` shells already used in `receipt-a4` but with header "COTIZACIÓN" and a quote-only footer (no payment lines, no cambio). Email goes through `MAILER.send({ to, subject, html })` with a `@react-email/components` template that mirrors the PDF header and embeds the PDF as a Resend attachment.

The promotion engine gets a single-line widening: `PosEvalInput.context` (default `'SALE'`). The engine treats shares the same evaluation logic; the discriminant is purely a gate so future targeting rules can opt-in/out per context. The `recomputePricingAndPromotions` call is copied wholesale from `SalesService` into `QuotationsService` — there is no shared base class in this slice (YAGNI; refactor on the second consumer).

Pricing strategy: a quotation snapshots the **resolved price at recompute time** onto `QuotationItem.unitPriceCents` (mirrors `SaleItem.priceSource`). The next recompute refreshes the snapshot. No prices are locked at SENT — that's a deliberate decision because the OPEN_DECISION on price lock is unresolved; the default "recompute on every read" makes the question moot at the cost of one extra DB roundtrip per draft open.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/quotations/` (new) | New | Full bounded context, ~12 files |
| `prisma/schema.prisma` | New models | `Quotation`, `QuotationItem`, `QuotationPromotionApplied`, `QuotationPromotionVeto`, `QuotationPromotionOptIn` + enums `QuotationStatus`, `QuotationCancelReason` |
| `src/pdf-generation/templates/registry.ts` | Modified | Add `quotation-a4` key → React template |
| `src/pdf-generation/templates/` | New | `quotation/QuotationPdf.tsx` + `quotation/index.ts` |
| `src/pdf-generation/pdf-generation.service.ts` | Modified | New `renderQuotationPdf(id, format)` method |
| `src/pdf-generation/pdf-generation.controller.ts` | Modified | New `GET /quotations/:id/pdf?format=quotation-a4` route |
| `src/pdf-generation/pdf-generation.module.ts` | Modified | Import `QuotationsModule` |
| `src/promotions/application/ports/pos-evaluate-promotions.port.ts` | Modified | Add `context: 'SALE' \| 'QUOTATION'` to `PosEvalInput` |
| `src/promotions/application/pos-evaluate-promotions.use-case.ts` | Modified | New branch on `context` (default: behavior unchanged) |
| `src/customers/customers.service.ts` (or list endpoint) | Modified | Optional: surface "active quotations for customer" count for the per-customer row UI |
| `src/sales/` | None | Untouched — strict isolation |
| `openspec/specs/quotations/spec.md` | New | Full requirements + scenarios |
| `openspec/specs/pdf-generation/spec.md` | Modified | Delta: new `quotation-a4` format scenarios |
| `openspec/specs/pos-promotion-engine/spec.md` | Modified | Delta: `context` discriminant scenarios |

## Risks

| Risk | Lik | Mitigation |
|------|-----|------------|
| Promotion engine context gate silently changes sale behavior | Low | Default `context = 'SALE'` for all existing call sites; new branch is additive only; full regression of `pos-promotion-engine` suite |
| Item-management logic drift between Sale and Quotation over time | Med | Accept the duplication — extract shared cart helpers only when a third consumer appears (rule of three) |
| PDF render of long quotations (50+ items) blows memory | Low | A4 template uses the same pagination strategy as `receipt-a4` (already stress-tested in receipt-review); cap is implicit |
| Email send fails after status flips to SENT → orphan state | Med | Send email INSIDE the same transaction-style flow as the SENT transition; if Resend returns error, keep `DRAFT` and surface 502; do NOT commit the status change until `mailer.send` resolves |
| Quotation becomes stale relative to product price changes between SENT and customer reply | High | Documented as expected. Lazy recompute on every read keeps the displayed numbers fresh; the PDF that was emailed is the historical snapshot |
| Customer has no email → `send` endpoint rejects | Low | Surface 422 with `QUOTATION_CUSTOMER_HAS_NO_EMAIL`; offer to set the email inline before retry |
| Expiry auto-transition on read is non-atomic across replicas | Low | Single-instance dev/staging today; if multi-replica lands, switch to a DB-level `WHERE status='SENT' AND expiresAt < NOW()` update |
| 400-line PR budget exceeded | Med | Forecast: ~1,200 lines across schema + entity + repo + service + controller + DTOs + tests + PDF template + email template + spec + proposal. Plan as **chained PR slices** (WU1: schema + entity + repo; WU2: service + draft CRUD; WU3: items + promos + price list; WU4: PDF + email + send flow) — confirmed in `sdd-tasks` |
| Frontend wiring not in scope breaks the "Create quotation" button | Low | API contract documented for the FE team; FE wiring is a separate slice |

## Product Decisions (RESOLVED)

1. **Expiry date** → **Optional**. Si no se setea, la cotización nunca expira. Si se setea, transición lazy a `EXPIRED` al leerla después de la fecha. Sin cron job.

2. **Promotion scope** → **Mismo engine que ventas**. Se agrega un campo `context` (`'SALE' | 'QUOTATION'`) al engine como discriminante para que futuras reglas quote-specific puedan existir sin cambiar código, pero hoy el comportamiento es idéntico al de ventas.

3. **Status post-email** → **Auto-SENT** al recibir respuesta exitosa de Resend. Si el envío falla, se queda en `DRAFT` y se devuelve error 502. No hay transición manual a SENT; el endpoint `send` es la única puerta.

4. **Límite de cotizaciones activas** → **Sin enforcement**. Sin restricción de cuántas cotizaciones activas puede tener un cliente.

5. **Stock checks** → **Bypass total**. El backend no bloquea ni advierte. La cotización es una promesa, no una reserva. El frontend puede consultar stock por su cuenta si quiere mostrar badges.

## Enhancement Ideas (for the future)

Not in this slice. Capture here so they don't get lost.

- **Quotation versioning** — re-sending keeps a `parentQuotationId` and the line-diff. Sales rep approves a rev, customer sees v1, v2, v3.
- **Internal notes / comments** — a `notes` text field on the quotation for the sales rep's eyes only; never printed on the PDF or email.
- **Customer acceptance workflow** — a public, tokenized `/q/:token` URL that lets the customer click "Accept" / "Request changes" / "Reject" without auth. Drives the open `CONVERTED_TO_SALE` lifecycle endpoint (which is itself a follow-up).
- **Quotation-level discount** — single percent or absolute discount applied AFTER line items and promotions (like a sale-level promotion). Today this is faked by promoting a `MANUAL` percent-discount promotion; explicit field is cleaner.
- **Multi-currency / price list comparison** — show the customer what they'd pay under each of their price lists in a single PDF. Useful for B2B where the same catalog has three contract prices.
- **Stock soft-hold on SENT** — flip inventory to `RESERVED` when the quotation is emailed, auto-release on EXPIRED/CANCELLED. Couples to a future inventory-module change.
- **Quotation as a contract** — add a signature box + custom terms text + digital signature captcha for B2B deals.

## Rollback Plan

Single revert of the feature branch. The migration adds 5 new tables and 2 new enums; reverse migration is `prisma migrate resolve --rolled-back` on the only new migration. Drop the new module imports from `PdfGenerationModule`. No data migration needed for existing sales/catalogs — the new tables are isolated. No PDF or email config changes (templates are new files, existing sale receipt templates untouched). The `pos-promotion-engine` widened `PosEvalInput` carries an optional `context` field; omitting it (old behavior) keeps the engine identical to today.

## Dependencies

- `@react-pdf/renderer` (already installed) — reuses for the new template.
- `@react-email/components` (already installed) — new email template.
- `IMailer` port (already shipped) — no change.
- `POS_EVALUATE_PROMOTIONS_USE_CASE` port (already shipped) — single field widening.
- `ProductsService.resolvePriceListGlobalIds` + `getProductInfoForSale` (already shipped) — pattern clone for the new context.
- `Customer` model has `email: String?` and `globalPriceListId` today — no schema change needed.

## Success Criteria

- [ ] `POST /quotations/drafts` opens a new DRAFT quotation for the authenticated user.
- [ ] `POST /quotations/drafts/:id/items` adds an item; price resolves through the customer price list (or global default if no customer).
- [ ] `PATCH /quotations/drafts/:id/customer` auto-seeds the price list from `customer.globalPriceListId`.
- [ ] `PUT /quotations/drafts/:id/price-list` overrides the price list; recompute propagates to all items.
- [ ] `PATCH /quotations/drafts/:id/items/:itemId/price` overrides a single item's price; the override snapshot is persisted.
- [ ] `PUT /quotations/drafts/:id/manual-promotions/:promoId` and `DELETE` toggle a manual promotion (mirrors sale).
- [ ] `POST /quotations/drafts/:id/send` with `?email=true` flips status to `SENT` AND calls `mailer.send` with the PDF attached; rejects with 422 if `customer.email` is null.
- [ ] `GET /quotations/:id/pdf?format=quotation-a4` renders the PDF even when status is `DRAFT` (previews allowed).
- [ ] On any read, an `expiresAt` in the past auto-flips `SENT` → `EXPIRED` (lazy, idempotent).
- [ ] `POST /quotations/drafts/:id` (cancel) transitions any non-terminal status to `CANCELLED` with a `cancelReason`.
- [ ] Promotions engine `context: 'QUOTATION'` produces the same evaluation as `context: 'SALE'` for every existing fixture (regression suite green).
- [ ] `GET /quotations` and `GET /quotations/:id` query endpoints follow the same auth/permissions pattern as Sales.
- [ ] All endpoints are tenant-scoped via `TenantPrismaService`; cross-tenant id returns 404.
- [ ] `pnpm run test` and `pnpm run build` green; new spec covers ≥ 80% of new files.

## Size Signal

**Forecast: 1,100–1,300 lines added across + new files (excluding Prisma generated client and existing sale templates).** Exceeds the 400-line review budget. Recommended execution: **chained PR slices** in the order documented under Risks (WU1 schema+entity → WU2 service+CRUD → WU3 items+promos+price-list → WU4 PDF+email+send). Each WU is a clean revert individually. Confirmed in `sdd-tasks` step.
