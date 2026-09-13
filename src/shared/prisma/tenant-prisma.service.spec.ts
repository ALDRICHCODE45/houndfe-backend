import type { PrismaClient } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import { TenantPrismaService } from './tenant-prisma.service';
import type { TenantClsStore } from '../tenant/tenant-cls-store.interface';
import { createTenantScopedPrisma } from './tenant-prisma.factory';

jest.mock('./tenant-prisma.factory', () => ({
  createTenantScopedPrisma: jest.fn(),
}));

const createTenantScopedPrismaMock = jest.mocked(createTenantScopedPrisma);

type TransactionCapableClient = Pick<PrismaClient, '$transaction' | '$extends'>;
type ServiceCtorArg = ConstructorParameters<typeof TenantPrismaService>[0];

class SentinelError extends Error {}

const makeCls = () => {
  const store = new Map<keyof TenantClsStore | string, unknown>();
  const get = jest.fn((key: keyof TenantClsStore | string) => store.get(key));
  const set = jest.fn((key: keyof TenantClsStore | string, value: unknown) => {
    store.set(key, value);
  });
  const cls = { get, set } as unknown as ClsService<TenantClsStore>;
  return { cls, getSpy: get, setSpy: set };
};

const makeService = (
  rawBase: unknown,
  cls: ClsService<TenantClsStore>,
): TenantPrismaService =>
  new TenantPrismaService(rawBase as ServiceCtorArg, cls);

// Distinct raw vs extended roots. The mocked factory always hands back the
// extended root; the raw base keeps a working `$transaction` so the
// pre-fix behavior stays exercisable and provably unused after the fix.
const makeTransactionMocks = (extendedTx: unknown = { tx: 'extended' }) => {
  const rawTx = { tx: 'raw' };
  const rawBase = {
    $extends: jest.fn(),
    $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>) =>
      work(rawTx),
    ),
  } as unknown as TransactionCapableClient;
  const extendedRoot = {
    $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>) =>
      work(extendedTx),
    ),
  } as unknown as ReturnType<typeof createTenantScopedPrisma>;
  createTenantScopedPrismaMock.mockReturnValue(extendedRoot);
  return { rawBase, extendedRoot, rawTx, extendedTx };
};

describe('TenantPrismaService', () => {
  beforeEach(() => {
    createTenantScopedPrismaMock.mockReset();
  });

  it('starts the outer transaction on the tenant-extended root and exposes its ambient client', async () => {
    const { rawBase, extendedRoot, extendedTx } = makeTransactionMocks();
    const { cls } = makeCls();
    const service = makeService(rawBase, cls);

    let insideClient: unknown;
    await service.runInTransaction((): Promise<void> => {
      insideClient = service.getClient();
      return Promise.resolve();
    });

    expect(extendedRoot.$transaction).toHaveBeenCalledTimes(1);
    expect(rawBase.$transaction).not.toHaveBeenCalled();
    expect(createTenantScopedPrismaMock).toHaveBeenCalledTimes(1);
    expect(insideClient).toBe(extendedTx);
  });

  it('reuses the same transaction client for nested runInTransaction calls across one outer $transaction', async () => {
    const { rawBase, extendedRoot, extendedTx } = makeTransactionMocks();
    const { cls } = makeCls();
    const service = makeService(rawBase, cls);

    await service.runInTransaction(async () => {
      expect(service.getClient()).toBe(extendedTx);

      await service.runInTransaction((): Promise<void> => {
        expect(service.getClient()).toBe(extendedTx);
        return Promise.resolve();
      });

      expect(service.getClient()).toBe(extendedTx);
    });

    expect(extendedRoot.$transaction).toHaveBeenCalledTimes(1);
    expect(rawBase.$transaction).not.toHaveBeenCalled();
    expect(createTenantScopedPrismaMock).toHaveBeenCalledTimes(1);
  });
});

describe('TenantPrismaService.runInTransaction restoration', () => {
  beforeEach(() => {
    createTenantScopedPrismaMock.mockReset();
  });

  it('stores the ambient tx in CLS and restores the prior (undefined) slot on the success path', async () => {
    const { rawBase, extendedRoot, extendedTx } = makeTransactionMocks();
    const { cls, setSpy } = makeCls();
    const service = makeService(rawBase, cls);

    await service.runInTransaction(() => Promise.resolve());

    expect(setSpy).toHaveBeenCalledWith('prismaTxClient', extendedTx);
    expect(setSpy).toHaveBeenLastCalledWith('prismaTxClient', undefined);
    expect(service.isInTransaction()).toBe(false);
    expect(service.getClient()).toBe(extendedRoot);
  });

  it('restores the prior CLS slot and rethrows the original error when work throws synchronously', async () => {
    const { rawBase, extendedRoot, extendedTx } = makeTransactionMocks();
    const { cls, setSpy } = makeCls();
    const service = makeService(rawBase, cls);
    const sentinel = new SentinelError('sync boom');
    const work = (): never => {
      throw sentinel;
    };

    await expect(service.runInTransaction(work)).rejects.toBe(sentinel);

    expect(setSpy).toHaveBeenCalledWith('prismaTxClient', extendedTx);
    expect(setSpy).toHaveBeenLastCalledWith('prismaTxClient', undefined);
    expect(service.isInTransaction()).toBe(false);
    expect(service.getClient()).toBe(extendedRoot);
  });

  it('restores the prior CLS slot and propagates the rejection when work returns a rejected promise', async () => {
    const { rawBase, extendedRoot, extendedTx } = makeTransactionMocks();
    const { cls, setSpy } = makeCls();
    const service = makeService(rawBase, cls);
    const sentinel = new SentinelError('rejected boom');

    await expect(
      service.runInTransaction(() => Promise.reject(sentinel)),
    ).rejects.toBe(sentinel);

    expect(setSpy).toHaveBeenCalledWith('prismaTxClient', extendedTx);
    expect(setSpy).toHaveBeenLastCalledWith('prismaTxClient', undefined);
    expect(service.isInTransaction()).toBe(false);
    expect(service.getClient()).toBe(extendedRoot);
  });
});

describe('TenantPrismaService.getClient outside transaction', () => {
  beforeEach(() => {
    createTenantScopedPrismaMock.mockReset();
  });

  it('returns a tenant-extended client, not the raw PrismaService, when no transaction is active', () => {
    const { rawBase, extendedRoot } = makeTransactionMocks();
    const { cls } = makeCls();
    const service = makeService(rawBase, cls);

    expect(service.getClient()).toBe(extendedRoot);
    expect(service.getClient()).not.toBe(rawBase);
    expect(createTenantScopedPrismaMock).toHaveBeenCalledWith(rawBase, cls);
  });
});

describe('TenantPrismaService.runInTransaction result/error forwarding', () => {
  beforeEach(() => {
    createTenantScopedPrismaMock.mockReset();
  });

  it('resolves to the exact value returned by work', async () => {
    const { rawBase } = makeTransactionMocks();
    const service = makeService(rawBase, makeCls().cls);
    const result = Symbol('result');

    await expect(
      service.runInTransaction(() => Promise.resolve(result)),
    ).resolves.toBe(result);
  });

  it('rethrows the exact error instance thrown by work', async () => {
    const { rawBase } = makeTransactionMocks();
    const service = makeService(rawBase, makeCls().cls);
    const sentinel = new SentinelError('boom');

    await expect(
      service.runInTransaction((): never => {
        throw sentinel;
      }),
    ).rejects.toBe(sentinel);
    expect(sentinel.message).toBe('boom');
  });
});

describe('TenantPrismaService.runInTransaction nested failure', () => {
  beforeEach(() => {
    createTenantScopedPrismaMock.mockReset();
  });

  it('keeps the outer slot on the ambient tx after a nested throw, then restores the outer slot', async () => {
    const { rawBase, extendedRoot, extendedTx } = makeTransactionMocks();
    const service = makeService(rawBase, makeCls().cls);
    const sentinel = new SentinelError('nested boom');
    let clientAfterNestedFailure: unknown;
    let stillInTransaction: boolean | undefined;

    await expect(
      service.runInTransaction(async () => {
        try {
          await service.runInTransaction((): never => {
            throw sentinel;
          });
        } catch (error) {
          clientAfterNestedFailure = service.getClient();
          stillInTransaction = service.isInTransaction();
          throw error;
        }
      }),
    ).rejects.toBe(sentinel);

    expect(clientAfterNestedFailure).toBe(extendedTx);
    expect(stillInTransaction).toBe(true);
    expect(service.isInTransaction()).toBe(false);
    expect(service.getClient()).toBe(extendedRoot);
  });
});

// ── Slice E — isInTransaction (reliability guard, see WARNING 1) ───────

describe('TenantPrismaService.isInTransaction', () => {
  beforeEach(() => {
    createTenantScopedPrismaMock.mockReset();
  });

  it('returns false when no CLS tx client is active', () => {
    const { cls } = makeCls();
    const rawBase = {
      $extends: jest.fn(),
      $transaction: jest.fn(),
    } as unknown as TransactionCapableClient;
    const service = makeService(rawBase, cls);

    expect(service.isInTransaction()).toBe(false);
  });

  it('returns true while inside runInTransaction (CLS tx client set)', async () => {
    const { rawBase } = makeTransactionMocks();
    const service = makeService(rawBase, makeCls().cls);

    let observedInside: boolean | undefined;
    await service.runInTransaction((): Promise<void> => {
      observedInside = service.isInTransaction();
      return Promise.resolve();
    });

    // After the tx completes the CLS slot is cleared → back to false.
    expect(observedInside).toBe(true);
    expect(service.isInTransaction()).toBe(false);
  });
});
