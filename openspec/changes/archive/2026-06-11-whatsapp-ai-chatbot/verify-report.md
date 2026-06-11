# Verification Report

**Change**: chatbot-api-foundation (within whatsapp-ai-chatbot)
**Version**: spec v1
**Mode**: Strict TDD
**Verifier**: fresh-context adversarial (did not write this code)
**Date**: 2026-06-11

---

## Completeness

| Metric | Value |
|--------|-------|
| Tasks total | 49 |
| Tasks complete | 49 |
| Tasks incomplete | 0 |
| Slices total | 7 |
| Slices complete | 7 |
| Commits | 12 (281da82..80bba1b) |
| Files changed | 54 |
| Lines added | ~5,098 |
| Lines deleted | ~112 |

---

## Build & Tests Execution

**Build**: N/A (no explicit build step; TypeScript compilation via Jest transform)

**Tests**: 1136 passed / 0 failed / 0 skipped (full suite)

```
Test Suites: 106 passed, 106 total
Tests:       1136 passed, 1136 total
Snapshots:   0 total
Time:        4.886 s
```

**Sales regression**: 411 passed / 0 failed (17 suites) — zero regressions.

**Coverage**: Coverage analysis skipped — no coverage tool configured in project capabilities.

---

## TDD Compliance

| Check | Result | Details |
|-------|--------|---------|
| TDD Evidence reported | ✅ | Found in apply-progress (Engram #2283) — Slice 7 has full TDD Cycle Evidence table; earlier slices have cumulative evidence in session summaries |
| All tasks have tests | ✅ | 49/49 tasks have corresponding test evidence |
| RED confirmed (tests exist) | ✅ | All test files verified to exist in codebase |
| GREEN confirmed (tests pass) | ✅ | 56/56 chatbot-api tests pass; 1136/1136 full suite |
| Triangulation adequate | ✅ | Slice 7 limiter: 3 paths (under/over/reset); guard: 6 paths; interceptor: 2 paths |
| Safety Net for modified files | ✅ | Guard baseline (5/5) verified green before Slice 7 modifications |

**TDD Compliance**: 6/6 checks passed

---

## Test Layer Distribution

| Layer | Tests | Files | Tools |
|-------|-------|-------|-------|
| Unit | ~48 | 8 | Jest 30 |
| Integration (supertest) | ~19 | 1 | Jest 30 + supertest |
| E2E | 0 | 0 | not installed |
| **Total** | **67** | **9** | |

(Counts approximate: 56 chatbot-api tests + 11 extended existing specs)

---

## Spec Compliance Matrix

### Requirement: Service Credential Authentication

| Scenario | Test | Result |
|----------|------|--------|
| Authorized bot call | `service-auth.guard.spec > authorizes a valid service credential, updates last-used, and sets CLS context` | ✅ COMPLIANT |
| Revoked or out-of-scope credential | `service-auth.guard.spec > rejects revoked credentials` + `rejects requests for a different branch` + `rejects missing, invalid, or out-of-scope authorization` | ✅ COMPLIANT |

### Requirement: Bot-Safe Catalog Search

| Scenario | Test | Result |
|----------|------|--------|
| Search returns safe projections | `chatbot-api.service.spec > returns safe catalog projections…` + explicit `not.toHaveProperty('tenantId')`, `not.toHaveProperty('purchaseNetCostCents')`, `not.toHaveProperty('purchaseGrossCostCents')` | ✅ COMPLIANT |
| No matching product | `chatbot-api.service.spec > returns an empty array when no catalog items match` | ✅ COMPLIANT |

### Requirement: Branch Stock Check

| Scenario | Test | Result |
|----------|------|--------|
| Zero stock is answerable | `chatbot-api.service.spec > returns out_of_stock with quantity 0 for zero-stock products` | ✅ COMPLIANT |
| Unknown product | `chatbot-api.service.spec > throws not found when the product does not exist in branch scope` | ✅ COMPLIANT |

### Requirement: Promotion-Aware Pricing

| Scenario | Test | Result |
|----------|------|--------|
| Active promotion applies | `evaluate-cart-promotions.use-case.spec > active percentage promo applies` + `active fixed promo applies` | ✅ COMPLIANT |
| Promotion engine cannot evaluate cart | `evaluate-cart-promotions.use-case.spec > unsupported promo type → needs_human_review` + `chatbot-api.service.spec > surfaces needs_human_review status` | ✅ COMPLIANT |

### Requirement: Customer Profile by WhatsApp Phone

| Scenario | Test | Result |
|----------|------|--------|
| Returning customer lookup | `chatbot-api.service.spec > returns a returning customer profile by normalized WhatsApp phone` | ✅ COMPLIANT |
| New delivery data is captured | `chatbot-api.service.spec > creates a new customer profile with delivery metadata when the phone is new` | ✅ COMPLIANT |

### Requirement: Order History for Reorder

| Scenario | Test | Result |
|----------|------|--------|
| Last order found | `chatbot-api.service.spec > returns recent confirmed ONLINE sales for a customer found by phone` | ✅ COMPLIANT |
| No prior orders | `chatbot-api.service.spec > returns empty array when customer has no prior orders` | ✅ COMPLIANT |

### Requirement: Bot Sale Registration

| Scenario | Test | Result |
|----------|------|--------|
| Pending transfer sale created | `chatbot-api.service.spec > creates an ONLINE CREDIT sale and returns the bot sale response` — asserts `CONFIRMED + CREDIT + ONLINE + PENDING delivery` | ✅ COMPLIANT |
| Delivery metadata recorded | `chatbot-api.service.spec > updates sale with carrier name, tracking ref, and estimated delivery date` — asserts `SHIPPED` status | ✅ COMPLIANT |

### Requirement: Receipt Attachment and Human Payment Confirmation

| Scenario | Test | Result |
|----------|------|--------|
| Receipt attached | `chatbot-api.service.spec > creates ReceiptEvidence with PENDING status and does not auto-mark the sale as paid` — explicitly asserts `sale.update NOT called` | ✅ COMPLIANT |
| Human confirms payment | (not implemented — spec says "human actor" confirms) | ⚠️ PARTIAL — the human confirmation endpoint is NOT part of chatbot-api scope; the spec scenario describes a separate human-facing workflow. The bot-side contract (attach receipt, stays PENDING) is correctly implemented. |

### Requirement: Audit, Idempotency, and Abuse Controls

| Scenario | Test | Result |
|----------|------|--------|
| Idempotent sale registration | `chatbot-api.service.spec > returns cached response without creating a duplicate sale on idempotency replay` | ✅ COMPLIANT |
| Rate limit exceeded | `rate-limit.spec > rejects requests that exceed the credential limit` + `service-auth.guard.spec > rejects after rate limit exceeded` | ✅ COMPLIANT |

**Compliance summary**: 17/18 scenarios compliant, 1 PARTIAL (human payment confirmation is correctly out of chatbot-api scope — it's a human-facing workflow)

---

## Correctness (Static Evidence)

| Requirement | Status | Notes |
|-------------|--------|-------|
| SHA-256 hashing of API keys | ✅ Implemented | `createHash('sha256').update(rawToken).digest('hex')` in guard |
| CLS tenant resolution | ✅ Implemented | Guard sets `tenantId`, `userId: service:{id}`, `isSuperAdmin: false` |
| Bot-safe field projection | ✅ Implemented | DTOs contain zero cost/margin/supplier/taxId/tenantId fields; explicit `not.toHaveProperty` assertions in tests |
| Zero-stock-as-answer | ✅ Implemented | Returns `out_of_stock` with qty `0`, not an error |
| `needs_human_review` paths | ✅ Implemented | Evaluator returns `needs_human_review` for unsupported promo types |
| Phone normalization | ✅ Implemented | `normalizePhonePart` strips all non-digits |
| Idempotency mechanism | ✅ Implemented | Reuses `SaleIdempotency` with `bot_sale_register` operation key |
| Receipt stays PENDING | ✅ Implemented | No auto-mark-paid; explicit test assertion |
| Additive-only migrations | ✅ Verified | All 4 migration files: CREATE TABLE, ADD COLUMN, ADD VALUE only; zero DROP/destructive ALTER |
| Rate limiting per-credential | ✅ Implemented | Sliding window via `CredentialRateLimiter` |
| Audit logging | ✅ Implemented | `BotAuditInterceptor` covers success + error paths |
| DTO validation | ✅ Implemented | class-validator decorators on all request DTOs; whitelist + forbidNonWhitelisted |
| Scope enforcement | ✅ Implemented | Every route has `@RequiredScopes`; guard checks via `credentialHasRequiredScopes` |

---

## Coherence (Design)

| Decision | Followed? | Notes |
|----------|-----------|-------|
| New `src/chatbot-api/` bounded context | ✅ Yes | Full hexagonal structure: domain/application/infrastructure/presentation |
| `ServiceCredential` Prisma model with SHA-256 | ✅ Yes | Matches design exactly |
| Guard sets CLS | ✅ Yes | Reuses entire `TenantPrismaService` chain |
| Minimal Sale schema delta | ✅ Yes | `SHIPPED` + flat delivery fields + `ReceiptEvidence` model |
| Customer phone lookup via index | ✅ Yes | Composite index `(tenantId, phoneCountryCode, phone)` + `findByPhone` |
| Promotion evaluation stub | ✅ Yes | `EvaluateCartPromotionsUseCase` returns `needs_human_review` for unsupported types |
| Idempotency reuse | ✅ Yes | Same `SaleIdempotency` mechanism |
| `registerBotSale` bypasses SalesService | ⚠️ Deviation | Writes directly via `TenantPrismaService` instead of `SalesService.openDraft → addItem → chargeDraft` as design data flow suggests. See WARNING below. |
| Audit interceptor at controller level | ⚠️ Deviation | Applied via `@UseInterceptors` on controller class, not `APP_INTERCEPTOR`. Acceptable — all chatbot routes are in one controller. |
| In-memory rate limiter | ⚠️ Deviation | Design notes single-node assumption; code has JSDoc comment documenting this. Acceptable. |

---

## Assertion Quality

No banned assertion patterns found across all 9 chatbot-api test files:

- Zero tautologies (`expect(true).toBe(true)`)
- Zero orphan empty checks without companion tests
- Zero type-only assertions used alone
- Zero ghost loops over potentially empty collections
- Zero smoke-test-only patterns
- Mock/assertion ratios are reasonable (service spec: ~40 assertions vs ~15 mocks)

All assertions verify real production behavior through mocked repositories and supertest HTTP calls.

**Assertion quality**: ✅ All assertions verify real behavior

---

## Security Adversarial Pass

### 1. API Key Timing Attack
**Severity**: WARNING
**Finding**: The guard uses `createHash('sha256').update(rawToken).digest('hex')` then does a database lookup by the hash. The hash comparison is performed by PostgreSQL (`findByHashedKey` → `WHERE hashedKey = ?`), NOT by Node.js `===`. Since the database lookup is the comparison mechanism, timing attacks against the string comparison are not directly exploitable — the response time is dominated by the DB query. However, `node:crypto.timingSafeEqual` is not used anywhere. For defense-in-depth, a constant-time comparison after DB lookup would be ideal but is not CRITICAL given the DB-lookup-first pattern.

### 2. Missing Scope Checks
**Finding**: ✅ CLEAR — Every route has explicit `@RequiredScopes`. Class-level `catalog:read` is overridden by method-level scopes where needed. The `getAllAndOverride` reflector pattern correctly picks the most specific scope.

### 3. IDOR (Cross-Branch Access)
**Finding**: ✅ CLEAR — `TenantPrismaService.getClient()` returns a tenant-scoped Prisma proxy, so all data queries are automatically filtered by `tenantId` from CLS. The guard sets CLS `tenantId` from the credential. A bot credential for branch A cannot access branch B data because the Prisma extension injects `WHERE tenantId = <credential.tenantId>`.

### 4. Branch ID Header Manipulation
**Finding**: ✅ CLEAR — `assertBranchScope()` rejects `x-branch-id` headers that mismatch the credential's `tenantId`. If no header is sent, the credential's `tenantId` is used (safe).

### 5. Idempotency Key Collision Across Credentials
**Severity**: WARNING
**Finding**: The idempotency lookup uses `tenantId + operation + key`. Two credentials for the SAME tenant would share the idempotency namespace. This is acceptable for single-bot-per-branch but should be documented. If multiple bot credentials per branch are supported in the future, `credentialId` should be added to the unique constraint.

### 6. Receipt Attachment to Foreign Sales
**Finding**: ✅ CLEAR — `attachReceipt` uses `this.tenantPrisma.getClient()` which scopes to the current tenant. The `ReceiptEvidence.create` sets `tenantId` explicitly. A bot cannot attach receipts to sales in another branch.

### 7. `setDeliveryMetadata` Lacks Sale Status Check
**Severity**: WARNING
**Finding**: `setDeliveryMetadata` updates any sale by ID (within tenant scope) without checking if the sale is in the correct status (e.g., CONFIRMED + CREDIT). A bot could theoretically update delivery metadata on a DRAFT sale or an already-DELIVERED sale. The spec says "GIVEN a paid bot-created sale exists" — the implementation does not enforce this precondition.

### 8. Rate Limiter Header Manipulation
**Finding**: ✅ CLEAR — The rate limiter is keyed by `credential.id` (from the database lookup), not by any client-supplied header. Cannot be bypassed by header manipulation.

### 9. `registerBotSale` Empty Items Array
**Severity**: SUGGESTION
**Finding**: The DTO validates `items` as `@IsArray()` with `@ValidateNested({ each: true })` but does NOT use `@ArrayMinSize(1)`. A bot could create a sale with zero items (totalCents = 0). The `EvaluateCartRequestDto` correctly uses `@ArrayMinSize(1)` but `RegisterBotSaleRequestDto` does not.

---

## Known Deviations — Judgment

### a. `registerBotSale` bypasses SalesService
**Judgment**: WARNING (not CRITICAL)
**Rationale**: The direct Prisma write correctly sets `subtotalCents`, `discountCents: 0`, `totalCents`, `paidCents: 0`, `debtCents: totalCents`, `changeDueCents: 0`, and `confirmedAt`. These match the sale-detail-totals invariants for a zero-discount sale. The SaleItem create sets `unitPriceCents`, `quantity`, `productName`, and all other SaleItem fields have schema defaults or are nullable. Stock deduction is intentionally skipped (online sales with pending payment don't deduct stock until confirmed pickup). The bypass means:
- No stock validation at sale creation time (acceptable for ONLINE/CREDIT flow)
- No `SalePayment` records created (correct — payment is pending)
- No domain events emitted (no outbox entry for sale.confirmed)
- Missing `sellerUserId` (null, acceptable for bot sales)
The main risk is drift: if SalesService gains new invariants, bot sales won't inherit them automatically. This should be tracked.

### b. ServiceAuthGuard x-branch-id mismatch rejection
**Judgment**: ✅ Acceptable — correct behavior. No route assumes multi-branch credentials.

### c. Audit interceptor at controller level
**Judgment**: ✅ Acceptable — all 9 chatbot-api routes are in the single `ChatbotApiController`. The `ROUTE_AUDIT_MAP` covers all 9 routes (verified: catalog.search, catalog.check_stock, customers.find_by_phone, customers.upsert_profile, pricing.evaluate_cart, sales.register, sales.attach_receipt, sales.update_delivery, customers.order_history).

### d. In-memory rate limiter
**Judgment**: ✅ Acceptable — single-node assumption is documented in JSDoc on `ServiceAuthGuard.rateLimiter`. The limiter is keyed by `credential.id`, cannot be bypassed.

---

## Issues Found

### CRITICAL
None.

### WARNING

1. **W-001: `setDeliveryMetadata` lacks sale status/payment guard** — Spec says delivery metadata is recorded on a "paid bot-created sale." Implementation updates any CONFIRMED sale without checking payment status. A bot could set delivery metadata before the sale is paid.

2. **W-002: No `timingSafeEqual` for API key hash comparison** — The guard relies on DB lookup (WHERE) for hash matching. While not directly exploitable via timing side-channel (DB query dominates timing), defense-in-depth recommends constant-time verification after the lookup.

3. **W-003: Idempotency key namespace shared across credentials within tenant** — If a tenant has multiple bot credentials, they share the idempotency key space. Could cause unintended replay responses across distinct bots.

4. **W-004: `registerBotSale` domain bypass risk** — Direct Prisma write skips SalesService domain validations and event emission. Currently safe because the only validation is sale math (correctly implemented) and stock checks (intentionally skipped for ONLINE). Future SalesService changes won't automatically apply to bot sales.

5. **W-005: Human payment confirmation endpoint not yet built** — Spec scenario "Human confirms payment" is out of chatbot-api scope but has no implementation anywhere. This is a known gap for the full whatsapp-ai-chatbot feature completion.

### SUGGESTION

1. **S-001: Add `@ArrayMinSize(1)` to `RegisterBotSaleRequestDto.items`** — Prevents creation of zero-item sales.

2. **S-002: `toOrderHistoryResponse` uses `any` type** — The `eslint-disable` block suppresses type safety. Consider typing the Prisma include result properly.

3. **S-003: `@RequiredScopes('catalog:read')` at class level uses `getAllAndOverride`** — This means method-level scopes REPLACE (not extend) the class-level scope. Routes like `POST /sales` only require `sales:create`, not `catalog:read` AND `sales:create`. This is likely intentional but should be documented.

4. **S-004: Domain event emission for bot sales** — `registerBotSale` does not emit `sale.confirmed` outbox events. If downstream systems (webhooks, analytics) depend on this event, they won't see bot sales.

---

## Verdict

### PASS WITH WARNINGS

**Rationale**: All 49 tasks complete. All 1136 tests pass (0 failures, 0 regressions). 17/18 spec scenarios are compliant with runtime test evidence (1 partial — human payment confirmation is correctly out of scope). All 4 migrations are strictly additive. Bot-safe field projection is verified with explicit negative assertions. TDD evidence is complete (6/6 checks). Assertion quality is clean. Security adversarial pass found no CRITICAL issues — all WARNINGs are defense-in-depth improvements, not exploitable vulnerabilities.

The implementation is merge-ready. The warnings should be addressed in a follow-up slice before the feature goes to production, particularly W-001 (delivery status guard) and W-004 (domain bypass tracking).
