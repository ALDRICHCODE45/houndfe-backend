/**
 * Branch sales summary aggregate against real PostgreSQL
 * (branch-analytics-summary / bas-2b).
 *
 * The adapter derives both boundaries in SQL with
 * `<date>::timestamp AT TIME ZONE 'America/Mexico_City'` and reads the
 * half-open range `[from, to)`. Running the real statement lets Postgres — not
 * a hardcoded offset — prove the semantics this suite pins down:
 *
 *   - Summer 2021 used the Mexico City DST offset (-05:00), so local midnight
 *     2021-07-01 is 05:00Z; 2026 is standard time (-06:00), so local midnight
 *     2026-07-01 is 06:00Z.
 *   - Only current-tenant CONFIRMED sales with `confirmedAt` inside the range
 *     feed gross/net/collected/debt/count/average-ticket.
 *   - Tendered `sale_payments` rows are never a metric input.
 *   - Settlement flow follows `settledAt`; pending obligations follow refund
 *     `createdAt` against the ALL-TIME settlement ledger, ignoring the cached
 *     `SaleRefund.settledCents` counter.
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
import { PrismaBranchSalesSummaryRepository } from './prisma-branch-sales-summary.repository';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

/** Summer 2021: DST offset -05:00, so local midnight 2021-07-01 is 05:00Z. */
const DST_SUMMER_2021 = { from: '2021-07-01', to: '2021-07-02' } as const;
/** 2026: standard offset -06:00, so local midnight 2026-07-01 is 06:00Z. */
const STANDARD_2026 = { from: '2026-07-01', to: '2026-07-02' } as const;
const EMPTY_2030 = { from: '2030-01-01', to: '2030-01-02' } as const;

type SaleStatusLiteral = 'DRAFT' | 'CONFIRMED' | 'CANCELED';

/** `[confirmedAt ISO|null, subtotal, total, paid, debt, status?, tenantId?]` */
type SaleRow = [
  string | null,
  number,
  number,
  number,
  number,
  SaleStatusLiteral?,
  string?,
];

/** `[amountCents, createdAt ISO, cachedSettledCents?, tenantId?]` */
type RefundRow = [number, string, number?, string?];

describeIfDb(
  'PrismaBranchSalesSummaryRepository.aggregate (Integration - Real DB)',
  () => {
    let prisma: PrismaClient;
    let userId: string;

    beforeAll(async () => {
      prisma = new PrismaClient();
      await prisma.$connect();
    });

    // Reset before every case so each starts from the baseline tenant alone,
    // and so a mid-test failure cannot leak rows into the next one.
    beforeEach(async () => {
      await resetAndSeedBaseline();
      userId = await seedUser();
    });

    afterAll(async () => {
      await resetAndSeedBaseline();
      await prisma.$disconnect();
      await disconnectIntegrationPrisma();
    });

    function createRepository(tenantId: string) {
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
      const tenantPrisma = new TenantPrismaService(
        prisma as unknown as ConstructorParameters<
          typeof TenantPrismaService
        >[0],
        cls,
      );
      return new PrismaBranchSalesSummaryRepository(tenantPrisma);
    }

    async function seedUser(): Promise<string> {
      const id = randomUUID();
      await prisma.user.create({
        data: {
          id,
          email: `analytics-${id}@test.local`,
          hashedPassword: 'test',
          name: 'Analytics Fixture',
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

    async function seedSale([
      at,
      subtotalCents,
      totalCents,
      paidCents,
      debtCents,
      status = 'CONFIRMED',
      tenantId = BASELINE_TENANT_ID,
    ]: SaleRow): Promise<string> {
      const id = randomUUID();
      await prisma.sale.create({
        data: {
          id,
          userId,
          tenantId,
          status,
          channel: 'POS',
          deliveryStatus: 'DELIVERED',
          paymentStatus: paidCents > 0 ? 'PAID' : 'CREDIT',
          subtotalCents,
          totalCents,
          paidCents,
          debtCents,
          discountCents: 0,
          confirmedAt: at === null ? null : new Date(at),
        },
      });
      return id;
    }

    async function seedRefund(
      saleId: string,
      [
        amountCents,
        createdAt,
        settledCents = 0,
        tenantId = BASELINE_TENANT_ID,
      ]: RefundRow,
    ): Promise<string> {
      const id = randomUUID();
      await prisma.saleRefund.create({
        data: {
          id,
          tenantId,
          saleId,
          method: 'CASH',
          amountCents,
          settledCents,
          reason: 'CUSTOMER_REQUEST',
          status: 'PENDING',
          createdAt: new Date(createdAt),
        },
      });
      return id;
    }

    /** Ledger row; `tenantId` must match the refund's composite FK. */
    async function seedSettlement(
      saleRefundId: string,
      amountCents: number,
      settledAt: string,
      tenantId = BASELINE_TENANT_ID,
    ): Promise<void> {
      await prisma.saleRefundSettlement.create({
        data: {
          id: randomUUID(),
          tenantId,
          saleRefundId,
          amountCents,
          method: 'CASH',
          settledAt: new Date(settledAt),
        },
      });
    }

    it('proves DST-aware boundaries, CONFIRMED-only accounting, and tenant isolation', async () => {
      const foreignId = await seedForeignTenant();
      const repo = createRepository(BASELINE_TENANT_ID);
      const lower = '2021-07-01T05:00:00.000Z';
      const mid = '2021-07-01T18:00:00.000Z';
      const upper = '2021-07-02T05:00:00.000Z';
      const before = '2021-07-01T04:59:59.999Z';

      // Counted: the lower boundary (05:00Z is local midnight under 2021 DST)
      // plus a mid-range sale. Net totals 100 + 51 = 151, so the average ticket
      // must round 75.5 up to 76.
      const boundarySaleId = await seedSale([lower, 1000, 100, 80, 20]);
      await seedSale([mid, 2000, 51, 51, 0]);

      // Tendered cash is never a metric input, however large.
      await prisma.salePayment.create({
        data: {
          id: randomUUID(),
          saleId: boundarySaleId,
          userId,
          tenantId: BASELINE_TENANT_ID,
          method: 'CASH',
          amountCents: 2_000_000_000,
        },
      });

      // One exclusion reason each: exclusive upper boundary, before-range,
      // DRAFT, CANCELED, missing `confirmedAt`, and a foreign tenant.
      const ignored: SaleRow[] = [
        [upper, 9000, 900, 900, 0],
        [before, 8000, 800, 800, 0],
        [mid, 7000, 700, 700, 0, 'DRAFT'],
        [mid, 6000, 600, 600, 0, 'CANCELED'],
        [null, 5000, 500, 500, 0],
        [mid, 4000, 400, 400, 0, 'CONFIRMED', foreignId],
      ];
      for (const row of ignored) {
        await seedSale(row);
      }

      await expect(repo.aggregate(DST_SUMMER_2021)).resolves.toEqual({
        grossSalesCents: 3000,
        netSalesCents: 151,
        collectedCents: 131,
        outstandingDebtCents: 20,
        saleCount: 2,
        averageTicketCents: 76,
        settledRefundsCents: 0,
        pendingRefundObligationsCents: 0,
      });
    });

    it('proves settledAt flow, ledger-authoritative obligations, and refund date bases', async () => {
      const foreignId = await seedForeignTenant();
      const repo = createRepository(BASELINE_TENANT_ID);
      const host = await seedSale([null, 99_999, 99_999, 99_999, 0, 'DRAFT']);
      const foreignHost = await seedSale([
        null,
        77_777,
        77_777,
        77_777,
        0,
        'DRAFT',
        foreignId,
      ]);

      // partialId is partially settled (400 + 300 of 1000 -> 300 pending);
      // fullId is fully settled by the ledger while its cached counter reads 0;
      // corruptId's cached counter claims 800 settled while the ledger holds
      // only 300, so its derived balance must be 500.
      const partialId = await seedRefund(host, [
        1000,
        '2026-07-01T12:00:00.000Z',
      ]);
      const fullId = await seedRefund(host, [500, '2026-07-01T13:00:00.000Z']);
      const corruptId = await seedRefund(host, [
        800,
        '2026-07-01T14:00:00.000Z',
        800,
      ]);
      // Created exactly at the exclusive upper boundary -> never an obligation.
      const upperId = await seedRefund(host, [
        4000,
        '2026-07-02T06:00:00.000Z',
      ]);
      // Created before the range but settled inside it: the settlement is flow,
      // the 650 remaining obligation is not.
      const beforeId = await seedRefund(host, [
        900,
        '2026-06-30T09:00:00.000Z',
      ]);
      const foreignRefundId = await seedRefund(foreignHost, [
        5000,
        '2026-07-01T15:00:00.000Z',
        0,
        foreignId,
      ]);

      // Inside-range flow: the exact lower boundary plus one mid-range
      // settlement. Only these two contribute 550.
      await seedSettlement(beforeId, 250, '2026-07-01T06:00:00.000Z');
      await seedSettlement(partialId, 300, '2026-07-01T23:00:00.000Z');
      // Outside-range ledger rows: before the range and the exclusive upper
      // boundary. They still count in the all-time obligation ledger.
      await seedSettlement(partialId, 400, '2026-06-15T12:00:00.000Z');
      await seedSettlement(fullId, 500, '2026-06-16T12:00:00.000Z');
      await seedSettlement(corruptId, 300, '2026-06-17T12:00:00.000Z');
      await seedSettlement(upperId, 5000, '2026-07-02T06:00:00.000Z');
      await seedSettlement(
        foreignRefundId,
        9000,
        '2026-07-01T07:00:00.000Z',
        foreignId,
      );

      await expect(repo.aggregate(STANDARD_2026)).resolves.toEqual({
        grossSalesCents: 0,
        netSalesCents: 0,
        collectedCents: 0,
        outstandingDebtCents: 0,
        saleCount: 0,
        averageTicketCents: 0,
        settledRefundsCents: 550,
        pendingRefundObligationsCents: 800,
      });
    });

    it('returns all eight metrics as zero for an empty range', async () => {
      const repo = createRepository(BASELINE_TENANT_ID);

      await expect(repo.aggregate(EMPTY_2030)).resolves.toEqual({
        grossSalesCents: 0,
        netSalesCents: 0,
        collectedCents: 0,
        outstandingDebtCents: 0,
        saleCount: 0,
        averageTicketCents: 0,
        settledRefundsCents: 0,
        pendingRefundObligationsCents: 0,
      });
    });
  },
);
