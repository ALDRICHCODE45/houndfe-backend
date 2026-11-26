# Customer payments feed («Cobros y recibos»)

`GET /customers/:customerId/payments?page=&limit=`

The customer page's «Cobros y recibos» tab lists every payment received from the customer, newest first. Each row of the feed is one **event**:

- `collection`: one «Cobrar todo», grouped into a single row with its breakdown;
- `payment`: any other payment (counter charge, `POST /sales/:id/payments`, bot or online payment).

Specification: `docs/proposals/customers-list-contract.md` §7, §7.1, §7.2, §12.3, with the frontend answers of 2026-11-26 (net amount by default, relative `receiptPath`, lowercase `method`).

## Request

| | |
|---|---|
| Permission | `read:Sale` |
| `:customerId` | UUID of a customer of the current tenant |
| `page` | integer ≥ 1, default `1` |
| `limit` | integer 1–100, default `50` |

No other query parameter is accepted.

## Response `200`

```json
{
  "data": [
    {
      "kind": "collection",
      "eventId": "uuid-collection",
      "occurredAt": "2026-11-26T18:02:11.000Z",
      "amountCents": 120000,
      "tenderedCents": 140000,
      "changeDueCents": 20000,
      "payments": [
        { "method": "card_debit", "amountCents": 60000, "catalog": null },
        { "method": "cash", "amountCents": 80000, "catalog": null }
      ],
      "sales": [
        { "saleId": "uuid", "folio": "V-000123", "status": "CONFIRMED", "appliedCents": 30000 },
        { "saleId": "uuid", "folio": "V-000124", "status": "CANCELED", "appliedCents": 90000 }
      ],
      "cashier": { "id": "uuid", "name": "María" },
      "receiptPath": "/collections/uuid-collection/pdf"
    },
    {
      "kind": "payment",
      "eventId": "uuid-payment",
      "occurredAt": "2026-11-20T19:31:02.000Z",
      "method": "cash",
      "catalog": null,
      "reference": null,
      "amountCents": 45000,
      "tenderedCents": 50000,
      "changeCents": 5000,
      "sale": { "id": "uuid", "folio": "V-000140", "status": "CONFIRMED", "totalCents": 45000 },
      "cashier": { "id": "uuid", "name": "Luis" },
      "receiptPath": "/sales/uuid/pdf"
    }
  ],
  "pagination": { "page": 1, "limit": 50, "total": 37, "totalPages": 1 }
}
```

### Order and pagination

- Events are sorted by `occurredAt` desc, then `eventId` desc (byte order). This is a total order, so pages are stable. A payment that arrives between two page reads shifts later pages by one, as in every offset list.
- `pagination` is the same object as `GET /sales`. `total` counts **events**, not payment rows. `totalPages` is `0` when `total` is `0`.
- A page past the end returns `data: []` with the real totals.

### `collection` events

| Field | Meaning |
|---|---|
| `eventId` | the collection id |
| `occurredAt` | when the «Cobrar todo» was made |
| `amountCents` | money kept by the sales (the collection's `appliedCents`) |
| `tenderedCents`, `changeDueCents` | as stored on the collection |
| `payments` | the tenders, same shape and values as `GET /collections/:id` `payments`: `method` lowercase, `amountCents` tendered (cash includes the change), `catalog` `{paymentMethodId, name, subtitle?}` or `null` |
| `sales` | the sales that received money, in the same order as `GET /collections/:id`. `status` is the sale's **current** status, `appliedCents` what this collection paid on it |
| `cashier` | the user who made the collection, `{id, name}`, or `null` if the user no longer exists |
| `receiptPath` | `/collections/:id/pdf`. Always present, also when a sale was canceled later |

### `payment` events

| Field | Meaning |
|---|---|
| `eventId` | the payment id |
| `occurredAt` | when the payment was recorded |
| `method` | lowercase: `cash`, `card_credit`, `card_debit`, `transfer` |
| `catalog` | the custom payment method snapshot `{paymentMethodId, name, subtitle?}` when valid, else `null` |
| `reference` | the stored reference (legacy rows: the old metadata reference, like `GET /sales/:id`), or `null` |
| `amountCents` | **net** amount: `tenderedCents − changeCents`. Show this one by default |
| `tenderedCents` | amount stored for the payment (cash includes the change) |
| `changeCents` | this payment's share of the change returned at the sale's charge |
| `sale` | `{id, folio, status, totalCents}`; `status` is the **current** status |
| `cashier` | the user who recorded the payment, `{id, name}`, or `null` (payment recorded without a user, or the user no longer exists) |
| `receiptPath` | `/sales/:id/pdf`, or `null` when the sale is no longer `CONFIRMED` (the sale PDF would answer `400 SALE_NOT_CONFIRMED`) |

The change rule is the one of the customer statement PDF: a sale stores its change once, and it is taken from the sale's cash payments in payment order. A payment's `amountCents`, `tenderedCents` and `changeCents` are therefore identical to that payment's row in the statement PDF. Card and transfer payments always have `changeCents: 0`.

### Receipts

`receiptPath` is a relative API path. Build the URL with the API base and append `?format=`. The formats differ per route:

| Kind | Route | `format` |
|---|---|---|
| `collection` | `GET /collections/:id/pdf` | `ticket` (default) or `a4` |
| `payment` | `GET /sales/:id/pdf` | `receipt-a4` (default) or `receipt-ticket` |

Both routes require `read:Sale`.

### Canceled sales and refunds

- Payments of sales canceled later **stay** in the feed: the money was received. They are flagged with `sale.status: "CANCELED"` (or the `status` inside `sales[]`). The UI can show «Venta cancelada».
- Refunds are **not** in the feed: no negative events, and amounts are not netted. Do not present the feed as a balance.
- Sales without a customer, or of another customer, never appear. A deleted customer's sales lose the customer, so their payments leave the feed.

## Errors

| HTTP | Body | When |
|---|---|---|
| 400 | `Validation failed (uuid is expected)` | `:customerId` is not a UUID |
| 400 | standard per-field validation body | `page` < 1 or not an integer; `limit` outside 1–100 or not an integer; unknown query parameter |
| 401 | standard | missing or invalid token |
| 403 | `INSUFFICIENT_PERMISSIONS` | the caller lacks `read:Sale` (hide the tab) |
| 404 | `{ "statusCode": 404, "error": "CUSTOMER_NOT_FOUND", "message": "CUSTOMER_NOT_FOUND" }` | unknown customer, or a customer of another tenant |
