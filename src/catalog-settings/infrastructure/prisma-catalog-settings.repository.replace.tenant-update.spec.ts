/**
 * F1.WU2b.1c-B2A — Tenant update payload / actor / failure mocked evidence.
 *
 * Scope: tenant.update payload derivation, where-clause scoping, actor
 * acceptance without persistence divergence, and tenant.update failure
 * short-circuiting the reload.
 *
 * Excludes by design (owned by other WUs):
 *   - reload-success reconstruction / ordering  → reload spec
 *   - binding upsert/delete/promote sequencing   → B1 sequencing spec
 *   - transaction preconditions (FOR UPDATE, ID validation)
 *                                              → A spec
 *   - real DB integration                       → WU2b.1d
 *
 * Coverage: T11a (propagates published + mode + customQty),
 *           T11a (HIDDEN + null customQty),
 *           T11b (where scoped to aggregate tenantId),
 *           T14  (distinct actors yield identical call args/counts;
 *                 actor never reaches any DB mock),
 *           T15  (tenant.update failure propagates; reload calls do not run).
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

interface TenantUpdateArgs {
  where: { id: string };
  data: {
    catalogPublished: boolean;
    catalogStockPresentationDefault: StockMode;
    catalogStockPresentationDefaultCustomQty: number | null;
  };
}

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

/**
 * Reusable reload-binding fixture (needed only so the reload step succeeds
 * when tenant.update precedes it; B2A does not assert on reload contents).
 */
function bindingsReloaded(): TenantCatalogPriceListBinding[] {
  return [
    {
      id: 'b0',
      tenantId: T,
      globalPriceListId: GA,
      isCatalogDefault: true,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
      globalPriceList: { id: GA, name: 'List-A' },
    },
  ];
}

/**
 * Build an aggregate. `published=true` requires a default binding to satisfy
 * invariants; the optional `withBindings` flag toggles that without forcing
 * B2A tests to depend on binding sequencing detail.
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
    ? [mkBinding(GA, true, 'List-A'), mkBinding(GB, false, 'List-B')]
    : [];
  return TenantCatalogSettings.fromPersistence({ tenant, bindings });
}

// ── Typed mock (no `any` / `as any`) ─────────────────────────────────────────

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

describe('PrismaCatalogSettingsRepository — replace tenant.update', () => {
  describe('T11a — payload derivation: published + mode + customQuantity', () => {
    it('propagates catalogPublished + stock mode + custom quantity to tenant.update', async () => {
      const mock = createMock();
      baseStubs(
        mock,
        tenantReloaded({
          catalogPublished: true,
          catalogStockPresentationDefault: 'CUSTOM_QUANTITY',
          catalogStockPresentationDefaultCustomQty: 7,
        }),
        [GA, GB],
        bindingsReloaded(),
      );
      await new PrismaCatalogSettingsRepository(createSvc(mock)).replace(
        makeAgg(true, 'CUSTOM_QUANTITY', 7, true),
        'user-1',
      );
      const calls = mock.tenant.update.mock.calls as Array<[TenantUpdateArgs]>;
      expect(calls).toHaveLength(1);
      expect(calls[0][0].data).toEqual({
        catalogPublished: true,
        catalogStockPresentationDefault: 'CUSTOM_QUANTITY',
        catalogStockPresentationDefaultCustomQty: 7,
      });
    });

    it('propagates HIDDEN mode with null custom quantity to tenant.update', async () => {
      const mock = createMock();
      baseStubs(mock, tenantReloaded());
      await new PrismaCatalogSettingsRepository(createSvc(mock)).replace(
        makeAgg(false, 'HIDDEN', null),
        'user-1',
      );
      const calls = mock.tenant.update.mock.calls as Array<[TenantUpdateArgs]>;
      expect(calls).toHaveLength(1);
      expect(calls[0][0].data).toEqual({
        catalogPublished: false,
        catalogStockPresentationDefault: 'HIDDEN',
        catalogStockPresentationDefaultCustomQty: null,
      });
    });
  });

  describe('T11b — where clause scoped to aggregate tenantId', () => {
    it('tenant.update where.id matches the aggregate tenantId', async () => {
      const mock = createMock();
      baseStubs(mock, tenantReloaded());
      await new PrismaCatalogSettingsRepository(createSvc(mock)).replace(
        makeAgg(false, 'SYSTEM_STATUS', null),
        'user-1',
      );
      const calls = mock.tenant.update.mock.calls as Array<[TenantUpdateArgs]>;
      expect(calls).toHaveLength(1);
      expect(calls[0][0].where).toEqual({ id: T });
    });

    it('tenant.update where.id derives from aggregate, not from the actor', async () => {
      const mock = createMock();
      baseStubs(mock, tenantReloaded());
      await new PrismaCatalogSettingsRepository(createSvc(mock)).replace(
        makeAgg(false, 'ABSTRACT_STATUS', null),
        'some-other-user-id',
      );
      const calls = mock.tenant.update.mock.calls as Array<[TenantUpdateArgs]>;
      expect(calls).toHaveLength(1);
      expect(calls[0][0].where).toEqual({ id: T });
      expect(calls[0][0].where.id).not.toBe('some-other-user-id');
    });
  });

  describe('T14 — actor acceptance without persistence divergence', () => {
    /** Recursively flatten jest.Mock call args (positional + nested arrays). */
    function flattenCallArgs(args: ReadonlyArray<unknown>): unknown[] {
      const out: unknown[] = [];
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
          for (const child of node as ReadonlyArray<unknown>) walk(child);
        } else {
          out.push(node);
        }
      };
      for (const a of args) walk(a);
      return out;
    }

    /** Total persistence-call count across the adapter's DB surface. */
    function totalPersistenceCalls(m: MockClient): number {
      return (
        m.tenant.update.mock.calls.length +
        m.tenant.findUnique.mock.calls.length +
        m.tenantCatalogPriceList.updateMany.mock.calls.length +
        m.tenantCatalogPriceList.upsert.mock.calls.length +
        m.tenantCatalogPriceList.deleteMany.mock.calls.length +
        m.tenantCatalogPriceList.findMany.mock.calls.length +
        m.globalPriceList.findMany.mock.calls.length +
        m.$queryRaw.mock.calls.length
      );
    }

    /** All DB-mock call arguments, flattened, for actor-isolation inspection. */
    function allDbCallArgs(m: MockClient): unknown[] {
      const all: unknown[] = [];
      const collect = (jestMock: jest.Mock): void => {
        for (const call of jestMock.mock.calls) {
          const args = call as ReadonlyArray<unknown>;
          for (const a of flattenCallArgs(args)) all.push(a);
        }
      };
      collect(m.tenant.update);
      collect(m.tenant.findUnique);
      collect(m.tenantCatalogPriceList.updateMany);
      collect(m.tenantCatalogPriceList.upsert);
      collect(m.tenantCatalogPriceList.deleteMany);
      collect(m.tenantCatalogPriceList.findMany);
      collect(m.globalPriceList.findMany);
      collect(m.$queryRaw);
      return all;
    }

    it('distinct actors yield identical tenant.update arguments', async () => {
      const actorA = 'user-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const actorB = 'user-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

      const mockA = createMock();
      baseStubs(mockA, tenantReloaded(), [GA, GB], bindingsReloaded());
      await new PrismaCatalogSettingsRepository(createSvc(mockA)).replace(
        makeAgg(true, 'CUSTOM_QUANTITY', 4, true),
        actorA,
      );

      const mockB = createMock();
      baseStubs(mockB, tenantReloaded(), [GA, GB], bindingsReloaded());
      await new PrismaCatalogSettingsRepository(createSvc(mockB)).replace(
        makeAgg(true, 'CUSTOM_QUANTITY', 4, true),
        actorB,
      );

      type UpdateCall = [TenantUpdateArgs];
      const callsA = mockA.tenant.update.mock.calls as UpdateCall[];
      const callsB = mockB.tenant.update.mock.calls as UpdateCall[];
      expect(callsA).toHaveLength(1);
      expect(callsB).toHaveLength(1);
      expect(callsA[0][0]).toEqual(callsB[0][0]);
    });

    it('distinct actors yield identical total persistence-call counts', async () => {
      const mockA = createMock();
      baseStubs(mockA, tenantReloaded());
      await new PrismaCatalogSettingsRepository(createSvc(mockA)).replace(
        makeAgg(false, 'SYSTEM_STATUS', null),
        'user-A',
      );

      const mockB = createMock();
      baseStubs(mockB, tenantReloaded());
      await new PrismaCatalogSettingsRepository(createSvc(mockB)).replace(
        makeAgg(false, 'SYSTEM_STATUS', null),
        'user-B',
      );

      expect(totalPersistenceCalls(mockA)).toBe(totalPersistenceCalls(mockB));
      // Single tenant.update per replace — actor must not trigger an audit row.
      expect(mockA.tenant.update.mock.calls).toHaveLength(1);
      expect(mockB.tenant.update.mock.calls).toHaveLength(1);
    });

    it('actorUserId never reaches any DB mock call argument', async () => {
      const actor = 'unique-actor-probe-id-zzzz-9999';
      const mock = createMock();
      baseStubs(mock, tenantReloaded());
      await new PrismaCatalogSettingsRepository(createSvc(mock)).replace(
        makeAgg(false, 'HIDDEN', null),
        actor,
      );
      const allArgs = allDbCallArgs(mock);
      // The actor string must never appear in any persisted call argument.
      expect(allArgs).not.toContain(actor);
    });
  });

  describe('T15 — tenant.update failure propagates and reload does not run', () => {
    it('tenant.update failure propagates and reload reads do not execute after', async () => {
      const mock = createMock();
      baseStubs(mock, tenantReloaded());
      mock.tenant.update.mockRejectedValue(new Error('DB write error'));

      await expect(
        new PrismaCatalogSettingsRepository(createSvc(mock)).replace(
          makeAgg(false, 'SYSTEM_STATUS', null),
          'user-1',
        ),
      ).rejects.toThrow('DB write error');

      // Reload reads (tenant.findUnique + tenantCatalogPriceList.findMany)
      // are owned by the reload step which must not run after the write fails.
      expect(mock.tenant.findUnique.mock.calls).toHaveLength(0);
      expect(mock.tenantCatalogPriceList.findMany.mock.calls).toHaveLength(0);
    });
  });
});
