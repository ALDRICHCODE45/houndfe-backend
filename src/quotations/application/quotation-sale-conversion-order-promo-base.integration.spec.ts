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
 *   - a normal sale with a cashier MANUAL line discount keeps today's
 *     behavior (the order promotion is computed on the gross base).
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
const MANUAL_LINE_GROSS_ORDER_TOTAL = 55_120; // 620.10 − 68.90 (today)

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

    async function fixture() {
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
        },
      });
      const run = <T>(work: () => Promise<T>): Promise<T> =>
        cls.runWith({ tenantId, userId: cashierId, isSuperAdmin: false }, work);

      /** POS draft with the item at a cashier price of $689.00, no discount. */
      const draftSale = async () => {
        const saleId = randomUUID();
        await db.sale.create({
          data: {
            id: saleId,
            tenantId,
            userId: cashierId,
            status: 'DRAFT',
            items: {
              create: [
                {
                  tenantId,
                  productId: product.id,
                  productName: product.name,
                  quantity: 1,
                  unitPriceCents: ITEM_CENTS,
                  priceSource: 'CUSTOM',
                  customPriceCents: ITEM_CENTS,
                },
              ],
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

    it('normal sale with a cashier MANUAL 10% line discount + order promotion keeps today behavior (order base is the gross subtotal)', async () => {
      const f = await fixture();
      const saleId = await f.draftSale();
      const draft = await f.run(() => saleRepo.findById(saleId));
      const itemId = draft!.items[0].id;
      await f.run(() =>
        sales.applyItemDiscount(
          saleId,
          itemId,
          { type: 'percentage', percent: 10 } as never,
          f.cashierId,
        ),
      );
      const sale = await f.run(() =>
        sales.applyManualPromotion(saleId, f.cashierId, f.orderPromotionId),
      );
      const line = sale.items.find((i) => i.id === itemId)!;
      expect(line).toMatchObject({
        unitPriceCents: QUOTED_TOTAL,
        promotionId: null,
      });
      expect(sale.totalCents).toBe(MANUAL_LINE_GROSS_ORDER_TOTAL);
    });
  },
);
