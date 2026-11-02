import { Injectable } from '@nestjs/common';
import { Prisma, type ProcurementSupplier } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { lockCatalogLifecycle } from '../../catalog-editorial/infrastructure/prisma-catalog-lifecycle-gate';
import {
  requireSupplierAuthority,
  type SupplierPrincipal,
} from './supplier-authority';
import { SupplierCursor } from './supplier-cursor';
import {
  parseSupplierId,
  parseSupplierListQuery,
  SupplierContractError,
  type Supplier,
  type SupplierPage,
} from './supplier-contract';

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

@Injectable()
export class SupplierQueries {
  constructor(
    private readonly db: TenantPrismaService,
    private readonly cls: ClsService<TenantClsStore>,
    private readonly cursor: SupplierCursor,
  ) {}

  async list(value: unknown): Promise<SupplierPage> {
    return this.sanitized(() => {
      const query = parseSupplierListQuery(value);
      return this.read(async (tx, scope) => {
        const binding = {
          tenantId: scope.tenantId,
          status: query.status,
          search: query.search,
        };
        const after = query.cursor
          ? this.cursor.decode(query.cursor, binding)
          : undefined;
        const pattern = query.search?.replace(/[\\%_]/g, '\\$&');
        const rows = await tx.$queryRaw<ProcurementSupplier[]>(Prisma.sql`
          SELECT s.* FROM "procurement_suppliers" s
          WHERE s."tenantId" = ${scope.tenantId}
          ${query.status === 'ALL' ? Prisma.empty : Prisma.sql`AND s."status" = ${query.status}::"ProcurementSupplierStatus"`}
          ${pattern === undefined ? Prisma.empty : Prisma.sql`AND s."displayName" ILIKE ${`%${pattern}%`} ESCAPE chr(92)`}
          ${after ? Prisma.sql`AND (s."createdAt", s."id") < (${new Date(after.createdAt)}, ${after.id})` : Prisma.empty}
          ORDER BY s."createdAt" DESC, s."id" DESC
          LIMIT ${query.limit + 1}
        `);
        const items = rows.slice(0, query.limit).map(wire);
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

  async detail(value: unknown): Promise<Supplier> {
    return this.sanitized(() => {
      const id = parseSupplierId(value);
      return this.read(async (tx, scope) => {
        const rows = await tx.$queryRaw<ProcurementSupplier[]>(Prisma.sql`
          SELECT s.* FROM "procurement_suppliers" s
          WHERE s."tenantId" = ${scope.tenantId} AND s."id" = ${id}
        `);
        if (!rows[0]) throw new SupplierContractError('NOT_FOUND');
        return wire(rows[0]);
      });
    });
  }

  private async sanitized<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof SupplierContractError) throw error;
      throw new SupplierContractError('INTERNAL_ERROR');
    }
  }

  /** Same authority lock order as commands; no receipts, audits or business writes.
   * Authority remains current through the bounded SELECT, not just JWT/cache age.
   */
  private async read<T>(
    work: (
      tx: Prisma.TransactionClient,
      scope: SupplierPrincipal,
    ) => Promise<T>,
  ): Promise<T> {
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
    return this.db.runInTransaction(async () => {
      // SAFETY: own runInTransaction installs the actual transaction client;
      // tenant-extended delegate types differ but raw SQL preserves its receiver.
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
      await requireSupplierAuthority(tx, scope, 'READ');
      return work(tx, scope);
    }, Prisma.TransactionIsolationLevel.ReadCommitted);
  }
}
