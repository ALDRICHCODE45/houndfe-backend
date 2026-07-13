/**
 * WU7 — BUY_X_GET_Y integration sweep (spec.md:18-139).
 *
 * End-to-end coverage of all 18 scenarios in the buy-x-get-y v2 spec,
 * driven through the real Prisma stack against the dedicated
 * `nest-practice-test` database (port 5433). Single seeded tenant.
 *
 * Coverage map (scenario number = spec.md line-prefix; see spec for
 * full prose):
 *   BW-1   BUY_X_GET_Y beats a smaller per-line PRODUCT_DISCOUNT
 *   BW-2a  PD wins when PD total > BXGY total (case A)
 *   BW-2b  genuine cross-type TIE → BXGY when id lower (case B)
 *   BW-3   BXGY pass runs between per-line PD and ORDER_DISCOUNT
 *   T-1    BXGY without a target is rejected (create)
 *   T-2    Updating BXGY to clear its target is rejected
 *   T-3    BXGY with a valid PRODUCTS target is accepted
 *   E-1    Line below buyQuantity is not eligible
 *   E-2    Line at buyQuantity but below N+M yields zero reward
 *   E-3    Line at one full N+M group yields one reward group
 *   E-4    Line spanning multiple groups yields floor(Q/(N+M)) groups
 *   R-1    Per-unit Math.round rounding
 *   R-2    Non-matching line yields zero reward
 *   F-1    100% produces a true free get-unit; 50% renders NET
 *   M-1    AUTOMATIC BXGY auto-applies on recompute
 *   M-2    MANUAL BXGY appears in availableManualPromotions when ANY matching line
 *   M-3    MANUAL BXGY appears in targetableManualPromotionIds for a specific matching line
 *   M-4    Opted-in MANUAL BXGY survives recompute
 *   I-1    Five recomputes converge to identical totals
 *
 * Zero-migration invariant: `prisma migrate diff
 * --from-schema-datamodel prisma/schema.prisma
 * --to-schema-datasource prisma/schema.prisma` is empty after the
 * BXGY changes — verified separately in WU7 commit notes. The spec
 * rides the existing `discountType='amount'` + `discountAmountCents`
 * columns with a column-derived discriminator; no schema/enum/migration
 * changes.
 *
 * Run filtered: `pnpm run test:integration -- buy-x-get-y.integration.spec.ts`.
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

// Global Category + Brand ids — these tables have no tenantId so they
// survive the per-test TRUNCATE CASCADE. Two of each so the precedence
// scenarios have valid FK targets for non-matching products.
const CAT1_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BR1_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describeIfDb('buy-x-get-y end-to-end (Integration - Real DB)', () => {
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
    await prisma.category.upsert({
      where: { id: CAT1_ID },
      update: { name: 'Integration CAT1' },
      create: { id: CAT1_ID, name: 'Integration CAT1' },
    });
    await prisma.brand.upsert({
      where: { id: BR1_ID },
      update: { name: 'Integration BR1' },
      create: { id: BR1_ID, name: 'Integration BR1' },
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
    // Re-seed the global category/brand after the tenant CASCADE.
    await prisma.category.upsert({
      where: { id: CAT1_ID },
      update: { name: 'Integration CAT1' },
      create: { id: CAT1_ID, name: 'Integration CAT1' },
    });
    await prisma.brand.upsert({
      where: { id: BR1_ID },
      update: { name: 'Integration BR1' },
      create: { id: BR1_ID, name: 'Integration BR1' },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await disconnectIntegrationPrisma();
  });

  // ─────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────

  async function seedProduct(opts: {
    sku: string;
    categoryId?: string | null;
    brandId?: string | null;
  }): Promise<{ productId: string; variantId: string | null }> {
    const product = await prisma.product.create({
      data: {
        tenantId,
        name: `Integration ${opts.sku}`,
        sku: opts.sku,
        hasVariants: false,
        sellInPos: true,
        useStock: false,
        categoryId: opts.categoryId ?? null,
        brandId: opts.brandId ?? null,
      },
    });
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
        buyQuantity: p.buyQuantity,
        getQuantity: p.getQuantity,
        getDiscountPercent: p.getDiscountPercent,
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

  // Deterministic promo ids — keeps failure output readable and lets
  // us tie ids across assertions when needed.
  function id(s: string): string {
    // pad to a valid UUID-like string (Prisma will accept any unique string).
    return `bxgy-int-${s}-${'0'.repeat(36)}`.slice(0, 36);
  }

  function makeBxgy(overrides: {
    id: string;
    title?: string;
    method?: 'AUTOMATIC' | 'MANUAL';
    buyQuantity?: number;
    getQuantity?: number;
    getDiscountPercent?: number;
    targetProductId: string;
  }): Promotion {
    const promo = Promotion.create({
      id: overrides.id,
      title: overrides.title ?? `BXGY ${overrides.id.slice(-6)}`,
      type: 'BUY_X_GET_Y',
      method: overrides.method ?? 'AUTOMATIC',
      buyQuantity: overrides.buyQuantity ?? 2,
      getQuantity: overrides.getQuantity ?? 1,
      getDiscountPercent: overrides.getDiscountPercent ?? 50,
      appliesTo: 'PRODUCTS',
    });
    promo.targetItems = [{
      id: id('ti'),
      side: 'DEFAULT',
      targetType: 'PRODUCTS',
      targetId: overrides.targetProductId,
    }];
    return promo;
  }

  function makePd(overrides: {
    id: string;
    title?: string;
    discountType: 'FIXED' | 'PERCENTAGE';
    discountValue: number;
    targetProductId: string;
  }): Promotion {
    const promo = Promotion.create({
      id: overrides.id,
      title: overrides.title ?? `PD ${overrides.id.slice(-6)}`,
      type: 'PRODUCT_DISCOUNT',
      method: 'AUTOMATIC',
      discountType: overrides.discountType,
      discountValue: overrides.discountValue,
      appliesTo: 'PRODUCTS',
    });
    promo.targetItems = [{
      id: id('ti'),
      side: 'DEFAULT',
      targetType: 'PRODUCTS',
      targetId: overrides.targetProductId,
    }];
    return promo;
  }

  // ─────────────────────────────────────────────────────────────────
  // BW-1 — BXGY beats a smaller per-line PRODUCT_DISCOUNT (spec.md:24-27)
  // ─────────────────────────────────────────────────────────────────
  describe('BW-1 — BXGY beats a smaller per-line PRODUCT_DISCOUNT', () => {
    it('BXGY 1000c wins over PD 600c on the same line (no stacking)', async () => {
      const p = await seedProduct({ sku: 'INT-BW-1' });
      const bxgy = makeBxgy({
        id: id('bxgy-bw1'),
        targetProductId: p.productId,
        buyQuantity: 2,
        getQuantity: 1,
        getDiscountPercent: 50,
      });
      const pd = makePd({
        id: id('pd-bw1'),
        discountType: 'FIXED',
        discountValue: 100, // per-unit 100 × qty 6 = 600c
        targetProductId: p.productId,
      });
      await seedPromotion(bxgy);
      await seedPromotion(pd);

      const result = await engine.evaluate({
        now: new Date(),
        customerId: null,
        lines: [
          {
            itemId: 'item-1',
            productId: p.productId,
            variantId: null,
            quantity: 6,
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
      expect(result.lines[0].promotionId).toBe(bxgy.id);
      if (result.lines[0].kind === 'buy-x-get-y') {
        expect(result.lines[0].lineDiscountCents).toBe(1000);
      } else {
        fail('expected buy-x-get-y kind');
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // BW-2a — PD wins when PD total > BXGY (spec.md:29-32 case A)
  // ─────────────────────────────────────────────────────────────────
  describe('BW-2a — PD wins when PD total > BXGY total', () => {
    it('PD total 1500c beats BXGY total 500c on the same line', async () => {
      const p = await seedProduct({ sku: 'INT-BW-2A' });
      const bxgy = makeBxgy({
        id: id('bxgy-bw2a'),
        targetProductId: p.productId,
        buyQuantity: 2,
        getQuantity: 1,
        getDiscountPercent: 50, // qty 3 → 1 × 500c
      });
      const pd = makePd({
        id: id('pd-bw2a'),
        discountType: 'FIXED',
        discountValue: 500, // per-unit 500 × qty 3 = 1500c
        targetProductId: p.productId,
      });
      await seedPromotion(bxgy);
      await seedPromotion(pd);

      const result = await engine.evaluate({
        now: new Date(),
        customerId: null,
        lines: [
          {
            itemId: 'item-1',
            productId: p.productId,
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
      expect(result.lines[0].promotionId).toBe(pd.id);
      // PD line result has no `kind` discriminator → defaults to per-unit.
      expect(result.lines[0].kind ?? 'per-unit').toBe('per-unit');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // BW-2b — genuine cross-type TIE → BXGY when id lower (spec.md:29-32 case B)
  // ─────────────────────────────────────────────────────────────────
  describe('BW-2b — genuine cross-type TIE → BXGY when id lower', () => {
    it('PD 600c = BXGY 600c, BXGY.id < PD.id → BXGY wins on lowest id', async () => {
      const p = await seedProduct({ sku: 'INT-BW-2B' });
      // BXGY id 'aaa...' < PD id 'zzz...'
      const bxgy = makeBxgy({
        id: id('bxgy-bw2b-aaa'),
        targetProductId: p.productId,
        buyQuantity: 2,
        getQuantity: 1,
        getDiscountPercent: 30, // qty 6 → 2 × 300c = 600c
      });
      const pd = makePd({
        id: id('pd-bw2b-zzz'),
        discountType: 'FIXED',
        discountValue: 100, // per-unit 100 × qty 6 = 600c
        targetProductId: p.productId,
      });
      await seedPromotion(bxgy);
      await seedPromotion(pd);

      const result = await engine.evaluate({
        now: new Date(),
        customerId: null,
        lines: [
          {
            itemId: 'item-1',
            productId: p.productId,
            variantId: null,
            quantity: 6,
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
      expect(result.lines[0].promotionId).toBe(bxgy.id);
      expect(result.lines[0].kind).toBe('buy-x-get-y');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // BW-3 — BXGY pass runs between per-line PD and ORDER_DISCOUNT
  //        (spec.md:34-37)
  // ─────────────────────────────────────────────────────────────────
  describe('BW-3 — BXGY pass runs between per-line PD and ORDER_DISCOUNT', () => {
    it('post-line subtotal fed to ORDER_DISCOUNT reflects the BXGY saving', async () => {
      const p1 = await seedProduct({ sku: 'INT-BW-3-P1' });
      const p2 = await seedProduct({ sku: 'INT-BW-3-P2' });
      const bxgy = makeBxgy({
        id: id('bxgy-bw3'),
        targetProductId: p1.productId,
        buyQuantity: 2,
        getQuantity: 1,
        getDiscountPercent: 30, // qty 3 → 300c
      });
      const pd = makePd({
        id: id('pd-bw3'),
        discountType: 'FIXED',
        discountValue: 100,
        targetProductId: p2.productId,
      });
      // ORDER_DISCOUNT 10% on the post-line subtotal.
      const order = Promotion.create({
        id: id('order-bw3'),
        title: 'Order 10%',
        type: 'ORDER_DISCOUNT',
        method: 'AUTOMATIC',
        discountType: 'PERCENTAGE',
        discountValue: 10,
      });
      await seedPromotion(bxgy);
      await seedPromotion(pd);
      await seedPromotion(order);

      const result = await engine.evaluate({
        now: new Date(),
        customerId: null,
        lines: [
          {
            itemId: 'L1',
            productId: p1.productId,
            variantId: null,
            quantity: 3,
            effectiveUnitPriceCents: 1000,
            appliedPriceListId: null,
            appliedGlobalPriceListId: null,
            categoryId: null,
            brandId: null,
            hasManualDiscount: false,
          },
          {
            itemId: 'L2',
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

      // postLineSubtotal = (3000 - 300) + (1000 - 100) = 3600c
      // ORDER_DISCOUNT saving = round(3600 * 10 / 100) = 360c
      expect(result.order).not.toBeNull();
      expect(result.order!.promotionId).toBe(order.id);
      expect(result.order!.discountAmountCents).toBe(360);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // T-1 — BXGY without a target is rejected at create (spec.md:45-48)
  // ─────────────────────────────────────────────────────────────────
  describe('T-1 — BXGY without a target is rejected at create', () => {
    it('PromotionsService.create rejects with INVALID_TARGET and persists no row', async () => {
      const p = await seedProduct({ sku: 'INT-T-1' });
      const beforeCount = await prisma.promotion.count();

      await expect(
        service.create({
          title: 'Untargeted BXGY',
          type: 'BUY_X_GET_Y',
          method: 'AUTOMATIC',
          buyQuantity: 2,
          getQuantity: 1,
          getDiscountPercent: 100,
          appliesTo: 'PRODUCTS',
          targetItems: [], // empty — invalid
        } as never),
      ).rejects.toMatchObject({ code: 'INVALID_TARGET' });

      const afterCount = await prisma.promotion.count();
      expect(afterCount).toBe(beforeCount);
      // Note: we intentionally do not consume `p` here — it exists only
      // to confirm a valid target id exists for the rejected-when-empty
      // scenario.
      expect(p.productId).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // T-2 — Updating BXGY to clear its target is rejected (spec.md:50-53)
  // ─────────────────────────────────────────────────────────────────
  describe('T-2 — Updating BXGY to clear its target is rejected', () => {
    it('PromotionsService.update rejects with INVALID_TARGET and does not mutate', async () => {
      const p = await seedProduct({ sku: 'INT-T-2' });
      const bxgy = makeBxgy({
        id: id('bxgy-t2'),
        targetProductId: p.productId,
        getDiscountPercent: 100,
      });
      await seedPromotion(bxgy);

      // PATCH with empty targetItems — MUST be rejected.
      await expect(
        service.update(bxgy.id, { targetItems: [] } as never),
      ).rejects.toMatchObject({ code: 'INVALID_TARGET' });

      // Row unchanged — still has its targetItem.
      const persisted = await prisma.promotion.findUnique({
        where: { id: bxgy.id },
        include: { targetItems: true },
      });
      expect(persisted).not.toBeNull();
      expect(persisted!.targetItems).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // T-3 — BXGY with a valid PRODUCTS target is accepted (spec.md:55-58)
  // ─────────────────────────────────────────────────────────────────
  describe('T-3 — BXGY with a valid PRODUCTS target is accepted', () => {
    it('PromotionsService.create succeeds and the promotion is persisted', async () => {
      const p = await seedProduct({ sku: 'INT-T-3' });

      const result = await service.create({
        title: 'BXGY 2x1 on P1',
        type: 'BUY_X_GET_Y',
        method: 'AUTOMATIC',
        buyQuantity: 2,
        getQuantity: 1,
        getDiscountPercent: 100,
        appliesTo: 'PRODUCTS',
        targetItems: [{ targetType: 'PRODUCTS', targetId: p.productId }],
      } as never);

      expect(result.type).toBe('BUY_X_GET_Y');

      const persisted = await prisma.promotion.findUnique({
        where: { id: result.id },
        include: { targetItems: true },
      });
      expect(persisted).not.toBeNull();
      expect(persisted!.targetItems).toHaveLength(1);
      expect(persisted!.targetItems[0].targetType).toBe('PRODUCTS');
      expect(persisted!.targetItems[0].targetId).toBe(p.productId);
      expect(persisted!.getDiscountPercent).toBe(100); // 100 accepted for BXGY
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // E-1 — Line below buyQuantity is not eligible (spec.md:64-67)
  // ─────────────────────────────────────────────────────────────────
  describe('E-1 — Line below buyQuantity is not eligible', () => {
    it('qty 1 < N=2 → no per-line result emitted', async () => {
      const p = await seedProduct({ sku: 'INT-E-1' });
      const bxgy = makeBxgy({
        id: id('bxgy-e1'),
        targetProductId: p.productId,
        buyQuantity: 2,
        getQuantity: 1,
        getDiscountPercent: 50,
      });
      await seedPromotion(bxgy);

      const result = await engine.evaluate({
        now: new Date(),
        customerId: null,
        lines: [
          {
            itemId: 'item-1',
            productId: p.productId,
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

      expect(result.lines).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // E-2 — Line at buyQuantity but below N+M yields zero reward (spec.md:69-72)
  // ─────────────────────────────────────────────────────────────────
  describe('E-2 — Line at buyQuantity but below N+M yields zero reward', () => {
    it('qty 2 < N+M=3 → no per-line result emitted (floor zero)', async () => {
      const p = await seedProduct({ sku: 'INT-E-2' });
      const bxgy = makeBxgy({
        id: id('bxgy-e2'),
        targetProductId: p.productId,
        buyQuantity: 2,
        getQuantity: 1,
        getDiscountPercent: 50,
      });
      await seedPromotion(bxgy);

      const result = await engine.evaluate({
        now: new Date(),
        customerId: null,
        lines: [
          {
            itemId: 'item-1',
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

      expect(result.lines).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // E-3 — Line at one full N+M group yields one reward group (spec.md:74-77)
  // ─────────────────────────────────────────────────────────────────
  describe('E-3 — Line at one full N+M group yields one reward group', () => {
    it('qty 3, 1000c/unit, buy 2 get 1 @ 50% → R=500c', async () => {
      const p = await seedProduct({ sku: 'INT-E-3' });
      const bxgy = makeBxgy({
        id: id('bxgy-e3'),
        targetProductId: p.productId,
        buyQuantity: 2,
        getQuantity: 1,
        getDiscountPercent: 50,
      });
      await seedPromotion(bxgy);

      const result = await engine.evaluate({
        now: new Date(),
        customerId: null,
        lines: [
          {
            itemId: 'item-1',
            productId: p.productId,
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
      if (line.kind === 'buy-x-get-y') {
        expect(line.lineDiscountCents).toBe(500);
        expect(line.discountedUnitCount).toBe(1);
      } else {
        fail('expected buy-x-get-y kind');
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // E-4 — Multiple groups (spec.md:79-83)
  // ─────────────────────────────────────────────────────────────────
  describe('E-4 — Line spanning multiple groups yields floor(Q/(N+M)) groups', () => {
    it('qty 6, 1000c/unit, buy 2 get 1 @ 50% → R=1000c (2 groups)', async () => {
      const p = await seedProduct({ sku: 'INT-E-4' });
      const bxgy = makeBxgy({
        id: id('bxgy-e4'),
        targetProductId: p.productId,
        buyQuantity: 2,
        getQuantity: 1,
        getDiscountPercent: 50,
      });
      await seedPromotion(bxgy);

      const result = await engine.evaluate({
        now: new Date(),
        customerId: null,
        lines: [
          {
            itemId: 'item-1',
            productId: p.productId,
            variantId: null,
            quantity: 6,
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
      if (line.kind === 'buy-x-get-y') {
        expect(line.lineDiscountCents).toBe(1000);
        expect(line.discountedUnitCount).toBe(2);
      } else {
        fail('expected buy-x-get-y kind');
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // R-1 — Per-unit Math.round (spec.md:88-91)
  // ─────────────────────────────────────────────────────────────────
  describe('R-1 — Per-unit rounding follows Math.round', () => {
    it('qty 2, 100c/unit, buy 1 get 1 @ 33% → perUnit=33c, lineDiscount=33c', async () => {
      const p = await seedProduct({ sku: 'INT-R-1' });
      const bxgy = makeBxgy({
        id: id('bxgy-r1'),
        targetProductId: p.productId,
        buyQuantity: 1,
        getQuantity: 1,
        getDiscountPercent: 33,
      });
      await seedPromotion(bxgy);

      const result = await engine.evaluate({
        now: new Date(),
        customerId: null,
        lines: [
          {
            itemId: 'item-1',
            productId: p.productId,
            variantId: null,
            quantity: 2,
            effectiveUnitPriceCents: 100,
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
      if (line.kind === 'buy-x-get-y') {
        expect(line.perUnitRewardCents).toBe(33);
        expect(line.lineDiscountCents).toBe(33);
      } else {
        fail('expected buy-x-get-y kind');
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // R-2 — Non-matching line yields zero reward (spec.md:93-96)
  // ─────────────────────────────────────────────────────────────────
  describe('R-2 — Non-matching line yields zero reward', () => {
    it('P1-targeted BXGY applies to P1 line (qty 3) only, P2 line yields zero', async () => {
      const p1 = await seedProduct({ sku: 'INT-R-2-P1' });
      const p2 = await seedProduct({ sku: 'INT-R-2-P2' });
      const bxgy = makeBxgy({
        id: id('bxgy-r2'),
        targetProductId: p1.productId,
        buyQuantity: 2,
        getQuantity: 1,
        getDiscountPercent: 50,
      });
      await seedPromotion(bxgy);

      const result = await engine.evaluate({
        now: new Date(),
        customerId: null,
        lines: [
          {
            itemId: 'item-P1',
            productId: p1.productId,
            variantId: null,
            quantity: 3,
            effectiveUnitPriceCents: 1000,
            appliedPriceListId: null,
            appliedGlobalPriceListId: null,
            categoryId: null,
            brandId: null,
            hasManualDiscount: false,
          },
          {
            itemId: 'item-P2',
            productId: p2.productId,
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
      expect(result.lines[0].itemId).toBe('item-P1');
      expect(result.lines[0].promotionId).toBe(bxgy.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // F-1 — 100% produces a true free get-unit (spec.md:102-106)
  //      Both case A (100%) and case B (50%) verified in one spec.
  // ─────────────────────────────────────────────────────────────────
  describe('F-1 — 100% produces a true free get-unit; partial percentages render NET', () => {
    it('case A (100%): getDiscountPercent=100 is ACCEPTED for BXGY → R=1000c', async () => {
      const p = await seedProduct({ sku: 'INT-F-1-100' });
      const bxgy = makeBxgy({
        id: id('bxgy-f1-100'),
        targetProductId: p.productId,
        buyQuantity: 2,
        getQuantity: 1,
        getDiscountPercent: 100, // 100 is the new BXGY-only cap (spec.md Q6)
      });
      await seedPromotion(bxgy);

      const result = await engine.evaluate({
        now: new Date(),
        customerId: null,
        lines: [
          {
            itemId: 'item-1',
            productId: p.productId,
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
      if (line.kind === 'buy-x-get-y') {
        // perUnit=round(1000*100/100)=1000; lineDiscount=1*1000=1000.
        expect(line.perUnitRewardCents).toBe(1000);
        expect(line.lineDiscountCents).toBe(1000);
      } else {
        fail('expected buy-x-get-y kind');
      }
    });

    it('case B (50%): partial percentage uses the same BXGY reward shape', async () => {
      const p = await seedProduct({ sku: 'INT-F-1-50' });
      const bxgy = makeBxgy({
        id: id('bxgy-f1-50'),
        targetProductId: p.productId,
        buyQuantity: 2,
        getQuantity: 1,
        getDiscountPercent: 50,
      });
      await seedPromotion(bxgy);

      const result = await engine.evaluate({
        now: new Date(),
        customerId: null,
        lines: [
          {
            itemId: 'item-1',
            productId: p.productId,
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
      if (line.kind === 'buy-x-get-y') {
        expect(line.perUnitRewardCents).toBe(500);
        expect(line.lineDiscountCents).toBe(500);
      } else {
        fail('expected buy-x-get-y kind');
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // M-1 — AUTOMATIC BXGY auto-applies on recompute (spec.md:112-115)
  // ─────────────────────────────────────────────────────────────────
  describe('M-1 — AUTOMATIC BXGY auto-applies on recompute', () => {
    it('engine emits the per-line BXGY reward for an AUTO promo with a matching line', async () => {
      const p = await seedProduct({ sku: 'INT-M-1' });
      const bxgy = makeBxgy({
        id: id('bxgy-m1'),
        targetProductId: p.productId,
        method: 'AUTOMATIC',
        buyQuantity: 2,
        getQuantity: 1,
        getDiscountPercent: 50,
      });
      await seedPromotion(bxgy);

      const result = await engine.evaluate({
        now: new Date(),
        customerId: null,
        lines: [
          {
            itemId: 'item-1',
            productId: p.productId,
            variantId: null,
            quantity: 6,
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
      expect(result.lines[0].promotionId).toBe(bxgy.id);
      expect(result.lines[0].kind).toBe('buy-x-get-y');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // M-2 — MANUAL BXGY appears in availableManualPromotions (spec.md:117-120)
  // ─────────────────────────────────────────────────────────────────
  describe('M-2 — MANUAL BXGY appears in availableManualPromotions when ANY matching line', () => {
    it('a MANUAL BXGY is surfaced with type BUY_X_GET_Y when a line matches', async () => {
      const p = await seedProduct({ sku: 'INT-M-2' });
      const bxgy = makeBxgy({
        id: id('bxgy-m2'),
        targetProductId: p.productId,
        method: 'MANUAL',
        buyQuantity: 2,
        getQuantity: 1,
        getDiscountPercent: 50,
      });
      await seedPromotion(bxgy);

      const result = await engine.evaluate({
        now: new Date(),
        customerId: null,
        lines: [
          {
            itemId: 'item-1',
            productId: p.productId,
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
        optedInManualPromotionIds: [], // not opted-in
      });

      // NOT applied.
      expect(result.lines).toEqual([]);
      // BUT surfaced as a candidate with type BUY_X_GET_Y.
      expect(result.availableManualPromotions).toHaveLength(1);
      expect(result.availableManualPromotions[0].id).toBe(bxgy.id);
      expect(result.availableManualPromotions[0].type).toBe('BUY_X_GET_Y');
      expect(result.availableManualPromotions[0].method).toBe('MANUAL');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // M-3 — MANUAL BXGY appears in targetableManualPromotionIds (spec.md:122-125)
  // ─────────────────────────────────────────────────────────────────
  describe('M-3 — MANUAL BXGY appears in targetableManualPromotionIds for a matching line', () => {
    it('opted-in MANUAL BXGY with a matching line is in targetableManualPromotionIds', async () => {
      const p = await seedProduct({ sku: 'INT-M-3' });
      const bxgy = makeBxgy({
        id: id('bxgy-m3'),
        targetProductId: p.productId,
        method: 'MANUAL',
        buyQuantity: 2,
        getQuantity: 1,
        getDiscountPercent: 50,
      });
      await seedPromotion(bxgy);

      const result = await engine.evaluate({
        now: new Date(),
        customerId: null,
        lines: [
          {
            itemId: 'item-1',
            productId: p.productId,
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
        optedInManualPromotionIds: [bxgy.id], // opted-in
      });

      // Applied (BXGY kind) AND retained in targetable list.
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0].promotionId).toBe(bxgy.id);
      expect(result.lines[0].kind).toBe('buy-x-get-y');
      expect(result.targetableManualPromotionIds).toContain(bxgy.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // M-4 — Opted-in MANUAL BXGY survives recompute (spec.md:127-130)
  //
  // We exercise this via two engine.evaluate() calls on the same
  // opted-in id; the self-heal retention rule keeps the id in
  // targetableManualPromotionIds across both, and the line result is
  // emitted on both (when qty >= buyQuantity).
  // ─────────────────────────────────────────────────────────────────
  describe('M-4 — Opted-in MANUAL BXGY survives recompute', () => {
    it('two consecutive engine.evaluate calls keep the opted-in MANUAL BXGY applied', async () => {
      const p = await seedProduct({ sku: 'INT-M-4' });
      const bxgy = makeBxgy({
        id: id('bxgy-m4'),
        targetProductId: p.productId,
        method: 'MANUAL',
        buyQuantity: 2,
        getQuantity: 1,
        getDiscountPercent: 50,
      });
      await seedPromotion(bxgy);

      const input: PosEvalInput = {
        now: new Date(),
        customerId: null,
        lines: [
          {
            itemId: 'item-1',
            productId: p.productId,
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
        optedInManualPromotionIds: [bxgy.id],
      };

      const first = await engine.evaluate(input);
      const second = await engine.evaluate(input);

      // Applied on BOTH recomputes — qty 3 still meets the threshold.
      expect(first.lines).toHaveLength(1);
      expect(first.lines[0].promotionId).toBe(bxgy.id);
      expect(first.lines[0].kind).toBe('buy-x-get-y');
      expect(first.targetableManualPromotionIds).toContain(bxgy.id);

      expect(second.lines).toHaveLength(1);
      expect(second.lines[0].promotionId).toBe(bxgy.id);
      expect(second.lines[0].kind).toBe('buy-x-get-y');
      expect(second.targetableManualPromotionIds).toContain(bxgy.id);

      // The reward is byte-equal across the two calls (idempotency).
      expect(second.lines[0]).toEqual(first.lines[0]);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // I-1 — Five recomputes converge to identical totals (spec.md:132-139)
  //
  // Engine is pure (no I/O), so five evaluate() calls on the same
  // input MUST produce byte-equal line results. The wire-format reward
  // is the contract under test.
  // ─────────────────────────────────────────────────────────────────
  describe('I-1 — Five recomputes converge to identical totals', () => {
    it('five engine.evaluate calls on the same input produce byte-equal BXGY results', async () => {
      const p = await seedProduct({ sku: 'INT-I-1' });
      const bxgy = makeBxgy({
        id: id('bxgy-i1'),
        targetProductId: p.productId,
        buyQuantity: 2,
        getQuantity: 1,
        getDiscountPercent: 50,
      });
      await seedPromotion(bxgy);

      const input: PosEvalInput = {
        now: new Date(),
        customerId: null,
        lines: [
          {
            itemId: 'item-1',
            productId: p.productId,
            variantId: null,
            quantity: 6,
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
      };

      const results = await Promise.all([
        engine.evaluate(input),
        engine.evaluate(input),
        engine.evaluate(input),
        engine.evaluate(input),
        engine.evaluate(input),
      ]);

      // All five runs MUST be byte-equal.
      const firstLine = results[0].lines[0];
      for (let i = 1; i < 5; i++) {
        expect(results[i].lines).toHaveLength(1);
        expect(results[i].lines[0]).toEqual(firstLine);
      }
      // Sanity: qty 6 × 1000c = 6000c pre-discount; R = 1000c.
      if (firstLine.kind === 'buy-x-get-y') {
        expect(firstLine.lineDiscountCents).toBe(1000);
        expect(firstLine.discountedUnitCount).toBe(2);
      } else {
        fail('expected buy-x-get-y kind');
      }
    });
  });
});
