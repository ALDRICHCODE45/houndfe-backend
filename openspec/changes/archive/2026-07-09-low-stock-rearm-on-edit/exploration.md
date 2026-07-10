# Exploration: low-stock-rearm-on-edit

## Current State

The low-stock alert is a one-shot edge trigger backed by `stock_alert_states`
rows keyed by `(tenantId, productId, variantKey)`, where `variantKey` is the
`variantId` or the sentinel `'__PRODUCT__'` for simple products. Two capabilities
drive the state machine (`IStockAlertStateRepository`,
`src/stock-alerts/domain/stock-alert-state.repository.ts`):

- `seedAndFlip(...)` — on a downward crossing it ensures an armed row exists,
  then runs a guarded `UPDATE ... SET alerted = true ... WHERE alerted = false
  RETURNING alertEpoch`. If `alerted` is already `true`, the guarded update
  matches 0 rows and returns `null` → no epoch bump → no outbox event → no email.
- `rearm(...)` — an unguarded `UPDATE ... SET alerted = false`. The STRICT
  `newQuantity > minQuantity` precondition is enforced **at the call site**, not
  in SQL (the quantity/min columns live on the product/variant, not on
  `stock_alert_states`).

Re-arm is invoked in **exactly one place today**:
`PrismaProductRepository.incrementStockForRestock`
(`src/products/infrastructure/prisma-product.repository.ts`, method at line 428).
For each adjustment it does a raw `UPDATE ... RETURNING "quantity", "minQuantity"`
against `variants` (when `variantId` is present) or `products` (simple), and only
if `newQuantity > minQuantity` (STRICT `>`, lines 467 and 493) does it call
`this.alertState.rearm({ tx: prisma, tenantId, productId, variantId })`.

That method is guarded by an ambient-transaction check (lines 439–443): it throws
if `!this.tenantPrisma.isInTransaction()`. Its callers (e.g.
`sales.service.ts` line 1819) wrap it in `saleRepo.runInTransaction(...)`
(line 1766), so the stock write + rearm are atomic. `getClient()` returns the
CLS transaction client when inside `runInTransaction`, otherwise a plain
tenant-scoped client that auto-commits each statement — hence the guard.

**The gap** is confirmed in the service edit paths, which never touch the alert
state machine at all:

- `ProductsService.update(id, dto)` — `src/products/products.service.ts`, method
  **starts at line 583**. It mutates the `Product` domain entity
  (`product.quantity = dto.quantity` line 637, `product.minQuantity =
  dto.minQuantity` line 638), calls `product.normalizeStockConfiguration()`
  (641), then `await this.productRepo.save(product)` (**line 684**). `save`
  (repository line 79) is a plain `prisma.product.upsert` with **no
  transaction** and **no rearm**. So a form edit that raises stock strictly above
  min leaves `alerted = true` forever.

- `ProductsService.updateVariant(productId, variantId, dto)` —
  `src/products/products.service.ts`, method **starts at line 805**. It does a
  direct `this.prisma.variant.update({ where: { id: variantId }, data: {...} })`
  (**line 834**), conditionally setting `quantity` (861) and `minQuantity`
  (862–866). **No transaction, no rearm.**

Net effect matching the user report: after a manual upward edit,
`seedAndFlip` on the next sale sees `alerted = true`, returns `null`, and no new
alert fires.

## Affected Areas

- `src/products/products.service.ts` — `update()` (line 583, persists at 684) and
  `updateVariant()` (line 805, persists at 834). **The two gap sites.**
- `src/products/infrastructure/prisma-product.repository.ts` —
  `incrementStockForRestock` (line 428) is the exemplar contract to mirror;
  `save` (line 79) is what `update()` calls. A new repository method would live
  here alongside them, reusing the injected `alertState` (constructor line 46)
  and `tenantPrisma`.
- `src/products/domain/product.repository.ts` — `IProductRepository` port
  (would gain one method if we choose the repository approach).
- `src/stock-alerts/domain/stock-alert-state.repository.ts` +
  `.../infrastructure/prisma-stock-alert-state.repository.ts` — `rearm` is reused
  as-is; **no change needed** (STRICT `>` is a caller responsibility).
- `src/shared/prisma/tenant-prisma.service.ts` — `runInTransaction`,
  `isInTransaction`, `getClient`, `getTenantId` — the atomicity/tenant plumbing
  that any new write path must respect.

## Key Constraints (must respect)

1. **STRICT `>`**: rearm only when the RESULTING `stock > minQuantity`. Mirror
   lines 467/493 exactly. Equal (`stock == min`) does NOT rearm.
2. **Ambient-tx guard**: rearm must be atomic with the stock/min write. The
   stock write and the rearm must run under the same `runInTransaction`. Any new
   repository method that calls `alertState.rearm` MUST assert
   `isInTransaction()` (mirror lines 439–443) to avoid the auto-commit foot-gun.
3. **Tenant scoping**: `rearm` needs `{ tx, tenantId, productId, variantId }`.
   `tenantId` comes from `tenantPrisma.getTenantId()`; the raw statements must
   carry `"tenantId" = $N` (the `stock_alert_states` `rearm` already does).
4. **Simple vs variant stock location** (real debugging trap): for **variant
   products** stock lives in the `variants` table and the key is `variantId`;
   for **simple products** stock lives in the `products` table and the key is
   `'__PRODUCT__'` (`variantId = null`). `update()` edits the simple-product
   row; `updateVariant()` edits a variant row. Pick the correct key per path.
5. **Manual-downward-edit does NOT alert** (business rule 2): the edit paths
   must NEVER call `seedAndFlip`. If an edit lands `stock <= min`, we simply do
   nothing (leave `alerted` as-is). Only sales/consumption fire alerts.
6. **No existing state row**: if no `stock_alert_states` row exists yet, `rearm`
   is a no-op (`UPDATE` matches 0 rows, returns 0). That is correct and safe —
   an item that never alerted has nothing to re-arm. Do NOT seed a row on edit.

## Approaches

### 1. Push rearm into a dedicated repository method (RECOMMENDED)

Add a method to `IProductRepository` / `PrismaProductRepository`, e.g.
`rearmAlertAfterEdit(items: Array<{ productId; variantId?; }>)`, that mirrors
`incrementStockForRestock`: it asserts `isInTransaction()`, reads the CURRENT
`quantity`/`minQuantity` for the item (a `SELECT`, or reuse the values the write
already returned), and calls `alertState.rearm` when `quantity > minQuantity`.
The service wraps the existing persistence + this call in
`tenantPrisma.runInTransaction(...)`.

Cleanest variant: fold the stock/min write AND the rearm into ONE new
transactional repository method per path (so the `UPDATE ... RETURNING quantity,
minQuantity` and the conditional rearm happen in the same statement sequence,
exactly like `incrementStockForRestock`). The service then calls that method
instead of `save` (for simple) / raw `variant.update` (for variant) when
stock/min changed.

- **Pros**: Rearm logic lives next to its sibling `incrementStockForRestock` and
  reuses the injected `alertState` — one place owns the STRICT `>` + tenant +
  tx-guard contract. Adapter-level tests already exist for this file to extend.
  Keeps the service thin. The RETURNING-based read is race-free (no read-then-act
  gap).
- **Cons**: Touches the domain port (`IProductRepository`) and the `save` flow
  for the simple path; slightly larger surface. `updateVariant` currently uses
  `this.prisma.variant.update` directly (not the repo) so it must be routed
  through the new repo method or a `runInTransaction` wrapper.
- **Effort**: Medium.

### 2. Call `alertState.rearm` directly from the service inside `runInTransaction`

Inject `STOCK_ALERT_STATE_REPOSITORY` into `ProductsService`, wrap the existing
persistence in `tenantPrisma.runInTransaction(...)`, and after the write compute
`resulting stock > min` from the domain entity / updated variant row and call
`alertState.rearm({ tx: tenantPrisma.getClient(), tenantId, productId,
variantId })`.

- **Pros**: No change to `IProductRepository`. Minimal new files.
- **Cons**: Duplicates the STRICT `>` + tenant + variantKey contract in the
  application layer, splitting rearm knowledge across two layers (repo for
  restock, service for edit). Leaks a driven-port (`alertState`) into the
  service. The "resulting stock > min" read must be reconstructed correctly for
  both simple (entity fields) and variant (updated row) — easy to get the
  key/table wrong. Harder to unit-test at the same fidelity as the adapter specs.
- **Effort**: Low–Medium.

## Recommendation

**Approach 1**, folding stock/min write + rearm into transactional repository
methods that mirror `incrementStockForRestock`. Rationale: the STRICT `>`,
ambient-tx guard, tenant carry, and variantKey selection are already solved once
in the repository — mirroring them there keeps a single owner of the rearm
contract and reuses the existing adapter test harness
(`prisma-product.repository.spec.ts` already covers rearm-on-restock with the
same fixtures). The service change is then just: wrap in `runInTransaction` and
call the new repo method when `quantity`/`minQuantity` changed.

Concretely: keep the STRICT `>` decision in SQL-adjacent code using the
`UPDATE ... RETURNING "quantity", "minQuantity"` pattern so there is no
read-then-decide race, exactly like lines 453–500.

## Risks

- **Atomicity regression**: if the rearm is added outside `runInTransaction`,
  the `isInTransaction()` guard throws (or, worse, if the guard is skipped, the
  rearm auto-commits separately from the stock write). Every new write+rearm path
  must be wrapped. This is the single biggest correctness risk.
- **Wrong key / wrong table**: using `productId`+`'__PRODUCT__'` for a variant
  edit (or vice-versa) silently no-ops the rearm. Tests must cover both simple
  and variant explicitly.
- **`useStock = false` interaction**: `update()` zeroes variant `minQuantity`
  when `useStock` flips to false (lines 686–691), and `updateVariant` forces
  `minQuantity: 0` for non-stock products (line 866). Rearm must be evaluated
  against the FINAL persisted `min`, and must not fire alerts — only rearm — so
  this stays safe, but tests should pin the non-stock behavior.
- **Partial-field edits**: an edit that changes `min` but not `quantity` (or
  vice-versa) must still be evaluated — the rule is about the RESULTING
  `stock > min`, regardless of which field moved. Do not gate rearm on
  `dto.quantity !== undefined` alone.
- **Over-triggering seedAndFlip**: must NOT call `seedAndFlip` from edits
  (business rule 2). Only `rearm` belongs on the edit path.

## Required Regression Test Scenarios (Strict TDD)

1. **The exact user bug (simple product)**: product with `alerted = true`
   (was low). `update()` raises `quantity` strictly above `min` → rearm sets
   `alerted = false`. A later sale that crosses down calls `seedAndFlip`, which
   now WINS → new epoch + event fires. **This is the headline scenario.**
2. **The exact user bug (variant product)**: same as #1 but via `updateVariant`,
   asserting the key is `variantId` and the `variants` table is read.
3. **Rearm via min lowered**: quantity unchanged, `minQuantity` edited DOWN so
   `stock > min` now holds → rearm fires. (Proves the rule is "resulting
   stock > min", not "quantity was edited".)
4. **STRICT `>` boundary**: edit leaves `stock == min` → rearm does NOT fire
   (`alerted` stays `true`). Mirror of restock spec line 523.
5. **Manual downward edit does NOT alert**: edit lands `stock <= min` →
   `seedAndFlip` is NEVER called, no event, no email; `alerted` unchanged.
6. **No pre-existing alert state row**: item never alerted (`alerted = false`
   or no row) and edit raises stock → rearm is a harmless no-op (0 rows), no
   crash.
7. **Atomicity/guard**: the rearm-bearing repository method THROWS when called
   outside an ambient transaction (mirror restock guard test at
   `prisma-product.repository.spec.ts` line 605), and the service invokes it
   inside `runInTransaction`.
8. **Non-stock product (`useStock = false`)**: edit does not fire alerts and does
   not error; rearm evaluated against final `min = 0` semantics.

## Ready for Proposal

**Yes.** The surface is confirmed and the gap is exactly at
`products.service.ts:684` (simple, via `productRepo.save`) and
`products.service.ts:834` (variant, via `prisma.variant.update`). Recommend the
orchestrator advance to `sdd-propose`, carrying: (a) the recommended
repository-method + `runInTransaction` approach, (b) the STRICT `>` / ambient-tx
/ tenant / variantKey constraints, and (c) the 8 regression scenarios above as
the spec's Given/When/Then seeds.
