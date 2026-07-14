# Tasks: Activate BUY_X_GET_Y in the POS Promotion Engine

> Branch `feat/buy-x-get-y`; one Conventional Commit per work unit; local merge to `main`; NO PRs. Strict RED→GREEN; filtered Jest only, never the full suite. ADVANCED and cart engine are out.

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: High

## Phase 1 / WU1 — Pure helper
**Independent:** `feat(promotions): add pure computeBuyXGetYReward helper`

- [x] 1.1 RED FIRST: create `src/promotions/application/pos-evaluate-promotions.buy-x-get-y-helper.spec.ts`; lock qty3/1000c/2+1/50, floor groups, zero group, and rounding (`spec.md:69-91,102-106`).
- [x] 1.2 GREEN: export the minimal helper from `src/promotions/application/pos-evaluate-promotions.use-case.ts`; run `pnpm run test -- pos-evaluate-promotions.buy-x-get-y-helper.spec.ts`.

## Phase 2 / WU2 — NET representation
**Independent:** `feat(sales): add BXGY line reward and NET readers`

- [x] 2.1 RED: extend `sale-item.entity.spec.ts`, `sale.entity.spec.ts`, and `prisma-sale.repository.spec.ts` for reward apply/discriminator, 100%/50% NET totals, `rewardKind`, and non-BXGY regression (`spec.md:98-106`).
- [x] 2.2 GREEN: change `src/sales/domain/sale-item.entity.ts`, `sale.entity.ts`, `infrastructure/prisma-sale.repository.ts`, and `dto/sale-detail-response.dto.ts`; run `pnpm run test -- sale-item.entity.spec.ts sale.entity.spec.ts prisma-sale.repository.spec.ts`.

## Phase 3 / WU3 — Engine pass
**Needs WU1+WU2:** `feat(promotions): evaluate BXGY with total-saving best-wins`

- [x] 3.1 RED: create `src/promotions/application/pos-evaluate-promotions.buy-x-get-y.spec.ts` for four targets, counting, non-match, manual-discount skip, PD-total comparison/tie, and pass order (`spec.md:21-37,60-96`).
- [x] 3.2 GREEN: add result union/gate/pass/comparator in `src/promotions/application/ports/pos-evaluate-promotions.port.ts` and `pos-evaluate-promotions.use-case.ts`; run `pnpm run test -- pos-evaluate-promotions.buy-x-get-y.spec.ts`.

## Phase 4 / WU4 — Recompute
**Needs WU3:** `feat(sales): recompute BXGY rewards idempotently`

- [x] 4.1 RED: extend `src/sales/sales.service.spec.ts` for kind apply, clear/re-apply, AUTOMATIC apply, and five-run byte equality (`spec.md:112-115,132-139`).
- [x] 4.2 GREEN: branch `recomputePromotions` in `src/sales/sales.service.ts`; run `pnpm run test -- sales.service.spec.ts -t "BUY_X_GET_Y"`.

## Phase 5 / WU5 — Validation
**Independent:** `feat(promotions): require BXGY targets and allow BXGY 100 percent`

- [x] 5.1 RED: invert `promotion.entity.spec.ts:216`, add ADVANCED=100 rejection, create `src/promotions/dto/create-promotion.dto.spec.ts`, and add create/update `INVALID_TARGET` cases to `promotions.service.spec.ts` (`spec.md:41-58,98-106`).
- [x] 5.2 GREEN: change `src/promotions/domain/promotion.entity.ts`, `dto/create-promotion.dto.ts`, and `promotions.service.ts`; run `pnpm run test -- promotion.entity.spec.ts create-promotion.dto.spec.ts promotions.service.spec.ts -t "BUY_X_GET_Y|ADVANCED"`.

## Phase 6 / WU6 — MANUAL wiring
**Needs WU3:** `feat(promotions): expose MANUAL BXGY and retain valid opt-ins`

- [x] 6.1 RED: extend the BXGY engine spec and `src/sales/sales.service.spec.ts` for candidate, targetability, wire type, and two-recompute opt-in survival (`spec.md:108-130`).
- [x] 6.2 GREEN: change the use-case, its port, and `src/sales/dto/list-applicable-promotions-response.dto.ts`; run `pnpm run test -- pos-evaluate-promotions.buy-x-get-y.spec.ts sales.service.spec.ts -t "BUY_X_GET_Y"`.

## Phase 7 / WU7 — Integration
**Needs WU1–WU6:** `test(promotions): complete BXGY integration sweep`

- [x] 7.1 RED→GREEN: create `src/promotions/buy-x-get-y.integration.spec.ts` for all 18 scenarios on one seeded tenant; run only `pnpm run test:integration -- buy-x-get-y.integration.spec.ts`.
- [x] 7.2 Sync `openspec/changes/buy-x-get-y/specs/pos-promotion-engine/spec.md`; verify zero migration with `pnpm exec prisma migrate diff --from-schema-datamodel prisma/schema.prisma --to-schema-datasource prisma/schema.prisma`.

## Review Workload Forecast

| WU | Lines | WU | Lines |
|---|---:|---|---:|
| 1 | 60–90 | 5 | 120–180 |
| 2 | 220–300 | 6 | 100–150 |
| 3 | 260–360 | 7 | 180–260 |
| 4 | 100–150 | **Total** | **1,040–1,490** |

Crosses 400: **Yes**. Mitigation: seven ordered, revertible commits on one local branch—not PR splitting.
