/**
 * INTEGRATION SPEC: PrismaSaleRepository pending refund reads —
 * pending-refund-obligations / prf-2.
 *
 * Proves the tenant-scoped read contract that the later
 * `GET /sales/refunds/pending` slice builds on, against the real
 * `nest-practice-test` database (port 5433 — NEVER the dev DB):
 *
 *   1. Tenant isolation — the caller sees ONLY its own PENDING
 *      `SaleRefund` rows; a second tenant's refunds are invisible to both
 *      the page query and the pagination count.
 *   2. Pending-only filtering — every returned row carries
 *      `status: 'PENDING'`.
 *   3. Oldest-first deterministic ordering with an id-ascending tie-break.
 *   4. Bounded offset pagination — `page`/`limit` slices concatenate to
 *      the full ordered set and the count matches the source page.
 *
 * Mirrors the `prisma-sale.repository.markSaleDelivered.integration.spec.ts`
 * setup: shared Prisma client + CLS shim + `resetAndSeedBaseline()` in
 * `afterEach` so a mid-test failure cannot leak rows into the next spec.
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
import { PrismaSaleRepository } from './prisma-sale.repository';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

interface SeedRefund {
  id: string;
  createdAt: Date;
  amountCents: number;
  settledCents?: number;
}

describeIfDb(
  'PrismaSaleRepository pending refunds (Integration - Real DB)',
  () => {
    let prisma: PrismaClient;
    let repo: PrismaSaleRepository;
    let tenantId: string;

    beforeAll(async () => {
      prisma = new PrismaClient();
      await prisma.$connect();

      // Wipe state from any previous run, then re-seed the baseline tenant
      // (globalSetup already applied migrations + seeded it at suite boot).
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
      // Robust cascade reset — wipes sales/users/tenants and re-seeds the
      // baseline tenant so the next test starts from a clean slate.
      await resetAndSeedBaseline();
    });

    afterAll(async () => {
      await prisma.$disconnect();
      await disconnectIntegrationPrisma();
    });

    /** Seed a cashier user + a CONFIRMED sale for the given tenant. */
    async function seedSale(
      targetTenantId: string,
    ): Promise<{ saleId: string }> {
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
      const saleId = randomUUID();
      await prisma.sale.create({
        data: {
          id: saleId,
          userId,
          tenantId: targetTenantId,
          status: 'CONFIRMED',
          channel: 'ONLINE',
        },
      });
      return { saleId };
    }

    /** Create a tenant outside the baseline so cross-tenant reads are testable. */
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

    /** Persist PENDING refunds for one guaranteed-owned sale. */
    async function seedPendingRefunds(
      targetTenantId: string,
      refunds: SeedRefund[],
    ): Promise<{ saleId: string }> {
      const { saleId } = await seedSale(targetTenantId);
      await prisma.saleRefund.createMany({
        data: refunds.map((refund, index) => ({
          id: refund.id,
          tenantId: targetTenantId,
          saleId,
          salePaymentId: null,
          method: index % 2 === 0 ? 'CASH' : 'CARD_CREDIT',
          amountCents: refund.amountCents,
          settledCents: refund.settledCents ?? 0,
          reason: 'CUSTOMER_REQUEST' as const,
          status: 'PENDING' as const,
          createdAt: refund.createdAt,
        })),
      });
      return { saleId };
    }

    // Own-tenant refunds (5); two share a `createdAt` on the id-ascending tie-break.
    const OWN_REFUNDS: SeedRefund[] = [
      {
        id: 'refund-a1',
        createdAt: new Date('2026-07-05T10:00:00.000Z'),
        amountCents: 100,
        settledCents: 40,
      },
      {
        id: 'refund-a2',
        createdAt: new Date('2026-07-06T10:00:00.000Z'),
        amountCents: 200,
      },
      {
        id: 'refund-a3',
        createdAt: new Date('2026-07-05T10:00:00.000Z'),
        amountCents: 300,
      },
      {
        id: 'refund-a4',
        createdAt: new Date('2026-07-07T10:00:00.000Z'),
        amountCents: 400,
      },
      {
        id: 'refund-a5',
        createdAt: new Date('2026-07-02T10:00:00.000Z'),
        amountCents: 500,
        settledCents: 500,
      },
    ];

    // Foreign tenant refunds (3) with newer timestamps: if isolation
    // regressed, they would outrank the own-tenant page.
    const FOREIGN_REFUNDS: SeedRefund[] = [
      {
        id: 'refund-f1',
        createdAt: new Date('2026-07-09T10:00:00.000Z'),
        amountCents: 900,
      },
      {
        id: 'refund-f2',
        createdAt: new Date('2026-07-08T10:00:00.000Z'),
        amountCents: 800,
      },
      {
        id: 'refund-f3',
        createdAt: new Date('2026-07-07T10:00:00.000Z'),
        amountCents: 700,
      },
    ];

    const OWN_ORDER = [
      'refund-a1',
      'refund-a3',
      'refund-a2',
      'refund-a4', // oldest-first; `refund-a5` is fully settled and absent.
    ];

    it('returns only the caller tenant PENDING refunds in deterministic order', async () => {
      const { saleId } = await seedPendingRefunds(tenantId, OWN_REFUNDS);
      const foreignTenantId = await seedForeignTenant();
      await seedPendingRefunds(foreignTenantId, FOREIGN_REFUNDS);

      const rows = await repo.findManyPendingRefunds({ page: 1, limit: 10 });

      expect(rows.map((row) => row.id)).toEqual(OWN_ORDER);
      expect(rows.every((row) => row.status === 'PENDING')).toBe(true);
      // No nested relation leaks a foreign row either.
      expect(rows.some((row) => row.id.startsWith('refund-f'))).toBe(false);
      // Minimal projection + domain method mapping on a real row.
      expect(rows[0]).toMatchObject({
        id: 'refund-a1',
        saleId,
        method: 'cash',
        amountCents: 100,
        settledCents: 40,
        outstandingCents: 60,
        reason: 'CUSTOMER_REQUEST',
        status: 'PENDING',
        createdAt: new Date('2026-07-05T10:00:00.000Z'),
      });
    });

    it('paginates the caller tenant page without duplicates or gaps', async () => {
      await seedPendingRefunds(tenantId, OWN_REFUNDS);
      const foreignTenantId = await seedForeignTenant();
      await seedPendingRefunds(foreignTenantId, FOREIGN_REFUNDS);

      const first = await repo.findManyPendingRefunds({ page: 1, limit: 2 });
      const second = await repo.findManyPendingRefunds({ page: 2, limit: 2 });
      const third = await repo.findManyPendingRefunds({ page: 3, limit: 2 });
      const beyond = await repo.findManyPendingRefunds({ page: 4, limit: 2 });

      expect(first.map((row) => row.id)).toEqual(['refund-a1', 'refund-a3']);
      expect([...first, ...second, ...third].map((row) => row.id)).toEqual(
        OWN_ORDER,
      );
      expect(beyond).toEqual([]);
    });

    it('counts only the caller tenant PENDING refunds', async () => {
      await seedPendingRefunds(tenantId, OWN_REFUNDS);
      const foreignTenantId = await seedForeignTenant();
      await seedPendingRefunds(foreignTenantId, FOREIGN_REFUNDS);

      await expect(repo.countPendingRefunds()).resolves.toBe(OWN_ORDER.length);
    });

    it('returns an empty page and a zero count when the tenant has no refunds', async () => {
      const foreignTenantId = await seedForeignTenant();
      await seedPendingRefunds(foreignTenantId, FOREIGN_REFUNDS);

      await expect(
        repo.findManyPendingRefunds({ page: 1, limit: 10 }),
      ).resolves.toEqual([]);
      await expect(repo.countPendingRefunds()).resolves.toBe(0);
    });
  },
);
