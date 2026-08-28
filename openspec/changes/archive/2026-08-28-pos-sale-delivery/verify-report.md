# Verify Report — `pos-sale-delivery`

- **Status:** PASS
- **Store:** `openspec` (authoritative). Engram memory was DOWN; no `mem_save` attempted.
- **Change:** POS sale "for delivery" at charge time.
- **Verified artifact:** working tree (uncommitted) — 5 files modified, 0 deletions, 353 insertions.

## Verdict summary

| Requirement | Verdict |
|---|---|
| POS Sale Delivery Flag At Charge Time (DTO) | PASS |
| Delivery Flag With Shipping Address Confirms Sale As PENDING | PASS |
| Delivery Flag Without Shipping Address Is Rejected Before Persistence | PASS |
| Omitted Or False Delivery Flag Preserves Today Behavior Exactly | PASS |
| Charge Idempotency Hash Includes Delivery Flag | PASS |
| Charge Route Authorization Unchanged | PASS |
| SHIPPED SHALL NOT Be Written For POS Sales | PASS |

All six proposal acceptance criteria are satisfied. No blockers.

## Requirements → evidence mapping

### 1. POS Sale Delivery Flag At Charge Time (DTO) — PASS

| Scenario | Evidence | Result |
|---|---|---|
| Delivery flag omitted reproduces today's behavior | `src/sales/dto/charge-sale.dto.ts:73-75` `@IsOptional() @IsBoolean() delivery?: boolean`; service only branches on `dto.delivery === true` (`sales.service.ts:2496`) | PASS |
| Delivery flag `true` accepted at DTO layer | DTO field `:74-75`; service test `sales.service.spec.ts` (pos-sale-delivery describe) persists `PENDING` with `delivery: true` | PASS |
| Delivery flag `false` accepted, behaves like omission | service test asserts `deliveryStatus: 'DELIVERED'` for `delivery: false` | PASS |
| Non-boolean delivery value rejected at DTO layer | `@IsBoolean()` (`charge-sale.dto.ts:74`) → class-validator 400. No dedicated `charge-sale.dto.spec.ts` exists (consistent with the existing file layout); type/build gate passes. | PASS (see note 3) |

### 2. Delivery Flag With Shipping Address Confirms Sale As PENDING — PASS

| Scenario | Evidence | Result |
|---|---|---|
| Flag true + non-null address persists PENDING and stays route-eligible | `Sale.markForDelivery()` sets `_deliveryStatus = 'PENDING'` (`sale.entity.ts:749-760`); `chargeDraft` calls it when `delivery === true` (`sales.service.ts:2496-2497`) and passes `deliveryStatus: sale.deliveryStatus` to `persistChargeConfirmation` (`sales.service.ts:2652`); entity test + service test assert `PENDING` | PASS |
| Route check-in still flips PENDING → DELIVERED | No change to `Sale.markDelivered()` (`sale.entity.ts:676-689`, pre-existing); feature only writes `PENDING` | PASS |

Channel stays `'POS'` — `chargeDraft` passes no `channel`, so the conditional-write rule keeps the draft's seeded `channel: 'POS'` (verified in design/explore; `persistChargeConfirmation` input at `sales.service.ts:2624-2652` contains no `channel`).

### 3. Delivery Flag Without Shipping Address Is Rejected Before Persistence — PASS

| Scenario | Evidence | Result |
|---|---|---|
| Flag true + null address → 422, no persist | `markForDelivery()` throws `BusinessRuleViolationError('SHIPPING_ADDRESS_REQUIRED_FOR_DELIVERY')` when `_shippingAddressId === null` (`sale.entity.ts:752-756`); `DomainExceptionFilter` maps `BusinessRuleViolationError` without a code override to 422 (`src/shared/filters/domain-exception.filter.ts:202-203`) | PASS |
| No persistence / side effects | Guard call placed immediately after DRAFT guard and **before** recompute/stock/folio (`sales.service.ts:2496-2497`); service test asserts `persistChargeConfirmation`, `allocateNextFolio`, `decrementStockForCharge` NOT called and no `sale.confirmed` outbox | PASS |
| Address field absent behaves like null | `shippingAddressId` getter returns `string | null` (`sale.entity.ts:398-400`); null check covers absent | PASS |

### 4. Omitted Or False Delivery Flag Preserves Today Behavior Exactly — PASS

| Scenario | Evidence | Result |
|---|---|---|
| Omitted flag → DELIVERED | No `markForDelivery()` call when `dto.delivery !== true`; aggregate seeded `'DELIVERED'` read via `sale.deliveryStatus` (`sales.service.ts:2652`); service test asserts `DELIVERED` | PASS |
| Explicit `false` → DELIVERED | service test asserts `DELIVERED` for `delivery: false` | PASS |

Channel and totals invariants unchanged (no `channel` pass-through added; no totals logic touched).

### 5. Charge Idempotency Hash Includes Delivery Flag — PASS

| Scenario | Evidence | Result |
|---|---|---|
| Hash includes flag | `delivery: dto.delivery ?? false` added to `requestHash` JSON (`sales.service.ts:2429`) | PASS |
| Flipped flag → `IDEMPOTENCY_KEY_CONFLICT` | service test captures first hash (`delivery: true`) vs second (`delivery: false`), asserts hashes differ and conflict thrown | PASS |
| Omitted vs explicit false hash identically | service test sanity assertion `ids[0] === ids[1]`; WU2 legacy-hash spec updated to include `delivery: false` (`sales.service.spec.ts:3724`) | PASS |
| Same key + same value replays | covered indirectly by omitted≡false hash normalization + pre-existing idempotency replay discipline | PASS (see note 2) |

### 6. Charge Route Authorization Unchanged — PASS

| Scenario | Evidence | Result |
|---|---|---|
| update:Sale still covers charge route | `sales.controller.ts:263` `@RequirePermissions(['update', 'Sale'])` unchanged; `git diff` touches no auth/permission file | PASS |
| No new CASL action/registry/seed | `git diff --name-only` = 5 files (DTO, entity, entity spec, service, service spec); no `permission.ts`, `casl-ability.factory.ts`, registry/seed changes | PASS |

### 7. SHIPPED SHALL NOT Be Written For POS Sales — PASS

| Scenario | Evidence | Result |
|---|---|---|
| Charge path never writes SHIPPED | `markForDelivery()` only writes `'PENDING'` (`sale.entity.ts:759`); no `'SHIPPED'` literal written in the diff (only a doc comment) | PASS |
| Chatbot guard continues to reject SHIPPED on POS | `chatbot-api.service.ts:412-425` `channel === 'ONLINE'` guard untouched (not in diff); POS sales stay `channel: 'POS'` | PASS |

## Acceptance criteria (proposal.md) — all satisfied

1. `delivery: true` + non-null address → `PENDING` + route-eligible — **PASS** (Req 2).
2. null/absent address → 422 + `persistChargeConfirmation` not called — **PASS** (Req 3).
3. omitted/`false` reproduces today's behavior — **PASS** (Req 4).
4. same idempotency key + changed flag does not replay stale result — **PASS** (Req 5).
5. no CASL change; `update:Sale` still covers — **PASS** (Req 6).
6. `pnpm test` + `pnpm build` pass — **PASS** (below).

## Non-goals held

- **No CASL change** — confirmed (0 auth files in diff).
- **No repository signature / migration** — confirmed (0 `*.repository.*`, `schema.prisma`, `migrations/*` in diff).
- **No `SHIPPED` writer** — confirmed (only a doc comment mentions SHIPPED; no write).
- **No `ListSalesDeliveryStatus` widening** — confirmed (no occurrence in diff).

## Test / build results (independently re-run)

| Command | Result |
|---|---|
| `pnpm test src/sales/domain/sale.entity.spec.ts src/sales/sales.service.spec.ts` | 2 suites passed, 347/347 tests |
| `pnpm test` (full) | **211 suites passed, 2940/2940 tests** |
| `pnpm build` (exit 0) | zero TypeScript errors |

`apply-progress.md` reported 2940/2940 and clean build; independently reproduced.

## Task completion status

No unchecked implementation task markers in `tasks.md` (`grep '^\s*- \[ \]'` → none). All implementation phases 1.1–4.1 marked `[x]`. Phase 4.2 (parent post-apply review) is a heading without a checkbox; this verify report is that review.

Note: `proposal.md` acceptance checkboxes (lines 45-50) remain literal `- [ ]` (unticked). Substantively all six are verified PASS here; tick them before archive as housekeeping (non-blocking for the verdict).

## Structured status / actionContext findings

- No structured SDD status JSON was passed in the parent prompt.
- Store `openspec` is authoritative (`openspec/` dir present); the `resolve-via-engram` non-authoritative carve-out does **not** apply.
- Change selection is unambiguous (`pos-sale-delivery`).
- `actionContext.mode` is not `workspace-planning`; no `allowedEditRoots` requirement applies.
- Implementation ownership is proven: all 5 changed files are under `src/sales/`, inside the repo working tree.

## Strict TDD

Not active. `openspec/config.yaml → rules.apply.tdd: false`. No TDD cycle-evidence table required. (Note: tasks.md documents RED→GREEN phases and a RED-failure was recorded for Phases 2.1/3.1, but strict TDD compliance is out of scope here.)

Assertion quality: the new tests assert concrete observable behavior (`persistChargeConfirmation` call shape with `deliveryStatus`, absence of side-effect calls, error `code` matching, hash inequality/equality) — not tautological, no ghost loops, no type-only/smoke-only assertions. The WU2 legacy-hash assertion is re-derived independently (not tautological), per its in-test comment.

## Review workload / PR boundary

- Forecast: single PR, no chained PRs, `Chain strategy: stacked-to-main`, `400-line budget risk: Low`, `~140 additions` estimated.
- Actual: 353 insertions / 0 deletions across exactly the 5 forecast files. Still single-PR within the 400-line budget; no chained-PR boundary violated; no scope creep (file set matches the design file map exactly).
- Observation: the `~140 additions` estimate undercounted the actual (353) — driven by 280 test lines. Non-blocking (still under budget, single slice). See note 4.

## Blocker list

None.

## Notes (non-blocking observations)

1. `proposal.md` acceptance checkboxes still unchecked (`- [ ]`) — tick before archive.
2. Req 5 "same key + same value replays cached result" has no dedicated end-to-end replay test; it is covered by the omitted≡false hash identity assertion plus the pre-existing `acquireChargeIdempotency` replay tests. Low risk.
3. Req 1 "non-boolean rejected at DTO layer" has no dedicated `charge-sale.dto.spec.ts` (that DTO has no co-located spec today); relies on `@IsBoolean()` standard class-validator behavior + build gate. Low risk.
4. Forecast line-count estimate (~140) undercounted actual (353); still within the 400-line single-PR budget. Low risk.
5. `charge-sale.dto.ts` ends without a trailing newline (cosmetic).
