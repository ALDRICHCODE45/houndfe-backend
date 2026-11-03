import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma, type ProcurementSupplier } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { lockCatalogLifecycle } from '../../catalog-editorial/infrastructure/prisma-catalog-lifecycle-gate';
import { requireSupplierAuthority } from './supplier-authority';
import {
  hashSupplierBody,
  parseSupplierId,
  parseSupplierIdempotencyKey,
  parseSupplierInput,
  parseSupplierUpdate,
  parseSupplierDelete,
  type SupplierDelete,
  SupplierContractError,
  type Supplier,
  type SupplierInput,
  type SupplierUpdate,
} from './supplier-contract';

export interface SupplierCommandResult {
  statusCode: 201 | 200;
  body: Supplier;
}

export interface SupplierDeleteResult {
  statusCode: 204;
  body: null;
}

function wire(row: ProcurementSupplier): Supplier {
  return {
    id: row.id,
    displayName: row.displayName,
    termsText: row.termsText,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Unwired command boundary: principal comes from authenticated CLS, never body. */
@Injectable()
export class SupplierCommands {
  constructor(
    private readonly db: TenantPrismaService,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  async create(key: unknown, body: unknown): Promise<SupplierCommandResult> {
    return this.sanitized(() =>
      this.execute('CREATE', 'collection', key, parseSupplierInput(body)),
    );
  }

  async update(
    id: unknown,
    key: unknown,
    body: unknown,
  ): Promise<SupplierCommandResult> {
    return this.sanitized(() =>
      this.execute(
        'UPDATE',
        parseSupplierId(id),
        key,
        parseSupplierUpdate(body),
      ),
    );
  }

  async delete(
    id: unknown,
    key: unknown,
    body: unknown,
  ): Promise<SupplierDeleteResult> {
    return this.sanitized(() =>
      this.execute(
        'DELETE',
        parseSupplierId(id),
        key,
        parseSupplierDelete(body),
      ),
    );
  }

  private async sanitized<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof SupplierContractError) throw error;
      throw new SupplierContractError('INTERNAL_ERROR');
    }
  }

  private execute(
    operation: 'CREATE' | 'UPDATE',
    target: string,
    rawKey: unknown,
    input: SupplierInput | SupplierUpdate,
  ): Promise<SupplierCommandResult>;
  private execute(
    operation: 'DELETE',
    target: string,
    rawKey: unknown,
    input: SupplierDelete,
  ): Promise<SupplierDeleteResult>;
  private async execute(
    operation: 'CREATE' | 'UPDATE' | 'DELETE',
    target: string,
    rawKey: unknown,
    input: SupplierInput | SupplierUpdate | SupplierDelete,
  ): Promise<SupplierCommandResult | SupplierDeleteResult> {
    // Snapshot all admission/context before the first await. Reuse the exact
    // header-value policy even for non-HTTP callers; duplicate header checking
    // remains the future route's rawHeaders responsibility.
    const idempotencyKey = parseSupplierIdempotencyKey([
      'Idempotency-Key',
      rawKey,
    ]);
    const actorId = this.cls.get('userId');
    if (typeof actorId !== 'string' || !actorId.trim())
      throw new SupplierContractError('UNAUTHORIZED');
    const tenantId = this.cls.get('tenantId');
    if (
      typeof tenantId !== 'string' ||
      !tenantId.trim() ||
      this.db.getTenantId() !== tenantId
    )
      throw new SupplierContractError('FORBIDDEN');
    if (this.db.isInTransaction())
      throw new SupplierContractError('INTERNAL_ERROR');
    const scope = { actorId, tenantId };
    const namespace = { ...scope, operation, target, idempotencyKey };
    const requestHash = hashSupplierBody(
      operation === 'CREATE'
        ? 'create'
        : operation === 'DELETE'
          ? 'delete'
          : 'update',
      input,
    );
    // Length-delimited JSON tuple, not ambiguous string concatenation. The
    // signed 64-bit advisory hash is contention only; receipt equality is FULL.
    const digest = createHash('sha256')
      .update(
        JSON.stringify([
          'procurement-supplier-command-v1',
          tenantId,
          actorId,
          operation,
          target,
          idempotencyKey,
        ]),
      )
      .digest();
    const gate = digest.readBigInt64BE(0);
    return this.db.runInTransaction(async () => {
      // SAFETY: own runInTransaction sets the ambient transaction client;
      // tenant-extended delegate signatures differ only in static types.
      const tx = this.db.getClient() as unknown as Prisma.TransactionClient;
      await lockCatalogLifecycle(tx, 'shared');
      const tenants = await tx.$queryRaw<
        { id: string; isActive: boolean }[]
      >(Prisma.sql`
        SELECT t."id", t."isActive" FROM "tenants" t
        WHERE t."id" = ${tenantId} FOR SHARE OF t
      `);
      if (tenants[0]?.id !== tenantId || tenants[0].isActive !== true)
        throw new SupplierContractError('FORBIDDEN');
      await requireSupplierAuthority(tx, scope, operation);
      const gates = await tx.$queryRaw<{ acquired: boolean }[]>(Prisma.sql`
        SELECT pg_try_advisory_xact_lock(${gate}::bigint) AS acquired
      `);
      if (gates[0]?.acquired !== true)
        throw new SupplierContractError('IDEMPOTENCY_KEY_IN_FLIGHT');
      const receipt = await tx.procurementSupplierReceipt.findFirst({
        where: namespace,
      });
      if (receipt) {
        if (receipt.requestHash !== requestHash)
          throw new SupplierContractError('IDEMPOTENCY_KEY_CONFLICT');
        if (operation === 'DELETE') return { statusCode: 204, body: null };
        return {
          statusCode: receipt.statusCode as 200 | 201,
          // SAFETY: this feature writes only persisted wire(row) snapshots;
          // no external receipt write/update interface exists.
          body: structuredClone(receipt.responseBody) as unknown as Supplier,
        };
      }
      let row: ProcurementSupplier;
      if (operation === 'CREATE') {
        row = await tx.procurementSupplier.create({
          data: { ...(input as SupplierInput), tenantId, version: 1 },
        });
      } else {
        const update = input as SupplierUpdate;
        const rows = await tx.$queryRaw<ProcurementSupplier[]>(Prisma.sql`
          SELECT s.* FROM "procurement_suppliers" s
          WHERE s."tenantId" = ${tenantId} AND s."id" = ${target} FOR UPDATE OF s
        `);
        if (!rows[0]) throw new SupplierContractError('NOT_FOUND');
        if (
          rows[0].version !== update.expectedVersion ||
          rows[0].version >= 2147483647
        )
          throw new SupplierContractError('SUPPLIER_VERSION_CONFLICT');
        if (operation === 'DELETE') {
          const deleted = await tx.procurementSupplier.deleteMany({
            where: { tenantId, id: target, version: update.expectedVersion },
          });
          if (deleted.count !== 1)
            throw new SupplierContractError('SUPPLIER_VERSION_CONFLICT');
          // Prior fields/timestamps, with the deletion event version.
          // Audit.createdAt is the deletion timestamp, not snapshot.updatedAt.
          row = { ...rows[0], version: rows[0].version + 1 };
        } else {
          const changed = await tx.procurementSupplier.updateMany({
            where: { tenantId, id: target, version: update.expectedVersion },
            data: { ...update.changes, version: { increment: 1 } },
          });
          if (changed.count !== 1)
            throw new SupplierContractError('SUPPLIER_VERSION_CONFLICT');
          row = await tx.procurementSupplier.findFirstOrThrow({
            where: { tenantId, id: target },
          });
        }
      }
      const body = wire(row);
      const snapshot: Prisma.InputJsonObject = { ...body };
      const statusCode =
        operation === 'CREATE' ? 201 : operation === 'DELETE' ? 204 : 200;
      await tx.procurementSupplierAudit.create({
        data: {
          ...scope,
          supplierId: row.id,
          operation,
          supplierVersion: row.version,
          snapshot,
        },
      });
      await tx.procurementSupplierReceipt.create({
        data: {
          ...namespace,
          supplierId: row.id,
          requestHash,
          statusCode,
          responseBody: operation === 'DELETE' ? Prisma.JsonNull : snapshot,
        },
      });
      if (operation === 'DELETE') return { statusCode: 204, body: null };
      return { statusCode: statusCode as 200 | 201, body };
    }, Prisma.TransactionIsolationLevel.ReadCommitted);
  }
}
