# Sales histories redesign (customer history + seller report) — contract proposal v0

Status: **v1 APPROVED by the frontend 2026-11-25; owner answers Q1–Q3 and implementation authorization given in the backend session (§10).** Implementation in progress (`odd/tasks/sales-history-redesign.md`). Requested by the frontend on 2026-11-25 after the owner approved the POS redesign of both histories. Facts cite the current backend (`main` c51857c1).

Every change is additive for callers. Existing unit tests that pin exact key sets (seller report key constants, `summary` `toEqual`) are updated with the change; no other consumer stores these payloads.

## 0. Requests and disposition

| # | Request (frontend) | Disposition | Where |
|---|---|---|---|
| R1 | Products of each sale in `GET /sales` rows | Accepted, every row | §1 |
| R2 | Customer on seller report rows | Accepted, JSON and PDF column (owner Q1) | §2 |
| R3 | Average ticket in `GET /sales` `summary` | Accepted | §3 |
| R4 | Top products of the seller in the period | Accepted (top 5) | §4 |
| R5 | Daily totals (seller) and monthly totals (customer) | Accepted; customer monthly as its own endpoint | §5 |
| R6 | Previous period comparison (seller) | Accepted | §6 |
| R7 | Overdue sales of the customer | Accepted; defines «vencida» (new notion) | §7 |
| R8 | Customer account statement PDF | Deferred to a later batch (owner Q2) | §8 |
| R9 | «Cobrar todo» (one payment for several sales) | Separate proposal later (owner Q3) | §9 |
| R10 | Payment status labels in backend PDFs aligned with the POS («Pagada / Impaga / Deuda») | Accepted | §9.1 |

## 1. `GET /sales` rows: product preview (R1)

Every row (with or without `customerId`) gains:

| Field | Type | Notes |
|---|---|---|
| `itemsPreview` | `{ productName: string, variantName: string \| null, quantity: number }[]` | at most 3 lines, in line creation order (`createdAt`, then `id`; sale lines have no position column) |
| `itemsCount` | int | number of lines of the sale (not units) |

- Names come from the line snapshot (`SaleItem.productName` / `variantName`), so renamed or deleted products still read as sold.
- Cost: one extra query per page (window function over the page's sale ids, at most 100 sales), no N+1. `data`, `pagination`, `counts`, `summary` and `filterSummary` are otherwise unchanged.

## 2. Seller report rows: customer (R2)

`GET /analytics/sales/sellers/:sellerUserId/report`: every row of `confirmed.rows[]` and `canceled.rows[]` gains `customer: { id, name } | null` (`null` = público en general). `name` = `firstName lastName` (same rule as `GET /sales` rows). Current name of the customer (customers have no name snapshot on the sale); a deleted customer reads `null`.

This reverses the DTO header promise «no customer field is projected»; the header is updated. The seller report PDF also prints a «Cliente» column in both tables (owner Q1), «Público en general» when `customer` is `null`.

## 3. `GET /sales` `summary.averageTicketCents` (R3)

`summary.averageTicketCents = round(totalSoldCents / salesCount)`, `0` when `salesCount = 0`. Always present (not only with one `customerId`); same scope as the rest of `summary`: CONFIRMED sales under the **base** filters (customer, cashier, `confirmedFrom/To`, `q`), never the page filters (`paymentStatus`, `deliveryStatus`, `petId`, …). Rounding half up to the cent, the same as the seller report's `averageTicketCents`.

## 4. Seller report `topProducts` (R4)

New top-level block in the seller report:

```json
"topProducts": [
  { "productId": "uuid", "variantId": "uuid|null", "productName": "…", "variantName": "…|null", "quantity": 12, "netSalesCents": 345600 }
]
```

- At most 5, over the report's CONFIRMED sales in `[from, to)` (same set as `confirmed.rows`; canceled sales excluded).
- Grouped by `(productId, variantId)`; names from the most recent line in the period.
- `netSalesCents` = sum of line totals after **line** discounts and line promotions. **Order-level discounts/promotions are not distributed to lines**, so the sum of `topProducts.netSalesCents` can be greater than `confirmed.summary.netSalesCents`. Documented in the handoff.
- Order: `quantity` desc, then `netSalesCents` desc, then `productId` (frontend F2: «más vendidos» reads as units; the POS labels the amount «antes de descuentos de la venta»).
- Respects the existing 1,000-row cap (the report fails with `SELLER_REPORT_ROW_LIMIT_EXCEEDED` before computing it).

## 5. Time series (R5)

### 5.1 Seller report `dailyTotals`

New top-level block: `dailyTotals: [{ date: "YYYY-MM-DD", saleCount, netSalesCents }]`, one entry per local day of `[from, to)` in the report's `timeZone` (America/Mexico_City), **including days with zero sales** (max 366 entries, so the chart has no gaps). Same definition as `confirmed.summary` (CONFIRMED by `confirmedAt`, `totalCents`, refunds not subtracted).

### 5.2 Customer monthly totals — new endpoint

`GET /customers/:customerId/sales-monthly?months=12` (permission `read:Sale`; `months` 1–24, default 12):

```json
{ "customerId": "uuid", "timeZone": "America/Mexico_City", "months": [ { "month": "2026-11", "saleCount": 3, "totalCents": 125000 } ] }
```

One entry per month ending with the current local month, including months with zero sales; CONFIRMED sales by `confirmedAt`. A separate endpoint so `GET /sales` (paginated, filter-driven) stays as is; unknown customer → `404 CUSTOMER_NOT_FOUND`.

## 6. Seller report `previousPeriod` (R6)

New top-level block: `previousPeriod: { from, to, saleCount, netSalesCents }`, where the previous period has the same number of days and ends where the current one starts (`to = from`). Same definition as `confirmed.summary`. Not affected by the row cap (aggregate only).

## 7. Overdue sales (R7)

New notion, defined once and used everywhere: a sale is **overdue** when it is CONFIRMED, its open debt (`openDebtCents`) is > 0 and its **due day** is before today's local date in the business timezone (America/Mexico_City). The due day is the UTC calendar date of `dueDate`, which is exactly the date the POS shows: user-picked due dates are stored as 00:00Z of the picked day, so a sale due on 25/11 is not overdue during 25/11 and becomes overdue on 26/11 (independent verify finding, 2026-11-25).

In `GET /sales` (base filters, like the other counts):

| Field | Notes |
|---|---|
| `counts.overdue` | number of overdue sales |
| `summary.overdueDebtCents` | open debt of those sales |
| `summary.oldestOverdueDueDate` | `YYYY-MM-DD` due day (the date the POS shows) of the oldest overdue sale, or `null`, for «1 vencida el …» |

Plus a page filter `overdue=true` so the warning can open the list of those sales. It is an **extended** filter: it combines (AND) with `customerId`, `petId`, `paymentStatus`, `deliveryStatus` and the other page filters, narrows `data`, `pagination` and `filterSummary`, and never changes `summary` or `counts`. `overdue=false` or absent = no filter.

Pre-existing inconsistency, not changed here: the default `dueDate` (`confirmedAt + 15 days`) keeps the time of day and uses server-local time, and `setDueDate` validates against UTC. The overdue rule follows the displayed due day, so both kinds of stored values agree with what the POS shows.

## 8. Customer statement PDF (R8) — follow-up task T4 (owner 2026-11-25)

Deferred by owner Q2 («Después»), then started on 2026-11-25 («Sí, arrancá ahora») with two decisions: «Todas las del período + deuda abierta» and «Sí, con los pagos del período» (this replaces the earlier «no payments ledger in v1»). Scope: `GET /customers/:customerId/statement/pdf?from=YYYY-MM-DD&to=YYYY-MM-DD` (A4, same visual system as the seller report PDF): customer data, period, every CONFIRMED sale of the period (folio, date, total, paid, open debt, due day, overdue mark with the §7 rule), period totals, the customer's current open debt across all sales (also older than the period) with its overdue part, and every payment received in the period (date, method, amount, sale folio). Refund obligations and settlements are not listed or subtracted, and the PDF says so. Final details: frontend handoff 29.

## 9. «Cobrar todo» (R9) — separate proposal later (owner Q3)

Not proposed as a contract in this batch. It moves money and adds rules that do not exist today (one payment applied across several sales): allocation order (oldest `dueDate` first?), partial allocation, one idempotency key for several sales, cash session binding, method splits, receipts per sale, and its interaction with refunds and the delivery gate. Recommendation: keep the POS paying sale by sale (`POST /sales/:id/payments`) and, if the owner wants it, write a separate proposal with those rules.

### 9.1 Payment status labels in PDFs (R10)

The POS now labels `PAID` «Pagada», `PARTIAL` «Impaga», `CREDIT` «Deuda» in every screen, including the seller report. The seller report PDF still prints «Parcial» and «A crédito» (`src/pdf-generation/templates/report/seller-sales-report-a4.document.tsx:50-51`). Change those two labels to «Impaga» and «Deuda» so screen and PDF match; a future statement PDF (§8) uses the same labels. The receipt PDFs print amounts («Pagado», «Deuda»), not payment statuses, and stay unchanged.

## 10. Resolved points (2026-11-25)

### Owner (backend session)

- **Q1** → «Sí, también en el PDF»: customer column in the seller report PDF (§2).
- **Q2** → «Después»: statement PDF in a later batch (§8).
- **Q3** → «Propuesta aparte, más adelante» (§9).
- Implementation of §1–§7 and §9.1 authorized once the frontend approved: «Sí, arrancá cuando apruebe».

### Frontend

- **F1** OK on every row. **F2** order by `quantity` (§4). **F3** OK. **F4** OK. **F5** OK; `overdue=true` confirmed as an extended filter (§7). **R10** OK.

## Implementation notes (final routes)

Implemented on `feat/sales-history-redesign` (T1 35dae595, T2 719aad4c). The frontend reference with final routes, shapes and errors is [`docs/frontend-handoff/28-sales-history-redesign.md`](../frontend-handoff/28-sales-history-redesign.md); where it and this contract differ, the handoff (taken from the code) wins. Points this contract left open, as implemented:

- **Monthly endpoint home:** `GET /customers/:customerId/sales-monthly` is served by `SalesCustomerMonthlyController` in the **sales** module (`src/sales/sales-customer-monthly.controller.ts`), like `customers/:customerId/pets` lives in customer-pets, so `CustomersModule` does not import `SalesModule`. Permission `read:Sale`; non-UUID `customerId` → `400`; `months` outside 1–24 or not an integer → `400`.
- **`overdue` parsing:** only the exact strings `"true"` and `"false"` are accepted; any other value (`yes`, `1`, `TRUE`, empty) → `400` per-field validation. `overdue=true` with `status=CANCELED` returns an empty page (overdue implies CONFIRMED).
- **`404 CUSTOMER_NOT_FOUND` envelope:** code-only `{ statusCode, error, message }` **without `timestamp`** (the customer pets envelope), unlike the sales module's usual `{ statusCode, error, message, timestamp }`.
- **Base filters of `summary`/`counts`:** also include `customerIncludeNull` and the deprecated `from`/`to` aliases of `confirmedFrom`/`confirmedTo` (§3 listed customer, cashier, `confirmedFrom/To`, `q`).
- **`topProducts` tie-breaker:** after `productId`, `variantId` (no-variant first); names from the most recent line by `confirmedAt`, then line `createdAt`, then `id`.
- **PDF scope:** the seller report PDF adds only the «Cliente» column (both tables; «Público en general» when `customer` is `null` or the name is blank; names over 40 characters cut to 39 + «…») and the labels «Pagada / Impaga / Deuda». `topProducts`, `dailyTotals` and `previousPeriod` are JSON only, not printed.
