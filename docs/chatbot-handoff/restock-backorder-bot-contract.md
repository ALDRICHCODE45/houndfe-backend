# Chatbot ↔ backend: restock backorder («pedido por reposición») — bot contract v1

**Status:** v1 approved by the chatbot on 2026-11-20 (with the §8 one-re-estimate-per-product adjustment). **T1, T2, T3, T4 and the staff half of T5 (T5a: staff list/detail/cancel and the `backorder.cancelled_by_staff` item) are built** on branch `feat/restock-backorder` (not merged, deploy pending): the model and the four routes `POST`, `GET :id`, `GET` list and `POST :id/cancel` under `/chatbot-api/backorders` (T1), and the reservation on arrival, the 24 h confirm window, the sweep and the `backorder.*` feed with the new outcome `PROVIDER_REJECTED` (T2; T2 ships together with the sweep, see the deploy checklist), the confirmation through the normal checkout with `sale.items[i].backorderId` (T3, §7), and the overdue-ETA re-estimate with `backorder.eta_updated` / `backorder.eta_unavailable` (T4, §8). The `reservedForBackorders` stock fields and `STOCK_RESERVED_FOR_BACKORDER` (T5b) are staff-facing and not live yet; nothing in them is for the bot. Migrations: `20261120000000_backorders` (T1, additive: two tables, two enums), `20261120010000_backorder_stock_movements`, `20261121000000_backorder_feed` and `20261121000100_backorder_feed` (T2, additive); T3 and T4 add no migration. Task: `odd/tasks/restock-backorder.md` (S1–S3). Source of truth for the full design (staff API, stock fields, §3–§5, §9): `docs/proposals/restock-backorder-contract.md`.

Source (T1): `src/backorders/presentation/backorders-bot.controller.ts`, `src/backorders/application/backorders-bot.service.ts`, `src/backorders/domain/backorder-rules.ts`, `src/backorders/backorders.integration.spec.ts`, `prisma/migrations/20261120000000_backorders/migration.sql`.

Source (T2): `src/backorders/application/backorder-allocator.ts` (reserve), `src/backorders/infrastructure/backorder-sweep.store.ts` and `.scheduler.ts` (sweep), `src/backorders/infrastructure/backorder-feed-writes.ts` (feed items), `src/chatbot-requests/domain/chatbot-feed.ts` (payloads, outcome rules), `src/chatbot-requests/infrastructure/prisma-chatbot-feed.store.ts` (ACK), `src/backorders/backorder-sweep.integration.spec.ts`, `src/chatbot-requests/infrastructure/chatbot-feed-backorder.integration.spec.ts`.

## What is live when

| Part | Task | State |
| --- | --- | --- |
| Schedule (`POST`), read (`GET :id`), list (`GET`), customer cancel (`POST :id/cancel`), scopes, errors, `BackorderBot` | **T1** | built |
| Reserve on arrival (WAITING → RESERVED), 24 h confirm window, `currentPriceCents`/`finalPriceCents`, reservation reminder and expiry (sweep, §4), expired-lot swap, the `backorder.reserved` / `reservation_reminder` / `reservation_expired` / `reservation_lost` feed items (§10), outcome `PROVIDER_REJECTED`, staff alert | **T2** | **built** |
| Confirm through the normal checkout with `sale.items[i].backorderId` (§7) | **T3** | **built** |
| Overdue ETA re-estimate (one staff RESTOCK per product), `backorder.eta_updated` / `backorder.eta_unavailable` (§8); `sourceDecisionId` in `BackorderBot` and in the `reservation_expired` / `cancelled_by_staff` payloads | **T4** | **built** |
| Staff API in the POS (`GET /backorders`, `GET /backorders/:id`, `POST /backorders/:id/cancel`), `backorder.cancelled_by_staff` (staff cancel), staff notices resolved through `read:Backorder` | **T5a** | **built** (staff-facing; for the bot only the cancel item, §10) |
| `reservedForBackorders` stock fields, `STOCK_RESERVED_FOR_BACKORDER` | **T5b** | not live (staff-facing, nothing for the bot) |

With T2 a backorder is created `WAITING` and, when the product's stock goes up (any adjustment, initial stock, a cancelled or lapsed sale, a released reservation), the backorders of that product/variant are reserved first come, first served (whole quantities only, the next ones that fit when the head does not: Q1). You get `backorder.reserved` and the customer has **24 hours from the reservation** to confirm through the normal checkout (checkout with `backorderId` is **T3**, §7, now built in the same branch). The 24 h run from the reservation, not from delivery: if you cannot deliver `backorder.reserved` or its reminder, ACK `PROVIDER_REJECTED` and staff call the customer (§10).

## 0. Owner decisions this implements

| # | Decision (verbatim as relayed) | Where | Live |
| --- | --- | --- | --- |
| D1 | Price: "El menor de los dos" — min(reference price at scheduling, current price at arrival) | §5 | reference price: T1; `min`: T2 |
| D2 | "Se le aparta solo y el bot le pide confirmar" — on arrival, reserve for waiting backorders by scheduling order; reserved units are not sellable at the counter | §3, §4 | T2 |
| D3 | "24 horas" to confirm, reminder before expiry | §4 | T2 |
| D4 | "Cuando sube el stock del producto" — any increase leaving sellable stock > 0 triggers matching | §4 | T2 |
| D5 | Pay on arrival, never in advance (no money/deposit). Confirm = normal checkout | §7 | T3 (live) |
| D6 | Overdue ETA: new staff estimate BEFORE telling the customer; only once | §8 | T4 (live) |
| D7 | Customer cancels from chat; staff list and cancel in the POS | §6 | cancel: T1; staff: T5a (live) |

## 1. Model (what the bot sees)

A backorder belongs to one sucursal (the credential's tenant), one customer, one product (and variant) and one quantity of whole units. It is created from a RESTOCK human decision that staff answered with `PROVIDE_RESTOCK_ESTIMATE`.

- `folio`: `BO-000001`, a per-sucursal consecutive counter. Show it to the customer.
- `referencePriceCents`: the unit price when scheduled, computed by the server for that customer and quantity (§5).
- `scheduledAt`: the queue key. The queue of one product/variant is served first come, first served by `scheduledAt` (ties by `id`).
- `estimatedAt` / `estimatedArrivalDays`: `estimatedAt = decision.resolvedAt + restockDays`. It may already be in the past (see rescheduling); that is allowed.

### States

```
WAITING ──(stock arrives, FIFO, full quantity available)──▶ RESERVED                  (T2, live)
RESERVED ──(bot checkout with backorderId)──▶ CONFIRMED (terminal; saleId set)         (T3, live)
RESERVED ──(24 h without checkout)──▶ EXPIRED (terminal)                               (T2, live)
RESERVED ──(reserved lot expired, no valid lot to swap)──▶ WAITING (front of the queue) (T2, live)
WAITING | RESERVED ──(customer or staff cancel)──▶ CANCELLED (terminal)                (T1 customer; T5a staff)
```

`CONFIRMED`, `EXPIRED` and `CANCELLED` are **terminal**. After `EXPIRED` or `CANCELLED` you may offer to schedule again: that creates a **new** backorder at the back of the queue (§6.1, rescheduling). Since T2, `RESERVED` and `EXPIRED` rows exist too.

Only one backorder per customer + product + variant can be **active** (`WAITING` or `RESERVED`) at a time.

## 2. Customer resolution

`PUT /chatbot-api/customers/by-phone` needs an address, so scheduling resolves the customer like checkout's `createIfAbsent`: `customer: { "mode": "existing", "customerId" }` or `{ "mode": "createIfAbsent", "firstName", "lastName"? }`, plus `phoneCountryCode` / `phone` (same rules and same phone lock as checkout: `^[0-9]{1,10}$` and `^[0-9]{1,20}$`, exact match, no canonicalization). **No address** is needed until checkout.

- `existing`: the phone must belong to exactly that customer, otherwise `404 CUSTOMER_NOT_FOUND`.
- `createIfAbsent`: if the phone already has one customer, that customer is used (your names are ignored); if none, the customer is created without an address; if the phone matches more than one customer, `409 CUSTOMER_PHONE_AMBIGUOUS`.

## 4. Matching, the 24 h window and the sweep (T2, live)

- **Reserve (D4).** In the same database transaction as every stock increase of a product/variant (an inventory adjustment, initial stock, a cancelled sale, a sale hold that lapsed, a released reservation) the backend walks that product/variant's `WAITING` queue by `scheduledAt, id` and reserves every backorder whose **whole** quantity fits the sellable stock (no partial reservations; one that does not fit keeps its place and is flagged `passedOverCount` for staff when someone behind it was reserved: Q1). Reserved units leave the sellable stock at once (counter sales, the bot catalog and `STOCK_AVAILABLE_NOW` see them as gone). `backorder.reserved` is written **in that same transaction**, so it exists if and only if the reservation committed, exactly once per reservation.
- **24 h.** `reservedUntil = reservedAt + 24 h`, `reminderAt = reservedUntil − 3 h`, from the moment of reservation regardless of whether or when you deliver the notice (owner decision).
- **Sweep.** A background job runs **every 30 seconds** on every backend replica (safe to run side by side: row locks plus a stage column make each step happen once). Per tick, in this order:
  1. `reminderAt` passed and nothing sent yet → `backorder.reservation_reminder` (once; the backorder stays `RESERVED`). If the sweep was down past the deadline, no reminder is sent: it expires directly.
  2. `reservedUntil` passed → `EXPIRED` (terminal; `expiredAt` set), the units go to the next `WAITING` backorder that fits (its own `backorder.reserved`) or back to general stock, `backorder.reservation_expired`, and a staff notice. Timing: **an expiry is processed within about 30 s of `reservedUntil`** (reminder: within about 30 s of `reminderAt`); a backend outage delays them, never skips them.
  3. A `RESERVED` backorder holding units of a lot that expired (owner Q6, never sell an expired lot): replaced by a valid lot silently (**no feed item**, it stays `RESERVED`), or, if valid stock cannot cover it, released and returned to `WAITING` at its original place (`scheduledAt` unchanged: the front of the queue) with `backorder.reservation_lost`.
  4. Safety net: any product/variant with a `WAITING` queue and enough sellable stock for its smallest backorder is allocated again (covers an allocation that could not commit with its stock write). You see the usual `backorder.reserved`.
- **Race with your cancel.** `POST /chatbot-api/backorders/:id/cancel` and the sweep serialize on the product's stock: if the cancel wins, the sweep does nothing; if the expiry wins, the cancel answers `409 BACKORDER_NOT_CANCELLABLE {status: "EXPIRED"}`. The units are released exactly once either way.
- **Data faults.** A `RESERVED` backorder the stock journal holds nothing for (a data fault) is logged by the backend and left alone (it expires at its deadline); you see nothing.

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
| 422 | `VARIANT_REQUIRED` / `VARIANT_NOT_OF_PRODUCT` | the product has variants and none was sent / the variant belongs to another product (or the product has no variants). `VARIANT_REQUIRED` also answers when staff converted the product to variants between your catalog read and this `POST` (the product row is locked before the check): re-read the product in the catalog, pick a variant and retry with a new key. A product-level backorder is never created on a product that has variants |
| 422 | `PRICE_UNAVAILABLE` | the product/variant has no catalog price for the customer; nothing to quote |
| 409 | `CUSTOMER_PHONE_AMBIGUOUS`, `IDEMPOTENCY_KEY_IN_FLIGHT`, `IDEMPOTENCY_KEY_CONFLICT` | as checkout |

`STOCK_AVAILABLE_NOW` uses the same sellable figure as `GET /catalog/search` and `GET /catalog/:productId/stock`: a variant's own `quantity`; for a product without variants, `quantity` minus the units in expired lots; never below 0.

**Rescheduling after `EXPIRED`/`CANCELLED`:** repeat `POST /chatbot-api/backorders` with the **same** `sourceDecisionId` (a decision may back several backorders over time; only one *active* per customer + product + variant). The new backorder joins the back of the queue with the same `estimatedAt`. If that date already passed, the backorder starts with `etaStage = 0` and the overdue-ETA flow (§8, **T4**, live) picks it up on the next sweep tick: staff are asked for a new estimate and you hear `backorder.eta_updated` / `backorder.eta_unavailable` when they answer. `sourceDecisionId` is in every `BackorderBot` and in the `backorder.reservation_expired` and `backorder.cancelled_by_staff` items (§10), so you have it when the customer says «sí, vuelve a apartarlo».

**Concurrency:** two simultaneous requests for the same customer + product + variant create exactly one backorder (the other gets `BACKORDER_DUPLICATE`).

### 6.2 `GET /chatbot-api/backorders/:id` (scope `backorders:read`)

→ `{ "backorder": BackorderBot }`, or `404 BACKORDER_NOT_FOUND` (also for another sucursal's backorder and for an id that is not a UUID).

### 6.3 `GET /chatbot-api/backorders?phoneCountryCode=&phone=&status=WAITING,RESERVED&updatedSince=` (scope `backorders:read`)

→ `{ "items": BackorderBot[] }`, **most recently updated first** (`updatedAt` desc, ties by `id` desc), **max 50**.

- `phoneCountryCode` and `phone` go together (both or neither). With them: only that customer's backorders (unknown phone → `{ "items": [] }`; phone shared by more than one customer → `409 CUSTOMER_PHONE_AMBIGUOUS`). Without them: every backorder of the sucursal.
- `status`: comma list of `WAITING,RESERVED,CONFIRMED,EXPIRED,CANCELLED`.
- `updatedSince`: ISO 8601 instant **with a zone** (`2026-11-20T10:00:00.000Z` or `…-06:00`); returns items with `updatedAt >= updatedSince`. It doubles as feed recovery (§10, T2): with `updatedSince` the answer also carries `backorderUndeliveredResumeAfter`.
- Any other query key, a repeated key or a malformed value → `400 INVALID_BACKORDER_REQUEST`.

Use it for «¿cómo va mi pedido?» (`queuePosition`, `estimatedAt`).

### 6.4 `POST /chatbot-api/backorders/:id/cancel` (scope `backorders:cancel`)

Body (optional as a whole): `{ "reason": "≤280 characters" }`; a blank reason is stored as `null`. → `200 { "backorder": BackorderBot }` with `status: "CANCELLED"`, `cancelledByKind: "CUSTOMER"`.

| Status | `error` (+ detail) | When |
| --- | --- | --- |
| 404 | `BACKORDER_NOT_FOUND` | unknown id, another sucursal's backorder, or not a UUID |
| 409 | `BACKORDER_NOT_CANCELLABLE {status}` | already `CONFIRMED`, `EXPIRED` or `CANCELLED` (a retry of a cancel that succeeded answers this with `status: "CANCELLED"`: treat it as done) |
| 400 | `INVALID_BACKORDER_REQUEST` | reason over 280 characters, wrong type or unknown member |

`WAITING` cancels now. A `RESERVED` backorder hands its units back to the next waiting backorder in the same transaction (T2, live). The customer cancel writes **no** feed item (you just cancelled it); only the staff cancel (T5a, live) does: `backorder.cancelled_by_staff` (§10). A `RESERVED` backorder cancelled by staff hands its units to the next waiting backorder in the same transaction, exactly like the customer cancel; staff cancel only `WAITING` or `RESERVED` ones.

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
  "sourceDecisionId": "uuid",
  "cancelledByKind": null, "cancelReason": null, "branchName": "Centro",
  "customerFirstName": "Rosa",
  "phoneCountryCode": "52", "phone": "5512349901"
}
```

- `queuePosition` (1-based, counted inside the product/variant queue) only while `WAITING`; `null` otherwise.
- `currentPriceCents`, `finalPriceCents`, `reservedAt`, `reservedUntil`, `reminderAt` are `null` until the backorder is reserved (T2). They are cleared again if the reservation is lost (`RESERVED → WAITING`); after `EXPIRED` they keep the values of the reservation that lapsed. `saleId` is set at checkout (T3, live).
- `sourceDecisionId` (T4, additive): the RESTOCK decision the backorder was scheduled from, in every status. To reschedule after `EXPIRED` / `CANCELLED` repeat `POST /chatbot-api/backorders` with this same id (§6.1). It is the decision you sent, never the server's re-estimate decision of §8.
- `cancelledByKind`: `CUSTOMER` (T1) or `STAFF` (T5a, live). `cancelReason` is what was sent (≤280).
- `productName`, `variantName`, `branchName` and `customerFirstName` are read live (the current names).
- `phoneCountryCode` and `phone` (T4b, additive): the customer's phone, exactly the pair the bot checkout locks on (`customers.phoneCountryCode` / `phone`), or `null` / `null` when the customer has none. They let you reach the customer when a feed item arrives with `conversationRef: null`, without asking again. They are the phone of **this backorder's own customer** and nothing else, and appear wherever a `BackorderBot` does (create, `GET :id`, list, cancel: each under the scope of its route) and in every `backorder.*` feed item (§10); never in any other payload.
- **Timestamps are ISO 8601 in UTC with `Z`** (`toISOString()`), like every other bot payload today (`holdUntil`, `reminderAt` of the pay-in-store hold, feed items). The approved proposal asked for an offset (`-06:00`); the backend keeps UTC `Z` for every backorder payload, feed items included, for consistency. Convert to local time on your side with the sucursal's time zone (America/Mexico_City).

## 5. Price (D1) — reference price live in T1, the rest in T2 (live)

- `referencePriceCents` (**T1**): computed by the server at scheduling with the price the bot checkout would use for that customer and quantity — the customer's price list (PUBLICO when none, or when the list has no price for the product) and the tier for `quantity`; **list price, without promotions**. A customer that does not exist yet (`createIfAbsent`) is priced as PUBLICO. If you send `expectedReferencePriceCents` and it differs → `409 PRICE_OUT_OF_DATE {currentPriceCents}`.
- Which list priced it is stored server-side (`referencePriceListId`, not in the bot payload): the customer's list when that list priced the line, none when the price came from PUBLICO.
- A customer the staff deletes from the POS: refused (`409`) while they have a `WAITING`/`RESERVED` backorder; with only `CONFIRMED`/`EXPIRED`/`CANCELLED` ones the customer is deleted and those backorders go with them (`GET /chatbot-api/backorders/:id` then answers `404 BACKORDER_NOT_FOUND`).
- `currentPriceCents` (T2): at reservation, the price that customer would pay that day through the bot for that quantity **with automatic promotions** (the final unit price `POST /chatbot-api/pricing/evaluate-cart` returns). The customer never pays more than a counter customer would that day.
- `finalPriceCents = min(referencePriceCents, currentPriceCents)` (T2), frozen at reservation and shown in the arrival message.
- At checkout the backorder line is priced at `finalPriceCents` and **promotions are not applied again to that line** (T3, live, §7).

## 7. Confirm = normal checkout with `backorderId` (D5) — **T3, live**

`POST /chatbot-api/checkouts` accepts an optional `sale.items[i].backorderId` (UUID; `null` is the same as omitted). Nothing else of the request or the response changes. The member exists **only on `POST /chatbot-api/checkouts`**: the legacy `POST /chatbot-api/sales` (which shares the confirmation code but has no way to validate and consume a reservation) keeps rejecting it as an unknown member (`400`).

```json
{
  "phoneCountryCode": "52", "phone": "5512349901",
  "customer": { "mode": "existing", "customerId": "uuid" },
  "sale": {
    "cashierUserId": "uuid",
    "items": [
      { "productId": "uuid", "productName": "Croquetas Adulto Raza Grande 18 kg",
        "quantity": 2, "unitPriceCents": 109900, "backorderId": "uuid-of-the-reserved-backorder" },
      { "productId": "uuid", "productName": "Collar", "quantity": 1, "unitPriceCents": 50000 }
    ],
    "expectedTotalCents": 269800,
    "shipping": { "mode": "pickup" }
  }
}
```

**Rules for a line with `backorderId`** (in this order; rule 2 runs and commits in its own short transaction before the checkout transaction, the rest inside the confirm transaction):

1. The backorder must exist in the sucursal and be `RESERVED` with `reservedUntil > now`.
2. A reserved lot that expired meanwhile is swapped for a valid one (silent, committed before the checkout) or, when valid stock cannot cover it, the reservation is lost (owner Q6: an expired lot is never sold).
3. Same customer, `productId`, `variantId` (omitted = `null`) and `quantity` as the backorder.
4. `unitPriceCents` must equal the backorder's `finalPriceCents`. **That line skips the list-price check and the promotions** (owner Q3): it is sold at `finalPriceCents × quantity`, as its own line (it never stacks with another line of the same product), stored as a `custom` price. The other lines keep today's rules (`PRICE_OUT_OF_DATE` against the live list price, promotions, stock). The price bypass exists only for a valid reservation: the same price without `backorderId`, or with an expired / cancelled / foreign one, is refused.
5. The reserved units are consumed by the sale (`BACKORDER_RELEASE` followed by the normal charge of the whole cart, same transaction): the sellable stock does not move and **no other waiting backorder is served in between**. The backorder becomes `CONFIRMED` with `saleId`, `confirmedAt` and `version + 1`.

**`expectedTotalCents` and `PROMO_RE_QUOTE`.** The server totals the backorder lines at `finalPriceCents × quantity` and prices the other lines exactly as before; backorder lines are **outside the promotion base** (an order-level promotion is computed on the ordinary lines only). So:

```
expectedTotalCents = Σ(finalPriceCents × quantity of the backorder lines)
                   + total of the ordinary lines (what POST /chatbot-api/pricing/evaluate-cart returns for ONLY those lines)
                   + shipping charge, if any
```

A cart made only of backorder lines is `Σ finalPriceCents × quantity`. A wrong total is `409 PROMO_RE_QUOTE { recomputedTotalCents, … }` as today, and `recomputedTotalCents` is computed that way.

**Errors** (code-only body `{ statusCode, error, message }` with `error === message`, plus the detail member shown). Everything else is as for any checkout (`PRICE_OUT_OF_DATE` of an ordinary line, `STOCK_INSUFFICIENT_AT_CONFIRM`, `IDEMPOTENCY_KEY_*`, …).

| Status | `error` (+ detail) | When |
| --- | --- | --- |
| 404 | `BACKORDER_NOT_FOUND` | no such backorder in this sucursal (another sucursal's id is the same) |
| 409 | `BACKORDER_NOT_RESERVED {status}` | `WAITING`, `CONFIRMED`, `EXPIRED` or `CANCELLED` (a second checkout of a confirmed one answers `{status: "CONFIRMED"}`) |
| 409 | `BACKORDER_RESERVATION_EXPIRED` | `reservedUntil` passed (even if the sweep has not run yet) |
| 409 | `BACKORDER_RESERVATION_LOST` | the reserved lot expired and valid stock cannot replace it. The backorder is back to `WAITING` at its place and **you also get `backorder.reservation_lost`** (committed even though the checkout failed): apologise as for that item, do not retry |
| 409 | `BACKORDER_MISMATCH {field}` | `field` is `customerId`, `productId`, `variantId` or `quantity` |
| 409 | `PRICE_OUT_OF_DATE {currentPriceCents}` | `unitPriceCents` is not the backorder's `finalPriceCents` (`currentPriceCents` is that value). A stale price on an ordinary line is the old code-only `PRICE_OUT_OF_DATE` |
| 409 | `BACKORDER_RESERVATION_UNAVAILABLE` | the backorder is `RESERVED` but the stock journal holds nothing for it (a data fault, logged by the backend; staff fix it). Not actionable by the bot: tell the customer staff will call |
| 400 | `INVALID_CHECKOUT_REQUEST` | `backorderId` is not a UUID, or the same backorder appears twice in the cart |
| 503 | `BACKORDER_CHECKOUT_UNAVAILABLE` | the backorder module is not bound in this backend (a misconfigured deployment) |

A refused checkout writes no sale, no receipt and charges nothing: the same `X-Idempotency-Key` may be retried (except after `BACKORDER_RESERVATION_LOST`, whose retry is a plain `BACKORDER_NOT_RESERVED {status: "WAITING"}`).

**Idempotency.** `backorderId` joins the request hash **only when present**; a request without it hashes byte for byte as before. Same key + same body replays the stored `201` (even though the backorder is no longer `RESERVED`); same key with another `backorderId`, or with none, is `409 IDEMPOTENCY_KEY_CONFLICT`.

**Races.** Against the 24 h sweep, a customer cancel and the arrival allocator, a reservation is taken by exactly one of them: if the checkout commits first the sweep and the cancel find a `CONFIRMED` backorder (the cancel answers `409 BACKORDER_NOT_CANCELLABLE {status: "CONFIRMED"}`); if the expiry or the cancel commits first the checkout answers `BACKORDER_NOT_RESERVED {status: "EXPIRED" | "CANCELLED"}`. Nothing is charged twice.

**Home delivery with a backorder line and an ordinary line of the same product:** quote the product once with the summed quantity (`POST /chatbot-api/shipping-quotes` refuses repeated lines, `DUPLICATE_CART_LINE`); the checkout sends the two lines separately and the quote binding sums quantities per `(productId, variantId)` before comparing, so it validates (no `SHIPPING_QUOTE_MISMATCH [LINES]`).

Mixed carts, shipping or pickup and the pay-in-store hold (`PATCH /chatbot-api/sales/:saleId/payment-intent`) work unchanged. If that sale is later cancelled or its hold expires, the units return to the general stock (`reverseSale`) and the next `WAITING` backorder is reserved (§4). The `CONFIRMED` backorder stays `CONFIRMED`.

## 8. Overdue ETA (D6) — **T4, live**

What you receive, and when. **Nothing, until staff answer.** When a `WAITING` backorder's `estimatedAt` passes (and it has not been asked yet: `etaStage = 0`), the server asks staff for a new RESTOCK estimate **before telling the customer anything**: you get no feed item, `GET /chatbot-api/backorders` still shows the old `estimatedAt` (now in the past), and the backorder keeps its place in the queue and can still be reserved on arrival. Do not invent a new date for the customer while it is pending.

**One re-estimate per (sucursal, product, variant).** The sweep (every 30 s) groups the overdue backorders of a product/variant: if a re-estimate for it is already pending, the newly overdue backorder joins it; otherwise one is created. Five customers waiting for the same product cost staff ONE question. A product/variant gets its next question only after the previous one was answered, and only for backorders that became overdue afterwards.

**When staff answer** (`POST /human-decisions/:id/resolve`, the existing route, the same transaction as the resolution), **every** backorder that is still `WAITING` and attached to that question moves on and each gets its **own** feed item, exactly once:

| Staff action | Effect on each backorder | Feed item (payload besides the common fields) |
| --- | --- | --- |
| `PROVIDE_RESTOCK_ESTIMATE` (`restockDays` 1–365) | `estimatedAt = resolvedAt + restockDays`, `estimatedArrivalDays = restockDays`, `version + 1` | `backorder.eta_updated` `{ estimatedAt, restockDays }` |
| `REPORT_RESTOCK_ESTIMATE_UNAVAILABLE` | `estimatedAt` / `estimatedArrivalDays` unchanged (the date stays in the past), `version + 1` | `backorder.eta_unavailable` (no extra member) |

- `eta_updated`: tell the customer the new date. It is a human estimate («aproximadamente»), not a guaranteed stock date; `estimatedAt` may be close or already past if staff answered a very short number of days late (the answer is anchored to the moment staff resolved, not to delivery).
- `eta_unavailable`: staff have **no confirmed date**. It does not mean «never»: the backorder stays `WAITING` in its place and is reserved as soon as stock arrives (you will get `backorder.reserved`). Offer to keep waiting or cancel (`POST …/cancel`).
- Skipped without a message: a backorder that became `RESERVED`, `CONFIRMED`, `CANCELLED` or `EXPIRED` before staff answered (a reserved customer already has a real date: the reservation). If a reservation is lost (`backorder.reservation_lost`) and the backorder returns to `WAITING` still attached to an already answered question, the next sweep tick applies that answer to it and you get the eta item then (so the customer is never left with a stale past date without a message).
- **Only once per backorder** (`etaStage` 0 → 1 → 2): after the answer there is no second automatic re-estimate. If its (new) `estimatedAt` passes too, nothing is sent; the staff list flags it as overdue (`etaOverdue`, T5a).
- **No generic `request.answered`, and the question never reaches you.** The staff-side request that carries the question is created by the server with no customer and no conversation and is staff-only (`context.origin = "BACKORDER_REESTIMATE"`): you never get a `request.answered` for it, **whichever screen staff answer it from** (the request inbox, `POST /chatbot-requests/:id/resolve`, or the human-decisions screen, `POST /human-decisions/:id/resolve`), and it is **never listed by the request recovery read** (`GET /chatbot-api/requests?status=open`, with or without `updatedSince`) nor served by the feed. Only the two items above reach you. Your own RESTOCK requests (`POST /chatbot-api/requests`) are unchanged: staff answers still arrive as `request.answered`.
- **No expiry.** A RESTOCK decision has no expiry or cancel path: if staff never answer, the question stays pending, the backorders stay `WAITING` and you hear nothing. (If every attached backorder is cancelled meanwhile the question stays open for staff until they answer it; the answer then affects nobody.)
- Both items follow §10 (ACK, `deliveryId` dedupe, `PROVIDER_REJECTED` is only recorded). `version` in the payload is the **bumped** version, so a retry or a second backend replica never repeats the item.

Staff-facing note (POS): the server-created question is a normal RESTOCK request in the staff inbox. It is recognised by its summary **«Reposición vencida: <producto>»** and `context.origin = "BACKORDER_REESTIMATE"` on the request (no customer, no conversation, never claimed by the bot). It is answered with the usual actions (`PROVIDE_RESTOCK_ESTIMATE` with the days, or `REPORT_RESTOCK_ESTIMATE_UNAVAILABLE`); the decision list (`GET /human-decisions`) shows it like any RESTOCK, without quantity or stock snapshot, and does not expose its origin. It can be answered from the request inbox (`POST /chatbot-requests/:id/resolve`) or from the human-decisions screen (`POST /human-decisions/:id/resolve`): both fan the answer out to the attached backorders and neither sends a `request.answered` to the bot. The answer is applied inside the staff resolution without waiting for a backorder row another transaction holds (a row the stock allocator is working on is skipped and receives the same answer on the next sweep tick, once).

Source (T4): `src/backorders/infrastructure/backorder-reestimate.service.ts`, `src/backorders/infrastructure/backorder-sweep.store.ts` (phases 4–5), `src/backorders/domain/backorder-reestimate.ts`, `src/human-decisions/infrastructure/restock-resolution.registry.ts` + `prisma-human-decision-review-resolve.repository.ts` (the hook), `src/chatbot-requests/infrastructure/chatbot-request-wrapper.ts` (staff-only request), `src/chatbot-requests/domain/staff-only-request.ts` (the origin), `src/chatbot-requests/infrastructure/chatbot-feed-writes.ts` (`enqueueAnswered` skips it), `src/chatbot-requests/infrastructure/prisma-chatbot-recovery.store.ts` (recovery read), `src/backorders/backorder-reestimate.integration.spec.ts`.

## 10. Feed items — **T2 live (reserved, reminder, expired, lost); T4 live (eta_updated, eta_unavailable); T5a live (cancelled_by_staff)**

A backorder-level feed subject. The envelope of a `backorder.*` item is the standard feed item with `requestId: null` and **no `saleId` key**; the `backorderId` is in the `payload`:

```json
{
  "cursor": "000000004311",
  "deliveryId": "5b1f…",
  "type": "backorder.reserved",
  "requestId": null,
  "conversationRef": "wa:5215512349901",
  "payload": {
    "backorderId": "uuid", "folio": "BO-000012",
    "productName": "Croquetas Adulto Raza Grande 18 kg", "variantName": null,
    "quantity": 2, "branchName": "Centro", "customerFirstName": "Rosa",
    "phoneCountryCode": "52", "phone": "5512349901",
    "version": 3,
    "referencePriceCents": 114900, "currentPriceCents": 109900, "finalPriceCents": 109900,
    "reservedUntil": "2026-11-21T15:00:00.000Z", "reminderAt": "2026-11-21T12:00:00.000Z"
  },
  "notBefore": null, "expiresAt": null
}
```

`conversationRef` is the customer's mirrored chat (the one `chatbot_conversations` row of the customer's phone key), `null` when the customer has none or more than one: then reach the customer with the `phoneCountryCode` + `phone` of the payload (T4b, `null` / `null` when the customer has no phone; the common fields of every `backorder.*` item), or resolve the backorder from `backorderId` (`GET /chatbot-api/backorders/:id`). Same cursor, long-poll, `deliveryId` dedupe and ACK route as every item (`docs/chatbot-handoff/chatbot-requests-bot-contract.md`).

| Type | Task | When | Payload (besides the common fields `backorderId`, `folio`, `productName`, `variantName`, `quantity`, `branchName`, `customerFirstName`, `phoneCountryCode`, `phone`, `version`) |
| --- | --- | --- | --- |
| `backorder.reserved` | T2 | the backorder became `RESERVED` (same transaction) | `referencePriceCents`, `currentPriceCents`, `finalPriceCents`, `reservedUntil`, `reminderAt` |
| `backorder.reservation_reminder` | T2 | sweep, `reminderAt` passed, once | `reservedUntil` |
| `backorder.reservation_expired` | T2 | sweep, `reservedUntil` passed, terminal | `expiredAt`, `sourceDecisionId` (T4, additive: reschedule with it, §6.1) |
| `backorder.reservation_lost` | T2 | sweep, the reserved lot expired and no valid lot replaced it; back to `WAITING`, front of the queue (apologise) | `reason: "LOT_EXPIRED"`, `queuePosition` (1-based, right now), `estimatedAt` |
| `backorder.cancelled_by_staff` | **T5a live** | staff cancelled it from the POS (`POST /backorders/:id/cancel`), written in the cancelling transaction, exactly once (`version` is the cancelled state's) | `reason` (`null` when staff gave none), `sourceDecisionId` (T4, additive: reschedule with it, §6.1) |
| `backorder.eta_updated` | **T4 live** | overdue-ETA re-estimate answered with an estimate (§8) | `estimatedAt`, `restockDays` |
| `backorder.eta_unavailable` | **T4 live** | staff have no new estimate (§8) | — |

- `version` is the backorder's own `version` when the item was written: **at most one item per backorder, type and `version`** exists (a database guarantee), so a retry or a second backend replica can never send you the same item twice, while a second reservation of the same backorder after `backorder.reservation_lost` is a new item with a new `version`. Use `deliveryId` to dedupe, as always.
- All timestamps are **ISO 8601 UTC with `Z`** (`toISOString()`), like every bot payload; convert to local time on your side (America/Mexico_City).
- Examples of the other payloads:

```json
{ "type": "backorder.reservation_reminder", "payload": { "backorderId": "uuid", "folio": "BO-000012", "productName": "…", "variantName": null, "quantity": 2, "branchName": "Centro", "customerFirstName": "Rosa", "phoneCountryCode": "52", "phone": "5512349901", "version": 3, "reservedUntil": "2026-11-21T15:00:00.000Z" } }
{ "type": "backorder.reservation_expired", "payload": { "backorderId": "uuid", "folio": "BO-000012", "productName": "…", "variantName": null, "quantity": 2, "branchName": "Centro", "customerFirstName": "Rosa", "phoneCountryCode": "52", "phone": "5512349901", "version": 4, "expiredAt": "2026-11-21T15:00:01.000Z", "sourceDecisionId": "uuid" } }
{ "type": "backorder.cancelled_by_staff", "payload": { "backorderId": "uuid", "folio": "BO-000012", "productName": "…", "variantName": null, "quantity": 2, "branchName": "Centro", "customerFirstName": "Rosa", "phoneCountryCode": "52", "phone": "5512349901", "version": 3, "reason": "Producto descontinuado", "sourceDecisionId": "uuid" } }
{ "type": "backorder.eta_updated", "payload": { "backorderId": "uuid", "folio": "BO-000012", "productName": "…", "variantName": null, "quantity": 2, "branchName": "Centro", "customerFirstName": "Rosa", "phoneCountryCode": "52", "phone": "5512349901", "version": 2, "estimatedAt": "2026-11-27T15:00:00.000Z", "restockDays": 7 } }
{ "type": "backorder.eta_unavailable", "payload": { "backorderId": "uuid", "folio": "BO-000012", "productName": "…", "variantName": null, "quantity": 2, "branchName": "Centro", "customerFirstName": "Rosa", "phoneCountryCode": "52", "phone": "5512349901", "version": 2 } }
{ "type": "backorder.reservation_lost", "payload": { "backorderId": "uuid", "folio": "BO-000012", "productName": "…", "variantName": null, "quantity": 2, "branchName": "Centro", "customerFirstName": "Rosa", "phoneCountryCode": "52", "phone": "5512349901", "version": 4, "reason": "LOT_EXPIRED", "queuePosition": 1, "estimatedAt": "2026-11-27T15:00:00.000Z" } }
```

### ACK and the new outcome `PROVIDER_REJECTED`

`POST /chatbot-api/deliveries/:deliveryId/outcome` as for every item (same body rules, same `attemptId` / idempotency semantics, one terminal outcome per delivery). For a `backorder.*` item:

| `outcome` | Allowed | Notes |
| --- | --- | --- |
| `PROVIDER_ACCEPTED` | yes | `providerMessageId` and `attemptedAt` required |
| `DELIVERY_UNKNOWN` | yes | `attemptedAt`; do not retry |
| `STALE` | yes | you did not send it (the customer cancelled, a newer item overtook it…) |
| **`PROVIDER_REJECTED`** | **yes, backorder items only** | **new, terminal.** The provider refused the message and you will not retry. Body: `{attemptId, outcome: "PROVIDER_REJECTED", attemptedAt, reason}` with `reason` **required, 1 to 280 characters** (for example `TEMPLATE_NOT_APPROVED`, `UNREACHABLE`); no `providerMessageId` |
| `DEFERRED_WINDOW_CLOSED`, `DEFERRED_HUMAN_SESSION` | **no: `422 OUTCOME_NOT_ALLOWED`** | a reserved/expired notice that waits days is useless (the 24 h window runs regardless); send an approved template or ACK `STALE`/`PROVIDER_REJECTED` |

- `PROVIDER_REJECTED` for **any other item** (a request item, a sale item) is `422 OUTCOME_NOT_ALLOWED` and nothing is written. A `reason` with any outcome other than `PROVIDER_REJECTED`, or a `PROVIDER_REJECTED` without a valid `reason`, is `400 VALIDATION_ERROR`. The `reason` is part of the idempotency evidence: the same `attemptId` with another reason is `409 IDEMPOTENCY_CONFLICT`; a different attempt after the terminal outcome is `409 OUTCOME_ALREADY_RECORDED`.
- For **`backorder.reserved` and `backorder.reservation_reminder`** a `PROVIDER_REJECTED` makes the backend create a **staff notice** (in-app, with the `backorderId`, folio and the reason) so staff **call the customer** before the 24 h run out. For the other `backorder.*` types it is just recorded. The reason is stored with the delivery.
- No request audit event is written (a backorder item has no request); the outcome is stored on the delivery.

### Recovery after `410 CURSOR_EXPIRED`

`GET /chatbot-api/backorders?phoneCountryCode=…&phone=…&updatedSince=` (§6.3) is the backorder recovery read: it returns the **current state** of the customer's backorders (status, `reservedUntil`, `queuePosition`…) and, **when `updatedSince` is sent**, one extra member:

```json
{ "items": [ … ], "backorderUndeliveredResumeAfter": "000000004310" }
```

`backorderUndeliveredResumeAfter` is the feed `after` that serves the sucursal's **oldest `backorder.*` item with no terminal outcome** again (its cursor minus one, never below the purge watermark; a 12-digit zero-padded cursor), or `null` when every backorder item was acknowledged. It is about the whole sucursal, whichever phone you filtered by. After a `410`: do the request recovery walk (`GET /chatbot-api/requests`), read this route once with `updatedSince`, and resume the feed from the **smallest** of `nextCursor`, any `undeliveredResumeAfter`, `saleUndeliveredResumeAfter` and `backorderUndeliveredResumeAfter` (compare the fixed-width strings, no arithmetic); dedupe by `deliveryId`. Without `updatedSince` the answer is exactly `{ "items": [...] }` as in T1. A backorder item is never in `pending-deliveries` (never deferred) and the request recovery walk does not list it. The request recovery walk does not list the server-created re-estimate request either (staff-only, §8).

## Deploy checklist (T1)

1. Apply migration `20261120000000_backorders` (additive; two new tables and two enums, nothing existing is altered).
2. Add `backorders:create`, `backorders:read` and `backorders:cancel` to the chatbot's `svc_` credential.
3. Nothing else changes: existing routes, scopes and feed are untouched.

## Deploy checklist (T2)

1. **Ship T2 together with its sweep (it is in this build) and not before the bot sends `sale.items[i].backorderId` (T3, §7, in this build)**: a customer told «apartado por 24 h» must be able to confirm.
2. Your feed consumer must accept `requestId: null` **without** a `saleId` and the four `backorder.*` types above, and the new outcome `PROVIDER_REJECTED` (ACK `STALE` for types you do not handle yet): a strict parser would otherwise reject the page and stall the feed. Deploy the backend **after** the bot can parse them.
3. Apply migrations (additive, in this order, each in one short transaction at low traffic): `20261120010000_backorder_stock_movements` (three enum values), `20261121000000_backorder_feed` (feed column `backorderId`, subject CHECK widened to request / sale / backorder, tenant-qualified FK, exactly-once partial unique index, two partial indexes of the sweep) and `20261121000100_backorder_feed` (the closed outcome CHECK gains `PROVIDER_REJECTED`). Do not deploy the bot reporting `PROVIDER_REJECTED` before the last one: an older database answers `500`.
4. The sweep (`@Interval` 30 s) starts with the backend; no new credential or scope. Staff notices go to every active member with `read:Backorder` (T5a registers the subject and seeds the grant: Manager read + update, Cashier read; `manage` / `all` holders receive them too).
5. Existing items, outcomes, payloads, recovery and ACK behaviour of requests, conversations and sales are unchanged (additive only).

## Deploy checklist (T3)

1. No migration: the backorder line is stored with the existing `custom` price source (sticky, no promotion) and the existing `BACKORDER_RELEASE`/`SALE` journal types.
2. The bot must send `backorderId` only to `POST /chatbot-api/checkouts` and compute `expectedTotalCents` as in §7. Requests without `backorderId` are unchanged (status, body, errors, idempotency hash).
3. Deploy the bot's handling of the new codes (`BACKORDER_*`, `PRICE_OUT_OF_DATE {currentPriceCents}`) with or before the backend.

## Deploy checklist (T4)

1. **No migration** (`etaStage` and `reestimateDecisionId` shipped with T1).
2. Your feed consumer must accept `backorder.eta_updated` / `backorder.eta_unavailable` (same envelope as the other `backorder.*` items; ACK `STALE` for a type you do not handle yet) and the additive `sourceDecisionId` member in `BackorderBot` and in the `reservation_expired` / `cancelled_by_staff` payloads (unknown members must be ignored). Deploy the backend **after** the bot parses them.
3. The sweep gains two phases (overdue-ETA request, repair of an answered re-estimate) on the same 30 s interval; no new credential or scope. The first tick after the deploy creates ONE staff RESTOCK request per product/variant that already has overdue `WAITING` backorders (staff get the usual new-request notice).
4. Existing RESTOCK/EXPIRATION flows are unchanged: bot intake, staff review and resolve, `request.answered` for a bot-created RESTOCK.

## Deploy checklist (T5a)

1. **No migration.** New CASL subject `Backorder` (`read`, `update`): `PermissionSeeder` upserts the two `permissions` rows on boot; a fresh `prisma db seed` grants Manager read + update and Cashier read. **Existing databases** need the role grants added by hand (or a grant script): without them only super admins (`manage:all`) see the staff screen and receive the staff notices.
2. Your feed consumer must accept `backorder.cancelled_by_staff` (same envelope as the other `backorder.*` items; ACK `STALE` for a type you do not handle yet). A staff cancel is the only way you hear about a cancellation you did not make. Deploy the backend **after** the bot parses it.
3. Staff cancel of a `RESERVED` backorder re-allocates the released units to the next `WAITING` backorder in the same transaction: that backorder's own `backorder.reserved` is written then, as for any other release.
4. The staff API is documented for the frontend in `docs/frontend-handoff/26-restock-backorder.md`; nothing in it is called by the bot.
