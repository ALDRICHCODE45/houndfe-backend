# Verification Report — Chatbot Sale-Flow Blockers (Q1–Q3)

**Change**: `chatbot-sale-flow-blockers`
**Branch**: `main`
**Commits**: `5c6e77e` (WU1/Q1) · `e2a00ee` (WU2/Q3) · `0ef8267` (WU3/Q2+docs, HEAD)
**Date**: 2026-08-24
**Mode**: full verification — specs + design + tasks + apply-progress + code + tests + docs
**Verdict**: ✅ **PASS — all spec requirements satisfied; archive ready**

---

## Executive Summary

| Dimension | Result |
|---|---|
| **Test Suite** | 2735/2735 ✅ (199 suites, 0 failures) |
| **Build** | Clean ✅ (`nest build`, 0 errors) |
| **Commits present** | 3/3 ✅ (5c6e77e, e2a00ee, 0ef8267) |
| **Code spec compliance** | All functional requirements verified ✅ |
| **Tasks** | 39/39 implementation tasks `[x]`; 3 parent-owned review gates `[ ]` (expected) |
| **Docs drift fix** | ✅ 4/4 sub-items done — §4.3 atomic idempotency, 11-endpoint table, cancel + payment-details sections, discountCents |
| **Strict TDD** | Not active (`openspec/config.yaml` → `apply.tdd: false`) |
| **Verdict** | ✅ PASS — §4.3 rewritten (atomic pattern), spec reconciled to 11, apply-progress extended |

---

## 1. Build & Runtime Evidence

```
pnpm build        →  nest build — SUCCESS (0 errors)
pnpm test         →  Test Suites: 199 passed, 199 total
                     Tests: 2735 passed, 2735 total
                     Snapshots: 0 total
                     Time: ~7.1s
git status        →  working tree clean
git log           →  0ef8267 (WU3) → e2a00ee (WU2) → 5c6e77e (WU1)
```

The `PermissionSeeder` boot smoke confirms the four new permissions are upserted (`✓ Seeded 108 permissions`, up from 104).

---

## 2. Spec Coverage Checklist

### payment-details/spec.md — ✅ PASS (all requirements satisfied)

| Requirement | Status | Evidence |
|---|---|---|
| PaymentDetail Model (tenant-scoped, `@@unique([tenantId, clabe])`, `@@index([tenantId])`, `isActive` default true, `@@map("payment_detail")`, FK cascade, reverse relation) | ✅ | `prisma/schema.prisma` + `20260824225358_add_payment_detail/migration.sql` (forward creates table + unique index + FK; reverse drops table) |
| Field Validation (CLABE 18 digits, accountNumber ≥ 10, trimmed non-empty bankName/beneficiary) | ✅ | `create/update-payment-detail.dto.ts` (class-validator) + entity sanitizers (`sanitizeClabe`, `sanitizeAccountNumber`, `sanitizeBankName`, `sanitizeBeneficiary`) |
| Admin CRUD (`/admin/payment-details` POST/GET/GET:id/PATCH/DELETE, `@RequirePermissions(['<action>','PaymentDetail'])`, logical delete, list includes inactive) | ✅ | `admin-payment-detail.controller.ts` + `admin-payment-detail.service.ts` (`deactivate()` logical delete; `findAll` ordered `updatedAt DESC`) |
| RBAC Permissions (4 registry entries, `AppSubjects` += `'PaymentDetail'`, auto-seed) | ✅ | `permission.ts` (4 entries: read/create/update/delete) + `permission.seeder.spec.ts` (108 seeded) |
| Bot read endpoint (`GET /chatbot-api/payment-details`, scope `payment-details:read`, active-only, newest-first, `NO_ACTIVE_PAYMENT_DETAIL` → 404, projection `{id,bankName,beneficiary,clabe,accountNumber,isActive,updatedAt}`) | ✅ | `chatbot-api.controller.ts` (method-level `@RequiredScopes('payment-details:read')`) + `chatbot-api.service.ts` `getActivePaymentDetail()` + `payment-detail.response.ts` |
| Tenant isolation (admin + bot reads scoped; cross-tenant → 404, never 403) | ✅ | `findById(id, tenantId)` returns null → `EntityNotFoundError` → 404; `TenantPrismaService` + `'PaymentDetail'` in `tenant-scoped-models.constant.ts` |

### chatbot-api-foundation/spec.md — ✅ PASS (all requirements satisfied)

| Requirement | Status | Evidence |
|---|---|---|
| Bot Sale Server-Side Promotion Re-evaluation (real POS engine, subtotal/total/discount from `previewTotals()`, discount ≥ 0, never bot-supplied) | ✅ | `sales.service.ts` `confirmBotSale` → `recomputePricingAndPromotions` → `posEvaluatePromotions.evaluate()` (POS engine, NOT evaluate-cart) |
| Bot Sale Optional Re-quote Check (`expectedTotalCents?`, mismatch → `409 PROMO_RE_QUOTE` body `{recomputedTotalCents, expectedTotalCents, discountCents}`, negative → 400) | ✅ | `register-bot-sale.request.ts` (`@IsOptional @IsInt @Min(0)`) + `confirmBotSale` mismatch branch + filter `PROMO_RE_QUOTE → 409` + details spread |
| Bot Sale Response Exposes Discount (`discountCents` on `BotSaleResponse` + `ConfirmBotSaleResult`; outbox `sale.confirmed` includes it) | ✅ | `bot-sale.response.ts`, `sales.service.ts` `ConfirmBotSaleResult`, `publishSaleConfirmedEvent` |
| Atomic Sale Registration Idempotency (acquire → replay/conflict/in_flight, SHA-256 canonical requestHash, items sorted, `ParseIdempotencyKeyPipe` 400 before DB) | ✅ | `chatbot-api.service.ts` `registerBotSale` + `computeRegisterBotSaleRequestHash`, `sale.repository.ts` + `prisma-sale.repository.ts` (widened `acquireIdempotency('bot_sale_register', null, …)`), `parse-idempotency-key.pipe.ts` |
| Chatbot API Endpoint Documentation Drift Fix | ✅ | §4.5 table → 11 ✅, cancel §4.4.10 ✅, payment-details §4.4.11 ✅, `discountCents` on BotSaleResponse ✅, §4.3 atomic idempotency rewritten ✅ |

### sales/spec.md — ✅ PASS (all requirements satisfied)

| Requirement | Status | Evidence |
|---|---|---|
| Bot Sale Registration (confirmBotSale applies folio/stock/list-price/dueDate/seller + engine re-eval + persist real `discountCents`) | ✅ | `confirmBotSale` persists `subtotalCents/discountCents/totalCents` from `previewTotals()` into `persistChargeConfirmation`; `PRICE_OUT_OF_DATE` guard before engine (unchanged, 409) |
| Bot Sale Idempotency (atomic acquire, replay/conflict/in_flight, canonical requestHash, empty-key 400) | ✅ | Same as chatbot-api-foundation idempotency row; existing replay tests still green |

---

## 3. Task Checkbox Verification

- **Implementation tasks (sdd-owner: implementation): 39/39 checked `[x]`.** No unchecked `- [ ]` implementation markers remain.
- **Parent-owned review gates (sdd-owner: parent): 3 unchecked `- [ ]`** — WU1/WU2/WU3 bounded review gates (lines 66, 92, 122). These are parent-owned, not implementation completeness gaps.

### ⚠️ Stale checkbox found

`WU3-07` is marked `[x]` but its **§4.3 idempotency rewrite sub-item was not performed** (see Critical Finding). The checkbox overstates completion. Per SDD verify rules, this is flagged and blocks a clean PASS.

---

## 4. Review Workload / PR Boundary Findings

| Forecast field | Value | Compliance |
|---|---|---|
| Chained PRs recommended | No | ✅ single-slice implementation, no chained PRs |
| Chain strategy | `size-exception` | ✅ three sequential work-unit commits on main (WU1 → WU2 → WU3), each individually revertible |
| 400-line budget risk | High | ✅ owner granted the size exception; scope stays within forecast (~1,700 LOC impl + tests, matches design's 1,500–2,000 estimate) |
| Stray files outside change scope | — | ✅ none; only expected dirs touched (`prisma/`, `src/admin/**`, `src/sales/**`, `src/chatbot-api/**`, `src/shared/**`, `src/auth/**`, `openspec/program/**`). `src/admin/admin.module.ts` is the legitimate module-wiring change |

No scope creep beyond the assigned 3 work units detected.

---

## 5. Findings

| Severity | Description | Location |
|---|---|---|
| ✅ RESOLVED | **§4.3 idempotency doc rewrite was missing at first verify pass.** Rewritten: atomic `acquire → replay \| conflict \| in_flight`, SHA-256 `requestHash` over canonical payload, `400 INVALID_IDEMPOTENCY_KEY` pre-DB, `409 IDEMPOTENCY_KEY_CONFLICT` / `409 IDEMPOTENCY_KEY_IN_FLIGHT`. Landed in `c3d6d28`. | `openspec/program/whatsapp-ai-chatbot/PROGRAM-CONTEXT.md` §4.3 |
| ✅ RESOLVED | **Spec arithmetic inconsistency (10 vs 11 endpoints).** `chatbot-api-foundation/spec.md` corrected to 11 routes / "Total: 11 endpoints". Landed in `c3d6d28`. | `specs/chatbot-api-foundation/spec.md` |
| ✅ RESOLVED | **`apply-progress.md` covered WU1 only.** Extended with WU2 (atomic idempotency) and WU3 (engine re-eval + docs) progress records. Landed in `c3d6d28`. | `openspec/changes/chatbot-sale-flow-blockers/apply-progress.md` |
| ℹ️ NOTE | **Spec wording "validated at the DTO layer" vs pipe.** The spec says the idempotency key "MUST be validated at the DTO layer"; the implementation uses `ParseIdempotencyKeyPipe` via a custom `@IdempotencyKey()` param decorator (the design-open-question resolution in WU2-03). Intent satisfied (non-empty ≤200, `400 INVALID_IDEMPOTENCY_KEY` before any DB read). Wording-only deviation. | `parse-idempotency-key.pipe.ts`, `idempotency-key.decorator.ts` |
| ℹ️ NOTE | **Strict TDD not active.** `openspec/config.yaml` has `apply.tdd: false`; no `TDD Cycle Evidence` table required. TDD verification checks skipped by design. | `openspec/config.yaml` |

---
## 6. Assertion Quality (spot-check)

New tests are substantive, not tautological/smoke-only:

- `sales.service.spec.ts:3167` asserts `discountCents=200` / `totalCents=1800` for a 10% PRODUCT_DISCOUNT (not just "engine was called").
- `sales.service.spec.ts:3346` asserts `PROMO_RE_QUOTE` rejection carries `{recomputedTotalCents:1800, expectedTotalCents:2000, discountCents:200}` **and** asserts no persistence/stock/folio side effects.
- `chatbot-api.service.spec.ts:962` asserts canonical requestHash is item-order-independent; `:1041` asserts a true payload change (quantity) produces a different hash → conflict.
- `chatbot-api.service.spec.ts:1186` asserts legacy cached replay (no `discountCents` key) normalizes to `discountCents=0` (WU3-06).
- `parse-idempotency-key.pipe.spec.ts` covers missing/null/non-string/empty/whitespace/oversized/boundary-200.

No tautologies, ghost loops, type-only, or implementation-detail-CSS assertions found.

---

## 7. Next Recommended

→ **Do NOT archive yet.** Fix the single CRITICAL: rewrite `PROGRAM-CONTEXT.md` §4.3 to describe the atomic `acquire → replay | conflict | in_flight` idempotency pattern (SHA-256 `requestHash` over canonical payload, `IDEMPOTENCY_KEY_CONFLICT` 409 and `IDEMPOTENCY_KEY_IN_FLIGHT` 409). Optionally reconcile the spec's "10 endpoints" → "11" text and extend `apply-progress.md` to WU2/WU3. Then re-run `pnpm test` + `pnpm build` and re-verify for archive.

---

## 8. Detailed Evidence

- **Test command**: `pnpm test` → 199 suites / 2735 tests / 0 failures.
- **Build command**: `pnpm build` → `nest build` success.
- **Commits**: `5c6e77e` WU1/Q1 (36 files, +4589), `e2a00ee` WU2/Q3 (12 files, +917/−86), `0ef8267` WU3/Q2+docs (11 files, +681/−23).

### Key files verified

| File | Role | Status |
|---|---|---|
| `prisma/schema.prisma` + `migrations/*_add_payment_detail/` | PaymentDetail model + migration | ✅ |
| `src/admin/payment-details/**` (entity, repo port, prisma repo, service, controller, module, 3 DTOs) | Admin CRUD + validation + isolation | ✅ |
| `src/auth/authorization/domain/permission.ts` | 4 PaymentDetail permissions | ✅ |
| `src/shared/domain/domain-error.ts` + `filters/domain-exception.filter.ts` | `details` + mappings (NO_ACTIVE_PAYMENT_DETAIL→404, DUPLICATE_CLABE→409, PROMO_RE_QUOTE→409) | ✅ |
| `src/chatbot-api/**` (service, controller, `payment-detail.response.ts`, `bot-sale.response.ts`, `register-bot-sale.request.ts`, `parse-idempotency-key.pipe.ts`, `idempotency-key.decorator.ts`) | bot read + idempotency + re-quote | ✅ |
| `src/sales/domain/sale.repository.ts` + `infrastructure/prisma-sale.repository.ts` | atomic bot-sale idempotency port + adapter | ✅ |
| `src/sales/sales.service.ts` | `confirmBotSale` engine re-eval + discountCents | ✅ |
| `openspec/program/whatsapp-ai-chatbot/PROGRAM-CONTEXT.md` | docs drift fix (11 endpoints, atomic idempotency) | ✅ |
