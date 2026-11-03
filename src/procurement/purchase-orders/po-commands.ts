import { createHash } from 'node:crypto';
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
import { requirePurchaseOrderAuthority } from './po-authority';
import {
  hashPurchaseOrderBody,
  parseOrderInput,
  parsePurchaseOrderDelete,
  parsePurchaseOrderId,
  parsePurchaseOrderIdempotencyKey,
  parsePurchaseOrderReplace,
  PurchaseOrderContractError,
  type OrderInput,
  type PurchaseOrder,
  type PurchaseOrderDelete,
  type PurchaseOrderReplace,
} from './po-contract';
import { buildPurchaseOrderDiagnostics } from './po-validation';
import { isQuantityAllowedForUnit } from './po-decimal';
import {
  readPurchaseOrderReferences,
  type PurchaseOrderReferences,
} from './po-references';

export interface PurchaseOrderCommandResult {
  statusCode: 201 | 200;
  body: PurchaseOrder;
}
export interface PurchaseOrderDeleteResult {
  statusCode: 204;
  body: null;
}

function json(value: PurchaseOrder): Prisma.InputJsonObject {
  // SAFETY: Only server-built JSON wire objects cross this boundary.
  return value as unknown as Prisma.InputJsonObject;
}

function admit(
  order: OrderInput,
  baseline: PurchaseOrder | null,
  refs: PurchaseOrderReferences,
): void {
  if (order.supplierId !== null && order.supplierId !== baseline?.supplierId) {
    if (refs.facts.supplier === 'missing')
      throw new PurchaseOrderContractError('NOT_FOUND');
    if (refs.facts.supplier === 'ARCHIVED')
      throw new PurchaseOrderContractError('SUPPLIER_ARCHIVED');
  }
  const previous = new Map(baseline?.lines.map((line) => [line.lineId, line]));
  for (const line of order.lines) {
    const old = previous.get(line.lineId);
    const retained =
      old !== undefined &&
      old.productId === line.productId &&
      old.variantId === line.variantId;
    const fact = refs.facts.lines[line.lineId];
    const product = fact?.product ?? 'missing';
    const variant = fact?.variant ?? 'missing';
    const validProduct = product !== 'missing' && product.type === 'PRODUCT';
    const validReference =
      validProduct &&
      (line.variantId === null ||
        (product.hasVariants &&
          variant !== 'missing' &&
          variant.belongsToProduct));
    if (!retained) {
      if (
        (line.productId !== null && product === 'missing') ||
        (line.variantId !== null && variant === 'missing')
      )
        throw new PurchaseOrderContractError('NOT_FOUND');
      if (line.productId !== null && !validReference)
        throw new PurchaseOrderContractError('MALFORMED');
      if (
        validProduct &&
        ((line.informedUnitCost?.unit != null &&
          line.informedUnitCost.unit !== product.unit) ||
          (line.orderedQuantity !== null &&
            !isQuantityAllowedForUnit(line.orderedQuantity, product.unit)))
      )
        throw new PurchaseOrderContractError('MALFORMED');
    } else if (
      line.informedUnitCost?.unit != null &&
      line.informedUnitCost.unit !== old.informedUnitCost?.unit
    ) {
      // Clearing a unit is allowed; a new non-null unit needs a live compatible
      // reference, not the historical label/unit of a missing row.
      if (!validReference || line.informedUnitCost.unit !== product.unit)
        throw new PurchaseOrderContractError('MALFORMED');
    }
  }
}

function response(
  row: ProcurementPurchaseOrder,
  order: OrderInput,
  refs: PurchaseOrderReferences,
  baseline: PurchaseOrder | null,
): PurchaseOrder {
  const diagnostics = buildPurchaseOrderDiagnostics(order, refs.facts);
  const invalidPaths = new Set(
    diagnostics.issues
      .filter((issue) =>
        [
          'REFERENCE_UNAVAILABLE',
          'REFERENCE_INCOMPATIBLE',
          'UNIT_MISMATCH',
          'QUANTITY_FRACTION_NOT_ALLOWED',
        ].includes(issue.code),
      )
      .map((issue) => issue.path.split('/').slice(0, 3).join('/')),
  );
  const previous = new Map(
    baseline?.lineDisplaySnapshots.map((line) => [line.lineId, line]),
  );
  return {
    ...order,
    id: row.id,
    version: row.version,
    status: 'DRAFT',
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    supplierDisplaySnapshot:
      order.supplierId === null
        ? null
        : (refs.supplierDisplaySnapshot ??
          (baseline?.supplierId === order.supplierId
            ? baseline.supplierDisplaySnapshot
            : null)),
    lineDisplaySnapshots: refs.lineDisplaySnapshots.map((line, index) => {
      const prior = baseline?.lines.find((old) => old.lineId === line.lineId);
      const current = order.lines[index];
      return invalidPaths.has(`/lines/${index}`) &&
        prior?.productId === current.productId &&
        prior?.variantId === current.variantId
        ? (previous.get(line.lineId) ?? line)
        : line;
    }),
    lineSubtotals: diagnostics.lineSubtotals,
    locationSnapshot: {
      tenantId: row.tenantId,
      tenantName: refs.tenantName,
      detail: order.location.detail,
    },
    validation: { issues: diagnostics.issues },
  };
}

/** CLS principal only; HTTP owns raw duplicate-key/header checks and no-store. */
@Injectable()
export class PurchaseOrderCommands {
  constructor(
    private readonly db: TenantPrismaService,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  async createDraft(
    key: unknown,
    body: unknown,
  ): Promise<PurchaseOrderCommandResult> {
    return this.sanitized(() =>
      this.execute('CREATE', 'collection', key, parseOrderInput(body)),
    );
  }

  async replaceDraft(
    id: unknown,
    key: unknown,
    body: unknown,
  ): Promise<PurchaseOrderCommandResult> {
    return this.sanitized(() =>
      this.execute(
        'REPLACE',
        parsePurchaseOrderId(id),
        key,
        parsePurchaseOrderReplace(body),
      ),
    );
  }

  async deleteDraft(
    id: unknown,
    key: unknown,
    body: unknown,
  ): Promise<PurchaseOrderDeleteResult> {
    return this.sanitized(() =>
      this.execute(
        'DELETE',
        parsePurchaseOrderId(id),
        key,
        parsePurchaseOrderDelete(body),
      ),
    );
  }

  private async sanitized<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof PurchaseOrderContractError) throw error;
      throw new PurchaseOrderContractError('INTERNAL_ERROR');
    }
  }

  private execute(
    operation: 'CREATE' | 'REPLACE',
    target: string,
    rawKey: unknown,
    input: OrderInput | PurchaseOrderReplace,
  ): Promise<PurchaseOrderCommandResult>;
  private execute(
    operation: 'DELETE',
    target: string,
    rawKey: unknown,
    input: PurchaseOrderDelete,
  ): Promise<PurchaseOrderDeleteResult>;
  private async execute(
    operation: 'CREATE' | 'REPLACE' | 'DELETE',
    target: string,
    rawKey: unknown,
    input: OrderInput | PurchaseOrderReplace | PurchaseOrderDelete,
  ): Promise<PurchaseOrderCommandResult | PurchaseOrderDeleteResult> {
    const idempotencyKey = parsePurchaseOrderIdempotencyKey([
      'Idempotency-Key',
      rawKey,
    ]);
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
    const scope = { tenantId, actorId };
    const namespace = { ...scope, operation, target, idempotencyKey };
    const requestHash = hashPurchaseOrderBody(
      operation === 'CREATE'
        ? 'create'
        : operation === 'REPLACE'
          ? 'replace'
          : 'delete',
      input,
    );
    const gate = createHash('sha256')
      .update(
        JSON.stringify([
          'procurement-purchase-order-command-v1',
          tenantId,
          actorId,
          operation,
          target,
          idempotencyKey,
        ]),
      )
      .digest()
      .readBigInt64BE(0);
    return this.db.runInTransaction(async () => {
      // SAFETY: own runInTransaction supplies the ambient Prisma transaction.
      const tx = this.db.getClient() as unknown as Prisma.TransactionClient;
      await lockCatalogLifecycle(tx, 'shared');
      const tenants = await tx.$queryRaw<
        { id: string; name: string; isActive: boolean }[]
      >(Prisma.sql`
        SELECT t."id", t."name", t."isActive" FROM "tenants" t
        WHERE t."id" = ${tenantId} FOR SHARE OF t
      `);
      if (tenants[0]?.id !== tenantId || tenants[0].isActive !== true)
        throw new PurchaseOrderContractError('FORBIDDEN');
      await requirePurchaseOrderAuthority(tx, scope, operation);
      const gates = await tx.$queryRaw<{ acquired: boolean }[]>(Prisma.sql`
        SELECT pg_try_advisory_xact_lock(${gate}::bigint) AS acquired
      `);
      if (gates[0]?.acquired !== true)
        throw new PurchaseOrderContractError('IDEMPOTENCY_KEY_IN_FLIGHT');
      const receipt = await tx.procurementPurchaseOrderReceipt.findFirst({
        where: namespace,
      });
      if (receipt) {
        if (receipt.requestHash !== requestHash)
          throw new PurchaseOrderContractError('IDEMPOTENCY_KEY_CONFLICT');
        if (operation === 'DELETE') return { statusCode: 204, body: null };
        return {
          statusCode: receipt.statusCode as 200 | 201,
          // SAFETY: only this service writes receipts, using full wire snapshots.
          body: structuredClone(
            receipt.responseBody,
          ) as unknown as PurchaseOrder,
        };
      }
      let baseline: PurchaseOrder | null = null;
      let row: ProcurementPurchaseOrder;
      if (operation !== 'CREATE') {
        const rows = await tx.$queryRaw<ProcurementPurchaseOrder[]>(Prisma.sql`
          SELECT o.* FROM "procurement_purchase_orders" o
          WHERE o."tenantId" = ${tenantId} AND o."id" = ${target} FOR UPDATE OF o
        `);
        if (!rows[0]) throw new PurchaseOrderContractError('NOT_FOUND');
        row = rows[0];
        const expectedVersion = (
          input as PurchaseOrderReplace | PurchaseOrderDelete
        ).expectedVersion;
        if (row.version !== expectedVersion || row.version >= 2147483647)
          throw new PurchaseOrderContractError('ORDER_VERSION_CONFLICT');
        const lines = await tx.procurementPurchaseOrderLine.findMany({
          where: { tenantId, orderId: target },
          orderBy: { position: 'asc' },
        });
        // The matching successful audit preserves exact saved diagnostics for
        // beforeSnapshot. Admission identities/content come from header + lines,
        // never a receipt or rejected request.
        const saved = await tx.procurementPurchaseOrderAudit.findFirstOrThrow({
          where: { tenantId, orderId: target, orderVersion: row.version },
        });
        // SAFETY: matching successful audit contains the saved wire object.
        const snapshot = saved.afterSnapshot as unknown as PurchaseOrder;
        baseline = {
          ...snapshot,
          id: row.id,
          version: row.version,
          status: 'DRAFT',
          supplierId: row.supplierId,
          note: row.note,
          location: { detail: row.locationDetail },
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          // SAFETY: server writes only supplier display objects or SQL NULL.
          supplierDisplaySnapshot:
            row.supplierDisplaySnapshot as unknown as PurchaseOrder['supplierDisplaySnapshot'],
          lines: lines.map((line) => ({
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
          lineDisplaySnapshots: lines.map((line) => ({
            lineId: line.lineId,
            productName: line.productName,
            variantName: line.variantName,
            unit: line.unitSnapshot,
          })),
          locationSnapshot: {
            tenantId,
            tenantName: row.locationTenantName,
            detail: row.locationDetail,
          },
        };
      }
      let body: PurchaseOrder | null = null;
      if (operation === 'DELETE') {
        const deleted = await tx.procurementPurchaseOrder.deleteMany({
          where: {
            tenantId,
            id: target,
            version: (input as PurchaseOrderDelete).expectedVersion,
          },
        });
        if (deleted.count !== 1)
          throw new PurchaseOrderContractError('ORDER_VERSION_CONFLICT');
      } else {
        const order =
          operation === 'CREATE'
            ? (input as OrderInput)
            : (input as PurchaseOrderReplace).order;
        const refs = await readPurchaseOrderReferences(
          tx,
          tenantId,
          tenants[0].name,
          order,
        );
        admit(order, baseline, refs);
        const supplierDisplay =
          order.supplierId === null
            ? null
            : (refs.supplierDisplaySnapshot ??
              baseline?.supplierDisplaySnapshot ??
              null);
        const data = {
          supplierId: order.supplierId,
          note: order.note,
          locationDetail: order.location.detail,
          locationTenantName: refs.tenantName,
          supplierDisplaySnapshot: supplierDisplay
            ? { ...supplierDisplay }
            : Prisma.DbNull,
        };
        if (operation === 'CREATE') {
          row = await tx.procurementPurchaseOrder.create({
            data: { ...data, tenantId, version: 1 },
          });
        } else {
          const changed = await tx.procurementPurchaseOrder.updateMany({
            where: {
              tenantId,
              id: target,
              version: (input as PurchaseOrderReplace).expectedVersion,
            },
            data: { ...data, version: { increment: 1 } },
          });
          if (changed.count !== 1)
            throw new PurchaseOrderContractError('ORDER_VERSION_CONFLICT');
          row = await tx.procurementPurchaseOrder.findFirstOrThrow({
            where: { tenantId, id: target },
          });
          await tx.procurementPurchaseOrderLine.deleteMany({
            where: { tenantId, orderId: target },
          });
        }
        body = response(row!, order, refs, baseline);
        if (order.lines.length) {
          const orderId = body.id;
          const displays = new Map(
            body.lineDisplaySnapshots.map((line) => [line.lineId, line]),
          );
          const lines: ProcurementPurchaseOrderLine[] = order.lines.map(
            (line, position) => ({
              tenantId,
              orderId,
              lineId: line.lineId,
              position,
              productId: line.productId,
              variantId: line.variantId,
              orderedQuantity: line.orderedQuantity,
              informedUnitCostPresent: line.informedUnitCost !== null,
              costAmount: line.informedUnitCost?.amount ?? null,
              currency: line.informedUnitCost?.currency ?? null,
              costUnit: line.informedUnitCost?.unit ?? null,
              taxBasis: line.informedUnitCost?.taxBasis ?? null,
              productName: displays.get(line.lineId)?.productName ?? null,
              variantName: displays.get(line.lineId)?.variantName ?? null,
              unitSnapshot: displays.get(line.lineId)?.unit ?? null,
            }),
          );
          await tx.procurementPurchaseOrderLine.createMany({ data: lines });
        }
      }
      const orderId = body?.id ?? target;
      const statusCode =
        operation === 'CREATE' ? 201 : operation === 'REPLACE' ? 200 : 204;
      await tx.procurementPurchaseOrderAudit.create({
        data: {
          ...scope,
          orderId,
          operation,
          orderVersion: body?.version ?? baseline!.version + 1,
          beforeSnapshot: baseline ? json(baseline) : Prisma.DbNull,
          afterSnapshot: body ? json(body) : Prisma.DbNull,
        },
      });
      await tx.procurementPurchaseOrderReceipt.create({
        data: {
          ...namespace,
          orderId,
          requestHash,
          statusCode,
          responseBody: body ? json(body) : Prisma.JsonNull,
        },
      });
      if (!body) return { statusCode: 204, body: null };
      return { statusCode: statusCode as 200 | 201, body };
    }, Prisma.TransactionIsolationLevel.ReadCommitted);
  }
}
