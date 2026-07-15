# Frontend Task: Apply Promotions During POS Sale Creation

> **Context for the frontend agent.** The backend for connecting promotions to the
> POS sale flow is **done, tested, and merged-ready**. This document is the complete
> contract you need to build the seller-facing UI. Do NOT change backend behavior —
> consume the endpoints and fields described here.

---

## 1. What this feature is

Until now, the **Promotions** module was a rule catalog with no effect on sales.
Now, when a seller builds a **sale draft** at the POS, the backend automatically
applies eligible promotions and lets the seller manage them. Your job is the UI for
this on the sale-draft (cart) screen.

Two kinds of promotions, driven by each promotion's `method` field:

- **AUTOMATIC** promotions apply **by themselves** whenever they are eligible for the
  current draft. The seller does nothing. They can be **removed** (vetoed) if the
  seller wants them off for this draft.
- **MANUAL** promotions do **not** apply on their own. The seller sees the list of
  applicable manual promotions and **opts one in**.

**Scope of THIS slice (backend only supports these):**
- `PRODUCT_DISCOUNT` where the promotion targets specific **products** (`appliesTo === 'PRODUCTS'`).
- `ORDER_DISCOUNT` (a discount on the whole-cart total).
- `BUY_X_GET_Y` — emits `rewardKind: 'buy_x_get_y'` on the GET line. Engine admits AUTOMATIC only.
- `ADVANCED` — emits `rewardKind: 'advanced'` on the GET line. Engine admits AUTOMATIC only. BUY-side aggregated across the cart; supports `getDiscountPercent=100` (true free).

**Explicitly NOT supported yet (do NOT build UI for these):**
- `PRODUCT_DISCOUNT` scoped by CATEGORIES or BRANDS (deferred — engine does not handle them).
- Per-promotion usage limits/caps (not modeled).

---

## 2. Business rules the backend enforces (so your UI matches reality)

1. **Best-wins**: if several promotions could apply to the same line or the same
   sale, only the one with the **highest customer discount** applies. There is no
   stacking. The UI should show the single winning promo per line and the single
   winning order-level promo.
2. **Automatic promos apply live** on every draft change (add item, change quantity,
   remove item, assign/unassign customer, price-list override). After any of those
   mutations, re-read the draft — the promotions may have changed.
3. **The seller's manual free-form discount wins.** If a line already has a manual
   free-form discount (the existing per-line discount feature), the automatic promo
   does **not** touch that line. Show the manual discount as-is.
4. **Removing an auto-promo is per-draft and sticky.** When the seller removes an
   auto-applied promo (veto), it stays off for that draft even as the cart changes.
   It only comes back if the seller explicitly re-applies it.
5. **Customer-scoped promos need a customer.** A promo restricted to registered or
   specific customers silently does not apply until an eligible customer is assigned.
   When the seller assigns the right customer, re-read the draft — it may now apply.
   (There is no "assign a customer to unlock" hint from the backend; the promo simply
   appears/disappears on re-read.)
6. **Promotions stack on top of price-list prices.** A promo discounts the effective
   per-line price (which may already be a price-list price). Nothing special to do —
   the numbers already reflect this.
7. **No tax model.** All money is in **integer cents**. Never do float math on money;
   render with a cents→currency formatter.

---

## 3. The 4 endpoints (all guarded by `update:Sale`, all under the sale-draft path)

Base: the existing sales-draft routes (same auth/headers as your current draft
mutation calls — Bearer JWT, tenant context handled server-side).

### 3.1 List applicable MANUAL promotions (read-only)

```
GET /sales/drafts/:id/applicable-promotions
```

Returns the MANUAL promotions the seller can opt into on THIS draft, already filtered
for eligibility (dates, days, customer scope, price-list, min purchase, etc.) against
the current draft state. Does NOT mutate the draft.

**Response** (`ListApplicablePromotionsResponseDto`):
```ts
{
  saleId: string;
  promotions: Array<{
    id: string;                                  // use as :promotionId when applying
    title: string;                               // human-readable, show this
    type: 'PRODUCT_DISCOUNT' | 'ORDER_DISCOUNT';
  }>;
}
```
Use this to render a "Promociones disponibles" section with an **Apply** button per item.
If `promotions` is empty, hide/greyed the section.

### 3.2 Apply (opt-in) a MANUAL promotion

```
POST /sales/drafts/:id/manual-promotions/:promotionId
```
- Body: empty (send `{}` — inputs are in the path).
- Returns HTTP 200 with the updated draft (same shape as your other draft-mutation
  responses — see §4). The manual promo is now opted-in; if best-wins selects it, it's
  applied. If the id was previously vetoed, opting in also un-vetoes it.
- After the call, render from the returned draft (or re-fetch the draft detail).

### 3.3 Remove a MANUAL opt-in

```
DELETE /sales/drafts/:id/manual-promotions/:promotionId
```
- Body: empty. Idempotent.
- Returns HTTP 200 with the updated draft. The manual promo is no longer applied.

### 3.4 Remove (veto) an AUTO-applied promotion

```
DELETE /sales/drafts/:id/promotions/:promotionId
```
- Body: empty. Idempotent.
- Returns HTTP 200 with the updated draft. The auto-promo is removed and stays
  excluded for this draft (sticky veto). Does NOT modify the promotion catalog.

> **Note:** all four use `ParseUUIDPipe` on the ids — send valid UUIDs.

---

## 4. How promotions show up in the draft/sale response (what to READ and render)

After any mutation (including your existing add-item / quantity / customer calls), the
draft response and the sale-detail response carry the applied-promotion state.

### 4.1 Per-line (item) fields — for `PRODUCT_DISCOUNT`

Each sale item in the response includes (in addition to the existing fields):

```ts
{
  // ...existing item fields (productId, quantity, unitPriceCents, etc.)...
  discountType: 'amount' | 'percentage' | null;   // set when a discount is applied
  discountValue: number | null;
  discountAmountCents: number | null;             // the discount in cents
  prePriceCentsBeforeDiscount: number | null;     // the price BEFORE the discount
  discountTitle: string | null;                   // e.g. the promotion title
  promotionId: string | null;                     // ← KEY: non-null = promo-sourced
}
```

**Discriminator (important):**
- `promotionId != null` → this line's discount came from a **promotion**
  (show it as a promo, e.g. a badge with `discountTitle`; the remove action is §3.4).
- `promotionId == null` but a discount is present → this is the seller's **manual
  free-form discount** (existing behavior; not a promotion).

Use `prePriceCentsBeforeDiscount` to show the struck-through original price and
`unitPriceCents` (post-discount) as the effective price, with `discountAmountCents`
as the savings.

### 4.2 Sale-level fields — for `ORDER_DISCOUNT` and the totals

The draft/sale response carries an applied order-level promotion (when one is active)
and the **totals**. The order promotion is exposed via the sale's applied-order-promotion
snapshot:

```ts
appliedOrderPromotion: {
  promotionId: string;
  discountType: 'amount' | 'percentage';
  discountValue: number;
  discountAmountCents: number;     // the order discount in cents
  discountTitle: string;           // show this in the summary
} | null;                          // null when no order promo applies
```

### 4.3 Totals — THE CONTRACT (do not recompute on the client; read these)

The sale-level totals follow this exact meaning (all in cents):

| Field | Meaning |
|---|---|
| `subtotalCents` | Base **before any discount** (per-line + order). The "Subtotal" line. |
| `discountCents` | **Full savings** = per-line discounts **plus** the order discount. The "Descuentos" line. |
| `totalCents` | **What the customer pays** = post-line sum − order discount (clamped ≥ 0). The "Total" line. |

Invariants you can rely on: `subtotalCents ≥ totalCents`, `discountCents ≥ 0`, and
`discountCents === subtotalCents − totalCents`.

> This matches the existing `docs/sales-pos-charge-frontend.md` totals contract:
> `subtotalCents` = "Suma base antes de descuentos", `discountCents` = "Diferencia
> subtotal − total". **Render these fields directly** — do NOT sum line discounts on
> the client, the backend already did it correctly.

---

## 5. UI you need to build (on the sale-draft / cart screen)

1. **Per-line promo indicator**: for each item where `promotionId != null`, show a
   promo badge with `discountTitle`, the struck-through `prePriceCentsBeforeDiscount`,
   the effective `unitPriceCents`, and the saving (`discountAmountCents`). Include a
   small **remove** control that calls §3.4 (`DELETE .../promotions/:promotionId`).
2. **Order-level promo indicator**: when `appliedOrderPromotion != null`, show it in
   the totals summary as a line with its `discountTitle` and `discountAmountCents`,
   plus a remove control (§3.4 with that `promotionId`).
3. **"Promociones disponibles" (manual) section**: call §3.1 to list applicable
   MANUAL promos; render each with title + an **Apply** button (§3.2). For an
   already-opted-in manual promo, show it as applied with a remove (§3.3).
4. **Totals summary**: render `subtotalCents` / `discountCents` / `totalCents` from
   §4.3. These already include all savings.
5. **Live refresh**: after ANY draft mutation (add/remove/qty/customer/price-list, and
   the 4 promo endpoints), re-read the draft so promo state and totals stay correct.
   Automatic promos can appear or disappear on any of these — never cache promo state
   across a mutation.

---

## 6. Edge cases to handle in the UI

- **No customer + customer-scoped promo**: the promo just won't appear/apply. When the
  seller assigns a customer, re-read — it may now apply. No special "locked" state from
  the backend.
- **Vetoed auto-promo**: once removed (§3.4), it won't reappear on cart changes for this
  draft. If you want to let the seller bring it back, there is currently **no
  "un-veto an auto-promo" endpoint** — only manual promos have a re-apply path (§3.2,
  which also un-vetoes). Design the UX around auto-promo removal being a deliberate,
  sticky action for the draft. (If product wants auto-promo re-enable, that's a backend
  follow-up.)
- **100% discount**: the backend clamps percentage discounts so a line never drops
  below 1 cent. Just render whatever `unitPriceCents`/`discountAmountCents` come back.
- **Empty state**: if `applicable-promotions` returns `[]` and no promo is applied,
  render nothing for the promo sections.

---

## 7. Money formatting reminder

Everything is **integer cents**. Use your existing cents→currency helper. Do not divide
by 100 with floating point in a way that reintroduces rounding — format for display only.

---

## 8. Out of scope for the frontend

- Do NOT build category/brand-scoped promo UI (backend doesn't support it yet).
- Do NOT implement your own eligibility, best-wins, or discount math — the backend owns
  all of it. Your job is to READ the applied state and CALL the 4 endpoints.
