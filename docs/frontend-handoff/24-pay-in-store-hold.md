# POS — pay-in-store hold of bot pickup orders ("Apartado")

**Status:** T1 on branch `feat/pay-in-store-hold`, **not merged, not pushed, not deployed**. Migration `20261118010000_pay_in_store_hold` must be deployed first. The reminder/expiry sweep (T2) and the bot feed items (T3) are **not built yet**: today nothing is reminded or auto-cancelled; the deadline is only stored, shown and editable. Task: `odd/tasks/pay-in-store-pickup.md`.

Shapes come from the code and its specs: `src/sales/sale-hold.controller.ts`, `src/sales/sale-hold.service.ts`, `src/sales/domain/sale-hold.ts`, `src/chatbot-api/presentation/pay-in-store-hold.integration.spec.ts` (real PostgreSQL). Nothing was sent to the dev API.

## What it is

A WhatsApp customer orders for **store pickup** and says they will **pay at the counter**. The bot marks the sale `IN_STORE`; the backend holds the order (stock is already reserved at confirmation) until a deadline: **24 h by default**, changeable **per sale** from the POS (owner decisions S2/S5). The customer gets a reminder **3 h before** the deadline; with a deadline of 3 h or less there is no reminder (S3). When the deadline passes unpaid, the sale will be cancelled automatically and the stock released (T2, not built yet), unless a payment or a pending transfer receipt exists (then staff get a notice instead, S4).

## 1. Reading the hold: `hold` on GET `/sales/:id` and GET `/sales`

Additive key on the sale detail and on every row of the sales list. `null` for every sale that never declared an intent (all POS sales, and bot sales where the customer did not choose pay-in-store):

```json
"hold": {
  "paymentIntent": "IN_STORE",
  "expiresAt": "2026-11-19T18:30:00.000Z",
  "reminderAt": "2026-11-19T15:30:00.000Z",
  "stage": 0,
  "version": 1
}
```

| Field | Meaning |
| --- | --- |
| `paymentIntent` | Always `"IN_STORE"` when `hold` is not null. |
| `expiresAt` | The deadline (UTC ISO). Render in the sucursal time zone. |
| `reminderAt` | When the customer reminder goes out (`expiresAt − 3 h`), or `null` when the hold is 3 h or shorter. |
| `stage` | `0` nothing sent yet, `1` reminder sent, `2` expired (set by T2). Reset to `0` on every edit. |
| `version` | Send it back as `expectedVersion` when editing. |

### Display rule

Show the badge **«Apartado · pagar en tienda · vence {fecha}»** only while the hold is live:

`hold !== null && status === "CONFIRMED" && paymentStatus === "CREDIT"`

`{fecha}` = `expiresAt` in the sucursal time zone (e.g. «vie 19 nov, 12:30»). Once the sale is paid (`PARTIAL`/`PAID`) or cancelled, hide the badge: the `hold` object stays on the sale as history, but a paid sale is never expired (see §3). A cancelled sale whose `cancelReason` is `HOLD_EXPIRED` was cancelled by the deadline (T2); label it «Apartado vencido».

## 2. Editing the deadline: `PATCH /sales/:id/hold`

Permission: `update:Sale` (the same as every other confirmed-sale edit, e.g. `PATCH /sales/:id/due-date`). Hide the edit control without it.

Request:

```json
{ "expiresAt": "2026-11-20T23:00:00-06:00", "expectedVersion": 1 }
```

- `expiresAt`: ISO 8601 with time and offset, **in the future**. Any length is accepted (there is no maximum).
- `expectedVersion`: the `hold.version` you displayed.

Response `200`: the full sale detail (same shape as `GET /sales/:id`) with the new `hold`: `expiresAt` updated, `reminderAt` recomputed (`expiresAt − 3 h`, or `null` if that is already past), `stage: 0`, `version + 1`. The change is logged with the acting user (`sale.hold.updated`). Once T3 ships, the customer is told about the new deadline over WhatsApp.

Errors (sales envelope `{ statusCode, error, message }`, switch on `error`):

| Status | `error` | Meaning / what to do |
| --- | --- | --- |
| `400` | (validation) | `expiresAt` not ISO or `expectedVersion` not an integer ≥ 0. |
| `403` | — | Missing `update:Sale`. |
| `404` | `SALE_NOT_FOUND` | No such sale in this sucursal. |
| `409` | `SALE_NOT_PAY_IN_STORE` | The sale has no pay-in-store hold. |
| `409` | `SALE_HOLD_NOT_EDITABLE` | Already paid (any amount) or cancelled; the hold is over. Reload. |
| `409` | `HOLD_VERSION_CONFLICT` | Someone else changed it (or the system sent the reminder/expired it). Reload and retry. |
| `422` | `HOLD_EXPIRY_NOT_FUTURE` | The chosen deadline is not in the future. |

## 3. Charging at the counter: `POST /sales/:id/payments`

The existing payment route (permission `update:Sale`, `Idempotency-Key` header required) now accepts **ONLINE (bot) sales from any staff member**. Before T1 it answered `404 SALE_NOT_FOUND` unless the caller was the bot's configured cashier. The owner rule is unchanged for POS sales: only the cashier who rang a POS sale can add payments to it.

```http
POST /sales/{saleId}/payments
Idempotency-Key: <one per press>

{ "method": "cash", "amountCents": 45000, "cashSessionId": "<open session, optional>" }
```

Same body, split payments (`payments: [...]`), catalog `paymentMethodId` and cash-session binding as for any other later collection. Response: `{ saleId, paidCents, debtCents, totalCents, paymentStatus, paymentIds }`.

Any payment (`PARTIAL` or `PAID`) ends the hold: the sale can no longer be edited with `PATCH /hold` and it will never be auto-cancelled by the deadline. After charging, mark the pickup as delivered as usual.

## Test data

`hold` appears only on bot pickup sales after the bot calls `PATCH /chatbot-api/sales/:saleId/payment-intent` (see `docs/chatbot-handoff/pay-in-store-hold-bot-contract.md`). To get one on the dev DB, create a bot pickup sale and call that route with a bot credential holding `sales:write`; no seed creates holds.
