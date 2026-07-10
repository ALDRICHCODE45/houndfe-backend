# Delta for sales

> This spec ADDS new requirements to the existing `sales` capability.
> Existing requirements (Bot Sale Registration, Bot Sale Event Emission,
> Bot Sale Idempotency, Canceled Sales Queryability, Stock Decrement
> Returns Threshold Crossings, Sales Orchestrator Dispatches Low-Stock
> Alerts) are unchanged. The new requirements below govern promotion
> recompute triggers, chargeDraft totals consistency with `getSaleDetail`,
> price-list override interaction with promo discounts, manual apply/remove
> endpoints for MANUAL promotions, and the auto-promo remove endpoint that
> feeds the per-draft veto set.

## ADDED Requirements

### Requirement: Draft Mutations Trigger Recompute

The system MUST trigger a recompute of all eligible AUTOMATIC promotions on every draft mutation that can change eligibility or totals: `addItem`, `updateItemQuantity`, `removeItem`, `assignCustomer`, `overrideItemPrice`, `applyItemDiscount` (manual), and `removeItemDiscount` (manual). The recompute MUST run inside the same call as the mutation (no async, no deferred job). The recompute MUST be idempotent: running it twice in a row with no state change MUST yield the same applied list and totals.

#### Scenario: addItem triggers recompute
- GIVEN an open draft with one line and an eligible AUTOMATIC `PRODUCT_DISCOUNT` (10%)
- WHEN `addItem` adds a new matching line
- THEN the response totals reflect the promo applied to BOTH lines

#### Scenario: updateItemQuantity triggers recompute
- GIVEN a line priced at 1000c, qty=1, and an AUTOMATIC 10% `PRODUCT_DISCOUNT`
- WHEN `updateItemQuantity` changes qty to 3
- THEN the line-level discount and totals reflect 10% on the new qty

#### Scenario: assignCustomer triggers recompute
- GIVEN a draft with no customer, with both ALL-scope and REGISTERED_ONLY-scope promotions eligible
- WHEN `assignCustomer` is called
- THEN the REGISTERED_ONLY-scope promo (if best-wins) is now applied to the recomputed totals

#### Scenario: removeItem triggers recompute
- GIVEN a draft with two lines and an `ORDER_DISCOUNT` min-purchase gate that depended on both lines' subtotal
- WHEN `removeItem` removes one line
- THEN the recompute re-evaluates the `ORDER_DISCOUNT` gate against the new subtotal

#### Scenario: Recompute is idempotent
- GIVEN a draft in any state
- WHEN two recomputes run back-to-back with no mutations between
- THEN the applied list and totals are identical

### Requirement: chargeDraft Totals Consistent With getSaleDetail

The system MUST compute `chargeDraft` totals from the current item state (post-recompute) such that the totals persisted on confirmation equal the totals returned by `getSaleDetail` immediately before charge. Any recompute MUST run before `chargeDraft` validates totals so the charged amount reflects the current applied promotions.

#### Scenario: chargeDraft totals match getSaleDetail
- GIVEN a draft with one line priced at 1000c, qty=1, and an eligible AUTOMATIC `PRODUCT_DISCOUNT` 10%
- WHEN `getSaleDetail` is called and then `chargeDraft` runs immediately
- THEN the persisted sale's totals equal the `getSaleDetail` totals (line discount 100c, subtotal 1000c, total 900c)

#### Scenario: Recompute before chargeDraft picks up new state
- GIVEN a draft with a line priced at 1000c, qty=1, and an eligible AUTOMATIC `PRODUCT_DISCOUNT` 10% applied
- WHEN the seller updates the line qty to 3 and then calls `chargeDraft`
- THEN the charged totals reflect the recomputed state (10% applied to the new qty)

### Requirement: Price-List Override Re-Runs Recompute Without Wiping Promo Discounts

The system MUST, on `overrideItemPrice`, re-run the recompute for the affected line and MUST NOT clear that line's existing promotion-driven discount fields. If an automatic promotion still best-wins on the new effective price, the line retains the promotion-driven discount on top of the new price. A seller manual free-form discount is removed only by an explicit `removeItemDiscount` call, NOT by `overrideItemPrice`.

#### Scenario: Price-list override re-applies auto-promo on the new price
- GIVEN a draft with one line, no current discount, default price 1000c, and an AUTOMATIC 10% `PRODUCT_DISCOUNT` on that product
- WHEN `overrideItemPrice` sets the line's price-list price to 2000c
- THEN the recompute runs and the line ends at 1800c (10% off 2000c)

#### Scenario: Price-list override preserves an already-applied auto-promo on the new price
- GIVEN a draft with one line priced at 1000c with an applied AUTOMATIC 10% `PRODUCT_DISCOUNT` (unit = 900c)
- WHEN `overrideItemPrice` changes the line to a new price-list price of 2000c
- THEN the recompute runs and the line ends at 1800c (10% off the new 2000c) — NOT at 2000c

#### Scenario: Price-list override does NOT clear a manual free-form discount
- GIVEN a draft with one line and a seller manual 100c discount applied (unit = 900c from a 1000c baseline)
- WHEN `overrideItemPrice` sets the line's price-list price to 2000c
- THEN the manual 100c discount is preserved (the operator must call `removeItemDiscount` explicitly to clear it)

### Requirement: Manual Apply And Remove Endpoints For MANUAL Promotions

The system MUST expose endpoints to list applicable MANUAL promotions for a draft, apply a MANUAL promotion (records it on the draft so future recomputes include it), and remove a MANUAL promotion. The apply/remove actions update the per-draft applied-promotion set; they MUST NOT mutate the promotion catalog.

#### Scenario: List applicable MANUAL promotions
- GIVEN a draft with two lines, each matching a different MANUAL `PRODUCT_DISCOUNT` (10% and 20%)
- WHEN the seller requests the list of applicable MANUAL promotions
- THEN the response includes both promotions with their computed per-line discount values

#### Scenario: Apply MANUAL promotion
- GIVEN a draft with one line and one eligible MANUAL `PRODUCT_DISCOUNT` P-M (10%)
- WHEN the seller applies P-M
- THEN the line ends at 90% of its baseline and subsequent recomputes keep P-M applied (subject to eligibility re-evaluation)

#### Scenario: Remove MANUAL promotion
- GIVEN P-M applied on the draft
- WHEN the seller removes P-M
- THEN the line returns to its baseline (no discount) and the P-M record is no longer on the draft

### Requirement: Remove Endpoint For AUTOMATIC Promotions Feeds The Veto Set

The system MUST expose an endpoint to remove an auto-applied AUTOMATIC promotion from a draft. Calling that endpoint MUST add the promotion's id to the draft's veto set so subsequent recomputes do not re-apply it. The endpoint MUST NOT mutate the promotion catalog.

#### Scenario: Removing an auto-applied AUTOMATIC promo adds to veto set
- GIVEN a draft with one line, an eligible AUTOMATIC `PRODUCT_DISCOUNT` P-A (10%) auto-applied
- WHEN the seller calls the remove endpoint for P-A
- THEN P-A is no longer applied, P-A is in the draft's veto set, and a subsequent recompute does NOT re-apply P-A

#### Scenario: Removing an auto-applied AUTOMATIC promo does NOT mutate the catalog
- GIVEN a draft with an auto-applied AUTOMATIC promo P-A
- WHEN the seller calls the remove endpoint for P-A
- THEN `Promotion.status`, `Promotion.method`, and any other catalog fields on P-A are unchanged