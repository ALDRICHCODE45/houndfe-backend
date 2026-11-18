# Chatbot ↔ backend: pay in store for pickup orders (T1)

**Status:** T1 on branch `feat/pay-in-store-hold`, not merged, not deployed. Migration `20261118010000_pay_in_store_hold` first. Task: `odd/tasks/pay-in-store-pickup.md` (S1–S6). The feed items `sale.pickup_reminder`, `sale.pickup_expired` and `sale.pickup_extended` (S6) are **T3, not built yet**; the reminder/expiry sweep is **T2, not built yet**.

Source: `src/chatbot-api/presentation/pay-in-store.controller.ts`, `src/sales/sale-hold.service.ts`, `src/chatbot-api/presentation/pay-in-store-hold.integration.spec.ts`.

## Flow

1. Create the PICKUP sale as today: `POST /chatbot-api/checkouts` or `POST /chatbot-api/sales` with `shipping: { "mode": "pickup" }`. The sale is `CONFIRMED`, `paymentStatus: "CREDIT"`, and its stock is already reserved.
2. If the customer chooses to pay at the counter, call `PATCH /chatbot-api/sales/:saleId/payment-intent` (below) and tell the customer the deadline (`holdUntil`).
3. If the customer pays by transfer instead, do **not** call it; use the receipt flow as today.
4. The customer pays at the counter; staff charge the sale in the POS. A paid sale (even partially) is never auto-cancelled.

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
- `reminderAt` = `holdUntil − 3 h`, or `null` when the hold is 3 h or shorter (S3). The reminder itself will arrive as a feed item in T3; the bot does not schedule anything.

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

`stage`: `0` nothing sent, `1` reminded, `2` expired (T2). `version` grows on every change (bot mark, staff edit).

## Not in T1

- Reminder and expiry (T2): at `reminderAt` the customer is reminded; at `holdUntil`, an unpaid sale with no pending transfer receipt is cancelled with `cancelReason: "HOLD_EXPIRED"` and its stock released; with a payment or a pending receipt, staff get a notice instead (S4).
- Feed items (T3): `sale.pickup_reminder { saleId, folio, holdUntil }`, `sale.pickup_expired { saleId, folio }`, `sale.pickup_extended { saleId, folio, holdUntil }`.
