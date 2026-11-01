import { createMongoAbility } from '@casl/ability';
import { CatalogSettingsController } from '../presentation/catalog-settings.controller';
import { GetCatalogSettingsUseCase } from '../application/get-catalog-settings.use-case';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { TenantCatalogSettings } from '../domain/tenant-catalog-settings.aggregate';
import type { UpdateCatalogSettingsDto } from '../dto/update-catalog-settings.dto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaCatalogSettingsTransaction } from './prisma-catalog-settings-transaction';
import { UpdateCatalogSettingsUseCase } from '../application/update-catalog-settings.use-case';
import { CatalogSettingsTransactionOwnershipError } from '../application/catalog-settings-transaction';
import { CatalogSettingsNotFoundError } from '../application/get-catalog-settings.use-case';

afterEach(() => jest.restoreAllMocks());

const date = new Date('2024-01-01T00:00:00Z');
const publicBinding = {
  id: 'binding',
  tenantId: 'target',
  globalPriceListId: 'public',
  isCatalogDefault: true,
  createdAt: date,
  updatedAt: date,
  globalPriceList: { id: 'public', name: 'Public' },
};
function fixture() {
  const events: string[] = [];
  let active = false;
  let bindings: (typeof publicBinding)[] = [];
  let ambient = false;
  let commitError: Error | undefined;
  const cls = new ClsService<TenantClsStore>(new AsyncLocalStorage());
  let tenant = {
    id: 'target',
    isActive: true,
    catalogPublished: false,
    catalogStockPresentationDefault: 'SYSTEM_STATUS',
    catalogStockPresentationDefaultCustomQty: null,
    updatedAt: date,
  };
  const record = (name: string) => {
    expect(active).toBe(true);
    events.push(name);
  };
  const tx = {
    $executeRaw: jest.fn<Promise<number>, [TemplateStringsArray]>(() => {
      record('lifecycle');
      return Promise.resolve(0);
    }),
    $queryRaw: jest.fn<
      Promise<{ id: string }[]>,
      [TemplateStringsArray, string]
    >((_sql, id) => {
      record('tenant lock');
      expect(id).toBe('target');
      return Promise.resolve([{ id }]);
    }),
    tenant: {
      findUnique: jest.fn(
        ({ where }: { where: { id: string }; select: unknown }) => {
          record('tenant read');
          expect(where).toEqual({ id: 'target' });
          return Promise.resolve(tenant);
        },
      ),
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<typeof tenant>;
        }) => {
          record('tenant write');
          expect(where).toEqual({ id: 'target' });
          tenant = { ...tenant, ...data };
          return Promise.resolve(tenant);
        },
      ),
    },
    tenantCatalogPriceList: {
      findMany: jest.fn(
        ({
          where,
        }: {
          where: { tenantId: string };
          orderBy: unknown;
          include: unknown;
        }) => {
          record('bindings read');
          expect(where).toEqual({ tenantId: 'target' });
          return Promise.resolve(structuredClone(bindings));
        },
      ),
      updateMany: jest.fn(
        ({
          where,
          data,
        }: {
          where: { tenantId: string; globalPriceListId?: string };
          data: { isCatalogDefault: boolean };
        }) => {
          record('defaults');
          bindings = bindings.map((b) =>
            !where.globalPriceListId ||
            b.globalPriceListId === where.globalPriceListId
              ? { ...b, ...data }
              : b,
          );
          expect(where.tenantId).toBe('target');
          return Promise.resolve({ count: 0 });
        },
      ),
      deleteMany: jest.fn(
        ({
          where,
        }: {
          where: { tenantId: string; globalPriceListId?: { notIn: string[] } };
        }) => {
          record('bindings delete');
          expect(where.tenantId).toBe('target');
          bindings = bindings.filter((b) =>
            where.globalPriceListId?.notIn.includes(b.globalPriceListId),
          );
          return Promise.resolve({ count: 0 });
        },
      ),
      upsert: jest.fn(
        ({
          where,
          create,
        }: {
          where: {
            tenantId_globalPriceListId: {
              tenantId: string;
              globalPriceListId: string;
            };
          };
          create: {
            tenantId: string;
            globalPriceListId: string;
            isCatalogDefault: boolean;
          };
        }) => {
          record('binding upsert');
          expect(where.tenantId_globalPriceListId.tenantId).toBe('target');
          expect(create.tenantId).toBe('target');
          if (
            !bindings.some(
              (b) => b.globalPriceListId === create.globalPriceListId,
            )
          )
            bindings.push({ ...publicBinding, ...create });
          return Promise.resolve({});
        },
      ),
    },
    globalPriceList: {
      findMany: jest.fn(() => {
        record('global lists');
        return Promise.resolve([{ id: 'public', name: 'Public' }]);
      }),
    },
    priceList: {
      count: jest.fn(
        ({
          where,
        }: {
          where: {
            tenantId: string;
            globalPriceListId: string;
            priceCents: { gt: number };
          };
        }) => {
          record('coverage');
          expect(where).toEqual({
            tenantId: 'target',
            globalPriceListId: 'public',
            priceCents: { gt: 0 },
          });
          return Promise.resolve(0);
        },
      ),
    },
  };
  const root = {
    $transaction: jest.fn(async (work: (db: typeof tx) => Promise<unknown>) => {
      const before = structuredClone(tenant);
      const beforeBindings = structuredClone(bindings);
      active = true;
      events.push('begin');
      try {
        const result = await work(tx);
        expect(cls.get('tenantId')).toBe('selected');
        if (commitError) throw commitError;
        events.push('commit');
        return result;
      } catch (error) {
        tenant = before;
        bindings = beforeBindings;
        events.push('rollback');
        throw error;
      } finally {
        active = false;
      }
    }),
  };
  type Args = ConstructorParameters<typeof PrismaCatalogSettingsTransaction>;
  // SAFETY: only the transaction callback surface is exercised by this fixture.
  const prisma = root as unknown as Args[0];
  const scoped = new TenantPrismaService(prisma, cls);
  const getClient = jest.spyOn(scoped, 'getClient').mockImplementation(() => {
    throw new Error('selected CLS client must not be used');
  });
  const transaction = new PrismaCatalogSettingsTransaction(prisma, scoped);
  const emit = jest.fn(() => {
    expect(active).toBe(false);
    expect(events.at(-1)).toBe('commit');
    events.push('audit');
    return true;
  });
  const useCase = new UpdateCatalogSettingsUseCase(transaction, {
    emit,
  } as unknown as EventEmitter2);
  const inScope = <T>(work: () => T): T =>
    cls.runWith(
      {
        userId: 'actor',
        tenantId: 'selected',
        isSuperAdmin: false,
        ...(ambient ? { prismaTxClient: tx } : {}),
      },
      work,
    );
  const execute = (
    data: UpdateCatalogSettingsDto = {
      stockPresentationDefault: { mode: 'ABSTRACT_STATUS' },
    },
  ) =>
    inScope(() =>
      useCase.execute({ tenantId: 'target', actorUserId: 'actor', data }),
    );
  const controller = new CatalogSettingsController(
    new GetCatalogSettingsUseCase(
      new Proxy({} as never, {
        get() {
          throw new Error('GET must not run');
        },
      }),
    ),
    useCase,
  );
  const patch = (allowed: boolean) => {
    type PatchArgs = Parameters<CatalogSettingsController['updateSettings']>;
    // SAFETY: direct-controller fixture supplies only authenticated fields consumed here.
    const user = { userId: 'actor', tenantId: 'selected' } as PatchArgs[2];
    const ability = createMongoAbility(
      allowed ? [{ action: 'manage', subject: 'all' }] : [],
    );
    // SAFETY: the controller consumes only ability; HTTP guards are unchanged and tested separately.
    return inScope(() =>
      controller.updateSettings(
        'target',
        { stockPresentationDefault: { mode: 'HIDDEN' } },
        user,
        { ability } as unknown as PatchArgs[3],
      ),
    );
  };
  return {
    patch,
    getClient,
    tx,
    root,
    scoped,
    events,
    emit,
    transaction,
    useCase,
    execute,
    snapshot: () => structuredClone(tenant),
    setBindings: () => {
      bindings = [structuredClone(publicBinding)];
    },
    bindingsSnapshot: () => structuredClone(bindings),
    setCommitError: (error: Error) => {
      commitError = error;
    },
    setAmbient: () => {
      ambient = true;
    },
  };
}

it('owns a target-qualified transaction, maps the response before commit, then emits audit', async () => {
  const f = fixture();
  const result = await f.execute();
  expect(result).toMatchObject({
    stockPresentationDefault: { mode: 'ABSTRACT_STATUS', customQuantity: null },
    priceContexts: [],
  });
  expect(f.snapshot().catalogStockPresentationDefault).toBe('ABSTRACT_STATUS');
  expect(f.events.slice(0, 5)).toEqual([
    'begin',
    'lifecycle',
    'tenant lock',
    'tenant read',
    'bindings read',
  ]);
  expect(f.events.slice(-2)).toEqual(['commit', 'audit']);
  expect(f.tx.$executeRaw.mock.calls).toEqual([
    [['LOCK TABLE "global_price_lists" IN SHARE MODE']],
  ]);
  expect(f.root.$transaction).toHaveBeenCalledTimes(1);
  expect(f.root.$transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: 'ReadCommitted',
  });
  expect(f.getClient).not.toHaveBeenCalled();
  expect(f.emit).toHaveBeenCalledTimes(1);
});

it('rejects ambient ownership before any database access or audit', async () => {
  const f = fixture();
  f.setAmbient();
  await expect(f.execute()).rejects.toEqual(
    new CatalogSettingsTransactionOwnershipError(),
  );
  expect(f.root.$transaction).not.toHaveBeenCalled();
  expect(f.getClient).not.toHaveBeenCalled();
  expect(f.events).toEqual([]);
  expect(f.emit).not.toHaveBeenCalled();
});

it('awaits lifecycle before target lock and every observation', async () => {
  const f = fixture();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.tx.$executeRaw.mockImplementationOnce(async () => {
    enter();
    await gate;
    return 0;
  });
  const operation = f.execute();
  await Promise.race([entered, operation.catch(() => undefined)]);
  try {
    expect(f.tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(f.tx.$queryRaw).not.toHaveBeenCalled();
    expect(f.tx.tenant.findUnique).not.toHaveBeenCalled();
    expect(f.tx.tenant.update).not.toHaveBeenCalled();
    expect(f.emit).not.toHaveBeenCalled();
  } finally {
    release();
    await operation.catch(() => undefined);
  }
});

it('returns the existing not-found error when the target lock finds no tenant', async () => {
  const f = fixture();
  f.tx.$queryRaw.mockResolvedValueOnce([]);
  await expect(f.execute()).rejects.toEqual(
    new CatalogSettingsNotFoundError('target'),
  );
  expect(f.tx.tenant.findUnique).not.toHaveBeenCalled();
  expect(f.emit).not.toHaveBeenCalled();
});

it.each([
  'lifecycle',
  'lock',
  'read',
  'defaults',
  'delete',
  'write',
  'reload',
  'response',
  'commit',
])('preserves %s failure and rolls back without audit', async (stage) => {
  const f = fixture();
  f.setBindings();
  const before = f.snapshot();
  const beforeBindings = f.bindingsSnapshot();
  const error = new Error(stage);
  if (stage === 'lifecycle') f.tx.$executeRaw.mockRejectedValueOnce(error);
  if (stage === 'lock') f.tx.$queryRaw.mockRejectedValueOnce(error);
  if (stage === 'read') f.tx.tenant.findUnique.mockRejectedValueOnce(error);
  if (stage === 'defaults')
    f.tx.tenantCatalogPriceList.updateMany.mockRejectedValueOnce(error);
  if (stage === 'delete')
    f.tx.tenantCatalogPriceList.deleteMany.mockRejectedValueOnce(error);
  if (stage === 'write') f.tx.tenant.update.mockRejectedValueOnce(error);
  if (stage === 'reload')
    f.tx.tenant.findUnique
      .mockImplementationOnce(() => Promise.resolve(before))
      .mockRejectedValueOnce(error);
  if (stage === 'response')
    jest
      .spyOn(TenantCatalogSettings.prototype, 'toInternalResult')
      .mockImplementationOnce(() => {
        throw error;
      });
  if (stage === 'commit') f.setCommitError(error);
  await expect(f.execute()).rejects.toBe(error);
  expect(f.snapshot()).toEqual(before);
  expect(f.bindingsSnapshot()).toEqual(beforeBindings);
  expect(f.emit).not.toHaveBeenCalled();
});

it('keeps post-commit audit failure non-fatal', async () => {
  const f = fixture();
  f.emit.mockImplementationOnce(() => {
    expect(f.events.at(-1)).toBe('commit');
    throw new Error('audit');
  });
  await expect(f.execute()).resolves.toMatchObject({
    stockPresentationDefault: { mode: 'ABSTRACT_STATUS' },
  });
  expect(f.snapshot().catalogStockPresentationDefault).toBe('ABSTRACT_STATUS');
});

it.each(['lifecycle', 'tenant'])(
  'merges post-wait settings/default/coverage after the %s gate',
  async (gateName) => {
    const f = fixture();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (gateName === 'lifecycle')
      f.tx.$executeRaw.mockImplementationOnce(async () => {
        enter();
        await gate;
        return 0;
      });
    else
      f.tx.$queryRaw.mockImplementationOnce(async () => {
        enter();
        await gate;
        return [{ id: 'target' }];
      });
    const operation = f.execute({});
    await Promise.race([entered, operation.catch(() => undefined)]);
    try {
      expect(f.tx.tenant.findUnique).not.toHaveBeenCalled();
      expect(f.tx.priceList.count).not.toHaveBeenCalled();
      f.setBindings();
    } finally {
      release();
    }
    const response = await operation;
    expect(response.priceContexts).toEqual([
      { priceListId: 'public', name: 'Public', isCatalogDefault: true },
    ]);
    expect(response.warnings).toEqual(['DEFAULT_CONTEXT_HAS_NO_VALID_PRICES']);
    expect(f.tx.priceList.count).toHaveBeenCalledTimes(1);
    expect(f.bindingsSnapshot()).toEqual([publicBinding]);
  },
);

it('preserves authorized cross-target PATCH despite a different selected CLS tenant', async () => {
  const f = fixture();
  await expect(f.patch(true)).resolves.toMatchObject({
    tenantId: 'target',
    stockPresentationDefault: { mode: 'HIDDEN' },
  });
  expect(f.snapshot().catalogStockPresentationDefault).toBe('HIDDEN');
  expect(f.getClient).not.toHaveBeenCalled();
});

it('retains cross-target denial before transaction, writes, and audit', async () => {
  const f = fixture();
  await expect(f.patch(false)).rejects.toMatchObject({
    status: 404,
    message: 'Catalog settings not found for tenant target',
  });
  expect(f.root.$transaction).not.toHaveBeenCalled();
  expect(f.events).toEqual([]);
  expect(f.emit).not.toHaveBeenCalled();
});

it.each(['lists', 'coverage', 'upsert'])(
  'rolls back %s failure with unchanged bindings and no audit',
  async (stage) => {
    const f = fixture();
    f.setBindings();
    const before = f.snapshot();
    const error = new Error(stage);
    if (stage === 'lists')
      f.tx.globalPriceList.findMany.mockRejectedValueOnce(error);
    if (stage === 'coverage') f.tx.priceList.count.mockRejectedValueOnce(error);
    if (stage === 'upsert')
      f.tx.tenantCatalogPriceList.upsert.mockRejectedValueOnce(error);
    await expect(f.execute({ publicPriceListIds: ['public'] })).rejects.toBe(
      error,
    );
    expect(f.snapshot()).toEqual(before);
    expect(f.bindingsSnapshot()).toEqual([publicBinding]);
    expect(f.events.at(-1)).toBe('rollback');
    expect(f.emit).not.toHaveBeenCalled();
  },
);

it('validates requested lists after both gates and keeps the complete DTO', async () => {
  const f = fixture();
  const response = await f.execute({
    publicPriceListIds: ['public'],
    catalogDefaultPriceListId: 'public',
    catalogPublished: true,
  });
  expect(response).toEqual({
    tenantId: 'target',
    catalogPublished: true,
    effectivePublication: true,
    priceContexts: [
      { priceListId: 'public', name: 'Public', isCatalogDefault: true },
    ],
    stockPresentationDefault: { mode: 'SYSTEM_STATUS', customQuantity: null },
    warnings: ['DEFAULT_CONTEXT_HAS_NO_VALID_PRICES'],
    updatedAt: date.toISOString(),
  });
  expect(f.events.indexOf('global lists')).toBeGreaterThan(
    f.events.indexOf('tenant lock'),
  );
  expect(f.events.indexOf('coverage')).toBeLessThan(
    f.events.indexOf('defaults'),
  );
  expect(f.bindingsSnapshot()).toEqual([publicBinding]);
});
