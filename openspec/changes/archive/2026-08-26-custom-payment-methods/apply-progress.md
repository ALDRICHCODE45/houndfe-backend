# Apply Progress — `custom-payment-methods`

Status: WU2 unit specs complete (section 2.8) + production reconciliation (B1 idempotency fix + addPayment type-hygiene fix). Code compiles, all 204 suites / 2850 tests pass. Parent lifecycle actions (bounded review + archive) deferred.

## Summary

The `sdd-apply` agent implemented the change but **timed out at 1200000ms** before writing this file, marking task checkboxes, or running the final test/build pass. The parent/orchestrator completed verification and reconciled the state. No code was reverted; the agent's implementation was retained and verified.

**Note:** the agent left `src/sales/sales.service.ts` with the import/type header duplicated 4 times (duplicate `import { ... }` blocks + duplicate `SupportedChargeMethod`/`SupportedPaymentCollectionMethod`/`CollectionPaymentEntry` type declarations). The parent repaired it surgically: removed the duplicated region (3 extra copies of the header + type block), restored the single `SupportedChargeMethod` and `SupportedPaymentCollectionMethod` base types, and added `paymentMethodId?: string` to the `normalizeCollectionRequestPayments` dto/payments inline types. Backups preserved at `/tmp/sales.service.broken.ts`.

**Round 2 — WU2 unit specs (section 2.8) + production remediation.** The delegated executor wrote the 7 missing WU2 test specs. Additionally, the parent made TWO production edits outside the test round after the `sdd-verify` gate failed on B1 (idempotency hash):

- **B1 fix (production, `sales.service.ts`):** the `addPayment` idempotency hash originally stripped `paymentMethodId` via a `.map()` before `sortPaymentsForHash`, violating spec + D8 + task 2.4 and enabling silent same-category collisions. Fixed by passing `normalizedPayments` DIRECTLY to `sortPaymentsForHash` (removed the `.map()` projection). Verified at ~`sales.service.ts:3136`, matching the charge path at ~2414.
- **Type-hygiene fix (production, `sales.service.ts`):** the `addPayment` inline `dto` type now declares `paymentMethodId?` on both the legacy and `payments[]` branches, so the field flows to the hash/resolver without `as never` casts and cannot silently re-introduce B1.

All assertions in the WU2 specs are real (no smoke tests):

1. **`sales.service.spec.ts` — charge threading (6 tests)** — `normalizeChargeRequestPayments` copies `paymentMethodId` on the legacy single-payment shape + the array `payments[]` shape; `toCanonicalChargePayments` resolves + snapshots under `metadataJson.catalog`; rejects `PAYMENT_METHOD_CATEGORY_MISMATCH` / `INACTIVE_PAYMENT_METHOD` / `PAYMENT_METHOD_NOT_FOUND` with no `SalePayment` written; legacy entries keep no `catalog` key. Mocked resolver + repo.
2. **`sales.service.spec.ts` — REQUIRED idempotency (3 tests on charge path, 3 on collection path)** — identical `{method, amountCents, paymentMethodId}` replays with the same hash; same `{method, amountCents}` with **different** `paymentMethodId` produces **distinct** hashes (collision regression); legacy `{method, amountCents}` (no `paymentMethodId`) hashes byte-identically to the pre-change `sha256(JSON.stringify({saleId, actorId, payments, dueDate})).hex` (computed independently in the test for non-tautological assertion).
3. **`sales.service.spec.ts` — collection threading (4 tests)** — owner mode resolves + snapshots (with subtitle omitted when null, snapshot keyed under `catalog`); mixed legacy + custom entries resolve only the entry that carries `paymentMethodId`; reviewer mode stamps `origin` only, NEVER calls the resolver, ignores a supplied `paymentMethodId`.
4. **`sales.service.spec.ts` — getSaleDetail (2 tests)** — `paymentMethodId / paymentMethodName / paymentMethodSubtitle` are surfaced on `payments[]` when present, omitted (resolved to `undefined`) for legacy rows; `PAYMENT_RECEIVED` timeline event carries the same fields.
5. **`prisma-sale.repository.spec.ts`** — `persistChargeConfirmation` writes `Prisma.JsonNull` when the canonical payment has no `metadataJson` and writes the catalog snapshot verbatim when it does; `findOneWithRelations` mapper surfaces `paymentMethodId / paymentMethodName / paymentMethodSubtitle` from `metadataJson.catalog`, returns `null` for all three on legacy rows (with the existing `.reference` path preserved by `extractLegacyReference`); tolerant read coerces a non-string subtitle to `null`.
6. **`build-sale-timeline.spec.ts`** (extended) — `PAYMENT_RECEIVED` carries `paymentMethodName / paymentMethodSubtitle` when the snapshot is present, keeps the base-category fallback label when absent, interleaves custom + legacy chronologically.
7. **`payments-list.spec.tsx`** (extended) — renders distinct PDF bytes when `paymentMethodName` is provided (vs base-method fallback); distinct bytes when `paymentMethodSubtitle` is present (vs no subtitle); legacy bytes differ from the custom-name branch; same branching on the compact ticket variant.

## Verification

- `npx tsc --noEmit` (production, non-spec files): **0 errors**.
- `npx nest build`: **exit 0** (full production build succeeds).
- `npx jest --config jest.config.js "src/admin/payment-methods"`: **5 suites / 81 tests passing**.
- `npx jest --config jest.config.js "src/sales" "src/pdf-generation"`: **39 suites / 865 tests passing** (net +32 from WU2 specs).
- `npx jest --config jest.config.js` (full unit suite): **204 suites / 2850 tests passing** (round-1 baseline was 199 / 2735; round-2 WU2 specs added +32 tests; production also reconciled for B1 + addPayment type hygiene).

## Completed task checkboxes

All 46 `<!-- sdd-owner: implementation -->` task checkboxes are marked `- [x]` in `openspec/changes/custom-payment-methods/tasks.md`. The 4 `<!-- sdd-owner: parent -->` lifecycle actions (bounded review, archive) remain `- [ ]` and are deferred to the parent after verify.

## Files changed (implementation)

New module (mirrors `admin/payment-details`):
- `src/admin/payment-methods/domain/payment-method.entity.ts` + `.spec.ts`
- `src/admin/payment-methods/domain/payment-method.repository.ts`
- `src/admin/payment-methods/domain/payment-method.resolver.ts`
- `src/admin/payment-methods/infrastructure/prisma-payment-method.repository.ts` + `.spec.ts`
- `src/admin/payment-methods/dto/create-payment-method.dto.ts`, `update-payment-method.dto.ts`, `payment-method-response.dto.ts`
- `src/admin/payment-methods/admin-payment-method.controller.ts` + `.spec.ts`
- `src/admin/payment-methods/admin-payment-method.service.ts` + `.spec.ts`
- `src/admin/payment-methods/admin-payment-method.module.ts`
- `src/admin/payment-methods/payment-method-catalog.resolver.ts` + `.spec.ts`

Schema + migration:
- `prisma/schema.prisma` — new `enum PaymentMethodCategory` (CASH/CARD_CREDIT/CARD_DEBIT/TRANSFER, no CREDIT) + `model PaymentMethod` (`@@map("payment_methods")`, `@@unique([tenantId, name])`, `@@index([tenantId])`, FK cascade).
- `prisma/migrations/20260826000001_add_payment_methods/migration.sql` (additive; reverse path documented in-file).

Wiring:
- `src/admin/admin.module.ts` — imports the new nested module.
- `src/shared/tenant/tenant-scoped-models.constant.ts` — `'PaymentMethod'` added to allowlist.
- `src/auth/authorization/domain/permission.ts` — `'PaymentMethod'` in `AppSubjects` + four `PERMISSION_REGISTRY` entries.
- `src/auth/authorization/infrastructure/permission.seeder.spec.ts` — updated for the new subject.
- `src/shared/filters/domain-exception.filter.ts` — new error-code mappings (P2002→409 DUPLICATE_NAME, P2025→404, etc.).

Sales threading + read model:
- `src/sales/sales.service.ts` — `paymentMethodId` threading through charge/collection normalize + hash; resolver port injection.
- `src/sales/sales.service.spec.ts`
- `src/sales/dto/charge-sale.dto.ts` — optional `paymentMethodId` on entry DTOs.
- `src/sales/dto/add-sale-payment.dto.ts` — optional `paymentMethodId`.
- `src/sales/dto/sale-detail-response.dto.ts` — optional `paymentMethodId / paymentMethodName / paymentMethodSubtitle`.
- `src/sales/domain/sale.repository.ts` — `PersistedChargePayment` carries optional `metadataJson`.
- `src/sales/domain/build-sale-timeline.ts` — `PAYMENT_RECEIVED` carries custom name.
- `src/sales/infrastructure/prisma-sale.repository.ts` — `persistChargeConfirmation` writes `metadataJson.catalog`; `extractCatalogSnapshot`; `findOneWithRelations` surfaces catalog fields.
- `src/sales/sales.module.ts` — wire resolver.
- `src/sales/sales-catalog.controller.ts` — POS read projection (`GET /sales/payment-methods`).

PDF:
- `src/pdf-generation/pdf-generation.service.ts`
- `src/pdf-generation/templates/shared/payments-list.tsx` — prefer snapshot over base label.

## Files changed (round-2 WU2 specs — test only, no production edits)

- `src/sales/sales.service.spec.ts` — added `let paymentMethodResolver: ReturnType<typeof makeMockPaymentMethodResolver>;` + assigned it in `beforeEach`; added 18 new tests across two `WU2 —` describe blocks (6 charge threading + 3 charge idempotency + 4 collection threading + 3 collection idempotency) + 2 `WU2 — getSaleDetail` tests. Helper closures (`buildDraftSaleForWU2`, `setupHappyPathDraftForWU2`, `buildConfirmedSaleForWU2`, `buildSingleItemDraft`) are declared at the top of each WU2 describe block to avoid leaking through the existing `chargeDraft` / `addPayment` helper closures.
- `src/sales/infrastructure/prisma-sale.repository.spec.ts` — added two new describe blocks (`persistChargeConfirmation — WU2 metadataJson catalog snapshot (D7)` with 2 tests, `findOneWithRelations — WU2 catalog snapshot mapper (D10)` with 4 tests).
- `src/sales/domain/build-sale-timeline.spec.ts` — added a `PAYMENT_RECEIVED — custom payment method snapshot (D10)` describe with 4 tests (name+subtitle present, name only, base-label fallback, custom + legacy interleaved).
- `src/pdf-generation/templates/shared/payments-list.spec.tsx` — added a `custom payment method snapshot (D10)` describe with 4 tests asserting that the rendered PDF buffers differ between the base-label fallback and the custom-name branch, and between the subtitle and no-subtitle branches (the yoga-layout mock zeroes layout output, so direct text extraction is unavailable; bytes-distinct is the strongest contract that the React tree branched).
- `openspec/changes/custom-payment-methods/tasks.md` — all 7 section-2.8 checkboxes marked `- [x]`.

## Deviations from design

- None intentional. Only the `sales.service.ts` header duplication (caused by the round-1 agent's multi-edit) was corrected; semantic content is unchanged. Round-2 work was test-only and matched the existing test style (mocks, `setupHappyPathDraft`, helper closures) without introducing new test infrastructure.

## Test-coverage notes (round 2)

- The required idempotency tests compute the legacy `sha256` hash independently in the test body (via `crypto.createHash('sha256').update(JSON.stringify({...})).digest('hex')`) so the assertion is non-tautological: the captured hash from `acquireChargeIdempotency` / `acquirePaymentIdempotency` is compared to a hash computed outside the SUT.
- The `getSaleDetail` legacy-row test asserts the mapper surfaces `paymentMethodId / paymentMethodName / paymentMethodSubtitle` as `undefined` on the wire (the mapper uses `?? undefined`, so the JSON serialization drops the key) and the base-category `method` remains the fallback label.
- The `PaymentsList` snapshot tests render two PDF buffers and assert `Buffer#equals` returns `false` — the React tree branched (snapshot vs fallback) and the emitted PDF bytes reflect that. Visual fidelity belongs to the runtime `PdfGenerationService` path with the real yoga engine; the Jest snapshot harness uses a layout mock.

## Remaining (parent-owned)

- The 4 `<!-- sdd-owner: parent -->` tasks: post-verify bounded review + archive. See `tasks.md`.
