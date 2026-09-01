/**
 * F1.WU2b.1c-B1 — Binding sequencing mocked evidence.
 *
 * Scope: deterministic replacement sequencing for binding mutations only.
 * Excludes (deferred to other work units):
 *   Tenant update payload, reload return/order, actor, failures,
 *   transaction preconditions, integration behavior.
 *
 * Coverage:
 *   T7   — bindings upsert in ascending globalPriceListId order.
 *   T8   — composite upsert key + non-default create/update payload.
 *   T9   — stale deletion uses globalPriceListId { notIn }.
 *   T9b  — empty bindings delete full tenant set (no notIn clause).
 *   T10  — selected default promotion predicate/payload.
 *   Order — clear defaults → sorted upserts → stale deletion → promote default.
 */
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { PrismaCatalogSettingsRepository } from './prisma-catalog-settings.repository';
import { TenantCatalogSettings } from '../domain/tenant-catalog-settings.aggregate';
import type { TenantBaseProps } from '../domain/tenant-catalog-settings.aggregate';
import type { TenantCatalogPriceListBinding } from '../domain/tenant-catalog-price-list.entity';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const T = '11111111-1111-1111-1111-111111111111';
const GA = 'aaaaaaaa-0000-0000-0000-000000000001';
const GB = 'bbbbbbbb-0000-0000-0000-000000000002';
const GC = 'cccccccc-0000-0000-0000-000000000003';

interface BindingSpec {
  gl: string;
  def: boolean;
  name: string;
}

function makeAggWithBindings(bindings: BindingSpec[]): TenantCatalogSettings {
  const raw: {
    tenant: TenantBaseProps;
    bindings: TenantCatalogPriceListBinding[];
  } = {
    tenant: {
      tenantId: T,
      isActive: true,
      catalogPublished: false,
      catalogStockPresentationDefault: 'SYSTEM_STATUS',
      catalogStockPresentationDefaultCustomQty: null,
      updatedAt: new Date(),
    },
    bindings: bindings.map((b, i) => ({
      id: `b${i}`,
      tenantId: T,
      globalPriceListId: b.gl,
      isCatalogDefault: b.def,
      createdAt: new Date(),
      updatedAt: new Date(),
      globalPriceList: { id: b.gl, name: b.name },
    })),
  };
  return TenantCatalogSettings.fromPersistence(raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// Typed mock client — no any / as any
// ─────────────────────────────────────────────────────────────────────────────

interface UpsertArgs {
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
  update: { isCatalogDefault: boolean };
}

interface UpdateManyArgs {
  where: {
    tenantId: string;
    isCatalogDefault?: boolean;
    globalPriceListId?: string | { notIn: string[] };
  };
  data: { isCatalogDefault: boolean };
}

interface DeleteManyArgs {
  where: { tenantId: string; globalPriceListId?: { notIn: string[] } };
}

interface ReloadTenantRow {
  id: string;
  isActive: boolean;
  catalogPublished: boolean;
  catalogStockPresentationDefault:
    | 'SYSTEM_STATUS'
    | 'ABSTRACT_STATUS'
    | 'CUSTOM_QUANTITY'
    | 'HIDDEN';
  catalogStockPresentationDefaultCustomQty: number | null;
  updatedAt: Date;
}

interface MockClient {
  readonly $queryRaw: jest.Mock;
  readonly tenant: {
    readonly findUnique: jest.Mock;
    readonly update: jest.Mock;
  };
  readonly tenantCatalogPriceList: {
    readonly updateMany: jest.Mock;
    readonly upsert: jest.Mock;
    readonly deleteMany: jest.Mock;
    readonly findMany: jest.Mock;
  };
  readonly globalPriceList: { readonly findMany: jest.Mock };
}

function createMock(): MockClient {
  return {
    $queryRaw: jest.fn(),
    tenant: { findUnique: jest.fn(), update: jest.fn() },
    tenantCatalogPriceList: {
      updateMany: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
      findMany: jest.fn(),
    },
    globalPriceList: { findMany: jest.fn() },
  };
}

function reloadTenant(): ReloadTenantRow {
  return {
    id: T,
    isActive: true,
    catalogPublished: false,
    catalogStockPresentationDefault: 'SYSTEM_STATUS',
    catalogStockPresentationDefaultCustomQty: null,
    updatedAt: new Date(),
  };
}

function setupMock(mock: MockClient, validIds: string[]): void {
  mock.$queryRaw.mockResolvedValue([{ id: T }]);
  mock.globalPriceList.findMany.mockResolvedValue(
    validIds.map((id) => ({ id })),
  );
  mock.tenantCatalogPriceList.updateMany.mockResolvedValue({ count: 0 });
  mock.tenantCatalogPriceList.upsert.mockResolvedValue({});
  mock.tenantCatalogPriceList.deleteMany.mockResolvedValue({ count: 0 });
  mock.tenant.update.mockResolvedValue({});
  mock.tenant.findUnique.mockResolvedValue(reloadTenant());
  mock.tenantCatalogPriceList.findMany.mockResolvedValue([]);
}

function createSvc(mock: MockClient): TenantPrismaService {
  const runInTransactionMock = jest.fn<
    Promise<unknown>,
    [() => Promise<unknown>]
  >();
  const getClientMock = jest.fn<MockClient, []>();
  runInTransactionMock.mockImplementation((work) => {
    getClientMock.mockReturnValue(mock);
    return work();
  });
  getClientMock.mockReturnValue(mock);
  return {
    getClient: getClientMock,
    getTenantId: () => T,
    runInTransaction: runInTransactionMock,
  } as unknown as TenantPrismaService;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — F1.WU2b.1c-B1: binding sequencing mocked evidence
// ─────────────────────────────────────────────────────────────────────────────

describe('PrismaCatalogSettingsRepository — replace sequencing', () => {
  describe('T7 — upsert invoked in ascending globalPriceListId order', () => {
    it('upserts are called in ascending globalPriceListId order', async () => {
      const mock = createMock();
      setupMock(mock, [GA, GB, GC]);
      await new PrismaCatalogSettingsRepository(createSvc(mock)).replace(
        makeAggWithBindings([
          { gl: GC, def: false, name: 'C' },
          { gl: GA, def: false, name: 'A' },
          { gl: GB, def: true, name: 'B' },
        ]),
        'user-1',
      );
      const upsertCalls = mock.tenantCatalogPriceList.upsert.mock
        .calls as Array<[UpsertArgs]>;
      const ids = upsertCalls.map(
        ([a]) => a.where.tenantId_globalPriceListId.globalPriceListId,
      );
      expect(ids).toEqual([GA, GB, GC]);
    });
  });

  describe('T8 — composite upsert key + non-default create/update payload', () => {
    it('each upsert uses composite (tenantId, globalPriceListId) key', async () => {
      const mock = createMock();
      setupMock(mock, [GA, GB]);
      await new PrismaCatalogSettingsRepository(createSvc(mock)).replace(
        makeAggWithBindings([
          { gl: GA, def: false, name: 'A' },
          { gl: GB, def: true, name: 'B' },
        ]),
        'user-1',
      );
      const upsertCalls = mock.tenantCatalogPriceList.upsert.mock
        .calls as Array<[UpsertArgs]>;
      expect(upsertCalls).toHaveLength(2);
      expect(
        upsertCalls.map(([a]) => a.where.tenantId_globalPriceListId),
      ).toEqual([
        { tenantId: T, globalPriceListId: GA },
        { tenantId: T, globalPriceListId: GB },
      ]);
    });

    it('create and update payloads set isCatalogDefault: false (non-default)', async () => {
      const mock = createMock();
      setupMock(mock, [GA, GB]);
      await new PrismaCatalogSettingsRepository(createSvc(mock)).replace(
        makeAggWithBindings([
          { gl: GA, def: false, name: 'A' },
          { gl: GB, def: true, name: 'B' },
        ]),
        'user-1',
      );
      const upsertCalls = mock.tenantCatalogPriceList.upsert.mock
        .calls as Array<[UpsertArgs]>;
      for (const [a] of upsertCalls) {
        expect(a.create.isCatalogDefault).toBe(false);
        expect(a.update.isCatalogDefault).toBe(false);
        expect(a.create.tenantId).toBe(T);
        expect(a.create.globalPriceListId).toBe(
          a.where.tenantId_globalPriceListId.globalPriceListId,
        );
      }
    });
  });

  describe('T9 — stale deletion via notIn / empty-set full-tenant delete', () => {
    it('uses globalPriceListId { notIn } when bindings are requested', async () => {
      const mock = createMock();
      setupMock(mock, [GA, GB]);
      await new PrismaCatalogSettingsRepository(createSvc(mock)).replace(
        makeAggWithBindings([
          { gl: GA, def: false, name: 'A' },
          { gl: GB, def: true, name: 'B' },
        ]),
        'user-1',
      );
      const deleteCalls = mock.tenantCatalogPriceList.deleteMany.mock
        .calls as Array<[DeleteManyArgs]>;
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0][0].where).toEqual({
        tenantId: T,
        globalPriceListId: { notIn: [GA, GB] },
      });
    });

    it('deletes full tenant set when no bindings are requested', async () => {
      const mock = createMock();
      setupMock(mock, []);
      await new PrismaCatalogSettingsRepository(createSvc(mock)).replace(
        makeAggWithBindings([]),
        'user-1',
      );
      const deleteCalls = mock.tenantCatalogPriceList.deleteMany.mock
        .calls as Array<[DeleteManyArgs]>;
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0][0].where).toEqual({ tenantId: T });
    });
  });

  describe('T10 — selected default promotion predicate/payload', () => {
    it('promotes default with isCatalogDefault: true on the selected globalPriceListId', async () => {
      const mock = createMock();
      setupMock(mock, [GA, GB]);
      await new PrismaCatalogSettingsRepository(createSvc(mock)).replace(
        makeAggWithBindings([
          { gl: GA, def: false, name: 'A' },
          { gl: GB, def: true, name: 'B' },
        ]),
        'user-1',
      );
      const updateCalls = mock.tenantCatalogPriceList.updateMany.mock
        .calls as Array<[UpdateManyArgs]>;
      const promote = updateCalls.find(
        ([a]) =>
          a.where.isCatalogDefault === undefined &&
          typeof a.where.globalPriceListId === 'string',
      );
      expect(promote).toBeDefined();
      expect(promote![0].where).toEqual({
        tenantId: T,
        globalPriceListId: GB,
      });
      expect(promote![0].data).toEqual({ isCatalogDefault: true });
    });

    it('does not promote when no default binding is selected', async () => {
      const mock = createMock();
      setupMock(mock, []);
      await new PrismaCatalogSettingsRepository(createSvc(mock)).replace(
        makeAggWithBindings([]),
        'user-1',
      );
      const updateCalls = mock.tenantCatalogPriceList.updateMany.mock
        .calls as Array<[UpdateManyArgs]>;
      const promote = updateCalls.find(
        ([a]) =>
          a.where.isCatalogDefault === undefined &&
          typeof a.where.globalPriceListId === 'string',
      );
      expect(promote).toBeUndefined();
    });
  });

  describe('invocation order — clear → sorted upserts → stale → promote', () => {
    it('follows the exact 4-phase order across multiple bindings', async () => {
      const mock = createMock();
      setupMock(mock, [GA, GB, GC]);
      const order: string[] = [];

      mock.tenantCatalogPriceList.updateMany.mockImplementation(
        (a: UpdateManyArgs) => {
          if (a.where.isCatalogDefault === true) {
            order.push('clear-defaults');
          } else if (typeof a.where.globalPriceListId === 'string') {
            order.push('promote-default');
          }
          return Promise.resolve({ count: 0 });
        },
      );
      mock.tenantCatalogPriceList.upsert.mockImplementation((a: UpsertArgs) => {
        order.push(
          `upsert:${a.where.tenantId_globalPriceListId.globalPriceListId}`,
        );
        return Promise.resolve({});
      });
      mock.tenantCatalogPriceList.deleteMany.mockImplementation(() => {
        order.push('delete-stale');
        return Promise.resolve({ count: 0 });
      });

      await new PrismaCatalogSettingsRepository(createSvc(mock)).replace(
        makeAggWithBindings([
          { gl: GC, def: false, name: 'C' },
          { gl: GA, def: false, name: 'A' },
          { gl: GB, def: true, name: 'B' },
        ]),
        'user-1',
      );

      expect(order).toEqual([
        'clear-defaults',
        `upsert:${GA}`,
        `upsert:${GB}`,
        `upsert:${GC}`,
        'delete-stale',
        'promote-default',
      ]);
    });
  });
});
