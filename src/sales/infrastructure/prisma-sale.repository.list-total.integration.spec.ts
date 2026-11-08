/**
 * INTEGRATION SPEC: PrismaSaleRepository GET /sales list total.
 *
 * `GET /sales?status=CANCELED&folio=…` once reported `pagination.total: 62`
 * for a single matching row because the total came from the base-filter
 * KPI count. This spec pins, against the real `nest-practice-test`
 * database (port 5433 — NEVER the dev DB), that `aggregateManyConfirmed`
 * counts exactly the rows `findManyConfirmed` can return for several
 * filter combinations, and that a second tenant's sales never leak into
 * either query. It also proves the generated `openDebtCents` column:
 * `sortBy=debtCents` and `filterSummary.debtCents` treat canceled sales as
 * zero debt, and every sort breaks ties by confirmedAt, then id.
 *
 * Mirrors the `prisma-sale.repository.refunds.integration.spec.ts` setup:
 * shared Prisma client + CLS shim + `resetAndSeedBaseline()` in
 * `afterEach`.
 *
 * Skips gracefully when the test DB is unreachable (`SKIP_DB_INTEGRATION=1`
 * or unset `DATABASE_URL`).
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  BASELINE_TENANT_ID,
  disconnectIntegrationPrisma,
  resetAndSeedBaseline,
} from '../../../test/integration/reset-db';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { ClsService } from 'nestjs-cls';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { ListSalesStatus } from '../dto/list-sales-query.dto';
import type { SalesListExtendedFilter } from '../dto/sales-list-filter.types';
import { PrismaSaleRepository } from './prisma-sale.repository';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

type SeedSale = {
  id?: string;
  folio: string;
  status: 'CONFIRMED' | 'CANCELED';
  paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT';
  deliveryStatus: 'DELIVERED' | 'PENDING';
  totalCents: number;
  debtCents: number;
  confirmedAt: Date;
};

// Own tenant: 6 confirmed + 2 canceled. The KPI base count (confirmed
// only) is 6, so any filter that narrows the page must narrow the total.
const OWN_SALES: SeedSale[] = [
  ['V-0001', 'CONFIRMED', 'PAID', 'DELIVERED', 1000, 0, '2026-05-01'],
  ['V-0002', 'CONFIRMED', 'PAID', 'PENDING', 2500, 0, '2026-05-02'],
  ['V-0003', 'CONFIRMED', 'PARTIAL', 'PENDING', 4000, 1500, '2026-05-03'],
  ['V-0004', 'CONFIRMED', 'CREDIT', 'DELIVERED', 6000, 6000, '2026-05-10'],
  ['V-0005', 'CONFIRMED', 'PAID', 'DELIVERED', 8000, 0, '2026-05-20'],
  ['V-0006', 'CONFIRMED', 'PAID', 'DELIVERED', 9000, 0, '2026-06-01'],
  ['V-0007', 'CANCELED', 'PAID', 'DELIVERED', 3000, 0, '2026-05-04'],
  ['V-0008', 'CANCELED', 'CREDIT', 'PENDING', 7000, 7000, '2026-05-05'],
].map(([folio, status, paymentStatus, deliveryStatus, total, debt, day]) => ({
  folio: folio as string,
  status: status as SeedSale['status'],
  paymentStatus: paymentStatus as SeedSale['paymentStatus'],
  deliveryStatus: deliveryStatus as SeedSale['deliveryStatus'],
  totalCents: total as number,
  debtCents: debt as number,
  confirmedAt: new Date(`${day as string}T12:00:00.000Z`),
}));

describeIfDb(
  'PrismaSaleRepository sales list total (Integration - Real DB)',
  () => {
    let prisma: PrismaClient;
    let repo: PrismaSaleRepository;
    let tenantId: string;

    beforeAll(async () => {
      prisma = new PrismaClient();
      await prisma.$connect();
      await resetAndSeedBaseline();

      const tenant = await prisma.tenant.findFirst({ select: { id: true } });
      if (!tenant) {
        throw new Error(
          'No tenant found for integration test. globalSetup must have seeded one — ' +
            'verify .env.test and that `pnpm run test:db:up` has the container running.',
        );
      }
      tenantId = tenant.id;
      expect(tenantId).toBe(BASELINE_TENANT_ID);

      const clsStore = new Map<string, unknown>([
        ['tenantId', tenantId],
        ['isSuperAdmin', false],
      ]);
      const cls = {
        get: (key: string) => clsStore.get(key),
        set: (key: string, value: unknown) => {
          clsStore.set(key, value);
        },
      } as unknown as ClsService<TenantClsStore>;
      const tenantPrisma = new TenantPrismaService(
        prisma as unknown as ConstructorParameters<
          typeof TenantPrismaService
        >[0],
        cls,
      );
      repo = new PrismaSaleRepository(tenantPrisma);
    });

    afterEach(async () => {
      await resetAndSeedBaseline();
    });

    afterAll(async () => {
      await prisma.$disconnect();
      await disconnectIntegrationPrisma();
    });

    async function seedCashier(): Promise<string> {
      const userId = randomUUID();
      await prisma.user.create({
        data: {
          id: userId,
          email: `cashier-${randomUUID()}@test.local`,
          hashedPassword: 'test',
          name: 'Cashier',
          isActive: true,
        },
      });
      return userId;
    }

    async function seedSales(
      targetTenantId: string,
      userId: string,
      sales: SeedSale[],
    ): Promise<void> {
      await prisma.sale.createMany({
        data: sales.map((sale) => ({
          id: sale.id ?? randomUUID(),
          userId,
          tenantId: targetTenantId,
          channel: 'POS' as const,
          ...sale,
        })),
      });
    }

    async function seedForeignTenant(): Promise<string> {
      const foreignTenantId = randomUUID();
      await prisma.tenant.create({
        data: {
          id: foreignTenantId,
          name: 'Foreign Tenant',
          slug: `foreign-${randomUUID()}`,
          isActive: true,
        },
      });
      return foreignTenantId;
    }

    async function pageAndTotal(filter: SalesListExtendedFilter) {
      const rows = await repo.findManyConfirmed({
        ...filter,
        page: 1,
        limit: 100,
        sortBy: 'confirmedAt',
        sortOrder: 'asc',
      });
      const { count: total } = await repo.aggregateManyConfirmed(filter);
      return { folios: rows.map((row) => row.folio), total };
    }

    async function sortedFolios(
      filter: SalesListExtendedFilter,
      sortBy: 'confirmedAt' | 'totalCents' | 'createdAt' | 'debtCents',
      sortOrder: 'asc' | 'desc',
    ): Promise<Array<string | null>> {
      const rows = await repo.findManyConfirmed({
        ...filter,
        page: 1,
        limit: 100,
        sortBy,
        sortOrder,
      });
      return rows.map((row) => row.folio);
    }

    it.each<[string, SalesListExtendedFilter, string[]]>([
      [
        'no filters (confirmed default)',
        {},
        OWN_SALES.slice(0, 6).map((s) => s.folio),
      ],
      [
        'status CANCELED + folio',
        { status: ['CANCELED'], folio: ['V-0008'] },
        ['V-0008'],
      ],
      ['status CANCELED', { status: ['CANCELED'] }, ['V-0007', 'V-0008']],
      [
        'payment + delivery status',
        { paymentStatus: ['PAID'], deliveryStatus: ['PENDING'] },
        ['V-0002'],
      ],
      [
        'confirmed date range + total range',
        {
          confirmedFrom: new Date('2026-05-02T00:00:00.000Z'),
          confirmedTo: new Date('2026-05-31T23:59:59.999Z'),
          totalMin: 3000,
          totalMax: 8000,
        },
        ['V-0003', 'V-0004', 'V-0005'],
      ],
      [
        'debt range',
        { debtMin: 1, status: ['CONFIRMED', 'CANCELED'] },
        ['V-0003', 'V-0008', 'V-0004'],
      ],
      ['search by folio', { q: 'V-0005' }, ['V-0005']],
    ])(
      'total equals the filtered rows for %s',
      async (_label, filter, expectedFolios) => {
        const userId = await seedCashier();
        await seedSales(tenantId, userId, OWN_SALES);
        // Foreign tenant mirrors the same folios: must never be counted.
        const foreignTenantId = await seedForeignTenant();
        await seedSales(foreignTenantId, userId, OWN_SALES);

        const { folios, total } = await pageAndTotal(filter);

        expect([...folios].sort()).toEqual([...expectedFolios].sort());
        expect(total).toBe(folios.length);
      },
    );

    it('keeps the KPI base count independent from extended filters', async () => {
      const userId = await seedCashier();
      await seedSales(tenantId, userId, OWN_SALES);

      const { total } = await pageAndTotal({
        status: ['CANCELED'],
        folio: ['V-0008'],
      });
      const kpi = await repo.aggregateSummaryConfirmed({});

      expect(total).toBe(1);
      expect(kpi.salesCount).toBe(6);
    });

    describe('debt sort and filter summary (generated openDebtCents)', () => {
      const ALL_STATUSES: SalesListExtendedFilter = {
        status: [ListSalesStatus.CONFIRMED, ListSalesStatus.CANCELED],
      };

      it('sorts by open debt desc, canceled as 0, ties by confirmedAt desc', async () => {
        const userId = await seedCashier();
        await seedSales(tenantId, userId, OWN_SALES);
        const foreignTenantId = await seedForeignTenant();
        await seedSales(foreignTenantId, userId, OWN_SALES);

        const folios = await sortedFolios(ALL_STATUSES, 'debtCents', 'desc');

        // V-0008 is canceled with stored debt 7000: it sorts as 0 debt.
        expect(folios).toEqual([
          'V-0004',
          'V-0003',
          'V-0006',
          'V-0005',
          'V-0008',
          'V-0007',
          'V-0002',
          'V-0001',
        ]);
      });

      it('aggregates the whole filter: count, totalCents and open debt', async () => {
        const userId = await seedCashier();
        await seedSales(tenantId, userId, OWN_SALES);
        const foreignTenantId = await seedForeignTenant();
        await seedSales(foreignTenantId, userId, OWN_SALES);

        const summary = await repo.aggregateManyConfirmed(ALL_STATUSES);
        const stored = await prisma.sale.findFirst({
          where: { tenantId, folio: 'V-0008' },
          select: { debtCents: true, openDebtCents: true },
        });

        expect(summary).toEqual({
          count: 8,
          totalCents: 40500,
          debtCents: 7500,
        });
        expect(stored).toEqual({ debtCents: 7000, openDebtCents: 0 });
      });

      it('returns zeroed sums when no row matches', async () => {
        const summary = await repo.aggregateManyConfirmed({
          folio: ['V-9999'],
        });

        expect(summary).toEqual({ count: 0, totalCents: 0, debtCents: 0 });
      });

      it.each(['asc', 'desc'] as const)(
        'breaks identical confirmedAt + totalCents ties by id %s',
        async (sortOrder) => {
          const userId = await seedCashier();
          const confirmedAt = new Date('2026-07-01T12:00:00.000Z');
          const twin = {
            status: 'CONFIRMED' as const,
            paymentStatus: 'PAID' as const,
            deliveryStatus: 'DELIVERED' as const,
            totalCents: 5000,
            debtCents: 0,
            confirmedAt,
          };
          await seedSales(tenantId, userId, [
            {
              ...twin,
              id: 'ffffffff-0000-4000-8000-000000000001',
              folio: 'T-HIGH',
            },
            {
              ...twin,
              id: '00000000-0000-4000-8000-000000000001',
              folio: 'T-LOW',
            },
          ]);
          const expected =
            sortOrder === 'asc' ? ['T-LOW', 'T-HIGH'] : ['T-HIGH', 'T-LOW'];

          for (const sortBy of [
            'confirmedAt',
            'totalCents',
            'debtCents',
          ] as const) {
            expect(await sortedFolios({}, sortBy, sortOrder)).toEqual(expected);
          }
        },
      );
    });
  },
);
