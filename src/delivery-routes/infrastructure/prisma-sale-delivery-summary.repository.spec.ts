/**
 * ADAPTER UNIT SPEC: PrismaSaleDeliverySummaryRepository.findConfirmedDeliveredSummary
 * — delivery-routes / DTE-2.
 *
 * The adapter splits its guarantees across two seams, and this spec pins
 * each at the seam where it actually holds:
 *
 *   - QUERY-driven (asserted on the exact `findFirst` arguments): the
 *     tenant + confirmed/delivered predicate, the per-line `tenantId`
 *     discriminator, deterministic line ordering, and the deliberate
 *     absence of `customer.email`. The adapter delegates these to Prisma,
 *     so an explicit argument assertion is the honest proof; a fake that
 *     re-implemented Prisma filtering would only test the fake.
 *   - CODE-driven (asserted on the returned view model): the item and
 *     customer tenant post-checks, the empty-line fail-closed guard, and
 *     the persisted money mapping (reward / coupon / legacy shapes).
 *
 * The `PrismaService` mock is a plain `jest.fn()` injected through
 * `Test.createTestingModule`, so no `as any` / `as unknown as` cast is
 * needed anywhere in this file.
 *
 * Scope note: source-level, in-memory behavior only. No PostgreSQL
 * row-level filtering, FK behavior, HTTP path, or real email delivery is
 * exercised or claimed here; `pnpm test` never reaches a database.
 */
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { SaleDeliverySummaryItem } from '../domain/ports/sale-delivery-summary.port';
import { PrismaSaleDeliverySummaryRepository } from './prisma-sale-delivery-summary.repository';

const TENANT_ID = 'tenant-1';
const OTHER_TENANT_ID = 'tenant-2';
const SALE_ID = 'sale-1';
const INPUT = { tenantId: TENANT_ID, saleId: SALE_ID };

// ── Persisted-row shapes the adapter reads ─────────────────────────────

type PersistedRewardKind = 'BUY_X_GET_Y' | 'ADVANCED' | null;

type ItemRow = {
  tenantId: string;
  productName: string;
  variantName: string | null;
  quantity: number;
  unitPriceCents: number;
  discountAmountCents: number | null;
  discountTitle: string | null;
  prePriceCentsBeforeDiscount: number | null;
  promotionId: string | null;
  rewardKind: PersistedRewardKind;
};

type CustomerRow = {
  tenantId: string;
  firstName: string;
  lastName: string | null;
};

type SaleSummaryRow = {
  id: string;
  folio: string | null;
  confirmedAt: Date | null;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  customer: CustomerRow | null;
  items: ItemRow[];
};

/** Shape of the single Prisma call this adapter is allowed to make. */
type SaleFindArgs = {
  where: {
    id: string;
    tenantId: string;
    status: string;
    deliveryStatus: string;
  };
  select: {
    id: true;
    folio: true;
    confirmedAt: true;
    subtotalCents: true;
    discountCents: true;
    totalCents: true;
    customer: { select: Record<string, true> };
    items: {
      select: Record<string, true>;
      orderBy: Array<Record<string, 'asc' | 'desc'>>;
    };
  };
};

// ── Mock + fixtures ────────────────────────────────────────────────────

async function createReader() {
  const saleFindFirst = jest.fn<Promise<unknown>, [SaleFindArgs]>();
  const moduleRef = await Test.createTestingModule({
    providers: [
      PrismaSaleDeliverySummaryRepository,
      {
        provide: PrismaService,
        useValue: { sale: { findFirst: saleFindFirst } },
      },
    ],
  }).compile();
  return {
    reader: moduleRef.get(PrismaSaleDeliverySummaryRepository),
    saleFindFirst,
  };
}

function makeItem(overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    tenantId: TENANT_ID,
    productName: 'Café molido',
    variantName: '500 g',
    quantity: 2,
    unitPriceCents: 15000,
    discountAmountCents: null,
    discountTitle: null,
    prePriceCentsBeforeDiscount: null,
    promotionId: null,
    rewardKind: null,
    ...overrides,
  };
}

function makeRow(overrides: Partial<SaleSummaryRow> = {}): SaleSummaryRow {
  return {
    id: SALE_ID,
    folio: 'A-001',
    confirmedAt: new Date('2026-02-01T12:00:00.000Z'),
    subtotalCents: 30000,
    discountCents: 0,
    totalCents: 30000,
    customer: { tenantId: TENANT_ID, firstName: 'Ana', lastName: 'López' },
    items: [makeItem()],
    ...overrides,
  };
}

// ── Specs ──────────────────────────────────────────────────────────────

describe('PrismaSaleDeliverySummaryRepository.findConfirmedDeliveredSummary', () => {
  describe('query contract', () => {
    it('restricts the read to the caller tenant and to confirmed+delivered sales, skipping cancelled and undelivered rows', async () => {
      const { reader, saleFindFirst } = await createReader();
      saleFindFirst.mockResolvedValue(makeRow());

      await reader.findConfirmedDeliveredSummary(INPUT);

      expect(saleFindFirst).toHaveBeenCalledTimes(1);
      expect(saleFindFirst.mock.calls[0][0].where).toEqual({
        id: SALE_ID,
        tenantId: TENANT_ID,
        status: 'CONFIRMED',
        deliveryStatus: 'DELIVERED',
      });
    });

    it('projects the persisted line fields with point tenant data and deterministic ordering', async () => {
      const { reader, saleFindFirst } = await createReader();
      saleFindFirst.mockResolvedValue(makeRow());

      await reader.findConfirmedDeliveredSummary(INPUT);

      expect(saleFindFirst.mock.calls[0][0].select.items.select).toEqual({
        tenantId: true,
        productName: true,
        variantName: true,
        quantity: true,
        unitPriceCents: true,
        discountAmountCents: true,
        discountTitle: true,
        prePriceCentsBeforeDiscount: true,
        promotionId: true,
        rewardKind: true,
      });
      expect(saleFindFirst.mock.calls[0][0].select.items.orderBy).toEqual([
        { createdAt: 'asc' },
        { id: 'asc' },
      ]);
      // A nested filter would silently hide a foreign-tenant line before
      // the post-read ownership check can reject the entire summary.
      expect(saleFindFirst.mock.calls[0][0].select.items).not.toHaveProperty(
        'where',
      );
    });

    it('never asks Prisma for the customer email (authoritative lookup stays separate)', async () => {
      const { reader, saleFindFirst } = await createReader();
      saleFindFirst.mockResolvedValue(makeRow());

      await reader.findConfirmedDeliveredSummary(INPUT);

      const customerSelect =
        saleFindFirst.mock.calls[0][0].select.customer.select;
      expect(Object.keys(customerSelect).sort()).toEqual([
        'firstName',
        'lastName',
        'tenantId',
      ]);
      expect(customerSelect).not.toHaveProperty('email');
    });

    it.each([
      ['tenantId', { tenantId: '', saleId: SALE_ID }],
      ['saleId', { tenantId: TENANT_ID, saleId: '' }],
    ])(
      'short-circuits an empty %s without querying Prisma',
      async (_field, input) => {
        const { reader, saleFindFirst } = await createReader();

        await expect(
          reader.findConfirmedDeliveredSummary(input),
        ).resolves.toBeNull();
        expect(saleFindFirst).not.toHaveBeenCalled();
      },
    );

    it('returns null when no matching sale exists', async () => {
      const { reader, saleFindFirst } = await createReader();
      saleFindFirst.mockResolvedValue(null);

      await expect(
        reader.findConfirmedDeliveredSummary(INPUT),
      ).resolves.toBeNull();
    });
  });

  describe('post-read guards', () => {
    it.each<{ name: string; items: ItemRow[] }>([
      {
        name: 'a foreign-tenant item row',
        items: [
          makeItem({ tenantId: OTHER_TENANT_ID, productName: 'Foreign line' }),
        ],
      },
      {
        name: 'a mix of own and foreign item rows',
        items: [
          makeItem(),
          makeItem({ tenantId: OTHER_TENANT_ID, productName: 'Foreign line' }),
        ],
      },
      { name: 'zero item rows', items: [] },
    ])('fails closed to null for $name', async ({ items }) => {
      const { reader, saleFindFirst } = await createReader();
      saleFindFirst.mockResolvedValue(makeRow({ items }));

      await expect(
        reader.findConfirmedDeliveredSummary(INPUT),
      ).resolves.toBeNull();
    });

    it.each<{ name: string; customer: CustomerRow | null }>([
      { name: 'a null customer relation', customer: null },
      {
        name: 'a foreign-tenant customer',
        customer: {
          tenantId: OTHER_TENANT_ID,
          firstName: 'Foreign',
          lastName: 'Owner',
        },
      },
      {
        name: 'a blank persisted customer name',
        customer: { tenantId: TENANT_ID, firstName: '   ', lastName: null },
      },
    ])(
      'suppresses the name for $name while keeping the summary',
      async ({ customer }) => {
        const { reader, saleFindFirst } = await createReader();
        saleFindFirst.mockResolvedValue(makeRow({ customer }));

        const summary = await reader.findConfirmedDeliveredSummary(INPUT);

        expect(summary).not.toBeNull();
        expect(summary?.customerName).toBeNull();
      },
    );

    it('uses the first name only when the persisted last name is absent', async () => {
      const { reader, saleFindFirst } = await createReader();
      saleFindFirst.mockResolvedValue(
        makeRow({
          customer: { tenantId: TENANT_ID, firstName: 'Ana', lastName: null },
        }),
      );

      const summary = await reader.findConfirmedDeliveredSummary(INPUT);

      expect(summary?.customerName).toBe('Ana');
    });
  });

  describe('summary projection', () => {
    it('passes the persisted folio, confirmation date and MXN totals through verbatim', async () => {
      const confirmedAt = new Date('2026-02-01T12:00:00.000Z');
      const { reader, saleFindFirst } = await createReader();
      saleFindFirst.mockResolvedValue(
        makeRow({
          confirmedAt,
          subtotalCents: 50000,
          discountCents: 7500,
          totalCents: 42500,
        }),
      );

      const summary = await reader.findConfirmedDeliveredSummary(INPUT);

      expect(summary).toEqual({
        saleId: SALE_ID,
        folio: 'A-001',
        confirmedAt,
        currency: 'MXN',
        subtotalCents: 50000,
        discountCents: 7500,
        totalCents: 42500,
        customerName: 'Ana López',
        items: [
          {
            productName: 'Café molido',
            variantName: '500 g',
            quantity: 2,
            unitPriceCents: 15000,
            lineTotalCents: 30000,
            discountAmountCents: null,
            discountTitle: null,
            rewardKind: null,
          },
        ],
      });
    });

    it.each<{
      name: string;
      item: Partial<ItemRow>;
      expected: Partial<SaleDeliverySummaryItem>;
    }>([
      {
        name: 'a plain line',
        item: {},
        expected: {
          unitPriceCents: 15000,
          lineTotalCents: 30000,
          discountAmountCents: null,
          discountTitle: null,
          rewardKind: null,
        },
      },
      {
        name: 'a persisted BXGY reward (netted off the gross price exactly once)',
        item: {
          quantity: 2,
          unitPriceCents: 10000,
          prePriceCentsBeforeDiscount: 10000,
          promotionId: 'promo-1',
          discountAmountCents: 10000,
          discountTitle: '2x1',
          rewardKind: 'BUY_X_GET_Y',
        },
        expected: {
          unitPriceCents: 10000,
          lineTotalCents: 10000,
          discountAmountCents: 10000,
          discountTitle: '2x1',
          rewardKind: 'buy_x_get_y',
        },
      },
      {
        name: 'a persisted ADVANCED reward',
        item: {
          quantity: 2,
          unitPriceCents: 10000,
          prePriceCentsBeforeDiscount: 10000,
          promotionId: 'promo-1',
          discountAmountCents: 10000,
          rewardKind: 'ADVANCED',
        },
        expected: { lineTotalCents: 10000, rewardKind: 'advanced' },
      },
      {
        name: 'a legacy reward shape whose rewardKind column is null',
        item: {
          quantity: 1,
          unitPriceCents: 8000,
          prePriceCentsBeforeDiscount: 8000,
          promotionId: 'promo-legacy',
          discountAmountCents: 8000,
          rewardKind: null,
        },
        expected: { lineTotalCents: 0, rewardKind: 'buy_x_get_y' },
      },
      {
        name: 'an already-netted coupon line (the discount is not subtracted twice)',
        item: {
          quantity: 2,
          unitPriceCents: 9000,
          prePriceCentsBeforeDiscount: 10000,
          promotionId: null,
          discountAmountCents: 2000,
          discountTitle: 'Cupón amigo',
          rewardKind: null,
        },
        expected: {
          unitPriceCents: 9000,
          lineTotalCents: 18000,
          discountAmountCents: 2000,
          rewardKind: null,
        },
      },
      {
        name: 'a persisted reward kind with a zero discount (kind alone is not proof of a reward)',
        item: {
          quantity: 1,
          unitPriceCents: 7000,
          prePriceCentsBeforeDiscount: 7000,
          promotionId: 'promo-zero',
          discountAmountCents: 0,
          rewardKind: 'BUY_X_GET_Y',
        },
        expected: {
          lineTotalCents: 7000,
          discountAmountCents: 0,
          rewardKind: 'buy_x_get_y',
        },
      },
      {
        name: 'a reward-shaped zero-discount line with no persisted kind',
        item: {
          quantity: 1,
          unitPriceCents: 7000,
          prePriceCentsBeforeDiscount: 7000,
          promotionId: 'promo-zero',
          discountAmountCents: 0,
          rewardKind: null,
        },
        expected: {
          lineTotalCents: 7000,
          discountAmountCents: 0,
          rewardKind: null,
        },
      },
    ])('maps $name', async ({ item, expected }) => {
      const { reader, saleFindFirst } = await createReader();
      saleFindFirst.mockResolvedValue(makeRow({ items: [makeItem(item)] }));

      const summary = await reader.findConfirmedDeliveredSummary(INPUT);

      expect(summary?.items[0]).toMatchObject(expected);
    });
  });
});
