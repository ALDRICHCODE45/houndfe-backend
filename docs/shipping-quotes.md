# Shipping quotes (shipping-zones / T3)

This covers specs **S5–S9** (the Skydropx adapter, task T6, is §6.1) of `odd/tasks/shipping-zones.md`. Design: `docs/shipping-and-delivery-zones-proposal.md` §4, §5, §9–§11. It builds on zones (`docs/delivery-zones.md`) and packaging (`docs/shipping-packaging.md`).

The bot asks for a quote, and the backend answers with a persisted quote that expires. Checkouts and sales accept it as `shipping: { quoteId }` (§7, task T7: `docs/chatbot-checkout-shipping.md`).

## 1. Endpoint

`POST /chatbot-api/shipping/quotes`

- **Auth:** a service credential (`Authorization: Bearer svc_…`), the same as other chatbot routes.
- **Scope:** new `shipping:quote`. Credentials need this scope granted.
- **Audit:** every call is written to the bot audit log as action `shipping.quote`, resource type `shipping_quote`.
- **Idempotency:** none. Every successful call creates a new quote.

Request:

```json
{
  "phoneCountryCode": "52",
  "phone": "5512345678",
  "items": [
    { "productId": "6f1c…", "quantity": 2 },
    { "productId": "8a2f…", "variantId": "a91e…", "quantity": 1 }
  ],
  "destination": {
    "zipCode": "64000",
    "state": "Nuevo León",
    "municipality": "Monterrey",
    "neighborhood": "Centro"
  }
}
```

Or with a saved address of that customer:

```json
{ "phoneCountryCode": "52", "phone": "5512345678", "items": [ … ], "destination": { "shippingAddressId": "c41b…" } }
```

| Key | Rule |
| --- | --- |
| `phoneCountryCode`, `phone` | Required. Digits only: 1–10 and 1–20 (as in `pricing/evaluate-cart`). |
| `items` | 1–100 lines. `productId` and `variantId` are UUIDs. `quantity` is an integer from 1 to 10000. Each product/variant may appear in only one line. |
| `destination` | Exactly one of: `shippingAddressId`, or all four of `zipCode` (5 digits), `state`, `municipality`, `neighborhood` (1–120 characters each). |

The bot never sends prices, and unknown keys are rejected with `400`.

## 2. Response (`201`)

```json
{
  "quoteId": "shq_Q2x9…43 chars…",
  "expiresAt": "2026-11-05T18:30:00.000Z",
  "zoneStatus": "CARRIER_ONLY",
  "option": { "carrier": "Skydropx/Estafeta", "service": "standard", "etaDays": 3 },
  "eta": { "days": 3, "reason": null },
  "costCents": 15000,
  "creditCents": 12000,
  "customerChargeCents": 3000,
  "currency": "MXN"
}
```

| `zoneStatus` | `quoteId` / `expiresAt` | `option` | Cost | `eta.days` |
| --- | --- | --- | --- | --- |
| `FREE` | set | `null` | `0` | the zone's days |
| `SURCHARGE` | set | `null` | the zone's `surchargeCents` | the zone's days |
| `CARRIER_ONLY` | set | the cheapest carrier | carrier total, taxes included | the carrier's ETA |
| `DENIED` | `null` | `null` | all `0` | `null` (the bot offers store pickup) |
| `PENDING` | `null` | `null` | all `0` | `null` |

Examples:

FREE:

```json
{ "quoteId": "shq_…", "expiresAt": "…", "zoneStatus": "FREE", "option": null, "eta": { "days": 1, "reason": null }, "costCents": 0, "creditCents": 0, "customerChargeCents": 0, "currency": "MXN" }
```

SURCHARGE with one unit above $500:

```json
{ "quoteId": "shq_…", "expiresAt": "…", "zoneStatus": "SURCHARGE", "option": null, "eta": { "days": 2, "reason": null }, "costCents": 30000, "creditCents": 12000, "customerChargeCents": 18000, "currency": "MXN" }
```

PENDING (and DENIED, with `"zoneStatus": "DENIED"`):

```json
{ "quoteId": null, "expiresAt": null, "zoneStatus": "PENDING", "option": null, "eta": { "days": null, "reason": null }, "costCents": 0, "creditCents": 0, "customerChargeCents": 0, "currency": "MXN" }
```

How the zone status is decided:

- **PENDING:** the postal code has no zone, or its zone is inactive. The quote does **not** open a DELIVERY_ZONE validation. The bot opens it through `POST /chatbot-api/human-decisions` with `type: "DELIVERY_ZONE"` (`docs/delivery-zones.md` §4.1), because only the bot has the conversation reference and the last customer message time that the intake requires. When the outcome arrives, the bot requotes.
- **DENIED / PENDING:** nothing is repriced, packed, sent to a carrier or stored. Products and the destination are still validated first, so a bad request is a `4xx`.
- **FREE / SURCHARGE:** no packaging data, box or origin is needed, and no carrier is called.

## 3. Rules

### 3.1 Repricing (S7 input)

The cart is repriced with `ChatbotApiService.evaluateCart`, the same bot pricing that sales use. That covers the customer's price list (looked up by phone), tiers and bot-eligible promotions. A phone with no customer is priced as a new customer (PUBLICO list).

### 3.2 Carrier (S6)

Only `CARRIER_ONLY` zones use carriers:

1. One package is built with `buildOrderPackage` (T2).
2. The sucursal shipping origin is read.
3. **Every configured carrier** is asked in parallel. Each call has a timeout (`SHIPPING_CARRIER_TIMEOUT_MS`), and a carrier still running at the timeout is aborted.
4. The cheapest usable `totalCents` wins. Ties go to the shorter ETA (an unknown ETA loses), then to the carrier name, then the service, so the result does not depend on which carrier answers first.

A rate is ignored when:

- `totalCents` is negative or not an integer;
- `etaDays` is negative or not an integer;
- `validUntil` has already passed.

A carrier that fails, times out or returns nothing is skipped. If no carrier is configured or none returns a usable rate, the quote fails with `SHIPPING_QUOTE_UNAVAILABLE`.

The carrier port (`src/shipping/quotes/domain/shipping-carrier.port.ts`) is shaped for Skydropx:

- `quote(request, signal)` may take several round trips (create a quotation, poll until it is complete) and must stop when `signal` aborts.
- Each option carries `rateId` (to buy the label later) and `validUntil` (Skydropx: 24 h).

### 3.3 Credit (S7)

$120 MXN per **unit** whose unit price after discounts is above $500:

- A line's unit price after discounts = repriced line total (`finalPriceCents`, including promotions and the order discount share) ÷ quantity. If that is **strictly** above the threshold, every unit of the line earns the credit. A unit at exactly $500 earns nothing.
- Credits from all lines add up.
- `creditCents` in the response is the credit **applied**: `min(earned credit, cost)`. It is `0` when the credit does not apply.
- `customerChargeCents = costCents − creditCents`, never below 0.
- The credit always applies to carrier cost. Whether it also applies to the own-zone surcharge is **TO BE CONFIRMED by the owner**; it is the switch `SHIPPING_CREDIT_APPLIES_TO_SURCHARGE`, `true` for now. A FREE zone always stays at 0.

### 3.4 ETA (S9)

The base is the zone's days (FREE/SURCHARGE) or the carrier's `etaDays` (CARRIER_ONLY).

If any line lacks sellable stock now, the quote returns `eta: { days: null, reason: "STOCK_PENDING" }`. The bot then uses RESTOCK (`restockDays`) and tells the customer `restockDays + base`. `option.etaDays` still shows the carrier's own days.

Sellable stock follows the chatbot catalog/sale rule:

| Line | Sellable quantity |
| --- | --- |
| Product without stock control (`useStock: false`) | Never lacks stock. |
| Variant | The variant's quantity. |
| Product without variants | Product quantity − units in expired lots (`sumExpiredLotQuantity`, business timezone), never below 0. |

A line lacks stock when it asks for more than that quantity.

### 3.5 Expiry and quote id (S8)

- `expiresAt` = `min(now + SHIPPING_QUOTE_TTL_MINUTES (30), carrier validUntil)`.
- For a carrier quote, `now` (also the stored `createdAt`) is the instant the rate was chosen, and only rates valid **after** that instant are eligible. A rate that would make `expiresAt ≤ createdAt` is skipped like any unusable rate: the next cheapest wins, or `503 SHIPPING_QUOTE_UNAVAILABLE` when none is left. It never reaches the table CHECK as a `500`.
- `quoteId` is `shq_` followed by 32 random bytes in base64url (43 characters). Only its SHA-256 is stored, so the id cannot be guessed or recovered from the database. "Signed" means the server holds the binding: the id is a bearer reference to a server-side record, not a token the client can decode.

## 4. Stored quote

Table `shipping_quotes`, migration `20261106040000_shipping_quotes`. It is tenant-scoped and listed in `TENANT_SCOPED_MODELS`. Rows are insert-only.

| Column | Content |
| --- | --- |
| `tokenHash` | SHA-256 of `quoteId` (unique). |
| `customerId` | The customer matched by phone, or `null` for a new customer. |
| `phoneCountryCode`, `phone` | The binding identity. Never returned. |
| `lines` | `[{ productId, variantId, quantity, finalPriceCents }]`, sorted. |
| `destination` | `{ source: ADDRESS\|INPUT, shippingAddressId, zipCode, state, municipality, neighborhood }`. |
| `zoneType`, `zone` | A zone snapshot `{ zoneId, zipCode, type, surchargeCents, etaDays }` plus the chosen carrier `option` (with `validUntil`). |
| `carrier`, `service`, `carrierRateId` | The chosen carrier rate (CARRIER_ONLY only). |
| `box` | `{ box, contentWeightG, totalWeightG }` (CARRIER_ONLY only). |
| `etaDays`, `etaReason` | The `eta` returned. |
| `costCents`, `creditCents`, `customerChargeCents`, `currency` | The money. CHECK: `customerChargeCents = costCents − creditCents`, credit ≤ cost, `currency = 'MXN'`. |
| `expiresAt`, `createdAt` | |

## 5. Errors

Every error uses the envelope `{ "statusCode", "error", "message", …details }`. Messages never include phones or addresses. An unexpected failure is a fixed `500 SHIPPING_QUOTE_FAILED`.

| Status | `error` | When |
| --- | --- | --- |
| `400` | validation (`ValidationPipe`) | Bad body, unknown keys, missing phone. |
| `400` | `INVALID_SHIPPING_DESTINATION` | Not exactly one of `shippingAddressId` / the four fields. |
| `400` | `DUPLICATE_CART_LINE` | The same product/variant in two lines. |
| `401` / `403` | — | Bad credential or missing `shipping:quote`. |
| `404` | `PRODUCT_NOT_FOUND`, `VARIANT_NOT_FOUND` | Unknown, foreign, or a variant of another product. |
| `404` | `SHIPPING_ADDRESS_NOT_FOUND` | The address is not a saved address of the customer with that phone. |
| `409` | `CUSTOMER_PHONE_AMBIGUOUS` | More than one customer has the phone. |
| `409` | `PRICE_OUT_OF_DATE` | A product has no catalog price (from repricing). |
| `422` | `SHIPPING_ADDRESS_INCOMPLETE` | The saved address has no 5-digit postal code. |
| `422` | `PACKAGING_DATA_MISSING` | `missing: [{ productId, variantId }]` (CARRIER_ONLY). |
| `422` | `NO_SHIPPING_BOX_FITS` | `contentWeightG`, `boxesConsidered` (CARRIER_ONLY). |
| `422` | `SHIPPING_ORIGIN_NOT_CONFIGURED` | The sucursal has no shipping origin (CARRIER_ONLY). Checked after packaging. |
| `503` | `SHIPPING_QUOTE_UNAVAILABLE` | `carriersAsked`: no carrier configured, or none answered usably. The bot can retry. |

## 6. Configuration (environment, all optional)

An absent key takes its default. A present but malformed or out-of-range value fails boot (`src/shared/config/env.validation.ts`); it never falls back silently. Flags accept `true`/`false`/`1`/`0`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SHIPPING_QUOTE_TTL_MINUTES` | `30` | Quote lifetime (1–1440). |
| `SHIPPING_CARRIER_TIMEOUT_MS` | `15000` | Per-carrier timeout (100–120000). |
| `SHIPPING_CREDIT_PER_UNIT_CENTS` | `12000` | Credit per qualifying unit. |
| `SHIPPING_CREDIT_UNIT_PRICE_THRESHOLD_CENTS` | `50000` | A unit qualifies when its price is strictly above this. |
| `SHIPPING_CREDIT_APPLIES_TO_SURCHARGE` | `true` | POR CONFIRMAR. `false` = credit on carrier cost only. |
| `SHIPPING_FAKE_CARRIER_ENABLED` | `false` | Registers the fake carrier `Fake/standard`: $99 for the first kg, $20 per extra started kg, 3 days, valid 24 h. **Ignored when `NODE_ENV=production`.** |

The credit rule is global configuration, not per tenant, for now.

With no carrier configured (no Skydropx credentials and the fake carrier off), a CARRIER_ONLY zone answers `503 SHIPPING_QUOTE_UNAVAILABLE`.

### 6.1 Skydropx (task T6)

Skydropx API Pro is the first real carrier. Code: `src/shipping/quotes/infrastructure/skydropx/`.

**Environment.** Every key is optional and validated at boot (`src/shared/config/env.validation.ts`). The names are listed in `.env.example`; values go only in the deployment's `.env`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SKYDROPX_CLIENT_ID` | — | OAuth client id. |
| `SKYDROPX_CLIENT_SECRET` | — | OAuth client secret. |
| `SKYDROPX_BASE_URL` | `https://api-pro.skydropx.com` | API host. It must be `https`. |
| `SKYDROPX_REQUEST_TIMEOUT_MS` | `5000` | Limit for every HTTP call: token, quotation, each poll and the `401` retry (500–60000). |
| `SKYDROPX_POLL_INTERVAL_MS` | `1000` | Wait between polls (500–10000). |
| `SKYDROPX_QUOTE_DEADLINE_MS` | `12000` | Limit for one whole quote (1000–120000). The adapter caps it at `SHIPPING_CARRIER_TIMEOUT_MS − 500`. |

- **Registration.** Skydropx is registered only when **both** the client id and the client secret are set. It is registered in every environment, production included. Without them, nothing calls Skydropx.
- **Startup log.** At startup the backend logs `Skydropx carrier registered (<base URL>)`. Credentials and tokens are never logged.
- **Sandbox vs production.** Each environment has its own credentials:
  - **Production:** credentials from `https://pro.skydropx.com/merchant_stores/applications` (Conexiones > API). The API host is the default.
  - **Sandbox:** credentials from `https://sb-pro.skydropx.com/merchant_stores/applications`. Set `SKYDROPX_BASE_URL=https://sb-pro.skydropx.com`. The public docs name only the production API host, so confirm the sandbox API host with the first sandbox call (§6.2).

**Behavior**

1. **Token.** `POST /api/v1/oauth/token` with an `application/x-www-form-urlencoded` body: `client_id`, `client_secret`, `grant_type=client_credentials` (as in the chatbot reference; not yet confirmed against a live Skydropx answer).
   - The token lasts 2 h (`expires_in`). It is reused until 5 minutes before it expires.
   - Requests that arrive at the same time share one token refresh. A failed refresh is not cached.
   - A call answered `401` drops that token, gets a new one and is retried **once**.
2. **Rate limit.** Skydropx allows 2 requests per second. Every call, the token call included, starts at least 500 ms after the previous one. The limit holds within one backend process.
3. **Quotation.** `POST /api/v1/quotations` with:
   - `address_from`: the sucursal shipping origin (T2);
   - `address_to`: the destination;
   - one parcel: the T2 order package.

   Both addresses are country `MX` and need the postal code, state (`area_level1`), municipality (`area_level2`) and colony (`area_level3`). If any is missing, the quote fails without calling Skydropx. Parcel sizes go up to whole centimetres, and the weight is sent in kilograms (gram precision); Skydropx needs at least 1 cm and 1 kg.
4. **Polling.** The adapter calls `GET /api/v1/quotations/:id` every `SKYDROPX_POLL_INTERVAL_MS` until `is_completed` is `true`. Rates from a quotation that is not complete are never used.
5. **Deadline.** If the quotation is not complete within `SKYDROPX_QUOTE_DEADLINE_MS`, Skydropx fails for this quote. Each HTTP call gets the smaller of `SKYDROPX_REQUEST_TIMEOUT_MS` and what is left of that deadline, measured after the rate-limit wait; the `401` retry gets what is left after the token refresh. A call with nothing left is not sent. The token call is shared by concurrent quotes, so it keeps `SKYDROPX_REQUEST_TIMEOUT_MS` alone. The engine then uses the other carriers (§3.2), or answers `503 SHIPPING_QUOTE_UNAVAILABLE` when there are none. With the defaults, a quote ends within 12 s, before the engine's 15 s timeout. If you lower `SHIPPING_CARRIER_TIMEOUT_MS`, the deadline follows it.
6. **Rates.** A rate is used only when all of these hold:
   - `success` is `true`;
   - `error_messages` is empty;
   - `total` is a positive plain decimal (a `0` total is not a price, so it is skipped even though the chatbot reference accepts `≥ 0`);
   - and, depending on `status`:
     - **`status` present:** it is `approved`, `price_found_internal`, `price_found_external` or `coverage_checked`, and the currency, when sent, is MXN;
     - **`status` absent or `null`:** the chatbot reference checks hold instead: `currency_code` is exactly `MXN`; `provider_display_name` and `provider_service_name` are non-empty after trimming and at most 128 characters; `days` is a whole number ≥ 0; `total` is a canonical decimal (no padding or leading zeros, at most 2 decimals).

   Which of the two shapes Skydropx really sends is still to be confirmed in the sandbox (§6.2).

   Each usable rate becomes:

   | Option field | Value |
   | --- | --- |
   | `carrier` | `Skydropx/<provider display name>` |
   | `service` | The provider's service name |
   | `totalCents` | `total` (shipping + IVA + service fee) |
   | `etaDays` | `days`, or `null` when missing or not a whole number |
   | `rateId` | The rate `id` |
   | `validUntil` | The quotation request time + 24 h |

   `total` is converted to cents from its digits, never through float arithmetic. A third decimal rounds half up. Protection (`total_value_with_protection`) is not included.
7. **Errors.** Error messages hold only the method, path and HTTP status. They never contain response bodies, which can echo addresses back. A Skydropx `429` or `5xx` makes Skydropx fail for this quote; there is no retry inside the engine timeout.

Not included yet: buying the label with `rateId`, pickups, tracking, per-tenant Skydropx accounts, and limiting the quote to selected carriers (`requested_carriers`).

### 6.2 First live quote (operator)

1. Put `SKYDROPX_CLIENT_ID` and `SKYDROPX_CLIENT_SECRET` in the backend `.env`. For the sandbox, also set `SKYDROPX_BASE_URL=https://sb-pro.skydropx.com`.
2. Start the backend. Check that the startup log says `Skydropx carrier registered`.
3. Prepare the sucursal:
   - a shipping origin with postal code, state, municipality and colony;
   - a standard box;
   - packaging data on the products to quote;
   - a `CARRIER_ONLY` zone for the destination postal code.
4. Call `POST /chatbot-api/shipping/quotes` (§1) with a credential that has `shipping:quote`. A `201` with `zoneStatus: "CARRIER_ONLY"` and `option.carrier` starting with `Skydropx/` means the integration works.
5. A `503 SHIPPING_QUOTE_UNAVAILABLE` means no usable rate came back. The backend log gives the reason as `Skydropx quote failed: …` with the HTTP status or the deadline.

## 7. Verification at checkout

`ShippingQuoteVerifier.verify(quoteId, { tenantId, customer: { phoneCountryCode, phone }, lines, destination }, now?)` is exported by `ShippingQuotesModule` (re-exported by `ChatbotApiModule`). The rules are pure (`verifyShippingQuote`) and are checked in this order:

1. **`NOT_FOUND`:** a malformed id, an unknown id, or a quote of another sucursal.
2. **`EXPIRED`:** `now ≥ expiresAt`. It is checked before the binding, so an expired quote is rejected whatever the request says.
3. **`MISMATCH`:** returned with `mismatches` (any of `CUSTOMER`, `LINES`, `DESTINATION`):
   - **customer:** compares the digits of `phoneCountryCode` and `phone`;
   - **lines:** compares the multiset of `(productId, variantId|null, quantity)`, ignoring order;
   - **destination:** compares the `zipCode` exactly, plus `state` / `municipality` / `neighborhood`. Labels are trimmed, whitespace is collapsed, accents are removed and case is ignored; a blank label counts as `null`. A saved address and loose fields bind the same way.
4. **`OK`:** returns `quote: { id, costCents, creditCents, customerChargeCents, currency, expiresAt }`.

### 7.1 Use in checkouts and sales (T7)

`POST /chatbot-api/checkouts` (`sale.shipping`) and `POST /chatbot-api/sales` (`shipping`) take `{ "quoteId": "shq_…" }`. The full contract, with request and response JSON, is in `docs/chatbot-checkout-shipping.md`.

- **What is compared.** The checkout passes:
  - the request phone (`/sales`: the phone of `customerId`);
  - the sale lines;
  - the address it sells to: the saved, created or corrected address, or `shippingAddressId` on `/sales`.
- **Errors:**

| Verifier result | HTTP |
| --- | --- |
| `NOT_FOUND` | `404 SHIPPING_QUOTE_NOT_FOUND` |
| `EXPIRED` | `409 SHIPPING_QUOTE_EXPIRED` |
| `MISMATCH` | `409 SHIPPING_QUOTE_MISMATCH`, body `mismatches: ["CUSTOMER" \| "LINES" \| "DESTINATION", …]` |

- **Charge.** The sale is charged `customerChargeCents`. It is added to `totalCents` and to the debt, and the response shows it as `shippingChargeCents` (`0` in a FREE zone).
- **Single use.** The sale stores the quote **row** (`sales.shippingQuoteRecordId`, unique), never the quote id. The row is locked `FOR UPDATE` while the sale is created. A second sale with the same quote gets `409 SHIPPING_QUOTE_ALREADY_USED`. Under that lock the sale also re-checks `now ≥ expiresAt` (`409 SHIPPING_QUOTE_EXPIRED`), for checkouts and `/sales` alike. Quotes stay insert-only.
- **Idempotent replay.** The same `X-Idempotency-Key` with the same body returns the first sale. The quote is not checked again (an expired quote still replays), and it is not used a second time.

The old `{ chargeCents, approvalId, quoteId? }` shape is deprecated but still accepted. Its `quoteId` is not verified.

## 8. Code

| Path | What |
| --- | --- |
| `src/shipping/quotes/domain/` | Carrier port, `quoteCheapest` / `selectCheapestOption`, credit, ETA, binding/verify/expiry/token, repository port, errors. |
| `src/shipping/quotes/infrastructure/` | Prisma repository, fake carrier, carrier registry. |
| `src/shipping/quotes/infrastructure/skydropx/` | T6: Skydropx HTTP client (token, limiter), quotation + polling carrier, rate mapping, env config. |
| `src/shipping/quotes/shipping-quotes.module.ts` | Module (imports packaging + delivery zones). |
| `src/chatbot-api/application/shipping-quote.service.ts` | Bot quote flow. |
| `src/chatbot-api/presentation/shipping-quotes.controller.ts` | Route and error mapping. |
| `src/chatbot-api/application/bot-shipping.ts` | T7: `shipping` shapes and quote error mapping for checkouts and sales. |
