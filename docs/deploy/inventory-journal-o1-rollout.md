# O1 inventory journal — rollout runbook

Audience: whoever runs `prisma migrate deploy` for migration `20261104020000_inventory_journal_storage` and deploys the app that comes with it (branch `feat/inventory-journal-o1`). The FE contract is in [../frontend-handoff/01-inventory-journal.md](../frontend-handoff/01-inventory-journal.md).

The migration is additive (new tables, new `stockVersion` columns) but it also **writes data**: it raises some `products.quantity` values and inserts one `OPENING` movement for all the existing stock. That is what makes the order of operations and the rollback story matter.

## Order of operations

1. **Back up the database.** This is the only complete rollback (see [Rollback](#rollback)).
2. **Run the pre-flight queries** below against production. Fix or accept every row they return.
3. **Stop every process that writes stock**, then wait until they are down:
   - all API instances (POS charge/cancel, product, variant and lot writes);
   - any worker or bot process that confirms or cancels sales (chatbot checkouts).
4. Run `pnpm prisma migrate deploy`.
5. Start the new version. Every instance must be the new version; do not run old and new side by side.
6. Run the [post-checks](#post-checks).
7. **Grant the new permissions** to the roles or users that need them (see [Permissions](#permissions)).

### Why the writers must be stopped

The opening takes a snapshot of `products.quantity`, `variants.quantity` and `lots.quantity` in one statement. A writer that changes stock while the migration runs, or between the snapshot and the new code starting, produces a change that has no movement: the journal balance and the real quantity then disagree from day one, and nothing in the journal explains the gap. The old code is also unsafe after the migration (it writes quantities without movements or version bumps), so no old instance may serve traffic once the migration has been applied.

### The activation marker

The app decides which sales are «legacy» (confirmed before the journal, so with no `SALE` rows) from `_prisma_migrations.finished_at` of this migration. A sale confirmed before that instant restores its stock through the journal as `SALE_CANCELLATION` rows when cancelled. A sale confirmed after it that has no `SALE` rows (all lines `useStock: false` or services) restores nothing.

- Do not edit or delete that row of `_prisma_migrations`.
- Apply the migration by running it. Marking it with `prisma migrate resolve --applied` without running the SQL sets `finished_at` to the time of the `resolve` and skips the opening.
- If the row is missing, cancelling a sale that has no `SALE` rows fails with an error instead of guessing.

## Pre-flight queries

Run them as a read-only user, over all tenants. Every query should return zero rows, or rows you have decided how to handle.

### 1. Negative quantities (product, variant, lot)

```sql
SELECT 'product' AS kind, "tenantId", "id", "name" AS label, "quantity" FROM "products" WHERE "quantity" < 0
UNION ALL
SELECT 'variant', "tenantId", "id", "name", "quantity" FROM "variants" WHERE "quantity" < 0
UNION ALL
SELECT 'lot', "tenantId", "id", "lotNumber", "quantity" FROM "lots" WHERE "quantity" < 0
ORDER BY 1, 2;
```

**What to do.** The journal never holds a negative balance (`stock_movements_balance_check`), so the opening cannot represent these rows: the migration **fails** and Prisma records it as failed. Fix the data before migrating. Count the physical stock and set the quantity to that value (or to 0 if it is unknown), and keep the list of rows you changed. If a migration already failed on this check, the whole script was rolled back; fix the rows, run `pnpm prisma migrate resolve --rolled-back 20261104020000_inventory_journal_storage`, and deploy again.

### 2. Lots attached to products with variants

```sql
SELECT l."tenantId", l."productId", p."name", l."id" AS "lotId", l."lotNumber", l."quantity"
  FROM "lots" l
  JOIN "products" p ON p."id" = l."productId"
 WHERE p."hasVariants" = true
 ORDER BY l."tenantId", l."productId";
```

**What to do.** Lots on variant products are not supported until O2. The opening journals only the variants of such a product and **skips its lots**: the lot rows stay in the table, with no `OPENING` movement, and the stock view and FEFO never use them. Decide for each row:

- quantity 0 and no use: delete the lot before migrating;
- quantity > 0: move that stock to the right variant (a count or an adjustment after the migration), then set the lot to 0 and delete it. Do not leave stock in a lot nobody can see.

### 3. Products where the lot sum is above the product quantity

```sql
SELECT p."tenantId", p."id", p."name", p."quantity", SUM(l."quantity")::int AS "lotSum"
  FROM "products" p
  JOIN "lots" l ON l."productId" = p."id"
 WHERE p."hasVariants" = false
 GROUP BY p."tenantId", p."id", p."name", p."quantity"
HAVING SUM(l."quantity") > p."quantity"
 ORDER BY p."tenantId", p."name";
```

**What to do.** The journal requires `product.quantity >= sum(lots)` (the difference is the untracked portion, never negative). For every row above, the opening **raises `products.quantity` to the lot sum**. The product total on screen goes up by `lotSum − quantity`, and the `OPENING` rows reflect the raised value. If the lots are right, accept the raise (it is the default and is documented for the FE). If the product quantity was right and the lots are overstated, lower the lot quantities to the real count **before** migrating. After the migration, correct anything that was wrong with a normal adjustment so the history shows it.

## Post-checks

Immediately after the migration and before opening traffic:

```sql
-- Opening rows exist (one per non-zero bucket).
SELECT count(*) FROM "stock_movements" WHERE "type" = 'OPENING';

-- Every non-variant product total equals the sum of its movements. Expect zero rows.
SELECT p."id", p."name", p."quantity", COALESCE(m."total", 0) AS "journal"
  FROM "products" p
  LEFT JOIN (SELECT "productId", SUM("delta")::int AS "total" FROM "stock_movements" GROUP BY "productId") m
    ON m."productId" = p."id"
 WHERE p."hasVariants" = false AND p."quantity" <> COALESCE(m."total", 0);

-- Every variant equals the sum of its movements. Expect zero rows.
SELECT v."id", v."name", v."quantity", COALESCE(m."total", 0) AS "journal"
  FROM "variants" v
  LEFT JOIN (SELECT "variantId", SUM("delta")::int AS "total" FROM "stock_movements" WHERE "variantId" IS NOT NULL GROUP BY "variantId") m
    ON m."variantId" = v."id"
 WHERE v."quantity" <> COALESCE(m."total", 0);
```

## Rollback

**Do not roll the app back to `main` on top of a migrated database and keep serving traffic.** `main` does not know about the journal:

- every stock change it makes (sales, edits, restocks) writes quantities **with no movement and no `stockVersion` bump**;
- the opening is recorded as applied, so it **will not run again** when you redeploy this version later;
- when you come back, the journal balance of each bucket no longer matches its quantity, `balanceAfter` chains are wrong from the first untracked change, and every `expectedVersion` read before the gap is stale.

Safe paths:

1. **Restore the backup (preferred).** Take the app down, restore the backup from step 1, deploy `main`. Everything written since the backup is lost, so use this only while the window is short, or export the sales you must re-enter.
2. **Roll forward instead.** If the new version has a bug, fix it and redeploy this version. The data stays consistent because nothing wrote outside the journal.
3. **If you must run `main` against the migrated database anyway** (not recommended): when you return to this version, run a re-opening script **before** letting traffic in. For every bucket (non-variant product untracked portion, lot, variant), compare the current quantity with the last `balanceAfter` in the journal and insert an `OPENING` movement for the difference (actor `Sistema`, `groupType` `PRODUCT`, `groupId` the product id), and bump that bucket's `stockVersion`. The script does not exist in the repository; write and review it for the incident, and run the post-checks afterwards.

The migration cannot be undone by SQL alone without losing the history; dropping the new tables and columns is not a rollback plan.

## Permissions

The new permissions are not granted by the migration.

- `PermissionSeeder` upserts every entry of `PERMISSION_REGISTRY` on application boot, so the rows `InventoryJournal:read` and `InventoryAdjustment:create` appear the first time the new version starts. There is no separate deploy step for them.
- They have **no default grants** and no inheritance from products or sales. Until an admin grants them to a role or user, `GET /inventory/*` and `POST /inventory/adjustments` answer `403 FORBIDDEN`, for every user including the existing managers.
- Grant `InventoryJournal:read` to whoever should see stock and the kardex, and `InventoryAdjustment:create` to whoever may correct stock. Stock adjustments need no second approval.
