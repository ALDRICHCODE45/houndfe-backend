import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type ProcurementPurchaseOrder,
  type ProcurementPurchaseOrderLine,
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
} from './po-contract';
import {
  deriveReferenceFacts,
  type ReferenceProduct,
  type ReferenceVariant,
} from './po-references';
import {
  buildPurchaseOrder,
  computePurchaseOrderTotals,
  storedOrderInput,
} from './po-response';

type StoredOrder = ProcurementPurchaseOrder & {
  lines: ProcurementPurchaseOrderLine[];
};
type ReadSupplier = SupplierDisplaySnapshot & { version: number };

// One statement observes the header and ordered lines at the same MVCC snapshot.
// Correlation includes tenant even though ids are globally unique today.
const projection = Prisma.sql`o.*, COALESCE((
  SELECT jsonb_agg(l ORDER BY l."position")
  FROM "procurement_purchase_order_lines" l
  WHERE l."tenantId" = o."tenantId" AND l."orderId" = o."id"
), '[]'::jsonb) AS "lines"`;

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
  // Closed orders read stored columns only; they need the live supplier version
  // and nothing else, so references are batched for the DRAFT rows alone.
  const drafts = rows.filter((row) => row.status === 'DRAFT');
  const supplierIds = [
    ...new Set(rows.flatMap((row) => (row.supplierId ? [row.supplierId] : []))),
  ].sort();
  const productIds = [
    ...new Set(
      drafts.flatMap((row) =>
        row.lines.flatMap((line) => (line.productId ? [line.productId] : [])),
      ),
    ),
  ].sort();
  const variantIds = [
    ...new Set(
      drafts.flatMap((row) =>
        row.lines.flatMap((line) => (line.variantId ? [line.variantId] : [])),
      ),
    ),
  ].sort();
  const suppliers = supplierIds.length
    ? await tx.$queryRaw<ReadSupplier[]>(Prisma.sql`
    SELECT s."id", s."displayName", s."status", s."version" FROM "procurement_suppliers" s
    WHERE s."tenantId" = ${tenantId} AND s."id" IN (${Prisma.join(supplierIds)})`)
    : [];
  const products = productIds.length
    ? await tx.$queryRaw<ReferenceProduct[]>(Prisma.sql`
    SELECT p."id", p."name", p."type", p."unit", p."hasVariants" FROM "products" p
    WHERE p."tenantId" = ${tenantId} AND p."id" IN (${Prisma.join(productIds)})`)
    : [];
  const variants = variantIds.length
    ? await tx.$queryRaw<ReferenceVariant[]>(Prisma.sql`
    SELECT v."id", v."name", v."productId" FROM "variants" v
    WHERE v."tenantId" = ${tenantId} AND v."id" IN (${Prisma.join(variantIds)})`)
    : [];
  const supplierById = new Map(suppliers.map((value) => [value.id, value]));
  const productById = new Map(products.map((value) => [value.id, value]));
  const variantById = new Map(variants.map((value) => [value.id, value]));
  return rows.map((row) => {
    const supplier = supplierById.get(row.supplierId ?? '');
    const supplierVersion = supplier?.version ?? null;
    if (row.status !== 'DRAFT')
      return buildPurchaseOrder(row, supplierVersion, { lines: row.lines });
    const order = storedOrderInput(row, row.lines);
    return buildPurchaseOrder(row, supplierVersion, {
      order,
      facts: deriveReferenceFacts(
        order,
        supplier?.status,
        productById,
        variantById,
      ),
      tenantName,
      displays: (invalidLines) => ({
        supplierDisplaySnapshot: supplier
          ? {
              id: supplier.id,
              displayName: supplier.displayName,
              status: supplier.status,
            }
          : (row.supplierDisplaySnapshot as SupplierDisplaySnapshot | null),
        lineDisplaySnapshots: row.lines.map((line, index) => {
          if (invalidLines.has(index))
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
      }),
    });
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
          WHERE o."tenantId" = ${scope.tenantId} AND o."id" = ${id}`);
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
          status: query.status,
          search: query.search,
        };
        const after = query.cursor
          ? this.cursor.decode(query.cursor, binding)
          : undefined;
        const pattern = query.search?.replace(/[\\%_]/g, '\\$&');
        const rows = await tx.$queryRaw<StoredOrder[]>(Prisma.sql`
          SELECT ${projection} FROM "procurement_purchase_orders" o
          LEFT JOIN "procurement_suppliers" s
            ON s."tenantId" = o."tenantId" AND s."id" = o."supplierId"
          WHERE o."tenantId" = ${scope.tenantId}
          ${query.status ? Prisma.sql`AND o."status" = ${query.status}::"ProcurementPurchaseOrderStatus"` : Prisma.empty}
          ${query.supplierId ? Prisma.sql`AND o."supplierId" = ${query.supplierId}` : Prisma.empty}
          ${pattern === undefined ? Prisma.empty : Prisma.sql`AND ((CASE WHEN o."status" = 'DRAFT' THEN s."displayName" ELSE o."supplierDisplaySnapshot"->>'displayName' END) ILIKE ${`%${pattern}%`} ESCAPE chr(92) OR o."note" ILIKE ${`%${pattern}%`} ESCAPE chr(92))`}
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
            totals: computePurchaseOrderTotals(order.lineSubtotals),
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
