# Delta for Sales

## ADDED Requirements

### Requirement: POS Sale Delivery Flag At Charge Time

The `ChargeSaleDto` SHALL accept an optional `delivery?: boolean`. The field SHALL be omitted-safe (no field, `undefined`, or `false` all reproduce today's behavior) and SHALL be validated by the DTO layer as a boolean when present. The field SHALL NOT add a new CASL action or permission; the existing `update:Sale` permission on the charge route SHALL continue to govern access.

#### Scenario: Delivery flag omitted reproduces today's behavior

- GIVEN a valid POS draft with non-null `shippingAddressId`
- WHEN the cashier calls `POST /sales/drafts/:id/charge` with no `delivery` field
- THEN the request is accepted
- AND the confirmed sale is persisted with the same `deliveryStatus` the draft had at charge time
- AND no `delivery` field is required at the DTO layer

#### Scenario: Delivery flag `true` is accepted at the DTO layer

- GIVEN a POS draft ready to charge
- WHEN the cashier calls `POST /sales/drafts/:id/charge` with `{ "delivery": true }`
- THEN the DTO layer accepts the payload
- AND service-layer business rules apply (address required; see other requirements)

#### Scenario: Delivery flag `false` is accepted and behaves like omission

- GIVEN a POS draft with non-null `shippingAddressId`
- WHEN the cashier calls `POST /sales/drafts/:id/charge` with `{ "delivery": false }`
- THEN the request is accepted
- AND the confirmed sale is persisted with the same `deliveryStatus` the draft had at charge time

#### Scenario: Non-boolean delivery value is rejected at the DTO layer

- GIVEN any POS draft
- WHEN the cashier calls `POST /sales/drafts/:id/charge` with `{ "delivery": "yes" }`
- THEN the request is rejected with a 400 class-validator error
- AND no business logic runs
- AND no persistence occurs

### Requirement: Delivery Flag With Shipping Address Confirms Sale As PENDING

When the charge request carries `delivery: true` AND the loaded draft has a non-null `shippingAddressId`, the confirmed sale SHALL persist `deliveryStatus: 'PENDING'` (overriding the draft's default `'DELIVERED'`), SHALL keep `channel: 'POS'` unchanged, and SHALL satisfy the existing `DeliveryRoute.create`/`addStop` eligibility check (`deliveryStatus ∈ {PENDING, SHIPPED}` AND non-null `shippingAddressId`). After confirmation, route check-in flips `PENDING → DELIVERED` via the existing `Sale.markDelivered()` path; this change SHALL NOT introduce any other transition out of `PENDING`.

#### Scenario: Flag true + non-null address persists PENDING and stays route-eligible

- GIVEN a POS draft in `DRAFT` state with non-null `shippingAddressId`
- WHEN the cashier charges the draft with `{ "delivery": true }` and the call succeeds
- THEN the persisted sale row has `deliveryStatus = 'PENDING'`
- AND the row has `channel = 'POS'`
- AND `DeliveryRoute.create` accepts the sale id (eligibility check passes)
- AND `DeliveryRoute.addStop` accepts the sale id (eligibility check passes)

#### Scenario: Route check-in still flips PENDING to DELIVERED

- GIVEN a POS sale confirmed as `deliveryStatus: 'PENDING'` by this feature
- WHEN the route check-in calls `Sale.markDelivered()`
- THEN the sale transitions to `deliveryStatus: 'DELIVERED'`
- AND no other transition out of `PENDING` is introduced by this change

### Requirement: Delivery Flag Without Shipping Address Is Rejected Before Persistence

When the charge request carries `delivery: true` AND the loaded draft has a null or absent `shippingAddressId`, the charge SHALL fail with a 422 business-rule error using a clear, dedicated error code (`SHIPPING_ADDRESS_REQUIRED_FOR_DELIVERY`), SHALL NOT call `persistChargeConfirmation`, and SHALL NOT mutate the draft row or any payment/outbox/folio/stock side effect.

#### Scenario: Flag true + null address fails with 422 and no persistence

- GIVEN a POS draft in `DRAFT` state with `shippingAddressId = null`
- WHEN the cashier charges the draft with `{ "delivery": true }`
- THEN the request is rejected with HTTP 422 and error code `SHIPPING_ADDRESS_REQUIRED_FOR_DELIVERY`
- AND `persistChargeConfirmation` is NOT called
- AND no folio is allocated
- AND no stock is decremented
- AND no outbox event is written
- AND the draft row is unchanged

#### Scenario: Flag true + address field absent behaves like null

- GIVEN a POS draft with no `shippingAddressId` column value at all (treated as null)
- WHEN the cashier charges the draft with `{ "delivery": true }`
- THEN the request is rejected with HTTP 422 and error code `SHIPPING_ADDRESS_REQUIRED_FOR_DELIVERY`
- AND `persistChargeConfirmation` is NOT called

### Requirement: Omitted Or False Delivery Flag Preserves Today Behavior Exactly

When `delivery` is omitted, `undefined`, or `false`, the charge path SHALL produce a confirmed sale whose `deliveryStatus` equals whatever the draft carried at the moment of charge (today: `'DELIVERED'`, inherited from `Sale.create` and `PrismaSaleRepository.save`). The flag SHALL NOT cause any change to the persisted `channel`, the existing `chargeDraft` totals invariants, or any other side effect of the charge path.

#### Scenario: Omitted flag reproduces today's DELIVERED outcome

- GIVEN a POS draft whose `deliveryStatus = 'DELIVERED'` at the moment of charge (today's seeded default)
- WHEN the cashier charges the draft with no `delivery` field
- THEN the confirmed sale row has `deliveryStatus = 'DELIVERED'`
- AND `channel = 'POS'`
- AND the sale is NOT eligible for `DeliveryRoute.create`/`addStop` (today's outcome)

#### Scenario: Explicit `false` flag reproduces today's DELIVERED outcome

- GIVEN the same preconditions as the omitted-flag scenario
- WHEN the cashier charges the draft with `{ "delivery": false }`
- THEN the confirmed sale row has `deliveryStatus = 'DELIVERED'`
- AND the sale is NOT eligible for `DeliveryRoute.create`/`addStop`

### Requirement: Charge Idempotency Hash Includes Delivery Flag

The charge `requestHash` SHALL include the `delivery` flag value (normalized: omitted/undefined → a sentinel equivalent to `false`). A retry with the same idempotency key but a changed `delivery` value SHALL NOT silently replay a stale non-delivery result: it MUST be treated as a payload mismatch and rejected with `IDEMPOTENCY_KEY_CONFLICT` (HTTP 409) following the same `requestHash` comparison discipline already established for the bot sale idempotency surface.

#### Scenario: Same key + same delivery value replays the cached result

- GIVEN a prior successful charge with key K, `delivery: true`, and persisted `deliveryStatus: 'PENDING'`
- WHEN the cashier retries the same request with key K and `delivery: true`
- THEN the cached response is returned
- AND no second charge confirmation runs

#### Scenario: Same key + flipped delivery returns IDEMPOTENCY_KEY_CONFLICT

- GIVEN a prior successful charge with key K, `delivery: true`, and a stored `requestHash` that includes `delivery: true`
- WHEN the cashier retries with key K and `delivery: false`
- THEN the request is rejected with `409 IDEMPOTENCY_KEY_CONFLICT`
- AND no second charge confirmation runs
- AND the original `deliveryStatus: 'PENDING'` row is NOT overwritten with `'DELIVERED'`

#### Scenario: Same key + omitted delivery after a delivered charge is rejected

- GIVEN a prior successful charge with key K, no `delivery` field, and `deliveryStatus: 'DELIVERED'`
- WHEN the cashier retries with key K and `{ "delivery": true }`
- THEN the request is rejected with `409 IDEMPOTENCY_KEY_CONFLICT`
- AND the original row is NOT flipped to `'PENDING'`

### Requirement: Charge Route Authorization Unchanged

The charge route SHALL continue to require only the existing `update:Sale` CASL permission. This change SHALL NOT introduce a new `AppActions` entry (e.g. no `deliver:Sale`, no `charge:Sale`), SHALL NOT add a registry/seed row, and SHALL NOT change `CaslAbilityFactory` wiring. A caller with `update:Sale` MAY set `delivery: true`; a caller without `update:Sale` SHALL still be rejected with the existing 403 path.

#### Scenario: Caller with update:Sale can flag a sale for delivery

- GIVEN a caller whose granted permissions include `update:Sale`
- WHEN the caller charges a draft with `{ "delivery": true }` and a non-null `shippingAddressId`
- THEN the request is authorized
- AND the sale is persisted as `PENDING`

#### Scenario: Caller without update:Sale cannot flag a sale for delivery

- GIVEN a caller whose granted permissions do NOT include `update:Sale`
- WHEN the caller calls `POST /sales/drafts/:id/charge` with `{ "delivery": true }`
- THEN the request is rejected by the existing permissions guard
- AND the flag value has no effect on the outcome

#### Scenario: No new CASL permission is added

- GIVEN the codebase at the time this delta is applied
- WHEN the registry, `AppActions`, the permission seeding list, and `CaslAbilityFactory` are inspected
- THEN no new entry referencing delivery or charge-by-flag is present

### Requirement: SHIPPED SHALL NOT Be Written For POS Sales

The `PENDING → SHIPPED` transition SHALL remain bot/ONLINE-only. The charge path for POS sales SHALL NOT write `deliveryStatus: 'SHIPPED'` directly. POS sales flagged for delivery SHALL remain `channel: 'POS'` after charge; the existing chatbot `setDeliveryMetadata` guard (which requires `channel === 'ONLINE'`) SHALL continue to reject any attempt to move a POS sale to `SHIPPED`.

#### Scenario: Charge path does not write SHIPPED for POS sales

- GIVEN any POS draft
- WHEN the charge path runs (with or without `delivery: true`)
- THEN the persisted `deliveryStatus` is one of `'PENDING'` or `'DELIVERED'`
- AND `'SHIPPED'` is NEVER written by this change

#### Scenario: Existing chatbot guard continues to reject SHIPPED on POS sales

- GIVEN a POS sale confirmed by this feature with `deliveryStatus: 'PENDING'` and `channel: 'POS'`
- WHEN the chatbot `setDeliveryMetadata` path is invoked for that sale
- THEN the request is rejected with `SALE_DELIVERY_NOT_READY`
- AND `deliveryStatus` stays `'PENDING'`

## MODIFIED Requirements

None. The canonical `sales` spec contains no existing requirement governing `deliveryStatus` semantics at charge time, so this delta adds behavior without modifying any existing requirement block. The existing `chargeDraft Totals Consistent With getSaleDetail` requirement remains untouched: totals invariants, recompute order, and persisted totals are unchanged.

## REMOVED Requirements

None.
