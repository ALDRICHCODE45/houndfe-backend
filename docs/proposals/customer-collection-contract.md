# «Cobrar todo» (one payment for several sales of a customer) — proposal v0

Status: **v1 APPROVED 2026-11-26** by the frontend; owner answers Q1–Q7 (relayed by the frontend, confirmed by the owner in the backend session) and implementation authorized: «Sí, confirmo e implementá». Implementation: `odd/tasks/customer-collection.md`. Requested by the frontend for the owner on 2026-11-26 (follow-up of `docs/proposals/sales-history-redesign-contract.md` §9, owner Q3 «Propuesta aparte, más adelante»). Decisions marked **[OWNER]** need the owner; the rest are technical recommendations open to the frontend review. Facts cite `main` 4ee16dd3.

## 0. What exists today (and what this proposal keeps)

| Today | Evidence | Kept? |
|---|---|---|
| Later collection is per sale: `POST /sales/:id/payments`, `update:Sale`, `idempotency-key` header, 1–5 tenders (`cash`, `card_credit`, `card_debit`, `transfer`; no CREDIT) | `sales-payments.controller.ts:27-47`, `dto/add-sale-payment.dto.ts` | Yes, unchanged |
| A later collection never gives change: paying more than the debt is `422 PAYMENT_EXCEEDS_DEBT` | `prisma-sale.repository.ts:1625-1723` | The single-sale route keeps it; the collection may give change (Q3) |
| Payments are stored **per sale** (`SalePayment`), and cancelling a sale refunds its own payments method by method | `sales.service.ts:317-358`, `4013-4078` | Yes: a collection writes per-sale payment rows, so cancellation and refunds work unchanged |
| Bound to an open cash session: one `CashMovement` `SALE_PAYMENT` per payment, owner of the session only | `cash-adapter-ledger.ts:42-91` | Yes |
| A POS cashier can only collect **their own** POS sales (ONLINE sales: anyone) | `sales.service.ts:5038-5085` | Q4 |
| Each payment emits `sale.payment.received`, and `sale.fully.paid` when the debt reaches 0 | `sales.service.ts:1289-1360` | Yes, per sale (Q6 for customer notices) |
| Receipts are per sale (`GET /sales/:id/pdf`); there is no «abono» receipt | `pdf-generation.controller.ts:30-31` | Q5 |
| No rule blocks delivery of an unpaid sale; a payment releases a pay-in-store hold | `prisma-sale.repository.ts:1262-1286`, `sales.service.ts:3960-3970` | Unchanged (§8) |

Known defect found on 2026-11-25: the counter charge (`chargeDraft`) accepts card 1100 + cash 100 on a 1000 sale and records change 200, more than the cash tendered. Owner 2026-11-26: fix it separately and first, rule «Rechazar si el cambio supera el efectivo» (task T1 of the implementation). The collection uses the same rule (§4).

## 1. Routes

| Method | Path | Permission | Purpose |
|---|---|---|---|
| POST | `/customers/:customerId/collections/preview` | `update:Sale` | Computes the allocation without writing (no idempotency key, no locks) |
| POST | `/customers/:customerId/collections` | `update:Sale` | Applies the payment; `idempotency-key` header required |
| GET | `/collections/:collectionId` | `read:Sale` | Reads a collection (same shape as the POST response) |
| GET | `/collections/:collectionId/pdf?format=ticket\|a4` | `read:Sale` | Collection receipt, if Q5 = general receipt |

The single-sale route `POST /sales/:id/payments` stays as it is.

## 2. Request

```json
{
  "payments": [
    { "method": "card_debit", "amountCents": 50000, "paymentMethodId": "uuid?", "reference": "…?" },
    { "method": "cash", "amountCents": 30000 }
  ],
  "cashSessionId": "uuid",
  "saleIds": ["uuid", "…"],
  "expectedDebtCents": 78500
}
```

| Field | Rule |
|---|---|
| `payments` | 1–5 tenders, same methods and catalog rules as the single-sale route (no CREDIT) |
| `cashSessionId` | open session owned by the actor (same checks as today); required or optional is Q7 |
| `saleIds` | optional explicit selection (max 50). Absent = every CONFIRMED sale of the customer with open debt, in the order of Q1 |
| `expectedDebtCents` | the debt the cashier saw in the preview (of the selection, or of all sales). If the real debt under lock differs → `409 COLLECTION_DEBT_CHANGED` with the current preview, so nobody charges against stale numbers |

## 3. Allocation

1. **Candidate sales:** CONFIRMED, `openDebtCents > 0`, of this customer and tenant (all, or the `saleIds` given; a selected sale without debt or of another customer → `422 COLLECTION_SALE_NOT_ELIGIBLE` with its id).
2. **Order [OWNER Q1]:** recommended **oldest due date first**: due day ascending (sales without due date last), then `confirmedAt`, then `id`. Overdue sales are paid first because they are the oldest due. This is already the order of the statement PDF's open-debt list.
3. **Fill in order:** each sale receives `min(remaining amount, its debt)`. With an amount smaller than the debt, the last reached sale is paid **partially** and the rest stay as they were **[OWNER Q2]**.
4. **Tenders to sales:** tenders are consumed in request order, except cash, which is always consumed last (so any change comes from cash). Every (sale, tender part) becomes its own `SalePayment` row with that method and catalog snapshot, for the **applied** amount only (never the tendered amount), so each sale's payments add up exactly to what it received.

Example: debts A 300 (due 01/11), B 500 (due 10/11), C 400 (no due date); tenders card 600 + cash 300 = 900.
A ← card 300; B ← card 300 + cash 200; C ← cash 100 (C stays with 300 debt). No change.

## 4. More than the debt, and change

- Total tendered above the debt of the candidate sales:
  - with cash among the tenders → **change** = excess, allowed only up to the cash tendered **[OWNER Q3]**; one `SALE_CHANGE` cash movement for the collection;
  - excess larger than the cash tendered, or no cash → `422 COLLECTION_EXCEEDS_DEBT` (no credit balance: the system has no customer balance today).
- Change is stored on the collection, not on a sale, so cancelling a sale later never refunds change.

## 5. Writes, atomicity and locks

One transaction:

1. Cash session fence (as today, when bound).
2. Idempotency acquire: `sale_idempotency`, new operation `customer_collection`, `saleId = null`, hash over `{customerId, actorId, payments (sorted), cashSessionId?, saleIds (sorted)?, expectedDebtCents?}`.
3. Lock the candidate sales `FOR UPDATE` **ordered by id** (same order as customer delete, so the two never deadlock; the single-sale route locks one sale and waits). Recompute debts under the lock and compare with `expectedDebtCents`.
4. Insert one new `sale_collections` row (additive migration: id, tenantId, customerId, actorUserId, cashSessionId?, tenderedCents, appliedCents, changeDueCents, createdAt) and the per-sale `SalePayment` rows with a new nullable `collectionId` FK; update `paidCents`, `debtCents`, `paymentStatus` of each sale (same writer as today).
5. Cash movements per payment (`SALE_PAYMENT`, existing unique source per payment) and the `SALE_CHANGE` row if any.
6. Outbox events per sale as today, plus one `customer.collection.recorded` for the collection.

All or nothing: if one sale fails a check, nothing is written.

## 6. Response (POST, GET, idempotent replay)

```json
{
  "collectionId": "uuid",
  "customer": { "id": "uuid", "name": "Ana López" },
  "createdAt": "…",
  "tenderedCents": 90000,
  "appliedCents": 90000,
  "changeDueCents": 0,
  "payments": [{ "method": "card_debit", "amountCents": 60000, "catalog": null }, { "method": "cash", "amountCents": 30000, "catalog": null }],
  "sales": [
    { "saleId": "uuid", "folio": "V-000123", "confirmedAt": "…", "dueDate": "…", "overdue": true, "appliedCents": 30000, "paidCents": 30000, "debtCents": 0, "paymentStatus": "PAID", "paymentIds": ["uuid"] },
    { "saleId": "uuid", "folio": "V-000130", "confirmedAt": "…", "dueDate": "…", "overdue": false, "appliedCents": 50000, "paidCents": 50000, "debtCents": 0, "paymentStatus": "PAID", "paymentIds": ["uuid", "uuid"] },
    { "saleId": "uuid", "folio": "V-000131", "confirmedAt": "…", "dueDate": null, "overdue": false, "appliedCents": 10000, "paidCents": 10000, "debtCents": 30000, "paymentStatus": "PARTIAL", "paymentIds": ["uuid"] }
  ],
  "remainingCustomerDebtCents": 30000
}
```

- `confirmedAt` and `dueDate` are the same strings as in the `GET /sales` row; `overdue` uses the rule of handoff 28 §3 and describes the sale **before** this collection (so the confirmation screen can say «vencida»).
- The preview returns the same shape without `collectionId`, `createdAt` and `paymentIds`, and lists **every candidate sale in allocation order, including those that receive nothing** (`appliedCents: 0`), so the cashier sees what stays pending. The POST response lists only the sales that received money. A replay with the same key and body returns the stored response (200); same key with another body → `409 IDEMPOTENCY_KEY_CONFLICT`; concurrent → `409 IDEMPOTENCY_KEY_IN_FLIGHT`; missing key → `400 IDEMPOTENCY_KEY_REQUIRED` (same codes as the single-sale route).

## 7. Receipt [OWNER Q5]

Recommended: **one «Comprobante de cobro»** per collection (ticket and A4, `GET /collections/:id/pdf`): customer, date, cashier, every sale with applied amount and remaining debt, tenders, change and the customer's remaining debt. The sale receipts keep showing their own payments, so re-printing a sale still works.

## 8. Refunds, cancellation and delivery

- **Cancelling a sale** paid by a collection refunds only that sale's payment rows, method by method, exactly as today. The collection stays as history (`sale_collections` is not rewritten); its receipt shows the sale as cancelled when re-printed.
- **Delivery:** no rule blocks delivering an unpaid sale today and the collection adds none. A collection that pays a sale in pay-in-store hold releases the hold, as a single payment does today.

## 9. Permissions and who may collect

- `update:Sale` to collect, `read:Sale` to read or print, as today. Reviewer (bot) mode is not allowed.
- **[OWNER Q4]** Today a cashier can only collect their own POS sales. For «Cobrar todo» recommended: **anyone with `update:Sale` may collect any sale of the customer** (debts are collected by whoever is at the counter). Alternative: keep the rule, and the collection silently skips other cashiers' sales — confusing at the counter.

## 10. Errors

| HTTP | Code | When |
|---|---|---|
| 400 | `IDEMPOTENCY_KEY_REQUIRED`, validation | missing key; bad tenders, more than 5 tenders or 50 sales |
| 403 | standard / `CASH_SESSION_NOT_OWNED` | no permission; session of another cashier |
| 404 | `CUSTOMER_NOT_FOUND` | unknown customer or of another branch |
| 409 | `COLLECTION_DEBT_CHANGED` | `expectedDebtCents` differs from the debt under lock (body: current preview) |
| 409 | `IDEMPOTENCY_KEY_CONFLICT` / `IDEMPOTENCY_KEY_IN_FLIGHT` | retries |
| 422 | `COLLECTION_NO_OPEN_DEBT` | the customer (or selection) has nothing to collect |
| 422 | `COLLECTION_SALE_NOT_ELIGIBLE` | a selected sale is not CONFIRMED, has no debt or is of another customer (`saleId` in the body) |
| 422 | `COLLECTION_EXCEEDS_DEBT` | excess without cash, or larger than the cash tendered |
| 422 | `CASH_SESSION_NOT_WRITABLE` / `CASH_SESSION_REQUIRED` | session closed; no session when Q7 requires it |

## 11. Decisions

### Owner (answered 2026-11-26)

Answers: Q1 «Vencimiento más viejo primero»; Q2 «En orden; la última queda parcial»; Q3 «Sí, solo hasta el efectivo entregado»; Q4 «Cualquiera con permiso, toda venta» (anyone with `update:Sale` collects any sale of the customer); Q5 «Un "Comprobante de cobro" general»; Q6 «Uno por cobro» (one customer notice per collection; which listeners notify the customer is checked at implementation); Q7 «Sí, obligatorio» (`cashSessionId` required, `422 CASH_SESSION_REQUIRED`). Counter charge defect: «Sí, que lo corrija aparte», rule «Rechazar si el cambio supera el efectivo», done first.

Original questions:

- **Q1 Order:** oldest due date first (recommended) / oldest sale first / always chosen by the cashier.
- **Q2 Partial:** an amount smaller than the debt pays sales in order and leaves the last one partial (recommended) / only exact amounts.
- **Q3 Change:** cash change allowed up to the cash tendered (recommended) / never change in a collection.
- **Q4 Who collects:** anyone with permission collects any sale of the customer (recommended) / only own sales.
- **Q5 Receipt:** one «Comprobante de cobro» per collection (recommended) / only re-print each sale receipt / both.
- **Q6 Customer notice:** if the customer gets WhatsApp/email notices for payments, one message per collection (recommended) instead of one per sale. (To confirm in the code which listeners notify the customer.)
- **Q7 Cash session:** required for every collection (recommended: the money always enters the drawer and the cash closing) / optional as in the single-sale route.

### Frontend (answered 2026-11-26)

- **F1** OK: preview without writes + `expectedDebtCents`, 409 with the updated preview; the POS calls the preview (debounced) whenever amounts change.
- **F2** Added `customer {id, name}`, per-sale `confirmedAt`, `dueDate`, `overdue`, and unapplied candidates in the preview (§6).
- **F3** The POS v1 always collects «all with debt» in the Q1 order; `saleIds` stays in the API without UI.

## 12. Risk and size

Moves money and adds a migration (`sale_collections`, `sale_payments.collectionId`), new locks over several sales and cash movements: high-risk items 1, 4 and 5-adjacent. Implemented as its own feature with independent verification and race tests (collection vs single payment vs customer delete vs cancellation). Estimate: ~1,500 authored lines plus the receipt PDF.

## Implementation notes (final routes)

Implemented on `feat/customer-collection` (b6e4f5eb, 2c6113cc, 21521920, 0c3c4382). The code is authoritative; the final frontend contract is `docs/frontend-handoff/30-customer-collection.md`. Deviations from v1:

- **§5 order:** the idempotency slot is acquired **before** the cash session check (the order of `POST /sales/:id/payments`). A same-key replay returns the stored `200` even after the session was closed. A rejected session check rolls the new slot back with everything else.
- **§5.4 storage:** `sale_collections` also stores `tendersJson`, the tenders as answered (method, tendered amount, catalog snapshot). `GET /collections/:id` and the receipt rebuild `payments` from it.
- **§2/§6 preview:**
  - accepts **0 tenders** (debt and order only);
  - adds a top-level **`debtCents`** (the debt of the candidates before the collection, to send back as `expectedDebtCents`);
  - accepts and ignores `cashSessionId` and `expectedDebtCents`.

  The `409 COLLECTION_DEBT_CHANGED` body carries the current preview under `preview`.
- **§5.3 locks:** with `saleIds`, every selected sale is locked. Without `saleIds`, only the sales the tender **reaches** are locked `FOR UPDATE ORDER BY id`: the shortest Q1 prefix whose debt covers the tender, or every sale when the tender covers the whole debt. The rest are read without locks. When the set of sales that would receive money differs from the locked set, the answer is `409 COLLECTION_DEBT_CHANGED` with the preview, **even without `expectedDebtCents`**. `remainingCustomerDebtCents`, and the debt of sales that receive nothing, are therefore informational unlocked reads.
- **Validation bounds (new):** each tender ≤ 2,147,483,647 cents; their sum ≤ 2,147,483,647 (`400`, `PAYMENTS_TOTAL_TOO_LARGE`); `reference` ≤ 120 characters.
- **422 vs 409 precedence:** `COLLECTION_SALE_NOT_ELIGIBLE`, `COLLECTION_NO_OPEN_DEBT`, `COLLECTION_EXCEEDS_DEBT` and the catalog payment method errors are evaluated under the lock **before** `COLLECTION_DEBT_CHANGED`, so they win over it.
- **§10:** `CASH_SESSION_NOT_OWNED` is **`422`** (the shared cash code), not `403`. `CASH_SESSION_NOT_FOUND`, `CASH_ACTOR_INACTIVE` and `CASH_TENANT_MEMBERSHIP_REQUIRED` are also `422`. `IDEMPOTENCY_KEY_REQUIRED` uses the Nest `400` body (the code is in `message`). The catalog errors are `404 PAYMENT_METHOD_NOT_FOUND`, `409 INACTIVE_PAYMENT_METHOD` and `400 PAYMENT_METHOD_CATEGORY_MISMATCH`.
- **§1/§6 `GET /collections/:id`:** this is not a replay of the POST body.
  - It is rebuilt at the **collection moment**: per-sale balances right after the collection (later payments and refunds excluded), `overdue` as it was before the collection, and the customer's debt right after it.
  - It adds `saleStatus` per sale (the current status, so a sale cancelled since reads `CANCELED`).
  - `customer` and `remainingCustomerDebtCents` become `null` after the customer is deleted.
  - An unknown collection is `404 COLLECTION_NOT_FOUND`.
- **§7 PDF:** `Content-Disposition: attachment; filename="comprobante-cobro-<id>.pdf"` and `Cache-Control: no-store`. `format` defaults to `ticket`; any other value is `400 INVALID_FORMAT`.
- **§4/§5.5 change movement:**
  - The `SALE_CHANGE` cash movement's `sourceId` is the collection id.
  - The `SALE_PAYMENT` movement of the last applied cash part carries that part plus the change.
  - When no cash part is applied (all cash is change), no cash movement is written.
- **§5.6 / Q6:** no listener notifies the customer of payments today. The per-sale events stay as they are (tagged with `collectionId`), and `customer.collection.recorded` is the single hook for a future customer notice.
