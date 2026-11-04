# O1 — Inventory journal (kardex, adjustments, FEFO)

**Status: implemented** and merged to local `main`. Every stock change is now an immutable **movement**. Stock can no longer be typed into the product, variant or lot forms. It changes only through:

- an adjustment with a reason,
- a sale or a sale cancellation,
- and later, receipts (O4).

Human decisions behind this file (2026-11-04, relayed by the FE session):

| # | Decision |
| --- | --- |
| P1 | The current stock becomes an automatic «Apertura» movement. |
| P2 | Direct quantity edits are blocked. |
| P3 | Fixed adjustment reasons; «Otro» requires a note. |
| P4 | Negative stock is never allowed. |
| P5 / S1 | Stock is per sucursal, and a sucursal **is** a tenant, as today. There is no branch selector. |
| P7 | A sale consumes the lot that expires first (FEFO). |
| P8 | `/orders` is retired. |

Decisions the backend took while the human slept are marked **[BE decision]**. Review them in the morning.

## 1. Concepts

### Stock buckets

A product's stock lives in **buckets**. Every movement changes exactly one bucket.

| Bucket | When it exists | What it holds |
| --- | --- | --- |
| `PRODUCT_UNTRACKED` | Product without variants | The product stock that is not assigned to a lot. |
| `LOT` | Each lot of a product without variants | The lot quantity. |
| `VARIANT` | Each variant of a product with variants | The variant quantity. Lots on variants arrive in O2. |

For a product without variants:

```text
product.quantity = untracked.quantity + Σ lots.quantity      (always ≥ Σ lots)
sellable         = product.quantity − Σ quantity of expired lots
```

For a product with variants, `product.quantity` is the sum of its variants and `untracked.quantity` is 0.

**[BE decision]** A lot is part of the product total, not something added on top of it. Creating a lot with quantity 10 raises the product total by 10.

### Expired lots

A lot is **expired** when its expiration calendar date is before today in the business timezone (`America/Mexico_City`). A lot that expires today is still sellable today. **[BE decision]**

Expired stock is never sold. It stays visible in the stock view (`expired: true`) until someone adjusts it out, for example with an adjustment of reason `EXPIRED`.

### Versions (optimistic concurrency)

Each bucket has a `version`. Any movement on that bucket bumps it: a sale, a cancellation, an adjustment, initial stock or a removal.

An adjustment must send the `version` the user saw. If it changed meanwhile, the backend answers `409 STOCK_VERSION_CONFLICT`. The FE should then reload the stock and show the new balance before letting the user retry.

Two notes on versions:

- A lot movement bumps only that lot's version, never the untracked version.
- Versions start at 0.

Every stock write bumps the version of the bucket it touches, with no exception: that includes cancelling a sale charged before the journal existed (it is written as `SALE_CANCELLATION` rows like any other cancellation, so a stale `expectedVersion` is rejected with `409 STOCK_VERSION_CONFLICT`).

**`stockVersion` in product responses.** Lot and variant rows returned by the products endpoints carry a `stockVersion` field. It is the same number as the `version` of that bucket in §3.1. The endpoints are:

- `GET /products/:id/lots`
- `PATCH /products/:id/lots/:lotId`
- `POST /products/:id/lots` (`addLot`)
- `POST /products/:id/variants`
- `PATCH /products/:id/variants/:variantId`

Treat it as read-only information. The FE may ignore it, or use it as the `expectedVersion` right after one of those calls. Any later movement makes it stale, so before an adjustment read the buckets again with §3.1 and use that `version`.

### Opening («Apertura»)

When the journal was switched on, the migration wrote one `OPENING` movement (actor `Sistema`) for every non-variant product, variant and lot with a quantity other than 0. **[BE decision]** One adjustment came with it: for a product with lots, the invariant is `product.quantity >= sum(lot.quantity)`. Where the stored lot sum was larger than the product quantity, the migration **raised `product.quantity` to the lot sum**, and the `OPENING` rows reflect the raised value. So after the switch-on a product's total can be higher than what the old screen showed. The untracked portion (`quantity − sum(lots)`) is never negative.

### Movement types

| `type` | Produced by | `delta` |
| --- | --- | --- |
| `OPENING` | One-time migration: the stock that existed when the journal was switched on. Actor `Sistema`. | + |
| `INITIAL` | Creating a product, variant or lot with a quantity. | + |
| `ADJUSTMENT` | `POST /inventory/adjustments`. | ± |
| `SALE` | POS charge or bot sale confirmation. One row **per bucket consumed**. | − |
| `SALE_CANCELLATION` | Cancelling a charged sale. It restores exactly the buckets the sale consumed. | + |
| `REMOVAL` | Stock that disappears with its row. It carries `removalCause`. | − |

`removalCause` is one of:

- `PRODUCT_DELETED`
- `VARIANT_DELETED`
- `FIRST_VARIANT_ZEROING`: the product had stock and its first variant was created.

### Adjustment reasons

The reason codes are fixed. Show the Spanish label to the user and send the code.

| `reason` | Label | `note` |
| --- | --- | --- |
| `PHYSICAL_COUNT` | Conteo físico | optional |
| `DAMAGE` | Merma/daño | optional |
| `EXPIRED` | Caducado | optional |
| `THEFT_LOSS` | Robo/pérdida | optional |
| `DATA_ENTRY_CORRECTION` | Corrección de captura | optional |
| `OTHER` | Otro | **required**, not blank, ≤ 500 characters |

Notes are trimmed. A blank note on a reason other than `OTHER` is stored as `null`.

## 2. Permissions

These subjects are new and granular. Users with sales or products permissions do not get them automatically, and there are no default grants: an admin assigns them per user in the roles/permissions UI.

| Subject | Action | Needed for |
| --- | --- | --- |
| `InventoryJournal` | `read` | Stock view and kardex. |
| `InventoryAdjustment` | `create` | Creating adjustments. It also requires `InventoryJournal:read`, because the response carries the stock snapshot. |

No second approval exists.

## 3. Endpoints

All three endpoints need the JWT and the tenant context, like every other authenticated route.

Errors use the procurement envelope `{ "statusCode": 409, "error": "CODE" }`, with `Cache-Control: no-store`.

### 3.1 `GET /inventory/products/:productId/stock`

Permission: `InventoryJournal:read`. It takes no query string.

```json
{
  "product": {
    "id": "8d0c…",
    "name": "Croquetas Adulto 15 kg",
    "useStock": true,
    "quantity": 42,
    "untracked": { "quantity": 12, "version": 3 },
    "sellable": 34
  },
  "lots": [
    { "id": "l-1", "lotNumber": "L-2026-10", "expirationDate": "2026-10-31", "quantity": 8, "expired": true, "version": 1 },
    { "id": "l-2", "lotNumber": "L-2027-01", "expirationDate": "2027-01-15", "quantity": 22, "expired": false, "version": 5 }
  ],
  "variants": []
}
```

The fields behave as follows:

- `lots` are ordered by expiration date ascending, then by id. This is the FEFO order.
- `sellable` is `null` when `useStock=false` or the product is a SERVICE.
- For a product with variants, `lots` is empty and `variants` lists `{ id, label, quantity, version }`.

Errors:

| Status | Code | When |
| --- | --- | --- |
| 404 | `NOT_FOUND` | Unknown product, or a product of another tenant. |
| 403 | `FORBIDDEN` | The user lacks `InventoryJournal:read`. |
| 401 | `UNAUTHORIZED` | No session, or the session is not valid. |

### 3.2 `GET /inventory/movements` (kardex)

Permission: `InventoryJournal:read`.

Query parameters:

| Parameter | Rules |
| --- | --- |
| `productId` | Required. |
| `variantId` or `lotId` | Optional, mutually exclusive. Sending both is `400 MALFORMED`. |
| `cursor` | Optional. Opaque, signed, and bound to tenant, product, variant and lot. |
| `limit` | Default 25, maximum 100. A larger value is `400 MALFORMED`. |

The response is a `Page<Movement>` ordered **newest first**:

```json
{
  "items": [
    {
      "id": "m-9",
      "type": "SALE",
      "bucket": "LOT",
      "productId": "8d0c…",
      "variantId": null,
      "lotId": "l-2",
      "labels": { "product": "Croquetas Adulto 15 kg", "variant": null, "lot": "L-2027-01" },
      "delta": -2,
      "balanceAfter": 22,
      "productBalanceAfter": 42,
      "reason": null,
      "note": null,
      "removalCause": null,
      "group": { "type": "SALE", "id": "sale-123" },
      "actor": { "displayName": "María López" },
      "createdAt": "2026-11-04T15:02:11.120Z"
    }
  ],
  "nextCursor": "eyJ…"
}
```

Each field means:

- `balanceAfter` is the balance of **that bucket** after the movement.
- `productBalanceAfter` is the product total after the movement.
- `labels` are snapshots taken at the time of the movement, so a renamed or deleted product still reads correctly.
- `group` ties together the rows of one operation:
  - `SALE` with the sale id, for sales and their cancellations;
  - `ADJUSTMENT` with the adjustment id;
  - `PRODUCT` with the product id, for `INITIAL` and `REMOVAL`.
- `nextCursor: null` means this is the last page.
- An unknown product, or a product of another tenant, returns an **empty page**, not a 404. A deleted product still returns its full history (including the `REMOVAL` rows), because history outlives deleted rows.

Suggested kardex UI:

- One row per movement, showing the date, type label, bucket (lot number or variant label, or «Sin lote»), signed delta, bucket balance, product total, reason/note and actor.
- Group consecutive rows with the same `group.id` (see §4.3).
- Offer filter chips for lot and variant using `lotId` and `variantId`.

### 3.3 `POST /inventory/adjustments`

Permissions: `InventoryAdjustment:create` + `InventoryJournal:read`.

Required header: `Idempotency-Key: <uuid>`. Use one key per form submission, and reuse the same key when retrying after a network error.

The body is **closed**: unknown keys return `400 MALFORMED`.

```json
{
  "target": { "productId": "8d0c…", "lotId": "l-1" },
  "expectedVersion": 1,
  "delta": -8,
  "reason": "EXPIRED",
  "note": "Lote vencido retirado del anaquel"
}
```

The `target` selects the bucket:

- `{ productId }` targets the untracked bucket of a product without variants.
- `{ productId, lotId }` targets a lot.
- `{ productId, variantId }` targets a variant.
- On a product with variants, `{ productId }` alone returns `404 NOT_FOUND`.

The other fields:

| Field | Rules |
| --- | --- |
| `expectedVersion` | Integer ≥ 0. It is the `version` of the targeted bucket, taken from §3.1. |
| `delta` | Signed integer. It cannot be 0, and its absolute value is at most 1,000,000,000. A result above 2,147,483,647 is `400 MALFORMED`. |

The adjustment takes a **delta**, not a target count. **[BE decision]** For a «Conteo físico», compute `delta = counted − bucket quantity shown`. The version check guarantees the shown quantity is still current.

Success is `201 { "movement": Movement, "stock": <same shape as §3.1> }`. A replay with the same key and the same body returns the same `201` body and does not write a second movement.

| Status | Code | When |
| --- | --- | --- |
| 400 | `MALFORMED` | Invalid JSON, unknown keys (including `tenantId`), missing or invalid fields, a missing `Idempotency-Key` header, `delta` 0, `OTHER` without a note (or with a blank one, or one over 500 characters), `variantId` together with `lotId`. |
| 401 | `UNAUTHORIZED` | No session, or an inactive user. |
| 403 | `FORBIDDEN` | A permission is missing. |
| 404 | `NOT_FOUND` | The product, lot or variant does not exist, belongs to another tenant, or does not match the target. |
| 409 | `STOCK_VERSION_CONFLICT` | The bucket changed since it was read. Reload and retry with a **new** key. |
| 409 | `INSUFFICIENT_STOCK` | The result would leave the bucket or the product total below 0. Nothing is changed. |
| 409 | `STOCK_NOT_TRACKED` | The product has `useStock=false` or is a SERVICE. |
| 409 | `IDEMPOTENCY_KEY_CONFLICT` | The same key was already used with a different body. |
| 409 | `IDEMPOTENCY_KEY_IN_FLIGHT` | The same key is being processed right now. Retry shortly with the same key. |
| 500 | `INTERNAL_ERROR` | Unexpected failure. |

## 4. Changes to existing endpoints

### 4.1 Products, variants and lots: quantity is read-only

These requests return `400` with the products error body if the body contains a `quantity` key, even when its value is `0` or `null`. Nothing is changed.

- `PATCH /products/:id`
- `PATCH /products/:id/variants/:variantId`
- `PATCH /products/:id/lots/:lotId`

```json
{ "statusCode": 400, "error": "STOCK_QUANTITY_READ_ONLY", "message": "…", "timestamp": "…" }
```

In the FE:

- Remove `quantity` from every PATCH payload.
- Show the stock as read-only, with an «Ajustar stock» action that opens the adjustment form (§3.3).
- Saving a product never changes its stock.

The create endpoints still accept an initial `quantity`, recorded as an `INITIAL` movement. One exception: when `useLotsAndExpirations` is `true`, the top-level `quantity` of `POST /products` is ignored, because the lots hold the stock (existing product rule). Send `quantity` on each inline lot instead. Units that belong to no lot can only be added afterwards with an adjustment that targets `{ productId }`.

- `POST /products`, including inline variants and lots
- `POST /products/:id/variants`
- `POST /products/:id/lots`

`POST /products/:id/lots` raises the product total by the lot quantity, and its response includes the new `stockVersion`.

Other rules on these endpoints:

- `DELETE /products/:id/lots/:lotId` on a lot with quantity > 0 returns `409 LOT_HAS_STOCK`, with `lotId` and `quantity` in the body. Adjust the lot to 0 first.
- Deleting a variant or a product with stock is allowed. It writes `REMOVAL` movements, and the history stays readable.
- Creating the first variant of a product that has stock zeroes the product stock with `REMOVAL FIRST_VARIANT_ZEROING`. This is the same behavior as before, now recorded. Warn the user before they do it.
- `PATCH /products/:id` with `type: "SERVICE"` while the product has stock or active lots returns `422 PRODUCT_TYPE_CHANGE_BLOCKED` (existing rule). Adjust the stock to 0 first.
- **[BE decision]** `PATCH /products/:id` with `useStock: false` while the product or a variant has stock returns `409 STOCK_TRACKING_HAS_STOCK`. Adjust the stock to 0 first. Before, the stock silently stayed hidden.

### 4.2 Sales (POS and bot)

Charging a sale (`POST /sales/drafts/:id/charge`) and confirming a bot sale consume stock through the journal:

- A variant line consumes its variant.
- A line of a product without variants consumes its **non-expired lots in FEFO order**:
  - by expiration date, then by lot id;
  - **split across lots** when the first lot does not cover the line;
  - with the rest taken from the untracked portion.
- A product with `useStock=false` writes nothing, as before.
- A sale cannot use stock held in expired lots. The draft availability check (`addItem` / `updateItemQuantity`) uses the same «sellable» rule.

**Contract change:** when stock is not enough at charge or confirmation time, the response is now `409`. Before, it was a `500`.

| Caller | Before | Now |
| --- | --- | --- |
| POS `POST /sales/drafts/:id/charge` | `500 {"statusCode":500,"message":"Internal server error"}` | `409 {"statusCode":409,"error":"STOCK_INSUFFICIENT_AT_CONFIRM","message":…}` |
| Bot `POST /chatbot-api/checkouts` | `500 {"statusCode":500,"error":"CHECKOUT_CREATE_FAILED"}` | `409 {"statusCode":409,"error":"STOCK_INSUFFICIENT_AT_CONFIRM"}` |

Show «Stock insuficiente» and reload the cart availability.

**Fail-closed code `SALE_STOCK_UNAVAILABLE`.** If the sales service were ever running without the stock journal wired in, charging, confirming a bot sale and cancelling would be refused with this code (the generic business-rule error body, `422`) instead of touching stock without a movement. In a deployed build the journal is always wired, so the FE should never see it: treat it as an unexpected server fault, show a generic error and do not retry.

The draft availability check (`POST /sales/drafts/:id/items` and `PATCH …/items/:itemId`) keeps the sales error body, not the 409 above. A quantity above the sellable stock answers `422 { "statusCode": 422, "error": "BUSINESS_RULE_VIOLATION", "message": "Insufficient stock for product …. Available: 62, Requested: 63" }`.

Cancelling a sale (`POST /sales/:id/cancel`) restores exactly the buckets the sale consumed, as `SALE_CANCELLATION` movements:

- the same lots, even if they have expired since;
- the untracked portion when a lot was deleted.

Three edge cases:

- Sales confirmed before the journal was switched on have no `SALE` rows. Cancelling one restores its lines to the product (untracked portion) or variant, and it is now journaled too: `SALE_CANCELLATION` rows with `group: { type: "SALE", id }`, a running balance, and a version bump. A line whose product no longer tracks stock (`useStock: false` or a service) or no longer exists is skipped. A sale confirmed after the switch-on that consumed nothing from the journal (all its lines were `useStock: false` or services) restores nothing: the backend tells the two cases apart by the confirmation date, not by the absence of `SALE` rows.
- Cancelling twice never restores twice. The second call answers `200` again and writes no rows.
- A POS sale is charged as `DELIVERED` by default, and a delivered sale cannot be cancelled: `409 SALE_DELIVERED_CANNOT_CANCEL`. Only sales charged with `delivery: true` (they stay `PENDING` until delivered) can be cancelled, so the restock on cancellation applies to those sales only. This is existing behavior on `main`, unchanged by O1: only where the stock goes back changed.

The movement actor is the cashier's name for POS sales and `Bot` for bot sales.

### 4.3 How FEFO looks in the kardex

Example: a product with lot A (expires 2026-12-01, 3 units), lot B (expires 2027-03-01, 10 units) and 5 untracked units. A sale of 15 units writes three rows with the same `group: { type: "SALE", id: "<saleId>" }`:

| bucket | lot | delta | balanceAfter | productBalanceAfter |
| --- | --- | --- | --- | --- |
| LOT | A | −3 | 0 | 15 |
| LOT | B | −10 | 0 | 5 |
| PRODUCT_UNTRACKED | — | −2 | 3 | 3 |

Rows of one group come out newest first, so the untracked row of the example above is listed before the lot rows. Render them as one operation, «Venta #…, −15», that can be expanded to show the split.

When the sale is cancelled, three `SALE_CANCELLATION` rows (+3 A, +10 B, +2 untracked) appear under the same sale id.

If the sellable stock does not cover the line, the whole charge fails with `409 STOCK_INSUFFICIENT_AT_CONFIRM` and nothing is written. A charge never partially consumes stock.

### 4.4 `/orders` retired

`POST /orders`, `PATCH /orders/:id/cancel` and the rest of `/orders` no longer exist (404). The FE did not use them.

## 5. Suggested FE screens

1. **Product detail → Inventario tab.**
   - Show the total, sellable and untracked quantities.
   - List the lots in FEFO order, with an «Vencido» badge, quantity and an «Ajustar» action on each.
   - For a variant product, list the variants with quantity and «Ajustar».
   - Below, show the kardex (§3.2) with infinite scroll.
2. **Adjustment dialog.**
   - Target: preselected from the row.
   - Mode: «Sumar / Restar», or «Conteo físico», where the FE computes the delta.
   - Quantity, reason (§1), and a note that is required for «Otro».
   - On submit, send `expectedVersion` = the row `version` and a fresh `Idempotency-Key`.
   - After success, update the stock view with the returned `stock`.
3. **Product/variant/lot forms.** `quantity` is editable only on create, read-only on edit.
4. **POS / bot errors.** Handle the new `409 STOCK_INSUFFICIENT_AT_CONFIRM` (§4.2).

## 6. Test data

See §7 of [README.md](README.md): tenant, login, granted permissions and the showcase products with ids, buckets, quantities and versions.

## 7. Known limits (O1)

- Lots on products **with variants** are not supported until O2 ([02-variant-lots-o2-proposal.md](02-variant-lots-o2-proposal.md)).
- Transfers between sucursales (tenants) do not exist. Use an adjustment out in one sucursal and an adjustment in in the other, with a reason.
- `GET /products` and `GET /products/:id` return `quantity` = product total (untracked + lots, expired lots included). Use it with `minQuantity` for list badges. Public catalog and POS catalog lists show the same `quantity`. Only the stock view (`sellable`), the charge and the draft availability check exclude expired lots. For a product with variants the stored `quantity` stays 0 (as on `main`): use `variantStockTotal` (sum of its variants) from `GET /products/:id`, and each variant's `quantity` against its own `minQuantity`.
