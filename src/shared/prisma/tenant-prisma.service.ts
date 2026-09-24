import { Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import type { TenantClsStore } from '../tenant/tenant-cls-store.interface';
import { createTenantScopedPrisma } from './tenant-prisma.factory';
import { PrismaService } from './prisma.service';

const TX_CLIENT_KEY = 'prismaTxClient';
type TenantPrismaClient = ReturnType<typeof createTenantScopedPrisma>;
type PrismaTransactionClient = Parameters<
  Parameters<PrismaClient['$transaction']>[0]
>[0];
/**
 * Callback parameter type of the tenant-extended client's interactive
 * `$transaction`. The extended client narrows several delegate signatures, so
 * this is intentionally NOT the raw `PrismaTransactionClient` above.
 */
type AmbientTransactionClient = Parameters<
  Parameters<ReturnType<typeof createTenantScopedPrisma>['$transaction']>[0]
>[0];

/**
 * Raised when `runInTransaction` is asked for an EXPLICIT transaction
 * isolation level while an ambient transaction is already open.
 *
 * Prisma does not expose the isolation level an open interactive transaction
 * was started with, so joining it could silently hand back a WEAKER guarantee
 * than the caller asked for (e.g. a default ReadCommitted tx reused for a
 * RepeatableRead snapshot read). Failing closed is the only honest option:
 * callers must open their own transaction before any ambient one exists.
 */
export class AmbientTransactionIsolationConflictError extends Error {
  constructor() {
    super(
      'runInTransaction cannot honour an explicit isolation level inside an ambient transaction: the ambient transaction was started without a verifiable isolation guarantee',
    );
    this.name = 'AmbientTransactionIsolationConflictError';
  }
}

@Injectable()
export class TenantPrismaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  getClient(): TenantPrismaClient {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const txClient = this.cls.get(TX_CLIENT_KEY) as PrismaClient | undefined;
    if (txClient) {
      if ('$extends' in txClient && typeof txClient.$extends === 'function') {
        return createTenantScopedPrisma(txClient, this.cls);
      }

      // SAFETY: Prisma transaction clients expose the same model delegates as
      // TenantPrismaClient but intentionally omit top-level lifecycle methods.
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

  /**
   * Runs `work` inside one tenant-scoped interactive transaction.
   *
   * `isolationLevel` is OPTIONAL and forwarded verbatim to Prisma. Callers
   * that need a stronger guarantee than the driver default (a stable snapshot
   * read, for example) pass it explicitly; callers that do not pass it keep
   * the previous, unchanged behavior.
   *
   * An explicitly requested level is never silently downgraded: when an
   * ambient transaction is already open, the requested level cannot be
   * verified against the open transaction, so this throws
   * `AmbientTransactionIsolationConflictError` instead of reusing a possibly
   * weaker ambient transaction.
   */
  async runInTransaction<T>(
    work: () => Promise<T>,
    isolationLevel?: Prisma.TransactionIsolationLevel,
  ): Promise<T> {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const previousClient = this.cls.get(TX_CLIENT_KEY) as
      | PrismaTransactionClient
      | undefined;

    if (previousClient) {
      if (isolationLevel !== undefined) {
        throw new AmbientTransactionIsolationConflictError();
      }
      return work();
    }

    const extendedRoot = createTenantScopedPrisma(this.prisma, this.cls);
    const runInsideAmbientTx = async (
      tx: AmbientTransactionClient,
    ): Promise<T> => {
      this.cls.set(TX_CLIENT_KEY, tx);
      try {
        return await work();
      } finally {
        this.cls.set(TX_CLIENT_KEY, previousClient);
      }
    };

    return isolationLevel === undefined
      ? extendedRoot.$transaction(runInsideAmbientTx)
      : extendedRoot.$transaction(runInsideAmbientTx, { isolationLevel });
  }

  getTenantId(): string {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) {
      throw new Error('Tenant context required');
    }
    return tenantId;
  }
}
