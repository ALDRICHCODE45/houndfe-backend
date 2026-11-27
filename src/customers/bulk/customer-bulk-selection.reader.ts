/**
 * customers-bulk-actions / T1 (S1) — the one read the selection needs beyond
 * the listing reader: which of the requested ids are customers of the
 * caller's branch (ids mode is strict, contract §2.4).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';

export interface CustomerBulkSelectionReader {
  /** The subset of `ids` that are customers of the current tenant. */
  findExistingIds(ids: string[]): Promise<string[]>;
}

export const CUSTOMER_BULK_SELECTION_READER = Symbol(
  'CUSTOMER_BULK_SELECTION_READER',
);

@Injectable()
export class PrismaCustomerBulkSelectionReader implements CustomerBulkSelectionReader {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async findExistingIds(ids: string[]): Promise<string[]> {
    const tenantId = this.tenantPrisma.getTenantId();
    if (!tenantId) {
      throw new BusinessRuleViolationError(
        'TENANT_CONTEXT_REQUIRED',
        'TENANT_CONTEXT_REQUIRED',
      );
    }
    // Raw SQL is not tenant-scoped by the Prisma extension: explicit tenant.
    const rows = await this.tenantPrisma.getClient().$queryRaw<
      Array<{ id: string }>
    >(Prisma.sql`SELECT c."id" FROM "customers" c
      WHERE c."tenantId" = ${tenantId} AND c."id" = ANY (${ids}::text[])`);
    return rows.map((row) => row.id);
  }
}
