# Delta for Sales

## Scope Boundary

This delta covers only draft item mutation operations and draft sale deletion protection for non-DRAFT lifecycles (including `CONFIRMED` and `CANCELED`). Concurrency control and stale-write prevention, refunds and refund-settlement semantics, analytics and reports, schema migrations, and historical-data repair are explicitly out of scope.

## ADDED Requirements

### Requirement: Draft Item Mutation Operations Reject Non-DRAFT Lifecycles

The system MUST reject every draft item mutation operation (`addItem`, `updateItemQuantity`, `clearItems`, and `removeItem`) whenever the target sale's lifecycle status is not `DRAFT`. The system MUST extend this rejection to both `CONFIRMED` and `CANCELED` lifecycles. The rejection MUST precede any destructive persistence: no sale field, item row, item identity, item content, or related record may change as a result of the rejected operation, and the operation MUST NOT emit a mutation success event. The rejection MUST NOT weaken existing ownership checks, tenant isolation, missing-sale contracts, or DRAFT-only validation rules.

#### Scenario: addItem rejected for CONFIRMED sale

- GIVEN a sale in `CONFIRMED` lifecycle owned by the calling tenant
- WHEN `addItem` is invoked against that sale with valid item data
- THEN the operation is rejected by a business-rule failure that follows existing error conventions
- AND no sale field is changed
- AND no item row is added or replaced
- AND no related record (folio, stock decrement, outbox event, payment) is mutated
- AND no addItem success event is emitted

#### Scenario: addItem rejected for CANCELED sale

- GIVEN a sale in `CANCELED` lifecycle owned by the calling tenant
- WHEN `addItem` is invoked against that sale with valid item data
- THEN the operation is rejected by a business-rule failure that follows existing error conventions
- AND no sale field is changed
- AND no item row is added or replaced
- AND no related record (folio, stock decrement, outbox event, payment) is mutated
- AND no addItem success event is emitted

#### Scenario: updateItemQuantity rejected for CONFIRMED sale

- GIVEN a sale in `CONFIRMED` lifecycle with an existing item
- WHEN `updateItemQuantity` is invoked for that item with a valid quantity
- THEN the operation is rejected by a business-rule failure that follows existing error conventions
- AND the target item identity, content, and quantity are unchanged
- AND no related record is mutated
- AND no updateItemQuantity success event is emitted

#### Scenario: updateItemQuantity rejected for CANCELED sale

- GIVEN a sale in `CANCELED` lifecycle with an existing item
- WHEN `updateItemQuantity` is invoked for that item with a valid quantity
- THEN the operation is rejected by a business-rule failure that follows existing error conventions
- AND the target item identity, content, and quantity are unchanged
- AND no related record is mutated
- AND no updateItemQuantity success event is emitted

#### Scenario: clearItems rejected for CONFIRMED sale with items

- GIVEN a sale in `CONFIRMED` lifecycle with one or more items
- WHEN `clearItems` is invoked against that sale
- THEN the operation is rejected by a business-rule failure that follows existing error conventions
- AND every existing item row for the sale is unchanged
- AND no related record is mutated
- AND no clearItems success event is emitted

#### Scenario: clearItems rejected for CANCELED sale

- GIVEN a sale in `CANCELED` lifecycle with one or more items
- WHEN `clearItems` is invoked against that sale
- THEN the operation is rejected by a business-rule failure that follows existing error conventions
- AND every item row remains in its prior state
- AND no clearItems success event is emitted

#### Scenario: removeItem rejected for CONFIRMED sale

- GIVEN a sale in `CONFIRMED` lifecycle with at least one item
- WHEN `removeItem` is invoked for one of its items
- THEN the operation is rejected by a business-rule failure that follows existing error conventions
- AND the targeted item row is unchanged
- AND no related record is mutated
- AND no removeItem success event is emitted

#### Scenario: removeItem rejected for CANCELED sale

- GIVEN a sale in `CANCELED` lifecycle with at least one item
- WHEN `removeItem` is invoked for one of its items
- THEN the operation is rejected by a business-rule failure that follows existing error conventions
- AND the targeted item row is unchanged
- AND no related record is mutated
- AND no removeItem success event is emitted

### Requirement: Draft Sale Deletion Rejects Non-DRAFT Lifecycles

The system MUST reject `deleteDraft` whenever the target sale's lifecycle status is not `DRAFT`. The system MUST extend this rejection to both `CONFIRMED` and `CANCELED` lifecycles. The rejection MUST precede destructive sale deletion: the sale row, its items, and any related record MUST remain in their prior state, and no deletion success event may be emitted. The rejection MUST NOT weaken ownership, tenant isolation, or missing-sale contracts.

#### Scenario: deleteDraft rejected for CONFIRMED sale

- GIVEN a sale in `CONFIRMED` lifecycle owned by the calling tenant
- WHEN `deleteDraft` is invoked against that sale
- THEN the operation is rejected by a business-rule failure that follows existing error conventions
- AND the sale row is unchanged
- AND every item row for the sale is unchanged
- AND no related record (folio, stock, outbox, payment, timeline) is mutated
- AND no deleteDraft success event is emitted

#### Scenario: deleteDraft rejected for CANCELED sale

- GIVEN a sale in `CANCELED` lifecycle owned by the calling tenant
- WHEN `deleteDraft` is invoked against that sale
- THEN the operation is rejected by a business-rule failure that follows existing error conventions
- AND the sale row, its items, and related records are unchanged
- AND no deleteDraft success event is emitted

### Requirement: Empty Non-DRAFT Clear Is Rejected, Not Treated As A Success

The system MUST treat a `clearItems` request against a non-DRAFT sale as a rejection even when the sale currently has zero items. An empty non-DRAFT sale MUST NOT be returned as a successful no-op by the clear path. The rejection MUST preserve the existing item list and item identities unchanged from before the call.

#### Scenario: clearItems on empty CONFIRMED sale is rejected

- GIVEN a sale in `CONFIRMED` lifecycle with zero items
- WHEN `clearItems` is invoked against that sale
- THEN the operation is rejected by a business-rule failure that follows existing error conventions
- AND the empty item list is unchanged
- AND no clearItems success event is emitted

#### Scenario: clearItems on empty CANCELED sale is rejected

- GIVEN a sale in `CANCELED` lifecycle with zero items
- WHEN `clearItems` is invoked against that sale
- THEN the operation is rejected by a business-rule failure that follows existing error conventions
- AND the empty item list is unchanged
- AND no clearItems success event is emitted

### Requirement: Lifecycle Eligibility Precedes Destructive Persistence

The system MUST evaluate lifecycle eligibility for every draft item mutation and every draft sale deletion before any destructive persistence step on the relevant shared domain or repository entry path. The same protection MUST apply on any shared persistence entry point that could otherwise replace the sale's items or remove the sale itself while bypassing the lifecycle check. Legitimate non-DRAFT persistence paths (confirmation, cancellation, payment recording, delivery updates, and other existing lifecycle transitions) MUST NOT be blocked by this protection; only prohibited draft item writes and draft deletions are scoped into the protection.

#### Scenario: Guard precedes item replacement on shared persistence path

- GIVEN a non-DRAFT sale and any shared item-replacement persistence path that could be reached from a draft item mutation
- WHEN the path is invoked for that sale as part of a draft item mutation
- THEN the lifecycle eligibility check rejects the operation before any item row is deleted or recreated
- AND the prior item rows remain in place

#### Scenario: Guard precedes sale deletion on shared persistence path

- GIVEN a non-DRAFT sale and any shared deletion persistence path that could be reached from `deleteDraft`
- WHEN the path is invoked for that sale as part of a draft deletion
- THEN the lifecycle eligibility check rejects the operation before any sale or item row is deleted
- AND the prior sale row and its items remain in place

#### Scenario: Legitimate non-DRAFT persistence path remains unblocked

- GIVEN a sale in a non-DRAFT lifecycle where the operation is legal under EXISTING lifecycle rules (for example, cancellation or payment recording against a `CONFIRMED` sale)
- WHEN a legitimate lifecycle transition persists state through any shared entry point
- THEN the persistence succeeds without invoking the draft-only rejection
- AND no new rejection is introduced for any operation that is legal under the existing lifecycle rules

### Requirement: Valid DRAFT Behavior And Authorization Contracts Preserved

The system MUST continue to accept draft item mutations and draft sale deletion when the target sale is in `DRAFT` lifecycle. The system MUST continue to enforce ownership, tenant isolation, and existing missing-sale behavior on every draft item mutation and `deleteDraft` call, regardless of the lifecycle outcome. The system MUST continue to permit legitimate confirmation, cancellation, payment, and other existing lifecycle workflows without modification. The lifecycle guard introduced by this delta MUST NOT change the persistence contract for any operation outside the scoped draft item mutations and `deleteDraft`.

#### Scenario: Valid DRAFT addItem still accepted

- GIVEN a sale in `DRAFT` lifecycle owned by the calling tenant
- WHEN `addItem` is invoked with valid item data
- THEN the item is added and the existing validation, pricing, and promotion-recompute behavior applies

#### Scenario: Valid DRAFT updateItemQuantity still accepted

- GIVEN a sale in `DRAFT` lifecycle owned by the calling tenant, with an existing item
- WHEN `updateItemQuantity` is invoked with a valid quantity
- THEN the quantity is updated and the existing recompute behavior applies

#### Scenario: Valid DRAFT clearItems (including empty) still accepted

- GIVEN a sale in `DRAFT` lifecycle owned by the calling tenant
- WHEN `clearItems` is invoked (whether or not the draft currently has items)
- THEN the items are removed and the existing empty-clear contract is preserved

#### Scenario: Valid DRAFT removeItem still accepted

- GIVEN a sale in `DRAFT` lifecycle owned by the calling tenant, with an existing item
- WHEN `removeItem` is invoked for that item
- THEN the item is removed and the existing recompute behavior applies

#### Scenario: Valid DRAFT deleteDraft still accepted

- GIVEN a sale in `DRAFT` lifecycle owned by the calling tenant
- WHEN `deleteDraft` is invoked
- THEN the sale and its items are removed through the existing deletion path

#### Scenario: Valid DRAFT item stacking still accepted

- GIVEN a sale in `DRAFT` lifecycle owned by the calling tenant, with an existing line for a product
- WHEN `addItem` is invoked with another line for the same product and variant
- THEN the operation follows the existing DRAFT item-stacking behavior without introducing a new line-merging or line-separation policy
- AND the existing rules for item identity, quantity, and promotion recomputation remain unchanged

#### Scenario: Valid DRAFT invalid quantity rejection preserved

- GIVEN a sale in `DRAFT` lifecycle owned by the calling tenant, with an existing item
- WHEN `updateItemQuantity` is invoked with a quantity that fails the existing quantity validation (for example, zero, negative, or otherwise out-of-range)
- THEN the operation is rejected by the existing quantity-validation failure
- AND the lifecycle guard does not change that outcome

#### Scenario: Same-tenant wrong-owner draft mutation still rejected

- GIVEN a sale owned by a different seller within the calling tenant
- WHEN `addItem`, `updateItemQuantity`, `clearItems`, `removeItem`, or `deleteDraft` is invoked (for any lifecycle)
- THEN the request is rejected by the existing ownership failure following existing error conventions
- AND the lifecycle guard does not change that outcome

#### Scenario: Cross-tenant draft mutation rejected without disclosure

- GIVEN a sale belonging to a different tenant
- WHEN `addItem`, `updateItemQuantity`, `clearItems`, `removeItem`, or `deleteDraft` is invoked
- THEN the request is rejected by the existing tenant-isolation failure following existing error conventions
- AND no information about the sale's existence, lifecycle status, items, or content is disclosed to the caller
- AND the lifecycle guard does not change that outcome

#### Scenario: Missing sale on draft mutation still rejected

- GIVEN no sale exists for the supplied identifier
- WHEN any draft item mutation or `deleteDraft` is invoked
- THEN the request is rejected by the existing missing-sale failure following existing error conventions
- AND the lifecycle guard does not change that outcome

#### Scenario: Legitimate charge confirmation flow remains unchanged

- GIVEN a valid `DRAFT` that satisfies the existing preconditions for charge confirmation
- WHEN the legitimate charge confirmation flow runs
- THEN the sale transitions to the non-DRAFT lifecycle through the existing path
- AND the lifecycle guard does not block this transition

#### Scenario: Legitimate cancellation and payment recording flows remain unchanged

- GIVEN a sale that satisfies all existing lifecycle, authorization, and business preconditions for the cancellation or payment recording operation being exercised
- WHEN a legitimate cancellation or payment recording flow persists state
- THEN the persistence succeeds through the existing path
- AND the lifecycle guard does not block these flows
