# Delta Spec for `stock-alerts` — Edit-Path Re-Arm

This delta extends the existing `One-Shot Edge Trigger At Or Below Min
Quantity` requirement so its re-arm mechanism also covers the direct
product/variant edit path. Edit-path re-arm is the SAME re-arm mechanism
as restock re-arm, not a distinct trigger, so it lives inside the existing
requirement. All six pre-existing scenarios are preserved verbatim and the
eight edit-path scenarios are appended.

## MODIFIED Requirements

### Requirement: One-Shot Edge Trigger At Or Below Min Quantity

The system MUST fire exactly one alert on transition from `quantity > minQuantity`
to `quantity <= minQuantity`. `hasVariants=false` tracks at product level; products
with variants track per variant. Lots/expiration items MUST be excluded. Re-arm
MUST occur only after quantity returns strictly above `minQuantity`.

Re-arm applies to BOTH the restock path AND the direct product/variant edit
path (`update` / `updateVariant`) whenever the resulting `quantity > minQuantity`
STRICTLY. On the edit path the write and the re-arm MUST commit atomically in
the same transaction, MUST share the caller's `tenantId`, MUST use the correct
simple-vs-variant key (`variantId` for variant rows, `'__PRODUCT__'` for
simple-product rows), and MUST NEVER call `seedAndFlip`. Edits MUST NOT re-arm
when the resulting `quantity <= minQuantity`, MUST NOT seed a `StockAlertState`
row, and MUST NOT run alert logic for non-stock products (`useStock = false`).
The STRICT `>` boundary, the ambient-transaction guard, and the tenant scope are
shared with the restock contract and SHALL NOT diverge.

#### Scenario: First crossing fires one alert
- GIVEN P (`hasVariants=false`, `qty=10`, `min=3`, no prior alert)
- WHEN a sale drops P to `qty=3`
- THEN ONE `stock/low.detected` event emits for P
- AND `StockAlertState(tenantId, P, null).alerted=true`

#### Scenario: Variant path tracks per variant
- GIVEN V1 (`qty=10/min=3`) and V2 (`qty=5/min=2`) on P
- WHEN a sale drops V1 to `qty=3` and V2 to `qty=2`
- THEN two events emit (one per variant); both rows `alerted=true`

#### Scenario: Subsequent sale while low does NOT re-fire
- GIVEN P `alerted=true`, `qty=3`, `min=3`
- WHEN a sale drops P to `qty=1`
- THEN no new event emits and `alerted` stays `true`

#### Scenario: Restock re-arms; later drop re-fires
- GIVEN P `alerted=true`, `qty=3`, `min=3`
- WHEN restock lifts P to `qty=10` then a later sale drops P to `qty=3`
- THEN `alerted` toggles `false` then `true`
- AND exactly ONE new event emits on the second drop

#### Scenario: Boundary inclusive at minQuantity
- GIVEN P at `qty=4`, `min=3`, armed
- WHEN a sale drops P to `qty=3`
- THEN one alert fires (`3 <= 3` inclusive)

#### Scenario: Lots/expiration products excluded
- GIVEN P with `useLotsAndExpirations=true` crossing
- WHEN the sale tx completes
- THEN no event emits and no `StockAlertState` row is written

#### Scenario: Edit raises simple product above min → rearm → later drop re-fires
- GIVEN a simple product P (`hasVariants=false`) with
  `StockAlertState(tenantId, P, null).alerted=true`, `quantity=3`,
  `minQuantity=3`
- WHEN `update(id, { quantity: 10 })` runs
- THEN `StockAlertState(tenantId, P, null).alerted` becomes `false`
- AND a later sale dropping P to `quantity=3` emits ONE new
  `stock/low.detected` event for P and flips `alerted` back to `true`

#### Scenario: Edit raises variant above min → rearm with variantId key
- GIVEN a variant V1 on P with
  `StockAlertState(tenantId, P, V1.id).alerted=true`, `quantity=3`,
  `minQuantity=3`
- WHEN `updateVariant(productId, V1.id, { quantity: 10 })` runs
- THEN `StockAlertState(tenantId, P, V1.id).alerted` becomes `false`
  (keyed by `variantId`, NOT by `'__PRODUCT__'`)
- AND a later sale dropping V1 to `quantity=3` emits ONE new event
  scoped to V1

#### Scenario: Edit lowers minQuantity only → rearm fires
- GIVEN a simple product P with `alerted=true`, `quantity=5`,
  `minQuantity=5`
- WHEN `update(id, { quantity: 5, minQuantity: 3 })` runs (quantity
  unchanged, `minQuantity` lowered)
- THEN `StockAlertState(tenantId, P, null).alerted` becomes `false`
  because the resulting `5 > 3` holds; the decision depends on the
  RESULTING pair, not on which field was edited

#### Scenario: Edit leaves stock == min → NO rearm (STRICT > boundary)
- GIVEN a simple product P with `alerted=true`, `quantity=5`,
  `minQuantity=3`
- WHEN `update(id, { quantity: 3 })` runs (resulting `stock == min`)
- THEN `StockAlertState(tenantId, P, null).alerted` stays `true`
  (STRICT `>` — equality does NOT rearm)

#### Scenario: Manual downward edit lands stock <= min → no seedAndFlip, no event
- GIVEN a simple product P with `quantity=10`, `minQuantity=3`, no
  pre-existing `StockAlertState` row
- WHEN `update(id, { quantity: 2 })` runs (manual downward edit lands
  `2 <= 3`)
- THEN `seedAndFlip` is NEVER called
- AND no `stock/low.detected` event is written to the outbox
- AND no `StockAlertState` row is seeded for P (edits MUST NOT seed)

#### Scenario: No pre-existing alert-state row → rearm is a harmless no-op
- GIVEN a simple product P with no `StockAlertState` row (never
  alerted) and `minQuantity=3`
- WHEN `update(id, { quantity: 10 })` runs (resulting `10 > 3`)
- THEN the rearm `UPDATE` matches 0 rows and does not throw
- AND no `StockAlertState` row is created as a side effect of the edit

#### Scenario: Ambient-tx guard throws outside runInTransaction; service wraps it
- GIVEN the rearm-bearing repository method
- WHEN it is called outside `tenantPrisma.runInTransaction(...)` (i.e.
  `isInTransaction()` returns `false`)
- THEN the method throws (mirroring the restock guard)
- AND `ProductsService` always wraps persistence + rearm in a single
  `runInTransaction` so write and rearm commit atomically; a partial
  commit is impossible

#### Scenario: useStock = false → no alert logic runs, no error
- GIVEN a product P with `useStock=false` and `minQuantity=0`
- WHEN `update(id, { quantity: 5, useStock: false })` runs
- THEN no alert state machine code path runs on the edit (no rearm, no
  `seedAndFlip`)
- AND no error is thrown
