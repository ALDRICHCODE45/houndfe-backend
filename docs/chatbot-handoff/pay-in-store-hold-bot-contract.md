# Chatbot ↔ backend: pay in store for pickup orders (T1, T2, T3)

**Status:** T1, T2 and T3 on branch `feat/pay-in-store-hold`, not merged, not deployed. Migrations `20261118010000_pay_in_store_hold` then `20261118020000_sale_feed_items` (T2 adds none). Task: `odd/tasks/pay-in-store-pickup.md` (S1–S6). The feed items `sale.pickup_reminder`, `sale.pickup_expired` and `sale.pickup_extended` (S6) are **built**: `sale.pickup_extended` is emitted by the staff deadline edit (T3); the reminder and the expiry items are emitted by the hold sweep (**T2, built**, see "Hold sweep (T2)").

Source: `src/chatbot-api/presentation/pay-in-store.controller.ts`, `src/sales/sale-hold.service.ts`, `src/sales/sale-hold-sweep.store.ts`, `src/sales/domain/sale-hold-sweep.ts`, `src/chatbot-requests/infrastructure/sale-feed-writes.ts`, `src/chatbot-api/presentation/pay-in-store-hold.integration.spec.ts`, `src/chatbot-requests/chatbot-feed-sale-items.integration.spec.ts`, `src/sales/sale-hold-sweep.integration.spec.ts`.

## Flow

1. Create the PICKUP sale as today: `POST /chatbot-api/checkouts` or `POST /chatbot-api/sales` with `shipping: { "mode": "pickup" }`. The sale is `CONFIRMED`, `paymentStatus: "CREDIT"`, and its stock is already reserved.
2. If the customer chooses to pay at the counter, call `PATCH /chatbot-api/sales/:saleId/payment-intent` (below) and tell the customer the deadline (`holdUntil`).
3. If the customer pays by transfer instead, do **not** call it; use the receipt flow as today.
4. The customer pays at the counter; staff charge the sale in the POS. A paid sale (even partially) is never auto-cancelled.
5. At `reminderAt` you get `sale.pickup_reminder`; at `holdUntil`, if nothing was paid and no transfer receipt is pending, the sale is cancelled and you get `sale.pickup_expired` (T2).

Sales without a declared intent never get a deadline (existing pickup orders included).

## `PATCH /chatbot-api/sales/:saleId/payment-intent`

Scope `sales:write` (the same as the other post-sale writes: delivery metadata, cancel, receipts). Route budget: `default`. Why a separate route and not a checkout field: the checkout request, its idempotency hash and its cached receipts stay untouched, and the customer can choose how to pay after the order is confirmed.

Request:

```json
{ "method": "IN_STORE" }
```

`IN_STORE` is the only accepted value (anything else → `400`).

Preconditions: the sale belongs to the credential's tenant and is `CONFIRMED`, `ONLINE`, `PICKUP`, `paymentStatus: "CREDIT"` with nothing paid.

Response `200`:

```json
{
  "saleId": "8c1d…",
  "folio": "<sale folio, same value as the checkout answer>",
  "paymentIntent": "IN_STORE",
  "holdUntil": "2026-11-19T18:30:00.000Z",
  "reminderAt": "2026-11-19T15:30:00.000Z"
}
```

- `holdUntil` = now + **24 h** (fixed default, S5). Staff may move it per sale from the POS later.
- `reminderAt` = `holdUntil − 3 h`, or `null` when the hold is 3 h or shorter (S3). The reminder itself arrives as a feed item (`sale.pickup_reminder`, below); the bot does not schedule anything.

**Idempotent:** calling it again for a sale already marked (and still eligible) returns the **current** hold unchanged (`200`, same body unless staff moved the deadline meanwhile). Safe to retry after a timeout. No `X-Idempotency-Key` is needed.

Errors (code-only body `{ "statusCode", "error", "message" }`, `error === message`):

| Status | `error` | Meaning |
| --- | --- | --- |
| `400` | (validation) | Body is not `{ "method": "IN_STORE" }` or `saleId` is not a UUID. |
| `403` | — | Credential without `sales:write`. |
| `404` | `SALE_NOT_FOUND` | No such sale for this tenant (another sucursal's sale is also 404). |
| `409` | `PAY_IN_STORE_SALE_NOT_CONFIRMED` | The sale is cancelled (or not confirmed). |
| `409` | `PAY_IN_STORE_SALE_ALREADY_PAID` | A payment exists (`PARTIAL`/`PAID`); nothing to hold. |
| `422` | `PAY_IN_STORE_REQUIRES_ONLINE` | Not a bot (ONLINE) sale. |
| `422` | `PAY_IN_STORE_REQUIRES_PICKUP` | Not a store-pickup sale (delivery or legacy without mode). |

## Reading the hold: `GET /chatbot-api/checkouts/status`

For a succeeded checkout, the answer gains a sibling key `hold` (the sale's **current** hold, read live; `null` when no intent was declared). `checkout` stays the byte-identical creation receipt.

```json
{
  "status": "succeeded",
  "checkout": { "…": "unchanged creation receipt" },
  "hold": {
    "paymentIntent": "IN_STORE",
    "expiresAt": "2026-11-19T18:30:00.000Z",
    "reminderAt": "2026-11-19T15:30:00.000Z",
    "stage": 0,
    "version": 1
  }
}
```

`stage`: `0` nothing sent, `1` reminder stage done, `2` hold over (expired and cancelled, or closed by the sweep because it was paid, cancelled or handed to staff). `version` grows on every change (bot mark, staff edit); the sweep changes `stage`, never `version`.

## Feed items (T3)

**Deploy checklist (pay-in-store, T1-T3).** Order is binding:
1. The bot ships a feed consumer that accepts `requestId: null` with a `saleId` and the `sale.pickup_*` types (ACK `STALE` while its pay-in-store flow is off). Until then this backend must not be deployed: a strict parser would reject the page and stall the whole feed.
2. Backend deploy (migrations `20261118010000_pay_in_store_hold`, `20261118020000_sale_feed_items`; the second briefly holds ACCESS EXCLUSIVE on `chatbot_feed_items` and SHARE ROW EXCLUSIVE on `sales`: deploy at low traffic).
3. The bot enables its flow (`PATCH /chatbot-api/sales/:saleId/payment-intent`). No sale item can exist before a sale is marked `IN_STORE`, and only the bot marks it; a staff hold edit then emits `sale.pickup_extended` at once.

They arrive on the same feed as the request items (`GET /chatbot-api/feed`, scope `feed:read`) and are acknowledged on the same route (`POST /chatbot-api/deliveries/:deliveryId/outcome`, scope `feed:ack`). They belong to a **sale**, not to a request.

```json
{
  "cursor": "000000002210",
  "deliveryId": "6f0e…",
  "type": "sale.pickup_reminder",
  "requestId": null,
  "saleId": "8c1d…",
  "conversationRef": "wa:5215512340000",
  "payload": {
    "saleId": "8c1d…",
    "folio": "<sale folio>",
    "holdUntil": "2026-11-19T18:30:00.000Z",
    "holdVersion": 1,
    "conversationRef": "wa:5215512340000"
  },
  "notBefore": null,
  "expiresAt": null
}
```

| `type`                 | Emitted when                                                                                                                         | `payload`                                                  | What you tell the customer                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------- |
| `sale.pickup_reminder` | `reminderAt` passed (3 h before `holdUntil`; never for a hold of 3 h or less), sale still unpaid. Sweep (T2)                      | `{saleId, folio, holdUntil, holdVersion, conversationRef}` | "Tu pedido {folio} se aparta hasta {holdUntil}; pasa a pagarlo" |
| `sale.pickup_expired`  | `holdUntil` passed unpaid, with no pending transfer receipt: the sale was cancelled (`HOLD_EXPIRED`) and its stock released. Sweep (T2)| `{saleId, folio, holdVersion, conversationRef}`            | "El apartado de {folio} venció y el pedido se canceló"          |
| `sale.pickup_extended` | Staff moved the deadline (`PATCH /sales/:id/hold`), in the same transaction; only for a sale with a customer. Informational        | `{saleId, folio, holdUntil, holdVersion, conversationRef}` | "Tu apartado de {folio} ahora vence {holdUntil}"                |

You compose the wording (tú/usted); there is no fallback text. `holdUntil` is ISO UTC: render it in the branch's time zone.

**Envelope.** `requestId` is `null` and the item carries an extra top-level `saleId` (request items do not have this key). `folio` is the sale folio (`null` only for a sale that has none).

**`conversationRef`** (top level and payload, the same value): the one mirrored chat (`chatbot_conversations`) of the branch whose phone key is the canonical phone of the sale's customer, resolved like the transfer-receipt requests. `null` when the customer has no phone, no chat, or more than one chat. With `null`, use the conversation of your own checkout record for `saleId`; if you have none, ACK `STALE`. It contains the customer's phone: keep it out of logs.

**`holdVersion` and staleness.** Each item belongs to one hold version (the `hold.version` of `GET /chatbot-api/checkouts/status`). Before you send, read the live hold: if `hold.version` is greater than the item's `holdVersion`, a later change overtook it (for example staff extended the deadline after a reminder was queued): ACK `STALE`. If the sale is already paid or cancelled, a reminder or an extension is moot: ACK `STALE`.

**Exactly once.** The backend enqueues at most one item per (sale, type, `holdVersion`) (partial unique index `chatbot_feed_items_sale_hold_uq`): a sweep retry, a second replica or a repeated call is a no-op. Every staff edit bumps the version, so each edit brings one `sale.pickup_extended`, and the reset hold can bring a new reminder. The bot's own `PATCH …/payment-intent` emits **no** item. The feed is still at-least-once: dedupe by `deliveryId`.

**ACK rules** (`POST /chatbot-api/deliveries/:deliveryId/outcome`, same body as every item):

| Outcome                  | Allowed | Use it when                                                                                                                 |
| ------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `PROVIDER_ACCEPTED`      | yes     | Meta accepted the message (send `providerMessageId`).                                                                       |
| `DELIVERY_UNKNOWN`       | yes     | You tried and cannot tell; do not retry.                                                                                    |
| `STALE`                  | yes     | Not sent and not needed: overtaken version, paid/cancelled sale, no conversation, window closed with no template, human session. |
| `DEFERRED_WINDOW_CLOSED` | **no**  | `422 OUTCOME_NOT_ALLOWED`: a hold notice delivered after the customer writes again is useless (the deadline may have passed). |
| `DEFERRED_HUMAN_SESSION` | **no**  | `422 OUTCOME_NOT_ALLOWED`: during a human session ACK `STALE`; the attendee sees the hold in the POS.                        |

One terminal outcome per delivery: the same `attemptId` with the same evidence replays `200`; a new `attemptId` afterwards is `409 OUTCOME_ALREADY_RECORDED`; the same `attemptId` with other evidence is `409 IDEMPOTENCY_CONFLICT`. The outcome is stored on the delivery (there is no request audit for a sale item). The reminder fires 21 h after a 24 h hold started, usually inside the customer's 24 h window; the expiry fires at 24 h, usually **outside** it: send it with an approved template or ACK `STALE`.

**Not in `pending-deliveries`** (they are never deferred).

**Recovery after `410 CURSOR_EXPIRED`.** Sale items belong to no request, so the request walk (`GET /chatbot-api/requests?status=open`) cannot list them. Its answer carries `saleUndeliveredResumeAfter`: the feed `after` that re-serves the branch's oldest sale item with no terminal outcome (never below the purge watermark), or `null`. Resume the feed from the smallest of `nextCursor`, `saleUndeliveredResumeAfter` and any `undeliveredResumeAfter`, dedupe by `deliveryId`, apply the staleness check above (`GET /chatbot-api/checkouts/status`) and ACK each one. Feed items are kept 30 days, far longer than a hold.

## Hold sweep (T2)

Built. A backend interval (every 30 s, any number of replicas) walks the open holds (`CONFIRMED`, `stage` < 2, deadline set). Each sale is decided under its own row lock (`FOR UPDATE SKIP LOCKED`) after re-checking `hold.version` and `stage`, so a staff edit or a counter payment that commits first always wins, and two replicas never act twice.

| When | Sale state under the lock | What happens | Bot gets |
| --- | --- | --- | --- |
| `reminderAt` passed, `stage` 0, deadline not reached | unpaid (`CREDIT`, nothing paid) | `stage` 1 | `sale.pickup_reminder` (once per `holdVersion`) |
| same | partially paid | `stage` 1, no reminder (staff review it at the deadline) | nothing |
| same | fully paid or cancelled | `stage` 2 | nothing |
| `holdUntil` passed | unpaid, no `PENDING` transfer receipt | sale cancelled `cancelReason: "HOLD_EXPIRED"` by the system: stock released through the journal, promotion capacity returned, `sale.canceled` event; `stage` 2 | `sale.pickup_expired` (once per `holdVersion`) |
| `holdUntil` passed | partially paid, or a transfer receipt `PENDING` (S4) | **not cancelled**; staff get one in-app notice to decide (and refund if needed); `stage` 2 | nothing |
| `holdUntil` passed | fully paid, cancelled, or already handed over | `stage` 2 | nothing |

A missed reminder is never sent after the deadline (the expiry stage runs instead). Items go only to sales with a customer (the bot's checkout always sets one). If staff extend a hold that stage 2 left uncancelled (pending receipt), the hold restarts (`stage` 0, `version` + 1, `sale.pickup_extended`) and is swept again at the new deadline.

**Cancelling yourself.** `POST /chatbot-api/sales/:saleId/cancel` does not accept `HOLD_EXPIRED` (system-only reason). After a `sale.pickup_expired`, the sale is `CANCELED`; a later cancel call is the usual idempotent replay.
