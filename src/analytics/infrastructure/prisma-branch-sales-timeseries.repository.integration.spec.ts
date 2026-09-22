/**
 * OI-2 / S3 — daily bucket adapter against real PostgreSQL.
 *
 * `Sale.confirmedAt` is a UTC-naive `timestamp(3)`: 2026 uses the standard
 * Mexico City offset (-06:00), so local midnight 2026-01-01 is 06:00Z, while
 * 2021 used DST (-05:00), so local midnight 2021-07-01 is 05:00Z. Ranges are
 * half-open `[from,to)` keyed on `confirmedAt` for current-tenant `CONFIRMED`
 * sales only, and the hostile-session case proves the UTC normalization rather
 * than the session environment.
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import {
  BASELINE_TENANT_ID,
  disconnectIntegrationPrisma,
  resetAndSeedBaseline,
} from '../../../test/integration/reset-db';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import type {
  BranchSalesDailyAggregateRow,
  BranchSalesTimeseriesRange,
} from '../domain/branch-sales-timeseries.repository';
import { PrismaBranchSalesTimeseriesRepository } from './prisma-branch-sales-timeseries.repository';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;
const JAN_2026 = { from: '2026-01-01', to: '2026-01-04' } as const;
const JUL_2021 = { from: '2021-07-01', to: '2021-07-03' } as const;
const HOSTILE_DATE_STYLE = 'German';

type PrismaLike = ConstructorParameters<typeof TenantPrismaService>[0];
interface SaleOverrides {
  status?: 'DRAFT' | 'CONFIRMED' | 'CANCELED';
  tenantId?: string;
  createdAt?: string;
}
const compact = (rows: BranchSalesDailyAggregateRow[]): string[] =>
  rows.map(
    (r) =>
      `${r.date}|${r.grossSalesCents}|${r.netSalesCents}|${r.collectedCents}|${r.outstandingDebtCents}|${r.saleCount}`,
  );

describeIfDb(
  'BranchSalesTimeseriesRepository.findDailyAggregates (Integration - Real DB)',
  () => {
    let prisma: PrismaClient;
    let userId: string;

    beforeAll(async () => {
      prisma = new PrismaClient();
      await prisma.$connect();
    });

    beforeEach(async () => {
      await resetAndSeedBaseline();
      userId = await seedUser();
    });

    afterAll(async () => {
      await resetAndSeedBaseline();
      await prisma.$disconnect();
      await disconnectIntegrationPrisma();
    });

    function tenantPrismaFor(tenantId: string, client: PrismaClient = prisma) {
      const store = new Map<string, unknown>([
        ['tenantId', tenantId],
        ['isSuperAdmin', false],
      ]);
      const cls = {
        get: (key: string) => store.get(key),
        set: (key: string, value: unknown) => {
          store.set(key, value);
        },
      } as unknown as ClsService<TenantClsStore>;
      return new TenantPrismaService(client as unknown as PrismaLike, cls);
    }

    const repoFor = (tenantId: string) =>
      new PrismaBranchSalesTimeseriesRepository(tenantPrismaFor(tenantId));

    async function seedUser(): Promise<string> {
      const id = randomUUID();
      await prisma.user.create({
        data: {
          id,
          email: `timeseries-${id}@test.local`,
          hashedPassword: 'test',
          name: 'Fixture',
          isActive: true,
        },
      });
      return id;
    }

    async function seedForeignTenant(): Promise<string> {
      const id = randomUUID();
      await prisma.tenant.create({
        data: { id, name: 'Foreign Branch', slug: `foreign-${id}` },
      });
      return id;
    }

    async function seedSale(
      at: string | null,
      subtotalCents: number,
      totalCents: number,
      paidCents: number,
      debtCents: number,
      opts: SaleOverrides = {},
    ): Promise<void> {
      const { status = 'CONFIRMED', tenantId = BASELINE_TENANT_ID } = opts;
      await prisma.sale.create({
        data: {
          id: randomUUID(),
          userId,
          tenantId,
          status,
          subtotalCents,
          totalCents,
          paidCents,
          debtCents,
          confirmedAt: at === null ? null : new Date(at),
          createdAt: opts.createdAt ? new Date(opts.createdAt) : undefined,
        },
      });
    }

    /**
     * Hostile session via connection options on a dedicated client: nothing is
     * spliced into a statement, the ambient pool is untouched, no restoration is
     * claimed, and a static probe proves the settings are in effect.
     */
    async function findUnderHostileSession(
      zone: string,
      range: BranchSalesTimeseriesRange,
    ): Promise<BranchSalesDailyAggregateRow[]> {
      const base = process.env.DATABASE_URL;
      if (!base) throw new Error('DATABASE_URL is required');
      const url = new URL(base);
      const options = `-c TimeZone=${zone} -c DateStyle=${HOSTILE_DATE_STYLE}`;
      url.searchParams.set('options', options);
      const client = new PrismaClient({
        datasources: { db: { url: url.toString() } },
      });
      try {
        const [{ TimeZone }] = await client.$queryRaw<
          { TimeZone: string }[]
        >`SELECT current_setting('TimeZone') AS "TimeZone"`;
        expect(TimeZone).toBe(zone);
        return await new PrismaBranchSalesTimeseriesRepository(
          tenantPrismaFor(BASELINE_TENANT_ID, client),
        ).findDailyAggregates(range);
      } finally {
        await client.$disconnect();
      }
    }

    it('buckets local days, honours the half-open confirmedAt range, and stays sparse', async () => {
      const foreignId = await seedForeignTenant();
      const before = '2026-01-01T05:59:59.999Z';
      const mid = '2026-01-02T12:00:00.000Z';
      // Day 1: inclusive lower boundary (out-of-range createdAt never gates) plus
      // the local day's last millisecond; day 2 opens at the exclusive upper edge.
      await seedSale('2026-01-01T06:00:00.000Z', 100, 200, 150, 50, {
        createdAt: '2025-12-24T00:00:00.000Z',
      });
      await seedSale('2026-01-02T05:59:59.999Z', 10, 20, 5, 15);
      await seedSale('2026-01-02T06:00:00.000Z', 1000, 4000, 3000, 1000);
      // Excluded: before-range+in-range createdAt, exclusive `to`, DRAFT, CANCELED, null, foreign.
      await seedSale(before, 9000, 9000, 9000, 0, { createdAt: mid });
      await seedSale('2026-01-04T06:00:00.000Z', 8000, 8000, 8000, 0);
      await seedSale(mid, 7000, 7000, 7000, 0, { status: 'DRAFT' });
      await seedSale(mid, 6000, 6000, 6000, 0, { status: 'CANCELED' });
      await seedSale(null, 5000, 5000, 5000, 0);
      await seedSale(mid, 4000, 4000, 4000, 0, { tenantId: foreignId });

      // Day 3 is absent (sparse); each repo sees only its own tenant, so the
      // explicit raw-SQL predicate is what scopes.
      const baseline =
        await repoFor(BASELINE_TENANT_ID).findDailyAggregates(JAN_2026);
      expect(compact(baseline)).toEqual([
        '2026-01-01|110|220|155|65|2',
        '2026-01-02|1000|4000|3000|1000|1',
      ]);
      const foreign = await repoFor(foreignId).findDailyAggregates(JAN_2026);
      expect(compact(foreign)).toEqual(['2026-01-02|4000|4000|4000|0|1']);
    });

    it('is host-timezone and DateStyle independent across a Mexico DST-era range', async () => {
      await seedSale('2021-07-01T05:00:00.000Z', 500, 500, 500, 0);
      await seedSale('2021-07-02T04:59:59.999Z', 1, 2, 3, 4);
      await seedSale('2021-07-02T05:00:00.000Z', 10, 20, 30, 40);
      for (const zone of ['Pacific/Kiritimati', 'Asia/Tokyo']) {
        const rows = await findUnderHostileSession(zone, JUL_2021);
        expect(compact(rows)).toEqual([
          '2021-07-01|501|502|503|4|2',
          '2021-07-02|10|20|30|40|1',
        ]);
      }
    });
  },
);
