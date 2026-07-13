/**
 * W5 — category-brand-promo-targeting end-to-end (Integration - Real DB).
 *
 * End-to-end sweep against the dedicated `nest-practice-test` database
 * (port 5433, NOT the dev DB). Validates the W1–W4 changes wire
 * correctly through the real Prisma stack:
 *
 *   - Engine applies a CATEGORIES promo only when the line's product
 *     categoryId matches the target (scenario 2).
 *   - Engine applies a BRANDS promo only when the line's product
 *     brandId matches the target (scenario 3).
 *   - Line with null categoryId / brandId NEVER matches the
 *     corresponding promo (scenarios 4, 5 — null-guard).
 *   - Precedence ladder VARIANT > PRODUCT > {BRAND ≡ CATEGORY}:
 *     V wins over B/C on the same line (P1); P wins over B/C on the
 *     same line (P2); B≡C peer tie → best-wins by discount (P3).
 *   - Validation: PromotionsService.create accepts an existing
 *     Category/Brand id (V1, V2), rejects a missing one with
 *     `INVALID_TARGET` (V3, V4) and persists NOTHING.
 *
 * Global models note: Category and Brand have NO tenantId. They
 * survive the `resetAndSeedBaseline()` TRUNCATE CASCADE — that's
 * intentional (design.md: validation is GLOBAL, resolution is
 * tenant-scoped). The spec upserts them in beforeAll with known
 * ids so the test body can reference them deterministically.
 *
 * Run filtered with the longer integration timeout (~180s). First
 * invocation of any integration spec triggers
 * `prisma migrate deploy` + baseline tenant seed via globalSetup
 * (~30s one-time cost).
 */
import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import {
  resetAndSeedBaseline,
  disconnectIntegrationPrisma,
} from '../../test/integration/reset-db';
import { PrismaService } from '../shared/prisma/prisma.service';
import { PrismaPromotionRepository } from './infrastructure/prisma-promotion.repository';
import { PosEvaluatePromotionsUseCase } from './application/pos-evaluate-promotions.use-case';
import { PromotionsService } from './promotions.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import type { ClsService } from 'nestjs-cls';
import type { PosEvalInput } from './application/ports/pos-evaluate-promotions.port';
import { Promotion } from './domain/promotion.entity';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;

const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

// Deterministic global ids for the seeded Category + Brand rows.
// Global models survive the tenants CASCADE; we reference these by
// id so the test body never re-queries. Two of each so the
// "negative match" cases have a VALID FK target to point at (the
// Product.categoryId / brandId columns have FK constraints to the
// global Category/Brand tables).
const CAT1_ID = '11111111-1111-1111-1111-111111111111';
const CAT2_ID = '11111111-1111-1111-1111-111111111112';
const BR1_ID = '22222222-2222-2222-2222-222222222222';
const BR2_ID = '22222222-2222-2222-2222-222222222223';

describeIfDb(
  'category-brand-promo-targeting end-to-end (Integration - Real DB)',
  () => {
    let prisma: PrismaService;
    let tenantPrisma: TenantPrismaService;
    let repository: PrismaPromotionRepository;
    let service: PromotionsService;
    let engine: PosEvaluatePromotionsUseCase;
    let tenantId: string;

    beforeAll(async () => {
      prisma = new PrismaService();
      await prisma.$connect();
      await resetAndSeedBaseline();

      // Seed the GLOBAL Category + Brand rows. These survive the
      // per-test `TRUNCATE tenants CASCADE` so we only need to do
      // this once. Upsert so re-running the spec against a dirty
      // DB is idempotent. Seed two of each so the negative-match
      // products can reference CAT2/BR2 as valid FK targets
      // (Product.categoryId / brandId are FKs to the global
      // Category/Brand tables).
      await prisma.category.upsert({
        where: { id: CAT1_ID },
        update: { name: 'Integration CAT1' },
        create: { id: CAT1_ID, name: 'Integration CAT1' },
      });
      await prisma.category.upsert({
        where: { id: CAT2_ID },
        update: { name: 'Integration CAT2' },
        create: { id: CAT2_ID, name: 'Integration CAT2' },
      });
      await prisma.brand.upsert({
        where: { id: BR1_ID },
        update: { name: 'Integration BR1' },
        create: { id: BR1_ID, name: 'Integration BR1' },
      });
      await prisma.brand.upsert({
        where: { id: BR2_ID },
        update: { name: 'Integration BR2' },
        create: { id: BR2_ID, name: 'Integration BR2' },
      });

      const tenant = await prisma.tenant.findFirst({ select: { id: true } });
      if (!tenant) {
        throw new Error(
          'No tenant found for integration test. globalSetup must have seeded one.',
        );
      }
      tenantId = tenant.id;

      const cls: Pick<ClsService<TenantClsStore>, 'get'> = {
        get: (key: string) => {
          if (key === 'tenantId') return tenantId;
          if (key === 'isSuperAdmin') return false;
          return undefined;
        },
      };

      tenantPrisma = new TenantPrismaService(
        prisma as unknown as ConstructorParameters<typeof TenantPrismaService>[0],
        cls as ClsService<TenantClsStore>,
      );
      repository = new PrismaPromotionRepository(tenantPrisma);

      const configService = {
        get: (key: string, defaultValue?: unknown) => {
          if (key === 'PROMOTIONS_BUSINESS_TIMEZONE')
            return 'America/Mexico_City';
          return defaultValue;
        },
      } as unknown as ConfigService;

      service = new PromotionsService(
        repository,
        prisma,
        tenantPrisma,
        configService,
      );
      engine = new PosEvaluatePromotionsUseCase(repository);
    });

    afterEach(async () => {
      // Robust cascade reset between tests in this suite — wipes
      // promotion rows + relations and re-seeds the baseline tenant
      // so the next test starts clean.
      await resetAndSeedBaseline();
    });

    afterAll(async () => {
      await prisma.$disconnect();
      await disconnectIntegrationPrisma();
    });

    // ──────────────────────────────────────────────────────────
    // Helpers — seed a Product + (optional) Variant in the
    // baseline tenant with the requested categoryId / brandId.
    // Always called AFTER resetAndSeedBaseline() (afterEach) so
    // the rows are fresh.
    // ──────────────────────────────────────────────────────────

    async function seedProduct(opts: {
      categoryId: string | null;
      brandId: string | null;
      hasVariants?: boolean;
      sku: string;
    }): Promise<{ productId: string; variantId: string | null }> {
      const product = await prisma.product.create({
        data: {
          tenantId,
          name: `Integration Product ${opts.sku}`,
          sku: opts.sku,
          hasVariants: opts.hasVariants ?? false,
          sellInPos: true,
          useStock: false,
          categoryId: opts.categoryId,
          brandId: opts.brandId,
        },
      });
      if (opts.hasVariants) {
        const variant = await prisma.variant.create({
          data: { tenantId, productId: product.id, name: 'V-A' },
        });
        return { productId: product.id, variantId: variant.id };
      }
      return { productId: product.id, variantId: null };
    }

    async function seedPromotion(p: Promotion): Promise<void> {
      await prisma.promotion.create({
        data: {
          id: p.id,
          tenantId,
          title: p.title,
          type: p.type,
          method: p.method,
          status: p.status,
          customerScope: p.customerScope,
          discountType: p.discountType,
          discountValue: p.discountValue,
          appliesTo: p.appliesTo,
        },
      });
      if (p.targetItems.length > 0) {
        await prisma.promotionTargetItem.createMany({
          data: p.targetItems.map((item) => ({
            promotionId: p.id,
            tenantId,
            side: item.side,
            targetType: item.targetType,
            targetId: item.targetId,
          })),
        });
      }
    }

    // ──────────────────────────────────────────────────────────
    // SCENARIO 2 — CATEGORIES targeting matches by category id
    // ──────────────────────────────────────────────────────────

    describe('Scenario 2 — CATEGORIES targeting matches by product category id', () => {
      it('only the line whose product.categoryId matches the target is eligible', async () => {
        // Two products: P-CAT1 in CAT1, P-CAT2 in CAT2.
        const pCat1 = await seedProduct({
          categoryId: CAT1_ID,
          brandId: null,
          sku: 'INT-CAT-A',
        });
        const pCat2 = await seedProduct({
          categoryId: CAT2_ID,
          brandId: null,
          sku: 'INT-CAT-B',
        });

        const promoC = Promotion.create({
          id: crypto.randomUUID(),
          title: 'CATEGORIES on CAT1',
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'FIXED',
          discountValue: 100,
          appliesTo: 'CATEGORIES',
        });
        promoC.targetItems = [
          {
            id: crypto.randomUUID(),
            side: 'DEFAULT',
            targetType: 'CATEGORIES',
            targetId: CAT1_ID,
          },
        ];
        await seedPromotion(promoC);

        const input: PosEvalInput = {
          now: new Date(),
          customerId: null,
          lines: [
            {
              itemId: 'item-CAT1',
              productId: pCat1.productId,
              variantId: pCat1.variantId,
              quantity: 1,
              effectiveUnitPriceCents: 1000,
              appliedPriceListId: null,
              appliedGlobalPriceListId: null,
              categoryId: CAT1_ID,
              brandId: null,
              hasManualDiscount: false,
            },
            {
              itemId: 'item-CAT2',
              productId: pCat2.productId,
              variantId: pCat2.variantId,
              quantity: 1,
              effectiveUnitPriceCents: 500,
              appliedPriceListId: null,
              appliedGlobalPriceListId: null,
              categoryId: CAT2_ID,
              brandId: null,
              hasManualDiscount: false,
            },
          ],
          vetoedPromotionIds: [],
          optedInManualPromotionIds: [],
        };

        const result = await engine.evaluate(input);

        expect(result.lines).toHaveLength(1);
        expect(result.lines[0].itemId).toBe('item-CAT1');
        expect(result.lines[0].promotionId).toBe(promoC.id);
        expect(result.lines[0].discountValue).toBe(100);
      });
    });

    // ──────────────────────────────────────────────────────────
    // SCENARIO 3 — BRANDS targeting matches by brand id
    // ──────────────────────────────────────────────────────────

    describe('Scenario 3 — BRANDS targeting matches by product brand id', () => {
      it('only the line whose product.brandId matches the target is eligible', async () => {
        const pBrand1 = await seedProduct({
          categoryId: null,
          brandId: BR1_ID,
          sku: 'INT-BR-A',
        });
        const pBrand2 = await seedProduct({
          categoryId: null,
          brandId: BR2_ID,
          sku: 'INT-BR-B',
        });

        const promoB = Promotion.create({
          id: crypto.randomUUID(),
          title: 'BRANDS on BR1',
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'FIXED',
          discountValue: 75,
          appliesTo: 'BRANDS',
        });
        promoB.targetItems = [
          {
            id: crypto.randomUUID(),
            side: 'DEFAULT',
            targetType: 'BRANDS',
            targetId: BR1_ID,
          },
        ];
        await seedPromotion(promoB);

        const result = await engine.evaluate({
          now: new Date(),
          customerId: null,
          lines: [
            {
              itemId: 'item-BR1',
              productId: pBrand1.productId,
              variantId: pBrand1.variantId,
              quantity: 1,
              effectiveUnitPriceCents: 1000,
              appliedPriceListId: null,
              appliedGlobalPriceListId: null,
              categoryId: null,
              brandId: BR1_ID,
              hasManualDiscount: false,
            },
            {
              itemId: 'item-BR2',
              productId: pBrand2.productId,
              variantId: pBrand2.variantId,
              quantity: 1,
              effectiveUnitPriceCents: 500,
              appliedPriceListId: null,
              appliedGlobalPriceListId: null,
              categoryId: null,
              brandId: BR2_ID,
              hasManualDiscount: false,
            },
          ],
          vetoedPromotionIds: [],
          optedInManualPromotionIds: [],
        });

        expect(result.lines).toHaveLength(1);
        expect(result.lines[0].itemId).toBe('item-BR1');
        expect(result.lines[0].promotionId).toBe(promoB.id);
      });
    });

    // ──────────────────────────────────────────────────────────
    // SCENARIO 4 — Line with null categoryId does NOT match a CATEGORIES promo
    // ──────────────────────────────────────────────────────────

    describe('Scenario 4 — null categoryId never matches a CATEGORIES promo', () => {
      it('a CATEGORIES promo on CAT1 does NOT apply to a line whose product.categoryId is null', async () => {
        const pNullCat = await seedProduct({
          categoryId: null,
          brandId: null,
          sku: 'INT-NULL-CAT',
        });

        const promoC = Promotion.create({
          id: crypto.randomUUID(),
          title: 'CATEGORIES on CAT1',
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'FIXED',
          discountValue: 100,
          appliesTo: 'CATEGORIES',
        });
        promoC.targetItems = [
          {
            id: crypto.randomUUID(),
            side: 'DEFAULT',
            targetType: 'CATEGORIES',
            targetId: CAT1_ID,
          },
        ];
        await seedPromotion(promoC);

        const result = await engine.evaluate({
          now: new Date(),
          customerId: null,
          lines: [
            {
              itemId: 'item-NULL-CAT',
              productId: pNullCat.productId,
              variantId: pNullCat.variantId,
              quantity: 1,
              effectiveUnitPriceCents: 1000,
              appliedPriceListId: null,
              appliedGlobalPriceListId: null,
              categoryId: null,
              brandId: null,
              hasManualDiscount: false,
            },
          ],
          vetoedPromotionIds: [],
          optedInManualPromotionIds: [],
        });

        expect(result.lines).toEqual([]);
      });
    });

    // ──────────────────────────────────────────────────────────
    // SCENARIO 5 — Line with null brandId does NOT match a BRANDS promo
    // ──────────────────────────────────────────────────────────

    describe('Scenario 5 — null brandId never matches a BRANDS promo', () => {
      it('a BRANDS promo on BR1 does NOT apply to a line whose product.brandId is null', async () => {
        const pNullBrand = await seedProduct({
          categoryId: null,
          brandId: null,
          sku: 'INT-NULL-BR',
        });

        const promoB = Promotion.create({
          id: crypto.randomUUID(),
          title: 'BRANDS on BR1',
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'FIXED',
          discountValue: 75,
          appliesTo: 'BRANDS',
        });
        promoB.targetItems = [
          {
            id: crypto.randomUUID(),
            side: 'DEFAULT',
            targetType: 'BRANDS',
            targetId: BR1_ID,
          },
        ];
        await seedPromotion(promoB);

        const result = await engine.evaluate({
          now: new Date(),
          customerId: null,
          lines: [
            {
              itemId: 'item-NULL-BR',
              productId: pNullBrand.productId,
              variantId: pNullBrand.variantId,
              quantity: 1,
              effectiveUnitPriceCents: 1000,
              appliedPriceListId: null,
              appliedGlobalPriceListId: null,
              categoryId: null,
              brandId: null,
              hasManualDiscount: false,
            },
          ],
          vetoedPromotionIds: [],
          optedInManualPromotionIds: [],
        });

        expect(result.lines).toEqual([]);
      });
    });

    // ──────────────────────────────────────────────────────────
    // PRECEDENCE 1 — VARIANTS wins over BRANDS and CATEGORIES on the same line
    // ──────────────────────────────────────────────────────────

    describe('Precedence P1 — VARIANTS wins over BRANDS and CATEGORIES on the same V-A line', () => {
      it('VARIANTS (V-A, 10c) wins even though BRANDS (BR1, 500c) and CATEGORIES (CAT1, 500c) offer higher discounts', async () => {
        const { productId, variantId } = await seedProduct({
          categoryId: CAT1_ID,
          brandId: BR1_ID,
          hasVariants: true,
          sku: 'INT-PREC-P1',
        });
        if (!variantId) throw new Error('variantId missing');

        const promoV = Promotion.create({
          id: crypto.randomUUID(),
          title: 'VARIANTS on V-A 10c',
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'FIXED',
          discountValue: 10,
          appliesTo: 'VARIANTS',
        });
        promoV.targetItems = [
          {
            id: crypto.randomUUID(),
            side: 'DEFAULT',
            targetType: 'VARIANTS',
            targetId: variantId,
          },
        ];
        const promoB = Promotion.create({
          id: crypto.randomUUID(),
          title: 'BRANDS on BR1 500c',
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'FIXED',
          discountValue: 500,
          appliesTo: 'BRANDS',
        });
        promoB.targetItems = [
          {
            id: crypto.randomUUID(),
            side: 'DEFAULT',
            targetType: 'BRANDS',
            targetId: BR1_ID,
          },
        ];
        const promoC = Promotion.create({
          id: crypto.randomUUID(),
          title: 'CATEGORIES on CAT1 500c',
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'FIXED',
          discountValue: 500,
          appliesTo: 'CATEGORIES',
        });
        promoC.targetItems = [
          {
            id: crypto.randomUUID(),
            side: 'DEFAULT',
            targetType: 'CATEGORIES',
            targetId: CAT1_ID,
          },
        ];
        await seedPromotion(promoV);
        await seedPromotion(promoB);
        await seedPromotion(promoC);

        const result = await engine.evaluate({
          now: new Date(),
          customerId: null,
          lines: [
            {
              itemId: 'item-V-A',
              productId,
              variantId,
              quantity: 1,
              effectiveUnitPriceCents: 1000,
              appliedPriceListId: null,
              appliedGlobalPriceListId: null,
              categoryId: CAT1_ID,
              brandId: BR1_ID,
              hasManualDiscount: false,
            },
          ],
          vetoedPromotionIds: [],
          optedInManualPromotionIds: [],
        });

        // VARIANTS (ordinal 3) wins over BRANDS/CATEGORIES (ordinal 1)
        // REGARDLESS of discount magnitude — specificity trumps.
        expect(result.lines).toHaveLength(1);
        expect(result.lines[0].promotionId).toBe(promoV.id);
        expect(result.lines[0].discountValue).toBe(10);
      });
    });

    // ──────────────────────────────────────────────────────────
    // PRECEDENCE 2 — PRODUCTS wins over BRANDS and CATEGORIES on the same line
    // ──────────────────────────────────────────────────────────

    describe('Precedence P2 — PRODUCTS wins over BRANDS and CATEGORIES on the same line', () => {
      it('PRODUCTS (P1, 10c) wins even though BRANDS (BR1, 500c) and CATEGORIES (CAT1, 500c) offer higher discounts', async () => {
        const { productId } = await seedProduct({
          categoryId: CAT1_ID,
          brandId: BR1_ID,
          sku: 'INT-PREC-P2',
        });

        const promoP = Promotion.create({
          id: crypto.randomUUID(),
          title: 'PRODUCTS on P1 10c',
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'FIXED',
          discountValue: 10,
          appliesTo: 'PRODUCTS',
        });
        promoP.targetItems = [
          {
            id: crypto.randomUUID(),
            side: 'DEFAULT',
            targetType: 'PRODUCTS',
            targetId: productId,
          },
        ];
        const promoB = Promotion.create({
          id: crypto.randomUUID(),
          title: 'BRANDS on BR1 500c',
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'FIXED',
          discountValue: 500,
          appliesTo: 'BRANDS',
        });
        promoB.targetItems = [
          {
            id: crypto.randomUUID(),
            side: 'DEFAULT',
            targetType: 'BRANDS',
            targetId: BR1_ID,
          },
        ];
        const promoC = Promotion.create({
          id: crypto.randomUUID(),
          title: 'CATEGORIES on CAT1 500c',
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'FIXED',
          discountValue: 500,
          appliesTo: 'CATEGORIES',
        });
        promoC.targetItems = [
          {
            id: crypto.randomUUID(),
            side: 'DEFAULT',
            targetType: 'CATEGORIES',
            targetId: CAT1_ID,
          },
        ];
        await seedPromotion(promoP);
        await seedPromotion(promoB);
        await seedPromotion(promoC);

        const result = await engine.evaluate({
          now: new Date(),
          customerId: null,
          lines: [
            {
              itemId: 'item-P1',
              productId,
              variantId: null,
              quantity: 1,
              effectiveUnitPriceCents: 1000,
              appliedPriceListId: null,
              appliedGlobalPriceListId: null,
              categoryId: CAT1_ID,
              brandId: BR1_ID,
              hasManualDiscount: false,
            },
          ],
          vetoedPromotionIds: [],
          optedInManualPromotionIds: [],
        });

        // PRODUCTS (ordinal 2) wins over BRANDS/CATEGORIES (ordinal 1).
        expect(result.lines).toHaveLength(1);
        expect(result.lines[0].promotionId).toBe(promoP.id);
        expect(result.lines[0].discountValue).toBe(10);
      });
    });

    // ──────────────────────────────────────────────────────────
    // PRECEDENCE 3 — BRAND and CATEGORY are peers — best-wins decides
    // ──────────────────────────────────────────────────────────

    describe('Precedence P3 — BRAND ≡ CATEGORY peer: best-wins decides, not tier', () => {
      it('CATEGORIES (CAT1, 500c) wins over BRANDS (BR1, 100c) on the same line', async () => {
        const { productId } = await seedProduct({
          categoryId: CAT1_ID,
          brandId: BR1_ID,
          sku: 'INT-PREC-P3',
        });

        const promoC = Promotion.create({
          id: crypto.randomUUID(),
          title: 'CATEGORIES on CAT1 500c',
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'FIXED',
          discountValue: 500,
          appliesTo: 'CATEGORIES',
        });
        promoC.targetItems = [
          {
            id: crypto.randomUUID(),
            side: 'DEFAULT',
            targetType: 'CATEGORIES',
            targetId: CAT1_ID,
          },
        ];
        const promoB = Promotion.create({
          id: crypto.randomUUID(),
          title: 'BRANDS on BR1 100c',
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'FIXED',
          discountValue: 100,
          appliesTo: 'BRANDS',
        });
        promoB.targetItems = [
          {
            id: crypto.randomUUID(),
            side: 'DEFAULT',
            targetType: 'BRANDS',
            targetId: BR1_ID,
          },
        ];
        await seedPromotion(promoC);
        await seedPromotion(promoB);

        const result = await engine.evaluate({
          now: new Date(),
          customerId: null,
          lines: [
            {
              itemId: 'item-P1',
              productId,
              variantId: null,
              quantity: 1,
              effectiveUnitPriceCents: 1000,
              appliedPriceListId: null,
              appliedGlobalPriceListId: null,
              categoryId: CAT1_ID,
              brandId: BR1_ID,
              hasManualDiscount: false,
            },
          ],
          vetoedPromotionIds: [],
          optedInManualPromotionIds: [],
        });

        // Both ordinal-1 peers — best-wins by discount (500c > 100c).
        // NOT a BRAND-over-CATEGORY hierarchy.
        expect(result.lines).toHaveLength(1);
        expect(result.lines[0].promotionId).toBe(promoC.id);
        expect(result.lines[0].discountValue).toBe(500);
      });
    });

    // ──────────────────────────────────────────────────────────
    // VALIDATION V1 — CATEGORIES with an existing category id is accepted
    // ──────────────────────────────────────────────────────────

    describe('Validation V1 — CATEGORIES with existing category id is accepted', () => {
      it('PromotionsService.create succeeds and the promotion is persisted', async () => {
        const result = await service.create({
          title: 'CATEGORIES on existing CAT1',
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'FIXED',
          discountValue: 100,
          appliesTo: 'CATEGORIES',
          targetItems: [{ targetType: 'CATEGORIES', targetId: CAT1_ID }],
        } as never);

        expect(result.appliesTo).toBe('CATEGORIES');

        const persisted = await prisma.promotion.findUnique({
          where: { id: result.id },
          include: { targetItems: true },
        });
        expect(persisted).not.toBeNull();
        expect(persisted!.targetItems).toHaveLength(1);
        expect(persisted!.targetItems[0].targetType).toBe('CATEGORIES');
        expect(persisted!.targetItems[0].targetId).toBe(CAT1_ID);
      });
    });

    // ──────────────────────────────────────────────────────────
    // VALIDATION V2 — BRANDS with an existing brand id is accepted
    // ──────────────────────────────────────────────────────────

    describe('Validation V2 — BRANDS with existing brand id is accepted', () => {
      it('PromotionsService.create succeeds and the promotion is persisted', async () => {
        const result = await service.create({
          title: 'BRANDS on existing BR1',
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'FIXED',
          discountValue: 75,
          appliesTo: 'BRANDS',
          targetItems: [{ targetType: 'BRANDS', targetId: BR1_ID }],
        } as never);

        expect(result.appliesTo).toBe('BRANDS');

        const persisted = await prisma.promotion.findUnique({
          where: { id: result.id },
          include: { targetItems: true },
        });
        expect(persisted).not.toBeNull();
        expect(persisted!.targetItems).toHaveLength(1);
        expect(persisted!.targetItems[0].targetType).toBe('BRANDS');
        expect(persisted!.targetItems[0].targetId).toBe(BR1_ID);
      });
    });

    // ──────────────────────────────────────────────────────────
    // VALIDATION V3 — CATEGORIES with a non-existent category id is rejected
    // ──────────────────────────────────────────────────────────

    describe('Validation V3 — CATEGORIES with non-existent category id is rejected', () => {
      it('rejects and persists NO promotion / target rows', async () => {
        const beforeCount = await prisma.promotion.count();
        const beforeTargetCount = await prisma.promotionTargetItem.count();

        await expect(
          service.create({
            title: 'Bogus category',
            type: 'PRODUCT_DISCOUNT',
            method: 'AUTOMATIC',
            discountType: 'PERCENTAGE',
            discountValue: 10,
            appliesTo: 'CATEGORIES',
            targetItems: [
              {
                targetType: 'CATEGORIES',
                targetId: '55555555-5555-5555-5555-555555555555',
              },
            ],
          } as never),
        ).rejects.toThrow(/Category with id/);

        const afterCount = await prisma.promotion.count();
        const afterTargetCount = await prisma.promotionTargetItem.count();
        expect(afterCount).toBe(beforeCount);
        expect(afterTargetCount).toBe(beforeTargetCount);
      });
    });

    // ──────────────────────────────────────────────────────────
    // VALIDATION V4 — BRANDS with a non-existent brand id is rejected
    // ──────────────────────────────────────────────────────────

    describe('Validation V4 — BRANDS with non-existent brand id is rejected', () => {
      it('rejects and persists NO promotion / target rows', async () => {
        const beforeCount = await prisma.promotion.count();
        const beforeTargetCount = await prisma.promotionTargetItem.count();

        await expect(
          service.create({
            title: 'Bogus brand',
            type: 'PRODUCT_DISCOUNT',
            method: 'AUTOMATIC',
            discountType: 'PERCENTAGE',
            discountValue: 10,
            appliesTo: 'BRANDS',
            targetItems: [
              {
                targetType: 'BRANDS',
                targetId: '66666666-6666-6666-6666-666666666666',
              },
            ],
          } as never),
        ).rejects.toThrow(/Brand with id/);

        const afterCount = await prisma.promotion.count();
        const afterTargetCount = await prisma.promotionTargetItem.count();
        expect(afterCount).toBe(beforeCount);
        expect(afterTargetCount).toBe(beforeTargetCount);
      });
    });
  },
);