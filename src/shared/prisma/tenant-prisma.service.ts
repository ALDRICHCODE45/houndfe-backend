import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import type { TenantClsStore } from '../tenant/tenant-cls-store.interface';
import { createTenantScopedPrisma } from './tenant-prisma.factory';
import { PrismaService } from './prisma.service';

const TX_CLIENT_KEY = 'prismaTxClient';
type TenantPrismaClient = ReturnType<typeof createTenantScopedPrisma>;
type PrismaTransactionClient = Parameters<
  Parameters<PrismaClient['$transaction']>[0]
>[0];

@Injectable()
export class TenantPrismaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  getClient(): TenantPrismaClient {
    const txClient = this.cls.get(TX_CLIENT_KEY);
    if (txClient) {
      if ('$extends' in txClient && typeof txClient.$extends === 'function') {
        return createTenantScopedPrisma(txClient, this.cls);
      }

      return txClient as unknown as TenantPrismaClient;
    }

    return createTenantScopedPrisma(this.prisma, this.cls);
  }

  /**
   * Slice E — ambient-tx guard.
   *
   * Returns `true` when the caller is currently inside
   * `runInTransaction(...)` (i.e. the CLS slot has a tx client set).
   * Repository methods that MUST run inside an ambient transaction
   * (decrement + flip + outbox write — all-or-nothing) call this to
   * avoid the silent-fallback foot-gun in `getClient()`: when no tx is
   * active, `getClient()` returns a tenant-scoped (NOT transactional)
   * client, which would auto-commit each statement independently and
   * leave the system with an orphaned `outbox` row or a committed
   * decrement for a failed sale.
   *
   * See design §Reliability finding R1.
   */
  isInTransaction(): boolean {
    return Boolean(this.cls.get(TX_CLIENT_KEY));
  }

  async runInTransaction<T>(work: () => Promise<T>): Promise<T> {
    const previousClient = this.cls.get(TX_CLIENT_KEY);

    if (previousClient) {
      return work();
    }

    return this.prisma.$transaction(async (tx) => {
      this.cls.set(TX_CLIENT_KEY, tx);
      try {
        return await work();
      } finally {
        this.cls.set(TX_CLIENT_KEY, previousClient);
      }
    });
  }

  getTenantId(): string {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) {
      throw new Error('Tenant context required');
    }
    return tenantId;
  }
}
