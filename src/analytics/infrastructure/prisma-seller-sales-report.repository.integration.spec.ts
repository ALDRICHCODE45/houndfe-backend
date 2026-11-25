/**
 * sales-history-redesign / T2 (S5–S8) — seller report against real PostgreSQL.
 *
 * The real adapter is composed with the real service so the assertions cover
 * the wire blocks: `customer` on both row sections (current name, null for
 * público en general and for a deleted customer), `topProducts` (line NET,
 * grouping by product+variant, ordering and ties, canceled/foreign exclusion),
 * `dailyTotals` (zero-fill and the Mexico City day boundary on the UTC-naive
 * `confirmedAt`) and `previousPeriod` (half-open bounds, not capped).
 * 2026 uses the standard Mexico City offset (-06:00): local midnight is 06:00Z.
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
import { SellerSalesReportService } from '../application/seller-sales-report.service';
import { PrismaSellerSalesReportRepository } from './prisma-seller-sales-report.repository';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

type PrismaLike = ConstructorParameters<typeof TenantPrismaService>[0];

interface SaleSeed {
  at: string;
  totalCents?: number;
  status?: 'CONFIRMED' | 'CANCELED';
  customerId?: string | null;
  tenantId?: string;
  sellerUserId?: string;
}

interface LineSeed {
  productId: string;
  variantId?: string | null;
  productName: string;
  variantName?: string | null;
  quantity: number;
  unitPriceCents: number;
  prePriceCentsBeforeDiscount?: number | null;
  discountAmountCents?: number | null;
  promotionId?: string | null;
  rewardKind?: 'BUY_X_GET_Y' | 'ADVANCED' | null;
  createdAt?: string;
}

describeIfDb(
  'PrismaSellerSalesReportRepository + SellerSalesReportService (Integration - Real DB)',
  () => {
    let prisma: PrismaClient;
    let userId: string;
    let sellerId: string;

    beforeAll(async () => {
      prisma = new PrismaClient();
      await prisma.$connect();
    });

    beforeEach(async () => {
      await resetAndSeedBaseline();
      userId = await seedUser('cashier');
      sellerId = await seedUser('seller');
    });

    afterAll(async () => {
      await resetAndSeedBaseline();
      await prisma.$disconnect();
      await disconnectIntegrationPrisma();
    });

    function serviceFor(tenantId: string) {
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
        prisma as unknown as PrismaLike,
        cls,
      );
      return new SellerSalesReportService(
        new PrismaSellerSalesReportRepository(tenantPrisma),
      );
    }

    const report = (from: string, to: string, tenantId = BASELINE_TENANT_ID) =>
      serviceFor(tenantId).getSellerReport(sellerId, { from, to });

    async function seedUser(label: string): Promise<string> {
      const id = randomUUID();
      await prisma.user.create({
        data: {
          id,
          email: `seller-report-${label}-${id}@test.local`,
          hashedPassword: 'test',
          name: `Usuario ${label}`,
          isActive: true,
        },
      });
      return id;
    }

    async function seedTenant(): Promise<string> {
      const id = randomUUID();
      await prisma.tenant.create({
        data: { id, name: 'Foreign Branch', slug: `foreign-${id}` },
      });
      return id;
    }

    async function seedCustomer(
      firstName: string,
      lastName: string | null,
      tenantId = BASELINE_TENANT_ID,
    ): Promise<string> {
      const customer = await prisma.customer.create({
        data: { tenantId, firstName, lastName },
      });
      return customer.id;
    }

    async function seedProduct(
      name: string,
      id: string = randomUUID(),
      tenantId = BASELINE_TENANT_ID,
    ): Promise<string> {
      await prisma.product.create({
        data: { id, tenantId, name, useStock: false },
      });
      return id;
    }

    async function seedVariant(productId: string, name: string) {
      const variant = await prisma.variant.create({
        data: { productId, name, tenantId: BASELINE_TENANT_ID },
      });
      return variant.id;
    }

    async function seedSale(seed: SaleSeed, lines: LineSeed[] = []) {
      const status = seed.status ?? 'CONFIRMED';
      const tenantId = seed.tenantId ?? BASELINE_TENANT_ID;
      const sale = await prisma.sale.create({
        data: {
          tenantId,
          userId,
          sellerUserId: seed.sellerUserId ?? sellerId,
          customerId: seed.customerId ?? null,
          status,
          totalCents: seed.totalCents ?? 1_000,
          paidCents: seed.totalCents ?? 1_000,
          paymentStatus: 'PAID',
          confirmedAt: new Date(seed.at),
          canceledAt: status === 'CANCELED' ? new Date(seed.at) : null,
        },
      });
      for (const line of lines) {
        await prisma.saleItem.create({
          data: {
            tenantId,
            saleId: sale.id,
            productId: line.productId,
            variantId: line.variantId ?? null,
            productName: line.productName,
            variantName: line.variantName ?? null,
            quantity: line.quantity,
            unitPriceCents: line.unitPriceCents,
            prePriceCentsBeforeDiscount:
              line.prePriceCentsBeforeDiscount ?? null,
            discountAmountCents: line.discountAmountCents ?? null,
            promotionId: line.promotionId ?? null,
            rewardKind: line.rewardKind ?? null,
            createdAt: line.createdAt ? new Date(line.createdAt) : undefined,
          },
        });
      }
      return sale.id;
    }

    it('projects the current customer {id,name} on both sections; null for público en general and deleted customers', async () => {
      const ana = await seedCustomer('Ana', 'López');
      const beto = await seedCustomer('Beto', null);
      const gone = await seedCustomer('Carla', 'Borrada');
      const confirmedAna = await seedSale({
        at: '2026-01-02T12:00:00.000Z',
        customerId: ana,
      });
      const confirmedBeto = await seedSale({
        at: '2026-01-02T13:00:00.000Z',
        customerId: beto,
      });
      const confirmedNone = await seedSale({ at: '2026-01-02T14:00:00.000Z' });
      const confirmedGone = await seedSale({
        at: '2026-01-02T15:00:00.000Z',
        customerId: gone,
      });
      const canceledAna = await seedSale({
        at: '2026-01-02T16:00:00.000Z',
        status: 'CANCELED',
        customerId: ana,
      });
      const canceledNone = await seedSale({
        at: '2026-01-02T17:00:00.000Z',
        status: 'CANCELED',
      });
      // Current name (no snapshot) and hard delete → SetNull on the sale.
      await prisma.customer.update({
        where: { id: ana },
        data: { firstName: 'Ana María' },
      });
      await prisma.customer.delete({ where: { id: gone } });

      const result = await report('2026-01-01', '2026-01-04');

      expect(
        result.confirmed.rows.map((r) => [r.id, r.customer] as const),
      ).toEqual([
        [confirmedAna, { id: ana, name: 'Ana María López' }],
        [confirmedBeto, { id: beto, name: 'Beto' }],
        [confirmedNone, null],
        [confirmedGone, null],
      ]);
      expect(
        result.canceled.rows.map((r) => [r.id, r.customer] as const),
      ).toEqual([
        [canceledAna, { id: ana, name: 'Ana María López' }],
        [canceledNone, null],
      ]);
    });

    it('ranks top products by quantity, then line NET, then productId; groups variants; excludes canceled, out-of-range, other sellers and tenants', async () => {
      const promotion = await prisma.promotion.create({
        data: {
          tenantId: BASELINE_TENANT_ID,
          title: '3x2',
          type: 'BUY_X_GET_Y',
          method: 'AUTOMATIC',
        },
      });
      const croquetas = await seedProduct('Croquetas');
      const arena = await seedProduct('Arena');
      const arena2kg = await seedVariant(arena, '2 kg');
      const arena5kg = await seedVariant(arena, '5 kg');
      const juguete = await seedProduct('Juguete');
      const tieLow = await seedProduct(
        'Collar A',
        '0aaaaaaa-0000-4000-8000-000000000000',
      );
      const tieHigh = await seedProduct(
        'Collar B',
        '0bbbbbbb-0000-4000-8000-000000000000',
      );
      const canceledOnly = await seedProduct('Cancelado');
      const outOfRange = await seedProduct('Fuera de rango');
      const otherSeller = await seedProduct('Otro vendedor');

      // Order-level discount: the sale total (1) is far below the line sum and
      // is never distributed to the lines.
      await seedSale({ at: '2026-01-02T12:00:00.000Z', totalCents: 1 }, [
        {
          productId: croquetas,
          productName: 'Croquetas viejas',
          quantity: 2,
          unitPriceCents: 1_000,
          createdAt: '2026-01-02T12:00:00.000Z',
        },
        // Per-unit line discount is already baked into unitPriceCents.
        {
          productId: arena,
          variantId: arena2kg,
          productName: 'Arena',
          variantName: '2 kg',
          quantity: 2,
          unitPriceCents: 400,
          prePriceCentsBeforeDiscount: 500,
          discountAmountCents: 100,
        },
        {
          productId: arena,
          variantId: arena5kg,
          productName: 'Arena',
          variantName: '5 kg',
          quantity: 5,
          unitPriceCents: 100,
        },
        {
          productId: tieHigh,
          productName: 'Collar B',
          quantity: 1,
          unitPriceCents: 100,
        },
      ]);
      await seedSale({ at: '2026-01-03T12:00:00.000Z' }, [
        // Most recent line in the period names the product.
        {
          productId: croquetas,
          productName: 'Croquetas Premium',
          quantity: 1,
          unitPriceCents: 1_000,
        },
        // BXGY whole-line reward: unit price stays full, R rides the line.
        {
          productId: juguete,
          productName: 'Juguete',
          quantity: 3,
          unitPriceCents: 1_000,
          prePriceCentsBeforeDiscount: 1_000,
          discountAmountCents: 1_000,
          promotionId: promotion.id,
        },
        {
          productId: tieLow,
          productName: 'Collar A',
          quantity: 1,
          unitPriceCents: 100,
        },
      ]);
      await seedSale({ at: '2026-01-02T12:00:00.000Z', status: 'CANCELED' }, [
        {
          productId: canceledOnly,
          productName: 'Cancelado',
          quantity: 100,
          unitPriceCents: 1,
        },
      ]);
      await seedSale({ at: '2026-01-04T06:00:00.000Z' }, [
        {
          productId: outOfRange,
          productName: 'Fuera de rango',
          quantity: 100,
          unitPriceCents: 1,
        },
      ]);
      const anotherSeller = await seedUser('other-seller');
      await seedSale(
        { at: '2026-01-02T12:00:00.000Z', sellerUserId: anotherSeller },
        [
          {
            productId: otherSeller,
            productName: 'Otro vendedor',
            quantity: 100,
            unitPriceCents: 1,
          },
        ],
      );
      const foreign = await seedTenant();
      const foreignProduct = await seedProduct('Foránea', undefined, foreign);
      await seedSale({ at: '2026-01-02T12:00:00.000Z', tenantId: foreign }, [
        {
          productId: foreignProduct,
          productName: 'Foránea',
          quantity: 100,
          unitPriceCents: 1,
        },
      ]);

      const result = await report('2026-01-01', '2026-01-04');

      expect(result.topProducts).toEqual([
        {
          productId: arena,
          variantId: arena5kg,
          productName: 'Arena',
          variantName: '5 kg',
          quantity: 5,
          netSalesCents: 500,
        },
        {
          productId: croquetas,
          variantId: null,
          productName: 'Croquetas Premium',
          variantName: null,
          quantity: 3,
          netSalesCents: 3_000,
        },
        {
          productId: juguete,
          variantId: null,
          productName: 'Juguete',
          variantName: null,
          quantity: 3,
          netSalesCents: 2_000,
        },
        {
          productId: arena,
          variantId: arena2kg,
          productName: 'Arena',
          variantName: '2 kg',
          quantity: 2,
          netSalesCents: 800,
        },
        // Full tie (1 unit, 100 cents): the lower productId wins the 5th slot.
        {
          productId: tieLow,
          variantId: null,
          productName: 'Collar A',
          variantName: null,
          quantity: 1,
          netSalesCents: 100,
        },
      ]);
      const topNet = result.topProducts.reduce(
        (sum, p) => sum + p.netSalesCents,
        0,
      );
      expect(topNet).toBeGreaterThan(result.confirmed.summary.netSalesCents);
      // The foreign tenant only sees its own line.
      const foreignResult = await report('2026-01-01', '2026-01-04', foreign);
      expect(foreignResult.topProducts.map((p) => p.productId)).toEqual([
        foreignProduct,
      ]);
    });

    it('zero-fills dailyTotals per Mexico City day and agrees with confirmed.summary', async () => {
      await seedSale({ at: '2026-01-01T06:00:00.000Z', totalCents: 100 });
      // Local 2026-01-01 23:59:59.999 → still day 1.
      await seedSale({ at: '2026-01-02T05:59:59.999Z', totalCents: 20 });
      // Local midnight of day 2.
      await seedSale({ at: '2026-01-02T06:00:00.000Z', totalCents: 4_000 });
      // Excluded: before from, at the exclusive to, canceled.
      await seedSale({ at: '2026-01-01T05:59:59.999Z', totalCents: 9_000 });
      await seedSale({ at: '2026-01-04T06:00:00.000Z', totalCents: 8_000 });
      await seedSale({
        at: '2026-01-03T12:00:00.000Z',
        totalCents: 7_000,
        status: 'CANCELED',
      });

      const result = await report('2026-01-01', '2026-01-04');

      expect(result.dailyTotals).toEqual([
        { date: '2026-01-01', saleCount: 2, netSalesCents: 120 },
        { date: '2026-01-02', saleCount: 1, netSalesCents: 4_000 },
        { date: '2026-01-03', saleCount: 0, netSalesCents: 0 },
      ]);
      expect(result.confirmed.summary).toMatchObject({
        saleCount: 3,
        netSalesCents: 4_120,
      });
    });

    it('aggregates previousPeriod over the same number of days ending at from, half-open and tenant-scoped', async () => {
      // Current [2026-01-11, 2026-01-14) → previous [2026-01-08, 2026-01-11).
      await seedSale({ at: '2026-01-08T06:00:00.000Z', totalCents: 100 });
      await seedSale({ at: '2026-01-11T05:59:59.999Z', totalCents: 20 });
      // Excluded from previous: before its from, at its to (= current from),
      // canceled, other tenant.
      await seedSale({ at: '2026-01-08T05:59:59.999Z', totalCents: 9_000 });
      await seedSale({ at: '2026-01-11T06:00:00.000Z', totalCents: 4_000 });
      await seedSale({
        at: '2026-01-09T12:00:00.000Z',
        totalCents: 7_000,
        status: 'CANCELED',
      });
      const foreign = await seedTenant();
      await seedSale({
        at: '2026-01-09T12:00:00.000Z',
        totalCents: 6_000,
        tenantId: foreign,
      });

      const result = await report('2026-01-11', '2026-01-14');

      expect(result.previousPeriod).toEqual({
        from: '2026-01-08',
        to: '2026-01-11',
        saleCount: 2,
        netSalesCents: 120,
      });
      expect(result.confirmed.summary.saleCount).toBe(1);
      const foreignResult = await report('2026-01-11', '2026-01-14', foreign);
      expect(foreignResult.previousPeriod).toMatchObject({
        saleCount: 1,
        netSalesCents: 6_000,
      });
    });

    it('subtracts discountAmountCents only on whole-line reward lines, never twice on per-unit promo lines', async () => {
      const promotion = await prisma.promotion.create({
        data: {
          tenantId: BASELINE_TENANT_ID,
          title: 'Promo',
          type: 'BUY_X_GET_Y',
          method: 'AUTOMATIC',
        },
      });
      const perUnit = await seedProduct('Descuento por unidad');
      const bxgy = await seedProduct('3x2');
      const advanced = await seedProduct('Avanzada');
      await seedSale({ at: '2026-01-02T12:00:00.000Z' }, [
        // Per-unit promo: the discount is already baked into unitPriceCents
        // (800 < 1000), so the line net is 800 × 4 and discountAmountCents
        // must NOT be subtracted again (3,000 would be the double discount).
        {
          productId: perUnit,
          productName: 'Descuento por unidad',
          quantity: 4,
          unitPriceCents: 800,
          prePriceCentsBeforeDiscount: 1_000,
          discountAmountCents: 200,
          promotionId: promotion.id,
        },
        // BUY_X_GET_Y whole-line reward: unit price stays full (= prePrice)
        // and the reward rides discountAmountCents: 1,000 × 3 − 1,000.
        {
          productId: bxgy,
          productName: '3x2',
          quantity: 3,
          unitPriceCents: 1_000,
          prePriceCentsBeforeDiscount: 1_000,
          discountAmountCents: 1_000,
          promotionId: promotion.id,
          rewardKind: 'BUY_X_GET_Y',
        },
        // ADVANCED whole-line reward, same shape: 750 × 2 − 500.
        {
          productId: advanced,
          productName: 'Avanzada',
          quantity: 2,
          unitPriceCents: 750,
          prePriceCentsBeforeDiscount: 750,
          discountAmountCents: 500,
          promotionId: promotion.id,
          rewardKind: 'ADVANCED',
        },
      ]);

      const result = await report('2026-01-01', '2026-01-04');

      expect(
        result.topProducts.map((p) => [
          p.productId,
          p.quantity,
          p.netSalesCents,
        ]),
      ).toEqual([
        [perUnit, 4, 3_200],
        [bxgy, 3, 2_000],
        [advanced, 2, 1_000],
      ]);
    });

    it('does not apply the row cap to previousPeriod (aggregate only)', async () => {
      await prisma.sale.createMany({
        data: Array.from({ length: 1_001 }, () => ({
          tenantId: BASELINE_TENANT_ID,
          userId,
          sellerUserId: sellerId,
          status: 'CONFIRMED' as const,
          totalCents: 1,
          paidCents: 1,
          paymentStatus: 'PAID' as const,
          confirmedAt: new Date('2026-01-05T12:00:00.000Z'),
        })),
      });

      const result = await report('2026-01-11', '2026-01-21');

      expect(result.rowCount).toBe(0);
      expect(result.previousPeriod).toEqual({
        from: '2026-01-01',
        to: '2026-01-11',
        saleCount: 1_001,
        netSalesCents: 1_001,
      });
    });
  },
);
