# Delta for chatbot-api-foundation

## ADDED Requirements

### Requirement: Bot Sale Server-Side Promotion Re-evaluation

The system MUST, inside `SalesService.confirmBotSale`, invoke
`recomputePricingAndPromotions(sale)` (the POS promotions engine) before
persisting the charge. The re-evaluation MUST use the real POS engine
(`PosEvaluatePromotionsUseCase`) — NOT the simplified
`EvaluateCartPromotionsUseCase` — because the POS engine is the only
evaluator that supports `ORDER_DISCOUNT`, `BUY_X_GET_Y`, `ADVANCED`,
tier-aware reprice, customer scope, date windows, `daysOfWeek`, and
price-list gating. After the engine runs, the system MUST compute:

- `subtotalCents = Σ(item.originalPriceCents · quantity)` (pre-promo,
  list + tier baseline)
- `totalCents = Σ(item.unitPriceCents · quantity)` (post-promo,
  post-reprice)
- `discountCents = subtotalCents − totalCents` (always ≥ 0)

If no promotion applies, `discountCents` MUST equal `0` and `totalCents`
MUST equal `subtotalCents`. The `discountCents` value MUST be the real
engine result (list − final) — never a value supplied by the bot.

#### Scenario: No promotion applicable keeps discountCents at 0

- GIVEN a bot cart with one item priced at `unitPriceCents=1000c` (list
  price) and no active promotion
- WHEN `registerBotSale` runs
- THEN the engine re-evaluates, applies nothing, and
  `discountCents=0`, `totalCents=1000c`

#### Scenario: AUTOMATIC promotion applies and is persisted

- GIVEN a bot cart with one item priced at `unitPriceCents=1000c` and
  an AUTOMATIC 10% `PRODUCT_DISCOUNT` active and eligible
- WHEN `registerBotSale` runs
- THEN the engine re-evaluates, applies the promo, and
  `subtotalCents=1000c`, `totalCents=900c`, `discountCents=100c`
- AND `discountCents=100c` is persisted on the Sale record

#### Scenario: ORDER_DISCOUNT promotion is reflected

- GIVEN a bot cart with subtotal `15000c` and an active AUTOMATIC
  ORDER_DISCOUNT of `1000c` (minimum subtotal met)
- WHEN `registerBotSale` runs
- THEN `discountCents=1000c`, `totalCents=14000c`

#### Scenario: BXGY / ADVANCED promotions are supported

- GIVEN a bot cart eligible for a `BUY_X_GET_Y` reward
- WHEN `registerBotSale` runs
- THEN the engine computes the reward and the reward value flows into
  `discountCents`

### Requirement: Bot Sale Optional Re-quote Check

The system MUST accept an optional `expectedTotalCents` (non-negative
integer, in cents) on `RegisterBotSaleRequestDto`. When the bot sends
`expectedTotalCents`, the server MUST compare it against the
engine-recomputed `totalCents`. If they differ, the system MUST reject
the request with HTTP `409` and a `PROMO_RE_QUOTE` error whose body
includes at least `{ recomputedTotalCents, expectedTotalCents,
discountCents }` so the bot can re-quote with the real totals and
re-issue the request. When the bot omits `expectedTotalCents`, the
server MUST NOT apply this check (re-evaluation still runs and
`discountCents` is still surfaced in the response).

#### Scenario: Matching expectedTotalCents succeeds

- GIVEN the bot sent `expectedTotalCents=900c` and the engine recomputed
  `totalCents=900c` with a 10% promo on a 1000c list item
- WHEN `registerBotSale` runs
- THEN the response is `201` with `discountCents=100c` and
  `totalCents=900c`

#### Scenario: Mismatched expectedTotalCents returns 409 PROMO_RE_QUOTE

- GIVEN the bot sent `expectedTotalCents=1000c` but the engine recomputed
  `totalCents=900c` because a new 10% promo became applicable
- WHEN `registerBotSale` runs
- THEN the response is `409 PROMO_RE_QUOTE` with body
  `{ recomputedTotalCents: 900, expectedTotalCents: 1000, discountCents: 100 }`
- AND no sale is persisted, no stock is decremented, no event is emitted

#### Scenario: Omitted expectedTotalCents skips the check

- GIVEN the bot did NOT send `expectedTotalCents` and the engine
  recomputed `totalCents=900c`
- WHEN `registerBotSale` runs
- THEN the response is `201` with `discountCents=100c` and
  `totalCents=900c`
- AND no 409 is raised

#### Scenario: Negative expectedTotalCents is rejected at the DTO

- GIVEN a request body with `expectedTotalCents=-1`
- WHEN DTO validation runs
- THEN the request is rejected with `400`

### Requirement: Bot Sale Response Exposes Discount

The system MUST expose `discountCents: number` on the
`BotSaleResponse` returned by `POST /chatbot-api/sales`. The field MUST
be `0` when no promotion applied and MUST equal the engine-recomputed
`subtotalCents − totalCents` when a promotion applied. The field is
additive — clients that ignore it continue to function. The
`ConfirmBotSaleResult` returned by `SalesService.confirmBotSale` MUST
also expose `discountCents`. The `sale.confirmed` outbox event payload
MUST include `discountCents` so downstream consumers (reports, the
annex to the bot) see the same value.

#### Scenario: Response carries discountCents=0 when no promo applies

- GIVEN a bot sale with no promotion applicable
- WHEN `registerBotSale` returns
- THEN `BotSaleResponse.discountCents = 0` and
  `BotSaleResponse.totalCents = subtotalCents`

#### Scenario: Response carries discountCents when promo applies

- GIVEN a bot sale with a 100c engine-recomputed discount
- WHEN `registerBotSale` returns
- THEN `BotSaleResponse.discountCents = 100`

#### Scenario: sale.confirmed event includes discountCents

- GIVEN a bot sale is confirmed with `discountCents=100c`
- WHEN the outbox event is written
- THEN the payload includes `discountCents: 100`

### Requirement: Atomic Sale Registration Idempotency

The system MUST atomically reserve the
`SaleIdempotency(tenantId, operation='bot_sale_register', key)` slot
using the same `create → P2002 → re-read` pattern the POS charge uses
(`acquireChargeIdempotency`). The `requestHash` MUST be
`SHA-256(JSON.stringify(canonicalPayload))` where
`canonicalPayload` includes the keys
`{ cashierUserId, customerId, shippingAddressId, items }` with
`items` sorted ascending by `(productId, variantId)`. Each item MUST be
serialized as `{ productId, variantId, quantity, unitPriceCents }`
(snake_case-stable, matching the DTO field names). Fields like
`productName` or `variantName` MUST NOT affect the hash. The system
MUST distinguish four outcomes:

- `acquired` — slot reserved, caller proceeds with `confirmBotSale`.
- `replay` — slot exists, `status=SUCCEEDED`, and `responseJson`
  present; the cached response is returned (preserves current
  semantics).
- `conflict` — slot exists but `requestHash` does not match; the
  system MUST throw `IDEMPOTENCY_KEY_CONFLICT` → HTTP `409`.
- `in_flight` — slot exists, `requestHash` matches, but
  `status=IN_FLIGHT`; the system MUST throw
  `IDEMPOTENCY_KEY_IN_FLIGHT` → HTTP `409`.

The `idempotencyKey` header MUST be validated at the DTO layer as a
non-empty string of max length 200. An empty or missing header MUST
return `400 INVALID_IDEMPOTENCY_KEY` before any DB read.

#### Scenario: Same key + same payload → replay

- GIVEN a prior `registerBotSale` for key K already SUCCEEDED with
  cached response R
- WHEN the bot retries with key K and identical payload
- THEN the response is R (same `saleId`, same totals)
- AND `confirmBotSale` is NOT called again
- AND no stock, folio, or event side effects are duplicated

#### Scenario: Same key + different payload → conflict

- GIVEN key K already has a SUCCEEDED row with `requestHash=H1`
- WHEN the bot retries with key K and a payload that hashes to H2
- THEN the request is rejected with `409 IDEMPOTENCY_KEY_CONFLICT`
- AND no sale is created or modified

#### Scenario: Same key + same payload + IN_FLIGHT → in_flight

- GIVEN key K currently has a row in `status=IN_FLIGHT` with
  `requestHash=H`
- WHEN the bot retries with key K and a payload that hashes to H
- THEN the request is rejected with `409 IDEMPOTENCY_KEY_IN_FLIGHT`
- AND the bot retries later once the original request completes

#### Scenario: First request acquires the slot

- GIVEN key K does not exist
- WHEN `registerBotSale` runs
- THEN the row is created atomically with `status=IN_FLIGHT` and
  `requestHash=<SHA-256 of canonical payload>`
- AND the service proceeds to `confirmBotSale`

#### Scenario: Empty idempotency key is rejected at the DTO

- GIVEN the `X-Idempotency-Key` header is missing or empty
- WHEN the controller validates the request
- THEN the response is `400 INVALID_IDEMPOTENCY_KEY`
- AND no DB read or write occurs

#### Scenario: Item order does not affect the hash

- GIVEN key K succeeded with payload P that has items
  `[{productId=A}, {productId=B}]`
- WHEN the bot retries with the same payload P reordered as
  `[{productId=B}, {productId=A}]`
- THEN the `requestHash` is identical
- AND the request replays (not conflict)

### Requirement: Bot Active Payment Detail Read

The system MUST expose `GET /chatbot-api/payment-details` for the
chatbot service, requiring the new `payment-details:read` scope. The
endpoint MUST return the active `PaymentDetail` (`isActive=true`) of
the credential's tenant. When multiple active rows exist, the endpoint
MUST return the record with the largest `updatedAt`. When no active row
exists, the endpoint MUST return `404 NO_ACTIVE_PAYMENT_DETAIL`. The
endpoint MUST be audit-logged via `BotAuditInterceptor`. See the
`PaymentDetail` specification for the full admin CRUD, RBAC, and
validation semantics.

#### Scenario: Active account is returned

- GIVEN tenant T has at least one `PaymentDetail` with `isActive=true`
- WHEN the bot calls `GET /chatbot-api/payment-details` with
  `payment-details:read`
- THEN the response is `200` with the active record projection

#### Scenario: No active account returns 404

- GIVEN tenant T has zero active `PaymentDetail` rows
- WHEN the bot calls `GET /chatbot-api/payment-details`
- THEN the response is `404 NO_ACTIVE_PAYMENT_DETAIL`

#### Scenario: Missing scope is rejected

- GIVEN a service credential without `payment-details:read`
- WHEN the bot calls `GET /chatbot-api/payment-details`
- THEN the request is rejected by `RequiredScopes`

### Requirement: Chatbot API Endpoint Documentation Drift Fix

The system MUST update
`openspec/program/whatsapp-ai-chatbot/PROGRAM-CONTEXT.md` so the
endpoint reference reflects the code reality: eleven routes total (the
existing nine plus `POST /chatbot-api/sales/:saleId/cancel`, which is
already implemented at
`src/chatbot-api/presentation/chatbot-api.controller.ts` but was missing
from the doc, plus the new `GET /chatbot-api/payment-details` route
introduced by this change). The doc MUST also include the new
`payment-details:read` scope, the new `discountCents` field on
`BotSaleResponse`, and a §4.3 idempotency section that describes the
atomic pattern (acquire / replay / conflict / in_flight) instead of the
old non-atomic upsert description. The §4.5 endpoint summary table
MUST be corrected from 9 to 11 entries.

#### Scenario: Endpoint count is corrected to 11

- GIVEN `PROGRAM-CONTEXT.md` currently lists 9 endpoints
- WHEN the change is applied
- THEN the §4.5 endpoint summary table lists 11 rows
- AND the total count line reads "Total: 11 endpoints" (replacing the
  9-endpoint count)

#### Scenario: Cancel endpoint is documented

- GIVEN the code has `POST /chatbot-api/sales/:saleId/cancel` but it
  is absent from `PROGRAM-CONTEXT.md`
- WHEN the change is applied
- THEN the doc includes a `4.4.x` section for the cancel route with
  the `sales:write` scope, HTTP method, path, and idempotency notes

#### Scenario: New payment-details endpoint is documented

- GIVEN the change introduces `GET /chatbot-api/payment-details`
- WHEN the change is applied
- THEN the doc includes a `4.4.x` section for the new route with the
  `payment-details:read` scope

#### Scenario: Idempotency section describes the atomic pattern

- GIVEN §4.3 currently describes a non-atomic upsert
- WHEN the change is applied
- THEN §4.3 describes the `acquire` → `replay | conflict | in_flight`
  pattern with `requestHash` matching on canonical payload
- AND mentions that `IDEMPOTENCY_KEY_CONFLICT` (409) and
  `IDEMPOTENCY_KEY_IN_FLIGHT` (409) are the rejection codes

## Verification Surface

- `src/chatbot-api/application/chatbot-api.service.ts` — uses
  `acquireSaleRegistrationIdempotency`, builds canonical `requestHash`,
  returns cached response on `replay`, throws `BusinessRuleViolationError`
  for `conflict` / `in_flight`.
- `src/chatbot-api/presentation/dto/register-bot-sale.request.ts` —
  `expectedTotalCents?` added; `idempotencyKey` validation tightened.
- `src/chatbot-api/presentation/dto/bot-sale.response.ts` —
  `discountCents` added.
- `src/chatbot-api/presentation/chatbot-api.controller.ts` — new
  `GET /chatbot-api/payment-details` route.
- `src/chatbot-api/application/chatbot-api.service.spec.ts` —
  scenarios: replay (preserves existing test), conflict, in_flight,
  requestHash mismatch, missing-key rejection, reorder-tolerant hash,
  re-quote mismatch, re-quote match, no-promo discountCents=0,
  promo-applied discountCents>0.
- `src/sales/sales.service.ts` — `confirmBotSale` calls
  `recomputePricingAndPromotions` and computes
  `subtotalCents/discountCents/totalCents`.
- `src/sales/sales.service.spec.ts` — promotion re-eval scenarios.
- `src/sales/infrastructure/prisma-sale.repository.ts` — new
  `acquireSaleRegistrationIdempotency` /
  `markSaleRegistrationIdempotencySucceeded` methods.
- `src/sales/sales.repository.interface.ts` — new method signatures.
- `openspec/program/whatsapp-ai-chatbot/PROGRAM-CONTEXT.md` —
  endpoint table corrected to 10, cancel + payment-details routes
  documented, §4.3 idempotency updated.
