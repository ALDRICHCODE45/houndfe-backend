# Purchase-order confirm and cancel contract — O3c

Contract agreed with the frontend session (messages 5524f7e6, 1d18abc3, daa64dc5, 47fa0145); task `odd/tasks/procurement-po-confirm-o3c.md`. It extends the O3b draft contract ([HTTP](procurement-po-drafts-http-contract.md), [commands](procurement-po-drafts-commands.md), [storage](procurement-po-drafts-storage.md)); everything there stays in force unless stated below.

**CONFIRMED does not mean received.** Confirm and cancel touch only the order header, its lines, audit rows and idempotency receipts. Invariant: zero stock, reservations, payments, debt or events. The UI never shows or asks for ids.

Status of evidence: the routes, commands, read model and storage are covered by offline unit tests and authored integration specs. PostgreSQL migration preservation, the SQL CHECKs, the integration specs and the live HTTP probe are proven only by the parent-run disposable proof and probe described in [`scripts/po-runtime/README.md`](../scripts/po-runtime/README.md); this document does not claim them.

## The `PurchaseOrder` shape (S2)

`GET /:orderId`, `POST` (create), `PUT /:orderId/draft`, `POST /:orderId/confirm` and `POST /:orderId/cancel` all return the same `PurchaseOrder`, so no extra GET is needed after a save or a transition. Fields added to the O3b shape:

| Field                         | Type                                    | Meaning                                                                                                                                      |
| ----------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                      | `'DRAFT' \| 'CONFIRMED' \| 'CANCELLED'` | Lifecycle. CANCELLED is terminal.                                                                                                            |
| `supplierCurrentVersion`      | `number \| null`                        | Current version of the supplier row; `null` when the order has no supplier. Informational on closed orders.                                  |
| `referenceToken`              | `string \| null`                        | Opaque. `null` means not confirmable (incomplete or invalid references). The FE never computes or parses it. Always `null` on closed orders. |
| `canConfirm`                  | `boolean`                               | See below.                                                                                                                                   |
| `confirmedAt` / `cancelledAt` | ISO string \| `null`                    | Transition instants.                                                                                                                         |
| `confirmedBy` / `cancelledBy` | `{ displayName: string } \| null`       | Actor name **snapshot** taken at transition time. No ids are exposed.                                                                        |

`canConfirm` is true only when all hold: status is DRAFT, `validation.issues` is empty, `referenceToken` is non-null, `supplierCurrentVersion` is non-null, and the supplier is not ARCHIVED (an archived supplier therefore never enables the button that would end in `SUPPLIER_ARCHIVED`). It is always false for CONFIRMED and CANCELLED.

**Closed orders are frozen.** After CONFIRMED, `supplierDisplaySnapshot`, `lineDisplaySnapshots`, `locationSnapshot` and `lineSubtotals` come from stored columns and are never rewritten by a later rename or archive of the supplier, product, variant or tenant. `validation.issues` is `[]` for CONFIRMED and CANCELLED. Confirm refreshes the snapshots of valid references once and then freezes them. A CANCELLED-from-DRAFT order has no frozen subtotals (one `subtotal: null` per line); a CANCELLED-from-CONFIRMED order keeps the confirmed subtotals and both actor snapshots.

## Confirm (S4)

`POST /procurement/purchase-orders/:orderId/confirm`, header `Idempotency-Key`, JSON body, all fields required and no others:

```json
{
  "expectedVersion": 3,
  "expectedSupplierVersion": 2,
  "expectedReferenceToken": "…"
}
```

The FE sends exactly `version`, `supplierCurrentVersion` and `referenceToken` from the last response it holds. Success is `200` with the CONFIRMED order, `version + 1`.

First failure wins, in this order:

1. `ORDER_VERSION_CONFLICT`
2. `ORDER_STATE_CONFLICT` (the order is not DRAFT)
3. `ORDER_NOT_READY` (no supplier)
4. `SUPPLIER_VERSION_CONFLICT` (expected supplier version is null or differs)
5. `SUPPLIER_ARCHIVED`
6. `ORDER_NOT_READY` (the current token is null)
7. `ELIGIBILITY_CHANGED` (expected token is null or differs: product/variant references changed since the FE last read)
8. `ORDER_NOT_READY` (any other issue, for example a missing cost)

The server recomputes the token under locks (order `FOR UPDATE`, supplier `FOR UPDATE`, products ascending `FOR UPDATE`, variants `FOR SHARE`, all tenant-qualified). On `ELIGIBILITY_CHANGED`, `SUPPLIER_VERSION_CONFLICT` or `ORDER_VERSION_CONFLICT` the FE should re-read the order and let the user decide again.

## Cancel (S5)

`POST /procurement/purchase-orders/:orderId/cancel`, header `Idempotency-Key`, body exactly `{ "expectedVersion": number }`. **Cancel takes no reason field** (any extra member is `400 MALFORMED`). DRAFT or CONFIRMED becomes CANCELLED, `version + 1`, no reference validation and no supplier or catalog locks. Errors: `ORDER_VERSION_CONFLICT`, and `ORDER_STATE_CONFLICT` when already CANCELLED.

## Other endpoints on closed orders (S6)

`PUT /:orderId/draft` and `DELETE /:orderId` return `409 ORDER_STATE_CONFLICT` for a CONFIRMED or CANCELLED order. The version check comes first, so a stale version still reports `ORDER_VERSION_CONFLICT`. Only DRAFT orders can be discarded. A supplier with a closed order can never be deleted (`SUPPLIER_HAS_PURCHASE_ORDERS`).

## List (S7)

`GET /procurement/purchase-orders` gains an optional `status=DRAFT|CONFIRMED|CANCELLED`:

- Single value only; omitted means all statuses. Anything else (lowercase, comma lists, repeated parameter, empty) is `400 MALFORMED`.
- The HMAC cursor is bound to `status` together with `supplierId` and `search`; reusing a cursor with another status, or with the status added or removed, is `400 MALFORMED`. Cursors issued before O3c are invalid; restart listing.
- The summary's `status` is widened to the three values; nothing else changes and there are no counts. GET detail returns orders in every status.
- `search` matches the **live** supplier name for DRAFT orders and the **frozen** supplier name for CONFIRMED and CANCELLED orders, plus the note for all. A renamed supplier therefore finds its drafts under the new name and its closed orders only under the name they were confirmed with.

## List totals per tax basis

Contract agreed with the frontend session (request 1850b3cf, proposal 191304d0, OK 2f685837); task `odd/tasks/procurement-po-list-totals.md`. Each item of `GET /procurement/purchase-orders` gains an additive field. The detail `PurchaseOrder` is unchanged and carries no total.

```ts
totals: Array<{
  amount: string;
  currency: 'MXN';
  taxBasis: 'EXCLUDES_TAX' | 'INCLUDES_TAX';
}> | null;
```

- One entry when every line shares the same tax basis; two entries when the bases are mixed, always ordered `EXCLUDES_TAX` then `INCLUDES_TAX`. Amounts of different bases are never added together, and no tax is calculated.
- `amount` is the exact decimal sum of that basis's line subtotals, in the same canonical form as `lineSubtotals`: no rounding, no trailing zeros (`0.1 + 0.2` is `"0.3"`, `0.25 + 0.75` is `"1"`).
- `totals` is `null` when the order has zero lines or when any line subtotal is `null`. That covers incomplete drafts, drafts with invalid references and orders cancelled from DRAFT.
- Sources: a DRAFT uses the same live-validated subtotals as its detail. CONFIRMED and CANCELLED-from-CONFIRMED use the frozen `lineSubtotalsSnapshot`, so later catalog or supplier changes never alter them. The FE only displays these values and never sums.
- Computed from the rows already read for the page: no extra query, no lock and no per-order read.

Example (mixed bases): `"totals": [{"amount": "2797.1", "currency": "MXN", "taxBasis": "EXCLUDES_TAX"}, {"amount": "2088", "currency": "MXN", "taxBasis": "INCLUDES_TAX"}]`.

## Errors (S8)

The envelope stays `{ statusCode, error }` and carries no values, so `ORDER_NOT_READY` does not include `validation.issues`; the FE reads the issues from the order it already holds.

| Status | Codes                                                                                                                                                                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 400    | `MALFORMED`                                                                                                                                                                                                                                                  |
| 401    | `UNAUTHORIZED`                                                                                                                                                                                                                                               |
| 403    | `FORBIDDEN`                                                                                                                                                                                                                                                  |
| 404    | `NOT_FOUND`                                                                                                                                                                                                                                                  |
| 409    | **new:** `ORDER_NOT_READY`, `ELIGIBILITY_CHANGED`, `SUPPLIER_VERSION_CONFLICT`, `ORDER_STATE_CONFLICT`; **existing:** `ORDER_VERSION_CONFLICT`, `SUPPLIER_ARCHIVED`, `IDEMPOTENCY_KEY_CONFLICT`, `IDEMPOTENCY_KEY_IN_FLIGHT`, `SUPPLIER_HAS_PURCHASE_ORDERS` |
| 500    | `INTERNAL_ERROR`                                                                                                                                                                                                                                             |

## Idempotency and audit (S9)

Identical to O3b. Receipts are scoped per tenant + actor + operation + order. The same key with the same body returns the stored original response with no re-execution (even if the order changed afterwards); the same key with a different body is `409 IDEMPOTENCY_KEY_CONFLICT`; a concurrent request with the same key is `409 IDEMPOTENCY_KEY_IN_FLIGHT`. Only successes are stored. The audit row (operation `CONFIRM` or `CANCEL`, with before and after snapshots) is written atomically with the transition. Receipts and audits created before O3c lack the new response fields; replays of those return the old shape.

## Permissions (S10)

Two new configurable subjects; no fixed roles and no default grants (the Super Admin dev seed grants everything, as in O3b).

| Route                     | Required permissions                                                    |
| ------------------------- | ----------------------------------------------------------------------- |
| `POST …/:orderId/confirm` | `create:ProcurementOrderConfirmation` + `read:ProcurementPurchaseOrder` |
| `POST …/:orderId/cancel`  | `create:ProcurementOrderCancellation` + `read:ProcurementPurchaseOrder` |

Edit permissions, supplier reads and Product reads are not required for either. Current persisted authority (active user and tenant, membership, grant edges) is re-checked inside the transaction, never taken from the JWT. A user without the matching grant gets `403 FORBIDDEN` on that route only; the FE should hide or disable the action from the user's permissions and still handle the 403.

## Storage (T1 summary)

Migrations `20261104010100_procurement_po_confirm_cancel_enums` (enum values only, committed before use) and `20261104010200_procurement_po_confirm_cancel_storage` (five nullable columns on the order table, `po_status_transition_check`, `po_frozen_subtotals_check`, and the widened audit/receipt CHECKs). They are additive: every O3b row is DRAFT with the new columns NULL. See [storage](procurement-po-drafts-storage.md) for the draft tables.

## Disposable runtime for FE

`scripts/po-runtime/README.md` describes the proof, the host and the probe. The seeded users, their grants and the showcase orders (ready to confirm, incomplete, archived supplier, CONFIRMED, CANCELLED from each state) all use realistic Spanish names and are created through the real commands. Credentials live only in the private `RUN` directory and are never written to the repository or this document.
