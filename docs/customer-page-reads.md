# Customer page reads: «Cliente de confianza» and the KPI strip

This doc covers two additions for the customer page `/pos/clientes/:id`:

- the «Cliente de confianza» switch (`isTrusted`), which you read from `GET /customers/:id` and change with `PATCH /customers/:id`;
- the KPI strip, which you read from `GET /customers/:customerId/sales-summary`.

Specification: `docs/proposals/customers-list-contract.md` §6, §6.1, §6.2, §2.1, §10, §11, §13.

## 1. `isTrusted` («Cliente de confianza»)

### Read: `GET /customers/:id`

|            |                                                                      |
| ---------- | -------------------------------------------------------------------- |
| Permission | `read:Customer` (unchanged)                                          |
| Change     | adds `isTrusted: boolean` (`false` for a customer nobody has marked) |

The rest of the detail is unchanged: `globalPriceList`, `addresses[]`, `activePetsCount`, and so on. Unknown or other-tenant customer → `404 ENTITY_NOT_FOUND` (unchanged).

`isTrusted` is also a field of every `GET /customers/listing` row, and you can filter on it with `isTrusted=true|false` there.

**`GET /customers` (the POS / checkout picker) is unchanged.** Its items do **not** have `isTrusted`. Use the detail or the listing to read it.

### Write: `PATCH /customers/:id`

|            |                                                     |
| ---------- | --------------------------------------------------- |
| Permission | `update:Customer` (unchanged)                       |
| Body       | any existing PATCH field, plus optional `isTrusted` |

```json
{ "isTrusted": true }
```

- `isTrusted` must be a JSON boolean: `true` or `false`. The strings `"true"` / `"false"`, numbers and `null` → `400` with the standard per-field validation body (below). In that case nothing is written, including the other fields of the same body.
- If you leave `isTrusted` out of the body, the stored value stays as it is. Every other field works as before.
- The response is the customer detail, the same shape as the PATCH response before, now with `isTrusted`. It does not include `activePetsCount`, as before.
- Last write wins, like every other PATCH field.
- Changing `isTrusted` changes nothing else. Price lists, sales and the bot work the same, and the chatbot inbox reads the same column, so it shows the change too.
- `POST /customers` does **not** accept `isTrusted`: sending it → `400` (unknown property). New customers start with `isTrusted: false`. The `POST` response now also carries `isTrusted: false`.

Example of a rejected value (`{"isTrusted": "true"}`):

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": [
    {
      "property": "isTrusted",
      "children": [],
      "constraints": { "isBoolean": "isTrusted must be a boolean value" }
    }
  ]
}
```

| HTTP | Body / code                            | When                                                |
| ---- | -------------------------------------- | --------------------------------------------------- |
| 400  | per-field validation body              | `isTrusted` is not a JSON boolean; unknown property |
| 400  | `Validation failed (uuid is expected)` | non-UUID `:id`                                      |
| 403  | `INSUFFICIENT_PERMISSIONS`             | missing `update:Customer`                           |
| 404  | `ENTITY_NOT_FOUND`                     | unknown or other-tenant customer                    |

## 2. KPI strip: `GET /customers/:customerId/sales-summary`

|               |                                          |
| ------------- | ---------------------------------------- |
| Permission    | `read:Sale`                              |
| `:customerId` | UUID of a customer of the current tenant |
| Query         | none                                     |

### Response `200`

```json
{
  "customerId": "uuid",
  "metrics": {
    "openDebtCents": 78500,
    "overdueDebtCents": 30000,
    "overdueCount": 1,
    "oldestOverdueDueDate": "2026-11-01",
    "salesCount": 14,
    "totalSoldCents": 1250000,
    "averageTicketCents": 89286,
    "lastPurchaseAt": "2026-11-20T19:31:02.000Z"
  }
}
```

`metrics` is **exactly** the `metrics` object of the customer's `GET /customers/listing` row, built by the same SQL. «Deuda», «Vencido», «Total comprado», «Ticket promedio» and «Última compra» always match the table.

| Field                  | Meaning                                                                   | Without sales |
| ---------------------- | ------------------------------------------------------------------------- | ------------- |
| `salesCount`           | number of CONFIRMED sales (any channel)                                   | `0`           |
| `totalSoldCents`       | Σ `totalCents` of those sales (refunds not subtracted)                    | `0`           |
| `openDebtCents`        | Σ open debt of those sales                                                | `0`           |
| `overdueCount`         | sales with open debt whose due date is before today (business local date) | `0`           |
| `overdueDebtCents`     | Σ open debt of those overdue sales                                        | `0`           |
| `oldestOverdueDueDate` | `YYYY-MM-DD` of the oldest overdue due date                               | `null`        |
| `averageTicketCents`   | `round(totalSoldCents / salesCount)`, half up                             | `null`        |
| `lastPurchaseAt`       | latest `confirmedAt`, ISO instant                                         | `null`        |

- Only CONFIRMED sales count. Draft and canceled sales do not count, and a sale stops counting as soon as it is canceled.
- «Vencida» follows the same rule as `GET /sales`. A sale due today becomes overdue at local midnight (business timezone, Mexico City by default).
- A customer with no sales gets `200` with counts and sums at `0`, and `oldestOverdueDueDate`, `averageTicketCents` and `lastPurchaseAt` at `null`. Note that `GET /sales` `summary.averageTicketCents` is `0` in that case. The difference is on purpose (contract §2.1).
- The values are computed on every read, so they are always current.

### Errors

| HTTP | Body / code                            | When                                |
| ---- | -------------------------------------- | ----------------------------------- |
| 400  | `Validation failed (uuid is expected)` | non-UUID `:customerId`              |
| 403  | `INSUFFICIENT_PERMISSIONS`             | missing `read:Sale`: hide the strip |
| 404  | `CUSTOMER_NOT_FOUND` (code-only)       | unknown or other-tenant customer    |

The 404 body has the same code-only shape as the other customer sales routes (`sales-monthly`, `payments`):

```json
{
  "statusCode": 404,
  "error": "CUSTOMER_NOT_FOUND",
  "message": "CUSTOMER_NOT_FOUND"
}
```
