/**
 * F1.WU2b.1c-B2B — Reload mocked evidence.
 *
 * Scope: scoped reload reads (tenant row + bindings) and the post-replace
 * aggregate reconstruction. The reload step issues exactly one
 * tenant.findUnique scoped to the aggregate tenantId and exactly one
 * tenantCatalogPriceList.findMany scoped to the same tenant, ordered
 * ascending by globalPriceListId and including the globalPriceList names.
 * It runs after tenant.update has succeeded. If tenant.findUnique returns
 * null the adapter throws "not found after replace" without issuing the
 * bindings query. If the bindings read fails, the error propagates.
 *
 * Excludes by design (owned by other work units):
 *   - tenant.update payload derivation (T11a)              → B2A
 *   - tenant.update where.id scoping (T11b)                 → B2A
 *   - actor acceptance without persistence divergence (T14) → B2A
 *   - tenant.update failure short-circuiting reload (T15)   → B2A
 *   - binding upsert/delete/promote sequencing (T7–T10)     → B1 sequencing spec
 *   - transaction preconditions (FOR UPDATE, ID validation)  → A spec
 *   - real DB integration                                   → WU2b.1d
 *
 * Coverage:
 *   T12a — reload tenant.findUnique exactly once, scoped to aggregate tenantId.
 *   T12b — reload bindings findMany exactly once, tenant-scoped, ordered
 *          ascending by globalPriceListId, including globalPriceList names.
 *   T13  — invocation order: tenant.update precedes tenant reload, which
 *          precedes binding reload.
 *   T12c — returned aggregate reflects reloaded tenant fields
 *          (isActive / updatedAt) and binding IDs / names / default selection.
 *   T15b — null reload tenant throws "not found after replace" and skips
 *          the binding reload query.
 *   T15c — reload binding findMany failure propagates.
 */
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { PrismaCatalogSettingsRepository } from './prisma-catalog-settings.repository';
import { TenantCatalogSettings } from '../domain/tenant-catalog-settings.aggregate';
import type { TenantBaseProps } from '../domain/tenant-catalog-settings.aggregate';
import type { TenantCatalogPriceListBinding } from '../domain/tenant-catalog-price-list.entity';

// ── Fixtures ────────────────────────────────────────────────────────────────

const T = '11111111-1111-1111-1111-111111111111';
const GA = 'aaaa1111-0000-0000-0000-000000000001';
const GB = 'bbbb2222-0000-0000-0000-000000000002';

type StockMode =
  | 'SYSTEM_STATUS'
  | 'ABSTRACT_STATUS'
  | 'CUSTOM_QUANTITY'
  | 'HIDDEN';

interface ReloadTenant {
  id: string;
  isActive: boolean;
  catalogPublished: boolean;
  catalogStockPresentationDefault: StockMode;
  catalogStockPresentationDefaultCustomQty: number | null;
  updatedAt: Date;
}

function tenantReloaded(o?: Partial<ReloadTenant>): ReloadTenant {
  return {
    id: T,
    isActive: true,
    catalogPublished: false,
    catalogStockPresentationDefault: 'SYSTEM_STATUS',
    catalogStockPresentationDefaultCustomQty: null,
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...o,
  };
}

function bindingsReloaded(): TenantCatalogPriceListBinding[] {
  return [
    {
      id: 'b0',
      tenantId: T,
      globalPriceListId: GA,
      isCatalogDefault: false,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
      globalPriceList: { id: GA, name: 'List-A' },
    },
    {
      id: 'b1',
      tenantId: T,
      globalPriceListId: GB,
      isCatalogDefault: true,
      createdAt: new Date('2024-01-02'),
      updatedAt: new Date('2024-01-02'),
      globalPriceList: { id: GB, name: 'List-B' },
    },
  ];
}

/**
 * Build an aggregate. `published=true` requires a default binding to satisfy
 * invariants; the optional `withBindings` flag toggles that without forcing
 * B2B tests to depend on binding sequencing detail.
 */
function makeAgg(
  catalogPublished: boolean,
  mode: StockMode,
  customQty: number | null,
  withBindings = false,
): TenantCatalogSettings {
  const tenant: TenantBaseProps = {
    tenantId: T,
    isActive: true,
    catalogPublished,
    catalogStockPresentationDefault: mode,
    catalogStockPresentationDefaultCustomQty: customQty,
    updatedAt: new Date(),
  };
  const mkBinding = (
    gl: string,
    def: boolean,
    name: string,
  ): TenantCatalogPriceListBinding => ({
    id: `b-${gl}`,
    tenantId: T,
    globalPriceListId: gl,
    isCatalogDefault: def,
    createdAt: new Date(),
    updatedAt: new Date(),
    globalPriceList: { id: gl, name },
  });
  const bindings: TenantCatalogPriceListBinding[] = withBindings
    ? catalogPublished
      ? [mkBinding(GA, false, 'List-A'), mkBinding(GB, true, 'List-B')]
      : [mkBinding(GA, true, 'List-A')]
    : [];
  return TenantCatalogSettings.fromPersistence({ tenant, bindings });
}

// ── Typed mock client (no `any` / `as any`) ──────────────────────────────────

interface TenantFindUniqueArgs {
  where: { id: string };
  select: {
    id: true;
    isActive: true;
    catalogPublished: true;
    catalogStockPresentationDefault: true;
    catalogStockPresentationDefaultCustomQty: true;
    updatedAt: true;
  };
}

interface BindingFindManyArgs {
  where: { tenantId: string };
  orderBy: { globalPriceListId: 'asc' };
  include: { globalPriceList: { select: { id: true; name: true } } };
}

interface MockClient {
  $queryRaw: jest.Mock;
  tenant: { findUnique: jest.Mock; update: jest.Mock };
  tenantCatalogPriceList: {
    updateMany: jest.Mock;
    upsert: jest.Mock;
    deleteMany: jest.Mock;
    findMany: jest.Mock;
  };
  globalPriceList: { findMany: jest.Mock };
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

function baseStubs(
  m: MockClient,
  reloadTenant: ReloadTenant | null,
  validGlobalIds: string[] = [],
  reloadBindings: TenantCatalogPriceListBinding[] = [],
): void {
  m.$queryRaw.mockResolvedValue([{ id: T }]);
  m.globalPriceList.findMany.mockResolvedValue(
    validGlobalIds.map((id) => ({ id })),
  );
  m.tenantCatalogPriceList.updateMany.mockResolvedValue({ count: 0 });
  m.tenantCatalogPriceList.upsert.mockResolvedValue({});
  m.tenantCatalogPriceList.deleteMany.mockResolvedValue({ count: 0 });
  m.tenant.update.mockResolvedValue({});
  m.tenant.findUnique.mockResolvedValue(reloadTenant);
  m.tenantCatalogPriceList.findMany.mockResolvedValue(reloadBindings);
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

// ── Tests ───────────────────────────────────────────────────────────────────

describe('PrismaCatalogSettingsRepository — replace reload', () => {
  describe('T12a — reload tenant.findUnique exactly once, scoped to tenantId', () => {
    it('calls tenant.findUnique exactly once with where.id === aggregate tenantId', async () => {
      const mock = createMock();
      baseStubs(mock, tenantReloaded());
      await new PrismaCatalogSettingsRepository(createSvc(mock)).replace(
        makeAgg(false, 'SYSTEM_STATUS', null),
        'user-1',
      );
      const calls = mock.tenant.findUnique.mock.calls as Array<
        [TenantFindUniqueArgs]
      >;
      expect(calls).toHaveLength(1);
      expect(calls[0][0].where).toEqual({ id: T });
    });
  });

  describe('T12b — reload bindings findMany exactly once, scoped + ordered + names', () => {
    it('calls tenantCatalogPriceList.findMany exactly once with tenant scope, ascending order, and included globalPriceList names', async () => {
      const mock = createMock();
      baseStubs(mock, tenantReloaded(), [GA, GB], bindingsReloaded());
      await new PrismaCatalogSettingsRepository(createSvc(mock)).replace(
        makeAgg(false, 'SYSTEM_STATUS', null),
        'user-1',
      );
      const calls = mock.tenantCatalogPriceList.findMany.mock.calls as Array<
        [BindingFindManyArgs]
      >;
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toEqual({
        where: { tenantId: T },
        orderBy: { globalPriceListId: 'asc' },
        include: { globalPriceList: { select: { id: true, name: true } } },
      });
    });
  });

  describe('T13 — invocation order: tenant.update → tenant reload → binding reload', () => {
    it('fires tenant.update before tenant reload, and tenant reload before binding reload', async () => {
      const mock = createMock();
      const order: string[] = [];
      mock.$queryRaw.mockResolvedValue([{ id: T }]);
      mock.globalPriceList.findMany.mockResolvedValue([]);
      mock.tenantCatalogPriceList.updateMany.mockResolvedValue({ count: 0 });
      mock.tenantCatalogPriceList.upsert.mockResolvedValue({});
      mock.tenantCatalogPriceList.deleteMany.mockResolvedValue({ count: 0 });
      mock.tenant.update.mockImplementation(() => {
        order.push('tenant.update');
        return Promise.resolve({});
      });
      mock.tenant.findUnique.mockImplementation(() => {
        order.push('reload.tenant.findUnique');
        return Promise.resolve(tenantReloaded());
      });
      mock.tenantCatalogPriceList.findMany.mockImplementation(() => {
        order.push('reload.binding.findMany');
        return Promise.resolve([]);
      });
      await new PrismaCatalogSettingsRepository(createSvc(mock)).replace(
        makeAgg(false, 'SYSTEM_STATUS', null),
        'user-1',
      );
      const u = order.indexOf('tenant.update');
      const r1 = order.indexOf('reload.tenant.findUnique');
      const r2 = order.indexOf('reload.binding.findMany');
      expect(u).toBeGreaterThanOrEqual(0);
      expect(r1).toBeGreaterThan(u);
      expect(r2).toBeGreaterThan(r1);
    });
  });

  describe('T12c — returned aggregate reflects reloaded tenant fields + bindings', () => {
    it('reflects reloaded isActive, updatedAt, binding IDs / names, and default selection', async () => {
      const mock = createMock();
      const reloaded = tenantReloaded({
        isActive: false,
        updatedAt: new Date('2026-06-15T12:34:56Z'),
      });
      baseStubs(mock, reloaded, [GA, GB], bindingsReloaded());
      const result = await new PrismaCatalogSettingsRepository(
        createSvc(mock),
      ).replace(makeAgg(true, 'SYSTEM_STATUS', null, true), 'user-1');
      expect(result.tenantId).toBe(T);
      expect(result.isActive).toBe(false);
      expect(result.updatedAt).toEqual(new Date('2026-06-15T12:34:56Z'));
      const ids = result.bindings.map((b) => b.globalPriceListId);
      expect(ids).toEqual([GA, GB]);
      const names = result.bindings.map((b) => b.globalPriceList.name);
      expect(names).toEqual(['List-A', 'List-B']);
      expect(result.defaultBinding?.globalPriceListId).toBe(GB);
    });
  });

  describe('T15b — null reload tenant throws not-found-after-replace and skips binding reload', () => {
    it('throws "not found after replace" when tenant.findUnique returns null, and never reads bindings', async () => {
      const mock = createMock();
      baseStubs(mock, null);
      await expect(
        new PrismaCatalogSettingsRepository(createSvc(mock)).replace(
          makeAgg(false, 'SYSTEM_STATUS', null),
          'user-1',
        ),
      ).rejects.toThrow(/not found after replace/i);
      // Binding reload must NOT run after a null tenant reload.
      expect(mock.tenantCatalogPriceList.findMany.mock.calls).toHaveLength(0);
    });
  });

  describe('T15c — reload binding findMany failure propagates', () => {
    it('propagates binding reload error when tenantCatalogPriceList.findMany rejects', async () => {
      const mock = createMock();
      baseStubs(mock, tenantReloaded());
      mock.tenantCatalogPriceList.findMany.mockRejectedValue(
        new Error('binding read error'),
      );
      await expect(
        new PrismaCatalogSettingsRepository(createSvc(mock)).replace(
          makeAgg(false, 'SYSTEM_STATUS', null),
          'user-1',
        ),
      ).rejects.toThrow('binding read error');
    });
  });
});
