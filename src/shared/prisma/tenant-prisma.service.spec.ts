import type { PrismaClient } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import { TenantPrismaService } from './tenant-prisma.service';
import type { TenantClsStore } from '../tenant/tenant-cls-store.interface';

type TransactionCapableClient = Pick<PrismaClient, '$transaction' | '$extends'>;

describe('TenantPrismaService', () => {
  const makeCls = () => {
    const store = new Map<keyof TenantClsStore | string, unknown>();

    return {
      get: jest.fn((key: keyof TenantClsStore | string) => store.get(key)),
      set: jest.fn((key: keyof TenantClsStore | string, value: unknown) => {
        store.set(key, value);
      }),
    } as unknown as ClsService<TenantClsStore>;
  };

  it('exposes the current transaction client inside runInTransaction', async () => {
    const txClient = { tx: true };
    const baseClient = {
      $extends: jest.fn().mockReturnThis(),
      $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>) =>
        work(txClient),
      ),
    } as unknown as TransactionCapableClient;
    const cls = makeCls();
    const service = new TenantPrismaService(
      baseClient as unknown as ConstructorParameters<
        typeof TenantPrismaService
      >[0],
      cls,
    );

    let insideClient: unknown;
    await service.runInTransaction(async () => {
      insideClient = service.getClient();
    });

    expect(baseClient.$transaction).toHaveBeenCalledTimes(1);
    expect(insideClient).toBe(txClient);
  });

  it('reuses the same transaction client for nested runInTransaction calls', async () => {
    const outerTxClient = { tx: 'outer' };

    const baseClient = {
      $extends: jest.fn().mockReturnThis(),
      $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>) =>
        work(outerTxClient),
      ),
    } as unknown as TransactionCapableClient;

    const cls = makeCls();
    const service = new TenantPrismaService(
      baseClient as unknown as ConstructorParameters<
        typeof TenantPrismaService
      >[0],
      cls,
    );

    await service.runInTransaction(async () => {
      expect(service.getClient()).toBe(outerTxClient);

      await service.runInTransaction(async () => {
        expect(service.getClient()).toBe(outerTxClient);
      });

      expect(service.getClient()).toBe(outerTxClient);
    });

    expect(baseClient.$transaction).toHaveBeenCalledTimes(1);
  });
});

// ── Slice E — isInTransaction (reliability guard, see WARNING 1) ───────

describe('TenantPrismaService.isInTransaction', () => {
  const makeCls = () => {
    const store = new Map<keyof TenantClsStore | string, unknown>();

    return {
      get: jest.fn((key: keyof TenantClsStore | string) => store.get(key)),
      set: jest.fn((key: keyof TenantClsStore | string, value: unknown) => {
        store.set(key, value);
      }),
    } as unknown as ClsService<TenantClsStore>;
  };

  it('returns false when no CLS tx client is active', () => {
    const cls = makeCls();
    const baseClient = {
      $extends: jest.fn().mockReturnThis(),
      $transaction: jest.fn(),
    } as unknown as TransactionCapableClient;
    const service = new TenantPrismaService(
      baseClient as unknown as ConstructorParameters<
        typeof TenantPrismaService
      >[0],
      cls,
    );

    expect(service.isInTransaction()).toBe(false);
  });

  it('returns true while inside runInTransaction (CLS tx client set)', async () => {
    const cls = makeCls();
    const baseClient = {
      $extends: jest.fn().mockReturnThis(),
      $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>) =>
        work({ tx: 'inner' }),
      ),
    } as unknown as TransactionCapableClient;
    const service = new TenantPrismaService(
      baseClient as unknown as ConstructorParameters<
        typeof TenantPrismaService
      >[0],
      cls,
    );

    let observedInside: boolean | undefined;
    await service.runInTransaction(async () => {
      observedInside = service.isInTransaction();
    });

    // After the tx completes the CLS slot is cleared → back to false.
    expect(observedInside).toBe(true);
    expect(service.isInTransaction()).toBe(false);
  });
});
