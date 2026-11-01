import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { lockCatalogLifecycle } from '../../catalog-editorial/infrastructure/prisma-catalog-lifecycle-gate';
import {
  CatalogSettingsTransactionOwnershipError,
  type CatalogSettingsTransaction,
} from '../application/catalog-settings-transaction';
import { CatalogSettingsNotFoundError } from '../application/get-catalog-settings.use-case';
import type { ICatalogSettingsRepository } from '../domain/catalog-settings.repository';
import { PrismaCatalogSettingsRepository } from './prisma-catalog-settings.repository';

@Injectable()
export class PrismaCatalogSettingsTransaction implements CatalogSettingsTransaction {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantPrisma: TenantPrismaService,
  ) {}

  async run<T>(
    tenantId: string,
    work: (repository: ICatalogSettingsRepository) => Promise<T>,
  ): Promise<T> {
    if (this.tenantPrisma.isInTransaction())
      throw new CatalogSettingsTransactionOwnershipError();
    return this.prisma.$transaction(
      async (tx) => {
        await lockCatalogLifecycle(tx, 'shared');
        const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "tenants" WHERE id = ${tenantId} FOR UPDATE
      `;
        if (rows.length !== 1) throw new CatalogSettingsNotFoundError(tenantId);
        // The authorized route target, not selected CLS, owns these explicitly
        // qualified repository operations. Never rebind the request's CLS context.
        const repository = new PrismaCatalogSettingsRepository({
          // SAFETY: this repository uses only model delegates and raw SQL;
          // it never requires client extensions or opens a nested transaction.
          getClient: () =>
            tx as unknown as ReturnType<TenantPrismaService['getClient']>,
          runInTransaction: (callback) => callback(),
        });
        return work(repository);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }
}
