# Batch Deletion — Exploration

**Date**: 2026-07-24  
**Change**: `batch-delete`

## 1. Current State

### 1.1 Single-Delete Pattern (Universal)

Every `@Delete` endpoint follows an identical pattern:

```
Controller  → Service               → Repository
@Delete(':id')  findById(id) guard      delete(id)
                repo.delete(id)
```

The canonical implementation (Products):

```typescript
// products.controller.ts:79-84
@Delete(':id')
@HttpCode(HttpStatus.NO_CONTENT)
@RequirePermissions(['delete', 'Product'])
remove(@Param('id', ParseUUIDPipe) id: string) {
  return this.productsService.remove(id);
}

// products.service.ts:781-785
async remove(id: string): Promise<void> {
  const product = await this.productRepo.findById(id);
  if (!product) throw new EntityNotFoundError('Product', id);
  await this.productRepo.delete(id);
}
```

**Variations by entity:**
- **Brand/Category**: Same pattern; comment documents `onDelete: SetNull` behavior
- **Customer**: Same pattern; CustomerAddress/PromotionCustomer cascade automatically
- **Promotion**: Same pattern; join tables cascade automatically
- **GlobalPriceList**: Extra guard — cannot delete the `isDefault` PUBLICO list
- **Employee**: **No delete** — uses `terminate()` (soft status change to TERMINATED) + `reactivate()`
- **Sale**: **No hard delete** — uses cancel flow (DRAFT→CANCELED status change). `DELETE /sales/:id` is `deleteDraft` (only on DRAFT sales)
- **SaleComment**: Soft-delete only (`deletedAt` column)
- **File**: Extra logic — deletes remote storage blob after DB row

### 1.2 Permission System

**5 actions only**: `create | read | update | delete | manage`  
**No "batch" action exists.**

`AppActions` type definition:
```typescript
export type AppActions = 'create' | 'read' | 'update' | 'delete' | 'manage';
```

Each `@Delete` endpoint uses `@RequirePermissions(['delete', '{Subject}'])` where `{Subject}` is one of 23 registered subjects (Product, Sale, Customer, Brand, Category, etc.).

`PermissionsGuard` checks each permission individually via CASL `ability.can(action, subject)`. There is no support for composite or compound permissions.

### 1.3 Existing Bulk Patterns (for reference)

**Bulk upsert** (variant prices) — closest analog to what batch-delete would follow:
```typescript
// products.controller.ts:164-176
@Put(':productId/variants/:variantId/prices')
@RequirePermissions(['update', 'Product'])  // reuses existing action
bulkUpsertVariantPrices(
  @Param('productId', ParseUUIDPipe) productId: string,
  @Param('variantId', ParseUUIDPipe) variantId: string,
  @Body() dto: BulkUpsertVariantPricesDto,
)
```

Key patterns from bulk upsert:
- Uses existing `update` permission (no special "bulk" action)
- DTO validates array elements with `class-validator`
- Service runs inside `$transaction`
- Validates all IDs exist before processing
- Uses Prisma `deleteMany` + `createMany` for child rows (e.g., `variantTierPrice.deleteMany`)

**Prisma deleteMany usage:**
- `deleteMany` is **already used** in production code (sales, promotions, notification-config, orders, seed scripts)
- Tenant-scoped: `TenantPrismaService` middleware auto-injects `tenantId` into `deleteMany` where clauses
- Used inside `$transaction` for safety in most cases

### 1.4 Multi-Tenant Context

All tenant-scoped entities use `TenantPrismaService` which:
- Provides `getClient()` returning a tenant-prefixed Prisma proxy
- Auto-injects `tenantId` into `where` clauses for `delete`, `deleteMany`, `update`, `updateMany`
- The CLS (Continuation Local Storage) holds `tenantId` per request

This means batch deletion MUST respect tenant boundaries — the middleware handles it at the Prisma level, but service-layer guard checks must also verify tenant ownership.

---

## 2. Entity Dependency Graph

```
Tenant
 ├── Brand ───────────→ Product (SetNull)
 ├── Category ────────→ Product (SetNull)
 ├── Product
 │   ├── Variant ─────→ VariantPrice, VariantTierPrice (Cascade)
 │   ├── Lot ─────────→ (Cascade)
 │   ├── ProductImage → FileObject (SetNull)
 │   └── PriceList ───→ TierPrice (Cascade)
 ├── Customer
 │   ├── CustomerAddress (Cascade)
 │   └── Sale (SetNull)
 ├── Sale
 │   ├── SaleItem ────→ Product (Restrict), Variant (Restrict), Promotion (SetNull)
 │   ├── SalePayment ─→ User (SetNull)
 │   ├── SaleRefund ──→ SalePayment (SetNull)
 │   ├── SaleComment ─→ User (Restrict) [soft-delete]
 │   ├── SaleIdempotency (SetNull)
 │   ├── ReceiptEvidence → User (SetNull)
 │   ├── SalePromotionApplied → Promotion (SetNull)
 │   ├── SalePromotionVeto → Promotion (Cascade)
 │   └── SalePromotionOptIn → Promotion (Cascade)
 ├── Promotion
 │   ├── PromotionTargetItem (Cascade)
 │   ├── PromotionCustomer → Customer (Cascade)
 │   ├── PromotionPriceList → GlobalPriceList (Cascade)
 │   ├── PromotionDayOfWeek (Cascade)
 │   └── SaleItem (SetNull), SalePromotionApplied (SetNull)
 ├── Employee
 │   ├── EmployeeSalaryHistory (Cascade) [append-only]
 │   ├── EmployeePositionHistory (Cascade) [append-only]
 │   ├── EmployeeDocument (Cascade)
 │   ├── EmployeeTimeOff (Cascade)
 │   ├── EmployeeEmergencyContact (Cascade)
 │   └── Employee (self-reference: manager → subordinates) (SetNull)
 ├── Role ────────────→ RolePermission (Cascade), TenantMembership (Cascade)
 ├── TenantMembership  → User (Cascade)
 ├── NotificationSettings, NotificationRecipient, NotificationAction
 ├── StockAlertState
 └── OutboxEvent

GlobalPriceList ←── Customer (SetNull), Sale (SetNull), PromotionPriceList (Cascade)
FileObject ←────── ProductImage (SetNull)
User ←──────────── Sale, SalePayment, SaleComment, ReceiptEvidence, NotificationRecipient
```

**Legend**: `→` = references via FK, `Restrict` = Prisma blocks delete if child exists, `SetNull` = FK nulled on delete, `Cascade` = child deleted with parent.

---

## 3. Per-Entity Batch Delete Viability Assessment

### ✅ Safe — Low Risk

| Entity | Guards | Cascade Behavior | Notes |
|--------|--------|-----------------|-------|
| **Brand** | findById guard | Products have `onDelete: SetNull` | Simple lookup table. No audit concern. |
| **Category** | findById guard | Products have `onDelete: SetNull` | Same as Brand. |
| **SaleComment** | findById + ownership guard | Already soft-delete only (`deletedAt`) | Soft-delete already implemented. Batch would just set `deletedAt` on multiple. |
| **File** | findById guard + storage cleanup | ProductImage `onDelete: SetNull` | Blob cleanup must be best-effort (already is). |
| **Role** | findById guard | Cascading join tables (role_permissions, tenant_memberships) | System roles may need protection (no `isSystem` guard exists today). |
| **TenantMembership** | findById guard | None | Simple junction table. |
| **Lot** | findById + product ownership | Cascade from Product | Currently embedded in product context. |
| **PriceList** (tenant-level) | findById + product ownership | TierPrice, VariantPrice cascade | Price data, no audit concern. |
| **VariantPrice / TierPrice** | findById + ownership | None | Simple price data. |
| **OutboxEvent** | None | Cascade from Tenant | System table, batch delete unlikely to be needed. |
| **Notification* / StockAlertState** | findById guard | Cascade from Tenant | Config/state tables. |

### ⚠️ Conditional — Needs Extra Guards

| Entity | Guards Needed | Risk | Assessment |
|--------|--------------|------|------------|
| **Product** | Must check no active `SaleItem` or `OrderItem` references (`onDelete: Restrict`) | **Medium** | `prisma.product.delete()` will throw P2003 FK violation if SaleItem/OrderItem reference it. Batch delete must either: (a) pre-validate no references exist, (b) only delete products not in any sale/order, or (c) handle partial failures. |
| **Customer** | Should check no active `Sale` references | **Medium** | Sale has `onDelete: SetNull` so technically safe, BUT deleting a customer that has many sales loses audit traceability. Consider: only delete customers with zero sales, or those created within last N hours. |
| **Promotion** | Existing `SaleItem.promotionId` uses `SetNull` | **Medium** | Hard-delete with cascade on join tables is technically clean, but orphan `promotionId` references in `SaleItem` and `SalePromotionApplied` lose audit meaning. Consider soft-ending instead (use `end()` pattern — already exists). |
| **GlobalPriceList** | Default list protection | **Medium** | Already has guard for `isDefault`. Cascade on PriceList → VariantPrice → TierPrice is safe. `Customer` and `Sale` reference with `SetNull`. Major impact: deleting a price list nulls references on all sales/customers. |
| **Order** | Must check status/completion | **Low** | Not clear if orders support deletion at all. If so, cascade on OrderItem is safe. |
| **EmployeeDocument** | findById + employee ownership | **Low** | Blob cleanup best-effort. Already understood pattern. |

### ❌ Should Never Be Batch Deleted

| Entity | Reason | Alternative |
|--------|--------|-------------|
| **Sale** | Legal/compliance audit trail. Sales have folios, payments, refunds — deleting removes financial records. | Use `cancel` flow (already exists). Batch cancel could be considered. |
| **Employee** | HR audit trail. Salary history, position history, documents all require retention. | Use `terminate` flow (already exists). |
| **User** | Auth identity. Referenced by sales, comments, payments, memberships. `onDelete: Restrict` on most FKs. | Deactivate (`isActive = false`). |
| **Tenant** | Top of cascade. Deletes everything. | Administrative action only, never batch from UI. |

---

## 4. Business Rules Per Entity (Guard Summary)

| Entity | Pre-Delete Guards | Works for Batch? |
|--------|------------------|-----------------|
| Brand | `findById` | ✅ Simple pass-through |
| Category | `findById` | ✅ Simple pass-through |
| Product | `findById` only — no SaleItem/OrderItem check | ❌ Needs FK check added |
| Customer | `findById` only — no Sale check | ❌ Needs audit consideration |
| Promotion | `findById` only | ⚠️ Technically works (cascade clean), but audit concern |
| GlobalPriceList | `findById` + `!isDefault` | ⚠️ Only non-default lists |
| EmployeeDocument | `findById` + employee ownership + blob cleanup | ✅ Pattern exists |
| EmployeeEmergencyContact | `findById` + employee ownership | ✅ Pattern exists |
| File | `findById` + blob cleanup | ✅ Pattern exists |
| Role | `findById` only — no `isSystem` check | ⚠️ System role protection missing |

---

## 5. Recommended Approach Directions

### Option A: Generic Batch Delete Endpoint (Flexible, Higher Risk)

One endpoint per entity: `POST /{entity}/batch-delete` with `{ ids: string[] }` body.

```
POST /products/batch-delete  { ids: [...] }
POST /brands/batch-delete     { ids: [...] }
POST /categories/batch-delete { ids: [...] }
... (select entities only)
```

**Cons**: Custom guard logic per entity, risk of partial failures, harder to reason about.

### Option B: Shared Batch Service with Per-Entity Strategies (Balanced)

Create a `BatchDeleteService` with a strategy pattern:

```typescript
interface BatchDeleteStrategy {
  validate(ids: string[]): Promise<ValidationResult>;
  execute(ids: string[]): Promise<BatchDeleteResult>;
}
```

Each entity's service provides its validation rules (FK checks, state checks), and the shared service handles transactions, error collection, and result formatting.

**Pros**: Reusable, testable, each entity declares its own rules.
**Cons**: More abstraction, more files.

### Option C: Inline Batch Delete in Existing Services (Pragmatic)

Add `removeMany(ids: string[])` methods to existing services that need batch delete. Keep it simple — each service handles its own validation and reporting.

**Pros**: Least abstraction, follows existing patterns, easy to implement incrementally.
**Cons**: Slightly repetitive, but each entity genuinely has different rules.

### **Recommendation: Option C (Inline)**

The variation in pre-delete rules across entities is significant enough that a "generic" batch service would become a leaky abstraction. The existing codebase pattern (hexagonal architecture, service-level business logic) supports adding `removeMany` to services naturally.

---

## 6. Risks

1. **Partial Failure**: If batch-deleting 10 products and 1 fails (FK violation on sale reference), should the entire operation roll back or partially succeed? Recommendation: all-or-nothing with `$transaction`.

2. **Permission Gap**: The current permission system has no "batch" action. Solutions:
   - (a) Add `batch_delete` action — requires DB migration, seed update, CASL update
   - (b) Reuse `delete` action — simpler, but coarse-grained
   - (c) Add a separate `BatchDelete` subject alongside specific entity subjects
   - **Recommendation**: (b) — reuse `delete`. Batch delete is fundamentally "delete many" — same intent, same authorization. No DB migration needed.

3. **Prisma deleteMany with `Restrict` FKs**: `deleteMany` will fail atomically if ANY target has a restricting FK. This is actually good — it forces validation. But the service MUST pre-validate and provide clear error messages (which IDs failed and why).

4. **Multi-Tenant Isolation**: The `TenantPrismaService` middleware auto-injects `tenantId` into `deleteMany` where clauses, which prevents cross-tenant deletion. However, the service MUST validate that all IDs belong to the current tenant BEFORE the delete to produce user-friendly errors.

5. **Soft-Delete Inconsistency**: SaleComment uses soft-delete. If batch-delete is implemented as hard-delete for all entities, SaleComment needs special handling to do soft batch-delete.

6. **Blob Orphans**: For FileObject and EmployeeDocument, batch delete MUST handle blob cleanup. Best-effort logging is acceptable (existing pattern).

---

## 7. Implementation Complexity Estimate

| Component | Complexity | Notes |
|-----------|------------|-------|
| DTO (batch delete input) | Low | `{ ids: string[] }` with `@IsArray() @IsUUID('4', { each: true }) @ArrayMinSize(1) @ArrayMaxSize(100)` |
| Controller endpoints | Low | One new `@Post('batch-delete')` per entity |
| Service `removeMany` | Medium | Per-entity validation logic differs |
| Repository `deleteMany` | Low | Prisma `deleteMany({ where: { id: { in: ids } } })` |
| Permission integration | Low | Reuse `delete` action; no new permission needed |
| Testing | Medium | Need per-entity partial failure + cascade tests |
| Frontend integration | Out of scope | UI patterns not explored |

---

## 8. Ready for Proposal

**Yes** — the exploration is thorough enough to proceed to `sdd-propose`.

**What the orchestrator should tell the user**: The codebase is well-understood. Batch delete is viable for ~12 entity types with varying guard complexity. The main decision is which entities to include in the first iteration. Recommendation: start with the safe entities (Brand, Category, Lot, File, TenantMembership, NotificationRecipient) and incrementally add conditional entities in later slices.
