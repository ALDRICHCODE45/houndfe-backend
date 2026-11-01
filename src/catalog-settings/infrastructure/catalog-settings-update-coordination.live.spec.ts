import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import type { UpdateCatalogSettingsUseCase } from '../application/update-catalog-settings.use-case';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { loadEditorialPostgresClient } from '../../catalog-editorial/infrastructure/editorial-coordination-postgres-binding';
import { lockCatalogLifecycle } from '../../catalog-editorial/infrastructure/prisma-catalog-lifecycle-gate';
import {
  currentBackendPid,
  seedEditorialPostgres,
  waitForLockWait,
} from '../../catalog-editorial/infrastructure/editorial-coordination-postgres-fixture';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('live operation-owned settings PATCH (explicit binding only)', () => {
  const opened: PrismaClient[] = [];
  const open = async () => {
    const client = await loadEditorialPostgresClient();
    opened.push(client);
    return client;
  };
  let observer: PrismaClient;
  let actor: (
    client: PrismaClient,
    target: string,
    selected: string,
    after?: () => Promise<void>,
  ) => {
    patch: (
      data?: Parameters<UpdateCatalogSettingsUseCase['execute']>[0]['data'],
    ) => ReturnType<UpdateCatalogSettingsUseCase['execute']>;
    ambient: () => ReturnType<UpdateCatalogSettingsUseCase['execute']>;
    emit: jest.SpyInstance;
  };
  beforeAll(async () => {
    observer = await open(); // Admission before application imports or construction.
    const { ClsService } = await import('nestjs-cls');
    const { EventEmitter2 } = await import('@nestjs/event-emitter');
    const { TenantPrismaService } =
      await import('../../shared/prisma/tenant-prisma.service');
    const { PrismaCatalogSettingsTransaction } =
      await import('./prisma-catalog-settings-transaction');
    const { UpdateCatalogSettingsUseCase } =
      await import('../application/update-catalog-settings.use-case');
    actor = (client, target, selected, after) => {
      const cls = new ClsService<TenantClsStore>(
        new AsyncLocalStorage<TenantClsStore>(),
      );
      let committed = false;
      const proxy = new Proxy(client, {
        get(root, property, receiver) {
          if (property !== '$transaction') {
            const member: unknown = Reflect.get(root, property, receiver);
            return member;
          }
          return async <T>(
            work: (tx: Prisma.TransactionClient) => Promise<T>,
            options: { isolationLevel: Prisma.TransactionIsolationLevel },
          ) => {
            const result = await root.$transaction(async (tx) => {
              const response = await work(tx);
              await after?.();
              return response;
            }, options);
            committed = true;
            return result;
          };
        },
      });
      // SAFETY: real Prisma client delegates are retained; only completion is instrumented.
      const prisma = proxy as ConstructorParameters<
        typeof PrismaCatalogSettingsTransaction
      >[0];
      const tenant = new TenantPrismaService(prisma, cls);
      const emitter = new EventEmitter2();
      const emit = jest.spyOn(emitter, 'emit').mockImplementation(() => {
        expect(committed).toBe(true);
        expect(cls.get('tenantId')).toBe(selected);
        return true;
      });
      const useCase = new UpdateCatalogSettingsUseCase(
        new PrismaCatalogSettingsTransaction(prisma, tenant),
        emitter,
      );
      const scope = <T>(work: () => T) =>
        cls.runWith(
          {
            tenantId: selected,
            userId: 'synthetic-settings-actor',
            isSuperAdmin: false,
          },
          work,
        );
      const execute = (data = {}) =>
        useCase.execute({
          tenantId: target,
          actorUserId: 'synthetic-settings-actor',
          data,
        });
      return {
        patch: (data) => scope(() => execute(data)),
        ambient: () => scope(() => tenant.runInTransaction(() => execute())),
        emit,
      };
    };
  });
  afterAll(async () => {
    await Promise.allSettled(opened.map((client) => client.$disconnect()));
  });

  async function snapshot(tenantId: string) {
    return {
      tenant: await observer.tenant.findUniqueOrThrow({
        where: { id: tenantId },
      }),
      bindings: await observer.tenantCatalogPriceList.findMany({
        where: { tenantId },
        orderBy: { id: 'asc' },
      }),
    };
  }

  it('waits for lifecycle before Tenant access and leaves the selected tenant untouched', async () => {
    const { ids: i } = await seedEditorialPostgres(observer, randomUUID());
    const selectedBefore = await snapshot(i.foreignTenantId);
    const owner = await open();
    const waiter = await open();
    const ownerPid = await currentBackendPid(owner);
    const waiterPid = await currentBackendPid(waiter);
    const reached = signal();
    const release = signal();
    const holding = owner
      .$transaction(async (tx) => {
        await lockCatalogLifecycle(tx, 'exclusive');
        reached.resolve();
        await release.promise;
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    const settings = actor(waiter, i.tenantId, i.foreignTenantId);
    let patch: ReturnType<typeof settings.patch> | undefined;
    try {
      await Promise.race([
        reached.promise,
        holding.then((cause) => {
          throw new Error('Owner ended before checkpoint', { cause });
        }),
      ]);
      patch = settings.patch({ stockPresentationDefault: { mode: 'HIDDEN' } });
      expect(await waitForLockWait(observer, waiterPid)).toContain(ownerPid);
      const locks = await observer.$queryRaw<
        { mode: string }[]
      >`SELECT mode FROM pg_locks WHERE pid = ${waiterPid} AND NOT granted AND relation = 'global_price_lists'::regclass`;
      expect(locks).toEqual([{ mode: 'ShareLock' }]);
      const tenantLocks = await observer.$queryRaw<
        { mode: string }[]
      >`SELECT mode FROM pg_locks WHERE pid = ${waiterPid} AND relation = 'tenants'::regclass`;
      expect(tenantLocks).toEqual([]);
      expect(settings.emit).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.allSettled([holding, patch]);
    }
    await expect(holding).resolves.toBeUndefined();
    await expect(patch).resolves.toMatchObject({
      tenantId: i.tenantId,
      stockPresentationDefault: { mode: 'HIDDEN' },
    });
    expect(await snapshot(i.foreignTenantId)).toEqual(selectedBefore);
    expect(settings.emit).toHaveBeenCalledTimes(1);
  });

  it('merges committed settings and default coverage after waiting for the target Tenant', async () => {
    const { ids: i } = await seedEditorialPostgres(observer, randomUUID());
    const owner = await open();
    const waiter = await open();
    const ownerPid = await currentBackendPid(owner);
    const waiterPid = await currentBackendPid(waiter);
    const reached = signal();
    const release = signal();
    const holding = owner
      .$transaction(async (tx) => {
        await lockCatalogLifecycle(tx, 'shared');
        await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${i.tenantId} FOR UPDATE`;
        await tx.tenantCatalogPriceList.create({
          data: {
            tenantId: i.tenantId,
            globalPriceListId: i.globalPriceListId,
            isCatalogDefault: true,
          },
        });
        await tx.priceList.update({
          where: { id: i.priceListId },
          data: { priceCents: 0 },
        });
        await tx.tenant.update({
          where: { id: i.tenantId },
          data: { catalogPublished: true },
        });
        reached.resolve();
        await release.promise;
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    const settings = actor(waiter, i.tenantId, i.foreignTenantId);
    let patch: ReturnType<typeof settings.patch> | undefined;
    try {
      await Promise.race([
        reached.promise,
        holding.then((cause) => {
          throw new Error('Owner ended before checkpoint', { cause });
        }),
      ]);
      patch = settings.patch({
        stockPresentationDefault: { mode: 'ABSTRACT_STATUS' },
      });
      expect(await waitForLockWait(observer, waiterPid)).toContain(ownerPid);
      expect(settings.emit).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.allSettled([holding, patch]);
    }
    await expect(holding).resolves.toBeUndefined();
    await expect(patch).resolves.toMatchObject({
      catalogPublished: true,
      priceContexts: [
        { priceListId: i.globalPriceListId, isCatalogDefault: true },
      ],
      warnings: ['DEFAULT_CONTEXT_HAS_NO_VALID_PRICES'],
    });
    expect((await snapshot(i.tenantId)).tenant.catalogPublished).toBe(true);
    expect(settings.emit).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'retains lifecycle through completion and audits only committed work, rollback=%s',
    async (rollback) => {
      const { ids: i } = await seedEditorialPostgres(observer, randomUUID());
      const before = await snapshot(i.tenantId);
      const owner = await open();
      const waiter = await open();
      const ownerPid = await currentBackendPid(owner);
      const waiterPid = await currentBackendPid(waiter);
      const reached = signal();
      const release = signal();
      const error = new Error('synthetic completion failure');
      const settings = actor(owner, i.tenantId, i.foreignTenantId, async () => {
        reached.resolve();
        await release.promise;
        if (rollback) throw error;
      });
      const patch = settings
        .patch({ stockPresentationDefault: { mode: 'HIDDEN' } })
        .then(
          (value) => value,
          (failure: unknown) => failure,
        );
      let competing: Promise<unknown> | undefined;
      try {
        await Promise.race([
          reached.promise,
          patch.then((cause) => {
            throw new Error('PATCH ended before checkpoint', { cause });
          }),
        ]);
        expect(await snapshot(i.tenantId)).toEqual(before);
        expect(settings.emit).not.toHaveBeenCalled();
        competing = waiter.$transaction((tx) =>
          lockCatalogLifecycle(tx, 'exclusive'),
        );
        expect(await waitForLockWait(observer, waiterPid)).toContain(ownerPid);
      } finally {
        release.resolve();
        await Promise.allSettled([patch, competing]);
      }
      await expect(competing).resolves.toBeUndefined();
      if (rollback) {
        await expect(patch).resolves.toBe(error);
        expect(await snapshot(i.tenantId)).toEqual(before);
        expect(settings.emit).not.toHaveBeenCalled();
      } else {
        await expect(patch).resolves.toMatchObject({
          stockPresentationDefault: { mode: 'HIDDEN' },
        });
        expect(
          (await snapshot(i.tenantId)).tenant.catalogStockPresentationDefault,
        ).toBe('HIDDEN');
        expect(settings.emit).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('rejects ambient invocation without modifying settings or emitting audit', async () => {
    const { ids: i } = await seedEditorialPostgres(observer, randomUUID());
    const before = await snapshot(i.tenantId);
    const settings = actor(await open(), i.tenantId, i.foreignTenantId);
    await expect(settings.ambient()).rejects.toMatchObject({
      name: 'CatalogSettingsTransactionOwnershipError',
      message: 'Catalog settings PATCH requires its own transaction',
    });
    expect(await snapshot(i.tenantId)).toEqual(before);
    expect(settings.emit).not.toHaveBeenCalled();
  });
});
