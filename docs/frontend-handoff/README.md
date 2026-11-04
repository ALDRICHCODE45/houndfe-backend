# Frontend handoff — index

Backend contracts for the frontend, **in implementation order**. Each file covers endpoints, request/response examples, errors, permissions, business rules, states and test data.

| # | Feature | Backend status | File |
| --- | --- | --- | --- |
| 1 | O1 Inventory journal: stock view, kardex, adjustments, FEFO on sale, read-only quantity | Implemented, merged to local `main` | [01-inventory-journal.md](01-inventory-journal.md) |
| 2 | O2 Lots on variants | **Paper proposal only**, not implemented | [02-variant-lots-o2-proposal.md](02-variant-lots-o2-proposal.md) |
| 3 | O4 Receipts against a confirmed purchase order (10 ordered, 6 accepted → +6, 4 pending) | Not started; depends on O1 and O2 | — |
| 4 | Purchase orders: checklist issue summary (`issueSummary`, `checklistItemCount`) | Implemented, merged to local `main` | [03-po-issue-summary.md](03-po-issue-summary.md) |

Operations: [deploy/inventory-journal-o1-rollout.md](../deploy/inventory-journal-o1-rollout.md) is the rollout runbook for the O1 migration (stop writers, pre-flight queries, rollback, permissions). It is for whoever deploys, not for the FE.

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

**Full demo data for every screen:** run `pnpm seed:showcase` (see the root `README.md`, section "Demo data (dev showcase)", for what it creates and the demo users). The O1 inventory test data below is still valid.

The dev database is disposable by human decision, so the FE can change this data freely. The data below was created through the real API by `scripts/inventory-runtime/seed.cjs` and checked by the runtime probe on 2026-11-04 (85 probes over real HTTP against the built app, all passing).

### Who logs in

| What | Value |
| --- | --- |
| Sucursal (tenant) | **Sucursal Centro** (`slug: centro`, id `ced6cc10-a037-4f41-92af-ee69bbb51c8b`) |
| Dev user | `manager@houndfe.com` (display name «Manager Centro», role `Manager` in Centro) |
| Password | Not repeated here. It is the seeded dev password the FE already uses to log in (the `manager@houndfe.com` login example in [multi-tenant-api.md](../multi-tenant-api.md)). |
| User without inventory permissions | `cashier@houndfe.com` (role `Cashier`). Use it to see `403 FORBIDDEN` on the three inventory endpoints. |
| Super admin | `admin@houndfe.com`. It has no tenant until `POST /auth/switch-tenant`, and it can switch to Sucursal Norte or Sur to see that stock is per sucursal. |

In development (`NODE_ENV=development`) the password login returns the tokens directly, with no email code.

### Permissions granted

The seed grants these two permissions to the `Manager` role of Sucursal Centro, and so to `manager@houndfe.com`:

- `InventoryJournal:read`
- `InventoryAdjustment:create`

No other role has them (`Cashier` has neither). In production an admin assigns them per user.

### Showcase products (Sucursal Centro)

Today is 2026-11-04 in the business timezone. Versions start as shown and grow with every movement, so they are the values right after seeding.

**Croquetas Adulto 15 kg** · id `c89a04e8-c39f-430b-b570-e8556a2993d2` · total 72, sellable 64. A product with an expired lot, two valid lots and untracked units.

| Bucket | id | Quantity | Version | State |
| --- | --- | --- | --- | --- |
| Untracked (`PRODUCT_UNTRACKED`) | the product id | 12 | 1 | Added with a «Conteo físico» adjustment, because a product with lots ignores the `quantity` sent on create. |
| Lot `L-2026-08` | `3a3cff07-995c-4593-921a-b6811f8f63e5` | 8 | 1 | **Expired** (expires 2026-10-15), not sellable. |
| Lot `L-2027-01` | `f8464207-45cd-483d-b8c3-9d037f111ce3` | 22 | 1 | Valid, expires 2027-01-15. Sold first (FEFO). |
| Lot `L-2027-06` | `bbad7d88-0aa4-449a-be71-8f6132f55ad1` | 30 | 1 | Valid, expires 2027-06-30. |

A sale of 60 units takes 22 from `L-2027-01`, 30 from `L-2027-06` and 8 from the untracked units. The expired lot is never touched.

**Desparasitante Canino 10 ml** · id `35971296-03f3-4e3b-b4fd-a85f3a1cbcd0` · total 40, sellable 40. A product without lots: one untracked bucket with quantity 40, version 1.

**Collar ajustable** · id `511634d0-5b59-4dfc-86f2-a43c3a59baf7` · total 24, sellable 24. A product with variants (`untracked` is 0, `lots` is empty):

| Variant | id | Quantity | Version |
| --- | --- | --- | --- |
| Chico · Azul | `bf93e080-17ab-426f-8b7c-84b89f8a1bf5` | 15 | 1 |
| Mediano · Rojo | `23b184a9-57d0-454c-aa8d-13218ef16665` | 9 | 1 |

**Placa de identificación grabada** · id `e3e603c0-a84f-4bf8-8591-4b1ccc1c01e3` · `useStock: false`, `sellable: null`. Adjusting it returns `409 STOCK_NOT_TRACKED`.

Each product's kardex starts with its `INITIAL` rows. The older products that existed before the journal was switched on have `OPENING` rows («Sistema») instead (76 in the dev DB).

### Ignore these leftovers

A product that has sale history cannot be deleted (`400 Invalid relation reference`, existing behavior). The runtime proof charged and cancelled sales on throwaway products, so these stay in Sucursal Centro: `zz sale probe` and every `Prueba T8 Croquetas …`. They are not part of the showcase.

### Re-running

Run from the backend repo, against the dev DB in `.env`. Start the app in the background and wait until it answers:

```sh
pnpm build
PORT=3917 nohup node dist/main > /tmp/app.log 2>&1 &
export INVENTORY_BASE_URL=http://127.0.0.1:3917
```

Then set `INVENTORY_DEV_PASSWORD` (manager), `INVENTORY_NOPERM_PASSWORD` (cashier) and `INVENTORY_ADMIN_PASSWORD` (admin) in the shell. Never commit them.

```sh
node scripts/inventory-runtime/seed.cjs   # idempotent: creates only what is missing
node scripts/inventory-runtime/probe.cjs  # runtime proof; evidence in /tmp/inventory-evidence.json
```

- The seed matches products by name inside the tenant, grants the two permissions, and prints the ids and buckets as JSON. It does not reset quantities of products that already exist. To restore one, `DELETE /products/:id` it (this writes `REMOVAL` rows) and run the seed again.
- The probe changes stock only on its own `Prueba T8 …` products and only reads the showcase products. Each run leaves one more undeletable `Prueba T8 Croquetas …` (see above).
