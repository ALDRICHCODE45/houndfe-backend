# Purchase-order draft storage — O3b T1

## Boundary and evidence

Storage/catalog only: S1, S3, S4, S9, S11 and the restrictive-FK prerequisite of S12. Decimal/MXN storage checks also support S5/S6. No endpoints, CAS implementation, authority enforcement, reference diagnostics, supplier-delete error mapping, stock, money, outbox, or default ordinary-role grants are implemented here.

Migration `20261104010000_procurement_purchase_order_drafts/migration.sql` is additive DDL only. It has **not been executed against PostgreSQL**. Offline specs check schema/DDL drift, tenant argument injection, catalog shape and seed defaults; they do not prove SQL behavior. Disposable DB proof belongs to T5. No Prisma client regeneration was needed for these static tests; downstream command/query work must generate its isolated client before importing the new model types.

## Model and column contract for T3/T4

Prisma field names equal quoted SQL column names. UUID identities use `String`/`TEXT`, like suppliers (`@default(uuid())` for generated header/audit IDs); FE line UUID syntax and reference UUID syntax must be validated by the parser. No SQL UUID defaults or triggers are introduced.

| Prisma model | SQL table | Columns |
| --- | --- | --- |
| `ProcurementPurchaseOrder` | `procurement_purchase_orders` | `id`, `tenantId`, `supplierId`, `status`, `version`, `note`, `locationDetail`, `locationTenantName`, `supplierDisplaySnapshot`, `createdAt`, `updatedAt` |
| `ProcurementPurchaseOrderLine` | `procurement_purchase_order_lines` | `tenantId`, `orderId`, `lineId`, `position`, `productId`, `variantId`, `orderedQuantity`, `informedUnitCostPresent`, `costAmount`, `currency`, `costUnit`, `taxBasis`, `productName`, `variantName`, `unitSnapshot` |
| `ProcurementPurchaseOrderAudit` | `procurement_purchase_order_audits` | `id`, `tenantId`, `orderId`, `actorId`, `operation`, `orderVersion`, `beforeSnapshot`, `afterSnapshot`, `createdAt` |
| `ProcurementPurchaseOrderReceipt` | `procurement_purchase_order_receipts` | `tenantId`, `actorId`, `operation`, `target`, `idempotencyKey`, `orderId`, `requestHash`, `statusCode`, `responseBody`, `createdAt` |

Prisma delegates: `procurementPurchaseOrder`, `procurementPurchaseOrderLine`, `procurementPurchaseOrderAudit`, `procurementPurchaseOrderReceipt`.

- `ProcurementPurchaseOrderStatus`: only `DRAFT`, also the header default. O3c must add any later statuses in a forward migration.
- `ProcurementPurchaseOrderOperation`: `CREATE`, `REPLACE`, `DELETE`. PUT uses **REPLACE**, not the supplier operation enum's UPDATE.
- `ProcurementPurchaseOrderTaxBasis`: `INCLUDES_TAX`, `EXCLUDES_TAX`; nullable with no default.
- Header `version` defaults to 1 and is positive. `note`/`locationDetail` are nullable with SQL codepoint bounds 2000/500. `locationTenantName` is the saved tenant label; wire location snapshot combines it with header `tenantId` and `locationDetail`.
- `supplierDisplaySnapshot` is nullable JSON `{id, displayName, status}`. Commands retain/refresh labels according to baseline rules, not arbitrary client-supplied JSON. SQL does not enforce this JSON shape.
- Lines have compound identity `(tenantId, orderId, lineId)` and unique zero-based `position` per order. Position is nonnegative; contiguous positions and maximum 200 lines remain application rules.
- `productId`/`variantId` are nullable tenant-qualified scalar references: **no live product/variant FK**. `productName`, `variantName`, `unitSnapshot` retain last successful baseline labels. `costUnit` is the informed cost unit, distinct from `unitSnapshot`; both use existing `UnitOfMeasure`.
- `orderedQuantity` and `costAmount` are nullable canonical **TEXT**, never float. SQL regex bounds match S5/S6, with quantity >0 via a guarded exact numeric cast and amount >=0 by grammar. Trailing fractional zeroes are allowed by the specified input grammar. Subtotal normalization/calculation is application-only; no stored subtotal or order total.
- `informedUnitCostPresent=false` means wire `informedUnitCost:null`; all four cost fields must then be SQL NULL. `true` preserves a present object even with four null fields. Currency is only `MXN` or SQL NULL. No tax basis default, no conversion.

## Referential integrity and deletion

`po_supplier_fk`: `(tenantId,supplierId)` → `procurement_suppliers(tenantId,id)`, ON DELETE/UPDATE RESTRICT. The supplier composite unique already exists; it is not recreated. A null supplier is allowed. This prevents cross-tenant references and supplies T3's `SUPPLIER_HAS_PURCHASE_ORDERS` constraint signal; eligibility checks/error precedence still belong to T3.

Header hard deletion cascades **only to its lines**, through the composite tenant/order FK. Audits and receipts have only restrictive tenant FKs, never live order/supplier/actor FKs. Historical IDs survive header deletion and do not keep the supplier referenced. Tenant deletion remains restricted by durable evidence. This is not RLS or tamperproof auditing.

## Atomic command obligations

Commands must atomically save header/line replacement (or hard delete), one audit and one receipt after current authority, replay handling and CAS. SQL does not establish provenance, increment versions, lock rows, verify hashes/snapshot contents, or require evidence for each write. All four models are individually registered for tenant injection; raw clients must explicitly qualify tenant.

Audit uniqueness is `(tenantId,orderId,orderVersion)`. Store full wire baseline before/after snapshots, including labels and lines:

| Operation | beforeSnapshot | afterSnapshot | orderVersion |
| --- | --- | --- | --- |
| CREATE | SQL NULL (`Prisma.DbNull`) | JSON object | 1 |
| REPLACE | prior saved wire object | resulting saved wire object | prior + 1 |
| DELETE | prior saved wire object, with its prior version/timestamps | SQL NULL (`Prisma.DbNull`) | prior + 1 (deletion event) |

SQL requires the operation-specific null/object shapes. Audit `createdAt` is the event timestamp and `actorId` the historical actor scalar. Do not mutate prior snapshot versions or timestamps to represent deletion.

Receipt primary key: `(tenantId,actorId,operation,target,idempotencyKey)`. CREATE target is literal `collection`, status 201; REPLACE target is order ID, status 200; DELETE target is order ID, status 204 and response JSON null (`Prisma.JsonNull`, **not SQL NULL**). `orderId` always retains the affected order, including CREATE. Request hashes are lowercase 64-character SHA-256; exact keys retain whitespace and have 1–200 codepoints. Replay uses original JSON status/body, not mutable live state; DELETE emits no response bytes. No evidence expiry or feature update/delete API.

## Permissions and seeds

Subject `ProcurementPurchaseOrder`: exactly create/read/update/delete; no manage row. Existing permissions and global manage:all remain unchanged. Production bootstrap upserts identities and links only its existing manage:all grant. Manager/cashier dev-seed key lists contain no PO grants. Per parent L4 decision, Super Admin dev-seed inclusion (the same all-permission loop used for suppliers) is accepted; `prisma/seed.ts` is unchanged.

T3/T4 still own route-specific combined authority checks, persisted-authority-before-replay, and tenant-qualified reference validation. No permission catalog test proves endpoint authorization.
