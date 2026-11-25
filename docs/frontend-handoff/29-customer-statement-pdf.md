# 29 — Customer account statement PDF («estado de cuenta»)

**Status:** implemented and merged into local `main` (b2f035dd; push pending). Task: `odd/tasks/sales-history-redesign.md` T4 (S11). Contract: `docs/proposals/sales-history-redesign-contract.md` §8. No migration.

Owner decisions (2026-11-25): «Todas las del período + deuda abierta» and «Sí, con los pagos del período».

## 1. Route

`GET /customers/:customerId/statement/pdf?from=YYYY-MM-DD&to=YYYY-MM-DD`

| Item | Value |
|---|---|
| Permission | `read:Sale` (same as `GET /customers/:customerId/sales-monthly`) |
| `customerId` | UUID |
| `from`, `to` | local dates in the business timezone (America/Mexico_City), **half-open `[from, to)`** like the seller report: to cover all of November send `from=2026-11-01&to=2026-12-01` |
| Range | 1 to 366 days |
| Response | `200`, `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="estado-de-cuenta-<customerId>-<from>-<to>.pdf"`, `Cache-Control: no-store` |

Download it as a blob (as with the seller report PDF); nothing is written before the PDF is ready, so an error never arrives as a half PDF.

## 2. Errors

| HTTP | Body | When |
|---|---|---|
| 400 | Nest validation body | non-UUID `customerId`; `from`/`to` missing, malformed or not a real date (`2026-02-30`); `to <= from`; more than 366 days |
| 403 | standard forbidden body | no `read:Sale` |
| 404 | `{ "statusCode": 404, "error": "CUSTOMER_NOT_FOUND", "message": "CUSTOMER_NOT_FOUND" }` (code-only, no `timestamp`) | unknown customer or a customer of another branch |
| 500 | `PDF_GENERATION_FAILED` | the PDF could not be rendered |

## 3. What the PDF contains

1. **Header:** customer (name, phone, email, business name/RFC when present), branch, period, generation date.
2. **Sales of the period:** every CONFIRMED sale of the customer with `confirmedAt` in `[from, to)`: folio, date, total, paid, open debt, due day and status («Pagada / Impaga / Deuda», the same labels as the POS), with an overdue mark. Canceled sales are not listed here.
   - «Pagado» is the sale's **current** paid amount, including payments made after the period (the PDF says so).
3. **Period totals:** number of sales, total, paid and open debt of those sales.
4. **Current open debt:** what the customer owes **today** across all confirmed sales, also those older than the period, and how much of it is overdue.
5. **Payments received in the period:** every payment of the customer's sales whose date is in `[from, to)`: date, sale folio, method and amount.
   - Cash is shown **net of change** («Recibido X · cambio Y»), so the total is what was actually paid.
   - A payment of a sale that was later canceled is listed and marked «Venta cancelada».
   - **Refunds are not listed or subtracted**, and the PDF says so.
6. **Empty states:** «Sin ventas…», «Sin pagos…», «Sin deuda abierta.».

The **overdue** rule is the one of handoff 28 §3: a sale is overdue when its due day (the date the POS shows) is before today and it still has open debt. A sale due today is not overdue.

Long statements paginate with the table header repeated on each page and «Página N de M» (checked with 120 sales and 80 payments: 9 pages). There is no row cap.
