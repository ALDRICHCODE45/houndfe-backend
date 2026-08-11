# Product Service Type — Frontend Handoff

> Quick reference for the variant editor + product form. Backend is the source of truth; this document only enumerates the API contract changes that frontend must reflect.

## TL;DR

`type` can now be `SERVICE` (e.g. "Paseo de perros"). Service products are inventory-less — they don't take stock, can't have lots or SKUs/barcodes, and live behind a 1:1 `serviceDetail` row for capacity/notes.

---

## API deltas vs PRODUCT

### Create / update DTO — fields allowed per type

| Field | PRODUCT | SERVICE | Notes |
| --- | --- | --- | --- |
| `sku` | optional | **rejected (400)** | R1 |
| `barcode` | optional | **rejected (400)** | R1 |
| `brandId` | optional | **rejected (400)** | R1 |
| `useStock` | optional (default `true`) | forced to `false` | R1 |
| `useLotsAndExpirations` | optional | forced to `false` | R2 |
| `quantity`, `minQuantity` | optional | forced to `0` | R1 |
| `purchaseCost.valueCents` | optional | forced to `0` | R1 |
| `lots[]` | optional (with `useLotsAndExpirations=true`) | **rejected (400)** | R2 |
| `serviceDetail` | ignored | optional payload | R4 |
| `unit` | `UNIDAD, CAJA, BOLSA, METRO, CENTIMETRO, KILOGRAMO, GRAMO, LITRO` | also `HORA, SESION, DIA, CONSULTA, CURSO, PAQUETE` | R3 |

### `serviceDetail` payload

```json
{
  "capacity": 5,        // optional, integer, >= 1
  "notes": "Recoger en lobby a las 9:00"  // optional, string, <= 500 chars
}
```

If you omit `serviceDetail` on create, the row exists with both fields `null`. If you omit it on update, the existing row is **kept** (only `serviceDetail` in the DTO triggers an upsert).

### Type change (`PATCH /products/:id` with `type`)

- `PRODUCT → SERVICE`:
  - Backend returns 400 (`PRODUCT_TYPE_CHANGE_BLOCKED`) if `quantity > 0` or any active lot exists.
  - On success, backend forces `useStock=false`, `quantity=0`, `minQuantity=0`, clears `sku`/`barcode`/`brandId`, resets purchase cost to 0, and creates a fresh `ServiceDetail` row (empty by default).
- `SERVICE → PRODUCT`:
  - Always allowed. Backend restores PRODUCT defaults, clears `ServiceDetail`. Admin must add stock in a follow-up PATCH.

### Response shape — `GET /products` and `GET /products/:id`

```json
{
  "id": "...",
  "name": "Paseo de perros",
  "type": "SERVICE",
  "useStock": false,
  "quantity": 0,
  "minQuantity": 0,
  "sku": null,
  "barcode": null,
  "brandId": null,
  ...
  "serviceDetail": {
    "capacity": 5,
    "notes": "Recoger en lobby a las 9:00"
  }
}
```

For PRODUCT products, `serviceDetail` is always `null`.

### List filter

`GET /products?type=SERVICE` returns only services. Omitting the param returns both types (unchanged).

`GET /products?type=SERVICE&search=paseo` combines via `AND` — service products matching "paseo" anywhere in name/sku/barcode.

### Lots

`POST /products/:id/lots` on a SERVICE product returns 400 with code `LOTS_NOT_ALLOWED_ON_SERVICE`. Frontend must hide the lots tab/section when `product.type === 'SERVICE'`.

---

## UI checklist

1. **Product form — type toggle** (existing): when admin switches to `SERVICE`:
   - Hide: `sku`, `barcode`, `brandId` fields, `useLotsAndExpirations` toggle, `quantity`, `minQuantity`, `purchaseCost.valueCents`, "Add lot" button.
   - Show: `serviceDetail` panel with `capacity` (number, min 1) and `notes` (textarea, max 500).
2. **Variant editor — unit dropdown**:
   - For SERVICE products, only show `HORA, SESION, DIA, CONSULTA, CURSO, PAQUETE`.
   - For PRODUCT, keep the original 8 units.
3. **Product list — type filter**:
   - Add a `type` segmented control: `Todos | Productos | Servicios`. Wire to `?type=`.
4. **Product detail page — lots tab**:
   - If `product.type === 'SERVICE'`, hide the lots section entirely.
5. **POS catalog**:
   - SERVICE products appear in `GET /sales/pos-catalog` and are sellable. No change to the POS flow. Barcode search just returns zero matches for SERVICE (they have no barcode).
6. **Type-change UX (admin)**:
   - When admin tries to flip `PRODUCT → SERVICE`, the backend rejects with 400 if the product has stock. Show a friendly hint: "Vacía el stock y los lotes antes de convertir en servicio".

---

## Error codes you'll see

- `INVALID_ARGUMENT` (400) — `sku`, `barcode`, `brandId`, or `lots` sent on a SERVICE create/update.
- `PRODUCT_TYPE_CHANGE_BLOCKED` (400) — attempted `PRODUCT → SERVICE` with stock/lots.
- `LOTS_NOT_ALLOWED_ON_SERVICE` (400) — attempted `POST /products/:id/lots` on SERVICE.

All other 4xx errors (`ENTITY_NOT_FOUND`, `ENTITY_ALREADY_EXISTS`, etc.) are unchanged.

---

## Verification

Run `pnpm test` in the backend repo. The new suite is `src/products/products.service.service-type.spec.ts` (15 tests covering create/update/addLot/findAll SERVICE paths) and the DTO spec `src/products/dto/create-product.dto.spec.ts` (18 tests covering the unit enum, serviceDetail bounds, and type filter). Both must pass.
