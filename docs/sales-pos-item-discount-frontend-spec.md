# Sales POS Item Discount — Backend Contract for Frontend

## Why this exists
Frontend POS now supports per-item discounts (amount or percentage) in draft sales, including visual badge state, tooltip title, and remove flow. Backend must provide explicit discount endpoints and canonical sale-item state so frontend can avoid local pricing drift and keep pricing/audit behavior deterministic.

## Goals
- Enable apply/remove discount per draft sale item.
- Keep backend as source of truth for final `unitPriceCents` and discount resolution.
- Preserve auditability (reason/title, actor, timing, before/after values).
- Define deterministic interactions with price overrides and quantity changes.

## Endpoint Summary

| Method | Path | Purpose | Auth/Permission |
|---|---|---|---|
| PATCH | `/sales/drafts/:saleId/items/:itemId/discount` | Apply/replace item discount | `update:Sale` |
| DELETE | `/sales/drafts/:saleId/items/:itemId/discount` | Remove item discount | `update:Sale` |

Only allowed for draft sales owned by current user/session tenancy constraints.

## Request Schemas

### PATCH `/discount`

```json
{
  "type": "amount",
  "amountCents": 2000,
  "title": "Promo especial"
}
```

or

```json
{
  "type": "percentage",
  "percent": 10,
  "title": "Descuento empleado"
}
```

#### Validation rules
- `type` required: `amount | percentage`
- XOR contract:
  - if `type=amount`: `amountCents` required, `percent` forbidden
  - if `type=percentage`: `percent` required, `amountCents` forbidden
- `amountCents`: integer, `> 0`, and `< current unitPriceCents`
- `percent`: number, `> 0` and `<= 100`
- `title`: optional, trim, max 100 chars; empty after trim -> `null`
- reject if `unitPriceCents <= 0`
- reject if sale not DRAFT or item not found in sale

### DELETE `/discount`
No body.

## Response Schema
Both endpoints return full updated `Sale` object.

### Required `SaleItem` fields for discount support

```ts
discountType: 'amount' | 'percentage' | null
discountValue: number | null
discountAmountCents: number | null
discountTitle: string | null
prePriceCentsBeforeDiscount: number | null
```

Semantics:
- `discountValue`: original user-entered value (`amountCents` for amount, `percent` for percentage)
- `discountAmountCents`: resolved effective cents discount used for pricing
- `prePriceCentsBeforeDiscount`: unit price baseline before current discount was applied

## Pricing & Rounding Rules

### Amount mode
- `discountAmountCents = amountCents`
- `newUnitPriceCents = currentUnitPriceCents - discountAmountCents`

### Percentage mode
- `discountAmountCents = round(currentUnitPriceCents * percent / 100)`
- Rounding must use `Math.round` equivalent (half-up)
- `newUnitPriceCents = currentUnitPriceCents - discountAmountCents`

### Invariants
- `newUnitPriceCents >= 0`
- For now frontend expects `amountCents < currentUnitPriceCents` (strictly less), so unit price remains positive.
- Backend can allow 100% via percentage if business wants free items, but must be explicit and documented. If not allowed, return validation error.

## Business Interaction Rules

### Apply when already discounted
- Replace discount atomically (no stacking)
- Reset baseline from current non-discounted price context as needed by domain rule

### Remove discount
- Restore `unitPriceCents = prePriceCentsBeforeDiscount`
- Clear all discount fields to `null`

### Price override interaction (critical)
- Applying/changing price override should clear any active discount atomically.
- Returned item after price override must show all discount fields `null`.

### Quantity changes
- Discount is per-unit, not per-line.
- Quantity update must not mutate discount metadata.
- Line totals remain `unitPriceCents * quantity`.

## Error Catalog

| HTTP | Code (suggested) | Message (example) | Trigger |
|---|---|---|---|
| 400 | `DISCOUNT_INVALID_TYPE` | Invalid discount type | type not allowed |
| 400 | `DISCOUNT_INVALID_PAYLOAD` | Invalid discount payload | XOR violation / malformed body |
| 400 | `DISCOUNT_AMOUNT_INVALID` | Amount must be a positive integer | amount <= 0 or non-integer |
| 400 | `DISCOUNT_PERCENT_INVALID` | Percent must be between 0 and 100 | percent out of range |
| 422 | `DISCOUNT_EXCEEDS_PRICE` | Discount exceeds item price | amount >= current price |
| 422 | `DISCOUNT_FREE_ITEM_FORBIDDEN` | Cannot discount free item | unitPriceCents <= 0 |
| 404 | `SALE_NOT_FOUND` | Sale not found | saleId invalid |
| 404 | `SALE_ITEM_NOT_FOUND` | Item not found | itemId invalid |
| 422 | `SALE_NOT_DRAFT` | Sale is not draft | status != DRAFT |
| 403 | `SALE_FORBIDDEN` | Forbidden | no permission / ownership mismatch |
| 409 | `SALE_VERSION_CONFLICT` | Version conflict | optional optimistic lock mismatch |

Frontend behavior expectation:
- On apply/remove error, frontend must not optimistically mutate final state.
- Modal remains open or shows error toast.

## Permissions & Security
- Enforce existing draft-sale ownership scope.
- Respect RBAC `update:Sale`.
- Validate title length server-side even if frontend validates.
- Escape/sanitize title in logs and downstream consumers.

## Audit Requirements
For compliance and traceability, log per discount mutation:
- actor user id
- sale id / item id
- operation (`apply_discount` / `remove_discount` / `replace_discount`)
- previous and new `unitPriceCents`
- previous/new discount metadata
- request payload snapshot (normalized)
- timestamp and request id/correlation id

Suggested audit table event payload:

```json
{
  "event": "apply_discount",
  "saleId": "...",
  "itemId": "...",
  "before": { "unitPriceCents": 10000, "discountType": null },
  "after": { "unitPriceCents": 8000, "discountType": "amount", "discountAmountCents": 2000 },
  "actorUserId": "...",
  "at": "2026-04-28T20:00:00Z"
}
```

## Acceptance Criteria
1. PATCH amount returns sale with reduced `unitPriceCents` and populated discount fields.
2. PATCH percentage uses deterministic rounding rule and returns resolved cents discount.
3. DELETE restores previous unit price and nulls discount fields.
4. Price override update clears active discount in same transaction.
5. Quantity updates preserve discount metadata.
6. Validation and permission errors return consistent code/message pairs.

## API Test Cases (backend)

### Happy path
1. Apply amount 2000 to item price 10000 -> final 8000, `discountType=amount`, baseline 10000.
2. Apply percentage 10 to price 20000 -> final 18000, `discountAmountCents=2000`.
3. Remove discount restores exact baseline.
4. Replace existing discount updates metadata and recalculates price correctly.

### Validation
5. `amountCents=0` -> 400.
6. `amountCents` non-integer -> 400.
7. `amountCents >= currentPrice` -> 422.
8. `percent=0` / `percent>100` -> 400.
9. XOR violation with both amount/percent -> 400.
10. Discount attempt on zero-priced item -> 422.

### Domain state
11. Non-draft sale -> 422.
12. Unknown sale/item -> 404.
13. Unauthorized user -> 403.

### Interaction
14. Apply discount then price override -> returned item has discount fields null.
15. Apply discount then qty update -> same per-unit discounted price; line total changed only by quantity.

### Rounding
16. Percentage rounding case: 9999 * 33% -> discount 3300, final 6699.
17. Percentage with decimals (e.g., 12.5%) behaves consistently with round-half-up.

## Frontend Contract Notes
- Frontend sends amount in major units converted to cents before request.
- Frontend title tooltip relies on `discountTitle` returned from backend.
- Frontend reads returned sale as canonical state after every mutation.
