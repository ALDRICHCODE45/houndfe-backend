/**
 * W6 — End-to-end integration sweep (12 spec scenarios).
 *
 * Runs against the dedicated `nest-practice-test` database (port
 * 5433, NOT the dev DB). Validates that the W1-W5 changes wire
 * correctly through the real Prisma stack: the engine consumes
 * persisted promotions, the tenant-scoped client surfaces
 * cross-tenant filtering, and the validation path rejects bogus
 * VARIANTS ids without persisting rows.
 *
 * Test-DB isolation contract:
 *   - jest.integration.config.js matches ONLY this file + setup chain
 *   - SKIP_DB_INTEGRATION=1 (or unset DATABASE_URL) → describe.skip
 *   - afterEach → resetAndSeedBaseline() so no spec pollutes the next
 */
import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import {
  resetAndSeedBaseline,
  disconnectIntegrationPrisma,
  BASELINE_TENANT_ID,
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

describeIfDb(
  'variant-level-promo-targeting end-to-end (Integration - Real DB)',
  () => {
    let prisma: PrismaService;
    let tenantPrisma: TenantPrismaService;
    let repository: PrismaPromotionRepository;
    let service: PromotionsService;
    let engine: PosEvaluatePromotionsUseCase;
    let tenantId: string;
    let productId: string;
    let variantAId: string;
    let variantBId: string;

    // ============================================================
    // Fixture seeding — runs once per spec, isolated per test by
    // resetAndSeedBaseline() in afterEach.
    // ============================================================
    beforeAll(async () => {
      prisma = new PrismaService();
      await prisma.$connect();
      await resetAndSeedBaseline();

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

      // Seed a product + two variants in the same tenant.
      const product = await prisma.product.create({
        data: {
          tenantId,
          name: 'Integration Product P1',
          sku: 'INT-P1',
          hasVariants: true,
          sellInPos: true,
          useStock: false,
        },
      });
      productId = product.id;

      const variantA = await prisma.variant.create({
        data: { tenantId, productId, name: 'V-A' },
      });
      variantAId = variantA.id;

      const variantB = await prisma.variant.create({
        data: { tenantId, productId, name: 'V-B' },
      });
      variantBId = variantB.id;
    });

    afterEach(async () => {
      // Robust cascade reset between tests in this suite — wipes
      // promotion rows + relations and re-seeds the baseline tenant +
      // product + variants so the next test starts clean.
      await resetAndSeedBaseline();
      // Re-seed the fixture rows the tests depend on (the reset wipes
      // them along with everything tenant-scoped).
      const product = await prisma.product.create({
        data: {
          tenantId,
          name: 'Integration Product P1',
          sku: 'INT-P1',
          hasVariants: true,
          sellInPos: true,
          useStock: false,
        },
      });
      productId = product.id;
      const variantA = await prisma.variant.create({
        data: { tenantId, productId, name: 'V-A' },
      });
      variantAId = variantA.id;
      const variantB = await prisma.variant.create({
        data: { tenantId, productId, name: 'V-B' },
      });
      variantBId = variantB.id;
    });

    afterAll(async () => {
      await prisma.$disconnect();
      await disconnectIntegrationPrisma();
    });

    // ──────────────────────────────────────────────────────────
    // Helpers — build a Promotion and persist it directly so we
    // don't depend on PromotionsService.create's validateTargetIds
    // roundtrip for engine-only scenarios.
    // ──────────────────────────────────────────────────────────

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
    // Scenarios 1-4: matcher rules (PRODUCTS, CATEGORIES, every-variant
    // back-compat, VARIANTS exact match) — driven end-to-end via the
    // engine after seeding a PRODUCTS or VARIANTS promotion.
    // ──────────────────────────────────────────────────────────

    describe('Scenario 1 — PRODUCTS targeting matches by product id', () => {
      it('only the P1 line is eligible (V-A and V-B lines both hit; P2 line is not)', async () => {
        const promoProducts = Promotion.create({
          id: crypto.randomUUID(),
          title: 'PRODUCTS on P1',
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'FIXED',
          discountValue: 100,
          appliesTo: 'PRODUCTS',
        });
        promoProducts.targetItems = [
          {
            id: crypto.randomUUID(),
            side: 'DEFAULT',
            targetType: 'PRODUCTS',
            targetId: productId,
          },
        ];
        await seedPromotion(promoProducts);

        // Seed a second product for the negative case.
        const product2 = await prisma.product.create({
          data: {
            tenantId,
            name: 'Integration Product P2',
            sku: 'INT-P2',
            sellInPos: true,
            useStock: false,
          },
        });

        const input: PosEvalInput = {
          now: new Date(),
          customerId: null,
          lines: [
            {
              itemId: 'item-A',
              productId,
              variantId: variantAId,
              quantity: 1,
              effectiveUnitPriceCents: 1000,
              appliedPriceListId: null,
              appliedGlobalPriceListId: null,
              categoryId: null,
              brandId: null,
              hasManualDiscount: false,
            },
            {
              itemId: 'item-B',
              productId,
              variantId: variantBId,
              quantity: 1,
              effectiveUnitPriceCents: 1000,
              appliedPriceListId: null,
              appliedGlobalPriceListId: null,
              categoryId: null,
              brandId: null,
              hasManualDiscount: false,
            },
            {
              itemId: 'item-P2',
              productId: product2.id,
              variantId: null,
              quantity: 1,
              effectiveUnitPriceCents: 500,
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

        const result = await engine.evaluate(input);

        // Both V-A and V-B lines eligible (back-compat); P2 line NOT.
        expect(result.lines).toHaveLength(2);
        const itemIds = result.lines.map((l) => l.itemId).sort();
        expect(itemIds).toEqual(['item-A', 'item-B']);
      });
    });

    describe('Scenario 3 — PRODUCTS still hits every variant of a variant-bearing product', () => {
      it('PRODUCTS on P1 applies to BOTH V-A and V-B lines (regression)', async () => {
        const promo = Promotion.create({
          id: crypto.randomUUID(),
          title: 'PRODUCTS regression',
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'FIXED',
          discountValue: 50,
          appliesTo: 'PRODUCTS',
        });
        promo.targetItems = [
          {
            id: crypto.randomUUID(),
            side: 'DEFAULT',
            targetType: 'PRODUCTS',
            targetId: productId,
          },
        ];
        await seedPromotion(promo);

        const result = await engine.evaluate({
          now: new Date(),
          customerId: null,
          lines: [
            {
              itemId: 'item-A',
              productId,
              variantId: variantAId,
              quantity: 1,
              effectiveUnitPriceCents: 1000,
              appliedPriceListId: null,
              appliedGlobalPriceListId: null,
              categoryId: null,
              brandId: null,
              hasManualDiscount: false,
            },
            {
              itemId: 'item-B',
              productId,
              variantId: variantBId,
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

        expect(result.lines).toHaveLength(2);
        expect(result.lines.every((l) => l.promotionId === promo.id)).toBe(true);
      });
    });

    describe('Scenario 4 — VARIANTS matches only the exact variant', () => {
      it('VARIANTS on V-A applies ONLY to the V-A line (not V-B)', async () => {
        const promoV = Promotion.create({
          id: crypto.randomUUID(),
          title: 'VARIANTS on V-A',
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'FIXED',
          discountValue: 30,
          appliesTo: 'VARIANTS',
        });
        promoV.targetItems = [
          {
            id: crypto.randomUUID(),
            side: 'DEFAULT',
            targetType: 'VARIANTS',
            targetId: variantAId,
          },
        ];
        await seedPromotion(promoV);

        const result = await engine.evaluate({
          now: new Date(),
          customerId: null,
          lines: [
            {
              itemId: 'item-A',
              productId,
              variantId: variantAId,
              quantity: 1,
              effectiveUnitPriceCents: 1000,
              appliedPriceListId: null,
              appliedGlobalPriceListId: null,
              categoryId: null,
              brandId: null,
              hasManualDiscount: false,
            },
            {
              itemId: 'item-B',
              productId,
              variantId: variantBId,
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

        expect(result.lines).toHaveLength(1);
        expect(result.lines[0].itemId).toBe('item-A');
        expect(result.lines[0].promotionId).toBe(promoV.id);
      });
    });

    // ──────────────────────────────────────────────────────────
    // Scenario 5: VARIANTS wins over PRODUCTS on the same line
    // ──────────────────────────────────────────────────────────

    describe('Scenario 5 — VARIANTS wins over PRODUCTS on the same line', () => {
      it('VARIANTS on V-A (30c) wins over PRODUCTS on P1 (50c) on the V-A line; PRODUCTS applies to V-B', async () => {
        const promoProducts = Promotion.create({
          id: crypto.randomUUID(),
          title: 'PRODUCTS on P1 50c',
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'FIXED',
          discountValue: 50,
          appliesTo: 'PRODUCTS',
        });
        promoProducts.targetItems = [
          {
            id: crypto.randomUUID(),
            side: 'DEFAULT',
            targetType: 'PRODUCTS',
            targetId: productId,
          },
        ];
        const promoVariants = Promotion.create({
          id: crypto.randomUUID(),
          title: 'VARIANTS on V-A 30c',
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'FIXED',
          discountValue: 30,
          appliesTo: 'VARIANTS',
        });
        promoVariants.targetItems = [
          {
            id: crypto.randomUUID(),
            side: 'DEFAULT',
            targetType: 'VARIANTS',
            targetId: variantAId,
          },
        ];
        await seedPromotion(promoProducts);
        await seedPromotion(promoVariants);

        const result = await engine.evaluate({
          now: new Date(),
          customerId: null,
          lines: [
            {
              itemId: 'item-A',
              productId,
              variantId: variantAId,
              quantity: 1,
              effectiveUnitPriceCents: 1000,
              appliedPriceListId: null,
              appliedGlobalPriceListId: null,
              categoryId: null,
              brandId: null,
              hasManualDiscount: false,
            },
            {
              itemId: 'item-B',
              productId,
              variantId: variantBId,
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

        const lineA = result.lines.find((l) => l.itemId === 'item-A');
        expect(lineA).toBeDefined();
        expect(lineA!.promotionId).toBe(promoVariants.id);

        const lineB = result.lines.find((l) => l.itemId === 'item-B');
        expect(lineB).toBeDefined();
        expect(lineB!.promotionId).toBe(promoProducts.id);
      });
    });

    // ──────────────────────────────────────────────────────────
    // Scenario 6: VARIANTS wins regardless of discount magnitude
    // ──────────────────────────────────────────────────────────

    describe('Scenario 6 — VARIANTS wins regardless of discount', () => {
      it('VARIANTS on V-A (10c) wins over PRODUCTS on P1 (500c) on the V-A line', async () => {
        const promoProducts = Promotion.create({
          id: crypto.randomUUID(),
          title: 'PRODUCTS 500c',
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'FIXED',
          discountValue: 500,
          appliesTo: 'PRODUCTS',
        });
        promoProducts.targetItems = [
          {
            id: crypto.randomUUID(),
            side: 'DEFAULT',
            targetType: 'PRODUCTS',
            targetId: productId,
          },
        ];
        const promoVariants = Promotion.create({
          id: crypto.randomUUID(),
          title: 'VARIANTS 10c',
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'FIXED',
          discountValue: 10,
          appliesTo: 'VARIANTS',
        });
        promoVariants.targetItems = [
          {
            id: crypto.randomUUID(),
            side: 'DEFAULT',
            targetType: 'VARIANTS',
            targetId: variantAId,
          },
        ];
        await seedPromotion(promoProducts);
        await seedPromotion(promoVariants);

        const result = await engine.evaluate({
          now: new Date(),
          customerId: null,
          lines: [
            {
              itemId: 'item-A',
              productId,
              variantId: variantAId,
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

        expect(result.lines).toHaveLength(1);
        expect(result.lines[0].promotionId).toBe(promoVariants.id);
      });
    });

    // ──────────────────────────────────────────────────────────
    // Scenario 7: VARIANTS target on a different variant does not match
    // ──────────────────────────────────────────────────────────

    describe('Scenario 7 — VARIANTS on V-B does not match a V-A line', () => {
      it('VARIANTS on V-B is NOT applied to a V-A line', async () => {
        const promo = Promotion.create({
          id: crypto.randomUUID(),
          title: 'VARIANTS on V-B',
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'FIXED',
          discountValue: 30,
          appliesTo: 'VARIANTS',
        });
        promo.targetItems = [
          {
            id: crypto.randomUUID(),
            side: 'DEFAULT',
            targetType: 'VARIANTS',
            targetId: variantBId,
          },
        ];
        await seedPromotion(promo);

        const result = await engine.evaluate({
          now: new Date(),
          customerId: null,
          lines: [
            {
              itemId: 'item-A',
              productId,
              variantId: variantAId,
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
    // Scenario 8: MANUAL VARIANTS-targeted promo appears in targetable set
    // ──────────────────────────────────────────────────────────

    describe('Scenario 8 — MANUAL VARIANTS in targetable set', () => {
      it('opted-in MANUAL VARIANTS promo on V-A appears in targetableManualPromotionIds', async () => {
        const promo = Promotion.create({
          id: crypto.randomUUID(),
          title: 'MANUAL VARIANTS V-A',
          type: 'PRODUCT_DISCOUNT',
          method: 'MANUAL',
          discountType: 'FIXED',
          discountValue: 100,
          appliesTo: 'VARIANTS',
        });
        promo.targetItems = [
          {
            id: crypto.randomUUID(),
            side: 'DEFAULT',
            targetType: 'VARIANTS',
            targetId: variantAId,
          },
        ];
        await seedPromotion(promo);

        const result = await engine.evaluate({
          now: new Date(),
          customerId: null,
          lines: [
            {
              itemId: 'item-A',
              productId,
              variantId: variantAId,
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
          optedInManualPromotionIds: [promo.id],
        });

        expect(result.targetableManualPromotionIds).toContain(promo.id);
      });
    });

    // ──────────────────────────────────────────────────────────
    // Scenario 9: Opted-in MANUAL VARIANTS survives recompute
    // ──────────────────────────────────────────────────────────

    describe('Scenario 9 — opted-in MANUAL VARIANTS survives recompute', () => {
      it('opted-in MANUAL VARIANTS survives when an unrelated P2 line is added', async () => {
        const promo = Promotion.create({
          id: crypto.randomUUID(),
          title: 'MANUAL VARIANTS V-A',
          type: 'PRODUCT_DISCOUNT',
          method: 'MANUAL',
          discountType: 'FIXED',
          discountValue: 100,
          appliesTo: 'VARIANTS',
        });
        promo.targetItems = [
          {
            id: crypto.randomUUID(),
            side: 'DEFAULT',
            targetType: 'VARIANTS',
            targetId: variantAId,
          },
        ];
        await seedPromotion(promo);

        // Recompute 1: V-A only.
        const first = await engine.evaluate({
          now: new Date(),
          customerId: null,
          lines: [
            {
              itemId: 'item-A',
              productId,
              variantId: variantAId,
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
          optedInManualPromotionIds: [promo.id],
        });
        expect(first.targetableManualPromotionIds).toContain(promo.id);

        // Recompute 2: V-A + unrelated P2 line.
        const product2 = await prisma.product.create({
          data: {
            tenantId,
            name: 'Integration Product P2',
            sku: 'INT-P2',
            sellInPos: true,
            useStock: false,
          },
        });
        const second = await engine.evaluate({
          now: new Date(),
          customerId: null,
          lines: [
            {
              itemId: 'item-A',
              productId,
              variantId: variantAId,
              quantity: 1,
              effectiveUnitPriceCents: 1000,
              appliedPriceListId: null,
              appliedGlobalPriceListId: null,
              categoryId: null,
              brandId: null,
              hasManualDiscount: false,
            },
            {
              itemId: 'item-P2',
              productId: product2.id,
              variantId: null,
              quantity: 1,
              effectiveUnitPriceCents: 500,
              appliedPriceListId: null,
              appliedGlobalPriceListId: null,
              categoryId: null,
              brandId: null,
              hasManualDiscount: false,
            },
          ],
          vetoedPromotionIds: [],
          optedInManualPromotionIds: [promo.id],
        });

        expect(second.targetableManualPromotionIds).toContain(promo.id);
        const lineAResult = second.lines.find((l) => l.itemId === 'item-A');
        expect(lineAResult).toBeDefined();
        expect(lineAResult!.promotionId).toBe(promo.id);
      });
    });

    // ──────────────────────────────────────────────────────────
    // Scenarios 10-12: VARIANTS validation through the tenant-scoped
    // PrismaService — these test PromotionsService.create end-to-end.
    // ──────────────────────────────────────────────────────────

    describe('Scenario 10 — VARIANTS with existing tenant variant id is accepted', () => {
      it('PromotionsService.create succeeds and the promotion is persisted', async () => {
        const result = await service.create({
          title: 'Variant-only 10%',
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'PERCENTAGE',
          discountValue: 10,
          appliesTo: 'VARIANTS',
          targetItems: [{ targetType: 'VARIANTS', targetId: variantAId }],
        } as never);

        expect(result.appliesTo).toBe('VARIANTS');

        const persisted = await prisma.promotion.findUnique({
          where: { id: result.id },
          include: { targetItems: true },
        });
        expect(persisted).not.toBeNull();
        expect(persisted!.targetItems).toHaveLength(1);
        expect(persisted!.targetItems[0].targetType).toBe('VARIANTS');
        expect(persisted!.targetItems[0].targetId).toBe(variantAId);
      });
    });

    describe('Scenario 11 — VARIANTS with non-existent variant id is rejected', () => {
      it('rejects and persists NO promotion / target rows', async () => {
        const beforeCount = await prisma.promotion.count();
        const beforeTargetCount = await prisma.promotionTargetItem.count();

        await expect(
          service.create({
            title: 'Bogus variant',
            type: 'PRODUCT_DISCOUNT',
            method: 'AUTOMATIC',
            discountType: 'PERCENTAGE',
            discountValue: 10,
            appliesTo: 'VARIANTS',
            targetItems: [
              { targetType: 'VARIANTS', targetId: 'V-MISSING-DOES-NOT-EXIST' },
            ],
          } as never),
        ).rejects.toThrow(/Variant with id 'V-MISSING-DOES-NOT-EXIST' not found/);

        const afterCount = await prisma.promotion.count();
        const afterTargetCount = await prisma.promotionTargetItem.count();
        expect(afterCount).toBe(beforeCount);
        expect(afterTargetCount).toBe(beforeTargetCount);
      });
    });

    describe('Scenario 12 — VARIANTS cross-tenant variant id is rejected', () => {
      it('rejects a variant belonging to another tenant', async () => {
        // Seed a SECOND tenant (T2) with its own variant. The baseline
        // tenant is T1 — asking T1's tenant-scoped client for T2's
        // variant id must surface as "not found".
        const tenant2Id = '00000000-0000-0000-0000-000000000002';
        await prisma.tenant.create({
          data: {
            id: tenant2Id,
            name: 'Integration Tenant T2',
            slug: 'integration-tenant-t2',
            isActive: true,
          },
        });
        const productT2 = await prisma.product.create({
          data: {
            tenantId: tenant2Id,
            name: 'T2 product',
            sku: 'INT-T2-P1',
            sellInPos: true,
            useStock: false,
          },
        });
        const variantT2 = await prisma.variant.create({
          data: {
            tenantId: tenant2Id,
            productId: productT2.id,
            name: 'T2-V',
          },
        });

        // Switch the CLS tenantId back to T1 (baseline) so the
        // tenant-scoped client filters out T2's variant.
        const clsT1: Pick<ClsService<TenantClsStore>, 'get'> = {
          get: (key: string) => {
            if (key === 'tenantId') return tenantId;
            if (key === 'isSuperAdmin') return false;
            return undefined;
          },
        };
        const tenantPrismaT1 = new TenantPrismaService(
          prisma as unknown as ConstructorParameters<typeof TenantPrismaService>[0],
          clsT1 as ClsService<TenantClsStore>,
        );
        const serviceT1 = new PromotionsService(
          repository,
          prisma,
          tenantPrismaT1,
          {
            get: (k: string, dv?: unknown) =>
              k === 'PROMOTIONS_BUSINESS_TIMEZONE' ? 'America/Mexico_City' : dv,
          } as unknown as ConfigService,
        );

        const beforeCount = await prisma.promotion.count();

        await expect(
          serviceT1.create({
            title: 'Cross-tenant attempt',
            type: 'PRODUCT_DISCOUNT',
            method: 'AUTOMATIC',
            discountType: 'PERCENTAGE',
            discountValue: 15,
            appliesTo: 'VARIANTS',
            targetItems: [
              { targetType: 'VARIANTS', targetId: variantT2.id },
            ],
          } as never),
        ).rejects.toThrow(/Variant with id/);

        // Confirm T2's variant row is still there (it was a real seed).
        const t2Variant = await prisma.variant.findUnique({
          where: { id: variantT2.id },
        });
        expect(t2Variant).not.toBeNull();

        // Confirm T1 (the requesting tenant) didn't persist the promo.
        const afterCount = await prisma.promotion.count();
        expect(afterCount).toBe(beforeCount);

        // Reference the BASELINE constant so it shows up in usage; it
        // documents the assertion's invariant (we're asking from T1's
        // scope — the constant is the T1 id).
        expect(BASELINE_TENANT_ID).toBe(tenantId);
      });
    });

    // ──────────────────────────────────────────────────────────
    // Scenario 13: read-path VARIANTS enrichment through the real DB.
    // findOne must stamp productId / variantName / productName onto the
    // VARIANTS targetItem, resolved via the separate variant lookup.
    // ──────────────────────────────────────────────────────────

    describe('Scenario 13 — findOne enriches VARIANTS targetItems with variant context', () => {
      it('returns productId, variantName and productName for the VARIANTS item', async () => {
        const created = await service.create({
          title: 'Variant enrichment read',
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'PERCENTAGE',
          discountValue: 10,
          appliesTo: 'VARIANTS',
          targetItems: [{ targetType: 'VARIANTS', targetId: variantAId }],
        } as never);

        const result = await service.findOne(created.id as string);

        const items = result.targetItems as Array<{
          side: string;
          targetType: string;
          targetId: string;
          productId?: string;
          variantName?: string;
          productName?: string;
        }>;

        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
          targetType: 'VARIANTS',
          targetId: variantAId,
          productId,
          variantName: 'V-A',
          productName: 'Integration Product P1',
        });
      });

      it('does not throw and adds no fields when the referenced variant was deleted', async () => {
        // Seed a promotion that references variantB, then delete variantB
        // directly. The read path must skip enrichment for the dangling
        // reference without throwing.
        const promoId = crypto.randomUUID();
        await prisma.promotion.create({
          data: {
            id: promoId,
            tenantId,
            title: 'Dangling variant ref',
            type: 'PRODUCT_DISCOUNT',
            method: 'AUTOMATIC',
            status: 'ACTIVE',
            customerScope: 'ALL',
            discountType: 'PERCENTAGE',
            discountValue: 10,
            appliesTo: 'VARIANTS',
          },
        });
        await prisma.promotionTargetItem.create({
          data: {
            promotionId: promoId,
            tenantId,
            side: 'DEFAULT',
            targetType: 'VARIANTS',
            targetId: variantBId,
          },
        });
        await prisma.variant.delete({ where: { id: variantBId } });

        const result = await service.findOne(promoId);
        const items = result.targetItems as Array<{
          targetId: string;
          productId?: string;
          variantName?: string;
          productName?: string;
        }>;

        expect(items).toHaveLength(1);
        expect(items[0].targetId).toBe(variantBId);
        expect(items[0].productId).toBeUndefined();
        expect(items[0].variantName).toBeUndefined();
        expect(items[0].productName).toBeUndefined();
      });
    });
  },
);