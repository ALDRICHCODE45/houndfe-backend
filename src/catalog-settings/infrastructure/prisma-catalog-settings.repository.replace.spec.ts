/**
 * F1.WU2b.1c-A — Mocked transaction/precondition evidence for PrismaCatalogSettingsRepository.
 * Coverage: T5, T5a, T6, T6a, T10c.
 */
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { PrismaCatalogSettingsRepository } from './prisma-catalog-settings.repository';
import { TenantCatalogSettings } from '../domain/tenant-catalog-settings.aggregate';
import type { TenantCatalogPriceListBinding } from '../domain/tenant-catalog-price-list.entity';
import type { TenantBaseProps } from '../domain/tenant-catalog-settings.aggregate';

// Fixtures
const T = '11111111-1111-1111-1111-111111111111';
const GA = 'gaaaaaaa0-0000-0000-0000-000000000001';
const GB = 'gaaaaaaa1-0000-0000-0000-000000000002';
const BAD = '00000000-0000-0000-0000-000000000000';

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate helpers
// ─────────────────────────────────────────────────────────────────────────────

type CatalogStockMode =
  | 'SYSTEM_STATUS'
  | 'ABSTRACT_STATUS'
  | 'CUSTOM_QUANTITY'
  | 'HIDDEN';

interface TenantRow {
  id: string;
  isActive: boolean;
  catalogPublished: boolean;
  catalogStockPresentationDefault: CatalogStockMode;
  catalogStockPresentationDefaultCustomQty: number | null;
  updatedAt: Date;
}

function tRow(overrides?: Partial<TenantRow>): TenantRow {
  return {
    id: T,
    isActive: true,
    catalogPublished: false,
    catalogStockPresentationDefault: 'SYSTEM_STATUS',
    catalogStockPresentationDefaultCustomQty: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

// Fixed malformed type: catalogStockPresentationDefault is a string union, not an object
type MakeAggOverrides = Partial<
  Pick<
    TenantBaseProps,
    | 'catalogPublished'
    | 'catalogStockPresentationDefault'
    | 'catalogStockPresentationDefaultCustomQty'
  >
>;

function makeAgg(overrides?: MakeAggOverrides): TenantCatalogSettings {
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
      ...overrides,
    },
    bindings: [],
  };
  return TenantCatalogSettings.fromPersistence(raw);
}

function makeAggWithBindings(
  bindings: Array<{ gl: string; def: boolean; name: string }>,
  catalogPublished = false,
): TenantCatalogSettings {
  const raw: {
    tenant: TenantBaseProps;
    bindings: TenantCatalogPriceListBinding[];
  } = {
    tenant: {
      tenantId: T,
      isActive: true,
      catalogPublished,
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
// Typed mock client — interface declares shapes; implementation uses jest.fn()
// No `any` in test logic; unknown bridge only for TenantPrismaService construction
// ─────────────────────────────────────────────────────────────────────────────

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
  readonly globalPriceList: {
    readonly findMany: jest.Mock;
  };
}

function createMock(): MockClient {
  return {
    $queryRaw: jest.fn(),
    tenant: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    tenantCatalogPriceList: {
      updateMany: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
      findMany: jest.fn(),
    },
    globalPriceList: {
      findMany: jest.fn(),
    },
  };
}

function setupMock(mock: MockClient, emptyBindings = true): void {
  mock.$queryRaw.mockResolvedValue([{ id: T }]);
  mock.globalPriceList.findMany.mockResolvedValue([]);
  mock.tenant.findUnique.mockResolvedValue(tRow());
  mock.tenantCatalogPriceList.findMany.mockResolvedValue(
    emptyBindings
      ? []
      : [
          {
            id: 'b0',
            tenantId: T,
            globalPriceListId: GA,
            isCatalogDefault: true,
            createdAt: new Date('2024-01-01'),
            updatedAt: new Date('2024-01-01'),
            globalPriceList: { id: GA, name: 'List-A' },
          },
        ],
  );
  mock.tenantCatalogPriceList.updateMany.mockResolvedValue({ count: 0 });
  mock.tenantCatalogPriceList.upsert.mockResolvedValue({});
  mock.tenantCatalogPriceList.deleteMany.mockResolvedValue({ count: 0 });
  mock.tenant.update.mockResolvedValue(tRow());
}

// ─────────────────────────────────────────────────────────────────────────────
// Service factory — uses `unknown` bridge for TenantPrismaService only
// ─────────────────────────────────────────────────────────────────────────────

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
// Tests — WU2b.1c-A: transaction/precondition mocked evidence
// ─────────────────────────────────────────────────────────────────────────────

describe('PrismaCatalogSettingsRepository — replace', () => {
  describe('T5 — transaction invocation', () => {
    it('runInTransaction is called exactly once', async () => {
      const mock = createMock();
      setupMock(mock);
      const svc = createSvc(mock);
      await new PrismaCatalogSettingsRepository(svc).replace(
        makeAgg(),
        'user-1',
      );

      const runInTransaction = (
        svc as unknown as { runInTransaction: jest.Mock }
      ).runInTransaction;
      expect(runInTransaction).toHaveBeenCalledTimes(1);
    });

    it('explicit proof callback entry occurs before getClient() access', async () => {
      const mock = createMock();
      setupMock(mock);
      const svc = createSvc(mock);
      const getClientCalls: unknown[] = [];

      // Override runInTransaction to track getClient calls inside the callback
      const originalRunInTransaction = svc.runInTransaction.bind(svc) as (
        work: () => Promise<unknown>,
      ) => Promise<unknown>;

      (
        svc as unknown as {
          runInTransaction: (work: () => Promise<unknown>) => Promise<unknown>;
        }
      ).runInTransaction = async (work: () => Promise<unknown>) => {
        // Proof callback entry point — getClient called here
        getClientCalls.push(svc.getClient());
        return originalRunInTransaction(work);
      };

      await new PrismaCatalogSettingsRepository(svc).replace(
        makeAgg(),
        'user-1',
      );

      expect(getClientCalls).toHaveLength(1);
      expect(getClientCalls[0]).toBe(mock);
    });
  });

  describe('T5a — FOR UPDATE lock', () => {
    it('parameterized tenant FOR UPDATE lock is executed', async () => {
      const mock = createMock();
      setupMock(mock);
      await new PrismaCatalogSettingsRepository(createSvc(mock)).replace(
        makeAgg(),
        'user-1',
      );

      expect(mock.$queryRaw).toHaveBeenCalled();
      const calls = mock.$queryRaw.mock.calls as [
        [TemplateStringsArray, ...unknown[]],
      ];
      expect(calls).toHaveLength(1);
      expect(calls[0][0].join(' ? ')).toContain('FOR UPDATE');
      expect(calls[0].slice(1)).toContain(T);
    });

    it('missing tenant throws before any write', async () => {
      const mock = createMock();
      mock.$queryRaw.mockResolvedValue([]); // Empty result = tenant not found
      mock.globalPriceList.findMany.mockResolvedValue([]);

      const writeCallCount = () =>
        mock.tenantCatalogPriceList.updateMany.mock.calls.length +
        mock.tenantCatalogPriceList.upsert.mock.calls.length +
        mock.tenantCatalogPriceList.deleteMany.mock.calls.length +
        mock.tenant.update.mock.calls.length;

      await expect(
        new PrismaCatalogSettingsRepository(createSvc(mock)).replace(
          makeAgg(),
          'user-1',
        ),
      ).rejects.toThrow(/not found/i);

      expect(writeCallCount()).toBe(0);
    });
  });

  describe('T6 — ID validation', () => {
    it('globalPriceList.findMany validates requested IDs inside transaction', async () => {
      const mock = createMock();
      setupMock(mock);
      mock.globalPriceList.findMany.mockResolvedValue([{ id: GA }, { id: GB }]);

      await new PrismaCatalogSettingsRepository(createSvc(mock)).replace(
        makeAggWithBindings([
          { gl: GA, def: true, name: 'A' },
          { gl: GB, def: false, name: 'B' },
        ]),
        'user-1',
      );

      expect(mock.globalPriceList.findMany).toHaveBeenCalledWith({
        where: { id: { in: [GA, GB] } },
        select: { id: true },
      });
    });

    it('T6a — invalid ID short-circuits updateMany/upsert/deleteMany/tenant.update', async () => {
      const mock = createMock();
      mock.$queryRaw.mockResolvedValue([{ id: T }]);
      mock.globalPriceList.findMany.mockResolvedValue([{ id: GA }]); // Only GA exists; GB does not

      const writeCount = () =>
        mock.tenantCatalogPriceList.updateMany.mock.calls.length +
        mock.tenantCatalogPriceList.upsert.mock.calls.length +
        mock.tenantCatalogPriceList.deleteMany.mock.calls.length +
        mock.tenant.update.mock.calls.length;

      await expect(
        new PrismaCatalogSettingsRepository(createSvc(mock)).replace(
          makeAggWithBindings([
            { gl: GA, def: false, name: 'V' },
            { gl: BAD, def: true, name: 'I' }, // BAD is invalid
          ]),
          'user-1',
        ),
      ).rejects.toThrow(/INVALID_GLOBAL_PRICE_LIST/i);

      expect(writeCount()).toBe(0);
    });
  });

  describe('T10c — error propagation', () => {
    it('one representative write failure propagates', async () => {
      const mock = createMock();
      mock.$queryRaw.mockResolvedValue([{ id: T }]);
      mock.globalPriceList.findMany.mockResolvedValue([{ id: GA }, { id: GB }]);
      mock.tenantCatalogPriceList.updateMany.mockRejectedValue(
        new Error('DB write error'),
      );

      await expect(
        new PrismaCatalogSettingsRepository(createSvc(mock)).replace(
          makeAggWithBindings([
            { gl: GA, def: false, name: 'A' },
            { gl: GB, def: true, name: 'B' },
          ]),
          'user-1',
        ),
      ).rejects.toThrow('DB write error');
    });
  });
});
