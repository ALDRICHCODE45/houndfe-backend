# Chatbot checkout shipping: quote, pickup and opening hours

Task T7 of `odd/tasks/shipping-zones.md` (specs **S8** and **S10**). Design: `docs/shipping-and-delivery-zones-proposal.md` §4, §10 and §11. The quote endpoint itself is in `docs/shipping-quotes.md`.

The bot no longer sends a shipping price. It asks for a quote, then sends the quote id with the order. The backend checks the quote and sets the shipping charge itself. When the zone is not delivered, the bot offers store pickup instead.

## 1. The `shipping` member

Two routes take it:

- `POST /chatbot-api/checkouts`, as `sale.shipping`;
- `POST /chatbot-api/sales`, as `shipping`.

| Shape | Meaning | Status |
| --- | --- | --- |
| `{ "quoteId": "shq_…" }` | Delivery with a backend quote. | **Use this.** |
| `{ "mode": "pickup" }` | Store pickup: no delivery address, no shipping charge. | **Use this.** |
| omitted | No shipping, as before (the sale has no charge). | Unchanged. |
| `{ "chargeCents", "approvalId", "quoteId"? }` | Old per-charge human approval. | **Deprecated.** |

The backend picks the shape by its keys:

- `mode` present → pickup;
- `chargeCents` or `approvalId` present → old shape;
- otherwise → quote.

Any other key in the chosen shape is rejected with `400`. So mixed bodies such as `{ "mode": "pickup", "quoteId": "…" }` fail.

### Deprecated shape

`{ chargeCents, approvalId, quoteId? }` still works, with exactly the checks it has today:

- the `BOT_SHIPPING_CHARGE_MAX_CENTS` ceiling;
- an `approvalId` used only once per sucursal;
- `expectedTotalCents` is required;
- its `quoteId` is free text and is **not** verified.

The chatbot has not moved to the new shapes yet, so this shape is not rejected. When it has moved, the plan is to answer the old shape with `400 SHIPPING_CONTRACT_CHANGED` (a later change).

## 2. Delivery: quote → checkout

### 2.1 Quote

`POST /chatbot-api/shipping/quotes` (scope `shipping:quote`), as described in `docs/shipping-quotes.md`:

```json
{
  "phoneCountryCode": "52",
  "phone": "5512345678",
  "items": [{ "productId": "6f1c…", "quantity": 1 }],
  "destination": {
    "zipCode": "64000",
    "state": "Nuevo León",
    "municipality": "Monterrey",
    "neighborhood": "Centro"
  }
}
```

```json
{
  "quoteId": "shq_Q2x9…43 chars…",
  "expiresAt": "2026-11-06T18:30:00.000Z",
  "zoneStatus": "SURCHARGE",
  "option": null,
  "eta": { "days": 2, "reason": null },
  "costCents": 30000,
  "creditCents": 12000,
  "customerChargeCents": 18000,
  "currency": "MXN"
}
```

`creditCents` is the credit **applied**, `min(earned credit, costCents)`, so `customerChargeCents` never goes below 0. For example, a cost of 6900 with 12000 earned gives `creditCents: 6900` and `customerChargeCents: 0` (see [shipping-quotes.md](shipping-quotes.md)).

A carrier quote can take a while: Skydropx completes a quotation in about 15 s, and the backend waits up to `SKYDROPX_QUOTE_DEADLINE_MS`. Give the quote request a client timeout above `SHIPPING_CARRIER_TIMEOUT_MS`.

### 2.2 Checkout

`POST /chatbot-api/checkouts`, header `X-Idempotency-Key`, scopes `customers:write` + `sales:create`.

The quote must be made for the same:

- phone,
- cart lines (product, variant, quantity),
- delivery address.

`expectedTotalCents` is the merchandise total plus `customerChargeCents`.

```json
{
  "phoneCountryCode": "52",
  "phone": "5512345678",
  "customer": { "mode": "existing", "customerId": "c0a1…" },
  "deliveryAddress": {
    "mode": "newSaved",
    "address": {
      "street": "Calle 5",
      "zipCode": "64000",
      "state": "Nuevo León",
      "municipality": "Monterrey",
      "neighborhood": "Centro"
    }
  },
  "sale": {
    "cashierUserId": "3a9e…",
    "items": [
      { "productId": "6f1c…", "productName": "Croquetas", "quantity": 1, "unitPriceCents": 60000 }
    ],
    "expectedTotalCents": 78000,
    "shipping": { "quoteId": "shq_Q2x9…" }
  }
}
```

Response `201`:

```json
{
  "status": "created",
  "customer": { "resolution": "existing", "customerId": "c0a1…", "firstName": "Ana", "lastName": null },
  "address": { "resolution": "created", "id": "d4e5…", "version": "2026-11-06T18:01:02.345Z" },
  "sale": {
    "saleId": "1e06…",
    "folio": "A-202611-000001",
    "paymentStatus": "CREDIT",
    "channel": "ONLINE",
    "deliveryStatus": "PENDING",
    "totalCents": 78000,
    "discountCents": 0,
    "subtotalCents": 60000,
    "shippingChargeCents": 18000,
    "fulfillmentMode": "DELIVERY",
    "paidCents": 0,
    "debtCents": 78000,
    "confirmedAt": "2026-11-06T18:01:02.400Z"
  }
}
```

- `totalCents` and `debtCents` include the shipping charge (proposal §10, "Total"). A transfer receipt is compared with that total.
- With a FREE zone, `shippingChargeCents` is `0` and is still present.

### 2.3 How the quote is checked

The address used is the one the checkout ends up selling to: the saved, created or corrected address. The checks run in this order:

1. The quote belongs to this sucursal. If not → `404 SHIPPING_QUOTE_NOT_FOUND`.
2. It has not expired. If it has → `409 SHIPPING_QUOTE_EXPIRED`.
3. The phone, the lines and the destination match. If not → `409 SHIPPING_QUOTE_MISMATCH`:
   - the phone is compared by digits;
   - the lines are compared as (product, variant, quantity) in any order;
   - the destination is compared by its 5-digit zip code plus state / municipality / neighborhood, ignoring case, accents and extra spaces.
4. The quote has not been used by another sale. If it has → `409 SHIPPING_QUOTE_ALREADY_USED`.

Step 4 runs inside the sale transaction with the quote row locked, and expiry is checked again there (`409 SHIPPING_QUOTE_EXPIRED`): a quote that expired while the sale waited for the lock is refused. Two requests racing for one quote (two checkouts, two `/sales`, or one of each) produce exactly one sale, charged once; the other gets `409 SHIPPING_QUOTE_ALREADY_USED`. Both endpoints lock the customer row before the quote row, so a checkout and a `/sales` call cannot deadlock. On `/sales`, every `SHIPPING_QUOTE_*` rejection frees the `X-Idempotency-Key`, so the bot can requote and retry with the same key.

Then the sale is charged `customerChargeCents`.

### 2.4 `POST /chatbot-api/sales`

The rules are the same. The customer is `customerId`, and the destination is `shippingAddressId`, a saved address of that customer. Both are required with a quote, and so is `expectedTotalCents`.

```json
{
  "cashierUserId": "3a9e…",
  "customerId": "c0a1…",
  "shippingAddressId": "d4e5…",
  "items": [
    { "productId": "6f1c…", "productName": "Croquetas", "quantity": 1, "unitPriceCents": 60000 }
  ],
  "expectedTotalCents": 78000,
  "shipping": { "quoteId": "shq_Q2x9…" }
}
```

The response is the `sale` object of §2.2: `subtotalCents`, `shippingChargeCents`, `fulfillmentMode: "DELIVERY"`, `totalCents` and `debtCents` include the charge.

## 3. Store pickup (`{ "mode": "pickup" }`)

Use it when the zone is `DENIED`, or when the customer prefers pickup.

- **No delivery address.** For the checkout, `deliveryAddress` may be left out. If it is sent, it is saved to the customer as today, but it is **not** put on the sale. For `POST /chatbot-api/sales`, `shippingAddressId` must be left out or `null`.
- **New customer:** only `customer: { "mode": "createIfAbsent", "firstName", "lastName"? }` plus the top-level `phoneCountryCode` + `phone`.
- **Existing customer:** `customer: { "mode": "existing", "customerId" }` (checkout), or only `customerId` (`/sales`).
- **No shipping charge.** `expectedTotalCents` is the merchandise total.
- **Delivery status:** the sale has `deliveryStatus: "PENDING"` and `fulfillmentMode: "PICKUP"`. Staff mark it `DELIVERED` when the customer picks it up. No new status was added: pickup is still something to hand over, and `fulfillmentMode` already tells staff it is a pickup. A pickup sale has no address, so delivery routes list it as not routable (`MISSING_ADDRESS`).

Checkout request:

```json
{
  "phoneCountryCode": "52",
  "phone": "5511112222",
  "customer": { "mode": "createIfAbsent", "firstName": "Luis" },
  "sale": {
    "cashierUserId": "3a9e…",
    "items": [
      { "productId": "6f1c…", "productName": "Croquetas", "quantity": 1, "unitPriceCents": 60000 }
    ],
    "expectedTotalCents": 60000,
    "shipping": { "mode": "pickup" }
  }
}
```

Response `201`:

```json
{
  "status": "created",
  "customer": { "resolution": "created", "customerId": "77b0…", "firstName": "Luis", "lastName": null },
  "address": null,
  "sale": {
    "saleId": "9c21…",
    "folio": "A-202611-000002",
    "paymentStatus": "CREDIT",
    "channel": "ONLINE",
    "deliveryStatus": "PENDING",
    "totalCents": 60000,
    "discountCents": 0,
    "fulfillmentMode": "PICKUP",
    "paidCents": 0,
    "debtCents": 60000,
    "confirmedAt": "2026-11-06T18:05:00.000Z"
  },
  "pickupLocation": {
    "name": "Sucursal Centro",
    "address": {
      "addressLine1": "Av. Juárez 123",
      "addressLine2": null,
      "neighborhood": "Centro",
      "municipality": "Cuauhtémoc",
      "state": "Ciudad de México",
      "postalCode": "06000",
      "formatted": "Av. Juárez 123, Centro, Cuauhtémoc, Ciudad de México, C.P. 06000"
    },
    "hours": {
      "timeZone": "America/Mexico_City",
      "days": [
        { "day": "MONDAY", "label": "Lunes", "closed": false, "ranges": [{ "open": "09:00", "close": "18:00" }] },
        { "day": "TUESDAY", "label": "Martes", "closed": false, "ranges": [{ "open": "09:00", "close": "18:00" }] },
        { "day": "WEDNESDAY", "label": "Miércoles", "closed": false, "ranges": [{ "open": "09:00", "close": "18:00" }] },
        { "day": "THURSDAY", "label": "Jueves", "closed": false, "ranges": [{ "open": "09:00", "close": "18:00" }] },
        { "day": "FRIDAY", "label": "Viernes", "closed": false, "ranges": [{ "open": "09:00", "close": "18:00" }] },
        { "day": "SATURDAY", "label": "Sábado", "closed": false, "ranges": [{ "open": "09:00", "close": "18:00" }] },
        { "day": "SUNDAY", "label": "Domingo", "closed": true, "ranges": [] }
      ],
      "summary": "Lunes a sábado: 09:00–18:00. Domingo: cerrado."
    }
  }
}
```

`POST /chatbot-api/sales` with `{ "mode": "pickup" }` returns the sale object shown under `sale` above, plus one more key, `pickupLocation`.

`pickupLocation`:

| Key | Content |
| --- | --- |
| `name` | The sucursal (tenant) name. |
| `address` | The sucursal shipping origin (`docs/shipping-packaging.md` §4). Without an origin, it falls back to the free-text sucursal address: only `formatted` is set and the other fields are `null`. It is `null` when there is neither. |
| `hours` | The opening hours of §4, or `null` while they are not set. `days` is always the seven weekdays, Monday first; `closed` is `true` when a day has no ranges. `summary` is a short Spanish text: consecutive days with the same hours are grouped (`Lunes a viernes`, `Lunes y martes`), ranges are joined with `y`, and a closed day says `cerrado`. |

The location is the one in effect at sale time. A replay returns it unchanged.

## 4. Sucursal opening hours (store settings)

| Method | Path | Permission | Success |
| --- | --- | --- | --- |
| GET | `/tenants/:tenantId/opening-hours` | `read:ShippingSettings` | 200 |
| PUT | `/tenants/:tenantId/opening-hours` | `update:ShippingSettings` | 200 (`Cache-Control: no-store`) |

PUT replaces the whole week:

```json
{
  "timeZone": "America/Mexico_City",
  "days": [
    { "day": "MONDAY", "ranges": [{ "open": "09:00", "close": "14:00" }, { "open": "16:00", "close": "20:00" }] },
    { "day": "TUESDAY", "ranges": [{ "open": "09:00", "close": "14:00" }, { "open": "16:00", "close": "20:00" }] },
    { "day": "WEDNESDAY", "ranges": [{ "open": "09:00", "close": "14:00" }, { "open": "16:00", "close": "20:00" }] },
    { "day": "THURSDAY", "ranges": [{ "open": "09:00", "close": "14:00" }, { "open": "16:00", "close": "20:00" }] },
    { "day": "FRIDAY", "ranges": [{ "open": "09:00", "close": "14:00" }, { "open": "16:00", "close": "20:00" }] },
    { "day": "SATURDAY", "ranges": [{ "open": "10:00", "close": "14:00" }] },
    { "day": "SUNDAY", "ranges": [] }
  ]
}
```

Rules:

- `days` must list each weekday (`MONDAY` … `SUNDAY`) exactly once, in any order. They are stored Monday first.
- An empty `ranges` means closed. A day has at most 6 ranges.
- Times are `HH:mm` from `00:00` to `23:59`. `open` must be before `close`, and a range never crosses midnight.
- Ranges of a day must not overlap or touch: `09:00–14:00` + `14:00–18:00` must be sent as `09:00–18:00`. They are stored sorted by `open`.
- `timeZone` is an IANA zone. It is optional, and the default is `America/Mexico_City`.

Response (`configured: false, openingHours: null` until the first PUT):

```json
{
  "configured": true,
  "openingHours": {
    "timeZone": "America/Mexico_City",
    "days": [
      { "day": "MONDAY", "ranges": [{ "open": "09:00", "close": "14:00" }, { "open": "16:00", "close": "20:00" }] },
      { "day": "SUNDAY", "ranges": [] }
    ],
    "updatedAt": "2026-11-06T18:00:00.000Z"
  }
}
```

(The example is cut short; `days` always has seven entries.)

Errors:

| Case | Status | `error` |
| --- | --- | --- |
| Bad shape: unknown key, unknown day, malformed time, more than 7 days or 6 ranges | 400 | `ValidationPipe` response |
| Missing or repeated weekday, `open` not before `close`, overlapping or touching ranges, unknown time zone | 400 | `INVALID_OPENING_HOURS` (the message names the day) |
| Missing or invalid token / missing permission | 401 / 403 | |
| `:tenantId` is not the caller's tenant (and no `manage:all`) | 404 | Same 404 whether that tenant exists or not |

Storage: table `tenant_opening_hours`, one row per sucursal, in `TENANT_SCOPED_MODELS`.

## 5. Errors (checkout and sales)

Every error is `{ "statusCode", "error", "message" }`, with the code in `error` and `message`. The checkout route never adds other details, except `mismatches`.

| Status | `error` | When |
| --- | --- | --- |
| 400 | `INVALID_CHECKOUT_REQUEST` (checkout) / validation (`/sales`) | Bad or mixed `shipping` shape, or no `deliveryAddress` without pickup. |
| 404 | `SHIPPING_QUOTE_NOT_FOUND` | Malformed or unknown quote id, or a quote of another sucursal. |
| 409 | `SHIPPING_QUOTE_EXPIRED` | Past `expiresAt`. Requote silently. |
| 409 | `SHIPPING_QUOTE_MISMATCH` | See below. Requote and show the new total. |
| 409 | `SHIPPING_QUOTE_ALREADY_USED` | The quote already backs another sale. |
| 422 | `SHIPPING_ADDRESS_REQUIRED` | `/sales` with a quote and no `shippingAddressId`. |
| 422 | `SHIPPING_EXPECTED_TOTAL_REQUIRED` | `/sales` with a quote and no `expectedTotalCents`. |
| 422 | `SHIPPING_ADDRESS_NOT_ALLOWED_FOR_PICKUP` | `/sales` pickup with a `shippingAddressId`. |
| 409 | `PROMO_RE_QUOTE` | Unchanged: `expectedTotalCents` is not merchandise + shipping charge. |

`SHIPPING_QUOTE_MISMATCH` lists every part that differs, using the T3 verifier names (`CUSTOMER`, `LINES`, `DESTINATION`):

```json
{
  "statusCode": 409,
  "error": "SHIPPING_QUOTE_MISMATCH",
  "message": "SHIPPING_QUOTE_MISMATCH",
  "mismatches": ["LINES", "DESTINATION"]
}
```

Example:

```json
{ "statusCode": 404, "error": "SHIPPING_QUOTE_NOT_FOUND", "message": "SHIPPING_QUOTE_NOT_FOUND" }
```

## 6. Single use and idempotent replay

- A quote backs **at most one sale**. The sale stores the quote row (`sales.shippingQuoteRecordId`, unique), never the quote id itself. The quote row is locked while the sale is created, so two orders racing for the same quote cannot both win. The unique index is the database backstop.
- **Same `X-Idempotency-Key` and same body:**
  - the first result is returned again, with the same sale and totals;
  - the quote is not checked again, so the replay works even after the quote has expired;
  - nothing is charged twice.
  
  The quote id is part of the request hash. The old shape hashes exactly as before this change, so stored receipts still replay.
- **A different key with an already used quote:** `409 SHIPPING_QUOTE_ALREADY_USED`.
- **After a `SHIPPING_QUOTE_*` error, nothing is written.** The bot requotes and sends again with the new `quoteId`:
  - **checkout:** everything is one transaction, so the same key can be reused;
  - **`/sales`:** the key's in-progress slot is freed after a quote rejection, so the same key can be reused too. Other `/sales` failures keep the existing rule: the slot stays in progress, so use a new key.

## 7. What the store sees

`GET /sales/:id` gains one optional key (additive): `fulfillmentMode`, `"DELIVERY"` or `"PICKUP"`. It is left out when not recorded (POS sales and bot sales without shipping). A sale registered with the old approved-charge shape is recorded as `DELIVERY`, but its bot response does not change.

Additive keys added by this task:

| Response | Key |
| --- | --- |
| `GET /sales/:id` (store) | `fulfillmentMode` (optional) |
| Bot sale object (`/chatbot-api/sales`, `sale` in checkouts) | `fulfillmentMode` (optional, new shapes only); `subtotalCents` + `shippingChargeCents` also for quote sales (`0` in a FREE zone) |
| `POST /chatbot-api/sales` | `pickupLocation` (pickup only) |
| `POST /chatbot-api/checkouts` | `pickupLocation` (pickup only); `address` may be `null` (pickup without address) |

No other store response changes.

## 8. Storage

| Migration | Change |
| --- | --- |
| `20261106060000_bot_checkout_shipping_pickup` | Enum `SaleFulfillmentMode` (`DELIVERY`, `PICKUP`). `sales.fulfillmentMode` (nullable). `sales.shippingQuoteRecordId` (nullable, unique, FK to `shipping_quotes`, `NO ACTION`). Table `tenant_opening_hours`. CHECKs: a quote-backed sale is `DELIVERY`; a pickup charges no shipping; the week has seven days. |
| `20261106060100_sales_quote_backed_shipping_charge` | A shipping charge needs an approval **or** a verified quote, never both. |

Both migrations only add, except that `sales_shipping_charge_requires_approval` is replaced by a looser check. Existing rows are unchanged.

## 9. Code

| Path | What |
| --- | --- |
| `src/chatbot-api/application/bot-shipping.ts` | Shape classification, request-hash member, quote error mapping (shared by both routes). |
| `src/chatbot-api/application/checkout.service.ts` | Checkout: verify inside the transaction, pickup, `pickupLocation`. |
| `src/chatbot-api/application/chatbot-api.service.ts` | `/sales`: verify, pickup, free the key after a quote rejection. |
| `src/sales/sales.service.ts` (`confirmBotSale`) | Lock the quote row, single use, charge, `fulfillmentMode`. |
| `src/shipping/pickup/` | Opening hours (domain, store routes) and `PickupLocationService`. |

Tests:

- unit: `bot-shipping`, `checkout.service`, `chatbot-api.service`, DTOs, `sales.service`, `prisma-sale.repository`, `opening-hours`, `pickup-location`;
- PostgreSQL: `src/chatbot-api/presentation/bot-checkout-shipping.integration.spec.ts` and `src/shipping/pickup/presentation/opening-hours.controller.integration.spec.ts`.
