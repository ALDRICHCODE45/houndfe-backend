# POS — sales histories redesign (customer history + seller report): product preview, average ticket, overdue sales, customer monthly totals, seller report customer / top products / daily totals / previous period

**Status:** implemented on `feat/sales-history-redesign` (T1 35dae595 `GET /sales` + customer monthly; T2 719aad4c seller report + PDF), merged into local `main` (push and dev deploy by the owner/backend). Task: `odd/tasks/sales-history-redesign.md`. Contract: `docs/proposals/sales-history-redesign-contract.md` v1 (approved by the frontend 2026-11-25). No migration.

Shapes come from the code: `src/sales/dto/sale-list-response.dto.ts`, `src/sales/dto/list-sales-query.dto.ts`, `src/sales/sales.service.ts` (`listSales`, `getCustomerSalesMonthly`), `src/sales/infrastructure/prisma-sale.repository.ts`, `src/sales/sales-customer-monthly.controller.ts`, `src/sales/dto/customer-sales-monthly.dto.ts`, `src/analytics/dto/seller-sales-report-response.dto.ts`, `src/analytics/application/seller-sales-report.service.ts`, `src/analytics/infrastructure/prisma-seller-sales-report.repository.ts`, `src/pdf-generation/templates/report/seller-sales-report-a4.document.tsx`, and the real-PostgreSQL spec `src/sales/sales-history-redesign.integration.spec.ts`. Nothing was sent to the dev API.

Every change is **additive**: no field was removed or renamed. The only behavior change on an existing output is the seller report PDF (new «Cliente» column, new payment labels, §6).

## 1. Permissions

| Route | Needs |
| --- | --- |
| `GET /sales` (new fields, `overdue` param) | `read:Sale` (unchanged) |
| `GET /customers/:customerId/sales-monthly` (**new**) | `read:Sale` (not `read:Customer`) |
| `GET /analytics/sales/sellers/:sellerUserId/report` and `…/report/pdf` | `read:Analytics` **and** `read:Sale` (unchanged) |

No new CASL subject. Every route runs `JWT → tenant context → permissions`; the sucursal is the token's.

## 2. `GET /sales` additions

### 2.1 Rows: `itemsPreview` and `itemsCount` (every row)

Every row of `data[]` gains two members, **with or without `customerId`**:

| Field | Type | Notes |
| --- | --- | --- |
| `itemsPreview` | `{ productName: string, variantName: string \| null, quantity: number }[]` | at most **3** lines, in line creation order (`createdAt`, then `id`) |
| `itemsCount` | int | number of **lines** of the sale (not units). `0` and `itemsPreview: []` for a sale without lines |

```json
{
  "id": "0b8a…",
  "folio": "V-000123",
  "status": "CONFIRMED",
  "paymentStatus": "PARTIAL",
  "totalCents": 125000,
  "debtCents": 45000,
  "confirmedAt": "2026-11-10T17:02:11.000Z",
  "dueDate": "2026-11-25T00:00:00.000Z",
  "customer": { "id": "5c1e…", "name": "Ana Pérez" },
  "…": "…the other existing row members…",
  "itemsPreview": [
    { "productName": "Croquetas Adulto 15 kg", "variantName": null, "quantity": 2 },
    { "productName": "Collar ajustable", "variantName": "Chico · Azul", "quantity": 1 },
    { "productName": "Desparasitante Canino 10 ml", "variantName": null, "quantity": 3 }
  ],
  "itemsCount": 5
}
```

- Names come from the **line snapshot** (`SaleItem.productName` / `variantName`): a renamed or deleted product still reads as it was sold.
- `quantity` is the line quantity (an integer).
- Show «+2 más» as `itemsCount - itemsPreview.length` when it is > 0.
- Cost: one extra query per page (≤ 100 sales), no N+1.

### 2.2 `summary` and `counts` additions

```json
"counts": { "all": 14, "pendingPayments": 3, "notDelivered": 1, "overdue": 2 },
"summary": {
  "salesCount": 14,
  "totalSoldCents": 1834500,
  "outstandingDebtCents": 98000,
  "averageTicketCents": 131036,
  "overdueDebtCents": 61000,
  "oldestOverdueDueDate": "2026-11-10"
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `summary.averageTicketCents` | int | `round(totalSoldCents / salesCount)` (half up to the cent, like the seller report's `averageTicketCents`); `0` when `salesCount` is `0`. Always present, not only with one `customerId` |
| `counts.overdue` | int | number of **overdue** sales (§3) |
| `summary.overdueDebtCents` | int | sum of the open debt of those overdue sales |
| `summary.oldestOverdueDueDate` | `"YYYY-MM-DD"` \| `null` | the due day of the oldest overdue sale (the date the row shows, §3), `null` when there is no overdue sale. For «1 vencida el 10/11» |

**Scope of `summary` and `counts` (old and new members alike):** CONFIRMED sales under the **base** filters only: `customerId` (and `customerIncludeNull`), `cashierUserId`, `confirmedFrom` / `confirmedTo` (and the deprecated `from` / `to` aliases) and `q`. The page (extended) filters never move them: `status`, `folio`, `paymentStatus`, `deliveryStatus`, `paymentMethod`, `paymentMethodIncludeNull`, `petId`, `dueDateFrom/To`, `dueDateIncludeNull`, `totalMin/Max`, `debtMin/Max` and the new `overdue`. So the KPI cards keep their values while a tab or filter is applied, and `summary.salesCount === counts.all` always.

### 2.3 Query parameter `overdue`

| Value | Effect |
| --- | --- |
| absent, `false` | no filter |
| `true` | lists only overdue sales (§3) |
| anything else (`yes`, `1`, `TRUE`, empty, …) | **`400`** (standard per-field validation body, `property: "overdue"`) |

Only the exact strings `"true"` and `"false"` are accepted.

It is an **extended** filter:

- It **combines (AND)** with `customerId`, `petId` (still needs exactly one `customerId`), `paymentStatus`, `deliveryStatus` and every other filter. Example: `GET /sales?customerId=<uuid>&overdue=true` = the overdue sales of that customer; `…&overdue=true&petId=<uuid>` = the overdue sales of that customer that have a line for that pet.
- It **narrows** `data`, `pagination.total` / `totalPages` and `filterSummary` (`count`, `totalCents`, `debtCents`).
- It **never changes** `summary` or `counts`: with `overdue=true` and no other extended filter, `pagination.total === counts.overdue` and `filterSummary.debtCents === summary.overdueDebtCents`.
- Overdue implies CONFIRMED, so `overdue=true&status=CANCELED` returns an empty page.

Typical flow: the customer card shows «2 vencidas · $610.00 · la más antigua el 10/11» from `counts.overdue`, `summary.overdueDebtCents` and `summary.oldestOverdueDueDate`; tapping it reloads the same list with `&overdue=true`.

## 3. The overdue rule (exact)

A sale is **overdue** when all three hold:

1. `status` is `CONFIRMED`;
2. its open debt is > 0 (canceled sales count as 0);
3. its **due day** is **before today's date in the business timezone** (`America/Mexico_City`).

The **due day** is the **UTC calendar date of `dueDate`**, i.e. the first 10 characters of the row's `dueDate` string (`"2026-11-25T00:00:00.000Z"` → `2026-11-25`). That is exactly the date the POS shows. Due dates picked by the user are stored as 00:00Z of the picked day. A sale with no `dueDate` is never overdue.

Examples (sale with open debt, due on 25/11, `dueDate: "2026-11-25T00:00:00.000Z"`):

| Local date in Mexico City | Overdue? |
| --- | --- |
| 24/11 | no |
| 25/11, any time, including 23:30 (05:30Z of the 26th) | **no**: the due day itself is not overdue |
| 26/11 from 00:00 local | **yes** |
| 26/11, but the debt was paid in full | no |

- `summary.oldestOverdueDueDate` is the **same date string** the row shows: the oldest overdue sale with `dueDate: "2026-11-10T00:00:00.000Z"` gives `"2026-11-10"`. Format it the same way as the row's due date, never through a timezone conversion.
- Default due dates (`confirmedAt + 15 days`, when nobody picked one) keep a time of day; the rule still uses their UTC date, the one the POS displays.
- `counts.overdue`, `summary.overdueDebtCents`, `summary.oldestOverdueDueDate` and `overdue=true` share one cut-off computed per request, so they always agree.

## 4. `GET /customers/:customerId/sales-monthly` — new

Monthly totals of one customer, for the chart in the customer card. It lives in the sales module but the path is under `/customers`.

### Request

| Param | Where | Rules |
| --- | --- | --- |
| `customerId` | path | UUID (`400` otherwise) |
| `months` | query | optional integer **1–24**, default **12**. `0`, `25`, `abc`, `1.5` → `400` |

### `200` response

```json
{
  "customerId": "5c1e9a02-77d4-4b8a-a1f3-0e2d4c6b8a90",
  "timeZone": "America/Mexico_City",
  "months": [
    { "month": "2026-09", "saleCount": 0, "totalCents": 0 },
    { "month": "2026-10", "saleCount": 2, "totalCents": 58000 },
    { "month": "2026-11", "saleCount": 3, "totalCents": 125000 }
  ]
}
```

(`?months=3` on 2026-11-25.)

- **Exactly `months` entries**, oldest first; the **last one is the current local month** (Mexico City). Months with no sales are present with `saleCount: 0, totalCents: 0`, so the chart has no gaps. A customer with no sales gets `months` zero entries, not an empty array.
- Counts **CONFIRMED** sales of the customer by **`confirmedAt`**, bucketed by local month; `totalCents` is the sum of their `totalCents` (refunds not subtracted, canceled sales excluded), the same definition as `summary.totalSoldCents`.

### Errors

| HTTP | Body | When |
| --- | --- | --- |
| 400 | `{ "statusCode": 400, "message": "Validation failed (uuid is expected)", "error": "Bad Request" }` | `customerId` is not a UUID |
| 400 | standard per-field validation body (`message` array, `property: "months"`) | bad `months` |
| 403 | `{ "statusCode": 403, "error": "INSUFFICIENT_PERMISSIONS", "message": "Insufficient permissions", "timestamp": "…" }` | missing `read:Sale` |
| 404 | `{ "statusCode": 404, "error": "CUSTOMER_NOT_FOUND", "message": "CUSTOMER_NOT_FOUND" }` | unknown customer or one of another sucursal |

The `404` is code-only (**no `timestamp`**), the same envelope as `GET /customers/:customerId/pets`. Switch on `error`.

## 5. Seller report additions (`GET /analytics/sales/sellers/:sellerUserId/report`)

Query, permissions, the 1,000-row cap and the `422 SELLER_REPORT_ROW_LIMIT_EXCEEDED` are unchanged (see `docs/branch-sales-summary-frontend.md` §15). `from` / `to` are local dates, half-open `[from, to)`. The cap is checked before anything else, so on `422` none of the new blocks is computed.

New top-level key order: `seller, tenantId, timeZone, from, to, generatedAt, attribution, balances, rowLimit, rowCount, confirmed, canceled, topProducts, dailyTotals, previousPeriod`.

### 5.1 `customer` on rows

Every row of `confirmed.rows[]` and `canceled.rows[]` gains `customer: { id, name } | null`:

```json
{ "id": "…", "folio": "V-000123", "confirmedAt": "2026-11-10T17:02:11.000Z", "totalCents": 125000,
  "paidCents": 80000, "debtCents": 45000, "paymentStatus": "PARTIAL",
  "customer": { "id": "5c1e…", "name": "Ana Pérez" } }
```

- `name` = `firstName lastName` (or only `firstName`), the same rule as the `GET /sales` rows. It is the customer's **current** name (no snapshot on the sale).
- `null` = público en general, or the customer was deleted. Show «Público en general».
- Only `id` and `name`, never contact data.

### 5.2 `topProducts`

```json
"topProducts": [
  { "productId": "c89a…", "variantId": null, "productName": "Croquetas Adulto 15 kg", "variantName": null, "quantity": 12, "netSalesCents": 345600 },
  { "productId": "5116…", "variantId": "bf93…", "productName": "Collar ajustable", "variantName": "Chico · Azul", "quantity": 7, "netSalesCents": 62300 }
]
```

- At most **5**; `[]` when the seller has no confirmed sale in the period.
- Over the same CONFIRMED sales as `confirmed.rows` (by `confirmedAt` in `[from, to)`); canceled sales excluded.
- Grouped by `(productId, variantId)`; `productName` / `variantName` from the most recent line of the group in the period.
- `quantity` = units sold. `netSalesCents` = sum of the line totals **after line discounts and line promotions**.
- Order: `quantity` desc → `netSalesCents` desc → `productId` (then `variantId`, no-variant first) as a final tie-breaker.
- **Caveat:** order-level (sale-wide) discounts and promotions are **not distributed** to lines, so the sum of `topProducts[].netSalesCents` **can be greater than** `confirmed.summary.netSalesCents`. Label the amount column **«antes de descuentos de la venta»** and never present it as part of the seller's total.

### 5.3 `dailyTotals`

```json
"dailyTotals": [
  { "date": "2026-11-01", "saleCount": 0, "netSalesCents": 0 },
  { "date": "2026-11-02", "saleCount": 3, "netSalesCents": 187000 }
]
```

- **One entry per local day of `[from, to)`** in `timeZone` (America/Mexico_City), oldest first, **days with zero sales included** (at most 366 entries; `from=2026-11-01&to=2026-12-01` → 30 entries).
- Same definition as `confirmed.summary`: CONFIRMED by `confirmedAt`, `totalCents`, refunds not subtracted. It is derived from the same rows, so **`Σ saleCount === confirmed.summary.saleCount`** and **`Σ netSalesCents === confirmed.summary.netSalesCents`** always.

### 5.4 `previousPeriod`

```json
"previousPeriod": { "from": "2026-10-02", "to": "2026-11-01", "saleCount": 21, "netSalesCents": 1520000 }
```

- The period right before the report: **the same number of days**, ending where the report starts. `previousPeriod.to` is always the report's `from`; `previousPeriod.from = from − (to − from)` days. Example: report `from=2026-11-01&to=2026-12-01` (30 days) → previous `2026-10-02` … `2026-11-01` (half-open).
- Same definition as `confirmed.summary` (`saleCount`, `netSalesCents`). Aggregate only: not limited by the 1,000-row cap.
- Use it for «+12% vs. período anterior»; guard the percentage when `previousPeriod.netSalesCents` is `0`.

## 6. Seller report PDF (`…/report/pdf`)

| Change | Detail |
| --- | --- |
| «Cliente» column | In **both** tables (confirmed and canceled), right after «Folio» |
| No customer | «Público en general» (also when the name is blank) |
| Long names | Names longer than **40** characters are cut to 39 characters plus «…» |
| Payment labels | `PAID` «Pagada» (unchanged), `PARTIAL` «Impaga» (was «Parcial»), `CREDIT` «Deuda» (was «A crédito») |

`topProducts`, `dailyTotals` and `previousPeriod` are **not** in the PDF; they are JSON only. The route, headers, filename and the `422` behavior are unchanged.

## 7. Not in this batch

- **Customer statement PDF** (contract §8): a later task, not available yet.
- **«Cobrar todo»** (one payment across several sales, contract §9): a separate proposal later. Keep paying sale by sale with `POST /sales/:id/payments`.

## 8. Error summary

| HTTP | `error` / body | Route |
| --- | --- | --- |
| 400 | per-field validation (`property: "overdue"`) | `GET /sales?overdue=` with a value other than `true` / `false` |
| 400 | `Validation failed (uuid is expected)` / per-field `months` | `GET /customers/:customerId/sales-monthly` |
| 403 | `INSUFFICIENT_PERMISSIONS` | missing `read:Sale` (monthly), or `read:Analytics` / `read:Sale` (seller report) |
| 404 | `CUSTOMER_NOT_FOUND` (code-only, no `timestamp`) | monthly: unknown or other-sucursal customer |
| 422 | `SELLER_REPORT_ROW_LIMIT_EXCEEDED` | seller report and PDF, unchanged |

Existing `GET /sales` errors (`PET_FILTER_REQUIRES_CUSTOMER`, `PET_NOT_FOUND`, listing range errors) are unchanged.
