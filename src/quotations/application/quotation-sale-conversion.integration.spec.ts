/**
 * Quotation ↔ sale conversion — PostgreSQL integration (T1 / S2-S7).
 *
 * Real adapters (PrismaQuotationRepository, PrismaSaleRepository, the
 * conversion store, ProductsService catalog/stock reads, SalesService and
 * QuotationsService recompute pipelines) against the guarded integration
 * test database. Only the promotion engine, mailer and sale side-effect
 * ports are deterministic stubs.
 *
 * Every test owns a fresh tenant (no truncation of shared rows), so the
 * spec is safe next to other suites on the shared test DB.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { ClsService } from 'nestjs-cls';

import type { PrismaService } from '../../shared/prisma/prisma.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { normalizeTestDatabaseUrl } from '../../../test/integration/setup/test-database-url';
import { PrismaQuotationRepository } from '../infrastructure/prisma-quotation.repository';
import { PrismaQuotationSaleConversionStore } from '../infrastructure/prisma-quotation-sale-conversion.store';
import { QuotationsService } from './quotations.service';
import { QuotationSaleConversionService } from './quotation-sale-conversion.service';
import { PrismaSaleRepository } from '../../sales/infrastructure/prisma-sale.repository';
import { SalesService } from '../../sales/sales.service';
import { ProductsService } from '../../products/products.service';
import type {
  IPosEvaluatePromotionsUseCase,
  PosEvalInput,
  PosEvalResult,
} from '../../promotions/application/ports/pos-evaluate-promotions.port';
import type { BusinessRuleViolationError } from '../../shared/domain/domain-error';

const describeDb =
  process.env.SKIP_DB_INTEGRATION === '1' ? describe.skip : describe;

const PROMO_DISCOUNT_CENTS = 500;
const ORDER_DISCOUNT_CENTS = 1_000;

describeDb('Quotation ↔ sale conversion (PostgreSQL)', () => {
  let db: PrismaClient;
  let cls: ClsService<TenantClsStore>;
  let tenantPrisma: TenantPrismaService;
  let conversion: QuotationSaleConversionService;
  let quotations: QuotationsService;
  let saleRepo: PrismaSaleRepository;
  let quotationRepo: PrismaQuotationRepository;
  let sales: SalesService;
  let promoId: string;
  /** AUTOMATIC ORDER_DISCOUNT promotion (only evaluated when active). */
  let orderPromoId: string;
  let orderPromoActive = false;
  const ownedTenants: string[] = [];

  /**
   * Deterministic engine: a per-unit $5.00 discount on any line whose
   * product is the fixture's promo product, unless vetoed or the line
   * carries a manual discount, plus (when `orderPromoActive`) an AUTOMATIC
   * $10.00 order discount unless vetoed. Same behavior for SALE and
   * QUOTATION. Like the real engine, only MANUAL opt-ins are targetable
   * (both fixture promotions are AUTOMATIC).
   */
  let promoProductIds = new Set<string>();
  const automaticIds = () => new Set([promoId, orderPromoId]);
  const engine: IPosEvaluatePromotionsUseCase = {
    evaluate: async (input: PosEvalInput): Promise<PosEvalResult> => ({
      lines: input.lines
        .filter(
          (line) =>
            promoProductIds.has(line.productId) &&
            !line.hasManualDiscount &&
            !input.vetoedPromotionIds.includes(promoId),
        )
        .map((line) => ({
          kind: 'per-unit' as const,
          itemId: line.itemId,
          promotionId: promoId,
          discountType: 'amount' as const,
          discountValue: PROMO_DISCOUNT_CENTS,
          discountTitle: 'Promo test',
        })),
      order:
        orderPromoActive && !input.vetoedPromotionIds.includes(orderPromoId)
          ? {
              promotionId: orderPromoId,
              discountType: 'amount' as const,
              discountValue: ORDER_DISCOUNT_CENTS,
              discountAmountCents: ORDER_DISCOUNT_CENTS,
              discountTitle: 'Orden auto',
            }
          : null,
      availableManualPromotions: [],
      targetableManualPromotionIds: input.optedInManualPromotionIds.filter(
        (id) => !automaticIds().has(id),
      ),
      promotionCapacityDemands: [],
      capacityExcludedPromotionIds: [],
    }),
  };

  beforeAll(() => {
    normalizeTestDatabaseUrl(process.env.DATABASE_URL, '[quotation-sale]');
    db = new PrismaClient();
    cls = new ClsService<TenantClsStore>(new AsyncLocalStorage());
    // SAFETY: TenantPrismaService only needs the root Prisma client API
    // ($transaction / $extends / model delegates), not Nest lifecycle hooks.
    tenantPrisma = new TenantPrismaService(db as PrismaService, cls);

    // SAFETY: the conversion only calls catalog/stock/price reads that run
    // through `tenantPrisma` and `stockJournal.expiredLotQuantity`; the other
    // constructor collaborators are never touched by those methods.
    const products = new ProductsService(
      undefined as never,
      db as PrismaService,
      undefined as never,
      tenantPrisma,
      undefined as never,
      { expiredLotQuantity: async () => 0 } as never,
    );
    quotationRepo = new PrismaQuotationRepository(tenantPrisma);
    saleRepo = new PrismaSaleRepository(tenantPrisma);
    quotations = new QuotationsService(
      quotationRepo,
      tenantPrisma,
      products,
      engine,
      { send: async () => undefined } as never,
    );
    sales = new SalesService(
      saleRepo,
      products,
      { emit: () => true } as never,
      undefined as never,
      tenantPrisma,
      undefined,
      engine,
      undefined as never,
      undefined as never,
    );
    conversion = new QuotationSaleConversionService(
      tenantPrisma,
      quotationRepo,
      saleRepo,
      quotations,
      sales,
      products,
      new PrismaQuotationSaleConversionStore(tenantPrisma),
    );
  });

  afterAll(async () => {
    for (const tenantId of ownedTenants) {
      await db.quotation.deleteMany({ where: { tenantId } });
      await db.tenant.deleteMany({ where: { id: tenantId } });
    }
    await db.$disconnect();
  });

  // ── Fixture ───────────────────────────────────────────────────────

  async function fixture() {
    const tenantId = randomUUID();
    const cashierId = randomUUID();
    const sellerId = randomUUID();
    const otherCashierId = randomUUID();
    ownedTenants.push(tenantId);
    await db.tenant.create({
      data: { id: tenantId, name: 'Quotation↔sale proof', slug: tenantId },
    });
    for (const [id, name] of [
      [cashierId, 'Cajero'],
      [sellerId, 'Vendedora'],
      [otherCashierId, 'Otro cajero'],
    ]) {
      await db.user.create({
        data: {
          id,
          name,
          email: `${id}@quotation-sale.invalid`,
          hashedPassword: 'not-a-login-hash',
        },
      });
    }
    const customer = await db.customer.create({
      data: { tenantId, firstName: 'María', lastName: 'García' },
    });
    const priceList = await db.globalPriceList.create({
      data: { name: `Mayoreo ${randomUUID()}` },
    });
    const product = (name: string, extra: Record<string, unknown> = {}) =>
      db.product.create({
        data: {
          tenantId,
          name,
          useStock: true,
          quantity: 10,
          ivaRate: 'IVA_16',
          chargeProductTaxes: true,
          ...extra,
        },
      });
    const plain = await product('Playera');
    const promoted = await product('Jeans');
    promoProductIds = new Set([promoted.id]);
    const promotion = await db.promotion.create({
      data: {
        tenantId,
        title: 'Promo test',
        type: 'PRODUCT_DISCOUNT',
        method: 'AUTOMATIC',
        discountType: 'FIXED',
        discountValue: PROMO_DISCOUNT_CENTS,
      },
    });
    promoId = promotion.id;
    const orderPromotion = await db.promotion.create({
      data: {
        tenantId,
        title: 'Orden auto',
        type: 'ORDER_DISCOUNT',
        method: 'AUTOMATIC',
        discountType: 'FIXED',
        discountValue: ORDER_DISCOUNT_CENTS,
      },
    });
    orderPromoId = orderPromotion.id;
    orderPromoActive = false;
    const run = <T>(work: () => Promise<T>, tenant = tenantId): Promise<T> =>
      cls.runWith(
        { tenantId: tenant, userId: cashierId, isSuperAdmin: false },
        work,
      );
    return {
      tenantId,
      cashierId,
      sellerId,
      otherCashierId,
      customerId: customer.id,
      priceListId: priceList.id,
      plain,
      promoted,
      run,
    };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  /** POS draft sale: one custom-priced line + one promoted line + ORDER promo. */
  async function draftSale(
    f: Fixture,
    overrides: Record<string, unknown> = {},
  ) {
    const saleId = randomUUID();
    await db.sale.create({
      data: {
        id: saleId,
        tenantId: f.tenantId,
        userId: f.cashierId,
        sellerUserId: f.sellerId,
        customerId: f.customerId,
        globalPriceListId: f.priceListId,
        priceListExplicitlySet: true,
        status: 'DRAFT',
        ...overrides,
        items: {
          create: [
            {
              tenantId: f.tenantId,
              productId: f.plain.id,
              productName: 'Playera',
              quantity: 2,
              unitPriceCents: 7_500,
              priceSource: 'CUSTOM',
              customPriceCents: 7_500,
            },
            {
              tenantId: f.tenantId,
              productId: f.promoted.id,
              productName: 'Jeans',
              quantity: 1,
              unitPriceCents: 10_000 - PROMO_DISCOUNT_CENTS,
              prePriceCentsBeforeDiscount: 10_000,
              priceSource: 'DEFAULT',
              discountType: 'amount',
              discountValue: PROMO_DISCOUNT_CENTS,
              discountAmountCents: PROMO_DISCOUNT_CENTS,
              discountTitle: 'Promo test',
              promotionId: promoId,
            },
          ],
        },
      },
    });
    await db.salePromotionApplied.create({
      data: {
        tenantId: f.tenantId,
        saleId,
        promotionId: null,
        discountType: 'amount',
        discountValue: 1_000,
        discountAmountCents: 1_000,
        discountTitle: 'Orden -$10',
      },
    });
    return saleId;
  }

  /** SENT quotation with a promo-discounted line and a custom-priced line. */
  async function quotation(
    f: Fixture,
    overrides: Record<string, unknown> = {},
    lines?: Array<Record<string, unknown>>,
  ) {
    const id = randomUUID();
    await db.quotation.create({
      data: {
        id,
        tenantId: f.tenantId,
        sellerUserId: f.sellerId,
        customerId: f.customerId,
        globalPriceListId: f.priceListId,
        priceListExplicitlySet: true,
        status: 'SENT',
        subtotalCents: 2 * 10_000 + 12_345,
        discountCents: 2 * PROMO_DISCOUNT_CENTS,
        totalCents: 2 * (10_000 - PROMO_DISCOUNT_CENTS) + 12_345,
        ...overrides,
        items: {
          create: (
            lines ?? [
              {
                productId: f.promoted.id,
                productName: 'Jeans',
                quantity: 2,
                unitPriceCents: 10_000 - PROMO_DISCOUNT_CENTS,
                priceSource: 'PRICE_LIST',
                discountType: 'amount',
                discountValue: PROMO_DISCOUNT_CENTS,
                discountAmountCents: PROMO_DISCOUNT_CENTS,
                promotionId: promoId,
              },
              {
                productId: f.plain.id,
                productName: 'Playera',
                quantity: 1,
                unitPriceCents: 12_345,
                priceSource: 'CUSTOM',
                customPriceCents: 12_345,
              },
            ]
          ).map((line) => ({ tenantId: f.tenantId, ...line })),
        },
      } as never,
    });
    return id;
  }

  const codeOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (err) {
      return {
        code: (err as BusinessRuleViolationError).code,
        details: (err as BusinessRuleViolationError).details,
      };
    }
    throw new Error('expected rejection');
  };

  // ── Sale DRAFT → quotation (S2, S3) ───────────────────────────────

  describe('POST /quotations/from-sale/:saleId', () => {
    it('creates a DRAFT quotation with customer, seller, price list, lines and notes, and discards the sale', async () => {
      const f = await fixture();
      const saleId = await draftSale(f);

      const result = await f.run(() =>
        conversion.createFromSaleDraft(
          saleId,
          f.cashierId,
          { customerNotes: 'Entrega en sucursal' },
          'key-1',
        ),
      );

      expect(result.discardedSaleId).toBe(saleId);
      expect(result.quotation).toMatchObject({
        status: 'DRAFT',
        customerId: f.customerId,
        sellerUserId: f.sellerId,
        globalPriceListId: f.priceListId,
        priceListExplicitlySet: true,
        customerNotes: 'Entrega en sucursal',
        saleId: null,
      });
      const byProduct = new Map(
        result.quotation.items.map((i) => [i.productId, i]),
      );
      expect(byProduct.get(f.plain.id)).toMatchObject({
        quantity: 2,
        unitPriceCents: 7_500,
        priceSource: 'CUSTOM',
        customPriceCents: 7_500,
      });
      // The promotion is re-evaluated by the quotation engine (QUOTATION context).
      expect(byProduct.get(f.promoted.id)).toMatchObject({
        quantity: 1,
        unitPriceCents: 10_000 - PROMO_DISCOUNT_CENTS,
        discountAmountCents: PROMO_DISCOUNT_CENTS,
        promotionId: promoId,
      });
      expect(result.quotation.totalCents).toBe(
        2 * 7_500 + 10_000 - PROMO_DISCOUNT_CENTS,
      );
      // IVA-per-item snapshot is taken for every copied line.
      expect(result.quotation.ivaBreakdown).toEqual([
        { classification: 'IVA_16', amountCents: expect.any(Number) },
      ]);
      // The sale-level ORDER promotion cannot be represented → reported.
      expect(result.droppedAdjustments).toEqual([
        expect.objectContaining({
          kind: 'ORDER_PROMOTION',
          discountCents: 1_000,
          title: 'Orden -$10',
        }),
      ]);

      // S3 — the draft sale is gone (and its lines/promo rows cascade).
      expect(await db.sale.count({ where: { id: saleId } })).toBe(0);
      expect(await db.saleItem.count({ where: { saleId } })).toBe(0);
      expect(
        await db.quotation.count({ where: { tenantId: f.tenantId } }),
      ).toBe(1);
    });

    it('replays the same response for the same Idempotency-Key and rejects a reused key for another sale', async () => {
      const f = await fixture();
      const saleId = await draftSale(f);
      const first = await f.run(() =>
        conversion.createFromSaleDraft(saleId, f.cashierId, {}, 'key-1'),
      );
      const replay = await f.run(() =>
        conversion.createFromSaleDraft(saleId, f.cashierId, {}, 'key-1'),
      );
      expect(replay).toEqual(first);
      expect(
        await db.quotation.count({ where: { tenantId: f.tenantId } }),
      ).toBe(1);

      const otherSaleId = await draftSale(f);
      expect(
        await codeOf(
          f.run(() =>
            conversion.createFromSaleDraft(
              otherSaleId,
              f.cashierId,
              {},
              'key-1',
            ),
          ),
        ),
      ).toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
      expect(await db.sale.count({ where: { id: otherSaleId } })).toBe(1);
    });

    it.each([['a CONFIRMED sale', { status: 'CONFIRMED' }, 'SALE_NOT_DRAFT']])(
      'rejects %s and keeps it',
      async (_label, overrides, code) => {
        const f = await fixture();
        const saleId = await draftSale(f, overrides);
        expect(
          await codeOf(
            f.run(() =>
              conversion.createFromSaleDraft(saleId, f.cashierId, {}, 'k'),
            ),
          ),
        ).toMatchObject({ code });
        expect(await db.sale.count({ where: { id: saleId } })).toBe(1);
        expect(
          await db.quotation.count({ where: { tenantId: f.tenantId } }),
        ).toBe(0);
      },
    );

    it('rejects a draft with payments (SALE_HAS_PAYMENTS)', async () => {
      const f = await fixture();
      const saleId = await draftSale(f);
      await db.salePayment.create({
        data: {
          tenantId: f.tenantId,
          saleId,
          method: 'CASH',
          amountCents: 100,
        },
      });
      expect(
        await codeOf(
          f.run(() =>
            conversion.createFromSaleDraft(saleId, f.cashierId, {}, 'k'),
          ),
        ),
      ).toMatchObject({ code: 'SALE_HAS_PAYMENTS' });
      expect(await db.sale.count({ where: { id: saleId } })).toBe(1);
    });

    it('rejects a draft that already moved inventory (SALE_HAS_STOCK_MOVEMENTS)', async () => {
      const f = await fixture();
      const saleId = await draftSale(f);
      await db.stockMovement.create({
        data: {
          tenantId: f.tenantId,
          productId: f.plain.id,
          productName: 'Playera',
          bucketKind: 'PRODUCT_UNTRACKED',
          type: 'SALE',
          delta: -2,
          balanceAfter: 8,
          productBalanceAfter: 8,
          groupType: 'SALE',
          groupId: saleId,
          actorDisplayName: 'Cajero',
        },
      });
      expect(
        await codeOf(
          f.run(() =>
            conversion.createFromSaleDraft(saleId, f.cashierId, {}, 'k'),
          ),
        ),
      ).toMatchObject({ code: 'SALE_HAS_STOCK_MOVEMENTS' });
      expect(await db.sale.count({ where: { id: saleId } })).toBe(1);
    });

    it('rejects an empty draft (SALE_HAS_NO_ITEMS) and a draft owned by another cashier (SALE_UPDATE_FORBIDDEN)', async () => {
      const f = await fixture();
      const empty = randomUUID();
      await db.sale.create({
        data: { id: empty, tenantId: f.tenantId, userId: f.cashierId },
      });
      expect(
        await codeOf(
          f.run(() =>
            conversion.createFromSaleDraft(empty, f.cashierId, {}, 'a'),
          ),
        ),
      ).toMatchObject({ code: 'SALE_HAS_NO_ITEMS' });

      const foreignOwner = await draftSale(f, { userId: f.otherCashierId });
      expect(
        await codeOf(
          f.run(() =>
            conversion.createFromSaleDraft(foreignOwner, f.cashierId, {}, 'b'),
          ),
        ),
      ).toMatchObject({ code: 'SALE_UPDATE_FORBIDDEN' });
      expect(await db.sale.count({ where: { id: foreignOwner } })).toBe(1);
    });

    it('cannot reach a draft sale of another tenant (SALE_NOT_FOUND) and leaves it intact', async () => {
      const a = await fixture();
      const b = await fixture();
      const saleOfA = await draftSale(a);
      expect(
        await codeOf(
          b.run(() =>
            conversion.createFromSaleDraft(saleOfA, a.cashierId, {}, 'k'),
          ),
        ),
      ).toMatchObject({ code: 'SALE_NOT_FOUND' });
      expect(await db.sale.count({ where: { id: saleOfA } })).toBe(1);
      expect(
        await db.quotation.count({ where: { tenantId: b.tenantId } }),
      ).toBe(0);
    });
  });

  // ── Quotation → sale DRAFT (S4, S5, S6) ───────────────────────────

  describe('POST /quotations/:id/convert-to-sale', () => {
    it.each(['SENT', 'DRAFT'])(
      'converts a %s quotation into a DRAFT sale at the quoted prices and discounts and links both',
      async (status) => {
        const f = await fixture();
        const quotationId = await quotation(f, {
          status,
          expiresAt: new Date(Date.now() + 86_400_000),
        });

        const result = await f.run(() =>
          conversion.convertToSale(quotationId, f.cashierId, 'key-1'),
        );

        const saleId = result.sale.id;
        expect(result.quotation).toMatchObject({
          id: quotationId,
          status: 'CONVERTED_TO_SALE',
          effectiveStatus: 'CONVERTED_TO_SALE',
          saleId,
        });
        expect(result.sale).toMatchObject({
          status: 'DRAFT',
          userId: f.cashierId,
          customerId: f.customerId,
          sellerUserId: f.sellerId,
          globalPriceListId: f.priceListId,
          quotationId,
          totalCents: 2 * (10_000 - PROMO_DISCOUNT_CENTS) + 12_345,
        });
        const byProduct = new Map(
          result.sale.items.map((i) => [i.productId, i]),
        );
        expect(byProduct.get(f.promoted.id)).toMatchObject({
          quantity: 2,
          unitPriceCents: 10_000 - PROMO_DISCOUNT_CENTS,
          discountAmountCents: PROMO_DISCOUNT_CENTS,
          discountTitle: 'Promo test',
          promotionId: null,
        });
        expect(byProduct.get(f.plain.id)).toMatchObject({
          quantity: 1,
          unitPriceCents: 12_345,
        });

        // Persisted link + reads expose it on both sides (S7).
        const row = await db.quotation.findUniqueOrThrow({
          where: { id: quotationId },
        });
        expect(row).toMatchObject({
          status: 'CONVERTED_TO_SALE',
          convertedSaleId: saleId,
        });
        const quotationRead = await f.run(() =>
          quotations.findOne(quotationId),
        );
        expect(quotationRead.saleId).toBe(saleId);
        const saleRead = await f.run(() => saleRepo.findById(saleId));
        expect(saleRead?.toResponse().quotationId).toBe(quotationId);
        const persistedItems = await db.saleItem.findMany({
          where: { saleId },
        });
        expect(persistedItems).toHaveLength(2);
      },
    );

    it('replays the same sale for the same Idempotency-Key; another key gets QUOTATION_ALREADY_CONVERTED with the saleId', async () => {
      const f = await fixture();
      const quotationId = await quotation(f);
      const first = await f.run(() =>
        conversion.convertToSale(quotationId, f.cashierId, 'key-1'),
      );
      const replay = await f.run(() =>
        conversion.convertToSale(quotationId, f.cashierId, 'key-1'),
      );
      expect(replay).toEqual(first);

      expect(
        await codeOf(
          f.run(() =>
            conversion.convertToSale(quotationId, f.cashierId, 'key-2'),
          ),
        ),
      ).toEqual({
        code: 'QUOTATION_ALREADY_CONVERTED',
        details: { saleId: first.sale.id },
      });
      expect(await db.sale.count({ where: { tenantId: f.tenantId } })).toBe(1);
    });

    it('concurrent double conversion with different keys produces exactly one sale', async () => {
      const f = await fixture();
      const quotationId = await quotation(f);

      const outcomes = await Promise.allSettled(
        ['key-a', 'key-b', 'key-c'].map((key) =>
          f.run(() => conversion.convertToSale(quotationId, f.cashierId, key)),
        ),
      );

      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter(
        (o): o is PromiseRejectedResult => o.status === 'rejected',
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(2);
      for (const r of rejected) {
        expect((r.reason as BusinessRuleViolationError).code).toBe(
          'QUOTATION_ALREADY_CONVERTED',
        );
      }
      expect(await db.sale.count({ where: { tenantId: f.tenantId } })).toBe(1);
    });

    it('concurrent retries with the same key produce one sale and the same response', async () => {
      const f = await fixture();
      const quotationId = await quotation(f);
      const [a, b] = await Promise.all([
        f.run(() => conversion.convertToSale(quotationId, f.cashierId, 'same')),
        f.run(() => conversion.convertToSale(quotationId, f.cashierId, 'same')),
      ]);
      expect(a.sale.id).toBe(b.sale.id);
      expect(await db.sale.count({ where: { tenantId: f.tenantId } })).toBe(1);
    });

    it.each([
      [
        'a persisted EXPIRED quotation',
        { status: 'EXPIRED' },
        'QUOTATION_EXPIRED',
      ],
      [
        'a SENT quotation past expiresAt (lazy expiry)',
        { status: 'SENT', expiresAt: new Date(Date.now() - 60_000) },
        'QUOTATION_EXPIRED',
      ],
      [
        'a CANCELLED quotation',
        { status: 'CANCELLED', cancelReason: 'OTHER', canceledAt: new Date() },
        'QUOTATION_CANCELLED',
      ],
    ])(
      'rejects %s without creating a sale',
      async (_label, overrides, code) => {
        const f = await fixture();
        const quotationId = await quotation(f, overrides);
        expect(
          await codeOf(
            f.run(() =>
              conversion.convertToSale(quotationId, f.cashierId, 'k'),
            ),
          ),
        ).toMatchObject({ code });
        expect(await db.sale.count({ where: { tenantId: f.tenantId } })).toBe(
          0,
        );
        const row = await db.quotation.findUniqueOrThrow({
          where: { id: quotationId },
        });
        expect(row.convertedSaleId).toBeNull();
      },
    );

    it('lists every unavailable line (inactive product, insufficient stock) and creates nothing', async () => {
      const f = await fixture();
      await db.product.update({
        where: { id: f.plain.id },
        data: { sellInPos: false },
      });
      await db.product.update({
        where: { id: f.promoted.id },
        data: { quantity: 1 },
      });
      const quotationId = await quotation(f);

      const rejection = await codeOf(
        f.run(() => conversion.convertToSale(quotationId, f.cashierId, 'k')),
      );
      expect(rejection.code).toBe('QUOTATION_LINES_UNAVAILABLE');
      const lines = (
        rejection.details as { lines: Array<Record<string, unknown>> }
      ).lines;
      expect(lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            productId: f.plain.id,
            reason: 'PRODUCT_NOT_SELLABLE',
          }),
          expect.objectContaining({
            productId: f.promoted.id,
            reason: 'INSUFFICIENT_STOCK',
            requestedQuantity: 2,
            availableQuantity: 1,
          }),
        ]),
      );
      expect(lines).toHaveLength(2);
      expect(await db.sale.count({ where: { tenantId: f.tenantId } })).toBe(0);
    });

    it('cannot reach a quotation of another tenant (404) and leaves it untouched', async () => {
      const a = await fixture();
      const b = await fixture();
      const quotationOfA = await quotation(a);
      const rejection = await codeOf(
        b.run(() => conversion.convertToSale(quotationOfA, b.cashierId, 'k')),
      );
      expect(rejection.code).toBe('ENTITY_NOT_FOUND');
      const row = await db.quotation.findUniqueOrThrow({
        where: { id: quotationOfA },
      });
      expect(row.status).toBe('SENT');
      expect(await db.sale.count({ where: { tenantId: b.tenantId } })).toBe(0);
    });

    it('quotation reads expose the linked sale status: DRAFT after conversion, CONFIRMED once confirmed, null once the draft is deleted', async () => {
      const f = await fixture();
      const quotationId = await quotation(f);
      const other = await quotation(f);
      const { sale, quotation: converted } = await f.run(() =>
        conversion.convertToSale(quotationId, f.cashierId, 'k'),
      );
      expect(converted.saleStatus).toBe('DRAFT');

      const statusInList = async () => {
        const list = await f.run(() =>
          quotations.findAll({ page: 1, limit: 20 }),
        );
        return new Map(list.data.map((q) => [q.id, q.saleStatus]));
      };
      expect(
        (await f.run(() => quotations.findOne(quotationId))).saleStatus,
      ).toBe('DRAFT');
      expect(await statusInList()).toEqual(
        new Map([
          [quotationId, 'DRAFT'],
          [other, null],
        ]),
      );

      await db.sale.update({
        where: { id: sale.id },
        data: { status: 'CONFIRMED', confirmedAt: new Date() },
      });
      expect(
        (await f.run(() => quotations.findOne(quotationId))).saleStatus,
      ).toBe('CONFIRMED');
      expect((await statusInList()).get(quotationId)).toBe('CONFIRMED');

      await db.sale.update({
        where: { id: sale.id },
        data: { status: 'DRAFT', confirmedAt: null },
      });
      await f.run(() => saleRepo.delete(sale.id));
      const afterDelete = await f.run(() => quotations.findOne(quotationId));
      expect(afterDelete).toMatchObject({ saleId: null, saleStatus: null });
      expect((await statusInList()).get(quotationId)).toBeNull();
    });

    it('allows converting again once the linked draft sale was discarded (FK SET NULL)', async () => {
      const f = await fixture();
      const quotationId = await quotation(f);
      const first = await f.run(() =>
        conversion.convertToSale(quotationId, f.cashierId, 'key-1'),
      );
      await f.run(() => saleRepo.delete(first.sale.id));
      const read = await f.run(() => quotations.findOne(quotationId));
      expect(read).toMatchObject({ status: 'CONVERTED_TO_SALE', saleId: null });

      const second = await f.run(() =>
        conversion.convertToSale(quotationId, f.cashierId, 'key-2'),
      );
      expect(second.sale.id).not.toBe(first.sale.id);
      expect(second.quotation.saleId).toBe(second.sale.id);
    });
  });

  // ── S8: the opened sale is the quote, exactly; adjust afterwards ──

  describe('S8 — exact quoted total at opening', () => {
    const QUOTED_TOTAL = 2 * 10_000 + 12_345;

    /** Quoted before today's promotions started: no quoted discount. */
    const quoteWithoutDiscounts = (f: Fixture) =>
      quotation(
        f,
        {
          subtotalCents: QUOTED_TOTAL,
          discountCents: 0,
          totalCents: QUOTED_TOTAL,
        },
        [
          {
            productId: f.promoted.id,
            productName: 'Jeans',
            quantity: 2,
            unitPriceCents: 10_000,
            priceSource: 'CUSTOM',
            customPriceCents: 10_000,
          },
          {
            productId: f.plain.id,
            productName: 'Playera',
            quantity: 1,
            unitPriceCents: 12_345,
            priceSource: 'CUSTOM',
            customPriceCents: 12_345,
          },
        ],
      );

    it('automatic line and order promotions active today do not change the opened sale: they are vetoed on it and reported', async () => {
      const f = await fixture();
      orderPromoActive = true;
      const quotationId = await quoteWithoutDiscounts(f);

      const result = await f.run(() =>
        conversion.convertToSale(quotationId, f.cashierId, 'key-s8'),
      );

      expect(result.quotation.totalCents).toBe(QUOTED_TOTAL);
      expect(result.sale.totalCents).toBe(QUOTED_TOTAL);
      expect(result.sale.discountCents).toBe(0);
      const byProduct = new Map(result.sale.items.map((i) => [i.productId, i]));
      expect(byProduct.get(f.promoted.id)).toMatchObject({
        quantity: 2,
        unitPriceCents: 10_000,
        discountAmountCents: null,
        promotionId: null,
      });
      expect(byProduct.get(f.plain.id)).toMatchObject({
        quantity: 1,
        unitPriceCents: 12_345,
      });
      expect(
        [...result.suppressedPromotions].sort((a, b) =>
          a.promotionId.localeCompare(b.promotionId),
        ),
      ).toEqual(
        [
          { promotionId: promoId, title: 'Promo test' },
          { promotionId: orderPromoId, title: 'Orden auto' },
        ].sort((a, b) => a.promotionId.localeCompare(b.promotionId)),
      );

      // Persisted as per-sale vetoes; a re-read is still the exact quote.
      const vetoes = await db.salePromotionVeto.findMany({
        where: { saleId: result.sale.id },
      });
      expect(vetoes.map((v) => v.promotionId).sort()).toEqual(
        [promoId, orderPromoId].sort(),
      );
      const reread = await f.run(() => saleRepo.findById(result.sale.id));
      expect(reread?.toResponse().totalCents).toBe(QUOTED_TOTAL);

      // Replay returns the same body (suppressedPromotions included).
      const replay = await f.run(() =>
        conversion.convertToSale(quotationId, f.cashierId, 'key-s8'),
      );
      expect(replay).toEqual(result);
    });

    it('reports nothing when no promotion applies today', async () => {
      const f = await fixture();
      const quotationId = await quotation(f);
      const result = await f.run(() =>
        conversion.convertToSale(quotationId, f.cashierId, 'k'),
      );
      expect(result.sale.totalCents).toBe(
        2 * (10_000 - PROMO_DISCOUNT_CENTS) + 12_345,
      );
      expect(result.suppressedPromotions).toEqual([]);
      expect(
        await db.salePromotionVeto.count({
          where: { saleId: result.sale.id },
        }),
      ).toBe(0);
    });

    it('the cashier re-enables a vetoed promotion (lower total) and raises a line price (higher total) with the existing draft routes', async () => {
      const f = await fixture();
      orderPromoActive = true;
      const quotationId = await quoteWithoutDiscounts(f);
      const { sale } = await f.run(() =>
        conversion.convertToSale(quotationId, f.cashierId, 'k'),
      );
      expect(sale.totalCents).toBe(QUOTED_TOTAL);

      // POST /sales/drafts/:id/manual-promotions/:promotionId — clears the
      // veto; the AUTOMATIC promotion applies again (lower total).
      const reEnabled = await f.run(() =>
        sales.applyManualPromotion(sale.id, f.cashierId, promoId),
      );
      expect(reEnabled.totalCents).toBe(
        QUOTED_TOTAL - 2 * PROMO_DISCOUNT_CENTS,
      );
      expect(
        (
          await db.salePromotionVeto.findMany({ where: { saleId: sale.id } })
        ).map((v) => v.promotionId),
      ).toEqual([orderPromoId]);
      // Not left behind as a MANUAL opt-in (it is AUTOMATIC).
      expect(
        await db.salePromotionOptIn.count({ where: { saleId: sale.id } }),
      ).toBe(0);

      // PATCH /sales/drafts/:id/items/:itemId/price — raise a line price.
      const plainItem = reEnabled.items.find(
        (i) => i.productId === f.plain.id,
      )!;
      const raised = await f.run(() =>
        sales.overrideItemPrice(
          sale.id,
          plainItem.id,
          { customPriceCents: 15_000 },
          f.cashierId,
        ),
      );
      expect(raised.totalCents).toBe(
        QUOTED_TOTAL - 2 * PROMO_DISCOUNT_CENTS + (15_000 - 12_345),
      );
    });
  });

  // ── Existing flows on converted vs. non-converted quotations (S7) ─

  describe('existing quotation flows', () => {
    it('a converted quotation cannot be edited, cancelled or deleted; a stale draft save cannot undo the conversion', async () => {
      const f = await fixture();
      const quotationId = await quotation(f, { status: 'DRAFT' });
      const stale = await f.run(() => quotationRepo.findById(quotationId));
      await f.run(() =>
        conversion.convertToSale(quotationId, f.cashierId, 'k'),
      );

      expect(
        await codeOf(f.run(() => quotations.setNotes(quotationId, 'x'))),
      ).toMatchObject({ code: 'QUOTATION_NOT_DRAFT' });
      expect(
        await codeOf(
          f.run(() =>
            quotations.cancel(quotationId, { cancelReason: 'OTHER' }),
          ),
        ),
      ).toMatchObject({ code: 'QUOTATION_ALREADY_CONVERTED' });
      expect(
        await codeOf(f.run(() => quotations.remove(quotationId))),
      ).toMatchObject({ code: 'QUOTATION_CANNOT_DELETE' });

      stale!.setNotes('stale write');
      expect(
        await codeOf(f.run(() => quotationRepo.save(stale!))),
      ).toMatchObject({ code: 'QUOTATION_NOT_DRAFT' });
      const row = await db.quotation.findUniqueOrThrow({
        where: { id: quotationId },
      });
      expect(row.status).toBe('CONVERTED_TO_SALE');
      expect(row.customerNotes).toBeNull();
    });

    it('non-converted quotations keep cancel, lazy expiry and list filters', async () => {
      const f = await fixture();
      const sent = await quotation(f);
      const expired = await quotation(f, {
        expiresAt: new Date(Date.now() - 60_000),
      });
      const converted = await quotation(f);
      await f.run(() => conversion.convertToSale(converted, f.cashierId, 'k'));

      const lazily = await f.run(() => quotations.findOne(expired));
      expect(lazily.effectiveStatus).toBe('EXPIRED');

      const cancelled = await f.run(() =>
        quotations.cancel(sent, { cancelReason: 'CUSTOMER_REQUEST' }),
      );
      expect(cancelled.status).toBe('CANCELLED');

      const list = await f.run(() =>
        quotations.findAll({
          page: 1,
          limit: 20,
          status: ['CONVERTED_TO_SALE'],
        }),
      );
      expect(list.data.map((q) => q.id)).toEqual([converted]);
      const sentOnly = await f.run(() =>
        quotations.findAll({ page: 1, limit: 20, status: ['SENT'] }),
      );
      expect(sentOnly.data.map((q) => q.id)).toEqual([expired]);
    });
  });

  // ── Races between draft writes and the conversion (verifier M1, M2) ─

  describe('races with a concurrent conversion', () => {
    it('M1: remove() that read a stale DRAFT never deletes a quotation converted in between', async () => {
      const f = await fixture();
      const quotationId = await quotation(f, { status: 'DRAFT' });
      const stale = await f.run(() => quotationRepo.findById(quotationId));
      await f.run(() =>
        conversion.convertToSale(quotationId, f.cashierId, 'k'),
      );

      // remove() checks the status on its own (unlocked) read: hand it the
      // pre-conversion snapshot so the delete itself must lose the race.
      const spy = jest
        .spyOn(quotationRepo, 'findById')
        .mockResolvedValueOnce(stale);
      try {
        expect(
          await codeOf(f.run(() => quotations.remove(quotationId))),
        ).toMatchObject({ code: 'QUOTATION_ALREADY_CONVERTED' });
      } finally {
        spy.mockRestore();
      }
      const row = await db.quotation.findUnique({ where: { id: quotationId } });
      expect(row).toMatchObject({ status: 'CONVERTED_TO_SALE' });
      expect(row?.convertedSaleId).not.toBeNull();
    });

    it('M2: a conversion racing a draft save sees the full new quotation, never a half-written one', async () => {
      const f = await fixture();
      const quotationId = await quotation(f, { status: 'DRAFT' });
      const draft = (await f.run(() => quotationRepo.findById(quotationId)))!;
      const promotedLine = draft.items.find(
        (i) => i.productId === f.promoted.id,
      )!;
      draft.updateItemQuantity(promotedLine.id, 5);

      // Pause the save right before it rewrites the items.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let paused!: () => void;
      const reachedGate = new Promise<void>((resolve) => (paused = resolve));
      let armed = true;
      const realGetClient = tenantPrisma.getClient.bind(tenantPrisma);
      const spy = jest
        .spyOn(tenantPrisma, 'getClient')
        .mockImplementation(() => {
          const client = realGetClient();
          return new Proxy(client, {
            get(target, prop) {
              const value = Reflect.get(target, prop) as unknown;
              if (prop === 'quotationItem') {
                const delegate = value as Record<string, unknown>;
                return new Proxy(delegate, {
                  get(d, key) {
                    const fn = Reflect.get(d, key) as unknown;
                    if (key === 'deleteMany' && armed) {
                      armed = false;
                      return async (...args: unknown[]) => {
                        paused();
                        await gate;
                        return (fn as (...a: unknown[]) => unknown).apply(
                          d,
                          args,
                        );
                      };
                    }
                    return typeof fn === 'function' ? fn.bind(d) : fn;
                  },
                });
              }
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        });

      try {
        const saving = f.run(() => quotationRepo.save(draft));
        await reachedGate;
        const converting = f.run(() =>
          conversion.convertToSale(quotationId, f.cashierId, 'race'),
        );
        // Give the conversion every chance to finish while the save is
        // paused mid-write (it must not be able to).
        await Promise.race([
          converting.catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 1_500)),
        ]);
        release();
        await saving;
        const result = await converting;

        const saleQty = result.sale.items.find(
          (i) => i.productId === f.promoted.id,
        )?.quantity;
        expect(saleQty).toBe(5);
        const quotedQty = result.quotation.items.find(
          (i) => i.productId === f.promoted.id,
        )?.quantity;
        expect(quotedQty).toBe(5);
      } finally {
        release();
        spy.mockRestore();
      }
    });

    it('M2: a save after the conversion is rejected and writes nothing (root, items, vetoes)', async () => {
      const f = await fixture();
      const quotationId = await quotation(f, { status: 'DRAFT' });
      const stale = (await f.run(() => quotationRepo.findById(quotationId)))!;
      await f.run(() =>
        conversion.convertToSale(quotationId, f.cashierId, 'k'),
      );
      const before = await db.quotationItem.findMany({
        where: { quotationId },
        orderBy: { id: 'asc' },
      });

      stale.updateItemQuantity(stale.items[0].id, 7);
      stale.addVetoedPromotion(promoId);
      expect(
        await codeOf(f.run(() => quotationRepo.save(stale))),
      ).toMatchObject({ code: 'QUOTATION_NOT_DRAFT' });

      expect(
        await db.quotationItem.findMany({
          where: { quotationId },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(before);
      expect(
        await db.quotationPromotionVeto.count({ where: { quotationId } }),
      ).toBe(0);
    });
  });
});
