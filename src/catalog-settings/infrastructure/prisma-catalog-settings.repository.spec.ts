/**
 * F1.WU2b.1b — Read/query evidence for PrismaCatalogSettingsRepository.
 * Scope: mocked unit tests only. Excludes replace/transaction → WU2b.1c.
 *
 * Coverage: T2 (explicit tenant predicates), T2a (ordered bindings),
 * T2b (domain aggregate reconstruction), T3 (null tenant), T4 (invariant propagation),
 * T11 (empty-ids short-circuit), T12 (coverage count with priceCents > 0).
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { PrismaCatalogSettingsRepository } from './prisma-catalog-settings.repository';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T = '11111111-1111-1111-1111-111111111111';
const GA = 'gaaaaaaaa-0000-0000-0000-000000000001';
const GB = 'bbbbbbbb-0000-0000-0000-000000000002';

function tenantRow(
  overrides?: Partial<{
    catalogPublished: boolean;
    catalogStockPresentationDefault:
      | 'SYSTEM_STATUS'
      | 'ABSTRACT_STATUS'
      | 'CUSTOM_QUANTITY'
      | 'HIDDEN';
  }>,
) {
  return {
    id: T,
    isActive: true,
    catalogPublished: false,
    catalogStockPresentationDefault: 'SYSTEM_STATUS' as const,
    catalogStockPresentationDefaultCustomQty: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

type BindingRow = {
  id: string;
  tenantId: string;
  globalPriceListId: string;
  isCatalogDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
  globalPriceList: { id: string; name: string };
};

function bindingRows(specs: Array<{ gl: string; def: boolean }>): BindingRow[] {
  return specs.map(({ gl, def }, i) => ({
    id: `b${i}`,
    tenantId: T,
    globalPriceListId: gl,
    isCatalogDefault: def,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    globalPriceList: { id: gl, name: `List-${gl.slice(-3)}` },
  }));
}

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

function createMock() {
  return {
    tenant: { findUnique: jest.fn() },
    tenantCatalogPriceList: { findMany: jest.fn() },
    globalPriceList: { findMany: jest.fn() },
    priceList: { count: jest.fn() },
  };
}

function createSvc(mock: ReturnType<typeof createMock>): TenantPrismaService {
  // Narrowed structural mock → TenantPrismaService via unknown bridge (no `any`)
  return {
    getClient: () => mock,
    getTenantId: () => T,
    runInTransaction: async <R>(w: () => Promise<R>) => w(),
  } as unknown as TenantPrismaService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PrismaCatalogSettingsRepository — read/query', () => {
  describe('findByTenantId', () => {
    it('T2 — queries tenant with explicit tenantId where clause', async () => {
      const mock = createMock();
      mock.tenant.findUnique.mockResolvedValue(tenantRow());
      mock.tenantCatalogPriceList.findMany.mockResolvedValue([]);
      await new PrismaCatalogSettingsRepository(createSvc(mock)).findByTenantId(
        T,
      );
      expect(mock.tenant.findUnique).toHaveBeenCalledWith({
        where: { id: T },
        select: expect.any(Object),
      });
    });

    it('T2 — queries bindings with explicit tenantId and ascending globalPriceListId', async () => {
      const mock = createMock();
      mock.tenant.findUnique.mockResolvedValue(tenantRow());
      mock.tenantCatalogPriceList.findMany.mockResolvedValue([]);
      await new PrismaCatalogSettingsRepository(createSvc(mock)).findByTenantId(
        T,
      );
      expect(mock.tenantCatalogPriceList.findMany).toHaveBeenCalledWith({
        where: { tenantId: T },
        orderBy: { globalPriceListId: 'asc' },
        include: { globalPriceList: { select: { id: true, name: true } } },
      });
    });

    it('T2a — bindings projection includes globalPriceList {id, name}', async () => {
      const mock = createMock();
      mock.tenant.findUnique.mockResolvedValue(tenantRow());
      mock.tenantCatalogPriceList.findMany.mockResolvedValue(
        bindingRows([{ gl: GA, def: true }]),
      );
      const result = await new PrismaCatalogSettingsRepository(
        createSvc(mock),
      ).findByTenantId(T);
      expect(result?.defaultBinding?.globalPriceList).toMatchObject({ id: GA });
      expect(result?.defaultBinding?.globalPriceList.name).toMatch(/List/);
    });

    it('T2b — reconstructs aggregate with names from binding projection', async () => {
      const mock = createMock();
      mock.tenant.findUnique.mockResolvedValue(
        tenantRow({ catalogPublished: true }),
      );
      mock.tenantCatalogPriceList.findMany.mockResolvedValue(
        bindingRows([
          { gl: GA, def: true },
          { gl: GB, def: false },
        ]),
      );
      const result = await new PrismaCatalogSettingsRepository(
        createSvc(mock),
      ).findByTenantId(T);
      expect(result?.bindings).toHaveLength(2);
      const names = result!.bindings.map((b) => b.globalPriceList.name);
      expect(names).toContain(`List-${GA.slice(-3)}`);
      expect(names).toContain(`List-${GB.slice(-3)}`);
    });

    it('T3 — returns null when tenant does not exist', async () => {
      const mock = createMock();
      mock.tenant.findUnique.mockResolvedValue(null);
      const result = await new PrismaCatalogSettingsRepository(
        createSvc(mock),
      ).findByTenantId(T);
      expect(result).toBeNull();
      expect(mock.tenantCatalogPriceList.findMany).not.toHaveBeenCalled();
    });

    it('T4 — PUBLISH_REQUIRES_DEFAULT propagates when published and bindings empty', async () => {
      const mock = createMock();
      mock.tenant.findUnique.mockResolvedValue(
        tenantRow({ catalogPublished: true }),
      );
      mock.tenantCatalogPriceList.findMany.mockResolvedValue([]);
      await expect(
        new PrismaCatalogSettingsRepository(createSvc(mock)).findByTenantId(T),
      ).rejects.toThrow('Published catalogs require a default binding');
    });

    it('T4 — invariant error propagates when published with no default binding', async () => {
      const mock = createMock();
      mock.tenant.findUnique.mockResolvedValue(
        tenantRow({ catalogPublished: true }),
      );
      mock.tenantCatalogPriceList.findMany.mockResolvedValue(
        bindingRows([{ gl: GA, def: false }]),
      );
      await expect(
        new PrismaCatalogSettingsRepository(createSvc(mock)).findByTenantId(T),
      ).rejects.toThrow(
        /Bindings must have exactly one default|Published catalogs require a default/,
      );
    });

    it('T2a — bindings ordered by globalPriceListId ascending in aggregate', async () => {
      const mock = createMock();
      mock.tenant.findUnique.mockResolvedValue(tenantRow());
      mock.tenantCatalogPriceList.findMany.mockResolvedValue(
        bindingRows([
          { gl: GA, def: false },
          { gl: GB, def: true },
        ]),
      );
      const result = await new PrismaCatalogSettingsRepository(
        createSvc(mock),
      ).findByTenantId(T);
      const ids = result!.bindings.map((b) => b.globalPriceListId);
      expect(ids).toEqual([GA, GB]);
    });

    it('defaultBinding returns the single isCatalogDefault binding', async () => {
      const mock = createMock();
      mock.tenant.findUnique.mockResolvedValue(tenantRow());
      mock.tenantCatalogPriceList.findMany.mockResolvedValue(
        bindingRows([
          { gl: GA, def: false },
          { gl: GB, def: true },
        ]),
      );
      const result = await new PrismaCatalogSettingsRepository(
        createSvc(mock),
      ).findByTenantId(T);
      expect(result!.defaultBinding?.globalPriceListId).toBe(GB);
    });

    it('defaultBinding returns null when bindings array is empty', async () => {
      const mock = createMock();
      mock.tenant.findUnique.mockResolvedValue(tenantRow());
      mock.tenantCatalogPriceList.findMany.mockResolvedValue([]);
      const result = await new PrismaCatalogSettingsRepository(
        createSvc(mock),
      ).findByTenantId(T);
      expect(result!.defaultBinding).toBeNull();
    });
  });

  describe('findGlobalPriceListsByIds', () => {
    it('T11 — returns empty array with no DB call for empty ids', async () => {
      const mock = createMock();
      const result = await new PrismaCatalogSettingsRepository(
        createSvc(mock),
      ).findGlobalPriceListsByIds([]);
      expect(result).toEqual([]);
      expect(mock.globalPriceList.findMany).not.toHaveBeenCalled();
    });

    it('T11 — queries DB with in clause selecting only id and name', async () => {
      const mock = createMock();
      mock.globalPriceList.findMany.mockResolvedValue([
        { id: GA, name: 'Public' },
        { id: GB, name: 'Internal' },
      ]);
      const result = await new PrismaCatalogSettingsRepository(
        createSvc(mock),
      ).findGlobalPriceListsByIds([GA, GB]);
      expect(result).toEqual([
        { id: GA, name: 'Public' },
        { id: GB, name: 'Internal' },
      ]);
      expect(mock.globalPriceList.findMany).toHaveBeenCalledWith({
        where: { id: { in: [GA, GB] } },
        select: { id: true, name: true },
      });
    });

    it('returns only found rows when some ids do not exist', async () => {
      const mock = createMock();
      mock.globalPriceList.findMany.mockResolvedValue([
        { id: GA, name: 'Found' },
      ]);
      const result = await new PrismaCatalogSettingsRepository(
        createSvc(mock),
      ).findGlobalPriceListsByIds([GA, '00000000-0000-0000-0000-000000000000']);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(GA);
    });
  });

  describe('countDefaultContextCoverage', () => {
    it('T12 — counts products scoped to tenantId + globalPriceListId with priceCents > 0', async () => {
      const mock = createMock();
      mock.priceList.count.mockResolvedValue(42);
      const count = await new PrismaCatalogSettingsRepository(
        createSvc(mock),
      ).countDefaultContextCoverage(T, GA);
      expect(count).toBe(42);
      expect(mock.priceList.count).toHaveBeenCalledWith({
        where: { tenantId: T, globalPriceListId: GA, priceCents: { gt: 0 } },
      });
    });

    it('T12 — uses explicit tenantId in coverage count', async () => {
      const mock = createMock();
      const other = '22222222-2222-2222-2222-222222222222';
      mock.priceList.count.mockResolvedValue(7);
      await new PrismaCatalogSettingsRepository(
        createSvc(mock),
      ).countDefaultContextCoverage(other, GB);
      expect(mock.priceList.count).toHaveBeenCalledWith({
        where: {
          tenantId: other,
          globalPriceListId: GB,
          priceCents: { gt: 0 },
        },
      });
    });

    it('T12 — returns zero when no products have positive priceCents', async () => {
      const mock = createMock();
      mock.priceList.count.mockResolvedValue(0);
      const count = await new PrismaCatalogSettingsRepository(
        createSvc(mock),
      ).countDefaultContextCoverage(T, GA);
      expect(count).toBe(0);
    });
  });
});
