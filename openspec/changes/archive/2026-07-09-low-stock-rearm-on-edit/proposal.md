# Proposal: Re-arm Low-Stock Alert on Product/Variant Edit

## Intent

After a manual edit leaving `stock > minQuantity`, `StockAlertState.alerted`
stays `true` forever. Next sale crossing: `seedAndFlip`'s guarded
`UPDATE ... WHERE alerted = false` matches zero rows, no event, no email.
**Business impact: silent lost alerts → stockouts ops never sees.**

Re-arm only runs in `incrementStockForRestock`; edits skip it. Fix: mirror
restock re-arm on edits.

## Scope

**In**: close re-arm gap in `update` + `updateVariant`; atomic write+re-arm
via `runInTransaction`; new repo method(s) mirroring
`incrementStockForRestock`; specs for the 8 scenarios.

**Out**: restock, sale/consumption, bulk import, inventory adjustments;
manual-downward alerts; `stock-alerts` code changes.

## Capabilities

**New**: none. **Modified**: `stock-alerts` — extend `One-Shot Edge Trigger At Or Below Min Quantity` with edit-path re-arm scenarios (mirror "Restock re-arms; later drop re-fires") plus a STRICT-`>` boundary case.

## Approach

One transactional repo method per edit path, mirroring `incrementStockForRestock`:
assert ambient tx; `UPDATE ... RETURNING "quantity","minQuantity"` against the right
table; if STRICT `>`, call `alertState.rearm(...)` with the right key; else no-op.
`seedAndFlip` NEVER called from edits. Service wraps persistence in
`runInTransaction`; calls the new method only when `quantity` or
`minQuantity` changed. STRICT `>`, tenant, variantKey stay in repo.

## Business Rules (Acceptance Seeds)

1. Edit leaving `stock > minQuantity` MUST re-arm `alerted=false`.
2. Edit landing `stock <= minQuantity` MUST NOT call `seedAndFlip`.
3. STRICT `>`: `stock == min` does NOT re-arm.
4. Stock/min write + re-arm MUST commit together.
5. Re-arm uses caller's `tenantId`; no CLS leak; edits MUST NOT seed `StockAlertState`.

## Required Regression Scenarios

The 8 from `exploration.md`:

1. Edit raises `quantity` above `min` (simple) → rearm → later drop re-fires.
2. Same via `updateVariant` (variant key/table).
3. Edit lowers `minQuantity` only → rearm fires.
4. Edit leaves `stock == min` → no rearm.
5. Manual downward edit → no `seedAndFlip`, no event.
6. No pre-existing alert row → rearm is a no-op.
7. Ambient-tx guard: throws outside `runInTransaction`; service wraps.
8. `useStock = false` → no alert, no error.

## Affected Areas

`products.service.ts`, `prisma-product.repository.ts`,
`IProductRepository` modified; `stock-alerts/**` unchanged.

## Risks

- **Atomicity regression** (Med) — restock guard + #7.
- **Wrong variantKey / table** (Med) — one method per path; #1, #2.
- **Over-triggering `seedAndFlip`** (Low) — grep guard + #5.
- **`useStock = false`** (Low) — rearm against FINAL `min` + #8.
- **Partial-field edit mis-gated** (Low) — trigger on either field + #3.

## Rollback

Revert the feature commit. Additive, no schema migration. `pnpm test`
passes on `main` after revert. Worst-case is today's bug, so revert is
strictly safer.

## Success Criteria

8 regression scenarios pass under `pnpm test`; new adapter spec extends
`prisma-product.repository.spec.ts` without regression; no change to
`stock-alerts` code; changes under 400 lines; no `seedAndFlip` outside
sale/consumption.