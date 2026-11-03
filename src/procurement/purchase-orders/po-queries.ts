import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type ProcurementPurchaseOrder,
  type ProcurementPurchaseOrderLine,
  type Product,
  type Variant,
} from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { lockCatalogLifecycle } from '../../catalog-editorial/infrastructure/prisma-catalog-lifecycle-gate';
import {
  requirePurchaseOrderAuthority,
  type PurchaseOrderPrincipal,
} from './po-authority';
import { PurchaseOrderCursor } from './po-cursor';
import {
  parsePurchaseOrderId,
  parsePurchaseOrderListQuery,
  PurchaseOrderContractError,
  type Page,
  type PurchaseOrder,
  type PurchaseOrderSummary,
  type SupplierDisplaySnapshot,
  type OrderInput,
} from './po-contract';
import {
  buildPurchaseOrderDiagnostics,
  type PurchaseOrderReferenceFacts,
} from './po-validation';

type StoredOrder = ProcurementPurchaseOrder & {
  lines: ProcurementPurchaseOrderLine[];
};
type ReadProduct = Pick<
  Product,
  'id' | 'name' | 'type' | 'unit' | 'hasVariants'
>;
type ReadVariant = Pick<Variant, 'id' | 'name' | 'productId'>;

// One statement observes the header and ordered lines at the same MVCC snapshot.
// Correlation includes tenant even though ids are globally unique today.
const projection = Prisma.sql`o.*, COALESCE((
  SELECT jsonb_agg(l ORDER BY l."position")
  FROM "procurement_purchase_order_lines" l
  WHERE l."tenantId" = o."tenantId" AND l."orderId" = o."id"
), '[]'::jsonb) AS "lines"`;

function input(row: StoredOrder): OrderInput {
  return {
    supplierId: row.supplierId,
    note: row.note,
    location: { detail: row.locationDetail },
    lines: row.lines.map((line) => ({
      lineId: line.lineId,
      productId: line.productId,
      variantId: line.variantId,
      orderedQuantity: line.orderedQuantity,
      informedUnitCost: line.informedUnitCostPresent
        ? {
            amount: line.costAmount,
            currency: line.currency as 'MXN' | null,
            unit: line.costUnit,
            taxBasis: line.taxBasis,
          }
        : null,
    })),
  };
}

/** Deliberately not the command reference reader: that helper takes UPDATE locks.
 * Bounded tenant-qualified SELECTs batch the entire returned page, never per order.
 */
async function resolvePage(
  tx: Prisma.TransactionClient,
  tenantId: string,
  tenantName: string,
  rows: StoredOrder[],
): Promise<PurchaseOrder[]> {
  if (!rows.length) return [];
  const supplierIds = [
    ...new Set(rows.flatMap((row) => (row.supplierId ? [row.supplierId] : []))),
  ].sort();
  const productIds = [
    ...new Set(
      rows.flatMap((row) =>
        row.lines.flatMap((line) => (line.productId ? [line.productId] : [])),
      ),
    ),
  ].sort();
  const variantIds = [
    ...new Set(
      rows.flatMap((row) =>
        row.lines.flatMap((line) => (line.variantId ? [line.variantId] : [])),
      ),
    ),
  ].sort();
  const suppliers = supplierIds.length
    ? await tx.$queryRaw<SupplierDisplaySnapshot[]>(Prisma.sql`
    SELECT s."id", s."displayName", s."status" FROM "procurement_suppliers" s
    WHERE s."tenantId" = ${tenantId} AND s."id" IN (${Prisma.join(supplierIds)})`)
    : [];
  const products = productIds.length
    ? await tx.$queryRaw<ReadProduct[]>(Prisma.sql`
    SELECT p."id", p."name", p."type", p."unit", p."hasVariants" FROM "products" p
    WHERE p."tenantId" = ${tenantId} AND p."id" IN (${Prisma.join(productIds)})`)
    : [];
  const variants = variantIds.length
    ? await tx.$queryRaw<ReadVariant[]>(Prisma.sql`
    SELECT v."id", v."name", v."productId" FROM "variants" v
    WHERE v."tenantId" = ${tenantId} AND v."id" IN (${Prisma.join(variantIds)})`)
    : [];
  const supplierById = new Map(suppliers.map((value) => [value.id, value]));
  const productById = new Map(products.map((value) => [value.id, value]));
  const variantById = new Map(variants.map((value) => [value.id, value]));
  return rows.map((row) => {
    const order = input(row);
    const supplier = supplierById.get(row.supplierId ?? '');
    const facts: PurchaseOrderReferenceFacts = {
      supplier: supplier?.status ?? 'missing',
      lines: Object.fromEntries(
        order.lines.map((line) => {
          const product = productById.get(line.productId ?? '');
          const variant = variantById.get(line.variantId ?? '');
          return [
            line.lineId,
            {
              product: product
                ? {
                    type: product.type,
                    unit: product.unit,
                    hasVariants: product.hasVariants,
                  }
                : 'missing',
              variant: variant
                ? { belongsToProduct: variant.productId === line.productId }
                : 'missing',
            },
          ];
        }),
      ),
    };
    const diagnostics = buildPurchaseOrderDiagnostics(order, facts);
    const invalidLines = new Set(
      diagnostics.issues
        .filter((issue) =>
          [
            'REFERENCE_UNAVAILABLE',
            'REFERENCE_INCOMPATIBLE',
            'UNIT_MISMATCH',
            'QUANTITY_FRACTION_NOT_ALLOWED',
          ].includes(issue.code),
        )
        .map((issue) => issue.path.split('/')[2]),
    );
    return {
      ...order,
      id: row.id,
      status: 'DRAFT',
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      supplierDisplaySnapshot:
        row.supplierId === null
          ? null
          : (supplier ??
            (row.supplierDisplaySnapshot as SupplierDisplaySnapshot | null)),
      lineDisplaySnapshots: row.lines.map((line, index) => {
        if (invalidLines.has(String(index)))
          return {
            lineId: line.lineId,
            productName: line.productName,
            variantName: line.variantName,
            unit: line.unitSnapshot,
          };
        const product = productById.get(line.productId ?? '');
        const variant = variantById.get(line.variantId ?? '');
        return {
          lineId: line.lineId,
          productName: product?.type === 'PRODUCT' ? product.name : null,
          unit: product?.type === 'PRODUCT' ? product.unit : null,
          variantName:
            product?.type === 'PRODUCT' &&
            product.hasVariants &&
            variant?.productId === product.id
              ? variant.name
              : null,
        };
      }),
      lineSubtotals: diagnostics.lineSubtotals,
      locationSnapshot: { tenantId, tenantName, detail: row.locationDetail },
      validation: { issues: diagnostics.issues },
    };
  });
}

@Injectable()
export class PurchaseOrderQueries {
  constructor(
    private readonly db: TenantPrismaService,
    private readonly cls: ClsService<TenantClsStore>,
    private readonly cursor: PurchaseOrderCursor,
  ) {}

  async getDraft(value: unknown): Promise<PurchaseOrder> {
    return this.sanitized(() => {
      const id = parsePurchaseOrderId(value);
      return this.read(async (tx, scope, tenantName) => {
        const rows = await tx.$queryRaw<StoredOrder[]>(Prisma.sql`
          SELECT ${projection} FROM "procurement_purchase_orders" o
          WHERE o."tenantId" = ${scope.tenantId} AND o."id" = ${id} AND o."status" = 'DRAFT'`);
        if (!rows[0]) throw new PurchaseOrderContractError('NOT_FOUND');
        return (await resolvePage(tx, scope.tenantId, tenantName, rows))[0];
      });
    });
  }

  async listDrafts(value: unknown): Promise<Page<PurchaseOrderSummary>> {
    return this.sanitized(() => {
      const query = parsePurchaseOrderListQuery(value);
      return this.read(async (tx, scope, tenantName) => {
        const binding = {
          tenantId: scope.tenantId,
          supplierId: query.supplierId,
        };
        const after = query.cursor
          ? this.cursor.decode(query.cursor, binding)
          : undefined;
        const rows = await tx.$queryRaw<StoredOrder[]>(Prisma.sql`
          SELECT ${projection} FROM "procurement_purchase_orders" o
          WHERE o."tenantId" = ${scope.tenantId} AND o."status" = 'DRAFT'
          ${query.supplierId ? Prisma.sql`AND o."supplierId" = ${query.supplierId}` : Prisma.empty}
          ${after ? Prisma.sql`AND (o."createdAt", o."id") < (${new Date(after.createdAt)}, ${after.id})` : Prisma.empty}
          ORDER BY o."createdAt" DESC, o."id" DESC LIMIT ${query.limit + 1}`);
        const orders = await resolvePage(
          tx,
          scope.tenantId,
          tenantName,
          rows.slice(0, query.limit),
        );
        const items = orders.map(
          (order): PurchaseOrderSummary => ({
            id: order.id,
            version: order.version,
            status: order.status,
            supplierDisplaySnapshot: order.supplierDisplaySnapshot,
            lineCount: order.lines.length,
            issueCount: order.validation.issues.length,
            note: order.note,
            locationDetail: order.location.detail,
            createdAt: order.createdAt,
            updatedAt: order.updatedAt,
          }),
        );
        const last = items.at(-1);
        return {
          items,
          nextCursor:
            rows.length > query.limit && last
              ? this.cursor.encode(binding, last)
              : null,
        };
      });
    });
  }

  private async sanitized<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof PurchaseOrderContractError) throw error;
      throw new PurchaseOrderContractError('INTERNAL_ERROR');
    }
  }

  /** Supplier query precedent: current authority held through bounded reads;
   * business/reference rows take no locks and no durable evidence is written.
   */
  private async read<T>(
    work: (
      tx: Prisma.TransactionClient,
      scope: PurchaseOrderPrincipal,
      tenantName: string,
    ) => Promise<T>,
  ): Promise<T> {
    const actorId = this.cls.get('userId');
    if (typeof actorId !== 'string' || !actorId.trim())
      throw new PurchaseOrderContractError('UNAUTHORIZED');
    const tenantId = this.cls.get('tenantId');
    if (
      typeof tenantId !== 'string' ||
      !tenantId.trim() ||
      this.db.getTenantId() !== tenantId
    )
      throw new PurchaseOrderContractError('FORBIDDEN');
    if (this.db.isInTransaction())
      throw new PurchaseOrderContractError('INTERNAL_ERROR');
    const scope = { actorId, tenantId };
    return this.db.runInTransaction(async () => {
      const tx = this.db.getClient() as unknown as Prisma.TransactionClient;
      await lockCatalogLifecycle(tx, 'shared');
      const tenants = await tx.$queryRaw<
        { id: string; isActive: boolean; name: string }[]
      >(Prisma.sql`
        SELECT t."id", t."isActive", t."name" FROM "tenants" t
        WHERE t."id" = ${tenantId} FOR SHARE OF t`);
      if (tenants[0]?.id !== tenantId || tenants[0].isActive !== true)
        throw new PurchaseOrderContractError('FORBIDDEN');
      await requirePurchaseOrderAuthority(tx, scope, 'READ');
      return work(tx, scope, tenants[0].name);
    }, Prisma.TransactionIsolationLevel.ReadCommitted);
  }
}
