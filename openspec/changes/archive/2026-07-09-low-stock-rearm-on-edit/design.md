# Design: Re-arm Low-Stock Alert on Product/Variant Edit

## Technical Approach

Mirror `incrementStockForRestock` on the edit path. Add ONE parameterized
transactional repository method, `rearmAlertAfterEdit`, to
`IProductRepository` / `PrismaProductRepository`. It asserts the ambient-tx
guard, re-reads the CURRENT persisted `quantity`/`minQuantity` inside the SAME
transaction (read-your-own-writes under READ COMMITTED), applies the STRICT `>`
gate, and calls `alertState.rearm(...)` with the correct key. `update` and
`updateVariant` wrap their PERSISTENCE TAIL + this call in a SINGLE
`tenantPrisma.runInTransaction(...)`, and re-route every raw `this.prisma.*`
persistence write in that tail through `tenantPrisma.getClient()` so it joins
the tx. Validation stays OUTSIDE the wrap. `seedAndFlip` is NEVER called on the
edit path.

Satisfies the MODIFIED `One-Shot Edge Trigger At Or Below Min Quantity`
requirement and all 8 edit-path scenarios.

## Architecture Decisions

### Decision: One parameterized method, not two

**Choice**: Single `rearmAlertAfterEdit({ productId, variantId })` with an
internal `variantId ? variants : products` branch.
**Alternatives considered**: One method per path; direct `alertState.rearm` from
the service (approach 2).
**Rationale**: The two branches differ only by table + key — identical to how
`incrementStockForRestock` already handles both in one loop body. One method
keeps a single owner of the STRICT `>` + tenant + tx-guard + variantKey
contract, reuses the existing adapter test harness, and keeps the service thin.
Service-layer `rearm` was rejected: it duplicates the contract across layers and
leaks the `alertState` driven port into the application service.

### Decision: Re-read via SELECT, do not fold the stock write into the method

**Choice**: Persistence stays where it is (`save` upsert / `variant.update`).
`rearmAlertAfterEdit` issues its own `SELECT` (tenant + id scoped) to get the
RESULTING pair, then gates on STRICT `>`.
**Alternatives considered**: Fold the stock/min `UPDATE ... RETURNING` into the
new method (as restock does).
**Rationale**: The edit write is a rich, field-heavy upsert (`save`, ~60 fields)
and a conditional variant update — reimplementing either as raw SQL to reuse
`RETURNING` would duplicate a large surface and risk drift. Reading back inside
the SAME transaction is race-free: no other writer can interleave between the
in-tx write and the read. Diff stays small; existing update behavior untouched.

### Decision: The tx boundary wraps the WHOLE persistence tail, not just save()

**Choice**: `update()`'s persistence tail contains THREE stock-affecting writes
that must all commit atomically with rearm. Wrap all of them + rearm in ONE
`runInTransaction`, and re-route the two raw `this.prisma.*` writes to
`tenantPrisma.getClient()`:

| Line | Write | Before | After |
|------|-------|--------|-------|
| ~673 | `priceList.updateMany` (priceCents) | `this.prisma` | `getClient()` — joins tx |
| ~684 | `productRepo.save(product)` | already `getClient()` (repo:80) | unchanged — joins tx |
| ~687 | `variant.updateMany {minQuantity:0}` (useStock=false transition) | `this.prisma` | `getClient()` — joins tx |
| after | `rearmAlertAfterEdit` | new | inside tx |

**Alternatives considered**: Wrap only `save()` + rearm.
**Rationale (critical trap CRITICAL-1)**: `runInTransaction` sets the tx client
in the CLS slot that `getClient()` reads. `this.prisma` (`PrismaService`)
bypasses CLS entirely. If lines 673 and 687 stay on `this.prisma`, they
auto-commit OUTSIDE the tx with undefined ordering relative to rearm — the exact
atomicity split this change exists to prevent. Both raw writes MUST be
re-routed so the SINGLE commit covers priceList + save + variant-min-zeroing +
rearm together.

### Decision: The variant SELECT MUST JOIN the parent product's useStock

**Choice**: The `variants` branch re-read joins `products` and gates on the
PARENT's `useStock = true` (Variant has no `useStock` column of its own):

```sql
SELECT v."quantity"::int AS "q", v."minQuantity"::int AS "m"
  FROM "variants" v
  JOIN "products" p ON p."id" = v."productId" AND p."tenantId" = v."tenantId"
 WHERE v."id" = ${variantId} AND v."productId" = ${productId}
   AND v."tenantId" = ${tenantId} AND p."useStock" = true
```

**Alternatives considered**: Read `variants` alone (no join), matching the
product branch's local `useStock` predicate.
**Rationale (critical trap CRITICAL-2)**: `useStock` lives ONLY on `Product` in
`prisma/schema.prisma`; `Variant` has no such column. On a `useStock=false`
product, `updateVariant` still applies `dto.quantity` and forces
`minQuantity:0`, so the row lands `quantity>0 / minQuantity=0` → `q>m` TRUE. A
join-less SELECT would call `rearm` on a non-stock variant, violating the spec
("MUST NOT run alert logic for non-stock products"). The JOIN + `p."useStock" =
true` predicate returns 0 rows for non-stock parents → early return → no rearm.
The tenant-scoped join key (`p."tenantId" = v."tenantId"`) preserves isolation.

### Decision: Route both edit writes through the tenant client; keep validation out

**Choice**: `updateVariant`'s `this.prisma.variant.update(...)` (~834) becomes
`tenantPrisma.getClient().variant.update(...)` so it joins the tx. It preserves
the existing conditional `data` spread and the `.then(enrichVariantCostResponse)`
chain verbatim. `updateVariant` has NO other raw `this.prisma.*` writes in its
persistence tail (only reads/uniqueness checks precede it). Prisma's `@updatedAt`
keeps working through `getClient()`, so no manual `NOW()` is needed.
**Rationale (WARNING-2)**: SKU/barcode uniqueness (`isSkuTaken`/`isBarcodeTaken`),
the initial `findFirst`, and the SAT-catalog `assertExists` (~620) MUST stay
OUTSIDE `runInTransaction`. Only the persistence tail + rearm go inside. Pulling
validation into the tx would burn a transaction on a validation failure.

## Data Flow

```
ProductsService.update(id, dto)
  ├─ findFirst / SKU+barcode uniqueness / satCatalog.assertExists   ← OUTSIDE tx
  ├─ mutate domain product + normalizeStockConfiguration
  └─ runInTransaction(() => {                                       ── tx boundary START
        priceList.updateMany  ── getClient() ──► price_lists row    (was this.prisma:673)
        productRepo.save      ── getClient() ──► products row       (repo:80, joins free)
        if useStock false→true transition:
          variant.updateMany {minQuantity:0} ── getClient() ──► variants (was this.prisma:687)
        if (qtyChanged || minChanged)
          productRepo.rearmAlertAfterEdit({ productId, variantId:null })
             ├─ guard: isInTransaction() else throw
             ├─ SELECT products.quantity,minQuantity WHERE useStock=true
             └─ if q > m → alertState.rearm({ tx, tenantId, productId, variantId:null })
     })                                                             ── single commit ──► tx END
  └─ buildFullResponse(id)                                          ← OUTSIDE tx

ProductsService.updateVariant(productId, variantId, dto)
  ├─ findFirst(+product.useStock) / SKU+barcode uniqueness         ← OUTSIDE tx
  └─ runInTransaction(() => {                                       ── tx boundary START
        getClient().variant.update {conditional data spread}       (was this.prisma:834)
        if (qtyChanged || minChanged)
          productRepo.rearmAlertAfterEdit({ productId, variantId })
             ├─ guard: isInTransaction() else throw
             ├─ SELECT v.quantity,minQuantity JOIN products p ON p.useStock=true
             └─ if q > m → alertState.rearm({ tx, tenantId, productId, variantId })
     })                                                             ── single commit ──► tx END
  └─ .then(enrichVariantCostResponse)                              ← chain preserved
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/products/domain/product.repository.ts` | Modify | Add `rearmAlertAfterEdit` to `IProductRepository` |
| `src/products/infrastructure/prisma-product.repository.ts` | Modify | Implement `rearmAlertAfterEdit` (mirror `incrementStockForRestock` guard/tenant/SELECT/STRICT-`>`/`rearm`; variant SELECT JOINs `products.useStock`) |
| `src/products/products.service.ts` | Modify | `update` (~665-691): wrap priceList write + `save` + useStock-false variant-min zeroing + rearm in ONE `runInTransaction`; re-route lines ~673 & ~687 to `getClient()`. `updateVariant` (~834): re-route variant write to `getClient()`, wrap persistence + rearm in `runInTransaction`, keep validation outside |

## Interfaces / Contracts

```ts
// IProductRepository — new method
rearmAlertAfterEdit(item: {
  productId: string;
  variantId?: string | null;
}): Promise<void>;
```

```ts
// PrismaProductRepository — pseudocode
async rearmAlertAfterEdit({ productId, variantId }) {
  if (!this.tenantPrisma.isInTransaction())
    throw new Error('rearmAlertAfterEdit must be called inside runInTransaction');
  const prisma = this.tenantPrisma.getClient();
  const tenantId = this.tenantPrisma.getTenantId();

  if (variantId) {
    // JOIN products: Variant has no useStock column; gate on parent's flag.
    const rows = await prisma.$queryRaw`
      SELECT v."quantity"::int AS "q", v."minQuantity"::int AS "m"
        FROM "variants" v
        JOIN "products" p ON p."id" = v."productId" AND p."tenantId" = v."tenantId"
       WHERE v."id" = ${variantId} AND v."productId" = ${productId}
         AND v."tenantId" = ${tenantId} AND p."useStock" = true`;
    if (rows.length !== 1) return;                     // non-stock parent → 0 rows
    if (rows[0].q > rows[0].m)                          // STRICT >
      await this.alertState.rearm({ tx: prisma, tenantId, productId, variantId });
    return;
  }

  const rows = await prisma.$queryRaw`
    SELECT "quantity"::int AS "q", "minQuantity"::int AS "m"
      FROM "products"
     WHERE "id" = ${productId} AND "tenantId" = ${tenantId}
       AND "useStock" = true`;                          // non-stock → 0 rows → no-op
  if (rows.length !== 1) return;
  if (rows[0].q > rows[0].m)
    await this.alertState.rearm({ tx: prisma, tenantId, productId, variantId: null });
}
```

```ts
// Service change-detection (both paths): trigger on RESULTING pair, not dto flags.
// Validation already ran OUTSIDE this block. Persistence tail + rearm go inside.
const changed = dto.quantity !== undefined || dto.minQuantity !== undefined;
await this.tenantPrisma.runInTransaction(async () => {
  await persistTail();                                 // ALL getClient() writes
  if (changed)
    await this.productRepo.rearmAlertAfterEdit({ productId: id, variantId });
});
```

## Simple vs Variant Mapping

| Path | Write table(s) | Read (SELECT) | `variantId` arg | `rearm` key |
|------|----------------|---------------|-----------------|-------------|
| `update` (simple) | `price_lists`, `products`, (`variants` on useStock-off) | `products` (`useStock=true`) | `null` | `'__PRODUCT__'` |
| `updateVariant` | `variants` | `variants` JOIN `products` (`p.useStock=true`) | `variantId` | `variantId` |

`rearm` maps `variantId ?? '__PRODUCT__'` itself — the caller passes `null` for
simple products; the sentinel is applied inside stock-alerts (unchanged).

## Guaranteed No-ops

- **`useStock = false` (product path)**: `normalizeStockConfiguration` zeroes
  qty/min; the product SELECT carries `AND "useStock" = true` → 0 rows → early
  return. No rearm, no error (Scenario: useStock=false).
- **`useStock = false` (variant path)**: even though `updateVariant` forces
  `minQuantity:0` and may leave `quantity>0` (q>m TRUE), the SELECT's JOIN gates
  on `p."useStock" = true` → 0 rows → early return. No rearm on non-stock
  variants (spec: "MUST NOT run alert logic for non-stock products").
- **`hasVariants = true` product path (harmless no-op)**: if `update` receives
  `dto.quantity` on a `hasVariants=true` product, `normalizeStockConfiguration`
  zeroes qty/min to 0, so `changed` is true and rearm runs — but the SELECT
  returns `q=0/m=0`, `0 > 0` is false → no rearm. The product-path gate CAN fire
  here; it resolves to a safe no-op.
- **No pre-existing state row**: `rearm`'s `UPDATE` matches 0 rows, returns 0,
  does not throw, seeds nothing (Scenario: no pre-existing alert-state row).
- **`stock <= min`**: STRICT `>` gate is false → `rearm` never called;
  `seedAndFlip` is never referenced on this path (Scenarios: stock==min,
  downward edit).

## Scenario Coverage

| Scenario | Mechanism |
|----------|-----------|
| Simple raise → rearm → re-fire | `products` SELECT, `null` key, STRICT `>` |
| Variant raise → rearm | `variants` JOIN `products` SELECT, `variantId` key |
| Lower `minQuantity` only | `changed` true (min moved); gate on RESULTING pair |
| `stock == min` → no rearm | STRICT `>` (equality excluded) |
| Downward → no seedAndFlip | gate false; `seedAndFlip` never called from edits |
| No state row → no-op | `rearm` matches 0 rows |
| Ambient-tx guard | `isInTransaction()` throws; service wraps in `runInTransaction` |
| `useStock=false` (product) | `useStock=true` predicate → 0 rows |
| `useStock=false` (variant) | JOIN `p.useStock=true` → 0 rows |

## Testing Strategy

| Layer | What | Approach |
|-------|------|----------|
| Adapter | `rearmAlertAfterEdit` guard, STRICT `>`, table/key per branch, variant JOIN gates on parent `useStock`, 0-row no-op | Extend `prisma-product.repository.spec.ts` (existing restock fixtures) |
| Service | `update`/`updateVariant` wrap ALL persistence-tail writes via `getClient()`; validation outside tx; change-gate | Assert single `runInTransaction`, all writes join tx, rearm called only on qty/min change |
| Integration | 8 spec scenarios incl. edit→rearm→sale re-fire; non-stock variant no-op | End-to-end via seeded `StockAlertState` |

## Migration / Rollout

No migration required. Additive method + service wrap; no schema change.

## Open Questions

- None. All anchors verified against source (`update` 583-694, `updateVariant`
  805-873, restock STRICT `>` at repo 467/493, `save` tx-join at repo 80).
