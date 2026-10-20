# Create a customer, destination and order atomically

`POST /chatbot-api/checkouts` creates or resolves the sender's customer, selects, appends or explicitly corrects a saved address, and confirms one credit order. The business writes and successful idempotency response commit together. A rejected transaction leaves no new customer, address or order and rolls back any address correction. Customer profiles are never overwritten; saved addresses change only with `existingUpdated`.

This is an additive API. Existing customer GET/PUT and `POST /chatbot-api/sales` remain unchanged. See [checkout discovery](chatbot-checkout-context.md) to select a unique customer and an existing address first.

## Quick path

1. Obtain sender phone, cashier and customer/address references from the trusted chatbot application, not free model input.
2. [Quote customer-aware pricing](chatbot-customer-pricing.md) with the same trusted sender phone. Use the returned pre-discount unit prices and final line totals, then confirm the intended cart, address and final amount; generate and persist one idempotency key for that exact checkout.
3. POST the checkout. On timeout, 5xx or an in-flight response, keep the cart locked and retry the **same request and key**.
4. GET `/chatbot-api/checkouts/status` with that key to recover a committed result. `not_observed` is **not** proof that the request failed.

Neither endpoint takes tenant information from the request body. Service credential ownership determines the tenant. Both require **all** scopes `customers:write` and `sales:create`.

## Headers

| Header | Rule |
| --- | --- |
| `Authorization` | Existing `Bearer svc_…` service authentication. |
| `X-Branch-Id` | Optional existing guard behavior: if supplied, must equal credential tenant. |
| `X-Idempotency-Key` | Required for POST and GET; trimmed, nonempty, at most 200 characters after trimming. |
| `Content-Type` | `application/json` for POST. |

Keys belong in the header, not a URL or query string. Authentication, credential activity, branch ownership and existing rate limits apply unchanged.

## POST request

All top-level and nested properties not defined here are rejected. The following is a valid creation intent; UUID values are placeholders to replace with trusted application references.

```json
{
  "phoneCountryCode": "52",
  "phone": "5512345678",
  "customer": {
    "mode": "createIfAbsent",
    "firstName": "Ana",
    "lastName": "Pérez"
  },
  "deliveryAddress": {
    "mode": "newSaved",
    "address": {
      "label": "Home",
      "street": "Example Street",
      "exteriorNumber": "12",
      "interiorNumber": null,
      "zipCode": "01000",
      "neighborhood": null,
      "municipality": null,
      "city": null,
      "state": null,
      "visualReferences": null,
      "carrierPhone": null
    }
  },
  "sale": {
    "cashierUserId": "<cashier-uuid>",
    "items": [
      {
        "productId": "<product-uuid>",
        "variantId": null,
        "productName": "Example product",
        "variantName": null,
        "quantity": 1,
        "unitPriceCents": 10000
      }
    ],
    "expectedTotalCents": 10500,
    "shipping": {
      "chargeCents": 500,
      "approvalId": "<trusted-human-approval-reference>",
      "quoteId": "<trusted-quote-reference>"
    }
  }
}
```

For a known customer, replace the complete `customer` object with:

```json
{ "mode": "existing", "customerId": "<customer-uuid>" }
```

For an existing saved address, replace the complete `deliveryAddress` object with:

```json
{
  "mode": "existing",
  "addressId": "<address-uuid>",
  "expectedVersion": "2026-10-13T22:00:00.000Z"
}
```

To correct a saved address in place, replace the complete `deliveryAddress` object with:

```json
{
  "mode": "existingUpdated",
  "addressId": "<address-uuid>",
  "expectedVersion": "2026-10-13T22:00:00.000Z",
  "address": {
    "label": "Home",
    "street": "Corrected Street",
    "exteriorNumber": "12",
    "interiorNumber": null,
    "zipCode": "01001",
    "neighborhood": null,
    "municipality": null,
    "city": null,
    "state": null,
    "visualReferences": "Blue gate",
    "carrierPhone": null
  }
}
```

`address` uses exactly the same nested fields and validation as `newSaved`. This is a **complete replacement**, not a patch: omitted optional fields normalize to null. Send every value that should remain saved.

For both existing-address modes, `expectedVersion` must be the exact canonical UTC ISO `version` returned by checkout discovery. The row is locked `FOR UPDATE`, scoped by address ID, credential tenant and resolved owning customer. Missing, other-customer and other-tenant addresses all return HTTP 404 `SHIPPING_ADDRESS_NOT_FOUND`; a mismatched version returns HTTP 409 `ADDRESS_VERSION_CONFLICT` before comparison or mutation. It is an `updatedAt` freshness marker, not a version counter. There is no fallback to another address.

For `existingUpdated`, normalized fields identical to storage cause **no address write**: resolution is `existing`, with the same ID and version. Otherwise the address is updated in place, resolution is `updated`, and version is its new `updatedAt` ISO string. The new sale uses the same address ID and snapshots the corrected fields. Any sale failure rolls back the correction, including its version and coordinates. Earlier confirmed orders and their delivery-route reads keep their original snapshots.

Coordinates are not accepted in the body. Changing any of `street`, `exteriorNumber`, `interiorNumber`, `zipCode`, `neighborhood`, `municipality`, `city` or `state` clears **both** `latitude` and `longitude` to null. Changing only `label`, `visualReferences` or `carrierPhone` preserves coordinates. All other address columns absent from the `newSaved` body are preserved.

### Customer and address rules

| Field | Validation |
| --- | --- |
| `phoneCountryCode` | Required string of 1–10 ASCII digits. |
| `phone` | Required string of 1–20 ASCII digits. No `+`, spaces or silent punctuation stripping. |
| `firstName` | Required for `createIfAbsent`, nonblank string, at most 100 characters. |
| `lastName` | Optional string of at most 100 characters or null; omission means null only on a newly created customer. |
| `street` | Required for `newSaved` / `existingUpdated`, nonblank string; see existing validation limitation below. |
| `label` | Optional/null, at most 100 characters. |
| `exteriorNumber`, `interiorNumber`, `carrierPhone` | Optional/null, at most 20 characters. |
| `zipCode` | Optional/null, at most 10 characters. |
| `neighborhood`, `municipality`, `city` | Optional/null, at most 100 characters. |
| `state` | Optional/null; existing `MEXICAN_STATES` enum, not free text. |
| `visualReferences` | Optional/null, at most 500 characters. |

Omitted optional address fields become null on the new row (`newSaved`) or corrected row (`existingUpdated`). `existing` never mutates the address. Coordinates, billing and preferred-payment fields are not accepted.

Existing validation limitation (unchanged): the shared checkout street subclass's nonblank decorator shadows its inherited length validation under the current validator. The nominal 200-character street maximum is not enforced by either `newSaved` or `existingUpdated`; this increment preserves their identical validation rather than changing existing-mode behavior.

Phone lookup is tenant-qualified and stops at two matches. An ambiguous sender is rejected; the API never guesses a customer. `existing` requires the unique phone match to have exactly the supplied customer ID. `createIfAbsent` creates on zero matches, or reuses a unique match without changing its name/profile. `resolution` in the response reports which happened. New addresses are appended only if the order succeeds. Existing address ownership must match both tenant and customer.

UUID syntax follows the existing validator. IDs are exact opaque strings; do not lowercase or case-fold them for identity comparisons. The cashier must have a membership in the credential tenant.

### Sale and approved shipping

`sale.items` requires at least one item. `productId` and `cashierUserId` are UUIDs; `variantId` is optional UUID/null; `productName` is a nonempty string, `variantName` optional string/null. Quantity is a positive safe integer. Unit price is a nonnegative safe integer no larger than the signed 32-bit storage limit.

`expectedTotalCents` is **required**, nonnegative and at most `2147483647`. Live product pricing, the full existing POS promotion engine, promotion capacity, stock, folio and confirmation/outbox invariants remain enforced by `SalesService.confirmBotSale`. Display names/prices are not price authority.

`shipping` is optional but cannot be null. Omit it for an order without a charged freight snapshot. When present:

- `chargeCents`: integer `1..2147483647`, also within the owner-configured `BOT_SHIPPING_CHARGE_MAX_CENTS`.
- `approvalId`: nonblank string, at most 200 characters; trimmed before persistence and hashing.
- `quoteId`: optional nonblank string, at most 200 characters; null is invalid, omission is allowed; trimmed before persistence and hashing.
- `expectedTotalCents`: positive, equal to recomputed merchandise total after discounts **plus approved freight**.

Missing/unusable shipping ceiling rejects new charged-shipping checkouts with `SHIPPING_CHARGE_UNAVAILABLE`. A successful replay does not create a new charge and is recovered even if the later ceiling changes. The authenticated chatbot asserts human approval; this endpoint does not obtain a carrier quote or independently validate the human approval's freshness. The existing tenant-wide shipping approval uniqueness constraint remains in force. A stale expected total or reused approval rolls back new customer/address writes too.

## POST success: HTTP 201

```json
{
  "status": "created",
  "customer": {
    "resolution": "created",
    "customerId": "<customer-uuid>",
    "firstName": "Ana",
    "lastName": "Pérez"
  },
  "address": {
    "resolution": "created",
    "id": "<address-uuid>",
    "version": "<updatedAt ISO UTC>"
  },
  "sale": {
    "saleId": "<sale-uuid>",
    "folio": "<folio>",
    "paymentStatus": "CREDIT",
    "channel": "ONLINE",
    "deliveryStatus": "PENDING",
    "totalCents": 10500,
    "subtotalCents": 10000,
    "shippingChargeCents": 500,
    "discountCents": 0,
    "paidCents": 0,
    "debtCents": 10500,
    "confirmedAt": "<ISO UTC>"
  }
}
```

Customer resolution is `created | existing`. Address resolution is `created | existing | updated`; `updated` occurs only for a changed `existingUpdated` body and returns `{ "resolution": "updated", "id": "<same address-uuid>", "version": "<new updatedAt ISO UTC>" }`. Identical `existingUpdated` returns `existing` with unchanged version; `newSaved` still returns `created`. The enclosing success shape and HTTP 201 are unchanged. `sale` uses `BotSaleResponse` (folio/confirmedAt types allow null); subtotal and shipping charge are included only when freight is charged. This is a credit order, not payment collection, packaging, delivery-route assignment or carrier dispatch. API money is integer cents; user-facing chatbot input remains normal currency.

## Recover committed status: HTTP 200

`GET /chatbot-api/checkouts/status` uses the same authorization/scopes and `X-Idempotency-Key` header. It reads only `bot_checkout_create`, never legacy sale registration receipts.

```json
{ "status": "succeeded", "checkout": "<the complete original POST success object>" }
```

The placeholder above is an **object**, not a string in the actual response. If no committed successful result is visible:

```json
{ "status": "not_observed", "checkout": null }
```

An in-flight or delayed request may still succeed after `not_observed`. Keep the cart locked and retry the exact same POST/key. A positive lookup recovers the original IDs and result; a negative lookup does not authorize a new checkout/key.

## Idempotency and rollback

Identity is `(credential tenant, bot_checkout_create, trimmed key)`, so credential rotation within the same tenant does not duplicate a successful checkout. The SHA-256 canonical hash covers the complete intent: customer/address modes, exact IDs/version, names/address fields, sender phone, cashier, ordered items including display names, expected total and shipping charge/approval/quote. For `existingUpdated`, the hash includes mode, address ID, expected version and every normalized address field. Existing `existing` / `newSaved` canonical hashes are unchanged. Optional nullable omission/null are equivalent only where validation allows them; shipping omission/null are not interchangeable because null is rejected.

Same successful key/hash returns the original HTTP 201/body without additional business writes. Changed semantic payload returns `IDEMPOTENCY_KEY_CONFLICT`. A demonstrably busy key returns `IDEMPOTENCY_KEY_IN_FLIGHT`. Neither a rejected request nor a rolled-back transaction reserves the key. Successful receipts have no automatic expiry/deletion.

The operation takes transaction-scoped key/phone locks, uses the ambient transaction for sale confirmation, and writes only a `SUCCEEDED` result in that same transaction. There is no separately committed `IN_FLIGHT` row or success stamp after sale commit. Unexpected connection/response failures can still occur **after a successful commit**: 5xx/timeout is not evidence of rollback. Always recover using the same key.

## Errors

New-route controlled errors are fixed code-only envelopes; arbitrary domain/driver messages and details are never copied into the response or audit error message:

```json
{ "statusCode": 409, "error": "CUSTOMER_PHONE_AMBIGUOUS", "message": "CUSTOMER_PHONE_AMBIGUOUS" }
```

| HTTP | Code / meaning |
| --- | --- |
| 400 | `INVALID_CHECKOUT_REQUEST`, `INVALID_IDEMPOTENCY_KEY`. |
| 404 | `CUSTOMER_NOT_FOUND`, `SHIPPING_ADDRESS_NOT_FOUND`, `CASHIER_NOT_FOUND`; missing/foreign identities are not distinguished. |
| 409 | `CUSTOMER_PHONE_AMBIGUOUS`, `ADDRESS_VERSION_CONFLICT` (both existing-address modes), `IDEMPOTENCY_KEY_CONFLICT` (including a different correction body under the same key), `IDEMPOTENCY_KEY_IN_FLIGHT`. |
| 409 | Existing `PRICE_OUT_OF_DATE`, `PROMO_RE_QUOTE`, `STOCK_INSUFFICIENT_AT_CONFIRM`, `SHIPPING_APPROVAL_ALREADY_USED` and promotion-capacity conflicts. |
| 422 | Existing shipping policy or other typed domain-rule rejections; code only, no raw details. |
| 503 | `CHECKOUT_RETRY_REQUIRED`; retry the same request/key, never assume the cart is safe to replace. |
| 500 | `CHECKOUT_CREATE_FAILED`, also the fixed code for unexpected status-read failures. |

Existing guard 401/403/429 envelopes are unchanged. Audit actions are `checkouts.create` and `checkouts.status` with route/status/outcome only; body, phone/address and idempotency key are not included. Credential last-used/rate-limit/audit telemetry is not business data and is not rolled back with the order.

## Boundaries and verification

New checkout writers serialize same-phone creation even with different keys. This is **not global phone uniqueness against legacy/admin writers**, which do not participate in the new lock protocol. Duplicate existing phone rows remain representable and are rejected, not cleaned up. This feature adds no schema migration or legacy uniqueness change.

Address row locking/version validation guarantees the selected or corrected saved address at commit. Confirmed sales use immutable delivery snapshots; their address foreign key remains a reference, not the source of historical destinations. A correction changes neither a previous order nor a route stop's snapshot-backed address projection.

Unit command (no database access):

```bash
node node_modules/jest/bin/jest.js --config jest.config.js --runInBand --runTestsByPath src/chatbot-api/presentation/checkout.controller.spec.ts
```

Real PostgreSQL proof requires an explicitly owned disposable database named `atomic_checkout_test` on `127.0.0.1` with an explicit port and already applied project migrations. The fixture refuses unset/remote/wrong-name targets, reads no dotenv files, deletes only its own seeded tenant/users, and never invokes the default integration setup or package manager:

```bash
ATOMIC_CHECKOUT_TEST_DATABASE_URL='<explicit owned disposable loopback URL>' \
node node_modules/jest/bin/jest.js --config jest.config.js --runInBand \
  --testPathIgnorePatterns /node_modules/ \
  --runTestsByPath src/chatbot-api/presentation/checkout.integration.spec.ts
```

The `existingUpdated` cases cover in-place replacement and corrected-sale snapshots, full rollback on re-quote and late failure, stale/foreign/missing address rejection, exact replay and changed-body conflict, normalized no-op/version preservation, each location field invalidating coordinates, metadata-only coordinate preservation, and a previous confirmed order attached to a persisted route stop retaining its original address. Existing/newSaved tests remain unchanged.

The fixture exercises real ambient transactions, actual sale confirmation/repository/folio persistence, `PrismaPromotionUsageRepository`, `PrismaProductRepository`, `PrismaStockAlertStateRepository`, `OutboxWriterService` and persisted service credentials through the actual credential repository/guard. Pricing and promotion-demand selection remain deterministic: this is not proof of production promotion evaluation or carrier behavior.

The additional S7 cases observe real promotion usage/counter, stock-alert and all three outbox writes **before** a late failure, then verify rollback and same-key recovery. Independent connections attempt non-advisory customer/address updates and deletes while checkout holds the rows; PostgreSQL `lock_timeout`/`55P03` proves blocking, followed by `FOR UPDATE NOWAIT` after commit to prove release. These are legacy-style SQL writers, not a test of the legacy HTTP PUT handler. Separate cases check two tenant-owned credentials sharing the same phone/key, actual persisted credential revocation/rotation and real database `P2002` recovery. The unique-error test deliberately inserts a separately committed receipt through a non-cooperating fixture writer; two cooperating checkout writers cannot bypass the key lock. It references an already committed fixture sale and never mocks the Prisma error.

For the bounded additional-evidence recheck, append `--testNamePattern='S7 gap'` to the PostgreSQL command above; this runs only the ten gap cases and skips the seven prior cases. Physical probes supplement the public HTTP responses for ledgers without a public listing API. Credential/audit telemetry is outside the business rollback guarantee.

Existing unit suites cover the unchanged pricing/promotion/sale behavior. Independent verification and native review are separate proof steps; these commands do not deploy or authorize publication.
