# Restock backorder («pedido por reposición») — contract proposal v1

Status: **v1 APPROVED by the chatbot 2026-11-20 (with the §8 one-re-estimate-per-product adjustment); implementation in progress (odd/tasks/restock-backorder.md).** Owner decisions Q1–Q6 resolved 2026-11-20 (§11, final answers after a cross-session conflict, confirmed in both sessions). v1 changes: §13. Owner authorized the feature on 2026-11-20 (decisions relayed by the chatbot agent, confirmed by the owner in the backend session). Chatbot spec: `houndfe-chatbot/odd/tasks/restock-backorder.md` (S1–S9). Facts below cite the current backend (`main` 6f5a8e99).

## 0. Owner decisions this contract implements

| # | Decision (verbatim as relayed) | Where |
|---|---|---|
| D1 | Price: "El menor de los dos" — min(reference price at scheduling, current price at arrival) | §5 |
| D2 | "Se le aparta solo y el bot le pide confirmar" — on arrival, reserve for waiting backorders by scheduling order; reserved units are not sellable at the counter; unconfirmed → next backorder, then general stock | §3, §4 |
| D3 | "24 horas" to confirm, reminder before expiry (like the pay-in-store hold) | §4 |
| D4 | "Cuando sube el stock del producto" — any increase leaving sellable stock > 0 triggers matching; no extra staff steps | §4 |
| D5 | Pay on arrival, never in advance (v1: no money/deposit). Confirm = normal checkout | §7 |
| D6 | Overdue ETA: get a new estimate from staff (RESTOCK-type request) BEFORE telling the customer; only once | §8 |
| D7 | Customer cancels from chat; staff list and cancel in the POS | §6, §9 |

## 1. Model

New table `backorders` (tenant = branch, like every stock row):

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | |
| `tenantId` | UUID | branch; from token/credential |
| `folio` | text | `BO-000001`, per-tenant counter (same pattern as cash closing folios `CC-000001`) |
| `status` | enum | `WAITING`, `RESERVED`, `CONFIRMED`, `EXPIRED`, `CANCELLED` |
| `version` | int | optimistic concurrency for staff cancel (like sale `holdVersion`) |
| `customerId` | UUID | required |
| `productId` / `variantId?` | UUID | `variantId` required when the product has variants |
| `quantity` | int ≥ 1 | integer units in v1 (no bulk/fractional products) |
| `referencePriceCents` | int | unit price at scheduling (server-computed, §5) |
| `referencePriceListId` | UUID? | list that produced it (null = PUBLICO) |
| `currentPriceCents` | int? | unit price at reservation, with auto promotions (§5) |
| `finalPriceCents` | int? | `min(reference, current)`; set at reservation |
| `scheduledAt` | timestamptz | queue order key (ties by `id`) |
| `estimatedArrivalDays` / `estimatedAt` | int / timestamptz | from the RESTOCK answer; updated once by §8 |
| `sourceDecisionId` | UUID | the RESTOCK decision answered with `PROVIDE_RESTOCK_ESTIMATE` |
| `chatbotRequestId` | UUID? | wrapper request, when the bot created it through `/chatbot-api/requests` |
| `reservedAt` / `reservedUntil` / `reminderAt` | timestamptz? | `reservedUntil = reservedAt + 24 h`, `reminderAt = reservedUntil − 3 h` |
| `reservationStage` | smallint | 0 none, 1 reminded, 2 expired (exactly-once, like `holdStage`) |
| `etaStage` | smallint | 0 none, 1 re-estimate requested, 2 re-estimate answered (§8) |
| `passedOverCount` | int | times later backorders were reserved while this one (head, quantity not covered) kept waiting (§4, Q1); shown in the POS |
| `reservedLotIds` | derived | lots held by the `BACKORDER_RESERVE` movements (lot-tracked products, §3) |
| `reestimateDecisionId` | UUID? | the server-created RESTOCK decision of §8 |
| `confirmedAt` / `saleId` | | set by checkout (§7) |
| `cancelledAt` / `cancelReason` (≤ 280) / `cancelledByKind` / `cancelledByUserId?` | | kind: `STAFF`, `CUSTOMER` |
| `expiredAt` | timestamptz? | |
| `idempotencyKey` | text | bot `X-Idempotency-Key`, unique per tenant |

Partial unique index: one active (`WAITING`/`RESERVED`) backorder per `(tenantId, customerId, productId, variantId)`.

### States

```
WAITING ──(stock arrives, FIFO head, full qty available)──▶ RESERVED
RESERVED ──(bot checkout with backorderId)──▶ CONFIRMED (terminal; saleId set)
RESERVED ──(24 h without checkout)──▶ EXPIRED (terminal; units go to the next WAITING, else general stock)
RESERVED ──(reserved lot expired, no valid lot to swap)──▶ WAITING (keeps scheduledAt = front of the queue; feed backorder.reservation_lost)
WAITING | RESERVED ──(customer or staff cancel)──▶ CANCELLED (terminal; RESERVED units go to the next)
```

`EXPIRED` is **terminal** (adopting the chatbot proposal): the bot offers to schedule again, which creates a new backorder at the back of the queue (§6.1, rescheduling).

## 2. Customer resolution

`PUT /chatbot-api/customers/by-phone` requires an address today (`customer-upsert.request.ts:79-104`), so intake resolves the customer like checkout's `createIfAbsent` (`checkout.request.ts`): `customer: {mode:"existing", customerId}` or `{mode:"createIfAbsent", firstName, lastName?}` plus `phoneCountryCode`/`phone`. No address is needed until checkout.

## 3. Reserving stock without a sale

Stock today has no reserved column; six independent readers compute "available" (`products.service.ts:3296` POS add-item, `chatbot-api.service.ts:1069-1145` bot catalog/stock, `shipping-quote.service.ts:474`, public catalog `stock-presentation.vo.ts:82`, POS catalog DTO, low-stock alerts) and two write guards (`stock-plan.ts:137,211`, `fefo-allocator.ts:79`).

**Proposal: reserve through the stock journal, not a column.** A reservation is a `StockJournalWriter` movement `BACKORDER_RESERVE` (new `StockMovementType`, `groupType = BACKORDER`, `groupId = backorderId`) that takes the units out of the sellable quantity; release is the reverse movement `BACKORDER_RELEASE` back to the same buckets (variant, lots via FEFO, or untracked).

- Every existing reader and guard stays correct untouched: reserved units simply are not in `quantity`, so the bot catalog, public catalog, POS and shipping checks all treat them as unavailable (FE item 5, chatbot catalog concern).
- `reservedForBackorders` = Σ active `RESERVED` backorder quantities for that product/variant (a read, indexed by `(tenantId, productId, variantId, status)`).
- `stockOnHand = quantity + reservedForBackorders`; `availableToSell = quantity`.
- Lot-tracked products: the reserve allocates non-expired lots FEFO like a sale. **An expired lot is never sold (owner Q6).** At checkout and in the sweep, if a reserved lot has expired: release it and re-reserve the same quantity from valid lots in the same transaction; if valid lots do not cover it, release everything and the backorder returns to `WAITING` keeping its `scheduledAt` (front of the queue), clears reservation fields, and the bot gets `backorder.reservation_lost`.
- Low-stock alerts will see reserved units as gone (intended: they are not sellable).

## 4. Matching (arrival → reservation) and expiry

**Trigger (D4):** in the same transaction as every stock increase — `StockJournalWriter.apply` with positive deltas (`inventory-commands.ts:160` adjustments, `product-stock-journal.ts:75,152` initial stock), `reverseSale` (`stock-journal.writer.ts:97`, sale cancel and `HOLD_EXPIRED`), and every `BACKORDER_RELEASE` — call `BackorderAllocator.allocate(tenantId, productId, variantId)` after the movement, inside the journal's lock order (products → lots → variants, `stock-journal.writer.ts:268-280`).

**Rule (owner Q1, «Apartarlas a los siguientes que sí alcanzan»):** take `WAITING` backorders for that product/variant ordered by `scheduledAt, id` (`FOR UPDATE`) and walk the whole queue: every backorder whose full `quantity` ≤ remaining sellable `quantity` is reserved (`BACKORDER_RESERVE`, status `RESERVED`, prices per §5, times per D3) and the remainder shrinks; a backorder that does not fit keeps its place (no partial reservation) and, if someone behind it was reserved in that pass, `passedOverCount += 1`. Because every pass starts from the oldest, the head is always evaluated first on each arrival.

**Safety net:** a sweep (pattern `SaleHoldSweepScheduler`, `@Interval(30_000)`, `FOR UPDATE SKIP LOCKED`, keyset batches) re-runs `allocate` for products with `WAITING` backorders and sellable stock > 0, and drives the timers:
- `reminderAt` passed, stage 0 → stage 1, feed `backorder.reservation_reminder`.
- `reservedUntil` passed, stage < 2 → `EXPIRED`, `BACKORDER_RELEASE`, `allocate` again (next in queue), feed `backorder.reservation_expired`, staff notice.
- A `RESERVED` backorder holding an expired lot → lot swap or back to `WAITING` (§3, Q6).

**24 h start:** `reservedUntil = reservedAt + 24 h` from the moment of reservation, regardless of notification. If the bot reports that `backorder.reserved` or `backorder.reservation_reminder` could not be delivered (outcome `PROVIDER_REJECTED`, §10), the staff get a notice with `backorderId` so they call the customer.

**Counter sale vs reservation (FE item 5):** reservations are enforced at sale confirm (POS add-item stays advisory, `sales.service.ts:1347`). When confirm fails `STOCK_INSUFFICIENT_AT_CONFIRM` and `quantity + reservedForBackorders ≥ requested`, the error becomes **`409 STOCK_RESERVED_FOR_BACKORDER {available, reserved}`**. POS add-item can show the same code as a warning.

## 5. Price (D1)

- `referencePriceCents`: computed server-side at intake with the bot price for that customer (`previewBotPricing`, `sales.service.ts:3702`: customer `globalPriceListId`, else PUBLICO; tier for `quantity`). The bot sends `expectedReferencePriceCents`; a mismatch returns `409 PRICE_OUT_OF_DATE {currentPriceCents}`.
- `currentPriceCents` (owner Q2, «Aplicar la promo si le da un precio menor»): at reservation time, the price that customer would pay that day through the bot for that quantity, **with auto-evaluated promotions** (`previewBotPricing` + `recomputePricingAndPromotions(sale, true)`, i.e. what `POST /chatbot-api/pricing/evaluate-cart` returns as the line's final unit price). The customer never pays more than a counter customer would that day.
- `finalPriceCents = min(referencePriceCents, currentPriceCents)`, frozen at reservation and shown in the arrival message.
- At checkout the backorder line is priced at `finalPriceCents` and **promotions are not applied again to that line** (owner Q3; no double discount).

## 6. Bot API (`/chatbot-api`)

New scopes: `backorders:create`, `backorders:read`, `backorders:cancel`.

### 6.1 `POST /chatbot-api/backorders` — schedule (scope `backorders:create`, `X-Idempotency-Key` required)

```json
{
  "phoneCountryCode": "52", "phone": "5512349901",
  "customer": { "mode": "existing", "customerId": "uuid" },
  "productId": "uuid", "variantId": "uuid|null", "quantity": 2,
  "expectedReferencePriceCents": 114900,   // optional
  "sourceDecisionId": "uuid",
  "chatbotRequestId": "uuid|null"
}
```

`201` → `{ "backorder": BackorderBot }` (§6.5). Same key + same body replays `200` with the same backorder; same key + different body → `409 IDEMPOTENCY_KEY_CONFLICT`.

| Code | Error | When |
|---|---|---|
| 409 | `STOCK_AVAILABLE_NOW {availableToSell}` | sellable stock already covers `quantity` → sell normally |
| 409 | `BACKORDER_DUPLICATE {backorderId}` | customer already has an active backorder for that product/variant |
| 409 | `PRICE_OUT_OF_DATE {currentPriceCents}` | `expectedReferencePriceCents` was sent and differs |
| 409 | `SOURCE_DECISION_NOT_ESTIMATED` | decision not answered with `PROVIDE_RESTOCK_ESTIMATE` |
| 404 | `PRODUCT_NOT_FOUND` / `VARIANT_NOT_FOUND` / `SOURCE_DECISION_NOT_FOUND` / `CUSTOMER_NOT_FOUND` | |
| 422 | `VARIANT_REQUIRED` / `VARIANT_NOT_OF_PRODUCT` | |
| 409 | `CUSTOMER_PHONE_AMBIGUOUS`, `IDEMPOTENCY_KEY_IN_FLIGHT` | as checkout |

`expectedReferencePriceCents` is **optional**: when omitted the server price is used and returned in `referencePriceCents` (the bot shows it when confirming).

`estimatedAt = sourceDecision.resolvedAt + restockDays`.

**Rescheduling after `EXPIRED`/`CANCELLED`:** the bot repeats `POST /chatbot-api/backorders` with the **same** `sourceDecisionId` (a decision may back several backorders over time; only one *active* per customer+product+variant). The new backorder joins the back of the queue with the same `estimatedAt`; if that date already passed it starts with `etaStage = 0` and the sweep requests the re-estimate right away (§8).

### 6.2 `GET /chatbot-api/backorders/:id` (scope `backorders:read`) → `{ backorder }` or `404 BACKORDER_NOT_FOUND`.

### 6.3 `GET /chatbot-api/backorders?phoneCountryCode=&phone=&status=WAITING,RESERVED&updatedSince=` (scope `backorders:read`) → `{ items: BackorderBot[] }`, newest first, max 50. `updatedSince` doubles as feed recovery (§10). The bot also uses it for «¿cómo va mi pedido?» (`queuePosition`, `estimatedAt`).

### 6.4 `POST /chatbot-api/backorders/:id/cancel` (scope `backorders:cancel`) `{ "reason": "≤280?" }` → `{ backorder }` (`CANCELLED`, `cancelledByKind: CUSTOMER`). `409 BACKORDER_NOT_CANCELLABLE {status}` when terminal. RESERVED units go to the next backorder (§4).

### 6.5 `BackorderBot`

```json
{
  "id": "uuid", "folio": "BO-000012", "status": "RESERVED",
  "productId": "uuid", "productName": "Croquetas Adulto Raza Grande 18 kg",
  "variantId": null, "variantName": null, "quantity": 2,
  "referencePriceCents": 114900, "currentPriceCents": 109900, "finalPriceCents": 109900,
  "scheduledAt": "…", "estimatedAt": "…", "estimatedArrivalDays": 7,
  "reservedAt": "…", "reservedUntil": "…", "reminderAt": "…",
  "queuePosition": null, "saleId": null,
  "cancelledByKind": null, "cancelReason": null, "branchName": "Centro",
  "customerFirstName": "Rosa"
}
```

`queuePosition` (1-based) only while `WAITING`.

## 7. Confirm = normal checkout with `backorderId` (D5)

`POST /chatbot-api/checkouts` gains an optional `sale.items[i].backorderId` (DTO is `forbidNonWhitelisted`, so the field is added explicitly; it joins the request hash, `checkout.service.ts:67`). For a line with `backorderId`, inside the confirm transaction:

1. Lock the backorder; require `RESERVED` and `reservedUntil > now` → else `409 BACKORDER_NOT_RESERVED {status}` / `409 BACKORDER_RESERVATION_EXPIRED`.
2. Require same customer, product, variant and `quantity` → else `409 BACKORDER_MISMATCH {field}`.
3. Require `unitPriceCents = finalPriceCents`; the line skips the price-list check (`PRICE_OUT_OF_DATE`, `sales.service.ts:3990`) and promotions (`priceSource = BACKORDER`).
4. `BACKORDER_RELEASE` then the normal sale `charge` (net zero on sellable stock); backorder → `CONFIRMED`, `saleId`, `confirmedAt`.

Other lines in the same cart behave as today. Shipping or pickup and the pay-in-store hold work unchanged; if that sale later expires or is cancelled, the stock returns to general stock through `reverseSale` and `allocate` serves the next `WAITING` backorder.

## 8. Overdue ETA (D6)

**One re-estimate per product (chatbot review of v1):** the sweep groups overdue backorders by `(tenantId, productId, variantId)`. If a re-estimate decision for that product is already pending, the newly overdue backorder attaches to it (`reestimateDecisionId`, `etaStage = 1`) instead of creating another; when staff answer, the result applies to every `WAITING` backorder of that product with `etaStage = 1` (each moves to `etaStage = 2` and gets its own feed item). Still once per backorder.

Sweep: `WAITING`, `estimatedAt < now`, `etaStage = 0`, no pending re-estimate for its product → create a staff RESTOCK decision server-side (`PrismaRestockIntakeRepository.submit`, own transaction; `sourceRequestId = backorderId`; `submittedCredentialId` = a constant system id), wrapped **without a conversation** (staff-only, so the bot gets no generic `request.answered`), `etaStage = 1`. **The customer is not told anything yet.**

When staff resolve it (`POST /human-decisions/:id/resolve`), the backorder module (listener on the resolution) sets `etaStage = 2` and:
- `PROVIDE_RESTOCK_ESTIMATE` → new `estimatedAt`, feed `backorder.eta_updated {estimatedAt, restockDays}`;
- `REPORT_RESTOCK_ESTIMATE_UNAVAILABLE` → feed `backorder.eta_unavailable`.

Only once: with `etaStage = 2` no further automatic re-estimate; the staff list flags it as overdue (`etaOverdue: true`).

## 9. Staff API (POS)

CASL subject **`Backorder`**: `read`, `update` (cancel). Grants seeded for Manager (read+update) and Cashier (read). No staff creation in v1.

### 9.1 `GET /backorders`

Query: `page`, `limit`, `status` (comma list), `productId`, `variantId`, `customerId`, `q` (customer name/phone or product/variant name), `from`/`to` (`scheduledAt`, ISO with zone), `sortBy = scheduledAt|status|reservedUntil` (default `scheduledAt`), `sortOrder` (default `asc`). Branch from the token.

Response: `{ items: BackorderStaff[], page, limit, total, counts: {WAITING, RESERVED, CONFIRMED, EXPIRED, CANCELLED} }` — `counts` honour every filter except `status`.

`BackorderStaff` = `BackorderBot` plus `version`, `customer {id, name, phone}`, `origin: "CHATBOT"`, `chatbotRequestId`, `productImageUrl`, `priceListId`, `confirmedAt`, `cancelledAt`, `expiredAt`, `cancelledBy {id, name} | null`, `saleStatus | null`, `etaOverdue`, `passedOverCount` (POS flag for a head that keeps being passed over, Q1).

### 9.2 `GET /backorders/:id` → `BackorderStaff`; `404 BACKORDER_NOT_FOUND`.

### 9.3 `POST /backorders/:id/cancel` `{ reason?: ≤280, version }` → `BackorderStaff`. Errors: `409 BACKORDER_NOT_CANCELLABLE {status}`, `409 VERSION_CONFLICT {currentVersion}`, `404 BACKORDER_NOT_FOUND`. RESERVED units go to the next backorder; the bot gets `backorder.cancelled_by_staff {reason}`.

### 9.4 Stock fields (additive)

Product and variant reads used by the POS (products list/detail, POS catalog search) gain `stockOnHand`, `reservedForBackorders`, `availableToSell` (= today's `quantity`). Existing fields keep their meaning.

### 9.5 Staff notifications

When a backorder becomes `RESERVED` or `EXPIRED`, a staff notice with `backorderId` through the existing notifications module (same channel as chatbot request notices). `GET /backorders/:id/audit`: deferred to v2 (the journal movements + timestamps cover v1).

## 10. Feed items for the bot

New feed subject `backorderId` (migration: FK column, widen `chatbot_feed_items_subject_chk`, `FeedDraft` union, partial unique `(tenantId, backorderId, type, payload->>'version')` for exactly-once, recovery pointer for backorder items). Delivered to the customer's conversation (resolved like `saleConversationRef`). ACK with `POST /chatbot-api/deliveries/:id/outcome`; deferrals rejected (`422 OUTCOME_NOT_ALLOWED`) like sale items.

| Type | Payload (besides `backorderId`, `folio`, `productName`, `variantName`, `quantity`, `branchName`) |
|---|---|
| `backorder.reserved` | `referencePriceCents`, `currentPriceCents`, `finalPriceCents`, `reservedUntil`, `reminderAt` |
| `backorder.reservation_reminder` | `reservedUntil` |
| `backorder.reservation_expired` | `expiredAt` |
| `backorder.cancelled_by_staff` | `reason` |
| `backorder.eta_updated` | `estimatedAt`, `restockDays` |
| `backorder.eta_unavailable` | — |
| `backorder.reservation_lost` | `reason: "LOT_EXPIRED"`, `queuePosition`, `estimatedAt` (back to `WAITING`, front of the queue; the bot apologises) |

Every payload also carries `customerFirstName` (for the template) and all timestamps are ISO 8601 in UTC with `Z` (`toISOString()`), like every other bot payload (implementation decision in T1: consistency with the hold and feed payloads the bot already parses; the bot converts to local time).

**Outcomes:** the existing values (`PROVIDER_ACCEPTED`, `DELIVERY_UNKNOWN`, `STALE`) plus a new terminal **`PROVIDER_REJECTED`** with `reason` (≤ 280, e.g. `TEMPLATE_NOT_APPROVED`, `UNREACHABLE`), accepted only for backorder items. For `backorder.reserved` and `backorder.reservation_reminder` it triggers the staff notice of §4; for the other backorder types it is just recorded. Deferrals stay rejected.

Recovery: `GET /chatbot-api/backorders?phone…&updatedSince=` (§6.3).

## 11. Owner decisions (resolved 2026-11-20, final)

The owner first answered Q1, Q2/Q3 and Q6 differently in the backend and chatbot sessions; the conflict was raised in both and the owner confirmed these final answers in both sessions.

| Q | Question | Owner choice (verbatim) |
|---|---|---|
| Q1 | Partial arrival (5 ordered, 3 arrive) | «Apartarlas a los siguientes que sí alcanzan» — walk the queue, reserve those that fit; the head keeps its place and is evaluated first on every arrival; `passedOverCount` flags it in the POS |
| Q2/Q3 | Price | «Aplicar la promo si le da un precio menor» — current = that day's bot price with auto promotions; final = min(reference, current); no promotion again at checkout |
| Q4 | Max quantity per backorder | No limit in v1 |
| Q5 | Staff can create backorders from the POS | Not in v1 |
| Q6 | Reserved lot expires before confirmation | «Cambiar a un lote vigente o volver a esperar» — never sell an expired lot; swap to a valid lot, else back to `WAITING` at the front + `backorder.reservation_lost` |
| — | Start of the 24 h | From reservation, plus a staff notice when the bot reports the notice could not be delivered |

## 12. Risks

1. Concurrency: allocation runs inside the journal lock order; every increase path must call it (three call sites plus releases). The sweep is the safety net.
2. Checkout price guard: the backorder line needs its own price path (§7.3) or `PRICE_OUT_OF_DATE`/`PROMO_RE_QUOTE` reject it.
3. Feed subject CHECK lives only in a migration; adding `backorderId` is a migration plus a recovery pointer.
4. Server-side RESTOCK cannot run inside another transaction (`NESTED_TRANSACTION_ERROR`) and needs a system credential id.
5. Migrations: new table, enum values (`StockMovementType`), feed column. All additive.

## 13. Changes v0 → v1

1. Q1 partial arrival: walk the queue and reserve every backorder that fits; head keeps its place; new `passedOverCount` (model, POS).
2. Q2/Q3 price: `currentPriceCents` includes auto promotions; no promotion again at checkout.
3. Q6 lots: never sell an expired lot; swap or return to `WAITING` at the front; new state edge `RESERVED → WAITING` and feed `backorder.reservation_lost`.
4. 24 h from reservation + staff notice on undeliverable notice; new feed outcome `PROVIDER_REJECTED {reason}` (backorder items only).
5. `expectedReferencePriceCents` optional (chatbot obs. 1).
6. Rescheduling with the same `sourceDecisionId` allowed; past `estimatedAt` triggers an immediate re-estimate (obs. 2).
7. Payloads: `customerFirstName`; timestamps ISO 8601 UTC `Z` like all bot payloads (obs. 4 asked for an offset; changed in T1 for consistency).
8. `GET ?phone…` documented for «¿cómo va mi pedido?» (obs. 6).
9. §8: one re-estimate per (tenant, product, variant); later overdue backorders attach to the pending one (chatbot approval note).
