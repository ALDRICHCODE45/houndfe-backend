# Design: Chatbot API Foundation

## Technical Approach

New `src/chatbot-api/` bounded context following repo hexagonal convention (domain/application/infrastructure/presentation). Thin orchestration layer — delegates to existing domain services in sales, customers, promotions, and public-catalog. API-key auth parallel to JWT, resolving branch context via CLS. Satisfies all spec requirements in `specs/chatbot-api-foundation/spec.md`.

## Architecture Decisions

| # | Decision | Alternatives | Rationale |
|---|----------|-------------|-----------|
| 1 | **New `src/chatbot-api/` module** with own guard, controller, DTOs | Extend public-catalog or sales controllers | Follows existing bounded-context convention; bot-safe field projection is a cross-cutting concern that doesn't belong in any single existing module. Keeps existing modules untouched for POS stability. |
| 2 | **`ServiceCredential` Prisma model** with SHA-256 hashed key, scopes JSON, branch FK | JWT service tokens; shared secret env var | Per-key rotation/revocation without redeployment; scopes + branch FK enable fine-grained access; hashing follows API-key best practice (store hash, never plaintext). Coexists with JWT — new `ServiceAuthGuard` checks `Authorization: Bearer svc_*` prefix, falls through to JWT otherwise. |
| 3 | **Guard sets CLS** (`tenantId`, `userId: 'service:{credentialId}'`) | Pass branch in request body | Reuses entire `TenantPrismaService` tenant-scoping chain without modifying it. All downstream domain services get branch context transparently. |
| 4 | **Minimal Sale schema delta** — add `SaleDeliveryStatus.SHIPPED`, delivery metadata fields on Sale, `ReceiptEvidence` model | New `SaleDelivery` join table | Existing `deliveryStatus` enum on Sale already drives the delivery state machine. Adding `SHIPPED` + flat delivery fields (carrier, trackingRef, estimatedDeliveryAt) is the minimal surgical change. `ReceiptEvidence` is a separate model (1:N to Sale) for pending payment proof. |
| 5 | **Customer phone lookup** as new index + `findByPhone` repo method | Full-text search on customer | Exact normalized-phone match is what the bot needs (WhatsApp identity). Add composite unique index `(tenantId, phoneCountryCode, phone)` and delivery metadata fields (visualReferences, carrierPhone, preferredPaymentMethod) directly on CustomerAddress. |
| 6 | **Promotion evaluation stub** — `EvaluateCartPromotionsUseCase` in promotions module, returns `promotionEvaluationStatus` | Build full engine now | Spec explicitly allows `needs_human_review` status. Stub loads AUTOMATIC+ACTIVE promotions, evaluates `PRODUCT_DISCOUNT` (simple percentage/fixed on matching items). Complex types return `needs_human_review`. Sufficient for v1 bot pricing. |
| 7 | **Idempotency** — reuse existing `SaleIdempotency` pattern for bot sale creation | New idempotency table | Same mechanism, same `@@unique([tenantId, operation, key])`. Bot passes `X-Idempotency-Key` header. |

## Data Flow

```
Bot VPS ──HTTP──→ ChatbotApiController
                     │
              ServiceAuthGuard
              (validate key hash, set CLS tenantId)
                     │
              ChatbotApiService (orchestrator)
                     ├──→ PublicCatalogRepository (search, detail, stock)
                     ├──→ CustomersService (findByPhone, create, update)
                     ├──→ PromotionsService / EvaluateCartPromotionsUseCase
                     ├──→ SalesService (openDraft, addItem, assignCustomer,
                     │                  chargeDraft, attachReceipt)
                     └──→ SaleRepository (order history query)
```

## Prisma Schema Deltas

| Model/Enum | Action | Fields |
|------------|--------|--------|
| `SaleDeliveryStatus` | Modify | Add `SHIPPED` |
| `Sale` | Modify | Add `carrierName String?`, `trackingRef String?`, `estimatedDeliveryAt DateTime?` |
| `ReceiptEvidence` | Create | `id, saleId, tenantId, mediaUrl, declaredAmountCents, declaredDate, declaredReference, status(PENDING/CONFIRMED/REJECTED), confirmedByUserId?, confirmedAt?, createdAt` |
| `CustomerAddress` | Modify | Add `visualReferences String?`, `carrierPhone String?`, `label String?` |
| `Customer` | Modify | Add `preferredPaymentMethod String?`; add index `@@index([tenantId, phoneCountryCode, phone])` |
| `ServiceCredential` | Create | `id, tenantId, name, hashedKey, scopes String[], isActive, lastUsedAt?, rateLimit Int @default(60), createdAt, revokedAt?` |
| `BotAuditLog` | Create | `id, tenantId, credentialId, action, resourceType, resourceId?, metadata Json?, createdAt` |

**Migration strategy**: All additive (new models, new optional fields, new enum value). Safe for production — no data transformation needed. Single `prisma migrate dev` per slice.

## Interfaces / Contracts

```typescript
// Service auth — new guard
@Injectable()
export class ServiceAuthGuard implements CanActivate {
  // Extracts `Bearer svc_<rawKey>`, SHA-256 hashes, looks up ServiceCredential
  // Sets CLS: tenantId from credential.tenantId, userId = `service:${credential.id}`
}

// Promotion evaluation port (new, in promotions module)
export interface CartItemForEvaluation {
  productId: string;
  variantId: string | null;
  quantity: number;
  unitPriceCents: number;
}

export interface EvaluatedCartItem extends CartItemForEvaluation {
  originalPriceCents: number;
  finalPriceCents: number;
  appliedPromotionTitle: string | null;
  discountAmountCents: number;
}

export interface CartEvaluationResult {
  items: EvaluatedCartItem[];
  promotionEvaluationStatus: 'fully_evaluated' | 'needs_human_review';
}
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/chatbot-api/` | Create | Full bounded context: module, controller, service, guard, DTOs, tests |
| `src/chatbot-api/domain/service-credential.entity.ts` | Create | Domain entity with static create/fromPersistence |
| `src/chatbot-api/infrastructure/prisma-service-credential.repository.ts` | Create | Credential lookup by hashed key |
| `src/chatbot-api/infrastructure/prisma-bot-audit-log.repository.ts` | Create | Audit log writer |
| `src/chatbot-api/presentation/chatbot-api.controller.ts` | Create | REST endpoints: search, stock, pricing, customer, sale, receipt, history |
| `src/chatbot-api/presentation/guards/service-auth.guard.ts` | Create | API-key auth + CLS setup |
| `src/chatbot-api/application/chatbot-api.service.ts` | Create | Thin orchestrator delegating to domain services |
| `src/promotions/application/evaluate-cart-promotions.use-case.ts` | Create | Cart promotion evaluation (v1 stub) |
| `prisma/schema.prisma` | Modify | Add ServiceCredential, ReceiptEvidence, BotAuditLog models; extend Sale, Customer, CustomerAddress, SaleDeliveryStatus |
| `src/customers/domain/customer.repository.ts` | Modify | Add `findByPhone(tenantId, countryCode, phone)` |
| `src/customers/infrastructure/prisma-customer.repository.ts` | Modify | Implement findByPhone |
| `src/sales/domain/sale.entity.ts` | Modify | Add delivery metadata setters (carrierName, trackingRef, estimatedDeliveryAt) |
| `src/app.module.ts` | Modify | Import ChatbotApiModule |

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | ServiceCredential entity, ServiceAuthGuard, ChatbotApiService, EvaluateCartPromotions | Jest with mocked repos (repo convention) |
| Unit | Sale entity delivery metadata, customer findByPhone | Extend existing spec files |
| Integration | Full controller request→response with mocked services | NestJS Testing.createTestingModule (matches existing pattern) |

## Migration / Rollout

All schema changes are additive (new models, optional fields, new enum value). No data backfill needed. Deploy order:
1. Run migration (schema)
2. Deploy code
3. Create first ServiceCredential via CLI/seed script (not API — admin-only)

## Open Questions

- [x] Package/weight data: Product model lacks `weightGrams`/`packageDimensions`. Spec says "package/weight data needed for later shipping quotes" — defer to shipping-quotes slice; catalog endpoint returns `null` for now.
- [ ] Rate limiting: per-credential or global? Design assumes per-credential (`rateLimit` field on ServiceCredential), enforced via in-memory sliding window in guard. If Redis is added later, swap implementation.

## Work-Unit Slicing (feeds sdd-tasks)

| # | Slice | Scope | Est. Lines | Depends |
|---|-------|-------|-----------|---------|
| 1 | Schema + ServiceCredential entity | Prisma migration, ServiceCredential entity + repo + tests | ~250 | — |
| 2 | ServiceAuthGuard + CLS setup | Guard, decorator, module wiring, guard tests | ~200 | Slice 1 |
| 3 | Catalog + stock endpoints | Search, detail, stock check via chatbot-api controller + bot-safe projection + tests | ~350 | Slice 2 |
| 4 | Customer phone lookup + delivery metadata | Schema delta, findByPhone repo, customer endpoints + tests | ~300 | Slice 2 |
| 5 | Promotion evaluation stub | EvaluateCartPromotionsUseCase + pricing endpoint + tests | ~250 | Slice 3 |
| 6 | Bot sale creation + idempotency | openDraft, addItem, assignCustomer, chargeDraft via chatbot-api + receipt evidence + order history + tests | ~400 | Slices 4, 5 |
| 7 | Audit logging + rate limiting | BotAuditLog interceptor, rate-limit guard logic, tests | ~200 | Slice 2 |
