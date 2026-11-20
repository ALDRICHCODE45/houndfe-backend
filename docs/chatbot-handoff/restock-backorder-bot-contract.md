# Chatbot ↔ backend: restock backorder («pedido por reposición») — bot contract v1

**Status:** v1 approved by the chatbot on 2026-11-20 (with the §8 one-re-estimate-per-product adjustment). **T1 is built** on branch `feat/restock-backorder` (not merged, deploy pending): the model and the four routes `POST`, `GET :id`, `GET` list and `POST :id/cancel` under `/chatbot-api/backorders`. Everything else in this document is marked **(T2)**, **(T3)** or **(T4)** and is **not live yet**; do not build against it until each task is announced. Migration: `20261120000000_backorders` (T1, additive: two tables, two enums). Task: `odd/tasks/restock-backorder.md` (S1–S3). Source of truth for the full design (staff API, stock fields, §3–§5, §9): `docs/proposals/restock-backorder-contract.md`.

Source (T1): `src/backorders/presentation/backorders-bot.controller.ts`, `src/backorders/application/backorders-bot.service.ts`, `src/backorders/domain/backorder-rules.ts`, `src/backorders/backorders.integration.spec.ts`, `prisma/migrations/20261120000000_backorders/migration.sql`.

## What is live when

| Part | Task | State |
| --- | --- | --- |
| Schedule (`POST`), read (`GET :id`), list (`GET`), customer cancel (`POST :id/cancel`), scopes, errors, `BackorderBot` | **T1** | built |
| Reserve on arrival (WAITING → RESERVED), 24 h confirm window, `currentPriceCents`/`finalPriceCents`, reservation expiry, lot swap, the `backorder.*` feed items (§10), outcome `PROVIDER_REJECTED`, staff alert | **T2** | not live |
| Confirm through the normal checkout with `sale.items[i].backorderId` (§7) | **T3** | not live |
| Overdue ETA re-estimate, `backorder.eta_updated` / `backorder.eta_unavailable` (§8) | **T4** | not live |
| Staff API in the POS, `reservedForBackorders` stock fields, `STOCK_RESERVED_FOR_BACKORDER`, staff notices | **T5** | not live (staff-facing, nothing for the bot) |

After T1 a backorder is created `WAITING` and stays `WAITING` until you or staff cancel it: nothing reserves stock yet. Until T2 is announced, tell the customer only that the order is scheduled and that you will notify them when stock arrives; do not promise the 24 h reservation message.

## 0. Owner decisions this implements

| # | Decision (verbatim as relayed) | Where | Live |
| --- | --- | --- | --- |
| D1 | Price: "El menor de los dos" — min(reference price at scheduling, current price at arrival) | §5 | reference price: T1; `min`: T2 |
| D2 | "Se le aparta solo y el bot le pide confirmar" — on arrival, reserve for waiting backorders by scheduling order; reserved units are not sellable at the counter | §3, §4 | T2 |
| D3 | "24 horas" to confirm, reminder before expiry | §4 | T2 |
| D4 | "Cuando sube el stock del producto" — any increase leaving sellable stock > 0 triggers matching | §4 | T2 |
| D5 | Pay on arrival, never in advance (no money/deposit). Confirm = normal checkout | §7 | T3 |
| D6 | Overdue ETA: new staff estimate BEFORE telling the customer; only once | §8 | T4 |
| D7 | Customer cancels from chat; staff list and cancel in the POS | §6 | cancel: T1; staff: T5 |

## 1. Model (what the bot sees)

A backorder belongs to one sucursal (the credential's tenant), one customer, one product (and variant) and one quantity of whole units. It is created from a RESTOCK human decision that staff answered with `PROVIDE_RESTOCK_ESTIMATE`.

- `folio`: `BO-000001`, a per-sucursal consecutive counter. Show it to the customer.
- `referencePriceCents`: the unit price when scheduled, computed by the server for that customer and quantity (§5).
- `scheduledAt`: the queue key. The queue of one product/variant is served first come, first served by `scheduledAt` (ties by `id`).
- `estimatedAt` / `estimatedArrivalDays`: `estimatedAt = decision.resolvedAt + restockDays`. It may already be in the past (see rescheduling); that is allowed.

### States

```
WAITING ──(stock arrives, FIFO, full quantity available)──▶ RESERVED                  (T2)
RESERVED ──(bot checkout with backorderId)──▶ CONFIRMED (terminal; saleId set)         (T3)
RESERVED ──(24 h without checkout)──▶ EXPIRED (terminal)                               (T2)
RESERVED ──(reserved lot expired, no valid lot to swap)──▶ WAITING (front of the queue) (T2)
WAITING | RESERVED ──(customer or staff cancel)──▶ CANCELLED (terminal)                (T1 customer; T5 staff)
```

`CONFIRMED`, `EXPIRED` and `CANCELLED` are **terminal**. After `EXPIRED` or `CANCELLED` you may offer to schedule again: that creates a **new** backorder at the back of the queue (§6.1, rescheduling). In T1 only `WAITING` rows exist (and `CANCELLED` after a cancel).

Only one backorder per customer + product + variant can be **active** (`WAITING` or `RESERVED`) at a time.

## 2. Customer resolution

`PUT /chatbot-api/customers/by-phone` needs an address, so scheduling resolves the customer like checkout's `createIfAbsent`: `customer: { "mode": "existing", "customerId" }` or `{ "mode": "createIfAbsent", "firstName", "lastName"? }`, plus `phoneCountryCode` / `phone` (same rules and same phone lock as checkout: `^[0-9]{1,10}$` and `^[0-9]{1,20}$`, exact match, no canonicalization). **No address** is needed until checkout.

- `existing`: the phone must belong to exactly that customer, otherwise `404 CUSTOMER_NOT_FOUND`.
- `createIfAbsent`: if the phone already has one customer, that customer is used (your names are ignored); if none, the customer is created without an address; if the phone matches more than one customer, `409 CUSTOMER_PHONE_AMBIGUOUS`.

## 6. Bot API (`/chatbot-api`) — **live in T1**

Credential: `Authorization: Bearer svc_…`. New scopes (add them to the chatbot credential before deploy): `backorders:create`, `backorders:read`, `backorders:cancel`. A route without its scope answers `403`; `X-Branch-Id`, when sent, must be the credential's sucursal.

Route budgets: `POST` and cancel spend from the `write` bucket, the two `GET` from the `read` bucket (the credential's per-class limits, `429` + `Retry-After`).

Every answer, error included, is `Cache-Control: no-store`: a backorder changes by itself.

Errors have a code-only body `{ "statusCode", "error", "message" }` with `error === message`, plus the small detail member listed in the tables. Unknown failures answer `500 BACKORDER_REQUEST_FAILED`; `503 BACKORDER_RETRY_REQUIRED` means a database transaction was aborted (retry with the same key).

### 6.1 `POST /chatbot-api/backorders` — schedule (scope `backorders:create`, `X-Idempotency-Key` required)

```json
{
  "phoneCountryCode": "52", "phone": "5512349901",
  "customer": { "mode": "existing", "customerId": "uuid" },
  "productId": "uuid", "variantId": "uuid|null", "quantity": 2,
  "expectedReferencePriceCents": 114900,
  "sourceDecisionId": "uuid",
  "chatbotRequestId": "uuid|null"
}
```

- `variantId`, `expectedReferencePriceCents` and `chatbotRequestId` are optional; omitted and `null` are the same thing.
- `quantity`: integer ≥ 1 (no upper limit in v1).
- Unknown members are rejected (`400`); there is no address member.
- `201` → `{ "backorder": BackorderBot }` (§6.5). Same key + same body replays `200` with the **current** state of the same backorder (it may have changed since: cancelled, reserved…); same key + different body → `409 IDEMPOTENCY_KEY_CONFLICT`. A second request with the same key while the first is still running → `409 IDEMPOTENCY_KEY_IN_FLIGHT` (retry). The key is per sucursal, 1–200 characters after trimming.
- `estimatedAt = sourceDecision.resolvedAt + restockDays`.
- `expectedReferencePriceCents` is **optional**: when omitted the server price is used and returned in `referencePriceCents` (show it when confirming); when sent and different → `409 PRICE_OUT_OF_DATE`.
- `sourceDecisionId` must be a RESTOCK human decision of this sucursal, for the same product and variant, answered `PROVIDE_RESTOCK_ESTIMATE`.
- `chatbotRequestId` (optional) is the wrapper request when you created the decision through `/chatbot-api/requests`; it must belong to the sucursal.

| Status | `error` (+ detail) | When |
| --- | --- | --- |
| 400 | `INVALID_BACKORDER_REQUEST` | body is not exactly the shape above |
| 400 | `INVALID_IDEMPOTENCY_KEY` | `X-Idempotency-Key` missing, blank or over 200 characters |
| 409 | `STOCK_AVAILABLE_NOW {availableToSell}` | sellable stock already covers `quantity`: sell normally. `availableToSell` is `null` for a product that does not track stock (always sellable) |
| 409 | `BACKORDER_DUPLICATE {backorderId}` | the customer already has an active backorder for that product/variant |
| 409 | `PRICE_OUT_OF_DATE {currentPriceCents}` | `expectedReferencePriceCents` was sent and differs from the server price |
| 409 | `SOURCE_DECISION_NOT_ESTIMATED` | the decision is pending or was answered "estimate unavailable" |
| 404 | `PRODUCT_NOT_FOUND` / `VARIANT_NOT_FOUND` / `SOURCE_DECISION_NOT_FOUND` / `CUSTOMER_NOT_FOUND` | `SOURCE_DECISION_NOT_FOUND` also covers a decision of another sucursal, another type (EXPIRATION) or another product/variant |
| 404 | `CHATBOT_REQUEST_NOT_FOUND` | `chatbotRequestId` does not belong to the sucursal |
| 422 | `VARIANT_REQUIRED` / `VARIANT_NOT_OF_PRODUCT` | the product has variants and none was sent / the variant belongs to another product (or the product has no variants) |
| 422 | `PRICE_UNAVAILABLE` | the product/variant has no catalog price for the customer; nothing to quote |
| 409 | `CUSTOMER_PHONE_AMBIGUOUS`, `IDEMPOTENCY_KEY_IN_FLIGHT`, `IDEMPOTENCY_KEY_CONFLICT` | as checkout |

`STOCK_AVAILABLE_NOW` uses the same sellable figure as `GET /catalog/search` and `GET /catalog/:productId/stock`: a variant's own `quantity`; for a product without variants, `quantity` minus the units in expired lots; never below 0.

**Rescheduling after `EXPIRED`/`CANCELLED`:** repeat `POST /chatbot-api/backorders` with the **same** `sourceDecisionId` (a decision may back several backorders over time; only one *active* per customer + product + variant). The new backorder joins the back of the queue with the same `estimatedAt`. If that date already passed, the backorder starts with `etaStage = 0` and the overdue-ETA flow (§8, **T4**) picks it up; until T4 it just stays `WAITING`.

**Concurrency:** two simultaneous requests for the same customer + product + variant create exactly one backorder (the other gets `BACKORDER_DUPLICATE`).

### 6.2 `GET /chatbot-api/backorders/:id` (scope `backorders:read`)

→ `{ "backorder": BackorderBot }`, or `404 BACKORDER_NOT_FOUND` (also for another sucursal's backorder and for an id that is not a UUID).

### 6.3 `GET /chatbot-api/backorders?phoneCountryCode=&phone=&status=WAITING,RESERVED&updatedSince=` (scope `backorders:read`)

→ `{ "items": BackorderBot[] }`, **most recently updated first** (`updatedAt` desc, ties by `id` desc), **max 50**.

- `phoneCountryCode` and `phone` go together (both or neither). With them: only that customer's backorders (unknown phone → `{ "items": [] }`; phone shared by more than one customer → `409 CUSTOMER_PHONE_AMBIGUOUS`). Without them: every backorder of the sucursal.
- `status`: comma list of `WAITING,RESERVED,CONFIRMED,EXPIRED,CANCELLED`.
- `updatedSince`: ISO 8601 instant **with a zone** (`2026-11-20T10:00:00.000Z` or `…-06:00`); returns items with `updatedAt >= updatedSince`. It doubles as feed recovery (§10, **T2**).
- Any other query key, a repeated key or a malformed value → `400 INVALID_BACKORDER_REQUEST`.

Use it for «¿cómo va mi pedido?» (`queuePosition`, `estimatedAt`).

### 6.4 `POST /chatbot-api/backorders/:id/cancel` (scope `backorders:cancel`)

Body (optional as a whole): `{ "reason": "≤280 characters" }`; a blank reason is stored as `null`. → `200 { "backorder": BackorderBot }` with `status: "CANCELLED"`, `cancelledByKind: "CUSTOMER"`.

| Status | `error` (+ detail) | When |
| --- | --- | --- |
| 404 | `BACKORDER_NOT_FOUND` | unknown id, another sucursal's backorder, or not a UUID |
| 409 | `BACKORDER_NOT_CANCELLABLE {status}` | already `CONFIRMED`, `EXPIRED` or `CANCELLED` (a retry of a cancel that succeeded answers this with `status: "CANCELLED"`: treat it as done) |
| 400 | `INVALID_BACKORDER_REQUEST` | reason over 280 characters, wrong type or unknown member |

`WAITING` cancels now. A `RESERVED` backorder (**T2**) hands its units back to the next waiting backorder in the same transaction.

### 6.5 `BackorderBot`

```json
{
  "id": "uuid", "folio": "BO-000012", "status": "WAITING",
  "productId": "uuid", "productName": "Croquetas Adulto Raza Grande 18 kg",
  "variantId": null, "variantName": null, "quantity": 2,
  "referencePriceCents": 114900, "currentPriceCents": null, "finalPriceCents": null,
  "scheduledAt": "2026-11-20T15:00:00.000Z",
  "estimatedAt": "2026-11-27T15:00:00.000Z", "estimatedArrivalDays": 7,
  "reservedAt": null, "reservedUntil": null, "reminderAt": null,
  "queuePosition": 3, "saleId": null,
  "cancelledByKind": null, "cancelReason": null, "branchName": "Centro",
  "customerFirstName": "Rosa"
}
```

- `queuePosition` (1-based, counted inside the product/variant queue) only while `WAITING`; `null` otherwise.
- `currentPriceCents`, `finalPriceCents`, `reservedAt`, `reservedUntil`, `reminderAt` are `null` until the backorder is reserved (**T2**). `saleId` is set at checkout (**T3**).
- `cancelledByKind`: `CUSTOMER` (T1) or `STAFF` (T5). `cancelReason` is what was sent (≤280).
- `productName`, `variantName`, `branchName` and `customerFirstName` are read live (the current names).
- **Timestamps are ISO 8601 in UTC with `Z`** (`toISOString()`), like every other bot payload today (`holdUntil`, `reminderAt` of the pay-in-store hold, feed items). The approved proposal asked for an offset (`-06:00`); the backend keeps UTC `Z` for every backorder payload, feed items included, for consistency. Convert to local time on your side with the sucursal's time zone (America/Mexico_City).

## 5. Price (D1) — reference price live in T1, the rest in T2

- `referencePriceCents` (**T1**): computed by the server at scheduling with the price the bot checkout would use for that customer and quantity — the customer's price list (PUBLICO when none, or when the list has no price for the product) and the tier for `quantity`; **list price, without promotions**. A customer that does not exist yet (`createIfAbsent`) is priced as PUBLICO. If you send `expectedReferencePriceCents` and it differs → `409 PRICE_OUT_OF_DATE {currentPriceCents}`.
- `currentPriceCents` (**T2**): at reservation, the price that customer would pay that day through the bot for that quantity **with automatic promotions** (the final unit price `POST /chatbot-api/pricing/evaluate-cart` returns). The customer never pays more than a counter customer would that day.
- `finalPriceCents = min(referencePriceCents, currentPriceCents)` (**T2**), frozen at reservation and shown in the arrival message.
- At checkout the backorder line is priced at `finalPriceCents` and **promotions are not applied again to that line** (**T3**).

## 7. Confirm = normal checkout with `backorderId` (D5) — **T3, not live**

`POST /chatbot-api/checkouts` will gain an optional `sale.items[i].backorderId`. For a line with `backorderId`, inside the confirm transaction:

1. The backorder must be `RESERVED` and `reservedUntil > now`, otherwise `409 BACKORDER_NOT_RESERVED {status}` / `409 BACKORDER_RESERVATION_EXPIRED`.
2. Same customer, product, variant and `quantity`, otherwise `409 BACKORDER_MISMATCH {field}`.
3. `unitPriceCents` must equal `finalPriceCents`; the line skips the price-list check (`PRICE_OUT_OF_DATE`) and promotions.
4. The reservation is released and the normal sale `charge` runs (net zero on sellable stock); the backorder becomes `CONFIRMED` with `saleId` and `confirmedAt`.

Other lines in the same cart behave as today. Shipping or pickup and the pay-in-store hold work unchanged. Until T3, a checkout with `backorderId` is rejected (the member is unknown to the DTO).

## 8. Overdue ETA (D6) — **T4, not live**

One re-estimate per product: when a `WAITING` backorder's `estimatedAt` passes (and `etaStage = 0`), the server asks staff for a new RESTOCK estimate **before telling the customer anything**; later overdue backorders of the same (sucursal, product, variant) attach to the pending request. When staff answer:

- `PROVIDE_RESTOCK_ESTIMATE` → each attached backorder gets a new `estimatedAt` and the feed item `backorder.eta_updated {estimatedAt, restockDays}`;
- `REPORT_RESTOCK_ESTIMATE_UNAVAILABLE` → the feed item `backorder.eta_unavailable`.

Only once per backorder: with `etaStage = 2` there is no further automatic re-estimate. The wrapper request is staff-only: you do not get a generic `request.answered` for it.

## 10. Feed items — **T2 (reserve/expiry/cancel items) and T4 (eta items), not live**

A new feed subject `backorderId` is delivered to the customer's conversation like the sale items. ACK with `POST /chatbot-api/deliveries/:id/outcome`; deferrals are rejected (`422 OUTCOME_NOT_ALLOWED`) like sale items.

| Type | Task | Payload (besides `backorderId`, `folio`, `productName`, `variantName`, `quantity`, `branchName`) |
| --- | --- | --- |
| `backorder.reserved` | T2 | `referencePriceCents`, `currentPriceCents`, `finalPriceCents`, `reservedUntil`, `reminderAt` |
| `backorder.reservation_reminder` | T2 | `reservedUntil` |
| `backorder.reservation_expired` | T2 | `expiredAt` |
| `backorder.cancelled_by_staff` | T2 | `reason` |
| `backorder.reservation_lost` | T2 | `reason: "LOT_EXPIRED"`, `queuePosition`, `estimatedAt` (back to `WAITING`, front of the queue; apologise) |
| `backorder.eta_updated` | T4 | `estimatedAt`, `restockDays` |
| `backorder.eta_unavailable` | T4 | — |

Every payload also carries `customerFirstName`. The feed timestamps will follow the same UTC `Z` form as `BackorderBot` unless we agree otherwise (see §6.5).

**Outcomes:** the existing values (`PROVIDER_ACCEPTED`, `DELIVERY_UNKNOWN`, `STALE`) plus a new terminal `PROVIDER_REJECTED` with `reason` (≤280, e.g. `TEMPLATE_NOT_APPROVED`, `UNREACHABLE`), accepted only for backorder items. For `backorder.reserved` and `backorder.reservation_reminder` it triggers a staff notice so they call the customer. The 24 h confirm window starts at reservation, not at delivery.

Recovery: `GET /chatbot-api/backorders?phoneCountryCode=…&phone=…&updatedSince=` (§6.3, live now).

## Deploy checklist (T1)

1. Apply migration `20261120000000_backorders` (additive; two new tables and two enums, nothing existing is altered).
2. Add `backorders:create`, `backorders:read` and `backorders:cancel` to the chatbot's `svc_` credential.
3. Nothing else changes: existing routes, scopes and feed are untouched.
