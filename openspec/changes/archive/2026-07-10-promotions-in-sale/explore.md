# Exploration: promotions-in-sale

Connect the existing Promotions rule catalog to the POS Sale (draft) flow so that
applicable promotions can be applied during sale creation — automatically when the
promotion is configured `AUTOMATIC`, manually (seller opt-in) when `MANUAL`.

**Scope:** backend + DB + domain only. Frontend is out of scope.

---

## Current State

### Promotions module = rule catalog ONLY (no business impact)

`src/promotions/**` implements CRUD for promotion rules. The `docs/promotions-frontend.md`
canonical doc states this explicitly (lines 41-44, 738-742):

> "Fuera de alcance (intencional): Motor de cálculo de promociones en checkout/POS
> (stacking/aplicación efectiva)."
> "El módulo Promotions hoy es **definición/gestión de reglas (CRUD)**. La aplicación
> en venta vive en POS/Ventas."

So promotions are, as the user said, "flying in the code" — persisted entities with
zero connection to any transactional flow.

#### Promotion TYPES (`PromotionType` enum — `prisma/schema.prisma:66-71`, mirrored in `src/promotions/domain/promotion.entity.ts:6-10`)

| Type | Config fields (entity + schema) | Meaning |
|---|---|---|
| `PRODUCT_DISCOUNT` | `discountType` (PERCENTAGE\|FIXED), `discountValue`, `appliesTo` (CATEGORIES\|BRANDS\|PRODUCTS), `targetItems[]` (side=DEFAULT) | % or fixed off matching products |
| `ORDER_DISCOUNT` | `discountType`, `discountValue`, `minPurchaseAmountCents?` | % or fixed off the whole order total, optional min purchase gate |
| `BUY_X_GET_Y` | `buyQuantity`, `getQuantity`, `getDiscountPercent` (0-99, 0=free), `appliesTo`, `targetItems[]` | 2x1 / 3x2 / "second at X%" |
| `ADVANCED` | `buyQuantity` + `buyTargetType` + buy `targetItems[]` (side=BUY); `getQuantity` + `getDiscountPercent` + `getTargetType` + get `targetItems[]` (side=GET) | "buy X of A, get Y of B at Z%" |

Type-specific invariants enforced in `Promotion.create()` /
`validateByType()` (`promotion.entity.ts:377-457`): required vs forbidden fields per type,
`discountValue` range (1-100 for PERCENTAGE, >0 for FIXED), quantity >= 1, `getDiscountPercent`
0-99, `endDate >= startDate`.

#### Prisma schema (promotions) — `prisma/schema.prisma:1051-1157`

```prisma
model Promotion {
  id            String          @id @default(uuid())
  title         String
  type          PromotionType
  method        PromotionMethod       // AUTOMATIC | MANUAL  <-- the auto/manual flag EXISTS
  status        PromotionStatus @default(ACTIVE)  // ACTIVE | SCHEDULED | ENDED
  startDate     DateTime?
  endDate       DateTime?
  customerScope CustomerScope   @default(ALL)     // ALL | REGISTERED_ONLY | SPECIFIC
  discountType  DiscountType?
  discountValue Int?
  minPurchaseAmountCents Int?
  appliesTo PromotionTargetType?
  buyQuantity        Int?
  getQuantity        Int?
  getDiscountPercent Int?
  buyTargetType PromotionTargetType?
  getTargetType PromotionTargetType?
  tenantId      String
  targetItems PromotionTargetItem[]   // side: DEFAULT|BUY|GET, targetType, targetId
  customers   PromotionCustomer[]     // for customerScope=SPECIFIC
  priceLists  PromotionPriceList[]    // globalPriceListId links
  daysOfWeek  PromotionDayOfWeek[]    // DayOfWeek[]
  @@index([tenantId]) @@index([type]) @@index([method])
  @@index([status, startDate, endDate])
}
```

Relation tables: `PromotionTargetItem` (1098-1113, `@@unique([promotionId, side, targetType, targetId])`),
`PromotionCustomer` (1115-1128), `PromotionPriceList` (1130-1143, → `GlobalPriceList`),
`PromotionDayOfWeek` (1145-1157).

#### Auto vs Manual flag — ALREADY EXISTS

`PromotionMethod` enum (`AUTOMATIC | MANUAL`, schema:73-76) is the exact flag the user asked
about. It is persisted and readable but **never consulted by any sale flow**. No `trigger`
or `isAutomatic` boolean is needed — the enum is the source of truth. **This is NOT a gap.**

#### Eligibility / condition fields present on the rule (but no engine reads them)

- Date window: `startDate` / `endDate` (drives lazy `status`)
- `daysOfWeek[]` — day-of-week gating
- `customerScope` (ALL / REGISTERED_ONLY / SPECIFIC) + `customers[]`
- `priceLists[]` — restrict promo to specific global price lists
- `minPurchaseAmountCents` (ORDER_DISCOUNT only)
- `status` effective evaluation (`getEffectiveStatus`, entity:320-327)
- **Missing entirely:** usage limits/caps (global or per-customer), priority/rank,
  explicit stacking rules. No such fields exist.

#### Persistence & ports

- Port: `IPromotionRepository` (`src/promotions/domain/promotion.repository.ts:20-30`):
  `save / findById / findAll(query) / delete / updateStatus`. `findAll` query supports
  filtering by `type/status/method/customerScope/search` (used by the stub engine below).
- Adapter: `src/promotions/infrastructure/prisma-promotion.repository.ts`.
- Token: `PROMOTION_REPOSITORY` Symbol.

### There IS a partial application engine — but it is a stub, and NOT wired to POS

`src/promotions/application/evaluate-cart-promotions.use-case.ts` (`EvaluateCartPromotionsUseCase`):

- Loads only `method: 'AUTOMATIC', status: 'ACTIVE'` promotions (`page 1, limit 100`).
- **Only handles `PRODUCT_DISCOUNT` where `appliesTo === 'PRODUCTS'`** with non-null
  discountType/value (`isSupportedProductDiscountPromotion`, lines 53-60).
- For every other supported type/config, returns
  `promotionEvaluationStatus: 'needs_human_review'` (lines 29-48) — it punts.
- Matches by `targetItems[].targetId === item.productId` (side DEFAULT only), computes a
  per-line discount, picks the **first** matching promo (`.find`, line 67) — no stacking,
  no best-wins, no priority.
- **Ignores:** dates, daysOfWeek, customerScope, priceLists, minPurchaseAmount, quantity
  thresholds, BUY_X_GET_Y, ORDER_DISCOUNT, ADVANCED, CATEGORIES/BRANDS targeting.
- Returns a computed preview only; **it does not persist anything** on any sale.

Port `IEvaluateCartPromotionsUseCase` + token `EVALUATE_CART_PROMOTIONS_USE_CASE`
(`application/ports/evaluate-cart-promotions.port.ts`). Input `CartItemForEvaluation`
(`productId, variantId, quantity, unitPriceCents`).

**Wiring:** Only `chatbot-api` (the ONLINE WhatsApp bot) consumes it — via
`ChatbotApiService.evaluateCart()` (`src/chatbot-api/application/chatbot-api.service.ts:112-113, 142-146`)
and `chatbot-api.module.ts:7-8,31,53-54`. **The `sales/` (POS seller) module does NOT import
`PromotionsModule` nor the use-case** (confirmed: `sales.module.ts:11-28` imports only
Products/Auth/Outbox/SaleComments; codebase-wide grep shows zero references from `sales/`).

### Sale creation flow (POS) — `src/sales/**`

The **sale-creation path the user means ("seller creating a SALE") is `sales/`**, not
`orders/`. `orders/` is a separate, thin legacy `Order/OrderItem` model
(`schema.prisma:598-636`) unrelated to POS discounts.

Draft lifecycle (all in `SalesService`, `src/sales/sales.service.ts`):

1. `openDraft(userId)` → `Sale.create` (status DRAFT, channel POS) → `saleRepo.save` (:532-544)
2. `addItem(saleId, userId, dto)` → fetches product info, **freezes price at add-time**
   via `ProductsService.getProductInfoForSale`, stock check, `sale.addItem` (:551-625)
3. `updateItemQuantity` / `removeItem` / `clearItems`
4. `assignCustomer` / `setShippingAddress` / `assignSeller`
5. Manual discounts: `applyItemDiscount` (:1062), `removeItemDiscount` (:1115),
   `applyGlobalDiscount` (:1136), `removeGlobalDiscount` (:1204)
6. Price overrides: `overrideItemPrice` (:988) — price-list or custom price
7. `chargeDraft(saleId, actorId, dto, idempotencyKey)` (:1466) — the terminal step that
   computes totals, confirms, and persists.

Controller routes (`sales.controller.ts`): `PATCH /sales/drafts/:id/items/:itemId/discount`
(:188), `DELETE .../discount` (:199), `PATCH /sales/drafts/:id/discount` (:209),
`DELETE /sales/drafts/:id/discount` (:219). All guarded `update:Sale`.

#### Totals computation — inline in `chargeDraft`, NOT a shared pricing service

`chargeDraft` transaction (`sales.service.ts:1518-1732`):

```
subtotalCents = Σ (item.prePriceCentsBeforeDiscount ?? item.unitPriceCents) * qty   (:1568)
totalCents    = Σ item.unitPriceCents * qty                                          (:1575)
discountCents = subtotalCents - totalCents                                           (:1579)
```

`item.unitPriceCents` is the **post-discount** unit price (discount already folded into it
at `applyDiscount` time). There is **no standalone pricing/calculation service** — totals
are derived from item state at charge time. `getSaleDetail` surfaces
`subtotalCents/discountCents/totalCents` (:886-889).

#### SaleItem discount model — the persistence surface already exists

`SaleItem` (`src/sales/domain/sale-item.entity.ts`) + schema `SaleItem`
(`schema.prisma:700-734`) already carry per-line discount audit fields:

`discountType` (amount|percentage), `discountValue`, `discountAmountCents`,
`prePriceCentsBeforeDiscount`, `discountTitle` (free text), `discountedAt`,
plus price-source fields `priceSource` (DEFAULT|PRICE_LIST|CUSTOM), `appliedPriceListId`,
`customPriceCents`, `originalPriceCents`.

`SaleItem.applyDiscount()` (:229-260): validates amount/percent, computes
`discountAmountCents`, enforces `baseline - discount >= 1`, folds discount into
`unitPriceCents`, records `discountTitle`. **There is NO `promotionId` field** — a discount
records only a free-text `discountTitle`, so today there is no way to know WHICH promotion
produced a discount (no audit link).

#### Price-lists interaction surface

`overrideItemPrice` (:988-1060) sets an item's price from a `GlobalPriceList` via
`ProductsService.resolveListPrice`, and `clearDiscountFields()` runs on override
(`sale-item.entity.ts:226`) — i.e. a price-list override currently **wipes** any item
discount. Promotions themselves carry `priceLists[]` (restrict promo to certain lists).
The interaction (promo on top of list price, or mutually exclusive) is unspecified → open question.

#### Transaction boundary & multi-tenancy

- `chargeDraft`/`cancelSale` run inside `saleRepo.runInTransaction` →
  `TenantPrismaService.runInTransaction` (`prisma-sale.repository.ts:469-471`). Draft mutations
  (addItem, applyDiscount, etc.) are NOT transactional — each is a single `saleRepo.save`.
- Tenant scoping: `TenantPrismaService.getClient()` returns a CLS-scoped Prisma client;
  every query filters `tenantId` explicitly (`requireTenantId()`, repo passim). Any promotion
  read added to the sale flow MUST go through the tenant-scoped client so promos are
  tenant-isolated (Promotion has `tenantId`, schema:1079).

---

## The Connection Gap (what is missing to connect promotions → sales)

1. **No wiring.** `sales/` does not import `PromotionsModule` / the evaluate use-case. No
   dependency exists from the POS flow to promotions.
2. **No POS-grade eligibility/matching engine.** The only engine (`EvaluateCartPromotionsUseCase`)
   handles 1 of 4 types, ignores every condition (dates, days, customerScope, priceLists,
   minPurchase, quantities), and flags the rest `needs_human_review`.
3. **No auto-apply trigger in the sale lifecycle.** `PromotionMethod.AUTOMATIC` exists but
   nothing in `addItem` / draft recompute / `chargeDraft` evaluates or applies auto promos.
4. **No manual-promo application path.** No endpoint/service to list applicable MANUAL promos
   for a draft and let a seller opt one in (distinct from the existing free-form manual discount).
5. **No promotion audit trail on the sale.** `SaleItem` records only `discountTitle` free
   text — no `promotionId` / applied-promotion record, so reporting/reversal by promotion
   is impossible.
6. **No config for stacking / priority / usage limits.** These fields do not exist on the
   Promotion model.
7. **ORDER_DISCOUNT has no home.** Sale-level (whole-cart) discount from a promotion has no
   representation — discounts today are per-line only; `Sale.discountCents` is derived, not stored input.

---

## Key OPEN QUESTIONS for the user (product/business decisions)

These are genuine forks only the business owner can decide. **Not answered here.**

1. **Stacking policy.** If several promotions match the same line/sale, do they stack
   (sum), does only the best-value one win, or is there an explicit priority order? (No
   priority/stacking field exists today; the stub just takes the first match.)
2. **Auto-apply strength.** For `AUTOMATIC` promos: must they ALWAYS apply when eligible,
   or can the seller remove/override an auto-applied promo? What happens on conflict with
   a manual free-form discount the seller already set?
3. **Application granularity.** Do promotions apply per line item, per product, per category,
   or to the whole cart total? (PRODUCT_DISCOUNT is per-line; ORDER_DISCOUNT is cart-level;
   the sale model only supports per-line discounts today.)
4. **Price-list interaction.** Does a promotion apply on TOP of the price-list price, or is
   it mutually exclusive? (Today `overrideItemPrice` wipes discounts — is that the intended
   rule for promos too?) And does a promo's `priceLists[]` restriction mean "only eligible
   when the sale/customer uses that list"?
5. **Audit requirement.** Does the business need to record WHICH promotion was applied to a
   sale/line (for reporting, reversal, or dispute)? If yes, we must add a `promotionId`
   link (schema migration).
6. **Recompute on edit.** If the seller edits the cart (add/remove/qty) after a promo
   applied, must auto-promos recompute automatically? At which lifecycle points
   (addItem, quantity change, customer change, charge)?
7. **Usage limits / caps.** Are there per-promotion usage caps — global (N total uses) or
   per-customer (once per customer)? (No such field exists; would need schema + counter.)
8. **Rounding & tax ordering.** Does the discount apply before or after tax? How is rounding
   handled (the stub uses `Math.round`, cents)? Is there tax at all in this POS model?
   (Current totals are tax-agnostic — no tax field on Sale/SaleItem.)
9. **customerScope enforcement in POS.** REGISTERED_ONLY / SPECIFIC require a customer on
   the draft. Does a promo silently not apply if no customer is assigned, or is it surfaced
   as "assign a customer to unlock this promo"?
10. **BUY_X_GET_Y / ADVANCED semantics in POS.** How is the "get" line represented — a
    discounted extra line, a modified existing line, or a synthetic bonus item? These types
    are entirely unhandled today.
11. **Scope of THIS change.** Given the stub only covers PRODUCT_DISCOUNT/PRODUCTS/AUTOMATIC:
    is the goal to ship a first slice (auto PRODUCT_DISCOUNT on POS drafts with audit) and
    defer the harder types, or to build the full engine now?

---

## Candidate Approaches (high level — do NOT commit; design phase decides)

### Approach A — Promotion engine as a domain/application service invoked during sale draft mutation (synchronous, inline)

Wire `PromotionsModule` into `SalesModule`; extend the evaluation use-case into a real
POS promotion engine; invoke it inside `SalesService` on draft changes (e.g. after
`addItem`, quantity/customer change, and/or at `chargeDraft`). Auto promos apply and persist
onto `SaleItem` (and a new applied-promotion audit record); manual promos exposed via a
new "applicable promotions" query + apply endpoint.

- **Pros:** Deterministic totals at charge time; immediate seller feedback; reuses existing
  per-line discount fields; fits the current synchronous, tenant-scoped `SalesService`
  orchestration; totals already recomputed from item state at charge.
- **Cons:** Requires a substantial engine (eligibility across dates/days/scope/lists/types);
  recompute-on-edit adds complexity; risk of coupling Sales↔Promotions; must decide stacking
  and audit-schema migration up front.
- **Effort:** Medium-High (High if all 4 types + full conditions in one slice).

### Approach B — Event-driven / post-hoc application

Apply promotions reactively (e.g. on a `sale.item.added` / `sale.confirmed` event via the
existing EventEmitter2 + outbox), recomputing discounts asynchronously.

- **Pros:** Looser coupling; leans on the existing event/outbox infrastructure.
- **Cons:** Eventual consistency is wrong for POS pricing — the seller needs the correct
  total BEFORE charging; async recompute races with `chargeDraft`'s inline total math;
  much harder to reason about "what will the customer pay". Poor fit for a cashier flow.
- **Effort:** Medium, but high correctness risk.

> Leaning signal (for design, not a decision): the POS flow is synchronous and totals are
> computed inline at charge — Approach A aligns with the codebase; B fights it. Consider a
> hybrid: synchronous eligibility/apply for the draft (A), while keeping domain events for
> audit/telemetry only.

---

## Ready for Proposal

**Yes — with a required product-decision gate first.** The technical surface is well
understood and the persistence groundwork (per-line discount fields, tenant-scoped tx,
existing rule catalog + method enum) is already in place. But at least questions **1, 2, 5,
and 11** (stacking, auto-apply strength, audit link, and the scope/first-slice decision)
must be answered by the business owner before a proposal can bound the work. Recommend the
orchestrator surface those four questions to the user, then proceed to `propose`.
