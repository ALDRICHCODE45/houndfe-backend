# POS "Pedido" tab — quotation ↔ sale conversion

**Status:** T1 (specs S1–S7) merged to `main`, deploy pending. T2 (S8: exact quoted total at opening, `suppressedPromotions`; plus `saleStatus` on quotation reads) on branch `fix/quotation-conversion-exact-price`, **not merged, not pushed, not deployed**; no migration. T3 (S8, defect D2: a quoted promotion line discount is kept as that promotion when it still applies exactly, so a re-enabled order promotion uses the net subtotal) on branch `fix/converted-sale-order-promo-base`, **not merged, not pushed, not deployed**; no migration. Task: `odd/tasks/quotation-sale-conversion.md`. Migration `20261118000000_quotation_sale_conversion` (T1) must be deployed first.

Shapes come from the code and its specs: `src/quotations/controllers/quotation-sale-conversion.controller.ts`, `src/quotations/application/quotation-sale-conversion.service.ts`, `src/quotations/domain/quotation-sale-conversion.mapper.ts`, `quotation-sale-conversion.integration.spec.ts` (real PostgreSQL). Nothing was sent to the dev API.

Two routes, both directions (S1):

| Method | Route | Permissions (all required) | What it does |
| --- | --- | --- | --- |
| `POST` | `/quotations/from-sale/:saleId` | `create:Quotation` **and** `delete:Sale` | POS DRAFT sale → new DRAFT quotation. The draft sale is **deleted** (S3). |
| `POST` | `/quotations/:id/convert-to-sale` | `create:Sale` **and** `update:Quotation` | DRAFT/SENT quotation → new POS DRAFT sale at the quoted prices; the quotation becomes `CONVERTED_TO_SALE`. |

Hide each button when the user lacks **any** of its two permissions (the guard checks both and answers `403` otherwise). No new CASL subject or action was added; the permission registry is unchanged.

## Common rules

- **`Idempotency-Key` header is required** on both routes (same contract as `POST /sales/drafts/:id/charge`). Missing or blank → `400` with `message: "IDEMPOTENCY_KEY_REQUIRED"`. One key per user press; reuse it only to retry the same request.
  - Same key + same request → the **same response** again (status `201`, byte-identical body), nothing is created twice. Use this after a timeout.
  - Same key + different request (other `saleId`/`quotationId`, other notes) → `409 IDEMPOTENCY_KEY_CONFLICT`.
  - Same key while the first request is still running → the second waits for it and then gets the replay (or `409 IDEMPOTENCY_KEY_IN_FLIGHT` in the rare case it cannot).
  - Any rejection (`4xx`) rolls everything back, including the key: fix the cause and retry with the same key.
- **All-or-nothing:** each route runs in one database transaction. Either everything happened (quotation created **and** sale deleted; sale created **and** quotation converted) or nothing did.
- **Tenant:** a `saleId`/`quotationId` of another sucursal behaves as not found.
- **Error body** (sales/quotations envelope): `{ statusCode, error: "<CODE>", message, timestamp, ...details }`. Switch on `error`. Extra keys (`saleId`, `lines`) sit at the top level of the body.

## 1. Venta borrador → cotización: `POST /quotations/from-sale/:saleId`

Body (optional):

```json
{ "customerNotes": "Entrega en sucursal Norte" }
```

`customerNotes`: string ≤ 280 or `null`. POS sales have **no notes field** (sale comments are internal and are not copied), so let the cashier type the customer-facing notes here; they can still be edited later with `PATCH /quotations/drafts/:id/notes`.

Preconditions (checked under a row lock):

- The sale exists in this sucursal, is `DRAFT`, and was opened by the **calling cashier** (same ownership rule as `DELETE /sales/drafts/:id`).
- It has at least one line.
- No payment, refund or transfer receipt is attached, no inventory movement was recorded for it, and it is not on a delivery route / promotion-capacity ledger.

Response `201`:

```json
{
  "quotation": {
    "id": "5b0f…",
    "status": "DRAFT",
    "effectiveStatus": "DRAFT",
    "sellerUserId": "…", "seller": { "id": "…", "name": "Pedro Pérez" },
    "customerId": "…", "customer": { "id": "…", "firstName": "María", "lastName": "García", "email": null },
    "globalPriceListId": "…", "priceListExplicitlySet": true,
    "customerNotes": "Entrega en sucursal Norte",
    "items": [ /* QuotationItemResponseDto, see docs/quotations-frontend.md §4 */ ],
    "subtotalCents": 25000, "discountCents": 500, "totalCents": 24500,
    "ivaBreakdown": [ { "classification": "IVA_16", "amountCents": 3379 } ],
    "saleId": null, "saleStatus": null, "convertedAt": null,
    "…": "rest of QuotationResponseDto"
  },
  "discardedSaleId": "9d2c…",
  "droppedAdjustments": [
    {
      "kind": "ORDER_PROMOTION",
      "saleItemId": null, "productId": null, "variantId": null,
      "promotionId": "…", "title": "Orden -$10",
      "discountCents": 1000
    }
  ]
}
```

After `201`: clear the POS cart (the draft no longer exists, S3) and open the quotation. Dates in this response are ISO strings.

### What is copied, and how ("precio vigente", S2)

| Sale draft | Quotation |
| --- | --- |
| `customerId` | `customerId` |
| `sellerUserId` (falls back to the calling user when the sale has no seller) | `sellerUserId` |
| `globalPriceListId` + whether the cashier chose it | `globalPriceListId` + `priceListExplicitlySet` |
| Line with list/default price | `PRICE_LIST` line. The quotation re-resolves the **current** list/tier price for that quantity (same pipeline as `POST /quotations/drafts/:id/items`). A per-item price-list override is kept. |
| Line with a cashier custom price | `CUSTOM` line (sticky) at the same unit price |
| Line with a **manual** discount (line or global discount) | `CUSTOM` line at the **discounted** unit price. Quotations cannot store a manual discount breakdown, so the net price is kept and the discount is folded into it (the line shows no discount). |
| Line with a **promotion** discount | Line at its pre-discount price; the quotation's promotion engine re-applies the promotion if it is still eligible (same engine, context `QUOTATION`). Manual opt-ins and vetoes are copied. If it does not re-apply, it is listed in `droppedAdjustments` (`LINE_PROMOTION`). |
| Buy X get Y / advanced reward on a line | **Not representable** on a quotation. Line copied at full price; reward listed in `droppedAdjustments` (`REWARD_PROMOTION`). |
| Order-level promotion | **Not representable**. Listed in `droppedAdjustments` (`ORDER_PROMOTION`). |
| Product/variant names, IVA | Taken from the current catalog; every line gets the per-item IVA snapshot, so `ivaBreakdown[]` is populated. |

`ivaBreakdown` shape (every quotation read): `ivaBreakdown: Array<{ classification: 'IVA_16' | 'IVA_8' | 'IVA_0' | 'IVA_EXENTO' | 'NOT_TAXABLE'; amountCents: number /* integer >= 0 */ }>`. Only the classifications present, in that order; `[]` means "do not show IVA". `taxRate` and `taxCents` were **removed** from the quotation response (IVA is per item).
| Comments, shipping address, due date | Not copied. |

`droppedAdjustments` is `[]` when nothing was lost. When it is not empty, tell the seller before or after the conversion ("La cotización no incluye: Orden -$10 (−$10.00)"); `discountCents` is the total the customer no longer saves.

### Errors

| HTTP | `error` | When | UI |
| --- | --- | --- | --- |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` (in `message`) | No `Idempotency-Key` | Bug in the client |
| 400 | — (validation) | `customerNotes` > 280 chars, `saleId` not a UUID | Counter 0/280 |
| 403 | `SALE_UPDATE_FORBIDDEN` | Draft opened by another cashier | "Esta venta es de otro cajero" |
| 403 | — | Missing `create:Quotation` or `delete:Sale` | Hide the button |
| 404 | `SALE_NOT_FOUND` | Sale does not exist in this sucursal (or was already converted/deleted) | Reload the POS drafts |
| 409 | `SALE_NOT_DRAFT` | Sale is `CONFIRMED`/`CANCELED` | Reload |
| 409 | `IDEMPOTENCY_KEY_CONFLICT` / `IDEMPOTENCY_KEY_IN_FLIGHT` | See common rules | New key / wait |
| 422 | `SALE_HAS_NO_ITEMS` | Empty cart | Disable the button on an empty cart |
| 422 | `SALE_HAS_PAYMENTS` | A payment/refund/receipt is attached | "Ya tiene pagos, no se puede pasar a cotización" |
| 422 | `SALE_HAS_STOCK_MOVEMENTS` | Inventory was already moved for it | Same |
| 422 | `SALE_NOT_DISCARDABLE` | On a delivery route / capacity ledger | Same |
| 422 | `SALE_LINES_UNAVAILABLE` | A line's product can no longer be sold in POS; body carries `lines` (same shape as below) | List the lines |

## 2. Cotización → venta borrador: `POST /quotations/:id/convert-to-sale`

No body.

Convertible (S6): status `DRAFT` or `SENT`, **not expired** (neither persisted `EXPIRED` nor `expiresAt` in the past), not `CANCELLED`, not already converted, with at least one line, and every line still sellable with enough stock.

Response `201`:

```json
{
  "quotation": {
    "id": "5b0f…",
    "status": "CONVERTED_TO_SALE",
    "effectiveStatus": "CONVERTED_TO_SALE",
    "saleId": "c7e1…",
    "saleStatus": "DRAFT",
    "convertedAt": "2026-11-18T18:04:05.123Z",
    "…": "rest of QuotationResponseDto"
  },
  "sale": {
    "id": "c7e1…",
    "status": "DRAFT",
    "userId": "<calling cashier>",
    "customerId": "…",
    "sellerUserId": "<quotation seller>",
    "globalPriceListId": "…",
    "quotationId": "5b0f…",
    "subtotalCents": 32345, "discountCents": 1000, "totalCents": 31345,
    "items": [
      {
        "id": "…", "productId": "…", "variantId": null,
        "productName": "Jeans", "quantity": 2,
        "unitPriceCents": 9500,
        "priceSource": "custom", "customPriceCents": 10000,
        "prePriceCentsBeforeDiscount": 10000,
        "discountType": "amount", "discountValue": 500, "discountAmountCents": 500,
        "discountTitle": "Promo test", "promotionId": "7c1e…",
        "…": "rest of the POS draft item"
      }
    ],
    "…": "rest of the POS draft sale (same shape as GET /sales/drafts)"
  },
  "suppressedPromotions": [
    { "promotionId": "9d2a…", "title": "Orden auto" }
  ]
}
```

`suppressedPromotions` (always present, `[]` when none): automatic promotions active **today** that would have changed the quoted total. They are vetoed on the new sale (see the pricing rule below); `title` is `null` only if the promotion row cannot be read. Idempotent replays return the same list.

After `201`: open the POS with `sale.id` (it is already one of the cashier's drafts in `GET /sales/drafts`). The draft belongs to the **calling** cashier (`sale.userId` = the user who converted); the quotation's seller is kept as `sellerUserId`.

**Who can open it:** `GET /sales/drafts` lists **only the caller's own** drafts, and every draft mutation (`/sales/drafts/:id/...`) rejects another user with `SALE_UPDATE_FORBIDDEN`. So a different cashier will **not** see this sale in "ventas en curso" and cannot continue it. There is no single-draft read: `GET /sales/:id` returns 404 for a `DRAFT` (it serves only `CONFIRMED` / `CANCELED`).

### Pricing rule (S5: "precio cotizado si está vigente")

- Every line keeps the **quoted** unit price and the **quoted** discount, to the cent, whatever the catalog says today. Lines are created as sticky custom prices. A quoted discount that came from a promotion is handled in one of two ways (T3):
  - If today the same promotion gives **exactly** the quoted discount on that line (and on no other line of the sale), the line keeps it as that **promotion** (`promotionId` = the promotion, `discountTitle` = its name). It then behaves like on any normal sale: an order-level promotion re-enabled later is computed on the subtotal **after** this line discount (e.g. $689.00 − 10% = $620.10, then Buen Fin 10% −$62.01 → $558.09), and removing it is `DELETE /sales/drafts/:id/promotions/:promotionId`. Changing the quantity re-evaluates it like on any draft.
  - Otherwise (the promotion changed, ended, no longer exists, or would also hit another line), the quoted discount becomes a **manual** line discount (`promotionId: null`) titled with the promotion name (or `"Descuento cotizado"` if the promotion no longer exists). Changing the quantity later keeps the per-unit price and discount. Like any manual line discount on a normal sale, an order-level promotion applied later is computed on the line's price **after** that manual discount (same $558.09 as above), and its minimum purchase is checked against the subtotal net of it.
- Nothing is repriced: there is **no "price changed" rejection**. A quotation past its `expiresAt` cannot be converted at all (`QUOTATION_EXPIRED`): the seller renews it (new quotation) to get current prices.
- **Exact by default (S8: "Exacto por defecto, se ajusta después").** At opening, the sale total equals the quotation total to the cent, per line and in total. No new promotion is applied: every automatic promotion that would apply today (on a line or at order level) is added to the sale's per-draft **veto set** and returned in `suppressedPromotions`. Vetoes from the quotation are copied too (they are not listed in `suppressedPromotions`). A promotion kept on its quoted line (see above) is not vetoed and not listed; lines with a quoted discount open at that discount to the cent.
- The opened sale is a normal POS draft: afterwards the cashier can lower or raise prices and apply discounts or promotions line by line with the **existing** draft routes (no new routes):

| Cashier action | Route (all `update:Sale`, owner cashier, `DRAFT` only) | Effect |
| --- | --- | --- |
| Re-enable a suppressed automatic promotion | `POST /sales/drafts/:id/manual-promotions/:promotionId` (empty body) | Clears the veto; the promotion applies again if still eligible (the total goes down). It is **not** left as a manual opt-in. |
| Drop an applied promotion again | `DELETE /sales/drafts/:id/promotions/:promotionId` | Vetoes it again. |
| Opt in a MANUAL promotion | `GET /sales/drafts/:id/applicable-promotions` then `POST /sales/drafts/:id/manual-promotions/:promotionId` | As on any draft. |
| Change a line price (up or down) | `PATCH /sales/drafts/:id/items/:itemId/price` with `{ "customPriceCents": n }` or `{ "priceListId": "…" }` | New price; **clears that line's quoted discount** (as on any draft) and re-runs promotions (suppressed ones stay vetoed). |
| Line discount | `PATCH /sales/drafts/:id/items/:itemId/discount` / `DELETE /sales/drafts/:id/items/:itemId/discount` | Apply / remove a manual line discount (removing the quoted discount raises the line to its quoted gross price). |
| Whole-sale discount | `PATCH /sales/drafts/:id/discount` / `DELETE /sales/drafts/:id/discount` | As on any draft. |
| Switch the sale price list | `PUT /sales/drafts/:id/price-list` | Converted lines are custom (sticky), so they keep the quoted price; only lines added later are priced from the list. |

  UI: after `201`, if `suppressedPromotions` is not empty, show e.g. "Se respetó el precio cotizado. Promociones disponibles hoy: …" with an "Aplicar" button per entry calling the re-enable route. The draft read (`GET /sales/drafts`) does not list vetoed ids; keep `suppressedPromotions` from the conversion response.
- Stock is checked like `POST /sales/drafts/:id/items` (no reservation). Customer and price list are copied; the shipping address is not (set it in the POS if needed).

### Errors

| HTTP | `error` | When | Extra body keys | UI |
| --- | --- | --- | --- | --- |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` (in `message`) | No header | | |
| 403 | — | Missing `create:Sale` or `update:Quotation` | | Hide "Convertir a venta" |
| 404 | `ENTITY_NOT_FOUND` | Quotation not in this sucursal | | |
| 409 | `IDEMPOTENCY_KEY_CONFLICT` / `IDEMPOTENCY_KEY_IN_FLIGHT` | See common rules | | |
| 422 | `QUOTATION_EXPIRED` | Persisted `EXPIRED`, or `expiresAt` already passed | | "La cotización venció; renuévala" |
| 422 | `QUOTATION_CANCELLED` | Cancelled | | |
| 422 | `QUOTATION_ALREADY_CONVERTED` | Already converted (other key, other user, double click with two keys) | `saleId` | "Ya se convirtió" + button to open `saleId` |
| 422 | `QUOTATION_HAS_NO_ITEMS` | No lines | | |
| 422 | `QUOTATION_LINES_UNAVAILABLE` | One or more lines cannot become sale lines; **all** of them are listed | `lines` | Show which lines and why |

`lines[]` entries:

```json
{
  "lineId": "<quotation item id>",
  "productId": "…", "variantId": null,
  "productName": "Playera", "variantName": null,
  "reason": "INSUFFICIENT_STOCK",
  "requestedQuantity": 2,
  "availableQuantity": 1
}
```

`reason`: `PRODUCT_NOT_FOUND`, `VARIANT_NOT_FOUND`, `PRODUCT_NOT_SELLABLE` (not sold in POS, or the variant shape changed), `INSUFFICIENT_STOCK` (`availableQuantity` = sellable stock; `null` for the other reasons). The quotation is unchanged: the seller can edit a DRAFT quotation and retry, or sell the available items from the POS.

**Concurrency:** two presses (or two cashiers) on the same quotation produce **exactly one sale**; the other gets `QUOTATION_ALREADY_CONVERTED` with that `saleId`.

## 3. The new status and the links (S4, S7)

- Quotation status `CONVERTED_TO_SALE` (terminal). Badge: "Convertida en venta". It is accepted by the list filter: `GET /quotations?status=CONVERTED_TO_SALE`.
- Every quotation read (`GET /quotations`, `GET /quotations/:id`, every mutation response, and `quotation` in the convert response) now carries `saleId` (string or `null`), `convertedAt` (ISO or `null`) and `saleStatus: 'DRAFT' | 'CONFIRMED' | 'CANCELED' | null` — the current status of the linked sale (`null` when there is no link or the sale was deleted). It is read live on every request (the list uses one batched query), except inside an idempotent replay of `convert-to-sale`, which returns the original body (`DRAFT`).
- "Ver venta" by `saleStatus`:

| `saleStatus` | Route | Notes |
| --- | --- | --- |
| `DRAFT` | POS draft: open the POS on `saleId`; the data comes from `GET /sales/drafts` (find it by `id`) and the `/sales/drafts/:id/...` mutations | Only the cashier who converted (`sale.userId`) has it. For anyone else show "En curso con otro cajero" instead of a link. |
| `CONFIRMED` / `CANCELED` | `GET /sales/:id` (`read:Sale`) | Sale detail. |
| `null` | — | No sale (if `status = CONVERTED_TO_SALE`: "Venta descartada", see below). |
- Sale reads carry `quotationId` **only when the sale came from a quotation** (the key is absent otherwise): every POS draft response (`GET /sales/drafts`, item/customer/price mutations) and `GET /sales/:id` once charged or cancelled. The sales list is unchanged.
- A converted quotation is read-only: edits and send → `QUOTATION_NOT_DRAFT`, cancel → `QUOTATION_ALREADY_CONVERTED` (cancel the sale instead), delete → `QUOTATION_CANNOT_DELETE`. The PDF still renders. The lazy expiry never turns it into `EXPIRED`. Races are resolved in favour of the conversion: an edit, send or delete that was already in flight when another user converted the quotation fails with `QUOTATION_NOT_DRAFT` (edit/send; no email is sent) or `QUOTATION_ALREADY_CONVERTED` (delete; nothing is deleted). Reload and show the converted quotation.
- If the draft sale created from a quotation is later **deleted** from the POS, the quotation stays `CONVERTED_TO_SALE` with `saleId: null`. In that state it can be converted again (same rules: not expired) or cancelled. Show "Venta descartada" and offer "Convertir de nuevo".

## 4. Test recipe

1. POS: open a draft, add two products, assign a customer → `POST /quotations/from-sale/:saleId` with `Idempotency-Key: <uuid>` → `201`; `GET /sales/drafts` no longer lists it.
2. Repeat the same request with the same key → same body; with another sale and the same key → `409 IDEMPOTENCY_KEY_CONFLICT`.
3. `POST /quotations/drafts/:id/send?email=false` → `SENT`; `POST /quotations/:id/convert-to-sale` → `201`; the sale total equals the quotation total; `GET /quotations/:id` → `saleId`.
   - With an automatic promotion active today on a quoted product that had no quoted discount: the sale total still equals the quotation total and the promotion is in `suppressedPromotions`; `POST /sales/drafts/:saleId/manual-promotions/:promotionId` → lower total; `PATCH /sales/drafts/:saleId/items/:itemId/price` with a higher `customPriceCents` → higher total.
4. Convert again with a new key → `422 QUOTATION_ALREADY_CONVERTED` with `saleId`.
5. Set `expiresAt` in the past on a DRAFT quotation and convert → `422 QUOTATION_EXPIRED`.
