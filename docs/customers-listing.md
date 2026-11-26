# Customers listing — `GET /customers/listing`

The paginated customers table with per-customer sales metrics. It is the
implementation of `docs/proposals/customers-list-contract.md` §2, §2.1, §2.2,
§3, §4, §5, §10, §10.1, §11 and §13.

**Status:** implemented: the row, metrics, pagination, sorting, `search`, the
§4.1–§4.5 filters, the permission modes and the selector endpoint
`GET /customers/listing/options` (see [Selector values](#selector-values--get-customerslistingoptions)).

`GET /customers` (the POS and checkout picker) has not changed. It keeps the
same route, query, flat-array shape and order.

## Request

`GET /customers/listing?page=&limit=&sortBy=&sortOrder=&search=&<filters>`

| Param | Type | Default | Notes |
|---|---|---|---|
| `page` | integer ≥ 1 | `1` | A page past the end returns `data: []` with the real totals |
| `limit` | integer 1–100 | `50` | |
| `sortBy` | `name` \| `openDebt` \| `oldestOverdue` \| `lastPurchaseAt` \| `totalSold` \| `salesCount` \| `averageTicket` \| `createdAt` | `createdAt` | Metric keys need `read:Sale` (see Permissions) |
| `sortOrder` | `asc` \| `desc` | `desc` | |
| `search` | string | — | Same rule as `GET /customers?search=` (below) |

Plus the filters below. Any other parameter returns `400`. This includes
`preferredPaymentMethod`, which is not a filter.

### Filters

General rules (shared listing conventions, `src/shared/listing/README.md`):

- **AND** between filters, **OR** inside a CSV filter (`?petSpecies=DOG,CAT`).
  CSV values are trimmed and deduplicated; an empty CSV (`?city=`) is no
  filter.
- Bounds are inclusive. Money is in cents. `*Min`/`*Max` must be integers
  ≥ 0.
- Booleans accept only the exact strings `true` and `false`.
- Instants are ISO strings, compared as instants (like `GET /sales`
  `confirmedFrom/To` and `dueDateFrom/To`).
- `N`-day filters take integers 1–3650 and count from today's **local** date
  (`PROMOTIONS_BUSINESS_TIMEZONE`, default America/Mexico_City).
- Contradictory filters (`hasDebt=false&openDebtMin=100`) are not errors; they
  match nothing.
- `pagination.total` and `filterSummary` always reflect every filter.

Params marked **M** are metric params: they need `read:Sale` (see
Permissions).

#### Deuda (all M)

| Param | Matches |
|---|---|
| `hasDebt=true\|false` | `openDebtCents > 0` / `= 0` |
| `openDebtMin`, `openDebtMax` | range on `openDebtCents` |
| `hasOverdue=true\|false` | `overdueCount > 0` / `= 0` |
| `overdueMoreThanDays=N` | at least one sale overdue by **strictly more than** N days: the oldest overdue due day is before `localToday − N`. For N = 30 on 26/11, a sale due 26/10 (31 days) matches and one due 27/10 (30 days) does not |
| `oldestOverdueFrom`, `oldestOverdueTo` | range on the oldest overdue `dueDate` (instants) |

#### Compras

| Param | Matches | M |
|---|---|---|
| `totalSoldMin`, `totalSoldMax` | range on `totalSoldCents` | M |
| `salesCountMin`, `salesCountMax` | range on `salesCount` | M |
| `averageTicketMin`, `averageTicketMax` | range on `averageTicketCents`. Customers without sales (average `null`) never match | M |
| `lastPurchaseFrom`, `lastPurchaseTo` | range on `lastPurchaseAt` | M |
| `noPurchaseMoreThanDays=N` | never bought (no CONFIRMED sale), **or** the local date of the last purchase is before `localToday − N` | M |
| `createdFrom`, `createdTo` | range on `createdAt` («Alta») | — |

#### Mascotas (ACTIVE pets only)

| Param | Matches |
|---|---|
| `petSpecies=DOG,CAT,OTHER` | an ACTIVE pet of one of these species |
| `petSize=SMALL,MEDIUM,LARGE,GIANT` | an ACTIVE pet of one of these sizes. Pets without a size never match |
| `activePetsMin`, `activePetsMax` | range on `activePetsCount` |
| `hasPets=true\|false` | `activePetsCount > 0` / `= 0` |

When `petSpecies` and `petSize` are both sent, **the same pet** must match
both: «perro grande» does not match a customer with a small dog and a large
cat. Archived pets never count.

#### Ubicación (any address)

| Param | Matches |
|---|---|
| `neighborhood`, `municipality`, `city`, `zipCode` | CSV, max 200 values each. An address whose value equals one of them, trimmed and case-insensitive (exact, not `contains`; no accent folding) |
| `deliveryZoneType=FREE,SURCHARGE,CARRIER_ONLY,DENIED` | an address whose trimmed ZIP code has an **active** delivery zone of the tenant with one of these types |
| `deliveryZoneNone=true` | an address with a non-empty ZIP code that has no active zone («sin zona»). `false` = no filter |

- A customer matches when **any** of their addresses matches. A customer
  without addresses never matches a location filter.
- When several location params are sent, they must all hold on the **same
  address** (`neighborhood=Narvarte&zipCode=03100` needs one address with
  both).
- `deliveryZoneType` and `deliveryZoneNone` together form one zone filter:
  `deliveryZoneType=FREE&deliveryZoneNone=true` = «gratis o sin zona».
- There are no named zones; zone ZIP codes are listed by
  `GET /delivery-zones`.
- When any location filter is active, every row carries
  **`matchedAddressId`**: the customer's oldest address that matches. It
  explains rows whose `primaryAddress` shows another colonia. Without a
  location filter the key is absent.

#### Comercial y contacto

| Param | Matches |
|---|---|
| `priceListId=<uuid,…>` | `globalPriceList` is one of these. `priceListIncludeNull=true` adds customers without a list (alone: only customers without a list) |
| `isTrusted=true\|false` | `isTrusted` |
| `hasRfc=true\|false` | RFC set / empty (null or blank) |
| `fiscalRegime=601,612,…` | CSV over the SAT list (`FISCAL_REGIMES`) |
| `hasEmail=true\|false`, `hasPhone=true\|false` | email / phone set or empty («sin correo», «sin teléfono») |
| `hasChatbotRequests=true\|false` | at least one chatbot request linked to the customer, **any status** |

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
- `matchedAddressId` is present only when a location filter is active (see
  Ubicación). It comes right after `matchedPetName`.
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
- A metric filter (`hasDebt`, `openDebtMin`, `openDebtMax`, `hasOverdue`,
  `overdueMoreThanDays`, `oldestOverdueFrom`, `oldestOverdueTo`,
  `totalSoldMin`, `totalSoldMax`, `salesCountMin`, `salesCountMax`,
  `averageTicketMin`, `averageTicketMax`, `lastPurchaseFrom`,
  `lastPurchaseTo`, `noPurchaseMoreThanDays`) or a metric sort (`sortBy` =
  `openDebt`, `oldestOverdue`, `lastPurchaseAt`, `totalSold`, `salesCount` or
  `averageTicket`) is rejected with this body:

  ```json
  { "statusCode": 400, "code": "LISTING_PARAM_REQUIRES_PERMISSION", "message": "openDebtMin requires read:Sale", "field": "openDebtMin", "details": { "required": "read:Sale" } }
  ```

  `field` is the first offending filter, in the order listed above, and
  `sortBy` comes after every filter. A metric filter sent as `false` is still
  a metric param. Validation runs first, so a malformed value (for example
  `limit=500` or `openDebtMin=-1`) still gets its normal `400`.
- `search`, `page`, `limit`, `createdFrom/To`, the pet, location and
  commercial filters and the `name` / `createdAt` sorts work as usual.

## Errors

| HTTP | Body / code | When |
|---|---|---|
| 400 | standard per-field validation body | `page` < 1, `limit` outside 1–100, unknown `sortBy`/`sortOrder`, unknown parameter (including `preferredPaymentMethod`), non-string `search`, a boolean other than `true`/`false`, an `N`-day value outside 1–3650 or not an integer; options: `field` missing/unknown, `limit` outside 1–200, `q` over 100 characters |
| 400 | `LISTING_INVALID_NUMBER` | a `*Min`/`*Max` bound that is not a number, negative, or not an integer |
| 400 | `LISTING_INVERTED_RANGE` | `*Min` > `*Max` or `*From` > `*To`; `field` is the range name (`openDebt`, `totalSold`, `salesCount`, `averageTicket`, `activePets`, `oldestOverdue`, `lastPurchase`, `created`) |
| 400 | `LISTING_INVALID_DATE` | a `*From`/`*To` that is not a valid date |
| 400 | `LISTING_INVALID_ENUM_VALUE` | `petSpecies`, `petSize`, `fiscalRegime`, `deliveryZoneType` (`details.allowed` lists the values) |
| 400 | `LISTING_TOO_MANY_VALUES` | more than 50 enum values or 200 text/UUID values (`details.cap`) |
| 400 | `LISTING_INVALID_UUID` | `priceListId` |
| 400 | `LISTING_PARAM_REQUIRES_PERMISSION` | a metric filter or sort without `read:Sale` |
| 403 | `INSUFFICIENT_PERMISSIONS` | no `read:Customer` |

The listing codes use the envelope
`{statusCode, code, message, field, details?}`.

## Selector values — `GET /customers/listing/options`

`GET /customers/listing/options?field=<field>&q=<text>&limit=<n>`, permission
`read:Customer` (no `read:Sale` needed).

| Param | Type | Default | Notes |
|---|---|---|---|
| `field` | `neighborhood` \| `municipality` \| `city` \| `zipCode` \| `fiscalRegime` | required | The four location fields read **any** address; `fiscalRegime` reads the customers |
| `q` | string ≤ 100 | — | Case-insensitive `contains` on the trimmed value. Blank = no filter |
| `limit` | integer 1–200 | `50` | |

```json
{ "field": "neighborhood", "data": [ { "value": "Del Valle", "customersCount": 41 } ] }
```

- Values are trimmed and grouped by `lower(value)`; blank values are skipped.
- `value` is the group's most frequent spelling (by customers; a tie takes the
  lowest spelling). Sending it in the matching filter matches the whole group,
  because the filter is trimmed and case-insensitive.
- `customersCount` counts distinct customers of the tenant (a customer with
  two addresses in the same colonia counts once).
- Sorted by `customersCount` desc, then `value`.
- `fiscalRegime` returns only the SAT codes in use (`FISCAL_REGIMES`). The
  full fixed SAT list works as well.
- There is no option endpoint for the zone (`deliveryZoneType` is the fixed
  enum `FREE`, `SURCHARGE`, `CARRIER_ONLY`, `DENIED`, plus
  `deliveryZoneNone=true`) and none for `preferredPaymentMethod` (not a
  filter). Both values return `400`.
- Only the caller's tenant is read.
