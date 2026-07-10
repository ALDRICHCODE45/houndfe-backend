# Archive Report: Re-arm Low-Stock Alert on Product/Variant Edit

## Final Verdict: ARCHIVED — PASS

- **Change**: `low-stock-rearm-on-edit`
- **Branch**: `feat/low-stock-rearm-on-edit`
- **Archive folder**: `openspec/changes/archive/2026-07-09-low-stock-rearm-on-edit/`
- **Archived at**: 2026-07-09
- **Merge state**: branch NOT merged to `main`, NOT pushed — solo dev merges manually (no PRs)
- **Verify verdict**: PASS — 1522/1522 tests green (2 consecutive live-Postgres runs), 16/16 tasks done, all 8 edit-path spec scenarios COMPLIANT with runtime test evidence, 0 CRITICAL, 0 WARNING
- **Tasks**: 16/16 complete, 0 unchecked
- **Spec compliance**: 8/8 edit-path scenarios COMPLIANT

## Commits Archived (3 work-unit commits)

| Hash | Slice | Title |
|------|-------|-------|
| `4448369` | A | `feat(low-stock-rearm-on-edit): add rearmAlertAfterEdit to IProductRepository` |
| `0ab3be3` | B | `feat(low-stock-rearm-on-edit): wrap update/updateVariant persistence in runInTransaction + change-gate rearm` |
| `a214c64` | C | `test(low-stock-rearm-on-edit): strengthen seedAndFlip + tx-containment assertions` |

Order: A → B → C. Slice ordering preserved per proposal/design (one-parameterized-method approach + service wrap + assertion hardening).

Branch HEAD: `a214c64` on `feat/low-stock-rearm-on-edit`.

## What Shipped

Closed the silent-lost-alerts gap on the manual product/variant edit path. Previously, `ProductsService.update` and `ProductsService.updateVariant` could leave `StockAlertState.alerted = true` forever after an edit raising stock strictly above `minQuantity`; the next sale's guarded `UPDATE ... WHERE alerted = false` would then match zero rows and no email would fire.

The change ships:

1. **One new repository method `rearmAlertAfterEdit({ productId, variantId? })`** on `IProductRepository` / `PrismaProductRepository` (`src/products/infrastructure/prisma-product.repository.ts` L525–602), mirroring the contract of `incrementStockForRestock`:
   - asserts `tenantPrisma.isInTransaction()` (ambient-tx guard, mirrors restock lines 439–443);
   - re-reads the RESULTING `quantity`/`minQuantity` inside the same transaction (no read-then-decide race);
   - applies STRICT `>` (equality `stock == min` does NOT rearm);
   - variant branch SELECT JOINs `products p ON p."useStock" = true` so non-stock parents get 0 rows (Variant has no `useStock` column of its own);
   - calls `alertState.rearm({ tx, tenantId, productId, variantId: variantId ?? null })` with the correct key — `variantId` for variants, `null` for simple (sentinel `'__PRODUCT__'` applied inside stock-alerts).

2. **`ProductsService` transactional wrap** (`src/products/products.service.ts`):
   - `update` (L695–733): wraps the entire persistence tail (`priceList.updateMany` + `productRepo.save` + conditional `variant.updateMany{minQuantity:0}` for the `useStock` flip + `rearmAlertAfterEdit`) in ONE `tenantPrisma.runInTransaction(...)`. Re-routes the two raw `this.prisma.*` writes to `tenantPrisma.getClient()` so they JOIN the transaction (without that, atomicity regresses). Validation (SKU/barcode uniqueness, `findFirst`, `satCatalog.assertExists`) stays OUTSIDE the tx.
   - `updateVariant` (L890–934): wraps `variant.update` + `rearmAlertAfterEdit` in ONE `runInTransaction`. Re-routes `this.prisma.variant.update` to `tenantPrisma.getClient().variant.update`. Validation stays outside. `.then(enrichVariantCostResponse)` chain preserved.
   - Rearm is gated on `dto.quantity !== undefined || dto.minQuantity !== undefined` so unrelated field edits don't trigger a useless SELECT.
   - `seedAndFlip` is NEVER called from the edit path (mutation-validated by the C-slice test that wires a REAL `PrismaProductRepository` with a mocked `alertState` seam).

3. **Strict TDD test coverage** (`+16` tests, baseline 1506 → 1522):
   - `prisma-product.repository.spec.ts` — 6 new adapter tests covering Sc.1, 2, 4, 6, 7, 8 (guard throw, STRICT `>` product, STRICT `>` variant with JOIN, STRICT `==` no-op, 0-row no-op, parent `useStock=false` variant gate).
   - `products.service.spec.ts` L1689–2345 — 10 new service tests covering `update`/`updateVariant` wrap, change-gate, qty/min presence, seedAndFlip never-called (mutation-validated, real adapter + mock seam), tx-containment (captures `insideTx` toggle at call time, not just "getClient was used"), `useStock=false` variant path, `.then` chain preservation.

## Specs Synced into Source of Truth

| Domain | Action | Requirements |
|--------|--------|--------------|
| `stock-alerts` | **MODIFIED** | `One-Shot Edge Trigger At Or Below Min Quantity` — REPLACED with extended prose (covers restock + edit path) + 6 original scenarios preserved + 8 new edit-path scenarios appended = **14 scenarios total** |

All other requirements in the baseline spec were preserved verbatim:

- `After-Commit Dispatch With No Phantom Alerts` (3 scenarios)
- `Concurrent Crossings Collapse To One Alert` (1 scenario)
- `Coalesced Email For Near-Simultaneous Crossings` (2 scenarios)
- `Email Content Contains Full Item Context` (1 scenario)
- `Recipients Are Active Users From The Tenant List` (2 scenarios)
- `Disabled Configuration Short-Circuits The Send` (2 scenarios)
- `Tenant Isolation For Alerts And Sends` (2 scenarios)
- `Verification Surface` section preserved verbatim.

**Final baseline `stock-alerts` spec totals**: **8 requirements**, **27 scenarios** (14 in `One-Shot Edge Trigger` + 13 distributed across the other 7 requirements).

Delta format (`## MODIFIED Requirements` on the existing requirement) was correctly handled as a REPLACEMENT of the matching requirement block — not as an APPEND of new requirements — because the re-arm mechanism is the SAME mechanism on both paths, just with an additional trigger surface.

## Design Coherence (verified in code per verify-report.md)

| Design decision | Verified |
|---|---|
| One parameterized method, not two | single `rearmAlertAfterEdit({productId, variantId})` with internal `variantId ? variants : products` branch ✅ |
| Re-read via SELECT (no folded write) | own `$queryRaw` SELECT then STRICT `>` gate ✅ |
| Tx wraps WHOLE persistence tail; raw writes → `getClient()` | priceList + save + variant cascade all re-routed, W-2 containment proof asserts `insideTx=true` ✅ |
| Variant SELECT JOINs parent `useStock` | repo L547–557 JOINs `p."useStock" = true` ✅ |
| Validation stays outside tx | uniqueness/`findFirst`/`satCatalog.assertExists` before wrap ✅ |
| STRICT `>` shared with restock | `q > m` gate (repo L565, L594) — same expression as restock lines 467/493 ✅ |
| Tenant scoping shared | `getTenantId()` in SELECT + rearm (repo L539) — mirrors restock ✅ |

## Spec Compliance Matrix (8 edit-path scenarios → test → RESULT)

| # | Spec scenario | Covering test(s) | Result |
|---|---|---|---|
| 1 | Edit raises simple → rearm → re-fire | adapter `product path STRICT >` (repo.spec L669) + service `wraps save + rearm … quantity provided — Sc.1` (svc.spec L1931) | ✅ PASS |
| 2 | Edit raises variant → rearm with variantId key | adapter `variant path STRICT > JOINs products.useStock — Sc.2` (repo.spec L758) + service `wraps variant.update + rearm … — Sc.2` (svc.spec L2222) | ✅ PASS |
| 3 | Edit lowers minQuantity only → rearm (RESULTING pair) | service `wraps … ONLY minQuantity … RESULTING pair — Sc.3` (svc.spec L1995) + updateVariant min-only (L2285) | ✅ PASS |
| 4 | stock == min → NO rearm (STRICT >) | adapter `product path STRICT == does NOT rearm — Sc.4` (repo.spec L707) + service `does NOT call rearm when neither qty/min — Sc.4` (svc.spec L2018) | ✅ PASS |
| 5 | Downward → no seedAndFlip, no event | service `edit path NEVER calls seedAndFlip … — Sc.5` (svc.spec L2041, real adapter + mocked alertState, mutation-validated) | ✅ PASS |
| 6 | No pre-existing alert-state row → harmless no-op | adapter `product path 0 rows: no throw, no rearm — Sc.6, Sc.8` (repo.spec L729) | ✅ PASS |
| 7 | Ambient-tx guard throws; service wraps it | adapter `throws outside ambient tx — Sc.7` (repo.spec L636) + service wrap containment proofs (L1931, L2222) | ✅ PASS |
| 8 | useStock=false → no alert logic, no error | adapter `product path 0 rows` (L729) + adapter `variant parent useStock=false JOIN gates out — Sc.8` (repo.spec L802) + service updateVariant useStock=false wrap (L2313) | ✅ PASS |

## TDD Compliance Audit (strict TDD module)

| Check | Result |
|---|---|
| TDD Evidence in apply-progress | ✅ Found (Engram #2749, #2750; RED→GREEN per work unit) |
| All tasks have tests | ✅ 16/16 backed |
| RED confirmed (test files exist) | ✅ adapter + service spec files present |
| GREEN confirmed (tests pass) | ✅ 1522/1522 on execution (2 consecutive live-DB runs) |
| Triangulation adequate | ✅ multi-case per behavior (STRICT `>` vs `==` vs 0-row; product vs variant) |
| Assertion quality | ✅ No tautologies. W-1 (seedAndFlip) rewired to real adapter + mock; W-2 (containment) uses load-bearing `insideTx` capture toggle. Both mutation-validated per apply-progress. |

## Archive Contents

- `proposal.md` ✅
- `exploration.md` ✅
- `design.md` ✅
- `tasks.md` ✅ (16/16 tasks complete, 0 unchecked)
- `verify-report.md` ✅ (final verdict PASS at top; full evidence + 8-scenario matrix + design-coherence + TDD audit)
- `specs/stock-alerts/spec.md` ✅ (delta-style spec preserved for audit trail)
- `archive-report.md` ✅ (this file)

## Source-of-Truth Files Updated

The following main spec now reflects the new behavior:

- `openspec/specs/stock-alerts/spec.md` — `One-Shot Edge Trigger At Or Below Min Quantity` REPLACED with MODIFIED version (extended prose + 14 scenarios = 6 original + 8 edit-path). 7 other requirements and the Verification Surface preserved verbatim. Total: **8 requirements, 27 scenarios**.

No other main spec required modification.

## Engram Observations for Traceability

| Topic | Obs ID | Purpose |
|-------|--------|---------|
| `sdd/low-stock-rearm-on-edit/verify-report` | #2755 | Verify PASS — 1522/1522, run of record |
| `sdd/low-stock-rearm-on-edit/archive-report` | (this save) | This archive report |

## Archive Notes

- Branch `feat/low-stock-rearm-on-edit` is **NOT merged to main** and is **NOT pushed**. The solo dev merges manually after archive; this is intentional per the developer's normal workflow (no PRs).
- No production source code or tests were modified during archive. Only spec/artifact movement (`openspec/specs/stock-alerts/spec.md` update + `openspec/changes/low-stock-rearm-on-edit/` → `openspec/changes/archive/2026-07-09-low-stock-rearm-on-edit/` move) and the new `archive-report.md`.
- The 3 implementation commits (Slices A→C) remain intact in the branch history (HEAD = `a214c64`). They will land on `main` when the dev merges manually.
- `openspec/changes/archive/2026-07-09-low-stock-rearm-on-edit/` is now the immutable audit trail.
- The delta-style spec at `openspec/changes/archive/2026-07-09-low-stock-rearm-on-edit/specs/stock-alerts/spec.md` is preserved verbatim. The merged baseline spec is at `openspec/specs/stock-alerts/spec.md`.

## DEFERRED — User Action Required After Merge

None. The change is purely additive (no schema migration, no breaking change to public API). After `feat/low-stock-rearm-on-edit` lands on `main`, existing behavior for sales/restock paths is unchanged; only the previously-broken edit path is fixed.

## SDD Cycle Complete

The change has been fully explored, proposed, specified, designed, broken into tasks, implemented across 3 work-unit commits (Slices A→C), verified PASS (1522/1522 live-Postgres, 2 consecutive runs), archived, and the baseline spec is now the new source of truth. Ready for the next change.