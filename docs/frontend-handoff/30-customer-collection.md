# 30 — «Cobrar todo» (customer collection): one payment for several sales of a customer, «Comprobante de cobro», counter charge change rule

**Status:** implemented and merged into local `main` (b6e4f5eb T1 counter charge rule, 2c6113cc T2 collection, 21521920 T3 read + receipt, 0c3c4382 T2b lock bound + input bounds); push pending. Task: `odd/tasks/customer-collection.md`. Contract: `docs/proposals/customer-collection-contract.md` v1 (approved 2026-11-26), see its «Implementation notes (final routes)» for what changed from v1. Migration: `20261126000000_customer_collections` (new `sale_collections` table, `sale_payments.collectionId`).

Owner decisions (2026-11-26): Q1 «Vencimiento más viejo primero», Q2 «En orden; la última queda parcial», Q3 «Sí, solo hasta el efectivo entregado», Q4 «Cualquiera con permiso, toda venta», Q5 «Un "Comprobante de cobro" general», Q6 «Uno por cobro», Q7 «Sí, obligatorio»; counter charge «Rechazar si el cambio supera el efectivo».

Shapes come from the code: `src/sales/customer-collections.controller.ts`, `src/sales/customer-collection.service.ts`, `src/sales/dto/customer-collection.dto.ts`, `src/sales/domain/collection-allocation.ts`, `src/sales/collections.controller.ts`, `src/sales/collection-receipt-pdf.controller.ts`, `src/sales/collection-read.service.ts`, `src/shared/filters/domain-exception.filter.ts`. All amounts are integer cents.

## What it is

The cashier collects a customer's debt in **one** payment. The backend spreads the money over the customer's open-debt sales, oldest due date first. The last sale it reaches may stay partially paid. Each sale gets ordinary payment rows for the amount it received, so sale receipts, cancellations and refunds keep working sale by sale. One «Comprobante de cobro» covers the whole collection.

The single-sale route `POST /sales/:id/payments` does not change.

## 1. Routes

| Method | Path | Permission | Purpose |
|---|---|---|---|
| POST | `/customers/:customerId/collections/preview` | `update:Sale` | Computes the allocation. No writes, no locks, no idempotency key. `200` |
| POST | `/customers/:customerId/collections` | `update:Sale` | Applies the collection. `idempotency-key` header **required**. `201` for a new collection, `200` for an idempotent replay |
| GET | `/collections/:collectionId` | `read:Sale` | Reads one collection as it was recorded. `200` |
| GET | `/collections/:collectionId/pdf?format=ticket\|a4` | `read:Sale` | «Comprobante de cobro» PDF. `200` |

- Every id in the path must be a UUID. Anything else gets a Nest `400` (`ParseUUIDPipe`).
- Q4: anyone with `update:Sale` can collect **any** sale of the customer. The «only your own POS sales» rule of `POST /sales/:id/payments` does not apply here.
- PDF headers: `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="comprobante-cobro-<collectionId>.pdf"`, `Cache-Control: no-store`. Download it as a blob. The PDF is fully rendered before any header goes out, so an error never arrives as half a PDF.

## 2. Request body (preview and apply)

Both routes take the same body. Unknown fields are rejected with `400` (`forbidNonWhitelisted`).

```json
{
  "payments": [
    { "method": "card_debit", "amountCents": 60000, "paymentMethodId": "uuid?", "reference": "…?" },
    { "method": "cash", "amountCents": 30000 }
  ],
  "cashSessionId": "uuid",
  "saleIds": ["uuid"],
  "expectedDebtCents": 140000
}
```

| Field | Preview | Apply | Rule |
|---|---|---|---|
| `payments` | optional, **0–5** tenders | required, **1–5** tenders | Each tender: `method` ∈ `cash`, `card_credit`, `card_debit`, `transfer` (no `credit`). `amountCents` is an integer from 1 to 2,147,483,647. The **sum** of all tenders is also at most 2,147,483,647 (`PAYMENTS_TOTAL_TOO_LARGE`) |
| `payments[].paymentMethodId` | optional | optional | UUID of a catalog payment method whose category matches `method`. Its name and subtitle are stored as a snapshot (`catalog`), the same as on the single-sale route |
| `payments[].reference` | optional | optional | string, at most **120** characters. It is copied onto every payment row the tender produces |
| `cashSessionId` | accepted, ignored | **required** | UUID of an OPEN session owned by the caller. If you omit it on apply you get `422 CASH_SESSION_REQUIRED`. `null` or a malformed id is a validation `400` (`INVALID_CASH_SESSION_ID`) |
| `saleIds` | optional | optional | an explicit selection: 1–**50** unique UUIDs. Omit it to mean «every CONFIRMED sale of the customer with open debt». An empty array is a `400`. The POS v1 always omits it (F3) |
| `expectedDebtCents` | accepted, ignored | optional (send it) | integer ≥ 0: the `debtCents` the preview returned. If it differs from the debt the backend finds, you get `409 COLLECTION_DEBT_CHANGED` |

## 3. Allocation

1. **Candidates:** CONFIRMED sales of this customer, in the current branch, with open debt > 0. That means all of them, or the `saleIds` you sent. A selected sale that does not exist, belongs to another branch or customer, is not CONFIRMED or has no debt fails with `422 COLLECTION_SALE_NOT_ELIGIBLE` and its `saleId`. Selected ids are checked in request order, so the first bad one is reported.
2. **Order (Q1):**
   - Due **day** ascending. The due day is the UTC calendar date of `dueDate`, the date the POS shows (handoff 28 §3).
   - Sales without a due date come last.
   - Ties are broken by `confirmedAt`, then by `id`.
   - Overdue sales therefore come first.
3. **Fill (Q2):** each sale receives `min(remaining amount, its debt)`. The last sale reached may stay **partial**. The sales after it receive 0.
4. **Tenders to sales:** tenders are used in request order, **except cash, which is always used last**. That way any change comes out of cash. Each (sale, tender part) becomes its own payment row with the **applied** amount, never the tendered amount.
5. **Change (Q3):** an excess over the debt of the candidates is change only when there is cash and the change is **≤ the cash tendered**. Otherwise you get `422 COLLECTION_EXCEEDS_DEBT`. There is no customer credit balance.

**Example** (contract §3 plus a fourth sale D):

| Sale | Due | Debt |
|---|---|---|
| A | 2026-11-01 | 30000 |
| B | 2026-11-10 | 50000 |
| C | none (confirmed 2026-10-20) | 40000 |
| D | none (confirmed 2026-11-15) | 20000 |

Total debt is 140000. The tenders are `card_debit 60000` + `cash 30000` = 90000.

- A ← card 30000. Paid.
- B ← card 30000 + cash 20000. Paid.
- C ← cash 10000. Partial: 30000 still owed.
- D ← 0.
- No change. The customer still owes 50000.

**Change examples** (a single sale with debt 30000):

| Tenders | Result |
|---|---|
| card 20000 + cash 15000 | applied 30000 (card 20000 + cash 10000), `changeDueCents: 5000` |
| card 30000 + cash 5000 | applied 30000 (card only), change 5000: all of the cash goes back |
| card 40000 + cash 1000 | `422 COLLECTION_EXCEEDS_DEBT`: the 11000 excess is more than the 1000 cash |
| card 35000 | `422 COLLECTION_EXCEEDS_DEBT`: excess without any cash |

## 4. Preview — `POST /customers/:customerId/collections/preview`

- Send it with **0 tenders** (`payments` omitted or `[]`) to get the debt and the order. Every sale then has `appliedCents: 0`.
- `debtCents` is the open debt of the candidates **before** the collection: of the whole customer, or of the selection. **Send it back as `expectedDebtCents`** on apply.
- `sales` lists **every candidate in allocation order, including those that receive nothing** (`appliedCents: 0`).
- Per sale:
  - `paidCents`, `debtCents` and `paymentStatus` describe the sale **after** the simulated collection. A sale that receives 0 keeps its current status.
  - `overdue` uses the handoff 28 rule and describes the sale **before** the collection, so the screen can say «vencida».
- `remainingCustomerDebtCents` is the whole customer's debt after the collection, including sales outside a selection.
- Validation errors and the 404/422 errors of §8 apply here too. For example, too much card returns `422 COLLECTION_EXCEEDS_DEBT` from the preview, so the POS can show it before confirming.

Response for the example (`200`):

```json
{
  "customer": { "id": "8a4c…", "name": "Ana López" },
  "debtCents": 140000,
  "tenderedCents": 90000,
  "appliedCents": 90000,
  "changeDueCents": 0,
  "payments": [
    { "method": "card_debit", "amountCents": 60000, "catalog": null },
    { "method": "cash", "amountCents": 30000, "catalog": null }
  ],
  "sales": [
    { "saleId": "…A", "folio": "V-000120", "confirmedAt": "2026-10-02T17:04:11.000Z", "dueDate": "2026-11-01T00:00:00.000Z", "overdue": true,  "appliedCents": 30000, "paidCents": 30000, "debtCents": 0,     "paymentStatus": "PAID" },
    { "saleId": "…B", "folio": "V-000123", "confirmedAt": "2026-10-11T18:30:00.000Z", "dueDate": "2026-11-10T00:00:00.000Z", "overdue": true,  "appliedCents": 50000, "paidCents": 50000, "debtCents": 0,     "paymentStatus": "PAID" },
    { "saleId": "…C", "folio": "V-000130", "confirmedAt": "2026-10-20T16:12:45.000Z", "dueDate": null,                       "overdue": false, "appliedCents": 10000, "paidCents": 10000, "debtCents": 30000, "paymentStatus": "PARTIAL" },
    { "saleId": "…D", "folio": "V-000141", "confirmedAt": "2026-11-15T19:40:02.000Z", "dueDate": null,                       "overdue": false, "appliedCents": 0,     "paidCents": 0,     "debtCents": 20000, "paymentStatus": "CREDIT" }
  ],
  "remainingCustomerDebtCents": 50000
}
```

- `confirmedAt` and `dueDate` are the same strings as in the `GET /sales` row. Format the due day from the first 10 characters, never through a timezone conversion.
- `catalog` is `{ "paymentMethodId", "name", "subtitle"? }` when the tender had a `paymentMethodId`, otherwise `null`.
- In `payments`, `amountCents` is the **tendered** amount. Cash includes the change.

## 5. Apply — `POST /customers/:customerId/collections`

Headers: `idempotency-key: <one key per user submission>`. The body is the same as the preview, plus `cashSessionId` and `expectedDebtCents`.

Everything runs in one transaction, so it is all or nothing:

1. Idempotency slot.
2. Cash session check.
3. Lock the sales.
4. Recompute the allocation under the lock.
5. Write the collection, the per-sale payment rows, the cash movements and the events.

If anything fails, nothing is written. That includes the idempotency slot, so after a 4xx the key is free again.

Response `201` for the example:

```json
{
  "collectionId": "5f0e9b2a-…",
  "customer": { "id": "8a4c…", "name": "Ana López" },
  "createdAt": "2026-11-25T18:02:33.120Z",
  "tenderedCents": 90000,
  "appliedCents": 90000,
  "changeDueCents": 0,
  "payments": [
    { "method": "card_debit", "amountCents": 60000, "catalog": null },
    { "method": "cash", "amountCents": 30000, "catalog": null }
  ],
  "sales": [
    { "saleId": "…A", "folio": "V-000120", "confirmedAt": "2026-10-02T17:04:11.000Z", "dueDate": "2026-11-01T00:00:00.000Z", "overdue": true,  "appliedCents": 30000, "paidCents": 30000, "debtCents": 0,     "paymentStatus": "PAID",    "paymentIds": ["p1"] },
    { "saleId": "…B", "folio": "V-000123", "confirmedAt": "2026-10-11T18:30:00.000Z", "dueDate": "2026-11-10T00:00:00.000Z", "overdue": true,  "appliedCents": 50000, "paidCents": 50000, "debtCents": 0,     "paymentStatus": "PAID",    "paymentIds": ["p2", "p3"] },
    { "saleId": "…C", "folio": "V-000130", "confirmedAt": "2026-10-20T16:12:45.000Z", "dueDate": null,                       "overdue": false, "appliedCents": 10000, "paidCents": 10000, "debtCents": 30000, "paymentStatus": "PARTIAL", "paymentIds": ["p4"] }
  ],
  "remainingCustomerDebtCents": 50000
}
```

- `sales` lists **only the sales that received money**, in allocation order. `paymentIds` are the payment rows created for that sale (B has one card row and one cash row). There is no top-level `debtCents`.
- **Idempotency:**

  | Request | Answer |
  |---|---|
  | Same key and same body after a success | `200` with the stored response, even if the session was closed meanwhile |
  | Same key with another body, or sent by another user | `409 IDEMPOTENCY_KEY_CONFLICT` |
  | Same key while the first request is still running | `409 IDEMPOTENCY_KEY_IN_FLIGHT` |
  | No key, or a blank key | `400 IDEMPOTENCY_KEY_REQUIRED` |

  The request hash ignores the order of `payments` and of `saleIds`.

### 5.1 Locks and `409 COLLECTION_DEBT_CHANGED`

- **Without `saleIds`:**
  - The backend reads the customer's open-debt sales and locks **only the sales the tender reaches**. That is the shortest prefix, in the Q1 order, whose debt covers the tender, or every sale when the tender covers the whole debt.
  - It then recomputes the allocation over the locked sales plus the unlocked rest.
  - It answers `409 COLLECTION_DEBT_CHANGED` when either of these is true:
    - the set of sales that would receive money differs from the locked set (a reached sale was paid, cancelled or changed by someone else in the meantime). This happens **even if you did not send `expectedDebtCents`**;
    - `expectedDebtCents` was sent and differs from the recomputed `debtCents`.
- **With `saleIds`:**
  - Every selected sale is locked.
  - A selected sale that is no longer eligible gets `422 COLLECTION_SALE_NOT_ELIGIBLE`.
  - The 409 comes only from `expectedDebtCents`.

The 409 body carries the **current preview** (the §4 shape) under `preview`:

```json
{
  "statusCode": 409,
  "error": "COLLECTION_DEBT_CHANGED",
  "message": "COLLECTION_DEBT_CHANGED",
  "timestamp": "2026-11-25T18:02:33.180Z",
  "preview": { "customer": { "id": "…", "name": "Ana López" }, "debtCents": 110000, "tenderedCents": 90000, "appliedCents": 90000, "changeDueCents": 0, "payments": [ … ], "sales": [ … ], "remainingCustomerDebtCents": 20000 }
}
```

### 5.2 Which error wins

The apply route checks in this order and answers the first failure:

1. `403` permission, then the `400`s: path UUID, body validation, `IDEMPOTENCY_KEY_REQUIRED`.
2. `422 CASH_SESSION_REQUIRED`.
3. Idempotency: replay `200` / `409 IDEMPOTENCY_KEY_CONFLICT` / `409 IDEMPOTENCY_KEY_IN_FLIGHT`.
4. Cash session: `422 CASH_SESSION_NOT_FOUND`, `CASH_ACTOR_INACTIVE`, `CASH_TENANT_MEMBERSHIP_REQUIRED`, `CASH_SESSION_NOT_OWNED`, `CASH_SESSION_NOT_WRITABLE`.
5. `404 CUSTOMER_NOT_FOUND`.
6. `422 COLLECTION_SALE_NOT_ELIGIBLE` (with `saleIds`).
7. Allocation under the lock: `422 COLLECTION_NO_OPEN_DEBT`, `422 COLLECTION_EXCEEDS_DEBT`.
8. Catalog payment method: `404 PAYMENT_METHOD_NOT_FOUND`, `409 INACTIVE_PAYMENT_METHOD`, `400 PAYMENT_METHOD_CATEGORY_MISMATCH`.
9. `409 COLLECTION_DEBT_CHANGED`.

So the 422s of steps 6–7 and the catalog errors **win over** `COLLECTION_DEBT_CHANGED`. Example: a concurrent payment lowers the debt so that your card now exceeds it. You get `422 COLLECTION_EXCEEDS_DEBT`, not the 409. For those errors, call the preview again to show the new numbers.

## 6. Read — `GET /collections/:collectionId`

This returns the POST shape with these differences:

| Field | Meaning |
|---|---|
| `sales[].saleStatus` | `CONFIRMED` or `CANCELED`: the sale's **current** status. A sale cancelled after the collection reads `CANCELED`; the collection stays as history |
| `sales[].paidCents` / `debtCents` / `paymentStatus` | the balance **right after the collection**: payments made before it plus this collection's own rows. Later payments and refunds are never counted, so a re-print a week later shows what the first print showed. `paymentStatus` is `PAID`, `PARTIAL` or `CREDIT` |
| `sales[].overdue` | the POST value: overdue before the collection, with the collection's local day as «today» |
| `customer` | `{ id, name }`, or **`null` once the customer was deleted** |
| `remainingCustomerDebtCents` | the customer's open debt right after the collection; **`null` once the customer was deleted** |

Sales come in allocation order, the same as the POST. `paymentIds` come in tender consumption order.

```json
{
  "collectionId": "5f0e9b2a-…",
  "customer": { "id": "8a4c…", "name": "Ana López" },
  "createdAt": "2026-11-25T18:02:33.120Z",
  "tenderedCents": 90000, "appliedCents": 90000, "changeDueCents": 0,
  "payments": [ { "method": "card_debit", "amountCents": 60000, "catalog": null }, { "method": "cash", "amountCents": 30000, "catalog": null } ],
  "sales": [
    { "saleId": "…A", "folio": "V-000120", "confirmedAt": "…", "dueDate": "2026-11-01T00:00:00.000Z", "overdue": true,  "appliedCents": 30000, "paidCents": 30000, "debtCents": 0,     "paymentStatus": "PAID",    "paymentIds": ["p1"],       "saleStatus": "CONFIRMED" },
    { "saleId": "…B", "folio": "V-000123", "confirmedAt": "…", "dueDate": "2026-11-10T00:00:00.000Z", "overdue": true,  "appliedCents": 50000, "paidCents": 50000, "debtCents": 0,     "paymentStatus": "PAID",    "paymentIds": ["p2", "p3"], "saleStatus": "CONFIRMED" },
    { "saleId": "…C", "folio": "V-000130", "confirmedAt": "…", "dueDate": null,                       "overdue": false, "appliedCents": 10000, "paidCents": 10000, "debtCents": 30000, "paymentStatus": "PARTIAL", "paymentIds": ["p4"],       "saleStatus": "CANCELED" }
  ],
  "remainingCustomerDebtCents": 50000
}
```

(Here C was cancelled after the collection. Its numbers still describe the collection moment.)

A collection that does not exist, or belongs to another branch, gets `404 { "statusCode": 404, "error": "COLLECTION_NOT_FOUND", "message": "COLLECTION_NOT_FOUND" }`. This body is code-only, with no `timestamp`.

## 7. «Comprobante de cobro» — `GET /collections/:collectionId/pdf?format=ticket|a4`

- `format` absent or empty means `ticket`. `a4` is the other option. Any other value gets `400` with `message: "INVALID_FORMAT"`, checked before any read.
- Content:
  - Folio `COB-` + the first 8 hex characters of the collection id, uppercase.
  - Branch, date, cashier («—» if the user is gone), customer («Cliente eliminado» after a delete).
  - Each sale with its folio, amount applied and debt remaining after the collection. It is marked «CANCELADA» / «Cancelada» if it was cancelled since.
  - Total abonado, the tenders (catalog name and subtitle, or the method label), Recibido and Cambio.
  - The customer's remaining debt («No disponible» after a customer delete).
- Layout: the ticket is 80 mm on one continuous page. The A4 paginates, repeats the table header and prints «Página X de Y».
- The numbers are those of §6, so re-printing gives the same receipt. Sale receipts (`GET /sales/:id/pdf`) keep showing each sale's own payments.
- Errors: `404 COLLECTION_NOT_FOUND`, `500 PDF_GENERATION_FAILED` (Nest body, `message: "PDF_GENERATION_FAILED"`).

## 8. Errors

The sales module body is `{ statusCode, error: "<CODE>", message, timestamp, …details }`. Switch on `error`. The exceptions are noted in the table.

| HTTP | Code (`error`) | Routes | When |
|---|---|---|---|
| 400 | Nest validation body `{ statusCode, message: [ValidationError…], error: "Bad Request" }` | preview, apply | bad or unknown fields; `payments` empty (apply) or more than 5; bad `method`; `amountCents` < 1 or > 2,147,483,647; tenders summing over 2,147,483,647 (constraint message `PAYMENTS_TOTAL_TOO_LARGE` on `payments`); `reference` > 120; `paymentMethodId` not a UUID (`INVALID_PAYMENT_METHOD_ID`); `cashSessionId` null or not a UUID (`INVALID_CASH_SESSION_ID`); `saleIds` empty, > 50, duplicated or not UUIDs; `expectedDebtCents` < 0 or not an integer |
| 400 | `message: "IDEMPOTENCY_KEY_REQUIRED"`, `error: "Bad Request"` (**the code is in `message`**) | apply | missing or blank `idempotency-key` |
| 400 | `PAYMENT_METHOD_CATEGORY_MISMATCH` | preview, apply | the catalog method's category ≠ `method` |
| 400 | `message: "INVALID_FORMAT"` | PDF | `format` other than `ticket` or `a4` |
| 400 | Nest `ParseUUIDPipe` body | all | path id not a UUID |
| 403 | standard forbidden body | all | no `update:Sale` (preview, apply) or no `read:Sale` (read, PDF) |
| 404 | `CUSTOMER_NOT_FOUND` | preview, apply | unknown customer, or of another branch |
| 404 | `PAYMENT_METHOD_NOT_FOUND` | preview, apply | unknown catalog `paymentMethodId` |
| 404 | `COLLECTION_NOT_FOUND` (code-only body, no `timestamp`) | read, PDF | unknown collection, or of another branch |
| 409 | `COLLECTION_DEBT_CHANGED` + `preview` | apply | §5.1 |
| 409 | `IDEMPOTENCY_KEY_CONFLICT` | apply | same key, other body or other user |
| 409 | `IDEMPOTENCY_KEY_IN_FLIGHT` | apply | same key still being processed |
| 409 | `INACTIVE_PAYMENT_METHOD` | preview, apply | the catalog method is inactive |
| 422 | `CASH_SESSION_REQUIRED` | apply | `cashSessionId` omitted (Q7) |
| 422 | `CASH_SESSION_NOT_FOUND` | apply | unknown session, or of another branch |
| 422 | `CASH_SESSION_NOT_OWNED` (**422, not 403**; body has `sessionId`) | apply | the session belongs to another cashier |
| 422 | `CASH_SESSION_NOT_WRITABLE` (body has `sessionId`, `status`, `frozenAt`) | apply | the session is closed or frozen |
| 422 | `CASH_ACTOR_INACTIVE` / `CASH_TENANT_MEMBERSHIP_REQUIRED` | apply | the caller is inactive or not a member of the branch |
| 422 | `COLLECTION_NO_OPEN_DEBT` | preview, apply | the customer has nothing to collect |
| 422 | `COLLECTION_SALE_NOT_ELIGIBLE` (body has `saleId`) | preview, apply | a selected sale is unknown, foreign, of another customer, not CONFIRMED or has no debt |
| 422 | `COLLECTION_EXCEEDS_DEBT` | preview, apply | the excess has no cash to cover it, or is larger than the cash tendered |
| 500 | `PDF_GENERATION_FAILED` | PDF | rendering failed |

The `message` of the `CASH_*` codes is an English sentence. Never show it; map the `error` code.

## 9. Recommended POS flow

1. When the cashier opens «Cobrar todo» for a customer, call the preview **without tenders**. Show the list in order, the overdue marks and `debtCents`.
2. While the cashier types amounts, call the preview **debounced** (for example 300 ms after the last change) with the current `payments`. Show:
   - `appliedCents` per sale (the sales with 0 stay pending);
   - `changeDueCents`;
   - `remainingCustomerDebtCents`.

   Show the 422s (`COLLECTION_EXCEEDS_DEBT`, …) inline, and keep the confirm button off while the last preview failed.
3. **Confirm:** `POST /customers/:customerId/collections` with the same `payments`, the open `cashSessionId`, `expectedDebtCents` = the last preview's `debtCents`, and a **new** `idempotency-key`. A network retry reuses the same key **and** the same body.
4. **`201`** (or `200` on a replay): show the result and offer «Imprimir comprobante» (`GET /collections/:collectionId/pdf?format=ticket`, or `a4`).
5. **`409 COLLECTION_DEBT_CHANGED`:** nothing was written.
   - Replace the screen with `body.preview` and tell the cashier the debt changed («La deuda del cliente cambió»).
   - Ask them to confirm again. The new attempt sends `expectedDebtCents = body.preview.debtCents` and a new key.
6. **`409 IDEMPOTENCY_KEY_IN_FLIGHT`:** wait briefly and retry with the same key and body. **`409 IDEMPOTENCY_KEY_CONFLICT`:** a client bug; never reuse a key for another body.
7. Any other 422 on apply: nothing was written. Refresh with the preview.

## 10. Behavior notes

- **Unlocked reads, informational only.** `remainingCustomerDebtCents`, and the part of `debtCents` that belongs to sales receiving nothing, may be read **without locks**: without `saleIds` the sales that receive 0 are never locked, and with `saleIds` the customer total is summed outside the selection. A concurrent payment on one of those sales can make these numbers stale by that payment. Money never moves on those sales, so treat the numbers as informational. The sales that do receive money are always locked and checked.
- **Cash movements and change.**
  - Each payment row produces one `SALE_PAYMENT` cash movement (source = the payment).
  - The change is one `SALE_CHANGE` movement whose `sourceId` is the **collection id, not a sale id**. Never resolve a `SALE_CHANGE` `sourceId` as a sale.
  - To keep the drawer right, the `SALE_PAYMENT` movement of the **last applied cash part** carries its applied amount plus the change, so that movement's amount is larger than its payment row.
  - If no cash was applied at all (the non-cash tenders covered the debt and every cash cent is change), no cash movement and no `SALE_CHANGE` are written. The cash never entered the drawer, and the change is recorded only on the collection.
- **Cancelling a collected sale** refunds only that sale's payment rows, method by method, exactly as for any sale. The change is stored on the collection, not on a sale, so it is **never refunded**. The collection stays as history (§6 `saleStatus`).
- **Delivery and holds:** no new rule. Only CREDIT sales with nothing paid expire from a pay-in-store hold. A sale that a collection leaves PARTIAL or PAID therefore leaves the hold-expiry flow, the same as after a single payment.
- **Events:**
  - Each sale emits `sale.payment.received` (and `sale.fully.paid` when its debt reaches 0) as today, tagged with `collectionId`.
  - The collection emits one `customer.collection.recorded`.
  - **No customer notification (WhatsApp or email) exists today** for payments. Q6 «Uno por cobro» will hang from `customer.collection.recorded` when one is built.
- Sales of the customer outside the current branch are never candidates (a branch is a tenant).

## 11. Counter charge change rule (T1)

This applies to the counter charge `POST /sales/:id/charge` (the draft charge with `payments`). Owner rule «Rechazar si el cambio supera el efectivo»: the change (tendered − total) may never be larger than the cash tendered.

| Case (sale total 1000) | Result |
|---|---|
| card 1100 + cash 100 | **`422 CHANGE_EXCEEDS_CASH_TENDERED`**, nothing written (before this rule it recorded change 200) |
| cash 1200 | OK, change 200 |
| card 800 + cash 300 | OK, change 100 |
| card 1000 | OK, no change |
| card 1100 (no cash) | `422 PAYMENT_AMOUNT_INVALID`, unchanged: a non-cash overpay without cash keeps its old code |

The rule is: when there is cash among the tenders and the **non-cash tenders add up to more than the total**, the answer is `CHANGE_EXCEEDS_CASH_TENDERED`. Suggested copy: «El cambio no puede ser mayor que el efectivo entregado. Ajusta los montos.» «Cobrar todo» applies the same limit through `COLLECTION_EXCEEDS_DEBT` (§3.5).
