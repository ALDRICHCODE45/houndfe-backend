/**
 * quotation-sale-conversion / T3 (S8, defect D2) — PostgreSQL integration
 * with the REAL promotion engine (PosEvaluatePromotionsUseCase +
 * PrismaPromotionRepository).
 *
 * FE live numbers (L4): one $689.00 item, a 10% line promotion on it and a
 * 10% ORDER promotion ("Buen Fin").
 *   - normal sale: 689.00 − 68.90 = 620.10; − 62.01 = 558.09.
 *   - converted sale opens at the quoted 620.10 exactly (order promotion
 *     suppressed); re-enabling the order promotion must give 558.09, not
 *     551.20 (order discount computed on the gross 689.00).
 *   - order-promo-base-net-of-manual (S2): a normal sale with a cashier
 *     MANUAL line discount computes the order promotion on the subtotal
 *     net of that manual discount too (558.09, no longer 551.20), and an
 *     order-promotion minimum purchase is checked against that net base.
 *
 * Every test owns a fresh tenant (no truncation of shared rows).
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
import { PrismaPromotionRepository } from '../../promotions/infrastructure/prisma-promotion.repository';
import { PosEvaluatePromotionsUseCase } from '../../promotions/application/pos-evaluate-promotions.use-case';

const describeDb =
  process.env.SKIP_DB_INTEGRATION === '1' ? describe.skip : describe;

const ITEM_CENTS = 68_900;
const LINE_DISCOUNT_CENTS = 6_890; // 10% of 689.00
const QUOTED_TOTAL = ITEM_CENTS - LINE_DISCOUNT_CENTS; // 620.10
const NORMAL_TOTAL_WITH_BOTH = 55_809; // 620.10 − 62.01
// S2 — 689.00 − 68.90 (manual 10%) = 620.10; − 62.01 (order 10%) = 558.09.
const MANUAL_LINE_NET_ORDER_TOTAL = 55_809;

describeDb(
  'Converted sale: order promotion base after the quoted line promotion (PostgreSQL, real engine)',
  () => {
    let db: PrismaClient;
    let cls: ClsService<TenantClsStore>;
    let conversion: QuotationSaleConversionService;
    let sales: SalesService;
    let saleRepo: PrismaSaleRepository;
    const ownedTenants: string[] = [];

    beforeAll(() => {
      normalizeTestDatabaseUrl(
        process.env.DATABASE_URL,
        '[quotation-sale-order-base]',
      );
      db = new PrismaClient();
      cls = new ClsService<TenantClsStore>(new AsyncLocalStorage());
      // SAFETY: TenantPrismaService only needs the root Prisma client API.
      const tenantPrisma = new TenantPrismaService(db as PrismaService, cls);
      // SAFETY: only catalog/stock/price reads through `tenantPrisma` run.
      const products = new ProductsService(
        undefined as never,
        db as PrismaService,
        undefined as never,
        tenantPrisma,
        undefined as never,
        { expiredLotQuantity: () => Promise.resolve(0) } as never,
      );
      const engine = new PosEvaluatePromotionsUseCase(
        new PrismaPromotionRepository(tenantPrisma),
      );
      const quotationRepo = new PrismaQuotationRepository(tenantPrisma);
      saleRepo = new PrismaSaleRepository(tenantPrisma);
      const quotations = new QuotationsService(
        quotationRepo,
        tenantPrisma,
        products,
        engine,
        { send: () => Promise.resolve(undefined) } as never,
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

    async function fixture(options: { orderMinPurchaseCents?: number } = {}) {
      const tenantId = randomUUID();
      const cashierId = randomUUID();
      ownedTenants.push(tenantId);
      await db.tenant.create({
        data: { id: tenantId, name: 'D2 order base proof', slug: tenantId },
      });
      await db.user.create({
        data: {
          id: cashierId,
          name: 'Cajero',
          email: `${cashierId}@quotation-sale-d2.invalid`,
          hashedPassword: 'not-a-login-hash',
        },
      });
      const product = await db.product.create({
        data: {
          tenantId,
          name: "Croqueta Hill's Science Diet Gato Adulto 1.8 kg",
          useStock: true,
          quantity: 10,
          ivaRate: 'IVA_16',
          chargeProductTaxes: true,
        },
      });
      const linePromotion = await db.promotion.create({
        data: {
          tenantId,
          title: "10% en croquetas Hill's",
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'PERCENTAGE',
          discountValue: 10,
          appliesTo: 'PRODUCTS',
          targetItems: {
            create: {
              tenantId,
              targetType: 'PRODUCTS',
              targetId: product.id,
            },
          },
        },
      });
      const orderPromotion = await db.promotion.create({
        data: {
          tenantId,
          title: 'Buen Fin 10%',
          type: 'ORDER_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'PERCENTAGE',
          discountValue: 10,
          minPurchaseAmountCents: options.orderMinPurchaseCents ?? null,
        },
      });
      const run = <T>(work: () => Promise<T>): Promise<T> =>
        cls.runWith({ tenantId, userId: cashierId, isSuperAdmin: false }, work);

      /** POS draft with `lines` × (`quantity` of) the item at a cashier price of $689.00, no discount. */
      const draftSale = async (lines = 1, quantity = 1) => {
        const saleId = randomUUID();
        await db.sale.create({
          data: {
            id: saleId,
            tenantId,
            userId: cashierId,
            status: 'DRAFT',
            items: {
              create: Array.from({ length: lines }, () => ({
                tenantId,
                productId: product.id,
                productName: product.name,
                quantity,
                unitPriceCents: ITEM_CENTS,
                priceSource: 'CUSTOM' as const,
                customPriceCents: ITEM_CENTS,
              })),
            },
          },
        });
        return saleId;
      };

      return {
        cashierId,
        product,
        linePromotionId: linePromotion.id,
        orderPromotionId: orderPromotion.id,
        run,
        draftSale,
      };
    }

    it('normal sale: line promotion 10% + order promotion 10% totals 558.09 (order base net of the line promotion)', async () => {
      const f = await fixture();
      const saleId = await f.draftSale();
      const sale = await f.run(() =>
        sales.applyManualPromotion(saleId, f.cashierId, f.orderPromotionId),
      );
      expect(sale.totalCents).toBe(NORMAL_TOTAL_WITH_BOTH);
    });

    it('converted sale opens at the quoted 620.10 exactly and re-enabling the order promotion gives 558.09 like a normal sale', async () => {
      const f = await fixture();
      // Normal sale → quotation (FE flow): the quote keeps the line
      // promotion (620.10) and drops the order promotion.
      const sourceSaleId = await f.draftSale();
      await f.run(() =>
        sales.applyManualPromotion(
          sourceSaleId,
          f.cashierId,
          f.orderPromotionId,
        ),
      );
      const { quotation } = await f.run(() =>
        conversion.createFromSaleDraft(sourceSaleId, f.cashierId, {}, 'q-1'),
      );
      expect(quotation.totalCents).toBe(QUOTED_TOTAL);

      // S8 — opens at the exact quoted total.
      const { sale, suppressedPromotions } = await f.run(() =>
        conversion.convertToSale(quotation.id, f.cashierId, 's-1'),
      );
      expect(sale.totalCents).toBe(QUOTED_TOTAL);
      expect(suppressedPromotions.map((p) => p.promotionId)).toEqual([
        f.orderPromotionId,
      ]);
      const reread = await f.run(() => saleRepo.findById(sale.id));
      expect(reread?.toResponse().totalCents).toBe(QUOTED_TOTAL);

      // D2 — cashier re-enables the order promotion.
      const reEnabled = await f.run(() =>
        sales.applyManualPromotion(sale.id, f.cashierId, f.orderPromotionId),
      );
      expect(reEnabled.totalCents).toBe(NORMAL_TOTAL_WITH_BOTH);
    });

    /** Applies a cashier MANUAL 10% discount to `itemId`. */
    const manualTenPercent = (
      f: Awaited<ReturnType<typeof fixture>>,
      saleId: string,
      itemId: string,
    ) =>
      f.run(() =>
        sales.applyItemDiscount(
          saleId,
          itemId,
          { type: 'percentage', percent: 10 } as never,
          f.cashierId,
        ),
      );

    it('S2 — normal sale with a cashier MANUAL 10% line discount + order promotion 10% totals 558.09 (order base net of the manual discount)', async () => {
      const f = await fixture();
      const saleId = await f.draftSale();
      const draft = await f.run(() => saleRepo.findById(saleId));
      const itemId = draft!.items[0].id;
      await manualTenPercent(f, saleId, itemId);
      const sale = await f.run(() =>
        sales.applyManualPromotion(saleId, f.cashierId, f.orderPromotionId),
      );
      const line = sale.items.find((i) => i.id === itemId)!;
      expect(line).toMatchObject({
        unitPriceCents: QUOTED_TOTAL,
        promotionId: null,
      });
      expect(sale.totalCents).toBe(MANUAL_LINE_NET_ORDER_TOTAL);
      const reread = await f.run(() => saleRepo.findById(saleId));
      expect(reread?.appliedOrderPromotion?.discountAmountCents).toBe(6_201);
    });

    it('S2 — an order-promotion minimum just above the subtotal net of the manual discount no longer applies', async () => {
      // Gross 689.00 >= 650.00, but net of the manual 10% it is 620.10.
      const f = await fixture({ orderMinPurchaseCents: 65_000 });
      const saleId = await f.draftSale();
      const draft = await f.run(() => saleRepo.findById(saleId));
      await manualTenPercent(f, saleId, draft!.items[0].id);
      const sale = await f.run(() =>
        sales.applyManualPromotion(saleId, f.cashierId, f.orderPromotionId),
      );
      expect(sale.totalCents).toBe(QUOTED_TOTAL);
      const reread = await f.run(() => saleRepo.findById(saleId));
      expect(reread?.appliedOrderPromotion).toBeNull();
    });

    it('S2 — a manual-discount line + a line-promotion line + order promotion: order base net of both', async () => {
      const f = await fixture();
      const saleId = await f.draftSale(2);
      const draft = await f.run(() => saleRepo.findById(saleId));
      const [manualItem, promoItem] = draft!.items;
      await manualTenPercent(f, saleId, manualItem.id);
      const sale = await f.run(() =>
        sales.applyManualPromotion(saleId, f.cashierId, f.orderPromotionId),
      );
      expect(sale.items.find((i) => i.id === manualItem.id)).toMatchObject({
        unitPriceCents: QUOTED_TOTAL,
        promotionId: null,
      });
      expect(sale.items.find((i) => i.id === promoItem.id)).toMatchObject({
        unitPriceCents: QUOTED_TOTAL,
        promotionId: f.linePromotionId,
      });
      // 620.10 + 620.10 = 1240.20; 10% = 124.02; total 1116.18
      // (the old gross-of-manual base 1309.10 gave 130.91 → 1109.29).
      expect(sale.totalCents).toBe(111_618);
      const reread = await f.run(() => saleRepo.findById(saleId));
      expect(reread?.appliedOrderPromotion?.discountAmountCents).toBe(12_402);
    });

    // T2 — quantity > 1: the line promotion is subtracted from the order
    // base for the WHOLE line (per-unit discount × quantity), not once.
    it.each([
      // qty, order discount, total
      [2, 12_402, 111_618], // FE dev: 2 × 620.10 = 1240.20 → 124.02 (not 130.91)
      [3, 18_603, 167_427], // 3 × 620.10 = 1860.30 → 186.03
    ])(
      'T2 — normal sale, qty %i: line promotion 10% + order promotion 10% → order discount %i, total %i',
      async (quantity, orderDiscount, total) => {
        const f = await fixture();
        const saleId = await f.draftSale(1, quantity);
        const sale = await f.run(() =>
          sales.applyManualPromotion(saleId, f.cashierId, f.orderPromotionId),
        );
        expect(sale.items[0]).toMatchObject({
          quantity,
          unitPriceCents: QUOTED_TOTAL,
          promotionId: f.linePromotionId,
        });
        expect(sale.totalCents).toBe(total);
        const reread = await f.run(() => saleRepo.findById(saleId));
        expect(reread?.appliedOrderPromotion?.discountAmountCents).toBe(
          orderDiscount,
        );
      },
    );

    it('T2 — manual 10% line discount with qty 2 + order promotion 10% → order discount 124.02, total 1116.18', async () => {
      const f = await fixture();
      const saleId = await f.draftSale(1, 2);
      const draft = await f.run(() => saleRepo.findById(saleId));
      await manualTenPercent(f, saleId, draft!.items[0].id);
      const sale = await f.run(() =>
        sales.applyManualPromotion(saleId, f.cashierId, f.orderPromotionId),
      );
      expect(sale.items[0]).toMatchObject({
        quantity: 2,
        unitPriceCents: QUOTED_TOTAL,
        promotionId: null,
      });
      expect(sale.totalCents).toBe(111_618);
      const reread = await f.run(() => saleRepo.findById(saleId));
      expect(reread?.appliedOrderPromotion?.discountAmountCents).toBe(12_402);
    });

    it('T2 — minimum purchase with qty 2 is checked on the whole line (2 × 689.00 net of manual = 1240.20)', async () => {
      const f = await fixture({ orderMinPurchaseCents: 124_020 });
      const saleId = await f.draftSale(1, 2);
      const draft = await f.run(() => saleRepo.findById(saleId));
      await manualTenPercent(f, saleId, draft!.items[0].id);
      const sale = await f.run(() =>
        sales.applyManualPromotion(saleId, f.cashierId, f.orderPromotionId),
      );
      expect(sale.totalCents).toBe(111_618);
    });
  },
);
