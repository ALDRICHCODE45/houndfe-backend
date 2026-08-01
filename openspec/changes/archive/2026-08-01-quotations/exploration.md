## Exploration: Customer Quotations (Cotizaciones)

### Current State

The system is a NestJS + TypeScript + Prisma + PostgreSQL multi-tenant POS/ERP backend using Hexagonal/DDD architecture. Sales are managed as a rich bounded context at `src/sales/` with a domain entity (`Sale`, `SaleItem`), repository interface (`ISaleRepository`), Prisma adapter, and multiple controllers for draft management, catalog search, payments, and queries. The `SalesService` orchestrates the entire lifecycle.

**Key architectural patterns in use:**
- Domain entities with static `create()`/`fromPersistence()` factories
- Symbol-based injection tokens for repository and use-case ports (e.g., `SALE_REPOSITORY`, `POS_EVALUATE_PROMOTIONS_USE_CASE`)
- Promotions engine is a separate bounded context (`src/promotions/`) integrated via a port interface — `recomputePricingAndPromotions()` is called after every draft mutation
- Price lists are global (`GlobalPriceList`) with per-product `PriceList` rows and optional quantity-based `TierPrice`
- PDF generation is a cross-cutting module using `@react-pdf/renderer` with a template registry pattern
- Email is provided by a `MAILER` port backed by Resend SDK

**No existing quotation concept** was found anywhere in the codebase — confirmed via grep for "quotation" and "cotizacion".

### Affected Areas

#### Sales Module (`src/sales/`)
- **`src/sales/domain/sale.entity.ts`** — The Sale aggregate root (DRAFT→CONFIRMED→CANCELED lifecycle) and its item management, discount, and promotion logic. A quotation would mirror ~80% of this structure but with a different lifecycle (QUOTATION→SENT→EXPIRED→CONVERTED_TO_SALE). Key fields to replicate: `items[]`, `customerId`, `globalPriceListId`, `subtotalCents`, `totalCents`, `discountCents`, and promotion-related columns.
- **`src/sales/domain/sale-item.entity.ts`** — SaleItem with product/variant binding, quantity, tier-aware pricing, discount/promotion tracking, price override logic. Almost identical shape needed for quotation items.
- **`src/sales/sales.service.ts`** (3035 lines) — The orchestration layer: `openDraft`, `addItem`, `updateItemQuantity`, `removeItem`, `overrideItemPrice`, `applyItemDiscount`, `assignCustomer`, `setSalePriceList`, and the promotion recompute pipeline. A quotation service would reuse similar patterns.
- **`src/sales/sales.controller.ts`** — Route conventions: `POST /sales/drafts`, `POST /sales/drafts/:id/items`, `PUT /sales/drafts/:id/customer`, `PUT /sales/drafts/:id/price-list`, etc. Quotation routes would follow the same pattern (`POST /quotations/drafts`, etc.).
- **`src/sales/infrastructure/prisma-sale.repository.ts`** — Persistence adapter. A parallel `PrismaQuotationRepository` would be needed.
- **`src/sales/dto/`** — DTOs like `AddItemDto`, `ChargeSaleDto`, `SetPriceListDto`, `AssignCustomerDto`, `ApplyManualPromotionDto`. Many will be reusable or need quotation-specific variants.

#### Prisma Schema (`prisma/schema.prisma`)
- **`Sale` model (lines 662-724)** — Has `customerId`, `sellerUserId`, `status` (DRAFT/CONFIRMED/CANCELED), `globalPriceListId`, `dueDate`, promotion junction tables (`sale_promotion_applied`, `sale_promotion_vetoes`, `sale_promotion_opt_ins`). A new `Quotation` model would be needed.
- **`SaleItem` model (lines 731-782)** — Has `productId`, `variantId`, `quantity`, `unitPriceCents`, `priceSource`, discount fields, `promotionId`. A new `QuotationItem` model would be needed.
- **`Customer` model (lines 1024-1066)** — **Email field already exists** (`email: String?`), as does `globalPriceListId` for auto-seeding price lists. No schema change needed.
- **`SalePromotionApplied`/`Veto`/`OptIn`** — Junction tables for sale↔promotion. Equivalent junction tables would be needed for quotations.

#### PDF Generation (`src/pdf-generation/`)
- **`src/pdf-generation/pdf-generation.service.ts`** — Uses `@react-pdf/renderer`, template registry, `renderToStream`. Currently only supports `receipt-a4` and `receipt-ticket` formats via `GET /sales/:id/pdf`.
- **`src/pdf-generation/templates/registry.ts`** — Maps `FormatKey` → React component. A new `quotation-*` format key and template would be added.
- **`src/pdf-generation/pdf-generation.module.ts`** — Currently depends on `SalesModule` to inject `SalesService`. Would need minimal changes.

#### Email Infrastructure (`src/notifications/email/`)
- **`src/notifications/email/mailer.port.ts`** — `IMailer` interface with `send({ to, subject, html })`. Already production-ready.
- **`src/notifications/email/resend.mailer.ts`** — Resend SDK adapter. Production and dev-logger modes.
- **`src/notifications/email/mailer.module.ts`** — Exports `MAILER` injection token. Can be imported by a quotation module directly.
- **`@react-email/components`** (`package.json`) — Already installed. Can render HTML email templates.

#### Price Lists (`src/price-lists/`)
- **`src/price-lists/price-lists.service.ts`** — CRUD for `GlobalPriceList`. The sale draft already auto-seeds from `Customer.globalPriceListId` via `assignCustomer`. Same pattern needed for quotations.

#### Promotions (`src/promotions/`)
- **`src/promotions/application/pos-evaluate-promotions.use-case.ts`** — The promotion engine. Would need to accept quotation cart input in addition to sale cart input, OR we reuse the same engine by passing a quotation-shaped cart that mimics the sale input shape.
- **`src/promotions/application/ports/pos-evaluate-promotions.port.ts`** — Port interface. May need a new `evaluateForQuotation` method or the same port can be reused if the input shape is compatible.

### Approaches

#### 1. **Extend Sale with `type` discriminator + new statuses**

Add a `SaleType` enum (`SALE | QUOTATION`) and `QuotationStatus` lifecycle to the existing `Sale` model. Quotations would live in the same table with a `type: 'QUOTATION'` discriminator.

- **Pros**: DRY — no new tables, model, entities, repositories, controllers. Everything reuses the sale machinery directly. Minimal migration.
- **Cons**: Pollutes the Sale domain. Sale and Quotation have fundamentally different lifecycles (charge/payment vs. send/expire). Future divergences become painful. The Sale table already has `paidCents`, `paymentStatus`, `folio` — fields irrelevant to quotations. Testing complexity increases.
- **Effort**: Low (short-term), High (long-term maintenance cost)

#### 2. **New Quotation bounded context (recommended)**

Create a new `src/quotations/` module with its own domain entity, repository, service, and controllers. The data model mirrors Sale structurally but is independent: `Quotation` (status: `DRAFT → SENT → EXPIRED → CONVERTED_TO_SALE → CANCELLED`), `QuotationItem`, `QuotationPromotionApplied/Veto/OptIn`.

- **Pros**: Clean separation of concerns. Independent lifecycle management. Can diverge from Sale without breaking it. The Sale domain stays pristine. Test isolation. Reusable patterns (same hexagonal structure, same DTO shapes where applicable). The PDF generation module is already architected for extension — the controller comment explicitly calls out "quotations" as a future use case.
- **Cons**: More initial boilerplate (~8-10 new files: entity, repository interface, Prisma adapter, service, controller, module, DTOs, Prisma schema models). Some logic duplication from SalesService (item management, price list resolution). Promotions engine needs a second evaluation path or input adapter.
- **Effort**: Medium-High

#### 3. **Thin wrapper over Sales with conversion**

Create a `QuotationService` that internally delegates to `SalesService` for draft operations (add item, assign customer, set price list) but adds quotation-specific behavior (expiry, PDF, email, conversion to Sale) as a wrapper layer.

- **Pros**: Less duplication than Option 2. Can reuse SalesService wholesale for draft management.
- **Cons**: Tight coupling to SalesService internals. The "DRAFT sale" concept is overloaded (a quotation draft is NOT a sale draft). The promotions engine is triggered by sale mutations — would fire on quotation mutations too unless we add conditionals. The `ChargeSaleDto` and payment flow don't apply to quotations.
- **Effort**: Medium

### Recommendation

**Approach 2: New Quotation bounded context.**

This aligns with the existing hexagonal/DDD architecture where each domain concept gets its own bounded context. The codebase already demonstrates clean separation between Sales, Products, Customers, Promotions, and Price Lists. A Quotation is conceptually distinct from a Sale — it's a pre-sale document with its own lifecycle.

The PDF generation module was explicitly designed for extension ("Future endpoints: invoice, quote, report will land here too"). The email infrastructure is already production-ready with a clean port/adapter pattern. The promotions engine architecture supports a second evaluation path via the same port interface.

Duplication of item management logic can be mitigated by extracting shared price-resolution and cart-management utilities into the Products service (which already handles `batchResolvePriceMap`, `getProductInfoForSale`).

### Risks

- **Promotions engine compatibility**: The `PosEvalInput` is currently sale-shaped. The engine may need minor adaptation to accept quotation cart inputs with the same shape but different context. Risk: Medium.
- **Data model divergence**: If quotations and sales diverge significantly over time (which they naturally will), a shared table approach becomes a migration nightmare. Independent models avoid this. Risk: Low (with Option 2).
- **Stock reservation**: If a quotation should reserve stock, the inventory system needs awareness of quotation items. This is NOT in the feature brief but is a common future requirement in ERP systems. Risk: Low (not in scope).
- **Conversion to Sale**: Converting a quotation to a sale is the most complex operation — it must create a new Sale entity from the quotation data, potentially re-validating prices and promotions at conversion time since prices/stock may have changed. Risk: High — needs careful design.
- **Price at conversion time vs. quotation time**: When converting a quotation to a sale, the prices might have changed. The design must decide: honor original quotation prices, or reprice at conversion time. Risk: Medium — will need explicit user/cashier workflow decision.

### Ready for Proposal

**Yes** — the codebase is well understood, all dependencies are characterized, and a clear architectural approach exists. Proceed to `sdd-propose` for the `quotations` change.
