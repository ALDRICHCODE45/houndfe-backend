# Verify Report — `custom-payment-methods`

Status: **PASS** (re-verification — both prior CRITICAL blockers resolved; archive-ready pending parent lifecycle actions)

Verifier: SDD verify executor (direct inline, no child agents)
Date: 2026-08-26 (re-run)

---

## Structured status

Reconstructed manually (no native `gentle-ai sdd-status` binary in scope; store is `openspec` on disk, so disk is authoritative).

```yaml
schemaName: spec-driven
changeName: custom-payment-methods
artifactStore: openspec
planningHome:
  root: /Users/aldrich_code45/Desktop/workspace/vue/houndfe-backend
  changesDir: openspec/changes
changeRoot: openspec/changes/custom-payment-methods
artifactPaths:
  proposal: [openspec/changes/custom-payment-methods/proposal.md]
  specs:
    - openspec/changes/custom-payment-methods/specs/payment-methods/spec.md
    - openspec/changes/custom-payment-methods/specs/sales/spec.md
    - openspec/changes/custom-payment-methods/specs/sale-payments/spec.md
  design: [openspec/changes/custom-payment-methods/design.md]
  tasks: [openspec/changes/custom-payment-methods/tasks.md]
  applyProgress: [openspec/changes/custom-payment-methods/apply-progress.md]
  verifyReport: [openspec/changes/custom-payment-methods/verify-report.md]
  syncReport: []
artifacts:
  proposal: done
  specs: done
  design: done
  tasks: done
  applyProgress: done
  verifyReport: done
  syncReport: missing
taskProgress:
  total: 46
  complete: 46
  remaining: 0
  unchecked: []
deferredParentActions:
  total: 4
  complete: 0
  remaining: 4
  unchecked:
    - '- [ ] After the implementation PR is merged, run `pnpm test` ... <!-- sdd-owner: parent -->'
    - '- [ ] Run `pnpm build` and confirm a clean compile ... <!-- sdd-owner: parent -->'
    - '- [ ] Perform a bounded review against the design''s WU1/WU2 revert boundaries ... <!-- sdd-owner: parent -->'
    - '- [ ] Apply the change lifecycle: archive `openspec/changes/custom-payment-methods/` ... <!-- sdd-owner: parent -->'
taskArtifactErrors: []
applyState: all_done
dependencies:
  apply: all_done
  verify: all_done
  sync: ready
  archive: ready
actionContext:
  mode: repo-local
  workspaceRoot: /Users/aldrich_code45/Desktop/workspace/vue/houndfe-backend
  allowedEditRoots: [/Users/aldrich_code45/Desktop/workspace/vue/houndfe-backend]
  warnings: []
nextRecommended: parent-lifecycle
isNonAuthoritative: false
```

`actionContext.mode` is `repo-local` (not `workspace-planning`), so the empty-`allowedEditRoots` guard does not apply. Implementation ownership is proven inside the repo (git status shows the files modified/untracked under the authoritative workspace).

---

## 1. Prior CRITICAL blockers — re-verification result

### B1 — Add-payment idempotency hash drops `paymentMethodId` → RESOLVED

`src/sales/sales.service.ts` now passes `normalizedPayments` directly to `sortPaymentsForHash` on **both** paths:

- L2414 (charge): `const hashPayments = sortPaymentsForHash(normalizedPayments);` — no `.map()`.
- L3136 (addPayment): `const hashPayments = sortPaymentsForHash(normalizedPayments);` — no `.map()`.

The prior `.map(({ method, amountCents, reference }) => ...)` at the addPayment site is gone. `sortPaymentsForHash` (L385-391) appends `|<paymentMethodId>` to the sort key only when `paymentMethodId` is truthy, so legacy payloads hash byte-identically (empty suffix; `JSON.stringify` drops `undefined`).

`CollectionPaymentEntry` (L98-105) declares `paymentMethodId?: string`, and `normalizeCollectionRequestPayments` (L421-490) copies `paymentMethodId` in **both** the legacy single-payment branch and the `payments[]` array branch. The `add-sale-payment.dto.ts` carries `paymentMethodId` on both `AddSalePaymentDto` and `AddSalePaymentEntryDto` (both `@IsOptional() @IsUUID('all', { message: 'INVALID_PAYMENT_METHOD_ID' })`), and the controller passes the validated DTO through unchanged. **Verdict: FIXED.**

### B2 — Work Unit 2 test tasks (2.8) marked `- [x]` but not implemented → RESOLVED

All 7 section-2.8 test sub-tasks are now implemented with real assertions (see §4). The three previously-untouched spec files are now modified:

- `src/sales/sales.service.spec.ts` — charge threading (6), charge idempotency (3), collection threading (4), collection idempotency (3), getSaleDetail (2).
- `src/sales/infrastructure/prisma-sale.repository.spec.ts` — `persistChargeConfirmation` metadataJson (2) + `findOneWithRelations` catalog mapper (4).
- `src/sales/domain/build-sale-timeline.spec.ts` — custom-name/fallback (4).
- `src/pdf-generation/templates/shared/payments-list.spec.tsx` — custom-name/fallback (4).

**Verdict: FIXED.**

---

## 2. Task checkbox verification

- All **46** `<!-- sdd-owner: implementation -->` checkboxes in `tasks.md` are `- [x]`.
- A `^\s*- \[ \]` scan returns **only** the 4 parent-owned lifecycle lines; a `^\s*- \[ \].*sdd-owner: implementation` scan returns **nothing**. No unchecked implementation tasks remain.
- Ownership markers are well-formed: exactly 50 `sdd-owner` markers — 46 `implementation`, 4 `parent`; none malformed/non-terminal (`taskArtifactErrors: []`).

The 4 remaining unchecked lines are **OUT of verify scope** (parent-owned lifecycle, `<!-- sdd-owner: parent -->`):

```text
- [ ] After the implementation PR is merged, run `pnpm test` at the repo root and confirm all unit specs ... <!-- sdd-owner: parent -->
- [ ] Run `pnpm build` and confirm a clean compile ... <!-- sdd-owner: parent -->
- [ ] Perform a bounded review against the design's WU1/WU2 revert boundaries ... <!-- sdd-owner: parent -->
- [ ] Apply the change lifecycle: archive `openspec/changes/custom-payment-methods/` per the OpenSpec archive rule, then close the SDD change. <!-- sdd-owner: parent -->
```

These are deferred parent actions, not implementation gaps; archive is `ready` but the parent must still execute them.

---

## 3. Spec coverage

The prior verify's only FAIL row (idempotency hash) now passes.

| Requirement | Verdict |
|---|---|
| PaymentMethod Model (enum no CREDIT, `@@unique([tenantId,name])`, `@@index([tenantId])`, `@@map("payment_methods")`, FK cascade, `SalePaymentMethod` unchanged) | PASS |
| Field Validation (name 1..60 trim, category 4-value, subtitle ≤120/null, trim) | PASS |
| Admin CRUD (5 routes, guards, 404 not 403, logical delete, reactivation, `updatedAt DESC`) | PASS |
| RBAC (4 permissions, `AppSubjects`, `TENANT_SCOPED_MODELS`) | PASS |
| Tenant isolation (allowlist + `where:{id,tenantId}` defense-in-depth) | PASS |
| POS read projection (`GET /sales/payment-methods`, `read:Sale`, active-only, no `metadataJson`) | PASS |
| Charge resolves custom method + snapshots `metadataJson.catalog` | PASS |
| Sale detail / timeline / receipt expose custom name + legacy fallback | PASS (now test-covered) |
| Add-payment resolves + snapshots (owner), bot reviewer unaffected | PASS (now test-covered) |
| **Idempotency hash includes `paymentMethodId`** (charge AND add-payment) | **PASS (was FAIL — B1 fixed)** |
| Snapshot semantics (no rewrite on rename/deactivate, opaque ref) | PASS |
| Refunds stay base category (`normalizeRefundMethod` unchanged) | PASS |

The `sale-payments/spec.md` "Idempotency Hashes Include paymentMethodId" requirement — including the "Same category, different paymentMethodId do not collide" scenario — is satisfied by the L3136 fix and covered by the new non-tautological tests.

---

## 4. Assertion quality (re-verification of the previously-missing specs)

Strict TDD is **not** active (`openspec/config.yaml` → `apply.tdd: false`), but assertion quality was still audited on the new/restored specs.

- **`sales.service.spec.ts` idempotency (charge + addPayment)** — real, non-tautological. The collision test captures two hashes for `{ method, amountCents }` with different `paymentMethodId` (`pm-A` vs `pm-B`) and asserts `hashA !== hashB`. The legacy test computes `sha256(JSON.stringify({ saleId, actorId, payments: [{ method, amountCents }], ... }))` **independently** in the test body (via `crypto.createHash`) and compares to the SUT-captured hash — not a re-assertion of SUT output. PASS.
- **`build-sale-timeline.spec.ts`** — asserts `paymentMethodName`/`paymentMethodSubtitle` present on the `PAYMENT_RECEIVED` event when snapshot exists, `undefined` when absent, base-category label preserved, and custom/legacy interleaving. PASS (not tautological).
- **`payments-list.spec.tsx`** — renders two variants and asserts `Buffer#equals` returns `false` (branch divergence). Uses the layout mock so text extraction is unavailable, but byte-distinctness across snapshot-vs-fallback and subtitle-vs-no-subtitle branches is a legitimate behavioral assertion. PASS.

No ghost loops, type-only assertions, smoke-only tests, or implementation-detail CSS assertions found in the new specs.

---

## 5. Test / validation commands (re-run)

| Command | Result |
|---|---|
| `npx nest build` | **exit 0** (production build) |
| `npx tsc --noEmit -p tsconfig.build.json` | **exit 0** (production, non-spec) |
| `npx jest --config jest.config.js "src/sales" "src/pdf-generation" "src/admin/payment-methods"` | **44 suites / 946 tests PASS** (exit 0) |
| `npx jest --config jest.config.js` (full unit) | **204 suites / 2850 tests PASS** (exit 0) |

Reproducible — matches the claims in the re-verification request and apply-progress.md. Integration tests were not run (require Postgres via docker compose, unchanged from prior verify).

---

## 6. Review workload verification

- `tasks.md` Review Workload Forecast records `Size exception: ACCEPTED` (user-approved 2026-08-26) and `Chain strategy: single-pr`. ✓
- No chained-PR boundary expected; implementation is a single change (WU1 + WU2 in one PR). ✓
- No scope creep beyond the WU1/WU2 task list observed. ✓

---

## 7. Non-blocking findings (WARNING)

These do not block archive readiness, but should be reconciled by the parent for traceability.

### W1 — apply-progress.md does not record the B1 production fix

`apply-progress.md` documents "Round 2 — WU2 unit specs" and explicitly states "no production code touched", but B1 was a **production** fix (`sales.service.ts:3136` `.map()` → direct). The idempotency-hash fix is present in the code and verified, but is not recorded in `apply-progress.md`. The parent should append a round-3/B1 note so the progress log matches the actual code history.

### W2 — `addPayment` inline DTO type omits `paymentMethodId`

`chargeDraft` takes the typed `ChargeSaleDto` (which declares `paymentMethodId`), but `addPayment` takes an inline `dto` object type that does **not** declare `paymentMethodId` (nor on its `payments[]` entries). Functionally correct — the controller passes the full `AddSalePaymentDto` (which carries `paymentMethodId`), `normalizeCollectionRequestPayments` reads it at runtime, and the collision/idempotency tests prove it flows into the hash — but the tests must use `as never` casts to inject the field. This is a type-hygiene gap: a future edit could drop `paymentMethodId` from the DTO with no compile error and silently re-introduce B1. Recommend widening the `addPayment` inline type (or typing it as `AddSalePaymentDto`) to match.

---

## Exact blockers

**None.** The two prior CRITICAL blockers (B1 idempotency hash, B2 missing WU2 tests) are resolved and independently re-verified. No unchecked implementation tasks remain. Remaining work is parent-owned lifecycle (post-merge `pnpm test`/`pnpm build`, bounded WU1/WU2 revert review, archive).
