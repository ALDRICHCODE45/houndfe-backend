# Tasks: WhatsApp AI Chatbot — Chatbot API Foundation

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~1,950 across 7 work units |
| 400-line budget risk | High (aggregate); Low–Medium per unit (each ≤400) |
| Chained PRs recommended | N/A — solo dev, no PRs |
| Suggested split | 7 work-unit commits on one feature branch |
| Delivery strategy | solo-dev work-unit commits → main (no formal PR) |
| Chain strategy | feature-branch-chain (single branch, sequential commits) |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: feature-branch-chain
400-line budget risk: High

**Branching**: Single feature branch `feat/whatsapp-ai-chatbot`. One commit per slice. Each commit must be independently revertable, ship green tests, and stay ≤400 changed lines (`additions + deletions`).

### Suggested Work Units

| Unit | Goal | Est. Lines | Depends | Notes |
|------|------|-----------|---------|-------|
| 1 | Prisma schema + `ServiceCredential` entity/repo | ~250 | — | Migration + domain layer; foundation for auth |
| 2 | `ServiceAuthGuard` + CLS wiring | ~200 | 1 | Auth plumbing, no endpoints yet |
| 3 | Catalog search + stock endpoints | ~350 | 2 | First user-visible API surface |
| 4 | Customer phone lookup + delivery metadata | ~300 | 2 | Independent of slice 3 (parallelizable in principle) |
| 5 | Promotion evaluation stub + pricing endpoint | ~250 | 3 | Needs catalog projection from slice 3 |
| 6 | Bot sale creation + idempotency + receipt + order history | ~400 | 4, 5 | Largest unit — watch the budget |
| 7 | Audit logging + rate limiting | ~200 | 2 | Cross-cutting; can land last |

**Parallelizable in principle**: {3, 4} after slice 2; {5, 7} after their parents. Solo dev executes sequentially in the order above.

**Apply batching recommendation**: One slice per `sdd-apply` run. Slice 6 is at the 400-line ceiling — verify line count before commit; split into 6a (sale + idempotency) and 6b (receipt + history) if it overshoots.

---

## Phase 1 — Slice 1: Schema + ServiceCredential Foundation (~250 lines)

**Spec coverage**: Service Credential Authentication (foundation).

- [x] 1.1 Edit `prisma/schema.prisma`: add `ServiceCredential` model (`id, tenantId, name, hashedKey @unique, scopes String[], isActive, lastUsedAt?, rateLimit Int @default(60), createdAt, revokedAt?`) with `@@index([tenantId, isActive])`.
- [x] 1.2 Run `pnpm prisma migrate dev --name add_service_credential` against local DB; verify migration is additive-only (no `DROP`, no `ALTER ... NOT NULL` without default).
- [x] 1.3 Create `src/chatbot-api/domain/service-credential.entity.ts` with static `create()` / `fromPersistence()` per repo convention.
- [x] 1.4 Create `src/chatbot-api/domain/service-credential.repository.ts` interface (`findByHashedKey`, `touchLastUsedAt`).
- [x] 1.5 Create `src/chatbot-api/infrastructure/prisma-service-credential.repository.ts` implementing the interface.
- [x] 1.6 Create `src/chatbot-api/chatbot-api.module.ts` skeleton (providers wired, no controller yet).
- [x] 1.7 Write `service-credential.entity.spec.ts` (create + fromPersistence + scope checks).
- [x] 1.8 Write `prisma-service-credential.repository.spec.ts` with mocked Prisma client.
- [ ] 1.9 **Verify**: `pnpm test src/chatbot-api` green + `pnpm lint` clean → commit `feat(chatbot-api): add ServiceCredential schema and domain entity`.

---

## Phase 2 — Slice 2: ServiceAuthGuard + CLS (~200 lines)

**Spec coverage**: Service Credential Authentication (authorized + revoked/out-of-scope scenarios).
**Depends on**: Slice 1.

- [ ] 2.1 Create `src/chatbot-api/presentation/guards/service-auth.guard.ts`: extract `Authorization: Bearer svc_*`, SHA-256 hash, look up credential, reject if missing/inactive/revoked, set CLS `tenantId` from credential, `userId = service:{credentialId}`.
- [ ] 2.2 Create `src/chatbot-api/presentation/decorators/required-scopes.decorator.ts` + scope check helper used by the guard.
- [ ] 2.3 Wire `ServiceAuthGuard` in `chatbot-api.module.ts` and register CLS dependency.
- [ ] 2.4 Write `service-auth.guard.spec.ts`: authorized bot call passes, revoked credential rejected, out-of-scope branch rejected, missing/invalid header rejected, CLS values asserted via mocked CLS service.
- [ ] 2.5 **Verify**: `pnpm test src/chatbot-api/presentation/guards` green + `pnpm lint` → commit `feat(chatbot-api): add ServiceAuthGuard with CLS tenant resolution`.

---

## Phase 3 — Slice 3: Catalog + Stock Endpoints (~350 lines)

**Spec coverage**: Bot-Safe Catalog Search; Branch Stock Check.
**Depends on**: Slice 2.

- [ ] 3.1 Create DTOs in `src/chatbot-api/presentation/dto/`: `catalog-search.query.ts`, `catalog-item.response.ts` (bot-safe fields only — no cost/margin/supplier/audit), `stock-check.response.ts`.
- [ ] 3.2 Create `src/chatbot-api/application/chatbot-api.service.ts` skeleton + `searchCatalog()` and `checkStock()` methods delegating to `PublicCatalogRepository`.
- [ ] 3.3 Create `src/chatbot-api/presentation/chatbot-api.controller.ts` with `GET /chatbot-api/catalog/search` and `GET /chatbot-api/catalog/:productId/stock` guarded by `ServiceAuthGuard` + `@RequiredScopes('catalog:read')`.
- [ ] 3.4 Implement bot-safe projection mapper: strips cost/margin/supplier/audit; includes price, promo-aware price placeholder, stock summary, package/weight (null for now per design open question).
- [ ] 3.5 Implement stock state derivation: `available | low_stock | out_of_stock | not_managed`; zero stock returns `out_of_stock` with qty `0` (not an error).
- [ ] 3.6 Write `chatbot-api.service.spec.ts` covering: search returns safe projections, no-match returns empty array, stock zero returns `out_of_stock`, unknown product returns not-found.
- [ ] 3.7 Write `chatbot-api.controller.spec.ts` (NestJS `Test.createTestingModule`) covering guard wiring and DTO contracts.
- [ ] 3.8 **Verify**: `pnpm test src/chatbot-api` green + `pnpm lint` → commit `feat(chatbot-api): add catalog search and stock endpoints`.

---

## Phase 4 — Slice 4: Customer Phone Lookup + Delivery Metadata (~300 lines)

**Spec coverage**: Customer Profile by WhatsApp Phone.
**Depends on**: Slice 2 (parallelizable with Slice 3 in principle).

- [ ] 4.1 Edit `prisma/schema.prisma`: add `Customer.preferredPaymentMethod String?` and `@@index([tenantId, phoneCountryCode, phone])`; add `CustomerAddress.visualReferences String?`, `carrierPhone String?`, `label String?`.
- [ ] 4.2 Run `pnpm prisma migrate dev --name add_customer_delivery_metadata`; verify additive-only.
- [ ] 4.3 Modify `src/customers/domain/customer.repository.ts`: add `findByPhone(tenantId, countryCode, phone)` to the interface.
- [ ] 4.4 Modify `src/customers/infrastructure/prisma-customer.repository.ts`: implement `findByPhone` using the new index.
- [ ] 4.5 Extend existing customer entity/spec only if `preferredPaymentMethod` requires setter — minimal touch.
- [ ] 4.6 Add DTOs `customer-lookup.response.ts`, `customer-upsert.request.ts` in `src/chatbot-api/presentation/dto/`.
- [ ] 4.7 Add `chatbot-api.service.ts` methods `findCustomerByPhone()`, `upsertCustomerProfile()`; add controller routes `GET /chatbot-api/customers/by-phone` and `PUT /chatbot-api/customers/by-phone` with `@RequiredScopes('customers:read'|'customers:write')`.
- [ ] 4.8 Write `prisma-customer.repository.spec.ts` extension for `findByPhone` (found + not-found paths).
- [ ] 4.9 Write `chatbot-api.service.spec.ts` extension for customer flows: returning-customer lookup, new-customer creation captures delivery metadata in branch scope.
- [ ] 4.10 **Verify**: `pnpm test src/customers src/chatbot-api` green + `pnpm lint` → commit `feat(chatbot-api): add customer phone lookup and delivery metadata`.

---

## Phase 5 — Slice 5: Promotion Evaluation Stub + Pricing Endpoint (~250 lines)

**Spec coverage**: Promotion-Aware Pricing.
**Depends on**: Slice 3.

- [ ] 5.1 Create `src/promotions/application/evaluate-cart-promotions.use-case.ts`: loads `AUTOMATIC` + `ACTIVE` promotions; evaluates `PRODUCT_DISCOUNT` (percentage / fixed); returns `CartEvaluationResult` with `promotionEvaluationStatus: 'fully_evaluated' | 'needs_human_review'`.
- [ ] 5.2 Define ports `CartItemForEvaluation`, `EvaluatedCartItem`, `CartEvaluationResult` in the promotions module (per design interface).
- [ ] 5.3 Add `chatbot-api.service.ts` method `evaluateCart()` delegating to the use case; add controller route `POST /chatbot-api/pricing/evaluate-cart` with `@RequiredScopes('pricing:evaluate')`.
- [ ] 5.4 Write `evaluate-cart-promotions.use-case.spec.ts`: active percentage promo applies, active fixed promo applies, unsupported promo type → `needs_human_review`, no active promos → `fully_evaluated` with zero discount.
- [ ] 5.5 Extend `chatbot-api.service.spec.ts` for pricing endpoint contract (status surfaces correctly).
- [ ] 5.6 **Verify**: `pnpm test src/promotions src/chatbot-api` green + `pnpm lint` → commit `feat(chatbot-api): add promotion-aware pricing evaluation`.

---

## Phase 6 — Slice 6: Bot Sale Creation + Idempotency + Receipt + Order History (~400 lines)

**Spec coverage**: Bot Sale Registration; Receipt Attachment and Human Payment Confirmation; Order History for Reorder; Audit/Idempotency (idempotency portion).
**Depends on**: Slices 4, 5.
**Budget watch**: This unit is at the 400-line ceiling. If estimate exceeds 400 mid-implementation, split into **6a (sale creation + idempotency)** and **6b (receipt evidence + order history)** with a verify+commit between them.

- [ ] 6.1 Edit `prisma/schema.prisma`: add `SaleDeliveryStatus.SHIPPED` enum value; add `Sale.carrierName String?`, `Sale.trackingRef String?`, `Sale.estimatedDeliveryAt DateTime?`.
- [ ] 6.2 Edit `prisma/schema.prisma`: create `ReceiptEvidence` model (`id, saleId, tenantId, mediaUrl, declaredAmountCents, declaredDate, declaredReference, status(PENDING/CONFIRMED/REJECTED), confirmedByUserId?, confirmedAt?, createdAt`) with `@@index([tenantId, saleId])`.
- [ ] 6.3 Run `pnpm prisma migrate dev --name add_sale_delivery_and_receipt`; verify additive-only and `SHIPPED` is a pure enum extension.
- [ ] 6.4 Modify `src/sales/domain/sale.entity.ts`: add delivery metadata setters (`setDeliveryMetadata({carrierName, trackingRef, estimatedDeliveryAt})`) and reflect in `fromPersistence`.
- [ ] 6.5 Add `chatbot-api.service.ts` methods: `registerBotSale()` (openDraft → addItem → assignCustomer → chargeDraft as `ONLINE` pending-payment), `attachReceipt()`, `setDeliveryMetadata()`, `getOrderHistoryByPhone()`.
- [ ] 6.6 Wire idempotency: reuse existing `SaleIdempotency` mechanism — controller reads `X-Idempotency-Key` header, service short-circuits to cached result on replay.
- [ ] 6.7 Add controller routes: `POST /chatbot-api/sales` (bot sale creation), `POST /chatbot-api/sales/:saleId/receipts`, `PATCH /chatbot-api/sales/:saleId/delivery`, `GET /chatbot-api/customers/by-phone/:phone/orders` — each with the right `@RequiredScopes`.
- [ ] 6.8 Add DTOs: `register-bot-sale.request.ts`, `bot-sale.response.ts`, `attach-receipt.request.ts`, `delivery-metadata.request.ts`, `order-history.response.ts`.
- [ ] 6.9 Update `sale.entity.spec.ts` for delivery metadata setters.
- [ ] 6.10 Extend `chatbot-api.service.spec.ts`: pending transfer sale created and auditable to credential; delivery metadata recorded once paid; receipt attached stays `PENDING` (no auto-mark-paid); human-confirm path records transfer payment and marks paid when fully covered; idempotency replay returns original sale id without duplicate creation; last-order-found returns recent products/delivery/payment/totals; no-prior-orders returns empty array.
- [ ] 6.11 **Verify**: `pnpm test src/sales src/chatbot-api` green + `pnpm lint` + `git diff --stat` shows ≤400 changed lines → commit `feat(chatbot-api): add bot sale creation, receipt evidence, and order history` (or 6a/6b if split).

---

## Phase 7 — Slice 7: Audit Logging + Rate Limiting (~200 lines)

**Spec coverage**: Audit/Idempotency (audit + rate limit portions).
**Depends on**: Slice 2.

- [ ] 7.1 Edit `prisma/schema.prisma`: create `BotAuditLog` model (`id, tenantId, credentialId, action, resourceType, resourceId?, metadata Json?, createdAt`) with `@@index([tenantId, credentialId, createdAt])`.
- [ ] 7.2 Run `pnpm prisma migrate dev --name add_bot_audit_log`; verify additive-only.
- [ ] 7.3 Create `src/chatbot-api/infrastructure/prisma-bot-audit-log.repository.ts` (write-only `append(entry)`).
- [ ] 7.4 Create `src/chatbot-api/presentation/interceptors/bot-audit.interceptor.ts`: on every chatbot-api route, append `{credentialId, action, resourceType, resourceId, metadata}` post-response.
- [ ] 7.5 Extend `service-auth.guard.ts` (or add `RateLimitGuard`) with in-memory sliding-window per-credential rate limit using `ServiceCredential.rateLimit`; reject over-limit with retryable response.
- [ ] 7.6 Wire interceptor + rate-limit globally in `chatbot-api.module.ts` so all routes are covered.
- [ ] 7.7 Write `prisma-bot-audit-log.repository.spec.ts` (single append happy path).
- [ ] 7.8 Write `bot-audit.interceptor.spec.ts`: success path writes audit row; failure path still writes audit row with error metadata.
- [ ] 7.9 Write `rate-limit.spec.ts`: under-limit passes, over-limit rejected within window, window resets after expiry.
- [ ] 7.10 **Verify**: `pnpm test src/chatbot-api` green + `pnpm lint` → commit `feat(chatbot-api): add audit logging and per-credential rate limiting`.

---

## Cross-Slice Notes

- **Prisma migrations**: Each slice that touches schema runs its own `migrate dev` with the named migration above. All deltas are additive (new models, optional fields, new enum value) per design §Migration / Rollout.
- **TDD**: Project config has `tdd: false`. Tests are co-located with implementation per slice — do not defer testing tasks to a separate phase.
- **Bounded-context boundary**: All new code lives under `src/chatbot-api/` except minimal touches in `src/customers/`, `src/sales/`, `src/promotions/`, and `src/app.module.ts` (import `ChatbotApiModule`).
- **Per-slice exit criteria**: targeted tests green, `pnpm lint` clean, `git diff --stat ≤ 400`, conventional-commit message landed on `feat/whatsapp-ai-chatbot`.
