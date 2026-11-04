# Purchase orders — checklist issue summary

**Status: implemented** on backend branch `fix/inventory-o1-review-followups` (not merged to `main` yet). The change is additive: `issueCount` and `validation.issues` are unchanged.

The contract was agreed with the FE (its checklist lives in `src/features/procurement/purchase-orders/utils/order-checklist.ts`).

## Fields

Both `GET /procurement/purchase-orders` (each list item) and `GET /procurement/purchase-orders/:orderId` (detail) now return:

```json
{
  "issueSummary": {
    "cost": 2,
    "quantity": 1,
    "reference": 0,
    "order": ["SUPPLIER_ARCHIVED", "UNIT_MISMATCH"]
  },
  "checklistItemCount": 4
}
```

| Field | Meaning |
| --- | --- |
| `issueSummary.cost` | Number of **lines** with at least one cost issue: `COST_AMOUNT_REQUIRED`, `COST_CURRENCY_REQUIRED`, `COST_UNIT_REQUIRED`, `COST_TAX_BASIS_REQUIRED`. A line missing amount and currency counts once. |
| `issueSummary.quantity` | Lines with `QUANTITY_REQUIRED` or `QUANTITY_FRACTION_NOT_ALLOWED`. |
| `issueSummary.reference` | Lines with `PRODUCT_REQUIRED`, `VARIANT_REQUIRED`, `REFERENCE_UNAVAILABLE` or `REFERENCE_INCOMPATIBLE`. |
| `issueSummary.order` | Every other code (for example `SUPPLIER_REQUIRED`, `SUPPLIER_ARCHIVED`, `LINES_REQUIRED`, `UNIT_MISMATCH`, `ELIGIBILITY_CHANGED`), each listed once, in the order it first appears. |
| `checklistItemCount` | Items the checklist shows: `(cost > 0) + (quantity > 0) + (reference > 0) + order.length`. Show it as «N avisos» in the list. |

Rules:

- An order without issues returns `{ cost: 0, quantity: 0, reference: 0, order: [] }` and `checklistItemCount: 0`.
- Confirmed and cancelled orders have no validation issues, so they always return the empty summary.
- Lines are identified by their position in `validation.issues[].path` (`/lines/<index>/…`).
