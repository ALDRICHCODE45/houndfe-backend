# Customers module (table with filters + customer page) — contract proposal v1

Status: **v1 APPROVED (owner OK 2026-11-26) and IMPLEMENTED** on `feat/customers-listing` (6bd81dfa, 15476114, 81a73364, f9792e3b). Final routes, shapes and errors: `docs/frontend-handoff/31-customers-module.md`. Differences from this text: `method` is lowercase in both feed event kinds; POST and PATCH /customers responses also carry `isTrusted`; `isTrusted` rejects `null` (strict boolean).

- Requested by the frontend on 2026-11-26, after the owner chose the design. The design files are in the frontend repo: `design/customers-module/01-tabla-y-filtros.html` (the table) and `02-pagina-pestanas.html` (the customer page `/pos/clientes/:id` with tabs).
- v1 applies the owner's and the frontend's answers to the v0 questions. The frontend relayed them on 2026-11-26 (§15).
- Same process as `docs/proposals/sales-history-redesign-contract.md` and `docs/proposals/customer-collection-contract.md`.
- Facts cite `main` 2fa0c892. Every existing behavior has a `path:line` in the **Evidence** appendix (E1, E2, …).

Legend:

- **EXISTS** = in the code today.
- **NEW** = proposed here.

Every change is additive. `GET /customers` (the POS and checkout customer picker) keeps its route, query, shape and order.

> **Implementation note (frontend answers after v1, 2026-11-26):** the payments feed shows `amountCents` net of change by default; `receiptPath` stays relative with per-route formats; `method` is **lowercase in both event kinds** (`cash`, `card_credit`, `card_debit`, `transfer`), overriding the uppercase enum in the §7.1 example.

## v0 → v1 changes

- **`isTrusted` becomes editable.** `PATCH /customers/:id` accepts `isTrusted: boolean` (`update:Customer`). The detail and the table row expose it, and `isTrusted=true|false` is a filter (§2, §4.5, §6).
- **Without `read:Sale`, the table answers 200, not 403.** The `metrics` key is omitted, metric filters and sorts are rejected with `400 LISTING_PARAM_REQUIRES_PERMISSION`, and `filterSummary` is `{count}` only (§10).
- **«Cobros y recibos» is now a feed of every payment of the customer:** `GET /customers/:customerId/payments`. It replaces the v0 list of «Cobrar todo» collections only. A «Cobrar todo» is one grouped event, and every other payment is its own event (§7).
- **`preferredPaymentMethod` is no longer a filter.** It stays a field of the row. The options endpoint drops it (§4.5, §5).
- **Default `limit` is 50** (max 100) on the table and on the payments feed (§3.2, §7).
- **`overdueMoreThanDays` is strict** (31+ days for N = 30). **Species and size apply to the same pet** (§4.1, §4.3).
- **Settled without change:** `GET /customers/:customerId/sales-summary` with the table rules; `averageTicketCents: null`; `oldestOverdueDueDate` as `YYYY-MM-DD`; the oldest address as primary with no migration; location over any address with no switch; chatbot requests of any status.

## 0. Requests and disposition

| # | Request (frontend) | Disposition | Where |
|---|---|---|---|
| R1 | New paginated customers list with per-row metrics, `{data, pagination}` and filter totals | **NEW** `GET /customers/listing` | §1–§3 |
| R2 | Sort by name, debt, «vencido desde», last purchase, total bought, purchases, average ticket, created date | Accepted | §3.3 |
| R3 | Server-side filters, five groups | Accepted. `preferredPaymentMethod` is out of the v1 filters (owner) | §4 |
| R4 | Keep `search`, including the pet name search | Accepted, same rule as `GET /customers` | §4.6 |
| R5 | Values for the colonia / municipio / ciudad / régimen / zona selectors | **NEW** distinct-values endpoint; régimen and zona are fixed lists | §5 |
| R6 | Customer page: `GET /customers/:id` + KPIs | Detail gains `isTrusted`. KPIs from **NEW** `GET /customers/:customerId/sales-summary` | §6 |
| R7 | «Cobros y recibos» tab | **NEW** `GET /customers/:customerId/payments`, every payment (owner) | §7 |
| R8 | «Cotizaciones» tab: is `GET /quotations?customerId=` enough? | Yes (EXISTS) | §8 |
| R9 | Is `Customer.comments` the «Notas»? | Yes | §9 |
| R10 | Permissions, errors, edge cases, performance | | §10–§13 |
| R11 | `isTrusted` editable (owner) | **NEW** field in `PATCH /customers/:id` | §6.1 |

## 1. What exists today

| Today | Evidence | Kept? |
|---|---|---|
| `GET /customers` takes only `search` and needs `read:Customer`. It returns a **flat array**, newest first (`createdAt desc`) | E1, E2 | Yes, unchanged |
| `search`: trimmed and cut to 100 characters, at most 6 words. A customer matches when every word appears (case-insensitive `contains`) in `firstName`, `lastName`, `email`, `phone` or `businessName`, **or** when the whole term appears in the `nameKey` of an **ACTIVE** pet. `matchedPetName` = the pet's name when the match came only through a pet | E2, E3 | Reused in §4.6 |
| A `GET /customers` row = `Customer.toResponse()` + `globalPriceList {id, name}` + `addresses[]` (`createdAt` asc) + `matchedPetName`. No `isTrusted`, no metrics | E4, E5 | Unchanged |
| `GET /customers/:id` returns the same fields + `activePetsCount`. Unknown → `404 ENTITY_NOT_FOUND` | E6, E7 | §6 |
| `PATCH /customers/:id` (`update:Customer`) takes `UpdateCustomerDto` = `PartialType(OmitType(CreateCustomerDto, ['addresses']))`: no `isTrusted`. The `Customer` entity and the repository `save` do not carry `isTrusted` either | E49, E50 | §6.1 |
| `Customer.isTrusted` (boolean, default false) is stored but not returned by the customers module. Only the chatbot inbox reads it. **No code path writes it** | E8, E9 | §6.1 makes it editable |
| `preferredPaymentMethod`: free text (≤ 50 characters), written only by the chatbot customer upsert | E10 | Row field only |
| `fiscalRegime` is validated against the fixed SAT list `FISCAL_REGIMES` | E11 | §4.5 |
| Addresses have **no** «principal» flag. Every reader sorts them by `createdAt` asc. The chatbot treats the **oldest** as «the» address | E12, E13 | §2.2 |
| `customer_addresses` is indexed only by `tenantId` | E14 | §12 |
| Pets: `species` DOG/CAT/OTHER, `size` SMALL/MEDIUM/LARGE/GIANT (nullable), `status` ACTIVE/ARCHIVED; index `(tenantId, customerId, status)` | E15 | §2, §4.3 |
| `DeliveryZone`: one row per tenant ZIP code with `type` FREE/SURCHARGE/CARRIER_ONLY/DENIED and `isActive`. There are **no named zones**. The bot uses only active zones | E16, E17 | §4.4 |
| `ChatbotRequest.customerId` (nullable, indexed) | E18 | §4.5 |
| `Sale.customerId` (nullable, `SetNull` on customer delete, index `(customerId)`); `openDebtCents` (generated; 0 when CANCELED), `dueDate`, `confirmedAt`, `changeDueCents` | E19, E24 | §2.1, §7 |
| `GET /sales` `summary` and `counts` cover **CONFIRMED sales only**. `averageTicketCents` = `round(total / count)` half up, **0** when there are no sales | E20, E21 | §2.1 |
| **«Vencida»**: CONFIRMED, `openDebtCents > 0`, `dueDate < cutoff`, where `cutoff` = 00:00Z of today's local date in `PROMOTIONS_BUSINESS_TIMEZONE` (default America/Mexico_City). `oldestOverdueDueDate` = `YYYY-MM-DD` | E22, E23 | §2.1, reused exactly |
| `sales` has no index starting `(tenantId, customerId)` | E24 | §12 |
| The tenant Prisma extension scopes **model** operations only. Every raw SQL query passes `tenantId` by hand | E25, E26 | §12 |
| `sale_payments`: one row per received tender (`saleId`, `userId?`, `method` CASH/CARD_CREDIT/CARD_DEBIT/TRANSFER, `amountCents`, `reference?`, `metadataJson.catalog?`, `createdAt`). `collectionId` is set only for «Cobrar todo» rows. Indexes: `(saleId)`, `(tenantId)`, `(tenantId, method)`, `(userId)`, `(collectionId)`. Credit-only sales have **no** payment rows | E51, E52, E53 | §7 |
| At the counter charge, a cash row stores the **tendered** amount, and the change is stored once on the sale (`changeDueCents`). The customer statement PDF already lists a customer's payments net of that change and flags canceled sales | E54, E55 | §7 reuses the rule |
| `sale_collections` (one row per «Cobrar todo», index `(tenantId, customerId, createdAt)`), `GET /collections/:collectionId` and the «Comprobante de cobro» `GET /collections/:collectionId/pdf?format=ticket\|a4` (`read:Sale`) | E27, E28, E29 | §7 |
| Sale receipt `GET /sales/:id/pdf?format=receipt-a4\|receipt-ticket` (`read:Sale`, default `receipt-a4`). A non-CONFIRMED sale → `400 SALE_NOT_CONFIRMED` | E56 | §7 |
| `GET /quotations?customerId=` (`read:Quotation`), `{data, pagination}`, PDF `GET /quotations/:id/pdf` | E30, E31 | §8 |
| Listing conventions and envelope `{statusCode, code, message, field, details?}`; global pipe with `forbidNonWhitelisted` | E32, E33, E34 | §4, §11 |
| `@RequirePermissions` needs every listed pair (`403 INSUFFICIENT_PERMISSIONS`). The guard attaches `request.ability`, and services already branch on `ability.can(...)` | E35, E36 | §10 |
| Customer sales routes live in the sales module; unknown customer → `404 CUSTOMER_NOT_FOUND` (code-only envelope) | E37, E38 | §6, §7 |

## 2. Row of the new list (NEW)

```json
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
```

- Every field comes from the same columns as `GET /customers` (E4), plus `isTrusted` (E8).
- The full address list, `comments` and the billing address are left out. The customer page loads them with `GET /customers/:id`.
- `phone` is unmasked, the same as `GET /customers` with `read:Customer`. The `read:CustomerPhone` mask applies only to the chatbot inbox (E39).
- `petSpecies` lists the distinct species of the **ACTIVE** pets, in enum order; `[]` when there are none.
- `matchedPetName` has the same meaning as in `GET /customers` (E3).
- `metrics` is **omitted** for callers without `read:Sale` (§10).
- `matchedAddressId` is added when a location filter is active (§4.4).

### 2.1 Metric definitions

The customer's sales are the `sales` rows with this `customerId` and `status = 'CONFIRMED'`, from any channel. This is the same set as `GET /sales` `summary` (E20).

| Metric | Definition | Without sales |
|---|---|---|
| `salesCount` | number of sales | `0` |
| `totalSoldCents` | Σ `totalCents` (refunds not subtracted) | `0` |
| `openDebtCents` | Σ `openDebtCents` (= `summary.outstandingDebtCents`) | `0` |
| `overdueCount` | sales with `openDebtCents > 0 AND dueDate < cutoff`. The cutoff is computed once per request by the `GET /sales` function (E22) | `0` |
| `overdueDebtCents` | Σ `openDebtCents` of those sales | `0` |
| `oldestOverdueDueDate` | `YYYY-MM-DD`: the UTC date of the oldest overdue `dueDate`, the same string as `summary.oldestOverdueDueDate` (frontend: Q3 → `YYYY-MM-DD`) | `null` |
| `averageTicketCents` | `round(totalSoldCents / salesCount)`, half up | **`null`** (frontend: Q2) |
| `lastPurchaseAt` | max `confirmedAt`, as an ISO instant | `null` |

- Counts and sums are `0` when the customer has no sales. Dates and the average are `null`.
- With `null`, a customer who never bought sorts last on «Ticket promedio» and never matches an `averageTicket` range.
- `GET /sales` `summary.averageTicketCents` stays `0` with no sales (E21). This divergence is deliberate and was accepted by the frontend.

### 2.2 Primary address

The primary address is the customer's **oldest** address (`createdAt` asc, then `id` asc), or `null` when the customer has none. There is no migration. This is the address the chatbot reads and overwrites (E13). Owner (Q5): a future «Marcar como principal» would be a separate task.

## 3. Endpoint (NEW)

### 3.1 Route

`GET /customers/listing` requires `read:Customer`; `read:Sale` decides which data the caller gets (§10). It is declared in `CustomersController` **before** `@Get(':id')`. Otherwise Nest would route `listing` into `:id`, and `ParseUUIDPipe` would answer 400.

Why a new route instead of `GET /customers?view=…`:

- `GET /customers` reads a bare `@Query('search')` (E1). Moving it to a DTO would turn on `forbidNonWhitelisted` (E34) for the POS picker. Any extra parameter it sends today would then start failing.
- One route returns one shape.
- `listing` matches the shared listing conventions (E32).

The route lives in the customers module and reads `sales` with raw SQL. The customers module already does this (E26), and `businessToday` is a pure helper (E22). So `CustomersModule` does not need to import `SalesModule`.

### 3.2 Pagination and response

`page` is an integer ≥ 1 (default 1). `limit` is 1–100, **default 50** (frontend Q13). The response:

```json
{
  "data": [ /* §2 rows */ ],
  "pagination": { "page": 1, "limit": 50, "total": 312, "totalPages": 7 },
  "filterSummary": { "count": 312, "openDebtCents": 4580000, "overdueDebtCents": 1210000 }
}
```

- `pagination.total` counts the customers matching every filter. `totalPages = 0` when `total = 0`.
- `filterSummary` totals every matching customer, not just the page. `count === pagination.total`, and the sums are `0` when nothing matches. This mirrors `GET /sales` `filterSummary` (E41).
- Without `read:Sale`, `filterSummary` is `{ "count": n }` only (§10).
- A page past the end returns `data: []` with the real totals.

### 3.3 Sorting

`sortBy` (default `createdAt`), `sortOrder` (`asc` | `desc`, default `desc`).

| `sortBy` | UI | Sorts by | Metric? |
|---|---|---|---|
| `name` | Nombre | `lower(firstName)`, then `lower(lastName)` | no |
| `openDebt` | Deuda | `metrics.openDebtCents` | yes |
| `oldestOverdue` | Vencido desde | `metrics.oldestOverdueDueDate` (`asc` = longest overdue first) | yes |
| `lastPurchaseAt` | Última compra | `metrics.lastPurchaseAt` | yes |
| `totalSold` | Total comprado | `metrics.totalSoldCents` | yes |
| `salesCount` | Compras | `metrics.salesCount` | yes |
| `averageTicket` | Ticket promedio | `metrics.averageTicketCents` | yes |
| `createdAt` | Alta | `createdAt` | no |

- `null` values always sort **last**, in both directions.
- The final tie-breaker is `id`, so pages are stable.
- `name` follows the database collation.

## 4. Filters (NEW)

The shared conventions apply (E32):

- AND between filters, OR inside a CSV filter.
- Inclusive bounds; money in cents.
- Booleans accept only the exact strings `true` and `false` (E42).
- Instants are ISO strings, compared like `GET /sales` `confirmedFrom/To`.
- `N`-day filters take integers 1–3650, counted against today's **local** date.

Params marked **M** are **metric params**: they need `read:Sale` (§10).

### 4.1 Deuda (all M)

| Param | Meaning |
|---|---|
| `hasDebt=true\|false` | `openDebtCents > 0` / `= 0` |
| `openDebtMin`, `openDebtMax` | range on `openDebtCents` |
| `hasOverdue=true\|false` | `overdueCount > 0` / `= 0` |
| `overdueMoreThanDays=N` | at least one sale overdue by **strictly more than** N days: `oldestOverdueDueDate < localToday − N` (frontend Q6). For N = 30 on 26/11, a sale due 26/10 (31 days) matches and one due 27/10 (30 days) does not |
| `oldestOverdueFrom`, `oldestOverdueTo` | range on the oldest overdue `dueDate`, compared like `GET /sales` `dueDateFrom/To` |

### 4.2 Compras

| Param | Meaning | M |
|---|---|---|
| `totalSoldMin`, `totalSoldMax` | range on `totalSoldCents` | M |
| `salesCountMin`, `salesCountMax` | range on `salesCount` | M |
| `averageTicketMin`, `averageTicketMax` | range on `averageTicketCents`. Customers without sales never match | M |
| `lastPurchaseFrom`, `lastPurchaseTo` | range on `lastPurchaseAt` | M |
| `noPurchaseMoreThanDays=N` | never bought, **or** the local date of the last purchase is before `localToday − N` | M |
| `createdFrom`, `createdTo` | range on `createdAt` («Alta») | — |

### 4.3 Mascotas (ACTIVE pets only)

| Param | Meaning |
|---|---|
| `petSpecies=DOG,CAT,OTHER` | the customer has an ACTIVE pet of one of these species |
| `petSize=SMALL,MEDIUM,LARGE,GIANT` | the customer has an ACTIVE pet of one of these sizes |
| `activePetsMin`, `activePetsMax` | range on `activePetsCount` |
| `hasPets=true\|false` | `activePetsCount > 0` / `= 0` |

When `petSpecies` and `petSize` are both present, **the same pet** must match both (frontend Q7). «Perro grande» means one `EXISTS (… species IN (…) AND size IN (…))`, not two independent conditions. Pets without a size never match `petSize`.

### 4.4 Ubicación — any address

| Param | Meaning |
|---|---|
| `neighborhood`, `municipality`, `city`, `zipCode` | CSV (max 200 each). Matches when **any** address of the customer has one of the values (trimmed, case-insensitive exact match) |
| `deliveryZoneType=FREE,SURCHARGE,CARRIER_ONLY,DENIED` | any address whose ZIP code has an **active** `DeliveryZone` of one of those types |
| `deliveryZoneNone=true` | any address with a non-empty ZIP code that has no active `DeliveryZone` («sin zona») |

- These filters match any address, and there is no `addressScope` switch in v1 (frontend Q8).
- «Principal» is derived (§2.2). Filtering on it alone would hide customers whose second address is in that colonia.
- When a location filter is active, every row carries `matchedAddressId`: the oldest address that matches. This explains rows whose primary address shows another colonia.
- There are no named zones (E16), so «zona de reparto» filters by the zone **type** of the address ZIP code, using active zones only, like the bot (E17).

### 4.5 Comercial y contacto

| Param | Meaning |
|---|---|
| `priceListId=<uuid,…>` | `globalPriceListId` in the list. `priceListIncludeNull=true` adds customers without a list |
| `isTrusted=true\|false` | `Customer.isTrusted`, editable since v1 (§6.1) |
| `hasRfc=true\|false` | `rfc` set / empty |
| `fiscalRegime=601,612,…` | CSV enum over `FISCAL_REGIMES` (E11) |
| `hasEmail=true\|false`, `hasPhone=true\|false` | «sin correo» / «sin teléfono» |
| `hasChatbotRequests=true\|false` | at least one `ChatbotRequest` with this `customerId`, **any status** (frontend Q9) |

`preferredPaymentMethod` is **not** a filter in v1 (owner Q12). Sending it → `400` (unknown parameter, E34).

### 4.6 `search`

`search` works exactly like in `GET /customers` (E2, E3): the same trimming, the 6-word limit, the own-field and ACTIVE-pet rules, `matchedPetName`, and `LIKE` escaping. It is combined with the other filters by AND. The implementation reproduces `ownFieldsWhere` + `petNameKey` in SQL and pins it with the same test cases.

## 5. Selector values (NEW)

`GET /customers/listing/options?field=<field>&q=<text>&limit=<n>`, permission `read:Customer`.

- `field`: one of `neighborhood`, `municipality`, `city`, `zipCode` (over any address), or `fiscalRegime` (only the codes in use).
- `q`: optional, case-insensitive `contains`.
- `limit`: 1–200, default 50.

```json
{ "field": "neighborhood", "data": [ { "value": "Del Valle", "customersCount": 41 } ] }
```

- Values are grouped by `lower(trim(value))`. `value` is the most frequent spelling of the group.
- Results are sorted by count desc, then value. Empty values are skipped.
- There is no accent folding (no `unaccent`, E43), but the filter matches exactly what an option sends.
- Why an endpoint: these columns are free text with spelling variants. The options show what really exists.
- **Régimen:** the fixed SAT list (E11) also works.
- **Zona:** a fixed enum. Zone ZIP codes are listed by `GET /delivery-zones` (E44).

## 6. Customer page

**`GET /customers/:id` (EXISTS, E6):** `Customer.toResponse()` + `globalPriceList` + `addresses[]` + `activePetsCount`. Unknown → `404 ENTITY_NOT_FOUND`. v1 adds **`isTrusted: boolean`** to this detail only. `GET /customers` stays unchanged.

### 6.1 Editing `isTrusted` (NEW, owner Q4)

`PATCH /customers/:id` (unchanged permission `update:Customer`, E49) accepts an optional `isTrusted: boolean`. The UI is the «Cliente de confianza» switch on the customer page.

- Only a JSON boolean is accepted. `"true"`, `1` or `null` → `400`, with the standard per-field body (`@IsOptional() @IsBoolean()`). Absent = unchanged.
- The field goes on `UpdateCustomerDto` only. `POST /customers` keeps creating with the default `false`. The `Customer` entity, `fromPersistence`/`toPersistence`, the repository `save` and `toResponse` gain the field (E50). The PATCH response then echoes it, because it is the detail.
- Last write wins, like every other `PATCH` field. Nothing else changes: price lists, sales and the bot are unaffected. The chatbot inbox already reads the same column (E9), so a change shows there too.

### 6.2 KPI strip (NEW, frontend Q1)

`GET /customers/:customerId/sales-summary`, permission `read:Sale`. It lives in the sales module, like `sales-monthly` (E37).

```json
{ "customerId": "uuid", "metrics": { /* exactly §2.1 */ } }
```

- It runs the same SQL fragment and rules as the table row. «Deuda», «Vencido», «Total comprado», «Ticket promedio» and «Última compra» always match the table.
- Unknown or foreign customer → `404 CUSTOMER_NOT_FOUND` (E38). Non-UUID → `400`.
- Without `read:Sale` → `403` (the UI hides the strip, §10).

## 7. «Cobros y recibos»: payments feed (NEW, owner Q10)

`GET /customers/:customerId/payments?page=&limit=` lists every payment received from the customer, one **event** per row, newest first. It replaces the v0 list of «Cobrar todo» collections only.

- **Permission:** `read:Sale`. The data is sales money, the same as `GET /collections/:id`, both PDFs and the statement PDF (E28, E56, E37).
- **Home:** the sales module (E37), next to the collection routes.
- **Unknown or foreign customer:** `404 CUSTOMER_NOT_FOUND` (code-only, E38). Non-UUID → `400`.
- **Pagination:** `page` ≥ 1 (default 1); `limit` 1–100, **default 50**, the same as the table.

### 7.1 Events

Source: `sale_payments` joined to `sales` on `sales.customerId = :customerId` (the same join as the statement PDF, E54). Rows are grouped into events by `coalesce(collectionId, id)`:

| `kind` | When | `eventId` | `occurredAt` |
|---|---|---|---|
| `collection` | the payment rows share a `collectionId` («Cobrar todo») | `collectionId` | `sale_collections.createdAt` |
| `payment` | any other payment row (counter charge, `POST /sales/:id/payments`, bot or ONLINE payment) | `sale_payments.id` | `sale_payments.createdAt` |

Order: `occurredAt desc, eventId desc`. This is a total order, so `page`/`limit` pages are stable. A new payment arriving between two page reads shifts later pages by one, as in every offset list.

```json
{
  "data": [
    {
      "kind": "collection",
      "eventId": "uuid-collection",
      "occurredAt": "2026-11-26T18:02:11.000Z",
      "amountCents": 90000,
      "tenderedCents": 90000,
      "changeDueCents": 0,
      "payments": [ { "method": "card_debit", "amountCents": 60000, "catalog": null }, { "method": "cash", "amountCents": 30000, "catalog": null } ],
      "sales": [ { "saleId": "uuid", "folio": "V-000123", "status": "CONFIRMED", "appliedCents": 30000 } ],
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

**`collection` events:**

- `amountCents` = `appliedCents`: the money kept by the sales.
- `tenderedCents` / `changeDueCents` come from `sale_collections`.
- `payments` = the stored tenders, using the same parser and shape as `GET /collections/:id` (E28).
- `sales` = the sales that received money, from the rows of this collection. `status` is the sale's **current** status.
- The collection is listed under the customer that owns its sales. A collection's sales all belong to one customer (`docs/proposals/customer-collection-contract.md` §3).

**`payment` events:**

- `method` is the stored enum (`CASH`, `CARD_CREDIT`, `CARD_DEBIT`, `TRANSFER`; credit-only sales have no rows, E53).
- `catalog` = `metadataJson.catalog` when valid (`{paymentMethodId, name, subtitle?}`), else `null` (E52).
- `reference` is the stored reference.
- **Change rule:** `tenderedCents` is the stored amount, `changeCents` is its share of the sale's `changeDueCents`, and `amountCents` = tendered − change. This is exactly the statement PDF rule: the change comes off the sale's CASH rows in payment order (E55). It requires reading every payment row of that sale, not only the page's rows.

**Both kinds:**

- `cashier` = `{id, name}` from `User.name` (the collection's `actorUserId`; the payment's `userId`), or `null` when unknown or deleted (E51, E28).
- **`receiptPath`:** a relative API path. The frontend appends `?format=`, which differs per route:
  - collection: `ticket|a4`, default `ticket` (E28);
  - sale: `receipt-a4|receipt-ticket`, default `receipt-a4` (E56).
- `receiptPath` is `null` for a `payment` whose sale is no longer CONFIRMED, because the sale PDF answers `400 SALE_NOT_CONFIRMED` (E56). A collection receipt still prints when one of its sales was canceled later.

### 7.2 Canceled sales and refunds

- **Payments of sales canceled later are included**, with `sale.status: "CANCELED"` (or the status inside `sales[]`). The money was received and appears in the cash ledger of that day. Hiding it would make the feed disagree with the statement PDF, which lists these payments and flags `saleCanceled` (E55). The UI can show «Venta cancelada».
- **Refunds (`sale_refunds`) are out of v1** (owner): no negative events, and amounts are not netted. The UI should not present the feed as a balance.
- DRAFT sales have no payments.

## 8. «Cotizaciones» tab — EXISTS, enough

`GET /quotations?customerId=<uuid>` (`read:Quotation`) supports CSV UUID filtering, `page`/`limit` (1/20, max 100), `sortBy` `createdAt|updatedAt|expiresAt|totalCents`, `sortOrder` and `status`. It returns `{data, pagination}`, and the PDF is `GET /quotations/:id/pdf` (E30, E31).

Two behaviors that do not matter for a per-customer tab:

- `search` matches only the customer name.
- `EXPIRED` is applied lazily.

Without `read:Quotation`, the route answers `403`, so the UI hides the tab.

## 9. «Notas» = `Customer.comments` — yes

This is the customer's only free-text note field. It is optional, trimmed, up to 2,000 characters, written by `POST`/`PATCH /customers` and returned by `GET /customers/:id` (E45). Pet `notes` are a separate field (E15).

## 10. Permissions

| Route | Permissions |
|---|---|
| `GET /customers/listing` | `read:Customer`; the metric parts need `read:Sale` too (below) |
| `GET /customers/listing/options` | `read:Customer` |
| `GET /customers/:id` (+ `isTrusted`) | `read:Customer` (unchanged) |
| `PATCH /customers/:id` (+ `isTrusted`) | `update:Customer` (unchanged) |
| `GET /customers/:customerId/sales-summary` | `read:Sale` |
| `GET /customers/:customerId/payments` | `read:Sale` |
| `GET /quotations?customerId=` | `read:Quotation` (unchanged) |

### 10.1 The table without `read:Sale` (owner Q11: «La tabla sin deuda ni compras»)

The route guard requires only `read:Customer`. The service checks `request.ability.can('read', 'Sale')`, which is the existing pattern (E36). Without `read:Sale`:

- The answer is still **200**, never 403.
- **`metrics` is omitted** from every row (the key is absent, not `null`). Inside `metrics`, `null` already means "no sales" (`averageTicketCents`, `lastPurchaseAt`). A `metrics: null` would invite the same reading, while an absent key cannot be mistaken for data, and a strict client type (`metrics?:`) catches a missing check.
- **`filterSummary` is `{ "count": n }`**: no debt sums.
- **Metric params are rejected** with `400 LISTING_PARAM_REQUIRES_PERMISSION`, so a stale saved view fails visibly instead of silently ignoring a filter. Metric params are:
  - **filters:** `hasDebt`, `openDebtMin`, `openDebtMax`, `hasOverdue`, `overdueMoreThanDays`, `oldestOverdueFrom`, `oldestOverdueTo`, `totalSoldMin`, `totalSoldMax`, `salesCountMin`, `salesCountMax`, `averageTicketMin`, `averageTicketMax`, `lastPurchaseFrom`, `lastPurchaseTo`, `noPurchaseMoreThanDays`;
  - **sorts:** `sortBy` = `openDebt`, `oldestOverdue`, `lastPurchaseAt`, `totalSold`, `salesCount`, `averageTicket`.

  The body uses the listing envelope (E33), with a new code:

  ```json
  { "statusCode": 400, "code": "LISTING_PARAM_REQUIRES_PERMISSION", "message": "openDebtMin requires read:Sale", "field": "openDebtMin", "details": { "required": "read:Sale" } }
  ```

  - `field` is the **first** offending param, filters in the order listed above, then `sortBy`.
  - The check runs after DTO validation, so a malformed value still gets its normal validation error first.
  - `details.required` is a new optional key of the envelope.
- Everything else works: `search`, pets, location, commercial filters, `createdFrom/To`, and sorting by `name` / `createdAt`.

## 11. Validation and errors

Unknown parameters → `400` (`forbidNonWhitelisted`, E34).

| HTTP | Body / code | When |
|---|---|---|
| 400 | standard per-field validation body | `page` < 1; `limit` outside 1–100; unknown `sortBy`/`sortOrder`; a boolean other than `true`/`false`; `N` outside 1–3650; unknown parameter (including `preferredPaymentMethod`); options `field` unknown or `limit` outside 1–200; `PATCH` `isTrusted` not a JSON boolean |
| 400 | `LISTING_INVALID_ENUM_VALUE` | `petSpecies`, `petSize`, `fiscalRegime`, `deliveryZoneType` |
| 400 | `LISTING_TOO_MANY_VALUES` | more than 50 enum or 200 text/UUID values |
| 400 | `LISTING_INVALID_UUID` | `priceListId` |
| 400 | `LISTING_INVALID_NUMBER` | a bound that is not a number; **NEW here:** negative or non-integer too (the shared decorator only rejects non-finite values, E46) |
| 400 | `LISTING_INVALID_DATE` / `LISTING_INVERTED_RANGE` | bad or inverted ranges |
| 400 | **NEW** `LISTING_PARAM_REQUIRES_PERMISSION` | a metric param without `read:Sale` (§10.1) |
| 400 | `Validation failed (uuid is expected)` | non-UUID `:customerId` |
| 403 | `INSUFFICIENT_PERMISSIONS` | missing the route permission (§10) |
| 404 | `CUSTOMER_NOT_FOUND` (code-only) | `sales-summary`, `payments` |
| 404 | `ENTITY_NOT_FOUND` | `GET`/`PATCH /customers/:id` unknown (unchanged) |

Contradictory filters (`hasDebt=false&openDebtMin=100`) are not errors; they match nothing (E42).

## 12. Performance

### 12.1 New indexes (one additive migration)

```sql
CREATE INDEX "sales_tenant_customer_confirmed_idx"
  ON "sales" ("tenantId", "customerId")
  INCLUDE ("totalCents", "openDebtCents", "dueDate", "confirmedAt")
  WHERE "status" = 'CONFIRMED' AND "customerId" IS NOT NULL;

CREATE INDEX "customer_addresses_tenant_customer_created_idx"
  ON "customer_addresses" ("tenantId", "customerId", "createdAt", "id");
```

- Both indexes are migration-only and documented with a schema comment (precedent E47).
- A plain `CREATE INDEX` makes writes wait while it builds (E48). Deploy off-hours if `sales` is large.
- `openDebtCents` is already indexed (E24), so the extra write cost is one index entry per confirmed sale.

**Payments feed: no new index.** The feed reads one customer's payments. Sales come through the existing `sales_customerId_idx` (`customerId`, all statuses; canceled sales are included on purpose, so the CONFIRMED-only partial index above does not apply). Their payments come through `sale_payments_saleId_idx`, and collections by primary key (E24, E51).

The work grows with that customer's payment count (tens to low thousands), not with the tenant. If `EXPLAIN` on a heavy customer shows a sort spill, the fallback is `sale_payments ("saleId", "createdAt")`.

### 12.2 Table query shape

A raw SQL builder (`$queryRaw` + `Prisma.sql`) with an explicit `"tenantId" = ${tenantId}` on every table (E25):

```sql
WITH c AS (            -- customer-field filters + search + EXISTS(address/zone/chatbot/pet) filters
  SELECT ... FROM customers c WHERE c."tenantId" = $t AND ...
), r AS (
  SELECT c.*, m.*, p.*
  FROM c
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int                                        AS "salesCount",
           COALESCE(SUM(s."totalCents"), 0)::bigint             AS "totalSoldCents",
           COALESCE(SUM(s."openDebtCents"), 0)::bigint          AS "openDebtCents",
           COUNT(*) FILTER (WHERE s."openDebtCents" > 0 AND s."dueDate" < $cutoff)::int AS "overdueCount",
           COALESCE(SUM(s."openDebtCents") FILTER (WHERE s."openDebtCents" > 0 AND s."dueDate" < $cutoff), 0)::bigint AS "overdueDebtCents",
           MIN(s."dueDate") FILTER (WHERE s."openDebtCents" > 0 AND s."dueDate" < $cutoff) AS "oldestOverdueDueDate",
           MAX(s."confirmedAt")                                 AS "lastPurchaseAt"
    FROM sales s
    WHERE s."tenantId" = $t AND s."customerId" = c.id AND s.status = 'CONFIRMED'
  ) m ON true
  LEFT JOIN LATERAL ( ... ACTIVE pets: count, species[] ... ) p ON true
  WHERE <metric and pet-count filters>
)
SELECT ... FROM r ORDER BY <sort> NULLS LAST, id LIMIT $limit OFFSET $offset;
```

- The primary address and `matchedAddressId` are resolved for the page rows only.
- `total` and `filterSummary` come from a second statement over the same `r`, run in parallel, as `GET /sales` does (E21). A window total would vanish on an empty page.
- **Without `read:Sale`**, or with no metric filter and `sortBy` = `name`/`createdAt`, the builder pages `c` first. The sales LATERAL then runs only for the page rows (with `read:Sale`), or not at all (without `read:Sale`, where the totals are a plain `COUNT(*)` over `c`).

### 12.3 Payments feed query shape

```sql
WITH p AS (
  SELECT sp.*, s."folio", s."status", s."totalCents" AS "saleTotalCents", s."changeDueCents"
  FROM sale_payments sp
  JOIN sales s ON s.id = sp."saleId" AND s."tenantId" = $t
  WHERE sp."tenantId" = $t AND s."customerId" = $customerId
), e AS (
  SELECT coalesce(p."collectionId", p.id) AS "eventId",
         (p."collectionId" IS NOT NULL)   AS "isCollection",
         MAX(coalesce(sc."createdAt", p."createdAt")) AS "occurredAt"
  FROM p LEFT JOIN sale_collections sc ON sc.id = p."collectionId" AND sc."tenantId" = $t
  GROUP BY 1, 2
)
SELECT * FROM e ORDER BY "occurredAt" DESC, "eventId" DESC LIMIT $limit OFFSET $offset;
-- + COUNT(*) FROM e for pagination.total, in parallel
```

A second query hydrates the page's events (≤ 100):

- tenders and totals of the collections;
- the per-sale rows of the collections;
- for `payment` events, every payment row of their sales, to apply the change rule (E55);
- cashier names.

There is no N+1.

### 12.4 Cost and caveat

- **Caveat:** sorting or filtering by a metric computes the metrics for **every customer matching the other filters, before `LIMIT`**. With no other filter, that is the whole tenant. The cost grows with the tenant's confirmed sales that have a customer.
- **Unmeasured estimate:** with 5,000 customers and 50,000 confirmed sales, each statement takes tens of milliseconds, and the request runs two statements.
- **Implementation requirements:** run `EXPLAIN (ANALYZE, BUFFERS)` on a seeded tenant about 10× the largest real one, confirm index-only scans, and set a budget (for example p95 < 300 ms).
- **Fallback if the budget fails:** a stats table maintained on write. It is out of scope for v1.
- **Freshness:** metrics are computed on read, so they are always current.

## 13. Edge cases

- Sales without a customer never count. A deleted customer's sales get `customerId = null` (E19), so they leave every row and every feed. Their collections keep `customerId = null` (E29).
- A canceled sale stops counting in the metrics immediately. Its payments stay in the feed, flagged (§7.2).
- A sale due today is not overdue until local midnight (E22).
- A customer with no address has `primaryAddress: null` and never matches a location filter.
- A ZIP code is free text and `DeliveryZone.zipCode` has 5 characters (E12, E16). They are matched by trimmed equality, so a malformed ZIP code matches no zone.
- Several customers can share a phone (E1). Each one is listed.

## 14. Risk and size

All read-only, except one new optional `PATCH` field and one additive migration with two indexes. No money moves and nothing is locked. The risks are the table query performance, reproducing `search` in SQL, and the change rule in the feed (it reuses the statement rule and its tests).

Estimate: about 1,500 authored lines:

- DTOs and the SQL builder;
- the options route;
- `sales-summary` and the payments feed;
- the `isTrusted` field;
- unit tests per filter and permission branch;
- PostgreSQL integration specs for the metrics, the overdue rule, null handling, tenant isolation, sorting with nulls, the no-`read:Sale` mode and the feed's grouping, change and paging.

## 15. Resolved decisions (2026-11-26)

Relayed by the frontend session.

- **Owner**
  - Q4 «Sumar un interruptor editable»: `isTrusted` in `PATCH /customers/:id` (`update:Customer`), in the detail, and as a table column and filter (§6.1, §2, §4.5).
  - Q5 Primary address = the oldest, no migration. «Marcar como principal» would be a separate task (§2.2).
  - Q10 «Todos los pagos del cliente»: the `GET /customers/:customerId/payments` feed. «Cobrar todo» rows are grouped with `/collections/:id/pdf`; single payments come with their sale and the sale PDF. Refunds are later. The collections-only list is dropped (§7).
  - Q11 «La tabla sin deuda ni compras»: 200 without `metrics`, metric params rejected by code, `filterSummary` with `count` only, no 403 (§10.1). The backend chose to omit the key.
  - Q12 `preferredPaymentMethod` is out of the filters; it stays a row field (§4.5).
- **Frontend**
  - Q1 `GET /customers/:customerId/sales-summary` with the table rules (§6.2).
  - Q2 `averageTicketCents: null` without sales.
  - Q3 `oldestOverdueDueDate` as `YYYY-MM-DD`.
  - Q6 strict, from day 31.
  - Q7 species and size on the same pet.
  - Q8 any address, no switch.
  - Q9 any chatbot request.
  - Q13 `limit` default 50, max 100.

### Open questions (new in v1)

1. **[FRONTEND]** Feed `payment` events show `amountCents` net of change, plus `tenderedCents` and `changeCents`, like the statement PDF. Is the net amount the one to show by default (proposed)?
2. **[FRONTEND]** `receiptPath` is a relative API path with different `format` values per route: `ticket|a4` for collections, `receipt-a4|receipt-ticket` for sales. Is that acceptable, or should the feed return a normalized `receipt: {type, id}` and let the frontend build both URLs?

## Evidence

Paths are relative to the repository root, at `main` 2fa0c892.

- **E1** `src/customers/customers.controller.ts:38-42` (`GET /customers`, `read:Customer`, bare `@Query('search')`), `:44-48` (`GET /customers/:id`). Non-unique phone index: `prisma/schema.prisma:2200`.
- **E2** `src/customers/customers.service.ts:99-153` (`findAll`; trim + 100 characters `:107`; `createdAt desc` `:110`, `:126`).
- **E3** `src/customers/customers.service.ts:117-121` (ACTIVE pet `nameKey`), `:148-151` (`matchedPetName`), `:309-327` (`ownFieldsWhere`, 6 words, 5 fields), `:22` (`escapeLike`); `src/customer-pets/domain/customer-pet-rules.ts:31-38` (`petNameKey`).
- **E4** `src/customers/customers.service.ts:330-369` (`toListItem`); `src/customers/domain/customer.entity.ts:189-215` (`toResponse`, no `isTrusted`).
- **E5** `src/customers/customers.service.ts:103`, `:380` (addresses `createdAt` asc).
- **E6** `src/customers/customers.service.ts:155-156`, `:371-424` (detail + `activePetsCount`).
- **E7** `src/customers/customers.service.ts:382`, `:419-421`; `src/shared/domain/domain-error.ts:20-24` (`ENTITY_NOT_FOUND`); `src/shared/filters/domain-exception.filter.ts:48-53`.
- **E8** `prisma/schema.prisma:2164` (`isTrusted`); `prisma/migrations/20260613000100_receipt_review/migration.sql:4`.
- **E9** `src/chatbot-requests/application/chatbot-request-reads.service.ts:546`, `:771`, `:782`, `:1116` (the only readers; no writer of `isTrusted` in `src`).
- **E10** `prisma/schema.prisma:2163`; `src/chatbot-api/presentation/dto/customer-upsert.request.ts:94-97`; `src/chatbot-api/application/chatbot-api.service.ts:1077-1078`.
- **E11** `src/customers/domain/constants.ts:40-66` (`FISCAL_REGIMES`); `src/customers/dto/create-customer.dto.ts:67-69`.
- **E12** `prisma/schema.prisma:2204-2230` (`CustomerAddress`, no default flag, free-text `zipCode`); `src/customers/customers.service.ts:247-256`; `src/chatbot-api/application/chatbot-api.service.ts:361-363`.
- **E13** `src/chatbot-api/application/chatbot-api.service.ts:496-499` (profile = oldest address), `:1029-1055` (upsert overwrites the oldest).
- **E14** `prisma/schema.prisma:2228`.
- **E15** `prisma/schema.prisma:2236-2295` (species, size, status, pet `notes`; index `:2292`).
- **E16** `prisma/schema.prisma:3619-3624`, `:3640-3666` (`zipCode` VarChar(5), unique `:3663`).
- **E17** `src/delivery-zones/infrastructure/prisma-delivery-zone-bot.repository.ts:198`.
- **E18** `prisma/schema.prisma:4032`, `:4128`.
- **E19** `prisma/schema.prisma:1493` (`customerId`), `:1525-1531` (`openDebtCents`, `changeDueCents`, `confirmedAt`, `dueDate`), `:1567` (`onDelete: SetNull`); `prisma/migrations/20261108090000_sales_open_debt_cents/migration.sql`.
- **E20** `src/sales/infrastructure/prisma-sale.repository.ts:1777-1780` (`status: 'CONFIRMED'`), `:2143-2162`, `:2200-2221`.
- **E21** `src/sales/sales.service.ts:1929-2028` (`listSales`: parallel statements, `totalPages`, average half up / 0, `filterSummary`).
- **E22** `src/sales/sales.service.ts:1934-1945`, `:141`, `:722-727`; `src/inventory/domain/fefo-allocator.ts:16-23`; `src/sales/dto/sales-list-filter.types.ts:34-40`; `src/sales/infrastructure/prisma-sale.repository.ts:1928-1938`.
- **E23** `src/sales/dto/sale-list-response.dto.ts:93-103`; `src/sales/sales.service.ts:2017-2020`; `src/sales/infrastructure/prisma-sale.repository.ts:2017-2018`.
- **E24** `prisma/schema.prisma:1592-1603` (sales indexes, `(customerId)` at `:1602`); `prisma/migrations/20260508223000_pos_sales_list_detail/migration.sql:23`.
- **E25** `src/shared/prisma/tenant-prisma.factory.ts:25-41`.
- **E26** `src/customers/infrastructure/prisma-customer.repository.ts:131-136`; `src/sales/infrastructure/prisma-sale.repository.ts:2236-2247`.
- **E27** `src/sales/customer-collections.controller.ts:29-58`.
- **E28** `src/sales/collections.controller.ts:22-30`; `src/sales/collection-receipt-pdf.controller.ts:28-61`, `:80-89` (`format` ticket/a4, default ticket); `src/sales/collection-read.service.ts:94-122`; `src/sales/dto/customer-collection.dto.ts:215-234`; `src/sales/infrastructure/prisma-collection.reader.ts:51`.
- **E29** `prisma/schema.prisma:1711-1731` (`SaleCollection`, `SetNull`, index `:1728`).
- **E30** `src/quotations/dto/quotation-query.dto.ts:11-120`.
- **E31** `src/quotations/controllers/quotations.controller.ts:104-105`, `:427-428`; `src/quotations/application/quotations.service.ts:873`.
- **E32** `src/shared/listing/README.md`.
- **E33** `src/shared/listing/listing.exceptions.ts:3-42`; `src/shared/listing/listing-validation-exception.factory.ts:33-49`.
- **E34** `src/shared/listing/app-validation.pipe.ts:4-12`; `src/main.ts:35`.
- **E35** `src/auth/authorization/guards/permissions.guard.ts:96-105`; `src/shared/domain/domain-error.ts:74-78`.
- **E36** `src/auth/authorization/guards/permissions.guard.ts:90-94` (`request.ability`); `src/pdf-generation/cash-closing/cash-closing-pdf.controller.ts:91-97` and `src/delivery-routes/application/delivery-routes.service.ts:577` (service-level `ability.can`).
- **E37** `src/sales/sales-customer-monthly.controller.ts:19-44`; `src/sales/sales-customer-statement.controller.ts:34-48`; `src/customer-pets/presentation/customer-pets.controller.ts:37`; `src/customers/customers.module.ts:9`.
- **E38** `src/sales/sales-customer-monthly.controller.ts:26-27`; `src/sales/customer-statement.service.ts:18-19`; `docs/frontend-handoff/28-sales-history-redesign.md:155-156`.
- **E39** `src/auth/authorization/domain/permission.ts:91`, `:923`; `src/chatbot-requests/application/chatbot-request-reads.service.ts:9`.
- **E40** `src/sales/dto/list-sales-query.dto.ts:86-107`; `src/sales/dto/sale-list-response.dto.ts:56-61`.
- **E41** `src/sales/dto/sale-list-response.dto.ts:104-116`.
- **E42** `src/sales/dto/list-sales-query.dto.ts:74-78`, `:158-168`; `docs/proposals/sales-history-redesign-contract.md`, implementation notes.
- **E43** No `unaccent`/`pg_trgm` in `prisma/migrations`.
- **E44** `src/delivery-zones/presentation/delivery-zones.controller.ts:85-111`.
- **E45** `prisma/schema.prisma:2162`; `src/customers/dto/create-customer.dto.ts:45-48`; `src/customers/customers.service.ts:179-180`.
- **E46** `src/shared/listing/decorators/numeric-range.decorator.ts:41-45`.
- **E47** `prisma/schema.prisma:4132-4136`.
- **E48** `prisma/migrations/20261112030000_conversation_unread_media_intents/migration.sql:18-21`.
- **E49** `src/customers/customers.controller.ts:50-57` (`PATCH /customers/:id`, `update:Customer`); `src/customers/dto/update-customer.dto.ts:1-6` (`PartialType(OmitType(CreateCustomerDto, ['addresses']))`, no `isTrusted`).
- **E50** `src/customers/domain/customer.entity.ts:17-44`, `:73-82` (props/constructor without `isTrusted`); `src/customers/infrastructure/prisma-customer.repository.ts:53-95` (`save` upsert without `isTrusted`); `src/customers/customers.service.ts:159-214` (`update`).
- **E51** `prisma/schema.prisma:1673-1701` (`SalePayment`: fields, `userId` `SetNull`, `collectionId`, indexes `:1695-1699`).
- **E52** `prisma/schema.prisma:151-157` (`SalePaymentMethod`); `src/sales/sales.service.ts:454-463` (`metadataJson.catalog`); `src/sales/infrastructure/prisma-sale.repository.ts:1544-1560` (charge writes payment rows).
- **E53** `src/sales/dto/list-sales-query.dto.ts:56-62` (credit-only sales have no `sale_payments` rows).
- **E54** `src/sales/infrastructure/prisma-customer-statement.reader.ts:80-97` (payments of a customer: `sale_payments JOIN sales ON customerId`, every sale status, `saleStatus`, `saleChangeDueCents`, catalog name).
- **E55** `src/sales/customer-statement.service.ts:13-16`, `:198-231` (net-of-change rule, `tenderedCents`, `changeCents`, `saleCanceled`).
- **E56** `src/pdf-generation/pdf-generation.controller.ts:25-38` (`GET /sales/:id/pdf`, `read:Sale`); `src/pdf-generation/pdf-generation.constants.ts:44-56` (`receipt-a4` default, `receipt-ticket`); `src/pdf-generation/pdf-generation.service.ts:30`, `:254-255` (`400 SALE_NOT_CONFIRMED`).
