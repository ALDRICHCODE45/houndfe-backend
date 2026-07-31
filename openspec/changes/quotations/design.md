# Design: Quotations Bounded Context

## Technical Approach

New `src/quotations/` bounded context mirroring the Sales hexagonal layout, but with an independent lifecycle (`DRAFT → SENT → EXPIRED → CANCELLED`). No conversion-to-sale or stock reservation in this slice. Shares the existing promotion engine, price list resolution, PDF generation, and email infrastructure — all via their existing ports, zero breaking changes.

| Aspect | Decision |
|--------|----------|
| **Entity pattern** | Same as `Sale`: private ctor, `static create()`/`fromPersistence()`, mutation methods reject non-DRAFT. |
| **Promotion recompute** | `recomputePricingAndPromotions()` copied wholesale from `SalesService` (YAGNI: no shared base class yet). Passes `context: 'QUOTATION'`. |
| **Expiry** | Lazy on read via `getEffectiveStatus()`. No cron. |
| **Send** | Atomically: render PDF in-memory → `mailer.send(...)` → SENT only on success. Failure keeps DRAFT + 502. |
| **PDF** | New `quotation-a4` template, same `@react-pdf/renderer` shell as `receipt-a4`, no payment/cambio lines. |
| **PosEvalInput widening** | Optional `context?: 'SALE' | 'QUOTATION'`, defaults `'SALE'`. Engine treats both identically — a gate for future rules. |

## Data Flow

```
POST /quotations/drafts/:id/items
  → QuotationsService.addItem()
    → domain.addItem()
    → repo.save()
    → recomputePricingAndPromotions()
      → buildPosEvalInput(context='QUOTATION')
      → posEvaluatePromotions.evaluate(input)
      → domain.apply*Promotions(result)
      → repo.save()
    → quotation.toResponse()
```

```
POST /quotations/drafts/:id/send
  → guard: DRAFT only, items non-empty, customer.email exists
  → renderQuotationPdf() → Buffer
  → mailer.send({ to, subject, html, attachments: [{ content, filename }] })
  → on success: domain.send() → status=SENT → repo.save()
  → on failure: throw 502, status stays DRAFT
```

## File Changes

| File | Action | Notes |
|------|--------|-------|
| `prisma/schema.prisma` | Modify | Add `Quotation`, `QuotationItem`, 3 junction tables, `QuotationStatus`, `QuotationCancelReason` enums |
| `src/quotations/domain/quotation.entity.ts` | New | Aggregate root — mirrors Sale entity structure |
| `src/quotations/domain/quotation-item.entity.ts` | New | Line item — mirrors SaleItem |
| `src/quotations/domain/quotation.repository.ts` | New | `IQuotationRepository` port + `QUOTATION_REPOSITORY` token |
| `src/quotations/domain/quotation.errors.ts` | New | Custom errors (NotFound, NotDraft, HasNoItems, CustomerHasNoEmail) |
| `src/quotations/infrastructure/prisma-quotation.repository.ts` | New | Prisma adapter — upsert pattern mirroring PrismaSaleRepository |
| `src/quotations/application/quotations.service.ts` | New | Orchestration layer — openDraft, addItem, send, cancel, recompute |
| `src/quotations/dto/*.dto.ts` | New | ~8 request DTOs, 2 response DTOs |
| `src/quotations/controllers/quotations.controller.ts` | New | `POST /quotations/drafts`, item CRUD, customer/price-list/promo/expiry mutations, send/cancel |
| `src/quotations/quotations.module.ts` | New | DI wiring — imports Prisma, Products, Customers, PriceLists, Promotions, Mailer |
| `src/pdf-generation/pdf-generation.constants.ts` | Modify | Add `'quotation-a4'` to `FormatKey` union |
| `src/pdf-generation/templates/quotation/QuotationPdf.tsx` | New | React PDF template — header "COTIZACIÓN", items, expiry, no payment/cambio |
| `src/pdf-generation/templates/registry.ts` | Modify | Register `quotation-a4` → QuotationA4Template |
| `src/pdf-generation/pdf-generation.service.ts` | Modify | Add `renderQuotationPdf(quotationId, format)` method |
| `src/pdf-generation/pdf-generation.controller.ts` | Modify | Add `GET /quotations/:id/pdf?format=quotation-a4`; inject QuotationsService |
| `src/pdf-generation/pdf-generation.module.ts` | Modify | Import `QuotationsModule` |
| `src/promotions/application/ports/pos-evaluate-promotions.port.ts` | Modify | Add `context?: 'SALE' | 'QUOTATION'` to `PosEvalInput` |
| `src/auth/authorization/domain/permission.ts` | Modify | Add `'Quotation'` to `AppSubjects`, 5 entries to `PERMISSION_REGISTRY` |

## Interfaces / Contracts

```typescript
// Quotation status lifecycle
type QuotationStatus = 'DRAFT' | 'SENT' | 'EXPIRED' | 'CANCELLED';
type QuotationCancelReason = 'CUSTOMER_REQUEST' | 'PRICE_OBJECTION' | 'EXPIRED' | 'OTHER';

// Repository port (Symbol('QUOTATION_REPOSITORY'))
interface IQuotationRepository {
  save(quotation: Quotation): Promise<Quotation>;
  findById(id: string): Promise<Quotation | null>;
  findAll(query: QuotationListQuery): Promise<{ data: Quotation[]; total: number }>;
  delete(id: string): Promise<void>;
}

// PosEvalInput widening (backward-compatible)
interface PosEvalInput {
  now: Date;
  customerId: string | null;
  lines: PosEvalLine[];
  vetoedPromotionIds: ReadonlyArray<string>;
  optedInManualPromotionIds: ReadonlyArray<string>;
  context?: 'SALE' | 'QUOTATION'; // NEW — default 'SALE'
}
```

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Unit | Quotation entity lifecycle | Table-driven tests: create, add/remove item, status transitions, lazy expiry, recompute idempotency |
| Unit | QuotationsService | Mock repository + engine + mailer ports; verify every mutation path triggers recompute |
| Integration | PrismaQuotationRepository | Real test DB: save with items+junctions, findById round-trip, cross-tenant isolation |
| Integration | Promotion engine regression | Existing `pos-evaluate-promotions` suite passes unchanged; new `context='QUOTATION'` test asserts equality with `'SALE'` |
| E2E | Controller endpoints | Supertest: draft creation, item CRUD, send flow (mock Resend), PDF render, cancel, cross-tenant 404 |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary.

## Migration / Rollout

- Single migration adds 5 tables + 2 enums. Reverse: `prisma migrate resolve --rolled-back`.
- Existing sales/catalogs untouched — zero data migration.
- PDF/email config unchanged (templates are new files, registry is additive).
- Promotion engine `context` field is optional — omitting it keeps engine identical.

## Work Unit Plan

| WU | Scope | Files | Revert boundary |
|----|-------|-------|-----------------|
| WU1 | Prisma schema + migration + entity + repository | schema, entity, item entity, repository port, Prisma adapter, errors, .spec files | Drop new tables + reverse migration |
| WU2 | Service + draft CRUD + customer + price list | service, module, controller drafts, openDraft/findAll/findOne DTOs, .spec files | Remove module + controller + service |
| WU3 | Items + promotions + price override + expiry | addItem/updateQty/removeItem/override price DTOs + service methods + promo mutations + expiry + .spec files | Remove item/promo/expiry endpoints |
| WU4 | PDF template + email + send flow + controller wiring | QuotationPdf.tsx, renderQuotationPdf, email template, send+email flow, PDF route, registry, permission entries + .spec files | Remove PDF routes, template, email |

## Open Questions

- None — all product decisions are resolved.
