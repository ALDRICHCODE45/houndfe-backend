# Chatbot request inbox — resolve a decision and the zone preview

**Status:** implemented on `feat/human-intervention` (human-intervention unit 3, slice 3a), **not merged, not pushed, not deployed**. Contract: `docs/proposals/human-intervention-backend-proposal.md` §2.1–§2.4, §3.8, §12.6, §12.12, R4, R9.

Shapes in this document come from the controller, the body parser, the scoped filter and their specs (`src/chatbot-requests/**`) and from the PostgreSQL integration spec `chatbot-request-wrapping.integration.spec.ts`. Nothing was sent to the dev API.

**Not in this slice:**
- Existing stock, expiry, zone and receipt rows are **not** wrapped yet. Only decisions created from now on have a `ChatbotRequest`; the backfill of the pending ones comes in the next slice. Until then the inbox (unit 4) will not list older rows, and the old screens keep working for them.
- The read routes (`groups`, `counts`, `:id`, `history`) arrive with unit 4. `zoneImpact` is also part of the detail there; for now use the route in §3.
- `cancel` by the customer arrives with unit 5. A decision is never cancelled by staff (`422 CANCEL_NOT_ALLOWED`, handoff 11): it closes with its negative action.
- The bot's feed deliveries (answers to the customer) still leave through the old paths; this route only resolves.

## 1. Who can do what

| Route | CASL required |
| --- | --- |
| `POST /chatbot-requests/:id/resolve` | `read:ChatbotRequest` + `update:ChatbotRequest` |
| `GET /chatbot-requests/:id/zone-impact` | `read:ChatbotRequest` |

Same guards as handoff 11 (`JWT → tenant → active user → CASL`). The old permissions (`update:HumanDecision`, `validate:DeliveryZone`, `update:ReceiptEvidence`) are **not** needed here and do not grant these routes. The caller still needs a membership in the sucursal (`403 FORBIDDEN` otherwise).

## 2. `POST /chatbot-requests/:id/resolve`

Headers and response follow handoff 11 §2: `Idempotency-Key: <uuid>` is required (use a UUID v4), the body carries `expectedVersion` of the **request** (the `version` the FE holds), and the answer is `200 {request}` with the new version, `status: RESOLVED`, the resolver as `assignee` when the request was `NEW` (implicit claim) and `closedAt`. A replay of the same key and body answers the same stored body.

The body is flat: `expectedVersion`, `action` and the fields of that action. **Do not send `resolutionRequestId`** (the backend derives it from `Idempotency-Key`) and no other field: any extra or missing key is `400 VALIDATION_ERROR`. The request must belong to the matching subtype; an action of another subtype is `422 ACTION_NOT_ALLOWED`.

| `subtype` | `action` | Fields |
| --- | --- | --- |
| `RESTOCK` | `PROVIDE_RESTOCK_ESTIMATE` | `restockDays`: integer 1..365 |
| `RESTOCK` | `REPORT_RESTOCK_ESTIMATE_UNAVAILABLE` | none (not even `restockDays: null`) |
| `EXPIRATION` | `PROVIDE_EXPIRATION_TEXT` | `expirationText`: 1..500 chars |
| `EXPIRATION` | `REPORT_EXPIRATION_UNAVAILABLE` | none |
| `DELIVERY_ZONE` | `APPROVE_DELIVERY_ZONE` | `zoneType`: `FREE` \| `SURCHARGE` \| `CARRIER_ONLY`; `surchargeCents`, `etaDays` as the zone type requires (same rules as the zone screen); **`expectedZoneSetVersion`**: integer ≥ 1 |
| `DELIVERY_ZONE` | `REJECT_DELIVERY_ZONE` | **`expectedZoneSetVersion`** |
| `TRANSFER_RECEIPT` | `CONFIRM_RECEIPT` | `amountCents`: integer ≥ 1 (records the transfer payment on the sale) |
| `TRANSFER_RECEIPT` | `REJECT_RECEIPT` | `reason`: internal, 1..1000 chars; **`customerReason`**: 1..300 chars after trimming, **required** here (it is the text the bot sends the customer; the old route only defaulted it) |

Examples:

```json
{ "expectedVersion": 1, "action": "PROVIDE_RESTOCK_ESTIMATE", "restockDays": 7 }
{ "expectedVersion": 1, "action": "APPROVE_DELIVERY_ZONE", "zoneType": "SURCHARGE", "surchargeCents": 5000, "etaDays": 3, "expectedZoneSetVersion": 7 }
{ "expectedVersion": 2, "action": "REJECT_RECEIPT", "reason": "monto distinto", "customerReason": "El monto no coincide, envíanos otro comprobante." }
```

### Implicit claim

Resolving a `NEW` request claims it in the same write (no `claim` first). If someone else holds it: `409 REQUEST_CLAIMED_BY_OTHER` with `current.claimedBy`. If you hold it, it stays yours.

### What happens in the one transaction

The request becomes `RESOLVED` (the chosen option is kept as its `resolution`, and the audit gets one `RESOLVED` event `{action}`), the existing stock/expiry/zone/receipt use case runs with its own version (the wrapped row goes `1 → 2` as before; claim, release and reassign never touch it), and the customer group is refreshed. If the old use case refuses, **everything rolls back** and the request stays as it was.

## 3. Zone approval resolves every customer of that postal code (D15)

A zone validation is shared by every customer who asked about the postal code, so one decision settles all their requests.

1. Before the confirmation dialog: `GET /chatbot-requests/:id/zone-impact` (a `DELIVERY_ZONE` request; another subtype is `422 ACTION_NOT_ALLOWED`) answers `200`:

   ```json
   { "requests": 4, "customers": 3, "setVersion": 7 }
   ```

   `requests` and `customers` count the **open** requests of the postal code and their distinct customers. Show "Esto resolverá 4 solicitudes de 3 clientes".
2. Send `resolve` with `expectedVersion` (the request) and `expectedZoneSetVersion` = that `setVersion`.
3. If a customer joined or left since the preview: `409 ZONE_SET_CHANGED`, nothing is written, and `current.zoneImpact` holds the new `{requests, customers, setVersion}`. Show it and let the user confirm again with the new `setVersion`.
4. On success every sibling request of that postal code is `RESOLVED` too (audit: `RESOLVED` with `action: "SIBLING_RESOLVED"`, resolved by the same person). The FE should refetch the groups: each affected customer's group shrinks or disappears. `setVersion` only grows; treat it as an opaque number.

Two people resolving two siblings at the same time: exactly one `200`; the other gets `409 REQUEST_CLOSED`.

## 4. Errors

Envelope and `current` as in handoff 11 §2 (`{statusCode, code, message, current?}`; switch on `code`).

| Status | `code` | When | `current` |
| --- | --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Missing/invalid `Idempotency-Key`, bad `:id`, unknown or missing action, extra field (including `resolutionRequestId`), out-of-range value, `REJECT_RECEIPT` without `customerReason`, zone action without `expectedZoneSetVersion` | — |
| 401 | `UNAUTHORIZED` | No or expired JWT, inactive user | — |
| 403 | `INSUFFICIENT_PERMISSIONS` | Missing `read`/`update:ChatbotRequest` | — |
| 403 | `FORBIDDEN` | No membership in the sucursal | — |
| 404 | `NOT_FOUND` | No such request in this sucursal | — |
| 409 | `VERSION_CONFLICT` | `expectedVersion` is stale | ✓ |
| 409 | `REQUEST_CLAIMED_BY_OTHER` | Someone else holds the request | ✓ |
| 409 | `REQUEST_CLOSED` | Already `RESOLVED`/`CANCELLED`, resolved through the old route, resolved as a zone sibling, or the receipt is no longer pending | ✓ |
| 409 | `ZONE_SET_CHANGED` | The customers of the postal code changed since the preview | ✓ + `zoneImpact` |
| 409 | `IDEMPOTENCY_CONFLICT` | Same `Idempotency-Key` with another body or route | — |
| 422 | `ACTION_NOT_ALLOWED` | The request is not a decision (`kind` ≠ `DECISION`), the action belongs to another subtype, or a receipt's sale is no longer payable | ✓ |
| 500 | `INTERNAL_ERROR` | Unexpected failure; retry with the **same** key | — |

**Order of checks** (the first failing check answers): `400` → replay of the key → `404` → `REQUEST_CLOSED` → `422` (not a decision) → `REQUEST_CLAIMED_BY_OTHER` → `VERSION_CONFLICT` → `422` (action of another subtype) → `ZONE_SET_CHANGED` (zones only) → the old use case's own refusals above.

**Failed commands store nothing**, as in handoff 11.

## 5. Old routes keep working

`POST /human-decisions/:id/resolve`, `POST /delivery-zone-validations/:id/resolve` and the receipt `confirm`/`reject` routes behave exactly as before. When one of them resolves a row that has a request, that request is resolved in the same transaction (audit `RESOLVED` with `via: "LEGACY_ROUTE"`; a zone resolves every request of the postal code). A request therefore never shows `NEW`/`IN_PROGRESS` for a row that is already resolved, and the new `resolve` on it answers `409 REQUEST_CLOSED`. These routes are retired in unit 13.

## 6. Retry recipe

As handoff 11 §4: one `Idempotency-Key` per click, reuse it for network retries of the same attempt, and a new key after `409`/`422` plus a user decision. After `ZONE_SET_CHANGED`, a new attempt needs a new key and the new `expectedZoneSetVersion`.
