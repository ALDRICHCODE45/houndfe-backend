# Quotations Specification

## Purpose

Define the quotation lifecycle, domain rules, and API surfaces for the quotations bounded context. A quotation is a pre-sale priced document that sales reps build, send as PDF, and manage independently from sale/inventory/payment machinery.

## Requirements

### Requirement: Create DRAFT Quotation
**Status**: ADDED
**Priority**: P0

The system MUST allow creating a new DRAFT quotation for the authenticated tenant user. The quotation starts with status `DRAFT`, no items, no customer, no price list, and no expiry.

#### Scenario: Create quotation succeeds
- **GIVEN** an authenticated user in tenant T
- **WHEN** `POST /quotations/drafts` is called
- **THEN** a new `Quotation` is persisted with `status=DRAFT`, `tenantId=T`, `sellerUserId=<current user>`, and `id` returned

#### Scenario: Unauthenticated request is rejected
- **GIVEN** no valid auth token
- **WHEN** `POST /quotations/drafts` is called
- **THEN** the request is rejected with 401

---

### Requirement: Add Item to Quotation
**Status**: ADDED
**Priority**: P0

The system MUST allow adding a product/variant item to a DRAFT quotation. Price resolves through the quotation's current price list (or global default if no customer/price list assigned). After adding, the system MUST recompute promotions.

#### Scenario: Add item with price list price
- **GIVEN** a DRAFT quotation with customer assigned (globalPriceListId = PL1), and PL1 has price 1000c for product P1
- **WHEN** `POST /quotations/drafts/:id/items` with `{ productId: P1, variantId: null, quantity: 1 }`
- **THEN** a `QuotationItem` is created with `unitPriceCents=1000`, `priceSource=PRICE_LIST`, and promotions recompute runs

#### Scenario: Add item without customer uses global price list
- **GIVEN** a DRAFT quotation with no customer assigned
- **WHEN** `POST /quotations/drafts/:id/items` with `{ productId: P1, quantity: 1 }`
- **THEN** the item is added with the global default price list resolution and `priceSource=PRICE_LIST`

#### Scenario: Add item to non-DRAFT quotation is rejected
- **GIVEN** a quotation with `status=SENT`
- **WHEN** `POST /quotations/drafts/:id/items` is called
- **THEN** the request is rejected with 409

#### Scenario: Product not found is rejected
- **GIVEN** no product P-MISSING exists in tenant T
- **WHEN** `POST /quotations/drafts/:id/items` with `{ productId: P-MISSING, quantity: 1 }`
- **THEN** the request is rejected with 404

---

### Requirement: Update Item Quantity
**Status**: ADDED
**Priority**: P0

The system MUST allow updating the quantity of a quotation item in DRAFT status. After updating, the system MUST recompute promotions. Quantity MUST be >= 1.

#### Scenario: Update quantity triggers recompute
- **GIVEN** a DRAFT quotation with item I at qty=1, unit price 1000c, and an AUTOMATIC 10% promotion
- **WHEN** `PATCH /quotations/drafts/:id/items/:itemId` with `{ quantity: 3 }`
- **THEN** I.quantity becomes 3 and the promotion discount reflects the new qty

#### Scenario: Quantity zero is rejected
- **GIVEN** a DRAFT quotation with item I at qty=1
- **WHEN** `PATCH /quotations/drafts/:id/items/:itemId` with `{ quantity: 0 }`
- **THEN** the request is rejected with 400

---

### Requirement: Remove Item
**Status**: ADDED
**Priority**: P0

The system MUST allow removing an item from a DRAFT quotation. After removal, the system MUST recompute promotions.

#### Scenario: Remove item succeeds
- **GIVEN** a DRAFT quotation with two items
- **WHEN** `DELETE /quotations/drafts/:id/items/:itemId` is called for one item
- **THEN** the item is removed and promotions recompute runs on the remaining item

---

### Requirement: Override Item Price
**Status**: ADDED
**Priority**: P0

The system MUST allow overriding the unit price of a quotation item in DRAFT status. The override persists as `priceSource=CUSTOM`. The override MUST trigger a promotion recompute on the affected line. The override MUST NOT clear an existing promotion-driven discount.

#### Scenario: CUSTOM price override persists with promotion discount
- **GIVEN** a DRAFT quotation with item I at price-list price 1000c, and an AUTOMATIC 10% promotion applied (unit = 900c)
- **WHEN** `PATCH /quotations/drafts/:id/items/:itemId/price` with `{ unitPriceCents: 2000 }`
- **THEN** I.unitPriceCents becomes 2000, `priceSource=CUSTOM`, and recompute re-applies 10% (unit = 1800c)

#### Scenario: Override on non-DRAFT quotation is rejected
- **GIVEN** a quotation with `status=SENT`
- **WHEN** `PATCH /quotations/drafts/:id/items/:itemId/price` is called
- **THEN** the request is rejected with 409

---

### Requirement: Assign Customer
**Status**: ADDED
**Priority**: P0

The system MUST allow assigning a customer to a DRAFT quotation. If the customer has a `globalPriceListId`, the quotation's price list MUST auto-seed from it. Assigning a customer MUST trigger a promotion recompute (customer-scope gates may now open).

#### Scenario: Assign customer with price list auto-seeds
- **GIVEN** a DRAFT quotation with no customer and no price list, and customer C1 has `globalPriceListId=PL1`
- **WHEN** `PUT /quotations/drafts/:id/customer` with `{ customerId: C1 }`
- **THEN** quotation.customerId becomes C1, quotation.globalPriceListId becomes PL1, and promotions recompute runs

#### Scenario: Assign customer without price list
- **GIVEN** a DRAFT quotation and customer C2 with `globalPriceListId=null`
- **WHEN** `PUT /quotations/drafts/:id/customer` with `{ customerId: C2 }`
- **THEN** quotation.customerId becomes C2, price list stays null, and promotions recompute runs

---

### Requirement: Set Price List
**Status**: ADDED
**Priority**: P0

The system MUST allow overriding the quotation's price list independently of the customer. The override MUST trigger a full recompute: item prices refresh from the new price list (unless a CUSTOM override exists on the item).

#### Scenario: Set price list triggers recompute
- **GIVEN** a DRAFT quotation with items priced from PL1 at 1000c
- **WHEN** `PUT /quotations/drafts/:id/price-list` with `{ globalPriceListId: PL2 }` where PL2 has price 800c for the same items
- **THEN** item prices refresh to 800c (unless CUSTOM override exists) and promotions recompute runs

---

### Requirement: Apply and Remove Manual Promotion
**Status**: ADDED
**Priority**: P1

The system MUST expose endpoints to apply and remove MANUAL promotions on a DRAFT quotation, mirroring the Sale draft behavior. Applied MANUAL promotions persist across recomputes (subject to eligibility re-evaluation). The system MUST also expose the list of applicable MANUAL promotions.

#### Scenario: Apply MANUAL promotion
- **GIVEN** a DRAFT quotation with one line matching a MANUAL `PRODUCT_DISCOUNT` (10%)
- **WHEN** `PUT /quotations/drafts/:id/manual-promotions/:promoId` is called
- **THEN** the promotion is applied and recompute reflects it in totals

#### Scenario: Remove MANUAL promotion
- **GIVEN** a DRAFT quotation with an applied MANUAL promotion
- **WHEN** `DELETE /quotations/drafts/:id/manual-promotions/:promoId` is called
- **THEN** the promotion is removed from the applied set and recompute runs

#### Scenario: List applicable MANUAL promotions
- **GIVEN** a DRAFT quotation with items matching two MANUAL promotions
- **WHEN** `GET /quotations/drafts/:id/promotions/applicable` is called
- **THEN** the response includes both promotions with computed per-line discount values

---

### Requirement: Veto AUTOMATIC Promotion
**Status**: ADDED
**Priority**: P1

The system MUST expose an endpoint to remove an auto-applied AUTOMATIC promotion from a DRAFT quotation. The veto MUST persist across recomputes.

#### Scenario: Remove auto-promo adds to veto set
- **GIVEN** a DRAFT quotation with an AUTOMATIC promotion P-A auto-applied
- **WHEN** `DELETE /quotations/drafts/:id/promotions/:promoId` is called for P-A
- **THEN** P-A is removed and excluded from subsequent recomputes until manually re-applied

---

### Requirement: Set Expiry Date
**Status**: ADDED
**Priority**: P1

The system MUST allow setting an optional `expiresAt` timestamp on a DRAFT quotation. If set, the quotation MUST lazily transition to `EXPIRED` on any read past the expiry date. If null, the quotation never expires.

#### Scenario: Set expiry on DRAFT succeeds
- **GIVEN** a DRAFT quotation with no expiry
- **WHEN** `PATCH /quotations/drafts/:id` with `{ expiresAt: "2026-08-15T00:00:00Z" }`
- **THEN** quotation.expiresAt is set and the quotation is returned with the expiry field

#### Scenario: Lazy EXPIRED transition on read
- **GIVEN** a SENT quotation with `expiresAt = yesterday`
- **WHEN** `GET /quotations/:id` is called
- **THEN** the quotation status auto-transitions to `EXPIRED` before returning (idempotent on subsequent reads)

#### Scenario: No expiry means never expires
- **GIVEN** a SENT quotation with `expiresAt = null`
- **WHEN** `GET /quotations/:id` is called at any time
- **THEN** the quotation stays `SENT` (never auto-transitions to EXPIRED)

---

### Requirement: Cancel Quotation
**Status**: ADDED
**Priority**: P0

The system MUST allow cancelling a quotation in any non-terminal status (`DRAFT`, `SENT`, `EXPIRED`). The cancellation MUST include a `cancelReason`.

#### Scenario: Cancel DRAFT quotation
- **GIVEN** a DRAFT quotation
- **WHEN** `POST /quotations/drafts/:id/cancel` with `{ cancelReason: "CUSTOMER_REQUEST" }`
- **THEN** the quotation status becomes `CANCELLED` and `cancelReason` is persisted

#### Scenario: Cancel already CANCELLED is idempotent
- **GIVEN** a CANCELLED quotation
- **WHEN** `POST /quotations/drafts/:id/cancel` is called again
- **THEN** the request returns 200 with the existing CANCELLED quotation (idempotent)

---

### Requirement: List Quotations
**Status**: ADDED
**Priority**: P0

The system MUST expose an endpoint to list quotations for the current tenant, with optional filters by status, customerId, and date range. The response MUST be paginated and tenant-scoped.

#### Scenario: List all quotations for tenant
- **GIVEN** tenant T has 5 quotations (3 DRAFT, 2 SENT)
- **WHEN** `GET /quotations` is called
- **THEN** the response includes all 5 quotations in descending creation order, paginated

#### Scenario: Filter by status
- **GIVEN** tenant T has 3 DRAFT and 2 SENT quotations
- **WHEN** `GET /quotations?status=DRAFT` is called
- **THEN** only the 3 DRAFT quotations are returned

#### Scenario: Cross-tenant isolation
- **GIVEN** quotation Q1 belongs to tenant T1
- **WHEN** a user from tenant T2 calls `GET /quotations/:id` for Q1's id
- **THEN** the request returns 404

---

### Requirement: Get Quotation Detail
**Status**: ADDED
**Priority**: P0

The system MUST expose an endpoint to retrieve a single quotation by id with all items, promotions, customer, and totals. The response MUST include the quotation's current computed totals (post-recompute).

#### Scenario: Get quotation detail with items
- **GIVEN** a DRAFT quotation with 2 items and an applied promotion
- **WHEN** `GET /quotations/:id` is called
- **THEN** the response includes the quotation metadata, items with unit prices and discounts, applied promotions, and computed totals

#### Scenario: Get quotation triggers lazy expiry check
- **GIVEN** a SENT quotation with `expiresAt = yesterday`
- **WHEN** `GET /quotations/:id` is called
- **THEN** the quotation status is `EXPIRED` in the response

---

### Requirement: Promotion Recompute on Every Draft Mutation
**Status**: ADDED
**Priority**: P0

The system MUST trigger a recompute of all eligible AUTOMATIC promotions on every draft mutation: `addItem`, `updateItemQuantity`, `removeItem`, `assignCustomer`, `setPriceList`, `overrideItemPrice`, `applyManualPromotion`, `removeManualPromotion`. The recompute MUST use `context='QUOTATION'` when calling the promotion engine. The recompute MUST be idempotent.

#### Scenario: Recompute runs on addItem
- **GIVEN** a DRAFT quotation with one line and an AUTOMATIC 10% promotion
- **WHEN** `addItem` adds a new matching line
- **THEN** the response totals reflect the promotion applied to BOTH lines

#### Scenario: Recompute passes context=QUOTATION to engine
- **GIVEN** a DRAFT quotation with items and an AUTOMATIC promotion
- **WHEN** any draft mutation triggers recompute
- **THEN** `PosEvalInput.context` is `'QUOTATION'` and the engine produces identical results to `context='SALE'`

#### Scenario: Recompute is idempotent
- **GIVEN** a DRAFT quotation in any state
- **WHEN** two recomputes run back-to-back with no mutations between
- **THEN** the applied list and totals are identical

---

### Requirement: Tenant Scoping
**Status**: ADDED
**Priority**: P0

All quotation endpoints MUST be tenant-scoped via `TenantPrismaService`. Cross-tenant access MUST return 404. Quotation models MUST include `tenantId`.

#### Scenario: Cross-tenant quotation id returns 404
- **GIVEN** quotation Q1 belongs to tenant T1
- **WHEN** a user from tenant T2 accesses any quotation endpoint with Q1's id
- **THEN** the request returns 404 (not 403)

---

### Requirement: Price Source Tracking
**Status**: ADDED
**Priority**: P1

The system MUST track how each quotation item's price was determined: `PRICE_LIST` (default from customer's or global price list) or `CUSTOM` (manual override). The `priceSource` MUST be persisted per item.

#### Scenario: Price list item tracks PRICE_LIST
- **GIVEN** an item added with price resolved from the quotation's price list
- **WHEN** the item is persisted
- **THEN** `priceSource = PRICE_LIST`

#### Scenario: Overridden item tracks CUSTOM
- **GIVEN** an item whose price was overridden via `overrideItemPrice`
- **WHEN** the item is persisted after override
- **THEN** `priceSource = CUSTOM` and `unitPriceCents` matches the override

---

### Requirement: Stock Checks Bypassed
**Status**: ADDED
**Priority**: P1

The system MUST NOT check or enforce stock availability when adding or updating quotation items. The quotation is a pricing promise, not a stock reservation.

#### Scenario: Add item with zero stock succeeds
- **GIVEN** product P1 has `quantity = 0` in inventory
- **WHEN** `POST /quotations/drafts/:id/items` adds P1
- **THEN** the item is added successfully (no stock validation)

---

### Requirement: No Active Quotation Limit
**Status**: ADDED
**Priority**: P1

The system MUST NOT enforce any limit on the number of active (non-terminal) quotations per customer or per tenant.

#### Scenario: Create unlimited quotations for same customer
- **GIVEN** customer C1 already has 10 DRAFT quotations
- **WHEN** `POST /quotations/drafts` creates another quotation for C1
- **THEN** the quotation is created successfully (no limit enforced)
