# O2 — Lots on variants (PROPOSAL, not implemented)

**Status: paper contract only.** Nothing in this file exists in the backend yet. The human chose «O1 implementado completo + documentación de O1, y el contrato propuesto de O2 solo en papel». Do not build UI against it until the backend marks it implemented in [README.md](README.md).

O2 depends on O1 ([01-inventory-journal.md](01-inventory-journal.md)) and reuses all of its conventions: movement types, buckets, `version` CAS, `Idempotency-Key`, the error envelope and `Page<T>`.

## 1. What changes for the user

| Today (after O1) | After O2 |
| --- | --- |
| A product **with variants** cannot have lots (`POST /products/:id/lots` rejects it). | Each variant can have its own lots, e.g. «Croquetas Adulto · 15 kg» lot `L-2026-11` and lot `L-2027-02`. |
| FEFO on sale applies only to products without variants. | FEFO applies per variant: a sale line of a variant consumes that variant's non-expired lots first, then its untracked portion. |
| Variant stock is a single bucket `VARIANT`. | A variant has an untracked bucket (`VARIANT_UNTRACKED`) plus one `LOT` bucket per lot of that variant. |

The rules are the same as O1 for products without variants, applied one level down:

- Invariant per variant: `variant.quantity >= sum(lots of that variant)`. The untracked portion is `variant.quantity − sum(lots)`.
- Expired lots are never sold.
- Adjusting a variant lot also moves `variant.quantity` and the product total.
- A lot belongs to exactly one variant of the same product and tenant. It cannot be moved between variants; to correct it, adjust it to 0 and create the lot on the right variant.

## 2. Proposed endpoints

| Operation | Change |
| --- | --- |
| `POST /products/:productId/variants/:variantId/lots` | **New.** Body `{ lotNumber, expirationDate, manufactureDate?, quantity? }`. A `quantity` creates an `INITIAL` movement. `lotNumber` is unique per variant. |
| `GET /products/:productId/variants/:variantId/lots` | **New.** Lots of the variant with `expired` and `version`. |
| `PATCH /products/:productId/variants/:variantId/lots/:lotId` | **New.** Same rules as the O1 lot `PATCH`: `quantity` is read-only (`STOCK_QUANTITY_READ_ONLY`). |
| `DELETE /products/:productId/variants/:variantId/lots/:lotId` | **New.** `409 LOT_HAS_STOCK` when quantity > 0. |
| `GET /inventory/products/:productId/stock` | **Extended.** Each entry in `variants[]` gains `untracked` and `lots[]`, with the same shape as the product-level `lots[]`. |
| `POST /inventory/adjustments` | **Extended.** `target` accepts `{ productId, variantId, lotId }`. The lot must belong to that variant (`404 NOT_FOUND` otherwise). |
| `GET /inventory/movements?variantId=…` | Unchanged shape. Rows for variant lots carry `variantId`, `lotId` and bucket `LOT`. |

The existing product-level lot routes keep working only for products without variants.

## 3. Proposed errors

- `409 PRODUCT_HAS_VARIANTS`: product-level lot routes are used on a product with variants. Today this case is a 400 from the products module; O2 would give it a stable code.
- `409 VARIANT_HAS_LOTS`: deleting a variant that still has lots with stock.

## 4. Open questions for the human (to ask before O2 starts)

1. When a variant's first lot is created on a variant that already has stock, should that stock stay untracked (recommended) or be assigned to the new lot?
2. Should the POS ever let the cashier pick a specific lot instead of FEFO? Recommended: no, FEFO only, as in O1.
3. Converting a product with lots to variants: block it until its lots are at 0 (recommended), or move the lots to the first variant?
