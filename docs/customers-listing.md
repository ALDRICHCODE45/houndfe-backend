# Customers listing — `GET /customers/listing`

The paginated customers table with per-customer sales metrics. It is the
implementation of `docs/proposals/customers-list-contract.md` §2, §2.1, §2.2,
§3, §4.6, §10, §10.1, §11 and §13.

**Status:** the core is implemented: the row, metrics, pagination, sorting,
`search` and the permission modes. The §4.1–§4.5 filters and the
`/customers/listing/options` selector endpoint are **not implemented yet**.
Sending one of their parameters returns `400` because it is an unknown
parameter.

`GET /customers` (the POS and checkout picker) has not changed. It keeps the
same route, query, flat-array shape and order.

## Request

`GET /customers/listing?page=&limit=&sortBy=&sortOrder=&search=`

| Param | Type | Default | Notes |
|---|---|---|---|
| `page` | integer ≥ 1 | `1` | A page past the end returns `data: []` with the real totals |
| `limit` | integer 1–100 | `50` | |
| `sortBy` | `name` \| `openDebt` \| `oldestOverdue` \| `lastPurchaseAt` \| `totalSold` \| `salesCount` \| `averageTicket` \| `createdAt` | `createdAt` | Metric keys need `read:Sale` (see Permissions) |
| `sortOrder` | `asc` \| `desc` | `desc` | |
| `search` | string | — | Same rule as `GET /customers?search=` (below) |

Any other parameter returns `400`. This includes `preferredPaymentMethod`,
which is not a filter.

### Sorting

| `sortBy` | Sorts by |
|---|---|
| `name` | `lower(firstName)`, then `lower(lastName)`, using the database collation |
| `openDebt` | `metrics.openDebtCents` |
| `oldestOverdue` | `metrics.oldestOverdueDueDate` (`asc` = longest overdue first) |
| `lastPurchaseAt` | `metrics.lastPurchaseAt` |
| `totalSold` | `metrics.totalSoldCents` |
| `salesCount` | `metrics.salesCount` |
| `averageTicket` | `metrics.averageTicketCents` |
| `createdAt` | `createdAt` («Alta») |

- `null` values always sort **last**, in both directions. For example, customers
  without sales come last on `averageTicket`, `lastPurchaseAt` and
  `oldestOverdue`.
- The final tie-breaker is `id`, in the same direction as `sortOrder`, so
  pages are stable.

### `search`

`search` works exactly like `GET /customers`:

- The term is trimmed and cut to 100 characters.
- A customer matches when each of the first 6 words appears (case-insensitive
  `contains`) in `firstName`, `lastName`, `email`, `phone` or `businessName`.
- A customer also matches when the whole term appears in the accent-folded
  name of one of their **ACTIVE** pets.
- `%`, `_` and `\` are literal.
- An empty or blank term means no search.
- A repeated `?search=a&search=b` returns `400` here (`GET /customers` treats it
  as a term that matches nothing).

## Response `200`

```json
{
  "data": [
    {
      "id": "uuid",
      "firstName": "Ana",
      "lastName": "López",
      "businessName": null,
      "phoneCountryCode": "52",
      "phone": "5512345678",
      "email": "ana@example.com",
      "globalPriceList": { "id": "uuid", "name": "Mayoreo" },
      "rfc": "LOAA800101XXX",
      "fiscalRegime": "612",
      "preferredPaymentMethod": "transferencia",
      "isTrusted": false,
      "createdAt": "2026-03-02T17:04:11.000Z",
      "primaryAddress": { "id": "uuid", "neighborhood": "Del Valle", "municipality": "Benito Juárez", "city": "Ciudad de México", "state": "Ciudad de México", "zipCode": "03100" },
      "activePetsCount": 2,
      "petSpecies": ["DOG", "CAT"],
      "matchedPetName": null,
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
  ],
  "pagination": { "page": 1, "limit": 50, "total": 312, "totalPages": 7 },
  "filterSummary": { "count": 312, "openDebtCents": 4580000, "overdueDebtCents": 1210000 }
}
```

### Row fields

- The customer fields come from the same columns as `GET /customers`.
  `phone` is unmasked.
- `isTrusted` is read-only on this route.
- `primaryAddress` is the customer's **oldest** address (`createdAt` asc, then
  `id` asc), or `null` when the customer has no address. For the full address
  list, `comments` and the billing data, use `GET /customers/:id`.
- `activePetsCount` counts the ACTIVE pets only.
- `petSpecies` lists the distinct species of the ACTIVE pets, in the order
  `DOG`, `CAT`, `OTHER`. It is `[]` when there are none.
- `matchedPetName` is the name of the matching pet when the customer matched
  `search` **only** through a pet (the first by name). Otherwise it is `null`.
- `metrics` is present only for callers with `read:Sale` (see Permissions).

### Metrics

The metrics are computed over the customer's **CONFIRMED** sales from any
channel. This is the same set as the `GET /sales` `summary`. Canceled and
draft sales never count, and neither do sales without a customer.

| Metric | Definition | No sales |
|---|---|---|
| `salesCount` | number of sales | `0` |
| `totalSoldCents` | Σ `totalCents` (refunds not subtracted) | `0` |
| `openDebtCents` | Σ open debt (= `GET /sales` `summary.outstandingDebtCents`) | `0` |
| `overdueCount` | sales with open debt > 0 whose due day is before today's local date | `0` |
| `overdueDebtCents` | Σ open debt of those sales | `0` |
| `oldestOverdueDueDate` | `YYYY-MM-DD` of the oldest overdue due date | `null` |
| `averageTicketCents` | `round(totalSoldCents / salesCount)`, half up | **`null`** |
| `lastPurchaseAt` | latest `confirmedAt`, ISO instant | `null` |

- «Overdue» follows the same rule as `GET /sales`. The due day is the date
  shown on the sale. A sale becomes overdue at local midnight
  (`PROMOTIONS_BUSINESS_TIMEZONE`, default America/Mexico_City) after its due
  day. A sale due today is not overdue yet.
- `GET /sales` returns `summary.averageTicketCents = 0` when there are no
  sales. This route returns `null`, on purpose.

### `pagination` and `filterSummary`

- `pagination` has the same shape as `GET /sales`. `total` counts every
  matching customer, and `totalPages` is `0` when `total` is `0`.
- `filterSummary` totals **every matching customer**, not just the page:
  `count === pagination.total`. The sums are `0` when nothing matches.

## Permissions

| Permission | Effect |
|---|---|
| no `read:Customer` | `403 INSUFFICIENT_PERMISSIONS` |
| `read:Customer` + `read:Sale` | full response |
| `read:Customer` without `read:Sale` | still `200`, with the changes below |

When the caller does not have `read:Sale`:

- The rows have **no `metrics` key**. The key is absent, not `null`. Type it as
  `metrics?:`.
- `filterSummary` is `{ "count": n }` only.
- A metric sort (`sortBy` = `openDebt`, `oldestOverdue`, `lastPurchaseAt`,
  `totalSold`, `salesCount` or `averageTicket`) is rejected with this body:

  ```json
  { "statusCode": 400, "code": "LISTING_PARAM_REQUIRES_PERMISSION", "message": "sortBy requires read:Sale", "field": "sortBy", "details": { "required": "read:Sale" } }
  ```

  When the metric filters of §4.1–§4.2 ship, they will return the same error.
  `field` will be the first offending filter, and `sortBy` comes after every
  filter. Validation runs first, so a malformed value (for example
  `limit=500`) still gets its normal `400`.
- `search`, `page`, `limit` and the `name` / `createdAt` sorts work as usual.

## Errors

| HTTP | Body / code | When |
|---|---|---|
| 400 | standard per-field validation body | `page` < 1, `limit` outside 1–100, unknown `sortBy`/`sortOrder`, unknown parameter, non-string `search` |
| 400 | `LISTING_PARAM_REQUIRES_PERMISSION` | a metric sort without `read:Sale` |
| 403 | `INSUFFICIENT_PERMISSIONS` | no `read:Customer` |
