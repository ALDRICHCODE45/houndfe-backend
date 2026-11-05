# Refund settlements (pending refunds and partial returns)

**Status: Backend implemented; no FE screen yet.** Both endpoints are merged to local `main`. Whether the screen gets built is still a product decision; this document is enough to design and build it without further questions.

Every example below is a real request/response captured on 2026-11-05 over HTTP against the built app and the dev DB, logged in as `manager@houndfe.com` in Sucursal Centro. Tokens are omitted; ids are real.

## 1. What a pending refund is

A pending refund (`SaleRefund`) is money the sucursal owes a customer. It is created **only** by cancelling a confirmed sale that had money paid (`POST /sales/:id/cancel`):

- The cancellation creates one refund per payment of the sale, in payment order, until the paid amount is covered. A sale paid with cash and a transfer produces two refunds.
- `method` on the refund is the method of the **original payment**. It does not force how the money is returned (see `method` on the settlement).
- A sale on credit (`paymentStatus: CREDIT`) or with nothing paid creates no refund.
- The refund amount (`amountCents`) never changes. Returning money appends **settlements**; each settlement raises `settledCents`.
- `outstandingCents = amountCents - settledCents`. When it reaches 0 the refund leaves the pending list.
- `status` is always `"PENDING"`. There is **no** `SETTLED` or `PARTIALLY_SETTLED` status. A refund is "partially settled" when `settledCents > 0`, and "finished" when it no longer appears in the list.

The FE never creates or deletes refunds. There is no endpoint to read a single refund or its settlement history (see section 9).

## 2. Permissions

| Action | Permission | Without it |
| --- | --- | --- |
| See the pending list | `SaleRefund:read` | `403` |
| Record a settlement | `SaleRefund:update` | `403` |

Production: no role receives these permissions automatically; an admin grants them per user. In the dev DB the showcase (`pnpm seed:showcase`) grants both to the `Manager` and `Cashier` roles of Sucursal Centro.

A user with `read` but not `update` should see the list without the «Registrar devolución» action.

`403` body (common `DomainExceptionFilter` shape):

```json
{ "statusCode": 403, "error": "INSUFFICIENT_PERMISSIONS", "message": "Insufficient permissions", "timestamp": "…" }
```

Without a token or tenant context: `401 {"message":"Unauthorized","statusCode":401}`.

## 3. `GET /sales/refunds/pending` — pending list

Query params (both optional):

| Param | Type | Default | Rule |
| --- | --- | --- | --- |
| `page` | integer | `1` | `>= 1` |
| `limit` | integer | `20` | `1..100` |

This list uses the **sales** pagination (`{ data, pagination }`, 1-based `page`), not the cursor `Page<T>` of the newer modules.

- Order: **oldest first** (`createdAt asc`, then `id asc`). The oldest debt is at the top.
- Only refunds with `outstandingCents > 0` of the current sucursal.
- An empty result is `200` with `data: []`, never `404`.
- A page past the end is `200` with `data: []` (`?page=9` → `{"data":[],"pagination":{"page":9,"limit":20,"total":4,"totalPages":1}}`).

Request:

```http
GET /sales/refunds/pending?page=1&limit=5
Authorization: Bearer <token>
```

Response `200` (before the examples below):

```json
{
  "data": [
    {
      "id": "cmw2iwsa00000r965efhf292s",
      "saleId": "291e8f35-0c17-46df-8c87-6ad6cbfdcd46",
      "method": "cash",
      "amountCents": 6555,
      "settledCents": 2000,
      "outstandingCents": 4555,
      "reason": "CUSTOMER_REQUEST",
      "status": "PENDING",
      "createdAt": "2026-10-21T20:42:00.000Z"
    },
    {
      "id": "cmw2iwsdh0001r965z1rmw0n0",
      "saleId": "9bfea032-7364-461f-a8ca-446ddaf857e6",
      "method": "transfer",
      "amountCents": 92910,
      "settledCents": 46500,
      "outstandingCents": 46410,
      "reason": "ORDER_ERROR",
      "status": "PENDING",
      "createdAt": "2026-10-25T20:42:00.000Z"
    }
  ],
  "pagination": { "page": 1, "limit": 5, "total": 5, "totalPages": 1 }
}
```

(The real response had 5 rows; 3 are cut here.)

| Field | Meaning |
| --- | --- |
| `id` | Refund id. A **cuid** (25 lowercase letters/digits), not a UUID. Use it in the settlement URL. |
| `saleId` | UUID of the cancelled sale. |
| `method` | Method of the original payment: `cash`, `card_credit`, `card_debit`, `transfer`, `credit`. |
| `amountCents` | Total owed for this payment. Never changes. |
| `settledCents` | Already returned. |
| `outstandingCents` | Still owed. Always `> 0` in this list. |
| `reason` | Cancellation reason: `CUSTOMER_REQUEST`, `ORDER_ERROR`, `OUT_OF_STOCK`, `DUPLICATE_SALE`, `OTHER`. |
| `status` | Always `"PENDING"`. Do not switch on it. |
| `createdAt` | When the sale was cancelled (UTC). |

The list has **no folio and no customer**. To show them, read the cancelled sales from `GET /sales?status=CANCELED` and match by `saleId` (the row has `folio`, `customer.name`, `totalCents`, `paymentMethods`). To open one sale, use `GET /sales/:saleId`: it returns `200` for a cancelled sale.

### Cancelled sale detail (`GET /sales/:id`)

The detail returns `CONFIRMED` and `CANCELED` sales of the tenant. A `DRAFT` sale or a sale of another tenant is `404 "Sale not found"`. Every detail response now has four more fields; on a confirmed sale they are `null` and `refunds: []`:

| Field | Type | Meaning |
| --- | --- | --- |
| `canceledAt` | ISO string \| null | When the sale was cancelled (UTC). |
| `cancelReason` | `CUSTOMER_REQUEST` \| `ORDER_ERROR` \| `OUT_OF_STOCK` \| `DUPLICATE_SALE` \| `OTHER` \| null | Reason sent to `POST /sales/:id/cancel`. |
| `canceledBy` | `{ id, name }` \| null | User who cancelled. `null` if that user no longer exists. |
| `refunds` | array | Refund obligations of the sale, oldest first: `{ id, method, amountCents, settledCents, outstandingCents, reason, status: 'PENDING', createdAt }`. Same values as the pending list, plus refunds already fully returned (`outstandingCents: 0`). |

`status` is `"CANCELED"`. A cancelled sale is read-only:

| Endpoint | Cancelled sale |
| --- | --- |
| `PUT /sales/:id/seller`, `DELETE /sales/:id/seller` | `422`, `error: "SALE_CANCELED"`; nothing is changed |
| `PATCH /sales/:id/due-date` | `422`, `error: "SALE_CANCELED"`; nothing is changed |
| `POST /sales/:id/payments` | `422 SALE_NOT_CONFIRMABLE_FOR_PAYMENT` (unchanged) |
| `POST /sales/:id/cancel` | `200` replay of the first cancellation (unchanged) |
| `GET /sales/:id/pdf` (ticket) | `400 SALE_NOT_CONFIRMED` |
| `PATCH /sales/:id/payments/:paymentId/reference` | `404` (unchanged) |

Hide the edit actions (seller, due date, payments, ticket) when `status === 'CANCELED'`. Comments stay allowed.

Errors (validation, `400`):

```json
{"message":[{"property":"limit","children":[],"constraints":{"max":"limit must not be greater than 100"}}],"error":"Bad Request","statusCode":400}
{"message":[{"property":"page","children":[],"constraints":{"min":"page must not be less than 1"}}],"error":"Bad Request","statusCode":400}
```

## 4. `POST /sales/refunds/:refundId/settlements` — record a return

Records one real return of money (partial or total) against one refund. Success is **`200`** (not 201).

### Headers

| Header | Rule |
| --- | --- |
| `Authorization: Bearer <token>` | Required. |
| `Idempotency-Key` | **Required.** Trimmed by the backend; missing or blank → `400 IDEMPOTENCY_KEY_REQUIRED`. Generate one key (for example a UUID) when the user opens the confirm step, and reuse it only to retry that same submission. |

The key is scoped to **this refund and this user**: the same key on another refund is a different, unrelated request. There is no maximum length on this endpoint, but keep it short (a UUID).

### Body (closed: unknown fields are rejected)

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `amountCents` | integer | yes | `1..2147483647`. Must be `<= outstandingCents` (checked at write time, see 422 below). |
| `method` | string | yes | How the money is returned **now**: `cash`, `card_credit`, `card_debit`, `transfer`, `credit`. Can differ from the refund's `method`. |
| `reference` | string | no | Free text (folio of the transfer, voucher…). Omit it if empty; `null` is rejected (`400`). Returned as `null` when omitted. |
| `settledAt` | string | yes | ISO-8601 instant **with a zone**: `Z` or `±HH:MM`. It is the real moment the money was returned (may be in the past). The response normalizes it to UTC. `"2026-11-05T11:05:00"` (no zone) is rejected. |
| `cashSessionId` | UUID | no | Binds the return to the user's **open** POS cash session so it shows as a cash outflow in that session. Optional for every method, including `cash`. With `method: "credit"` it is rejected (`422 CASH_SESSION_CREDIT_NOT_ALLOWED`). Send it from the POS when a session is open; omit it elsewhere. |

### Partial settlement

Refund `cmw2iwsa00000r965efhf292s` owed 6555 with 2000 already settled (`outstandingCents: 4555`).

```http
POST /sales/refunds/cmw2iwsa00000r965efhf292s/settlements
Authorization: Bearer <token>
Idempotency-Key: doc-example-partial-1
Content-Type: application/json

{
  "amountCents": 2000,
  "method": "cash",
  "reference": "DOC-EXAMPLE",
  "settledAt": "2026-11-05T10:30:00-06:00"
}
```

Response `200`:

```json
{
  "settlementId": "1cd165f0-6aa9-4001-8441-b8648ca54b07",
  "refundId": "cmw2iwsa00000r965efhf292s",
  "saleId": "291e8f35-0c17-46df-8c87-6ad6cbfdcd46",
  "amountCents": 2000,
  "method": "cash",
  "reference": "DOC-EXAMPLE",
  "settledAt": "2026-11-05T16:30:00.000Z",
  "settledCents": 4000,
  "outstandingCents": 2555
}
```

| Field | Meaning |
| --- | --- |
| `settlementId` | UUID of this return. |
| `amountCents`, `method`, `reference` | What this return recorded. |
| `settledAt` | The instant sent, in UTC (`-06:00` → `Z`). |
| `settledCents` | **Cumulative** returned for the refund, this return included. |
| `outstandingCents` | Still owed **after** this return. |

The refund stays in the list with the new balance:

```json
{"data":[{"id":"cmw2iwsa00000r965efhf292s","saleId":"291e8f35-0c17-46df-8c87-6ad6cbfdcd46","method":"cash","amountCents":6555,"settledCents":4000,"outstandingCents":2555,"reason":"CUSTOMER_REQUEST","status":"PENDING","createdAt":"2026-10-21T20:42:00.000Z"}],"pagination":{"page":1,"limit":1,"total":5,"totalPages":5}}
```

### Final settlement (outstanding reaches 0)

Returning exactly the outstanding amount, by transfer this time:

```http
POST /sales/refunds/cmw2iwsa00000r965efhf292s/settlements
Idempotency-Key: doc-example-final-1

{
  "amountCents": 2555,
  "method": "transfer",
  "reference": "DOC-EXAMPLE SPEI 0012345678",
  "settledAt": "2026-11-05T11:00:00-06:00"
}
```

Response `200`:

```json
{
  "settlementId": "b642c79a-1522-4db6-84cf-e66392c9d038",
  "refundId": "cmw2iwsa00000r965efhf292s",
  "saleId": "291e8f35-0c17-46df-8c87-6ad6cbfdcd46",
  "amountCents": 2555,
  "method": "transfer",
  "reference": "DOC-EXAMPLE SPEI 0012345678",
  "settledAt": "2026-11-05T17:00:00.000Z",
  "settledCents": 6555,
  "outstandingCents": 0
}
```

After this the refund is gone from `GET /sales/refunds/pending` (`total` went from 5 to 4). Its `status` is still `PENDING` in the DB; "finished" means `outstandingCents: 0` in this response, or absent from the list.

### Balance rules

- Settlements are append-only: one refund can take any number of returns, each with its own method, reference, date and user. They cannot be edited or undone.
- `amountCents > outstandingCents` → `422 SETTLEMENT_EXCEEDS_REFUND`. Nothing is written; the balance is unchanged. There is no automatic capping: send at most `outstandingCents`.
- Any new return on a refund with `outstandingCents: 0` → `409 REFUND_ALREADY_SETTLED`.
- The balance is checked under a row lock, so two users settling the same refund at the same time can never return more than `amountCents` in total. The loser gets `422 SETTLEMENT_EXCEEDS_REFUND` or `409 REFUND_ALREADY_SETTLED`.

## 5. Idempotency-Key: replay, conflict and concurrency

The backend stores the response of the first successful request per (refund, key). The stored request is compared by `refundId`, user, `amountCents`, `method`, `reference`, the `settledAt` **instant**, and `cashSessionId` (only when sent).

| Case | Result |
| --- | --- |
| Same key, same body, after success | `200` with **the stored response**. No new settlement. |
| Same key, same body with `settledAt` written in another zone but the same instant | `200` replay (the instant is compared, not the text). |
| Same key, any different field | `409 IDEMPOTENCY_KEY_CONFLICT`. Nothing is written. |
| Same key sent again while the first request is still running (double click) | `409 IDEMPOTENCY_KEY_IN_FLIGHT` for the second. |
| Same key from another user | `409 IDEMPOTENCY_KEY_CONFLICT`. |
| A request failed (4xx/5xx other than the idempotency 409s) | The key is released; retrying with the same key and body runs again. |
| Different key, same body | A **new** settlement (if the balance allows). Never send a new key for a retry. |

Replay of the partial example (same key and body, sent twice more, once as `"settledAt":"2026-11-05T16:30:00.000Z"`):

```json
{"method":"cash","saleId":"291e8f35-0c17-46df-8c87-6ad6cbfdcd46","refundId":"cmw2iwsa00000r965efhf292s","reference":"DOC-EXAMPLE","settledAt":"2026-11-05T16:30:00.000Z","amountCents":2000,"settledCents":4000,"settlementId":"1cd165f0-6aa9-4001-8441-b8648ca54b07","outstandingCents":2555}
```

Same values and same `settlementId`; **the JSON key order differs** from the first response (the stored copy comes back from the DB). Compare by field, never by raw text.

**Replayed balances are a snapshot.** The replay above was sent again after the final settlement and still returned `settledCents: 4000, outstandingCents: 2555`. After any settlement (new or replayed), refresh the list to show the current balance.

Same key, different amount (`2100` instead of `2000`):

```json
{"statusCode":409,"error":"IDEMPOTENCY_KEY_CONFLICT","message":"IDEMPOTENCY_KEY_CONFLICT","timestamp":"2026-11-05T16:26:25.967Z"}
```

Concurrent: the final settlement sent twice at the same time with the same key. One got `200` (the final response in section 4), the other:

```json
{"statusCode":409,"error":"IDEMPOTENCY_KEY_IN_FLIGHT","message":"IDEMPOTENCY_KEY_IN_FLIGHT","timestamp":"2026-11-05T16:26:34.103Z"}
```

FE handling: disable the confirm button while a request is in flight. On `IDEMPOTENCY_KEY_IN_FLIGHT`, wait a moment and retry with the **same key and body**; that returns the stored `200` once the first finishes. On `IDEMPOTENCY_KEY_CONFLICT`, the user changed the form after a submission: generate a new key and resubmit.

## 6. Every error of the settlement endpoint

Switch on `error` for the domain errors. Validation `400`s have `error: "Bad Request"` and the details in `message`.

| Status | `error` | `message` (exact) | When / FE action |
| --- | --- | --- | --- |
| 400 | `Bad Request` | `Validation failed (cuid is expected)` | `:refundId` is not a cuid (a UUID such as a `saleId` also fails). FE bug. |
| 400 | `Bad Request` | `IDEMPOTENCY_KEY_REQUIRED` | Header missing or blank. FE bug. |
| 400 | `Bad Request` | array of validation errors (below) | Body invalid. Validate in the form first. |
| 401 | — | `Unauthorized` | No/expired token. |
| 403 | `INSUFFICIENT_PERMISSIONS` | `Insufficient permissions` | Missing `SaleRefund:update`. |
| 404 | `REFUND_NOT_FOUND` | `REFUND_NOT_FOUND` | Valid cuid but no such refund in this sucursal (also another sucursal's refund). Refresh the list. |
| 409 | `REFUND_ALREADY_SETTLED` | `REFUND_ALREADY_SETTLED` | Outstanding is already 0. Refresh the list; the row disappears. |
| 409 | `IDEMPOTENCY_KEY_CONFLICT` | `IDEMPOTENCY_KEY_CONFLICT` | Key reused with another body or by another user. New key. |
| 409 | `IDEMPOTENCY_KEY_IN_FLIGHT` | `IDEMPOTENCY_KEY_IN_FLIGHT` | Same key still running. Retry the same request. |
| 422 | `SETTLEMENT_EXCEEDS_REFUND` | `SETTLEMENT_EXCEEDS_REFUND` | Amount above the current outstanding. Refresh the balance. |
| 422 | `CASH_SESSION_CREDIT_NOT_ALLOWED` | `CASH_SESSION_CREDIT_NOT_ALLOWED` | `method: "credit"` with a `cashSessionId`. Omit the session for credit. |
| 422 | `CASH_SESSION_NOT_FOUND` | `Cash session not found` | Session id does not exist in this sucursal. Body also has `sessionId`. |
| 422 | `CASH_SESSION_NOT_OWNED` | `Only the session owner may bind POS money to this session` | Session belongs to another cashier. Body also has `sessionId`. |
| 422 | `CASH_SESSION_NOT_WRITABLE` | `Cash session no longer accepts operational movements` | Session closed or frozen. Body also has `sessionId`, `status`, `frozenAt`. |
| 422 | `CASH_ACTOR_INACTIVE` | `Cash actor is not an active user` | Only with `cashSessionId`; user deactivated. |
| 422 | `CASH_TENANT_MEMBERSHIP_REQUIRED` | `Cash actor is not a member of the active tenant` | Only with `cashSessionId`. |

The 409/422/404 domain bodies have the shape `{ statusCode, error, message, timestamp }`, plus the extra fields noted. The `CASH_SESSION_NOT_FOUND`, `CASH_SESSION_CREDIT_NOT_ALLOWED`, `REFUND_NOT_FOUND`, `SETTLEMENT_EXCEEDS_REFUND`, `REFUND_ALREADY_SETTLED` and both idempotency errors were captured live; the other cash-session errors are from code (the dev manager owns no session).

Captured bodies:

```json
{"message":"Validation failed (cuid is expected)","error":"Bad Request","statusCode":400}
{"message":"IDEMPOTENCY_KEY_REQUIRED","error":"Bad Request","statusCode":400}
{"statusCode":404,"error":"REFUND_NOT_FOUND","message":"REFUND_NOT_FOUND","timestamp":"2026-11-05T16:26:46.362Z"}
{"statusCode":409,"error":"REFUND_ALREADY_SETTLED","message":"REFUND_ALREADY_SETTLED","timestamp":"2026-11-05T16:26:34.190Z"}
{"statusCode":422,"error":"SETTLEMENT_EXCEEDS_REFUND","message":"SETTLEMENT_EXCEEDS_REFUND","timestamp":"2026-11-05T16:26:26.046Z"}
{"statusCode":422,"error":"CASH_SESSION_CREDIT_NOT_ALLOWED","message":"CASH_SESSION_CREDIT_NOT_ALLOWED","timestamp":"2026-11-05T16:26:47.273Z"}
{"statusCode":422,"error":"CASH_SESSION_NOT_FOUND","message":"Cash session not found","timestamp":"2026-11-05T16:26:47.350Z","sessionId":"7f1c2a90-3b4d-4e5f-8a6b-1c2d3e4f5a6b"}
```

(`SETTLEMENT_EXCEEDS_REFUND` came from `amountCents: 9999` with 2555 outstanding; `REFUND_ALREADY_SETTLED` from `amountCents: 100` after the final settlement; `REFUND_NOT_FOUND` from `cmw2zzzzz0000zzzzzzzzzzzz`.)

Validation `400` bodies, exact:

| Input | `message` |
| --- | --- |
| `amountCents: 0` | `[{"property":"amountCents","children":[],"constraints":{"min":"amountCents must not be less than 1"}}]` |
| `amountCents: 10.5` | `[{"property":"amountCents","children":[],"constraints":{"isInt":"amountCents must be an integer number"}}]` |
| `method: "check"` | `[{"property":"method","children":[],"constraints":{"isIn":"method must be one of the following values: cash, card_credit, card_debit, transfer, credit"}}]` |
| `settledAt: "2026-11-05T11:05:00"` | `[{"property":"settledAt","children":[],"constraints":{"matches":"settledAt must match /(?:Z\|[+-]\\d{2}:\\d{2})$/ regular expression"}}]` |
| `settledAt` missing | `[{"property":"settledAt","children":[],"constraints":{"matches":"settledAt must match /(?:Z\|[+-]\\d{2}:\\d{2})$/ regular expression","isIso8601":"settledAt must be a valid ISO 8601 date string"}}]` |
| `reference: null` | `[{"property":"reference","children":[],"constraints":{"isString":"reference must be a string"}}]` |
| extra field `note` | `[{"property":"note","constraints":{"whitelistValidation":"property note should not exist"}}]` |
| `cashSessionId: "abc"` | `[{"property":"cashSessionId","children":[],"constraints":{"isUuid":"INVALID_CASH_SESSION_ID"}}]` |

(In the table, `\|` is the Markdown escape for the `|` inside the regex.) Each body is `{"message":[…],"error":"Bad Request","statusCode":400}`. Use `message[].property` to place the error on the field.

## 7. Suggested screen flow

1. **List** («Devoluciones pendientes»). `GET /sales/refunds/pending`, oldest first. Join with `GET /sales?status=CANCELED` for folio and customer. Columns: folio, cliente, fecha de cancelación, motivo, método original, total, devuelto, pendiente. Show a «Parcial» badge when `settledCents > 0`.
2. **Detail / settle panel** (drawer or modal from a row). Show total, devuelto, **pendiente**. Form: monto (default = pendiente; buttons «Devolver todo» and free amount), método (default = the refund's `method`, editable), referencia (optional; suggest it for transfer/card), fecha y hora de la devolución (default now, sent with the local offset, e.g. `-06:00`). From the POS with an open session, send `cashSessionId` and hide `credit`.
3. **Confirm.** Generate the `Idempotency-Key` when the confirm step opens; keep it until the form changes or the request succeeds.
4. **Result.**
   - `outstandingCents > 0` → «Se registró una devolución parcial. Quedan $25.55 por devolver.» Keep the panel open with the new balance.
   - `outstandingCents === 0` → «Devolución completada.» Close the panel; the row disappears after the refresh.
   - Always refresh the list afterwards.

Validate in the form before sending: integer cents `>= 1` and `<= outstandingCents`, a method, a date. Format cents as MXN (`6555` → `$65.55`).

### Copy hints (es-MX)

| Situation | Copy |
| --- | --- |
| Screen title | «Devoluciones pendientes» |
| Empty list | «No hay devoluciones pendientes.» |
| Action | «Registrar devolución» |
| Columns | «Total a devolver», «Devuelto», «Pendiente» |
| Full amount button | «Devolver todo» |
| Date field | «Fecha y hora en que se devolvió el dinero» |
| Reference field | «Referencia (opcional)» · help: «Ej. folio de transferencia o de la terminal» |
| Methods | `cash` «Efectivo», `card_credit` «Tarjeta de crédito», `card_debit` «Tarjeta de débito», `transfer` «Transferencia», `credit` «Saldo a favor / crédito» |
| Reasons | `CUSTOMER_REQUEST` «Solicitud del cliente», `ORDER_ERROR` «Error en el pedido», `OUT_OF_STOCK` «Sin existencias», `DUPLICATE_SALE` «Venta duplicada», `OTHER` «Otro» |
| Partial success | «Devolución parcial registrada. Quedan {pendiente} por devolver.» |
| Final success | «Devolución completada.» |
| `SETTLEMENT_EXCEEDS_REFUND` | «El monto es mayor que lo pendiente. Actualizamos el saldo; revisa el monto.» |
| `REFUND_ALREADY_SETTLED` | «Esta devolución ya se completó.» |
| `REFUND_NOT_FOUND` | «No encontramos esta devolución. Actualiza la lista.» |
| `IDEMPOTENCY_KEY_IN_FLIGHT` | «Estamos registrando la devolución, espera un momento.» |
| `IDEMPOTENCY_KEY_CONFLICT` | «Los datos cambiaron desde el último intento. Vuelve a confirmar.» |
| `CASH_SESSION_NOT_WRITABLE` | «La caja ya está cerrada. Registra la devolución sin caja o abre una nueva.» |
| `CASH_SESSION_NOT_OWNED` | «Esta caja pertenece a otro cajero.» |
| `CASH_SESSION_CREDIT_NOT_ALLOWED` | «Una devolución a crédito no se registra en caja.» |
| `403` | «No tienes permiso para registrar devoluciones.» |

The `credit` meaning as a return method is not product-confirmed; check the label with product before shipping.

## 8. Test data (dev DB)

Pending refunds in Sucursal Centro after the captures (2026-11-05), oldest first:

| Refund id | Sale folio | Original method | Total | Settled | Outstanding |
| --- | --- | --- | --- | --- | --- |
| `cmw2iwsdh0001r965z1rmw0n0` | A-202611-000023 | transfer | 92910 | 46500 | 46410 |
| `cmw2j0iy00003r9659scsjac7` | A-202611-000067 | card_credit | 74955 | 10000 | 64955 |
| `cmw2iu8ls0000r9mijx25om85` | A-202611-000006 | cash | 1661170 | 0 | 1661170 |
| `cmw2izrjw0002r965eh02ytw3` | A-202611-000050 | cash | 16055 | 8000 | 8055 |

`cmw2iwsa00000r965efhf292s` (folio A-202611-000022) was fully settled by these examples (settlements with reference `DOC-EXAMPLE`) and is no longer pending. To get new pending refunds, cancel a paid confirmed sale.

## 9. Known gaps (backend)

- No endpoint returns one refund or its settlement history (who returned what, when). The FE only has `settledCents` from the list and the response of each settlement it records.
- No endpoint lists already completed refunds.
