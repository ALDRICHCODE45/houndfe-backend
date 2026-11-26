# 31 — Customers module: table with metrics and filters, «Cliente de confianza», KPI strip, «Cobros y recibos» feed

**Status:** implemented on branch `feat/customers-listing` (3cfe56a6 contract, 6bd81dfa payments feed, 15476114 listing core, 81a73364 `isTrusted` + sales-summary, f9792e3b filters + options); merge to local `main` pending. Task: `odd/tasks/customers-listing.md`. Contract: `docs/proposals/customers-list-contract.md` v1 (owner OK 2026-11-26) plus the frontend answers of 2026-11-26. Migration: `20261126110000_customers_listing_sales_index` (additive indexes only: `sales_tenant_customer_confirmed_idx` on `sales`, `customer_addresses_tenant_customer_created_idx` on `customer_addresses`; no table or column changes).

Owner decisions (2026-11-26): Q4 «Sumar un interruptor editable» (`isTrusted` editable, column and filter), Q5 primary address = the oldest one, no migration, Q10 «Todos los pagos del cliente» (payments feed, refunds later), Q11 «La tabla sin deuda ni compras» (200 without `metrics`, metric params rejected, no 403), Q12 `preferredPaymentMethod` is not a filter (it stays a row field).

Frontend decisions (2026-11-26): Q1 `GET /customers/:customerId/sales-summary` with the table rules, Q2 `averageTicketCents: null` without sales, Q3 `oldestOverdueDueDate` as `YYYY-MM-DD`, Q6 `overdueMoreThanDays` strict (day 31+ for N = 30), Q7 species and size on the same pet, Q8 location over any address, no switch, Q9 chatbot requests of any status, Q13 `limit` default 50, max 100. Feed answers: net amount by default (tendered − change), relative `receiptPath` with per-route formats, `method` lowercase in both event kinds.

Shapes come from the code: `src/customers/listing/**`, `src/customers/customers.controller.ts`, `src/customers/customers.service.ts`, `src/customers/dto/update-customer.dto.ts`, `src/customers/domain/customer.entity.ts`, `src/sales/customer-payments*`, `src/sales/dto/customer-payments.dto.ts`, `src/sales/customer-sales-summary*`. All amounts are integer cents.

## 1. Routes

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/customers/listing` | `read:Customer` (+ `read:Sale` for metrics, §2.6) | The customers table: rows, metrics, filters, sorting, totals |
| GET | `/customers/listing/options?field=…` | `read:Customer` | Values for the colonia / municipio / ciudad / CP / régimen selectors |
| GET | `/customers/:id` | `read:Customer` (unchanged) | Customer detail, now with `isTrusted` |
| PATCH | `/customers/:id` | `update:Customer` (unchanged) | Now also accepts `isTrusted` |
| GET | `/customers/:customerId/sales-summary` | `read:Sale` | KPI strip of the customer page |
| GET | `/customers/:customerId/payments?page=&limit=` | `read:Sale` | «Cobros y recibos» feed |
| GET | `/quotations?customerId=<uuid>` | `read:Quotation` (unchanged, EXISTS) | «Cotizaciones» tab |

- Path ids must be UUIDs. Anything else gets the Nest `400` body `Validation failed (uuid is expected)` (`ParseUUIDPipe`).
- Unknown query parameters get `400` on every new route (`forbidNonWhitelisted`).
- «Notas» on the customer page is `Customer.comments` (existing field of `GET`/`PATCH /customers/:id`).

## 2. `GET /customers/listing`

### 2.1 Request

| Param | Type | Default | Notes |
|---|---|---|---|
| `page` | integer ≥ 1 | `1` | A page past the end returns `data: []` with the real totals |
| `limit` | integer 1–100 | `50` | |
| `sortBy` | `name` \| `openDebt` \| `oldestOverdue` \| `lastPurchaseAt` \| `totalSold` \| `salesCount` \| `averageTicket` \| `createdAt` | `createdAt` | Every key except `name` and `createdAt` is a metric sort (§2.6) |
| `sortOrder` | `asc` \| `desc` | `desc` | |
| `search` | string | — | Same rule as `GET /customers?search=` (§2.4) |

Plus the filters of §2.3. `preferredPaymentMethod` is **not** a parameter: sending it gets `400`.

### 2.2 Response `200`

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

TypeScript shape of a row:

```ts
interface CustomerListingRow {
  id: string;
  firstName: string;
  lastName: string | null;
  businessName: string | null;
  phoneCountryCode: string | null;
  phone: string | null;
  email: string | null;
  globalPriceList: { id: string; name: string } | null;
  rfc: string | null;
  fiscalRegime: string | null;
  preferredPaymentMethod: string | null;
  isTrusted: boolean;
  createdAt: string;                      // ISO instant
  primaryAddress: {
    id: string;
    neighborhood: string | null;
    municipality: string | null;
    city: string | null;
    state: string | null;
    zipCode: string | null;
  } | null;
  activePetsCount: number;
  petSpecies: Array<'DOG' | 'CAT' | 'OTHER'>;
  matchedPetName: string | null;
  matchedAddressId?: string;              // only with a location filter (§2.3.4)
  metrics?: CustomerSalesMetrics;         // absent without read:Sale (§2.6)
}

interface CustomerSalesMetrics {
  openDebtCents: number;
  overdueDebtCents: number;
  overdueCount: number;
  oldestOverdueDueDate: string | null;    // 'YYYY-MM-DD'
  salesCount: number;
  totalSoldCents: number;
  averageTicketCents: number | null;
  lastPurchaseAt: string | null;          // ISO instant
}
```

**Row fields:**

- The customer fields come from the same columns as `GET /customers`. `phone` is unmasked.
- `isTrusted` is read-only here; change it with `PATCH /customers/:id` (§4).
- `primaryAddress` is the customer's **oldest** address (`createdAt` asc, then `id` asc), or `null` when there is none. For the full address list, `comments` and billing data use `GET /customers/:id`.
- `activePetsCount` counts ACTIVE pets only. `petSpecies` lists the distinct species of the ACTIVE pets in the order `DOG`, `CAT`, `OTHER`; `[]` when there are none.
- `matchedPetName` is the pet's name when the customer matched `search` **only** through a pet; otherwise `null`.
- `matchedAddressId` is present only when a location filter is active (§2.3.4). Without one the key is absent.
- `metrics` is present only when the caller has `read:Sale` (§2.6). The key is absent, not `null`.

**Metrics** are computed over the customer's **CONFIRMED** sales from any channel (the same set as the `GET /sales` `summary`). Canceled and draft sales never count, and a sale stops counting as soon as it is canceled.

| Metric | Definition | No sales |
|---|---|---|
| `salesCount` | number of sales | `0` |
| `totalSoldCents` | Σ `totalCents` (refunds not subtracted) | `0` |
| `openDebtCents` | Σ open debt (= `GET /sales` `summary.outstandingDebtCents`) | `0` |
| `overdueCount` | sales with open debt > 0 whose due day is before today's local date | `0` |
| `overdueDebtCents` | Σ open debt of those sales | `0` |
| `oldestOverdueDueDate` | `YYYY-MM-DD` of the oldest overdue due date (the same string as `GET /sales` `summary.oldestOverdueDueDate`) | `null` |
| `averageTicketCents` | `round(totalSoldCents / salesCount)`, half up | **`null`** |
| `lastPurchaseAt` | latest `confirmedAt`, ISO instant | `null` |

- «Vencida» is the `GET /sales` rule: CONFIRMED, open debt > 0, due day before today's local date (`PROMOTIONS_BUSINESS_TIMEZONE`, default America/Mexico_City). A sale due today is not overdue until local midnight.
- `GET /sales` `summary.averageTicketCents` is `0` with no sales; this route returns `null`, on purpose.

**`pagination` and `filterSummary`:**

- `pagination` is the `GET /sales` object. `total` counts every matching customer; `totalPages` is `0` when `total` is `0`.
- `filterSummary` totals **every matching customer**, not just the page. `count === pagination.total`. The sums are `0` when nothing matches.
- Without `read:Sale`, `filterSummary` is `{ "count": n }` only.

### 2.3 Filters

General rules:

- **AND** between filters, **OR** inside a CSV filter (`?petSpecies=DOG,CAT`). CSV values are trimmed and deduplicated. An empty CSV (`?city=`) is no filter.
- Bounds are inclusive. Money is in cents. `*Min` / `*Max` must be integers ≥ 0.
- Booleans accept only the exact strings `true` and `false`.
- `*From` / `*To` are ISO strings compared as instants (like `GET /sales` `confirmedFrom/To`).
- `N`-day filters take integers 1–3650 and count from today's **local** date.
- Contradictory filters (`hasDebt=false&openDebtMin=100`) are not errors; they match nothing.

Params marked **M** are metric params: they need `read:Sale` (§2.6).

#### 2.3.1 Deuda (all M)

| Param | Matches |
|---|---|
| `hasDebt=true\|false` | `openDebtCents > 0` / `= 0` |
| `openDebtMin`, `openDebtMax` | range on `openDebtCents` |
| `hasOverdue=true\|false` | `overdueCount > 0` / `= 0` |
| `overdueMoreThanDays=N` | at least one sale overdue by **strictly more than** N days: the oldest overdue due day is before `localToday − N`. For N = 30 on 26/11, a sale due 26/10 (31 days) matches and one due 27/10 (30 days) does not |
| `oldestOverdueFrom`, `oldestOverdueTo` | range on the oldest overdue `dueDate` (instants) |

#### 2.3.2 Compras

| Param | Matches | M |
|---|---|---|
| `totalSoldMin`, `totalSoldMax` | range on `totalSoldCents` | M |
| `salesCountMin`, `salesCountMax` | range on `salesCount` | M |
| `averageTicketMin`, `averageTicketMax` | range on `averageTicketCents`. Customers without sales (average `null`) never match | M |
| `lastPurchaseFrom`, `lastPurchaseTo` | range on `lastPurchaseAt` | M |
| `noPurchaseMoreThanDays=N` | never bought (no CONFIRMED sale), **or** the local date of the last purchase is before `localToday − N` | M |
| `createdFrom`, `createdTo` | range on `createdAt` («Alta») | — |

#### 2.3.3 Mascotas (ACTIVE pets only)

| Param | Matches |
|---|---|
| `petSpecies=DOG,CAT,OTHER` | an ACTIVE pet of one of these species |
| `petSize=SMALL,MEDIUM,LARGE,GIANT` | an ACTIVE pet of one of these sizes. Pets without a size never match |
| `activePetsMin`, `activePetsMax` | range on `activePetsCount` |
| `hasPets=true\|false` | `activePetsCount > 0` / `= 0` |

When `petSpecies` and `petSize` are both sent, **the same pet** must match both: «perro grande» does not match a customer with a small dog and a large cat. Archived pets never count.

#### 2.3.4 Ubicación (any address)

| Param | Matches |
|---|---|
| `neighborhood`, `municipality`, `city`, `zipCode` | CSV, max 200 values each. An address whose value equals one of them, trimmed and case-insensitive. Exact match, not `contains`; no accent folding |
| `deliveryZoneType=FREE,SURCHARGE,CARRIER_ONLY,DENIED` | an address whose trimmed ZIP code has an **active** delivery zone of the branch with one of these types |
| `deliveryZoneNone=true` | an address with a non-empty ZIP code that has no active zone («sin zona»). `deliveryZoneNone=false` is no filter |

Interpretations (decided in the implementation, pinned by tests):

- A customer matches when **any** of their addresses matches. A customer without addresses never matches a location filter.
- **Several location params must all hold on ONE address.** `neighborhood=Narvarte&zipCode=03100` needs one address with both; a customer with Narvarte on one address and 03100 on another does not match.
- **`deliveryZoneType` OR `deliveryZoneNone`.** Together they form one zone filter: `deliveryZoneType=FREE&deliveryZoneNone=true` = «gratis o sin zona» (still on the same address as the other location params).
- There are no named zones. Zone ZIP codes are listed by `GET /delivery-zones`.
- With any location filter active, every row carries **`matchedAddressId`**: the customer's oldest address that satisfies every active location filter. It explains rows whose `primaryAddress` shows another colonia.

#### 2.3.5 Comercial y contacto

| Param | Matches |
|---|---|
| `priceListId=<uuid,…>` | `globalPriceList.id` is one of these (max 200) |
| `priceListIncludeNull=true\|false` | `true` adds customers without a price list to `priceListId`. **Sent alone, it lists only the customers without a price list.** `false` is no filter |
| `isTrusted=true\|false` | `isTrusted` |
| `hasRfc=true\|false` | RFC set / empty (null or blank) |
| `fiscalRegime=601,612,…` | CSV over the SAT list `FISCAL_REGIMES` |
| `hasEmail=true\|false`, `hasPhone=true\|false` | email / phone set or empty (null or blank): «sin correo», «sin teléfono» |
| `hasChatbotRequests=true\|false` | at least one chatbot request linked to the customer, **any status** |

### 2.4 `search`

The same rule as `GET /customers?search=`:

- The term is trimmed and cut to 100 characters. Blank = no search.
- A customer matches when each of the first 6 words appears (case-insensitive `contains`) in `firstName`, `lastName`, `email`, `phone` or `businessName`, **or** when the whole term appears in the accent-folded name of one of their **ACTIVE** pets (then `matchedPetName` is set).
- `%`, `_` and `\` are literal.
- A repeated `?search=a&search=b` gets `400` here (`GET /customers` treats it as a term that matches nothing).

### 2.5 Sorting

| `sortBy` | UI | Sorts by | M |
|---|---|---|---|
| `name` | Nombre | `lower(firstName)`, then `lower(lastName)` (database collation) | — |
| `openDebt` | Deuda | `metrics.openDebtCents` | M |
| `oldestOverdue` | Vencido desde | `metrics.oldestOverdueDueDate` (`asc` = longest overdue first) | M |
| `lastPurchaseAt` | Última compra | `metrics.lastPurchaseAt` | M |
| `totalSold` | Total comprado | `metrics.totalSoldCents` | M |
| `salesCount` | Compras | `metrics.salesCount` | M |
| `averageTicket` | Ticket promedio | `metrics.averageTicketCents` | M |
| `createdAt` | Alta | `createdAt` | — |

- `null` values always sort **last**, in both directions (customers without sales come last on `averageTicket`, `lastPurchaseAt`, `oldestOverdue`).
- The final tie-breaker is `id`, in the `sortOrder` direction, so pages are stable.

### 2.6 Without `read:Sale`

| Caller | Result |
|---|---|
| no `read:Customer` | `403 INSUFFICIENT_PERMISSIONS` |
| `read:Customer` + `read:Sale` | full response |
| `read:Customer` without `read:Sale` | still **`200`**, with the changes below |

- Rows have **no `metrics` key** (absent, not `null`). Type it as `metrics?:`.
- `filterSummary` is `{ "count": n }` only.
- `search`, `page`, `limit`, `createdFrom/To`, the pet, location and commercial filters and the `name` / `createdAt` sorts work as usual.
- A **metric param** is rejected with `400 LISTING_PARAM_REQUIRES_PERMISSION`. The metric params are exactly:
  - **filters**, in this order: `hasDebt`, `openDebtMin`, `openDebtMax`, `hasOverdue`, `overdueMoreThanDays`, `oldestOverdueFrom`, `oldestOverdueTo`, `totalSoldMin`, `totalSoldMax`, `salesCountMin`, `salesCountMax`, `averageTicketMin`, `averageTicketMax`, `lastPurchaseFrom`, `lastPurchaseTo`, `noPurchaseMoreThanDays`;
  - **sorts:** `sortBy` = `openDebt`, `oldestOverdue`, `lastPurchaseAt`, `totalSold`, `salesCount`, `averageTicket`.

```json
{ "statusCode": 400, "code": "LISTING_PARAM_REQUIRES_PERMISSION", "message": "openDebtMin requires read:Sale", "field": "openDebtMin", "details": { "required": "read:Sale" } }
```

- `field` is the **first** offending filter in the order above; `sortBy` comes after every filter (`field: "sortBy"`).
- A metric filter sent as `false` (`hasDebt=false`) is still a metric param.
- DTO validation runs first, so a malformed value (`limit=500`, `openDebtMin=-1`) still gets its normal `400`.

### 2.7 Errors

The listing codes use the envelope `{ statusCode, code, message, field, details? }`. Switch on `code`.

| HTTP | Body / code | When |
|---|---|---|
| 400 | Nest per-field validation body `{ statusCode, message: [ValidationError…], error: "Bad Request" }` | `page` < 1; `limit` outside 1–100; unknown `sortBy` / `sortOrder`; unknown parameter (including `preferredPaymentMethod`); non-string or repeated `search`; a boolean other than `true` / `false`; an `N`-day value outside 1–3650 or not an integer |
| 400 | `LISTING_INVALID_NUMBER` | a `*Min` / `*Max` that is not a number, is negative, or is not an integer |
| 400 | `LISTING_INVERTED_RANGE` | `*Min` > `*Max` or `*From` > `*To`; `field` is the range name (`openDebt`, `totalSold`, `salesCount`, `averageTicket`, `activePets`, `oldestOverdue`, `lastPurchase`, `created`) |
| 400 | `LISTING_INVALID_DATE` | a `*From` / `*To` that is not a valid date |
| 400 | `LISTING_INVALID_ENUM_VALUE` (`details.allowed`) | a bad value in `petSpecies`, `petSize`, `fiscalRegime` or `deliveryZoneType` |
| 400 | `LISTING_TOO_MANY_VALUES` (`details.cap`) | more than 50 enum values or more than 200 text / UUID values |
| 400 | `LISTING_INVALID_UUID` | a `priceListId` value that is not a UUID |
| 400 | `LISTING_PARAM_REQUIRES_PERMISSION` (`details.required: "read:Sale"`) | a metric filter or sort without `read:Sale` (§2.6) |
| 401 | standard | missing or invalid token |
| 403 | `INSUFFICIENT_PERMISSIONS` | no `read:Customer` |

When one request has both a listing-code error and a plain validation error, the listing-code body is the one returned.

## 3. `GET /customers/listing/options?field=…`

Permission `read:Customer` (no `read:Sale` needed).

| Param | Type | Default | Notes |
|---|---|---|---|
| `field` | `neighborhood` \| `municipality` \| `city` \| `zipCode` \| `fiscalRegime` | **required** | The four location fields read **any** address of the branch's customers; `fiscalRegime` reads the customers |
| `q` | string, ≤ 100 characters | — | Case-insensitive `contains` on the trimmed value. Blank = no filter |
| `limit` | integer 1–200 | `50` | |

Response `200`:

```json
{ "field": "neighborhood", "data": [ { "value": "Del Valle", "customersCount": 41 } ] }
```

- Values are trimmed and grouped by `lower(value)`. Blank values are skipped.
- `value` is the group's most frequent spelling (counted by customers; a tie takes the lowest spelling). Sending it in the matching filter matches the whole group, because the filter is trimmed and case-insensitive.
- `customersCount` counts distinct customers (a customer with two addresses in the same colonia counts once).
- Sorted by `customersCount` desc, then `value`.
- `fiscalRegime` returns only the SAT codes in use. The fixed SAT list works as well for the filter.
- There is no option for the zone (`deliveryZoneType` is the fixed enum `FREE`, `SURCHARGE`, `CARRIER_ONLY`, `DENIED`, plus `deliveryZoneNone=true`) and none for `preferredPaymentMethod`. `field=deliveryZoneType` or `field=preferredPaymentMethod` gets `400`.

| HTTP | Body / code | When |
|---|---|---|
| 400 | Nest per-field validation body | `field` missing or unknown; `limit` outside 1–200 or not an integer; `q` over 100 characters or not a string; unknown parameter |
| 401 | standard | missing or invalid token |
| 403 | `INSUFFICIENT_PERMISSIONS` | no `read:Customer` |

## 4. `isTrusted` («Cliente de confianza»): `GET` and `PATCH /customers/:id`

### 4.1 Read: `GET /customers/:id` (`read:Customer`, unchanged)

The detail gains **`isTrusted: boolean`** (`false` for a customer nobody has marked). Everything else is unchanged: `globalPriceList`, `addresses[]`, `activePetsCount`, `comments`, billing fields.

### 4.2 Write: `PATCH /customers/:id` (`update:Customer`, unchanged)

Body: any existing PATCH field, plus optional `isTrusted`.

```json
{ "isTrusted": true }
```

- `isTrusted` must be a JSON boolean (`true` / `false`). The strings `"true"` / `"false"`, numbers and `null` get `400` with the per-field body below, and **nothing is written**, including the other fields of the same body.
- Absent = unchanged. Every other field works as before.
- The response is the customer detail as before, now with `isTrusted`. As before, it does not include `activePetsCount`.
- Last write wins, like every other PATCH field. Changing it changes nothing else (price lists, sales, bot). The chatbot inbox reads the same column, so it shows the change too.

Rejected value (`{ "isTrusted": "true" }`):

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": [
    { "property": "isTrusted", "children": [], "constraints": { "isBoolean": "isTrusted must be a boolean value" } }
  ]
}
```

| HTTP | Body / code | When |
|---|---|---|
| 400 | Nest per-field validation body | `isTrusted` not a JSON boolean (including `null`); unknown property; other existing field rules |
| 400 | `Validation failed (uuid is expected)` | non-UUID `:id` |
| 403 | `INSUFFICIENT_PERMISSIONS` | no `update:Customer` (PATCH) / `read:Customer` (GET) |
| 404 | `ENTITY_NOT_FOUND` (`{ statusCode, error, message, timestamp }`) | unknown customer, or of another branch (unchanged) |

### 4.3 Other customer routes

- `POST /customers` does **not** accept `isTrusted` (unknown property → `400`). New customers start with `isTrusted: false`, and the **`POST` response now carries `isTrusted: false`** (it is the detail shape).
- `GET /customers` (POS / checkout picker) is **unchanged**: its items have **no** `isTrusted`. Read it from the detail or the listing row.

## 5. KPI strip — `GET /customers/:customerId/sales-summary`

Permission `read:Sale`. No query parameters.

Response `200`:

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

- `metrics` is **exactly** the `metrics` object of the customer's listing row (§2.2), built by the same SQL and the same overdue cut-off. «Deuda», «Vencido», «Total comprado», «Ticket promedio» and «Última compra» always match the table.
- A customer with no sales gets `200` with counts and sums at `0` and `oldestOverdueDueDate`, `averageTicketCents`, `lastPurchaseAt` at `null`.
- Computed on every read, so always current.

| HTTP | Body / code | When |
|---|---|---|
| 400 | `Validation failed (uuid is expected)` | non-UUID `:customerId` |
| 401 | standard | missing or invalid token |
| 403 | `INSUFFICIENT_PERMISSIONS` | no `read:Sale`: hide the strip |
| 404 | `{ "statusCode": 404, "error": "CUSTOMER_NOT_FOUND", "message": "CUSTOMER_NOT_FOUND" }` (code-only, no `timestamp`) | unknown customer, or of another branch |

## 6. «Cobros y recibos» — `GET /customers/:customerId/payments?page=&limit=`

Permission `read:Sale`.

| Param | Type | Default |
|---|---|---|
| `page` | integer ≥ 1 | `1` |
| `limit` | integer 1–100 | `50` |

No other query parameter is accepted.

Every payment received from the customer, newest first. Each row is one **event**:

- `collection`: one «Cobrar todo» (handoff 30), grouped into one row with its breakdown;
- `payment`: any other payment row (counter charge, `POST /sales/:id/payments`, bot or online payment).

Response `200`:

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

TypeScript shape:

```ts
type PaymentMethod = 'cash' | 'card_credit' | 'card_debit' | 'transfer';
type Catalog = { paymentMethodId: string; name: string; subtitle?: string } | null;
type Cashier = { id: string; name: string } | null;

interface CollectionEvent {
  kind: 'collection';
  eventId: string;            // collection id
  occurredAt: string;         // when the «Cobrar todo» was made
  amountCents: number;        // appliedCents: money kept by the sales
  tenderedCents: number;
  changeDueCents: number;
  payments: Array<{ method: PaymentMethod; amountCents: number; catalog: Catalog }>;
  sales: Array<{ saleId: string; folio: string | null; status: string; appliedCents: number }>;
  cashier: Cashier;
  receiptPath: string;        // '/collections/:id/pdf', always present
}

interface PaymentEvent {
  kind: 'payment';
  eventId: string;            // sale_payments id
  occurredAt: string;
  method: PaymentMethod;
  catalog: Catalog;
  reference: string | null;
  amountCents: number;        // NET: tenderedCents − changeCents
  tenderedCents: number;
  changeCents: number;
  sale: { id: string; folio: string | null; status: string; totalCents: number };
  cashier: Cashier;
  receiptPath: string | null; // '/sales/:id/pdf', null when the sale is not CONFIRMED
}
```

### 6.1 Order and pagination

- Sorted by `occurredAt` desc, then `eventId` desc. This is a total order, so pages are stable. A payment arriving between two page reads shifts later pages by one, as in every offset list.
- `pagination` is the `GET /sales` object. `total` counts **events**, not payment rows. `totalPages` is `0` when `total` is `0`. A page past the end returns `data: []` with the real totals.
- A customer with no payments gets `200` with `data: []` and `total: 0`.

### 6.2 Field rules

- **`method` is lowercase in both kinds:** `cash`, `card_credit`, `card_debit`, `transfer` (the same values as `GET /collections/:id` and the POS tenders). There is no `credit`: credit-only sales have no payment rows.
- **`collection` events:**
  - `amountCents` = the collection's `appliedCents`. `tenderedCents` / `changeDueCents` as stored on the collection.
  - `payments` = the tenders, same shape and values as `GET /collections/:id` `payments`: `amountCents` is the **tendered** amount (cash includes the change).
  - `sales` = the sales that received money, in the `GET /collections/:id` order. `status` is the sale's **current** status; `appliedCents` is what this collection paid on it.
- **`payment` events — net amounts:** `amountCents` is **net**, `tenderedCents − changeCents`. Show it by default. `tenderedCents` is the stored amount (cash includes the change). `changeCents` is this payment's share of the change returned at the sale's charge: the sale's change is taken from its cash payments in payment order, the same rule as the statement PDF (handoff 29), so the three numbers equal that payment's row in the statement PDF. Card and transfer payments always have `changeCents: 0`.
- `catalog` is the custom payment method snapshot `{ paymentMethodId, name, subtitle? }` when valid, else `null`.
- `reference` is the stored reference (legacy rows: the old metadata reference, like `GET /sales/:id`), or `null`.
- `cashier` is the user who made the collection / recorded the payment, `{ id, name }`, or `null` (no user recorded, or the user no longer exists).

### 6.3 `receiptPath` formats per route

`receiptPath` is a relative API path. Build the URL with the API base and append `?format=`:

| `kind` | `receiptPath` | Route | `format` |
|---|---|---|---|
| `collection` | `/collections/:collectionId/pdf` | «Comprobante de cobro» (handoff 30 §7) | `ticket` (default) or `a4` |
| `payment` | `/sales/:saleId/pdf`, or `null` | sale receipt | `receipt-a4` (default) or `receipt-ticket` |

- Both PDF routes require `read:Sale`.
- A `payment` whose sale is no longer `CONFIRMED` has `receiptPath: null` (the sale PDF would answer `400 SALE_NOT_CONFIRMED`).
- A `collection` always has its `receiptPath`, also when one of its sales was canceled later.

### 6.4 Canceled sales and refunds

- **Payments of sales canceled later stay in the feed**: the money was received. They are flagged with `sale.status: "CANCELED"` (or the `status` inside `sales[]`). Show «Venta cancelada».
- **Refunds are not in the feed:** no negative events, and amounts are not netted. Do not present the feed as a balance.
- Sales without a customer or of another customer never appear. A deleted customer's sales lose the customer, so their payments leave the feed.

### 6.5 Errors

| HTTP | Body / code | When |
|---|---|---|
| 400 | `Validation failed (uuid is expected)` | non-UUID `:customerId` |
| 400 | Nest per-field validation body | `page` < 1 or not an integer; `limit` outside 1–100 or not an integer; unknown query parameter |
| 401 | standard | missing or invalid token |
| 403 | `INSUFFICIENT_PERMISSIONS` | no `read:Sale`: hide the tab |
| 404 | `{ "statusCode": 404, "error": "CUSTOMER_NOT_FOUND", "message": "CUSTOMER_NOT_FOUND" }` (code-only, no `timestamp`) | unknown customer, or of another branch |

## 7. What did not change

- **`GET /customers`** (POS / checkout picker): same route, bare `search`, **flat array**, `createdAt desc`, same item shape (no `isTrusted`, no metrics).
- **`GET /sales`**: route, filters, rows, `summary`, `counts` and `filterSummary` are untouched. The listing metrics reuse its CONFIRMED set and overdue rule, so the numbers agree.
- **Customer statement PDF** (`GET /customers/:customerId/statement/pdf`, handoff 29): same numbers. Its change rule was only extracted into a shared function that the payments feed also uses.
- `GET /customers/:id` 404 stays `ENTITY_NOT_FOUND`; the customer sales routes keep `CUSTOMER_NOT_FOUND`.
- `GET /quotations?customerId=` is enough for the «Cotizaciones» tab (EXISTS, `read:Quotation`; without it, hide the tab).

## 8. Recommended UI flow

1. **Table:** call `GET /customers/listing` with the user's filters and sort. If the user lacks `read:Sale`, hide the metric columns, metric filters, metric sorts and the debt totals (the rows have no `metrics`). Treat `400 LISTING_PARAM_REQUIRES_PERMISSION` (for example, a stale saved view) by dropping the reported `field` and retrying.
2. **Selectors:** load colonia / municipio / ciudad / CP / régimen values with `GET /customers/listing/options?field=…&q=…` (debounced). Send the returned `value` as-is in the filter.
3. **Customer page** `/pos/clientes/:id`: `GET /customers/:id` (detail, `isTrusted`, `comments` = «Notas»), `GET /customers/:customerId/sales-summary` (KPI strip; hide on `403`), `GET /customers/:customerId/payments` («Cobros y recibos»; hide on `403`), `GET /quotations?customerId=` («Cotizaciones»; hide on `403`).
4. **«Cliente de confianza» switch:** `PATCH /customers/:id` with `{ "isTrusted": true|false }`; replace the detail with the response.
