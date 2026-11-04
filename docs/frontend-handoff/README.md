# Frontend handoff — index

Backend contracts for the frontend, **in implementation order**. Each file covers endpoints, request/response examples, errors, permissions, business rules, states and test data.

| # | Feature | Backend status | File |
| --- | --- | --- | --- |
| 1 | O1 Inventory journal: stock view, kardex, adjustments, FEFO on sale, read-only quantity | Implemented on branch `feat/inventory-journal-o1` (pending merge to `main`) | [01-inventory-journal.md](01-inventory-journal.md) |
| 2 | O2 Lots on variants | **Paper proposal only**, not implemented | [02-variant-lots-o2-proposal.md](02-variant-lots-o2-proposal.md) |
| 3 | O4 Receipts against a confirmed purchase order (10 ordered, 6 accepted → +6, 4 pending) | Not started; depends on O1 and O2 | — |

Already delivered before this index (O3, implemented by the FE): suppliers, purchase-order drafts, confirm/cancel, and per-tax-basis list totals.

## Conventions shared by every feature

- **Auth:** JWT plus the tenant context. A sucursal is a tenant, so switching sucursal means switching tenant. The tenant and the actor are never sent in the body.
- **Lists:** `Page<T> = { items, nextCursor }`. The cursor is opaque and newest-first. `limit` defaults to 25, with a maximum of 100. `nextCursor: null` marks the last page.
- **Writes:**
  - Send an `Idempotency-Key` header. Use one key per user submission and reuse it only to retry the same body.
  - Send an `expectedVersion` for optimistic concurrency. A `409 *_VERSION_CONFLICT` means: reload, show the new state, and let the user retry with a new key.
- **Errors:** new modules return `{ "statusCode": <n>, "error": "<CODE>" }` with `Cache-Control: no-store`. The products and sales modules keep their existing body, `{ statusCode, error, message, timestamp }`. Switch on `error`, never on `message`.
- **Permissions:** granular subjects, assigned per user. There are no default grants and no second approval.

## 7. Test data (dev DB)

The backend fills this section after the O1 runtime proof.
