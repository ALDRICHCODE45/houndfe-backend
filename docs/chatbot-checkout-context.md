# Chatbot checkout context (read-only business data)

`GET /chatbot-api/customers/checkout-context` is additive. Existing customer
GET/PUT and sale endpoints keep their semantics. This route does not create or
update customers, addresses, drafts, orders, reservations, payment or shipping.
The trusted chatbot application derives phone from its WhatsApp sender; the
model must never supply phone, tenant or customer identity. The service credential
authenticates that application, not a WhatsApp sender independently.

## Authentication and query

Use the existing service Bearer credential with `customers:read`. Credential/CLS
owns the tenant; an optional `X-Branch-Id` must match it. Existing rate limits,
credential-last-used telemetry and audit writes remain enabled. No phone/address
query or response data is added to audit metadata.

| Query              | Constraint                                                 |
| ------------------ | ---------------------------------------------------------- |
| `phoneCountryCode` | Digit string, length 1–10, no plus sign                    |
| `phone`            | Digit string, length 1–20                                  |
| `limit`            | Integer 1–20; omitted defaults to 10; never clamped        |
| `afterAddressId`   | Optional UUID; must belong to resolved customer and tenant |

Malformed input is HTTP 400; authentication/scope/branch/rate errors retain the
existing 401/403/429 responses. No caller-supplied tenant/customer field is accepted.

## Response

HTTP 200 always has exactly `status`, `customer`, `addresses`, `nextAfterAddressId`.
`status` is `not_found`, `unique` or `ambiguous`. The customer probe reads at most
two matching rows. Multiple matches are ambiguous, not newest-match selection.
Missing/ambiguous responses have `customer:null`, `addresses:[]`, and
`nextAfterAddressId:null`; no duplicate identities/counts are disclosed.

Unique customer: `{customerId, firstName, lastName}` with nullable `lastName`.
Unique with no address is distinct from customer absence. Each address contains:
`{id,version,label,street,exteriorNumber,interiorNumber,zipCode,neighborhood,
municipality,city,state,visualReferences,carrierPhone}`. Street is non-null; all
other delivery fields are nullable. `version` is ISO `updatedAt`: a freshness
marker, not a version counter. Discovery itself does not lock or edit the row;
[atomic checkout](chatbot-atomic-checkout.md) checks this exact version under a
row lock for `existing` and `existingUpdated`. Saved values are returned
unaltered, never silently truncated/normalized. Coordinates, billing, profile
comments and unrelated data are excluded by explicit database projection and
response mapping.

Addresses are ordered ascending `(createdAt,id)`; each lookup reads `limit+1`,
returns at most `limit` and uses the last emitted ID as `nextAfterAddressId` only
when another row is visible. Fetch one page per explicit request, never drain
unbounded pages automatically. On a uniquely resolved customer, a missing or
foreign cursor yields HTTP 400 with `error: INVALID_ADDRESS_CURSOR`, without
revealing whether it exists elsewhere. Customer is re-resolved on each page;
not_found/ambiguous short-circuit address reads. Read failures propagate as
failures, never customer absence. Pages are not a cross-request snapshot;
chatbot must revalidate selected address freshness before trusting confirmation.

### Unexpected read failure (new-route privacy boundary)

An unexpected read failure (customer probe, cursor probe or address page) can
carry sender phone or saved-address text in its driver/ORM message. This route
maps any non-HTTP error to a fixed safe envelope, HTTP 500:
`{statusCode:500, error:"CHECKOUT_CONTEXT_READ_FAILED",
message:"CHECKOUT_CONTEXT_READ_FAILED"}`. The bot audit row records the same
constant in `metadata.errorMessage` — the raw message is never written. The
failure stays a failure (never a synthetic `not_found`/`ambiguous`) and no write
occurs. Expected contract failures such as `INVALID_ADDRESS_CURSOR` remain
their existing 400, and legacy routes/filters/interceptors keep their current
verbatim-error semantics; the sanitization is scoped to this route only.

## Draft integration boundary

The chatbot hides raw IDs/cursors behind sender-bound server-owned references and
persists selection or new delivery data only in its local draft. This backend
route has no selection/write endpoint. Draft delivery limits follow the existing
customer delivery DTO: label100, street200, exterior/interior number20, zipCode10,
neighborhood/municipality/city100, visualReferences500, carrierPhone20;
state must be a `MEXICAN_STATES` value. A completed draft requires nonblank street.
Optional draft omission means unknown and null means unsupplied; neither is a
saved-profile clearing instruction. When submitting `existingUpdated` to
[atomic checkout](chatbot-atomic-checkout.md), send the complete desired address:
that write contract normalizes omitted optional fields to null, unlike a local
draft. Draft validation is chatbot-owned and does not truncate this read response.

## Offline verification and rollback

Mocked tests assert discriminants, nullable/safe projection, bounds and owned
keyset cursors, propagated errors, auth/audit and zero business mutations, while
retaining legacy route/service assertions. A public HTTP regression drives the
real `ChatbotApiService` (mock tenant client) for customer/cursor/address read
failures bearing phone/address text and asserts the exact safe 500 envelope plus
safe `audit.errorMessage`, with no sensitive string in the serialized response or
audit row. No DB/provider/live checks are used.

```sh
node node_modules/jest/bin/jest.js --config jest.config.js --runInBand --runTestsByPath src/chatbot-api/application/chatbot-api.service.spec.ts src/chatbot-api/presentation/chatbot-api.controller.spec.ts src/chatbot-api/presentation/guards/service-auth.guard.spec.ts src/chatbot-api/presentation/interceptors/bot-audit.interceptor.spec.ts
node node_modules/typescript/bin/tsc -p tsconfig.build.json --noEmit --incremental false
node node_modules/eslint/bin/eslint.js src/chatbot-api/presentation/chatbot-api.controller.ts src/chatbot-api/presentation/chatbot-api.controller.spec.ts
```

Rollback removes only this route, its service method/DTOs, audit-map entry,
the new-route failure sanitization, additive tests and this document. Runtime
deployment/rehearsal requires separate owner authorization. This increment does not change shipping/promotion authority
or register orders/customers; successfully-created-order registration is deferred.
