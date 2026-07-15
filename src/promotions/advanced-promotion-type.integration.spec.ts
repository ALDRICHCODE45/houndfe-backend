/**
 * WU9 — Advanced promotion type end-to-end integration suite.
 *
 * Runs against the dedicated `nest-practice-test` database (port
 * 5433, NOT the dev DB). Validates that Slices 1+2 (engine +
 * persistence + sales routing + receipt mapper) wire together
 * correctly for the new ADVANCED promotion type end-to-end:
 *   - Promotion create via PromotionsService.create (full pipeline
 *     through `assertAdvancedSideTargets`).
 *   - Promotion load via the engine's repository (roundtrip through
 *     the real Prisma stack).
 *   - Engine `evaluate()` against seeded cart lines that match the
 *     BUY-side aggregate + GET-side cross-line path.
 *   - ORDER_DISCOUNT's base subtotal includes the ADVANCED saving
 *     (cross-line placement at `:284`, before ORDER at `:304`).
 *
 * Scenarios (named against spec.md):
 *   S1   category→product, aggregated BUY across multiple smaller
 *        lines (canonical Vela-A + Vela-B → Maceta-Large 50%)
 *   S2   multi-group: 6 BUY units, buyQuantity=3 → 2 reward
 *        applications on Holder-X (600c saving)
 *   S3   intake rejects same-entity BUY=[P1] / GET=[P1] with
 *        `advanced_overlapping_targets`, no row persisted
 *   S4   degenerate: BUY met, no GET line → no reward, no error
 *   S5   best-wins: ADVANCED 50% (500c) beats PD 20% (200c) on
 *        the same line; line carries `kind='advanced'`
 *   S6   100% free: ADVANCED with `getDiscountPercent=100` yields
 *        a free GET unit at 0c. qty≥2 on the GET side to satisfy
 *        the BXGY guard (`R < unitPrice × qty`).
 *   S7   ADVANCED saving flows into ORDER_DISCOUNT subtotal
 *
 * Test-DB isolation contract (mirrors `buy-x-get-y.integration.spec.ts`):
 *   - jest.integration.config.js + `--runInBand`
 *   - SKIP_DB_INTEGRATION=1 (or unset DATABASE_URL) → describe.skip
 *   - afterEach → `resetAndSeedBaseline()` so no spec pollutes the next
 *   - Global Category + Brand ids re-seeded post-reset (no tenantId).
 *
 * Run filtered: `pnpm run test:integration -- advanced-promotion-type.integration.spec.ts --runInBand`.
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
import {
  PromotionTargetTypeEnum,
  PromotionTypeEnum,
  PromotionMethodEnum,
} from './dto/create-promotion.dto';
import { Promotion } from './domain/promotion.entity';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;

const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

// Global Category + Brand ids — these tables have no tenantId so they
// survive the per-test TRUNCATE CASCADE. Names are unique across the
// integration suite to avoid `name` unique-constraint collisions
// against `buy-x-get-y.integration.spec.ts` (which also seeds global
// categories with non-unique names).
const CAT_HOME_DECOR_ID = 'aaaaaaaa-0000-0000-0000-00000000c001';
const CAT_CANDLES_ID = 'aaaaaaaa-0000-0000-0000-00000000c002';
const BR_HOME_ID = 'bbbbbbbb-0000-0000-0000-00000000b001';

describeIfDb(
  'advanced-promotion-type end-to-end (Integration - Real DB)',
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

      // Global models — upsert so the spec is idempotent on dirty DBs.
      // Names are unique across the integration suite to avoid
      // `name` unique-constraint collisions with
      // `buy-x-get-y.integration.spec.ts`.
      await prisma.category.upsert({
        where: { id: CAT_HOME_DECOR_ID },
        update: { name: 'ADV-int Home Decor' },
        create: { id: CAT_HOME_DECOR_ID, name: 'ADV-int Home Decor' },
      });
      await prisma.category.upsert({
        where: { id: CAT_CANDLES_ID },
        update: { name: 'ADV-int Candles' },
        create: { id: CAT_CANDLES_ID, name: 'ADV-int Candles' },
      });
      await prisma.brand.upsert({
        where: { id: BR_HOME_ID },
        update: { name: 'ADV-int HomeBrand' },
        create: { id: BR_HOME_ID, name: 'ADV-int HomeBrand' },
      });

      const tenant = await prisma.tenant.findFirst({ select: { id: true } });
      if (!tenant) throw new Error('No tenant — globalSetup must have seeded one.');
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
      await resetAndSeedBaseline();
      // Re-seed global refs after the tenant CASCADE.
      await prisma.category.upsert({
        where: { id: CAT_HOME_DECOR_ID },
        update: { name: 'ADV-int Home Decor' },
        create: { id: CAT_HOME_DECOR_ID, name: 'ADV-int Home Decor' },
      });
      await prisma.category.upsert({
        where: { id: CAT_CANDLES_ID },
        update: { name: 'ADV-int Candles' },
        create: { id: CAT_CANDLES_ID, name: 'ADV-int Candles' },
      });
      await prisma.brand.upsert({
        where: { id: BR_HOME_ID },
        update: { name: 'ADV-int HomeBrand' },
        create: { id: BR_HOME_ID, name: 'ADV-int HomeBrand' },
      });
    });

    afterAll(async () => {
      await prisma.$disconnect();
      await disconnectIntegrationPrisma();
    });

    // ── Fixtures ─────────────────────────────────────────────
    async function seedProduct(opts: {
      sku: string;
      categoryId?: string | null;
      brandId?: string | null;
    }): Promise<{ productId: string }> {
      const product = await prisma.product.create({
        data: {
          tenantId,
          name: `ADV ${opts.sku}`,
          sku: opts.sku,
          hasVariants: false,
          sellInPos: true,
          useStock: false,
          categoryId: opts.categoryId ?? null,
          brandId: opts.brandId ?? null,
        },
      });
      return { productId: product.id };
    }

    function id(s: string): string {
      return `adv-int-${s}-${'0'.repeat(36)}`.slice(0, 36);
    }

    /**
     * Build an ADVANCED Promotion and persist it via
     * `PromotionsService.create` so the full pipeline runs — including
     * `assertAdvancedSideTargets` (D7 disjoint guard + missing_targets
     * guard). Returns the saved Promotion.
     */
    async function createAdvanced(opts: {
      promoId: string;
      buyTargetType: 'CATEGORIES' | 'BRANDS' | 'PRODUCTS' | 'VARIANTS';
      getTargetType: 'CATEGORIES' | 'BRANDS' | 'PRODUCTS' | 'VARIANTS';
      buyTargetIds: string[];
      getTargetIds: string[];
      buyQuantity: number;
      getQuantity: number;
      getDiscountPercent: number;
      title?: string;
    }): Promise<Promotion> {
      const promo = Promotion.create({
        id: opts.promoId,
        title: opts.title ?? `ADVANCED ${opts.promoId.slice(-6)}`,
        type: 'ADVANCED',
        method: 'AUTOMATIC',
        buyQuantity: opts.buyQuantity,
        getQuantity: opts.getQuantity,
        getDiscountPercent: opts.getDiscountPercent,
        buyTargetType: opts.buyTargetType,
        getTargetType: opts.getTargetType,
      });
      promo.targetItems = [
        ...opts.buyTargetIds.map((tid) => ({
          id: id(`ti-buy-${tid}`),
          side: 'BUY' as const,
          targetType: opts.buyTargetType,
          targetId: tid,
        })),
        ...opts.getTargetIds.map((tid) => ({
          id: id(`ti-get-${tid}`),
          side: 'GET' as const,
          targetType: opts.getTargetType,
          targetId: tid,
        })),
      ];
      return service.create({
        title: promo.title,
        type: promo.type as PromotionTypeEnum,
        method: promo.method as PromotionMethodEnum,
        customerScope: 'ALL',
        buyQuantity: promo.buyQuantity,
        getQuantity: promo.getQuantity,
        getDiscountPercent: promo.getDiscountPercent,
        buyTargetType: promo.buyTargetType as PromotionTargetTypeEnum,
        getTargetType: promo.getTargetType as PromotionTargetTypeEnum,
        buyTargetItems: opts.buyTargetIds.map((tid) => ({ targetId: tid })),
        getTargetItems: opts.getTargetIds.map((tid) => ({ targetId: tid })),
      });
    }

    /**
     * Build a PRODUCT_DISCOUNT Promotion and persist it directly
     * (engine-only scenario — no need to round-trip through
     * `PromotionsService.create` for the per-line PD path).
     */
    async function seedPd(opts: {
      promoId: string;
      discountType: 'FIXED' | 'PERCENTAGE';
      discountValue: number;
      targetProductId: string;
    }): Promise<void> {
      const promo = Promotion.create({
        id: opts.promoId,
        title: `PD ${opts.promoId.slice(-6)}`,
        type: 'PRODUCT_DISCOUNT',
        method: 'AUTOMATIC',
        discountType: opts.discountType,
        discountValue: opts.discountValue,
        appliesTo: 'PRODUCTS',
      });
      promo.targetItems = [
        {
          id: id('ti-pd'),
          side: 'DEFAULT',
          targetType: 'PRODUCTS',
          targetId: opts.targetProductId,
        },
      ];
      await prisma.promotion.create({
        data: {
          id: promo.id,
          tenantId,
          title: promo.title,
          type: promo.type,
          method: promo.method,
          status: promo.status,
          customerScope: promo.customerScope,
          discountType: promo.discountType,
          discountValue: promo.discountValue,
          appliesTo: promo.appliesTo,
        },
      });
      await prisma.promotionTargetItem.create({
        data: {
          promotionId: promo.id,
          tenantId,
          side: 'DEFAULT',
          targetType: 'PRODUCTS',
          targetId: opts.targetProductId,
        },
      });
    }

    async function seedOrder(opts: {
      promoId: string;
      discountType: 'FIXED' | 'PERCENTAGE';
      discountValue: number;
    }): Promise<void> {
      await prisma.promotion.create({
        data: {
          id: opts.promoId,
          tenantId,
          title: `Order ${opts.promoId.slice(-6)}`,
          type: 'ORDER_DISCOUNT',
          method: 'AUTOMATIC',
          status: 'ACTIVE',
          customerScope: 'ALL',
          discountType: opts.discountType,
          discountValue: opts.discountValue,
        },
      });
    }

    // ────────────────────────────────────────────────────────
    // S1 — category→product, aggregated BUY across lines
    // ────────────────────────────────────────────────────────
    describe('S1 — category→product, aggregated BUY', () => {
      it('buy 3 from CAT_HOME_DECOR (Vela-A×2 + Vela-B×1) → 1 reward group on Maceta-Large at 50% (500c saving)', async () => {
        const velaA = await seedProduct({
          sku: 'ADV-S1-VELA-A',
          categoryId: CAT_HOME_DECOR_ID,
        });
        const velaB = await seedProduct({
          sku: 'ADV-S1-VELA-B',
          categoryId: CAT_HOME_DECOR_ID,
        });
        const maceta = await seedProduct({
          sku: 'ADV-S1-MACETA',
        });

        await createAdvanced({
          promoId: id('adv-s1'),
          buyTargetType: 'CATEGORIES',
          getTargetType: 'PRODUCTS',
          buyTargetIds: [CAT_HOME_DECOR_ID],
          getTargetIds: [maceta.productId],
          buyQuantity: 3,
          getQuantity: 1,
          getDiscountPercent: 50,
        });

        const result = await engine.evaluate({
          now: new Date(),
          customerId: null,
          lines: [
            {
              itemId: 'vela-a',
              productId: velaA.productId,
              variantId: null,
              quantity: 2,
              effectiveUnitPriceCents: 500,
              appliedPriceListId: null,
              appliedGlobalPriceListId: null,
              categoryId: CAT_HOME_DECOR_ID,
              brandId: null,
              hasManualDiscount: false,
            },
            {
              itemId: 'vela-b',
              productId: velaB.productId,
              variantId: null,
              quantity: 1,
              effectiveUnitPriceCents: 500,
              appliedPriceListId: null,
              appliedGlobalPriceListId: null,
              categoryId: CAT_HOME_DECOR_ID,
              brandId: null,
              hasManualDiscount: false,
            },
            {
              itemId: 'maceta',
              productId: maceta.productId,
              variantId: null,
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

        // Only the GET line carries the reward.
        expect(result.lines).toHaveLength(1);
        const line = result.lines[0];
        expect(line.itemId).toBe('maceta');
        expect(line.kind).toBe('advanced');
        if (line.kind === 'advanced') {
          expect(line.lineDiscountCents).toBe(500); // floor(3/3) × 1 × 500
          expect(line.discountedUnitCount).toBe(1);
          expect(line.perUnitRewardCents).toBe(500);
          expect(line.getDiscountPercent).toBe(50);
        }
      });
    });

    // ────────────────────────────────────────────────────────
    // S2 — multi-group: 6 BUY units, 2 reward applications
    // ────────────────────────────────────────────────────────
    describe('S2 — multi-group, 6 BUY units → 2 reward apps (600c)', () => {
      it('buy 3 from CANDLES (6 units) → 2 reward groups on Holder-X at 30% (600c saving)', async () => {
        const candle = await seedProduct({
          sku: 'ADV-S2-CANDLE',
          categoryId: CAT_CANDLES_ID,
        });
        const holder = await seedProduct({ sku: 'ADV-S2-HOLDER' });

        await createAdvanced({
          promoId: id('adv-s2'),
          buyTargetType: 'CATEGORIES',
          getTargetType: 'PRODUCTS',
          buyTargetIds: [CAT_CANDLES_ID],
          getTargetIds: [holder.productId],
          buyQuantity: 3,
          getQuantity: 1,
          getDiscountPercent: 30,
        });

        const result = await engine.evaluate({
          now: new Date(),
          customerId: null,
          lines: [
            {
              itemId: 'candle',
              productId: candle.productId,
              variantId: null,
              quantity: 6,
              effectiveUnitPriceCents: 200,
              appliedPriceListId: null,
              appliedGlobalPriceListId: null,
              categoryId: CAT_CANDLES_ID,
              brandId: null,
              hasManualDiscount: false,
            },
            {
              itemId: 'holder',
              productId: holder.productId,
              variantId: null,
              quantity: 3,
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

        expect(result.lines).toHaveLength(1);
        const line = result.lines[0];
        expect(line.itemId).toBe('holder');
        expect(line.kind).toBe('advanced');
        if (line.kind === 'advanced') {
          expect(line.lineDiscountCents).toBe(600); // 2 × 1 × 300
          expect(line.discountedUnitCount).toBe(2);
          expect(line.perUnitRewardCents).toBe(300);
        }
      });
    });

    // ────────────────────────────────────────────────────────
    // S3 — intake rejects same-entity BUY/GET (D7)
    // ────────────────────────────────────────────────────────
    describe('S3 — same-entity BUY/GET rejected at intake', () => {
      it('POST-style create with PRODUCTS [P1] BUY and PRODUCTS [P1] GET throws advanced_overlapping_targets and persists no promotion row', async () => {
        const p = await seedProduct({ sku: 'ADV-S3-P1' });

        const before = await prisma.promotion.count();

        await expect(
          service.create({
            title: 'Disjoint reject',
            type: 'ADVANCED' as PromotionTypeEnum,
            method: 'AUTOMATIC' as PromotionMethodEnum,
            customerScope: 'ALL',
            buyQuantity: 3,
            getQuantity: 1,
            getDiscountPercent: 50,
            buyTargetType: 'PRODUCTS' as PromotionTargetTypeEnum,
            getTargetType: 'PRODUCTS' as PromotionTargetTypeEnum,
            buyTargetItems: [{ targetId: p.productId }],
            getTargetItems: [{ targetId: p.productId }],
          }),
        ).rejects.toMatchObject({
          code: 'advanced_overlapping_targets',
          name: 'InvalidArgumentError',
        });

        const after = await prisma.promotion.count();
        expect(after).toBe(before);
      });
    });

    // ────────────────────────────────────────────────────────
    // S4 — degenerate: BUY met, no GET line
    // ────────────────────────────────────────────────────────
    describe('S4 — degenerate cart, BUY met, no GET line', () => {
      it('no reward, no error, lines=[] when the cart has no GET-side product line', async () => {
        const vela = await seedProduct({
          sku: 'ADV-S4-VELA',
          categoryId: CAT_HOME_DECOR_ID,
        });
        // The GET-side target product. The cart below does NOT include
        // a line for this product — that's the S4 trigger (engine
        // silently skips).
        const maceta = await seedProduct({ sku: 'ADV-S4-MACETA' });

        await createAdvanced({
          promoId: id('adv-s4'),
          buyTargetType: 'CATEGORIES',
          getTargetType: 'PRODUCTS',
          buyTargetIds: [CAT_HOME_DECOR_ID],
          getTargetIds: [maceta.productId],
          buyQuantity: 3,
          getQuantity: 1,
          getDiscountPercent: 50,
        });

        const result = await engine.evaluate({
          now: new Date(),
          customerId: null,
          lines: [
            {
              itemId: 'vela-1',
              productId: vela.productId,
              variantId: null,
              quantity: 3,
              effectiveUnitPriceCents: 500,
              appliedPriceListId: null,
              appliedGlobalPriceListId: null,
              categoryId: CAT_HOME_DECOR_ID,
              brandId: null,
              hasManualDiscount: false,
            },
            // No maceta line → degenerate.
          ],
          vetoedPromotionIds: [],
          optedInManualPromotionIds: [],
        });

        expect(result.lines).toEqual([]);
        expect(result.order).toBeNull();
        expect(result.availableManualPromotions).toEqual([]);
      });
    });

    // ────────────────────────────────────────────────────────
    // S5 — best-wins: ADVANCED 50% beats PD 20% on the same line
    // ────────────────────────────────────────────────────────
    describe('S5 — best-wins, ADVANCED 50% beats PD 20%', () => {
      it('on a single P1 line at 1000c/unit × qty 2, ADVANCED 500c > PD 200c → ADVANCED wins, kind=advanced', async () => {
        const p = await seedProduct({ sku: 'ADV-S5-P1' });

        await createAdvanced({
          promoId: id('adv-s5'),
          buyTargetType: 'CATEGORIES',
          getTargetType: 'PRODUCTS',
          buyTargetIds: [CAT_HOME_DECOR_ID],
          getTargetIds: [p.productId],
          buyQuantity: 1, // any 1 BUY unit triggers the reward
          getQuantity: 1,
          getDiscountPercent: 50, // 500c per unit
        });
        await seedPd({
          promoId: id('pd-s5'),
          discountType: 'PERCENTAGE',
          discountValue: 20, // 200c per unit
          targetProductId: p.productId,
        });

        const result = await engine.evaluate({
          now: new Date(),
          customerId: null,
          lines: [
            // Satisfies the BUY-side aggregate (1 × CAT_HOME_DECOR vela).
            {
              itemId: 'vela-trigger',
              productId: (await seedProduct({
                sku: 'ADV-S5-VELA',
                categoryId: CAT_HOME_DECOR_ID,
              })).productId,
              variantId: null,
              quantity: 1,
              effectiveUnitPriceCents: 100,
              appliedPriceListId: null,
              appliedGlobalPriceListId: null,
              categoryId: CAT_HOME_DECOR_ID,
              brandId: null,
              hasManualDiscount: false,
            },
            // The contested line — both ADVANCED and PD target P1.
            {
              itemId: 'p1',
              productId: p.productId,
              variantId: null,
              quantity: 2,
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

        const p1Result = result.lines.find((l) => l.itemId === 'p1');
        expect(p1Result).toBeDefined();
        expect(p1Result!.kind).toBe('advanced');
        if (p1Result!.kind === 'advanced') {
          expect(p1Result!.lineDiscountCents).toBe(500); // 1 × 500
        }
      });
    });

    // ────────────────────────────────────────────────────────
    // S6 — 100% free: ADVANCED with getDiscountPercent=100
    // qty≥2 on the GET side per the carry-forward guard note.
    // ────────────────────────────────────────────────────────
    describe('S6 — 100% free GET unit', () => {
      it('ADVANCED 100% yields a free unit on P1 (qty=2 satisfies R < unitPrice × qty)', async () => {
        const p = await seedProduct({ sku: 'ADV-S6-P1' });
        const vela = await seedProduct({
          sku: 'ADV-S6-VELA',
          categoryId: CAT_HOME_DECOR_ID,
        });

        await createAdvanced({
          promoId: id('adv-s6'),
          buyTargetType: 'CATEGORIES',
          getTargetType: 'PRODUCTS',
          buyTargetIds: [CAT_HOME_DECOR_ID],
          getTargetIds: [p.productId],
          buyQuantity: 3,
          getQuantity: 1,
          getDiscountPercent: 100,
        });

        const result = await engine.evaluate({
          now: new Date(),
          customerId: null,
          lines: [
            {
              itemId: 'vela',
              productId: vela.productId,
              variantId: null,
              quantity: 3,
              effectiveUnitPriceCents: 500,
              appliedPriceListId: null,
              appliedGlobalPriceListId: null,
              categoryId: CAT_HOME_DECOR_ID,
              brandId: null,
              hasManualDiscount: false,
            },
            {
              itemId: 'p1',
              productId: p.productId,
              variantId: null,
              quantity: 2, // ≥2 satisfies the BXGY guard at 100%
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

        const p1Result = result.lines.find((l) => l.itemId === 'p1');
        expect(p1Result).toBeDefined();
        expect(p1Result!.kind).toBe('advanced');
        if (p1Result!.kind === 'advanced') {
          // floor(3/3) × 1 × 1000 = 1000c saving on one free unit.
          expect(p1Result!.lineDiscountCents).toBe(1000);
          expect(p1Result!.getDiscountPercent).toBe(100);
        }
      });
    });

    // ────────────────────────────────────────────────────────
    // S6b — D3 4R-review defense-in-depth: 100% free at qty=1.
    //
    // S6 above uses qty=2 on the GET side, dodging the R==line edge
    // that FIX 1 (D3 / sale-item.entity.ts applyBuyXGetYReward guard
    // relaxed `>=` → `>`) made legitimate. The full-line-free qty=1
    // path is now the load-bearing edge for the POS "GRATIS" badge
    // on a single-unit reward line; without this end-to-end lock,
    // the D3 true-free scenario remains PARTIAL. This scenario runs
    // against Postgres :5433 and proves the engine emits a fully
    // free GET line (lineDiscountCents == unitPrice × qty == 1000c,
    // getDiscountPercent == 100, kind == 'advanced') so the wire
    // surfaces NET=0 downstream.
    //
    // Fixture SKU prefix `ADV-S6B-` to keep names unique against S6
    // and the rest of the integration suite (avoid the global
    // `name` unique-constraint collision on Product).
    // ────────────────────────────────────────────────────────
    describe('S6b — 100% free GET unit at qty=1 (D3 true-free edge)', () => {
      it('ADVANCED 100% on a single-unit GET line emits R == unitPrice × qty and kind=advanced', async () => {
        const p = await seedProduct({ sku: 'ADV-S6B-P1' });
        const vela = await seedProduct({
          sku: 'ADV-S6B-VELA',
          categoryId: CAT_HOME_DECOR_ID,
        });

        await createAdvanced({
          promoId: id('adv-s6b'),
          buyTargetType: 'CATEGORIES',
          getTargetType: 'PRODUCTS',
          buyTargetIds: [CAT_HOME_DECOR_ID],
          getTargetIds: [p.productId],
          buyQuantity: 1, // minimum trigger — a single BUY unit fires the reward
          getQuantity: 1,
          getDiscountPercent: 100,
        });

        const result = await engine.evaluate({
          now: new Date(),
          customerId: null,
          lines: [
            {
              itemId: 'vela',
              productId: vela.productId,
              variantId: null,
              quantity: 1, // 1 × 1 BUY unit satisfies buyQuantity=1
              effectiveUnitPriceCents: 500,
              appliedPriceListId: null,
              appliedGlobalPriceListId: null,
              categoryId: CAT_HOME_DECOR_ID,
              brandId: null,
              hasManualDiscount: false,
            },
            {
              itemId: 'p1',
              productId: p.productId,
              variantId: null,
              quantity: 1, // the D3 true-free edge: qty=1 @ 100% → R=unitPrice
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

        const p1Result = result.lines.find((l) => l.itemId === 'p1');
        expect(p1Result).toBeDefined();
        expect(p1Result!.kind).toBe('advanced');
        if (p1Result!.kind === 'advanced') {
          // floor(1/1) × 1 × 1000 = 1000c saving on one free unit —
          // the GET line is FULLY free (R == unitPrice × qty).
          expect(p1Result!.lineDiscountCents).toBe(1000);
          expect(p1Result!.perUnitRewardCents).toBe(1000);
          expect(p1Result!.discountedUnitCount).toBe(1);
          expect(p1Result!.getDiscountPercent).toBe(100);
        }
      });
    });

    // ────────────────────────────────────────────────────────
    // S7 — ADVANCED saving flows into ORDER_DISCOUNT subtotal
    // ────────────────────────────────────────────────────────
    describe('S7 — ADVANCED saving flows into ORDER_DISCOUNT subtotal', () => {
      it('post-line subtotal reflects the ADVANCED saving; ORDER_DISCOUNT base = subtotal - adv_saving', async () => {
        const p1 = await seedProduct({ sku: 'ADV-S7-P1' });
        const p2 = await seedProduct({ sku: 'ADV-S7-P2' });
        const vela = await seedProduct({
          sku: 'ADV-S7-VELA',
          categoryId: CAT_HOME_DECOR_ID,
        });

        await createAdvanced({
          promoId: id('adv-s7'),
          buyTargetType: 'CATEGORIES',
          getTargetType: 'PRODUCTS',
          buyTargetIds: [CAT_HOME_DECOR_ID],
          getTargetIds: [p1.productId],
          buyQuantity: 3,
          getQuantity: 1,
          getDiscountPercent: 50,
        });
        await seedOrder({
          promoId: id('order-s7'),
          discountType: 'PERCENTAGE',
          discountValue: 10,
        });

        const result = await engine.evaluate({
          now: new Date(),
          customerId: null,
          lines: [
            // BUY-side aggregate (3 × CAT_HOME_DECOR vela).
            {
              itemId: 'vela',
              productId: vela.productId,
              variantId: null,
              quantity: 3,
              effectiveUnitPriceCents: 500,
              appliedPriceListId: null,
              appliedGlobalPriceListId: null,
              categoryId: CAT_HOME_DECOR_ID,
              brandId: null,
              hasManualDiscount: false,
            },
            // GET-side line (carries ADVANCED reward).
            {
              itemId: 'p1',
              productId: p1.productId,
              variantId: null,
              quantity: 2, // ≥2 so the 50% × 1k = 500c saving fits the guard
              effectiveUnitPriceCents: 1000,
              appliedPriceListId: null,
              appliedGlobalPriceListId: null,
              categoryId: null,
              brandId: null,
              hasManualDiscount: false,
            },
            // Non-targeted line — full price feeds the ORDER subtotal.
            {
              itemId: 'p2',
              productId: p2.productId,
              variantId: null,
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

        // Cart math:
        //   vela line:  3 × 500 = 1500c (no line discount)
        //   p1 line:    2 × 1000 = 2000c − 500c (ADVANCED 50%) = 1500c
        //   p2 line:    1 × 1000 = 1000c (no line discount)
        //   post-line subtotal = 1500 + 1500 + 1000 = 4000c
        //   ORDER_DISCOUNT 10% = round(4000 × 10 / 100) = 400c
        expect(result.lines).toHaveLength(1);
        const p1Line = result.lines.find((l) => l.itemId === 'p1');
        expect(p1Line).toBeDefined();
        expect(p1Line!.kind).toBe('advanced');

        expect(result.order).not.toBeNull();
        expect(result.order!.promotionId).toBe(id('order-s7'));
        expect(result.order!.discountAmountCents).toBe(400);
      });
    });
  },
);
