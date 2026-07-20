/**
 * WU8 — D7 Disjoint BUY/GET entity rejection at intake.
 *
 * Spec: `openspec/changes/advanced-promotion-type/specs/pos-promotion-engine/spec.md`
 * Requirement: ADVANCED — Disjoint BUY/GET Entities (D7)
 *
 * Contract (design.md decision + spec scenarios):
 *   - BUY-side and GET-side target items MUST be disjoint.
 *   - Same (targetType, targetId) on BOTH sides is REJECTED at promotion
 *     intake (create AND update) with code `advanced_overlapping_targets`.
 *   - The rejection happens BEFORE the row is persisted; `repo.save`
 *     MUST NOT be called.
 *   - Cross-entity BUY/GET (different ids OR different targetTypes) is
 *     accepted — disjoint is per-entity, not per-targetType.
 *   - Any combination of PRODUCTS/VARIANTS/CATEGORIES/BRANDS is in scope.
 *
 * Symmetry with the existing `advanced_missing_targets` test pattern in
 * `promotions.service.spec.ts`. The disjoint check lives in
 * `assertAdvancedSideTargets()` per design.md row 8.
 *
 * Test isolation: like `promotions-validate-variants.spec.ts`, the test
 * mock returns the same object as both global `prisma` and `tenantClient`.
 */
import 'reflect-metadata';
import { PromotionsService } from './promotions.service';
import { InvalidArgumentError } from '../shared/domain/domain-error';
import { PrismaService } from '../shared/prisma/prisma.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { ConfigService } from '@nestjs/config';
import { IPromotionRepository } from './domain/promotion.repository';
import {
  Promotion,
  PromotionProps,
  PromotionType,
  PromotionMethod,
  PromotionTargetType,
} from './domain/promotion.entity';
import {
  CreatePromotionDto,
  PromotionMethodEnum,
  PromotionTargetTypeEnum,
  PromotionTypeEnum,
} from './dto/create-promotion.dto';
import { UpdatePromotionDto } from './dto/update-promotion.dto';

// ── Helpers ──────────────────────────────────────────────────

function makePromotion(overrides: Partial<PromotionProps> = {}): Promotion {
  return Promotion.fromPersistence({
    id: 'promo-1',
    title: 'Test Promo',
    type: 'PRODUCT_DISCOUNT',
    method: 'AUTOMATIC',
    status: 'ACTIVE',
    manuallyEnded: false,
    startDate: null,
    endDate: null,
    customerScope: 'ALL',
    discountType: 'PERCENTAGE',
    discountValue: 20,
    minPurchaseAmountCents: null,
    appliesTo: 'CATEGORIES',
    buyQuantity: null,
    getQuantity: null,
    getDiscountPercent: null,
    buyTargetType: null,
    getTargetType: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    targetItems: [],
    customers: [],
    priceLists: [],
    daysOfWeek: [],
    ...overrides,
  });
}

function makeRepo(
  overrides: Partial<jest.Mocked<IPromotionRepository>> = {},
): jest.Mocked<IPromotionRepository> {
  return {
    save: jest.fn(),
    findById: jest.fn(),
    findAll: jest.fn(),
    delete: jest.fn(),
    updateStatus: jest.fn(),
    ...overrides,
  } as jest.Mocked<IPromotionRepository>;
}

type PrismaLookupMock = {
  category: { findMany: jest.Mock };
  brand: { findMany: jest.Mock };
  product: { findMany: jest.Mock };
  variant: { findMany: jest.Mock };
  customer: { findMany: jest.Mock };
  globalPriceList: { findMany: jest.Mock };
};

function makePrisma(
  overrides: Partial<PrismaLookupMock> = {},
): PrismaLookupMock {
  return {
    category: { findMany: jest.fn().mockResolvedValue([]) },
    brand: { findMany: jest.fn().mockResolvedValue([]) },
    product: { findMany: jest.fn().mockResolvedValue([]) },
    variant: { findMany: jest.fn().mockResolvedValue([]) },
    customer: { findMany: jest.fn().mockResolvedValue([]) },
    globalPriceList: { findMany: jest.fn().mockResolvedValue([]) },
    ...overrides,
  };
}

function makeService(
  repo: IPromotionRepository,
  prisma: PrismaLookupMock,
  configService: ConfigService = makeConfigService(),
): PromotionsService {
  const tenantPrisma: Pick<TenantPrismaService, 'getClient'> = {
    getClient: jest.fn().mockReturnValue(prisma),
  };

  return new PromotionsService(
    repo,
    prisma as unknown as PrismaService,
    tenantPrisma as TenantPrismaService,
    configService,
  );
}

function makeConfigService(
  timezone: string = 'America/Mexico_City',
): ConfigService {
  return {
    get: jest.fn((key: string, defaultValue?: unknown) => {
      if (key === 'PROMOTIONS_BUSINESS_TIMEZONE') return timezone;
      return defaultValue;
    }),
  } as unknown as ConfigService;
}

type CreateAdvancedInput = {
  title: string;
  buyTargetType: PromotionTargetType;
  getTargetType: PromotionTargetType;
  buyTargetItems: Array<{ targetId: string }>;
  getTargetItems: Array<{ targetId: string }>;
  buyQuantity?: number;
  getQuantity?: number;
  getDiscountPercent?: number;
};

function createAdvancedDto(input: CreateAdvancedInput): CreatePromotionDto {
  return {
    title: input.title,
    type: 'ADVANCED' as PromotionTypeEnum,
    method: 'AUTOMATIC' as PromotionMethodEnum,
    customerScope: 'ALL',
    buyQuantity: input.buyQuantity ?? 1,
    getQuantity: input.getQuantity ?? 1,
    getDiscountPercent: input.getDiscountPercent ?? 0,
    buyTargetType: input.buyTargetType as PromotionTargetTypeEnum,
    getTargetType: input.getTargetType as PromotionTargetTypeEnum,
    buyTargetItems: input.buyTargetItems,
    getTargetItems: input.getTargetItems,
  };
}

// ── Tests ─────────────────────────────────────────────────────

describe('PromotionsService.assertAdvancedSideTargets — D7 disjoint BUY/GET (WU8)', () => {
  // ============================================================
  // S3 — Create: same entity on BUY and GET is rejected
  // ============================================================
  describe('create() rejects same-entity BUY/GET with code advanced_overlapping_targets', () => {
    it('rejects PRODUCTS P1 on BOTH sides with advanced_overlapping_targets (no row persisted)', async () => {
      const repo = makeRepo();
      const prisma = makePrisma({
        product: {
          findMany: jest.fn().mockResolvedValue([{ id: 'p1' }]),
        },
      });
      const service = makeService(repo, prisma);

      await expect(
        service.create(
          createAdvancedDto({
            title: 'Same product',
            buyTargetType: 'PRODUCTS',
            getTargetType: 'PRODUCTS',
            buyTargetItems: [{ targetId: 'p1' }],
            getTargetItems: [{ targetId: 'p1' }],
          }),
        ),
      ).rejects.toMatchObject({
        code: 'advanced_overlapping_targets',
        name: 'InvalidArgumentError',
      });

      expect(repo.save).not.toHaveBeenCalled();
    });

    it('rejects BRANDS brand-x on BOTH sides', async () => {
      const repo = makeRepo();
      const prisma = makePrisma({
        brand: {
          findMany: jest.fn().mockResolvedValue([{ id: 'brand-x' }]),
        },
      });
      const service = makeService(repo, prisma);

      await expect(
        service.create(
          createAdvancedDto({
            title: 'Same brand',
            buyTargetType: 'BRANDS',
            getTargetType: 'BRANDS',
            buyTargetItems: [{ targetId: 'brand-x' }],
            getTargetItems: [{ targetId: 'brand-x' }],
          }),
        ),
      ).rejects.toMatchObject({ code: 'advanced_overlapping_targets' });

      expect(repo.save).not.toHaveBeenCalled();
    });

    it('rejects CATEGORIES cat1 on BOTH sides', async () => {
      const repo = makeRepo();
      const prisma = makePrisma({
        category: {
          findMany: jest.fn().mockResolvedValue([{ id: 'cat1' }]),
        },
      });
      const service = makeService(repo, prisma);

      await expect(
        service.create(
          createAdvancedDto({
            title: 'Same category',
            buyTargetType: 'CATEGORIES',
            getTargetType: 'CATEGORIES',
            buyTargetItems: [{ targetId: 'cat1' }],
            getTargetItems: [{ targetId: 'cat1' }],
          }),
        ),
      ).rejects.toMatchObject({ code: 'advanced_overlapping_targets' });

      expect(repo.save).not.toHaveBeenCalled();
    });

    it('rejects VARIANTS var1 on BOTH sides', async () => {
      const repo = makeRepo();
      const prisma = makePrisma({
        variant: {
          findMany: jest.fn().mockResolvedValue([{ id: 'var1' }]),
        },
      });
      const service = makeService(repo, prisma);

      await expect(
        service.create(
          createAdvancedDto({
            title: 'Same variant',
            buyTargetType: 'VARIANTS',
            getTargetType: 'VARIANTS',
            buyTargetItems: [{ targetId: 'var1' }],
            getTargetItems: [{ targetId: 'var1' }],
          }),
        ),
      ).rejects.toMatchObject({ code: 'advanced_overlapping_targets' });

      expect(repo.save).not.toHaveBeenCalled();
    });

    it('rejects when ANY entity overlaps across multi-id BUY/GET sets', async () => {
      // BUY [p1, p2, p3] vs GET [p4, p3, p5] → p3 overlaps → reject.
      const repo = makeRepo();
      const prisma = makePrisma({
        product: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              { id: 'p1' },
              { id: 'p2' },
              { id: 'p3' },
              { id: 'p4' },
              { id: 'p5' },
            ]),
        },
      });
      const service = makeService(repo, prisma);

      await expect(
        service.create(
          createAdvancedDto({
            title: 'Multi overlap',
            buyTargetType: 'PRODUCTS',
            getTargetType: 'PRODUCTS',
            buyTargetItems: [
              { targetId: 'p1' },
              { targetId: 'p2' },
              { targetId: 'p3' },
            ],
            getTargetItems: [
              { targetId: 'p4' },
              { targetId: 'p3' },
              { targetId: 'p5' },
            ],
          }),
        ),
      ).rejects.toMatchObject({ code: 'advanced_overlapping_targets' });

      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // Cross-entity BUY/GET is accepted (regression guard)
  // ============================================================
  describe('create() accepts disjoint BUY/GET', () => {
    it('accepts CATEGORIES cat1 (BUY) and PRODUCTS p1 (GET) — cross-type', async () => {
      let captured: Promotion | null = null;
      const repo = makeRepo({
        save: jest.fn().mockImplementation((p: Promotion) => {
          captured = p;
          return p;
        }),
      });
      const prisma = makePrisma({
        category: {
          findMany: jest.fn().mockResolvedValue([{ id: 'cat1' }]),
        },
        product: {
          findMany: jest.fn().mockResolvedValue([{ id: 'p1' }]),
        },
      });
      const service = makeService(repo, prisma);

      await service.create(
        createAdvancedDto({
          title: 'Cross-entity',
          buyTargetType: 'CATEGORIES',
          getTargetType: 'PRODUCTS',
          buyTargetItems: [{ targetId: 'cat1' }],
          getTargetItems: [{ targetId: 'p1' }],
        }),
      );

      expect(repo.save).toHaveBeenCalledTimes(1);
      expect(captured).not.toBeNull();
      expect(captured!.targetItems).toHaveLength(2);
    });

    it('accepts PRODUCTS p1 (BUY) and PRODUCTS p2 (GET) — same type, different ids', async () => {
      let captured: Promotion | null = null;
      const repo = makeRepo({
        save: jest.fn().mockImplementation((p: Promotion) => {
          captured = p;
          return p;
        }),
      });
      const prisma = makePrisma({
        product: {
          findMany: jest.fn().mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]),
        },
      });
      const service = makeService(repo, prisma);

      await service.create(
        createAdvancedDto({
          title: 'Different products',
          buyTargetType: 'PRODUCTS',
          getTargetType: 'PRODUCTS',
          buyTargetItems: [{ targetId: 'p1' }],
          getTargetItems: [{ targetId: 'p2' }],
        }),
      );

      expect(repo.save).toHaveBeenCalledTimes(1);
      expect(captured!.targetItems).toHaveLength(2);
    });

    it('accepts BRANDS brand-lg (BUY) and CATEGORIES cat-sony (GET) — the existing happy-path', async () => {
      let captured: Promotion | null = null;
      const repo = makeRepo({
        save: jest.fn().mockImplementation((p: Promotion) => {
          captured = p;
          return p;
        }),
      });
      const prisma = makePrisma({
        brand: {
          findMany: jest.fn().mockResolvedValue([{ id: 'brand-lg' }]),
        },
        category: {
          findMany: jest.fn().mockResolvedValue([{ id: 'cat-sony' }]),
        },
      });
      const service = makeService(repo, prisma);

      await service.create(
        createAdvancedDto({
          title: 'LG → Sony',
          buyTargetType: 'BRANDS',
          getTargetType: 'CATEGORIES',
          buyTargetItems: [{ targetId: 'brand-lg' }],
          getTargetItems: [{ targetId: 'cat-sony' }],
        }),
      );

      expect(repo.save).toHaveBeenCalledTimes(1);
      expect(captured!.targetItems).toHaveLength(2);
    });
  });

  // ============================================================
  // Update path: existing disjoint → update to same-entity is rejected
  // ============================================================
  describe('update() rejects same-entity BUY/GET with code advanced_overlapping_targets', () => {
    it('rejects an update that flips BUY/GET sides onto the same entity', async () => {
      // Start: BUY=[BRANDS, brand-lg], GET=[CATEGORIES, cat-sony] (disjoint).
      // Update: override BOTH sides to point at category cat-lg.
      // Result: same (targetType, id) on BUY AND GET → reject.
      const existing = makePromotion({
        type: 'ADVANCED',
        discountType: null,
        discountValue: null,
        appliesTo: null,
        buyQuantity: 1,
        getQuantity: 1,
        getDiscountPercent: 0,
        buyTargetType: 'BRANDS',
        getTargetType: 'CATEGORIES',
        targetItems: [
          {
            id: 'ti-buy',
            side: 'BUY',
            targetType: 'BRANDS',
            targetId: 'brand-lg',
          },
          {
            id: 'ti-get',
            side: 'GET',
            targetType: 'CATEGORIES',
            targetId: 'cat-sony',
          },
        ],
      });

      const repo = makeRepo({
        findById: jest.fn().mockResolvedValue(existing),
      });
      const prisma = makePrisma({
        category: {
          findMany: jest
            .fn()
            // Existing cat-sony is no longer in the new shape; the
            // disjoint check fires before validateTargetIds is asked
            // about cat-sony. Only the NEW cat-lg lookup is needed.
            .mockResolvedValue([{ id: 'cat-lg' }]),
        },
      });
      const service = makeService(repo, prisma);

      const dto: UpdatePromotionDto = {
        // Flip BUY type from BRANDS to CATEGORIES so the buyTargetItems
        // below share the same targetType.
        buyTargetType: 'CATEGORIES' as PromotionTargetTypeEnum,
        getTargetType: 'CATEGORIES' as PromotionTargetTypeEnum,
        buyTargetItems: [{ targetId: 'cat-lg' }],
        getTargetItems: [{ targetId: 'cat-lg' }],
      };

      await expect(service.update('promo-1', dto)).rejects.toMatchObject({
        code: 'advanced_overlapping_targets',
      });

      // No save, no mutation of the existing entity.
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('accepts an update that introduces a new disjoint entity on the GET side', async () => {
      // Regression guard: when the update is disjoint, it must NOT
      // regress to the overlapping rejection path.
      const existing = makePromotion({
        type: 'ADVANCED',
        discountType: null,
        discountValue: null,
        appliesTo: null,
        buyQuantity: 1,
        getQuantity: 1,
        getDiscountPercent: 0,
        buyTargetType: 'BRANDS',
        getTargetType: 'CATEGORIES',
        targetItems: [
          {
            id: 'ti-buy',
            side: 'BUY',
            targetType: 'BRANDS',
            targetId: 'brand-lg',
          },
          {
            id: 'ti-get',
            side: 'GET',
            targetType: 'CATEGORIES',
            targetId: 'cat-sony',
          },
        ],
      });

      const repo = makeRepo({
        findById: jest.fn().mockResolvedValue(existing),
        save: jest.fn().mockImplementation((p: Promotion) => p),
      });
      const prisma = makePrisma({
        brand: {
          findMany: jest.fn().mockResolvedValue([{ id: 'brand-lg' }]),
        },
        category: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ id: 'cat-sony' }, { id: 'cat-panasonic' }]),
        },
      });
      const service = makeService(repo, prisma);

      const result = await service.update('promo-1', {
        getTargetItems: [{ targetId: 'cat-panasonic' }],
      } as UpdatePromotionDto);

      expect(repo.save).toHaveBeenCalledTimes(1);
      expect(result.targetItems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            side: 'BUY',
            targetType: 'BRANDS',
            targetId: 'brand-lg',
          }),
          expect.objectContaining({
            side: 'GET',
            targetType: 'CATEGORIES',
            targetId: 'cat-panasonic',
          }),
        ]),
      );
    });
  });

  // ============================================================
  // Sanity — does NOT regress non-ADVANCED types
  // ============================================================
  describe('disjoint check is scoped to ADVANCED only', () => {
    it('does NOT reject a BUY_X_GET_Y even if the same id appears twice on DEFAULT side (duplicate_target guard remains)', async () => {
      const repo = makeRepo();
      const prisma = makePrisma({
        product: {
          findMany: jest.fn().mockResolvedValue([{ id: 'p1' }]),
        },
      });
      const service = makeService(repo, prisma);

      // The D7 disjoint check is ADVANCED-only; BUY_X_GET_Y keeps its
      // own `duplicate_target` guard. Confirm the disjoint code does
      // not bleed across types.
      await expect(
        service.create({
          title: 'BXGY duplicate',
          type: 'BUY_X_GET_Y' as PromotionTypeEnum,
          method: 'AUTOMATIC' as PromotionMethodEnum,
          customerScope: 'ALL',
          appliesTo: 'PRODUCTS' as PromotionTargetTypeEnum,
          buyQuantity: 2,
          getQuantity: 1,
          getDiscountPercent: 50,
          targetItems: [
            {
              targetType: 'PRODUCTS' as PromotionTargetTypeEnum,
              targetId: 'p1',
            },
            {
              targetType: 'PRODUCTS' as PromotionTargetTypeEnum,
              targetId: 'p1',
            },
          ],
        }),
      ).rejects.toMatchObject({ code: 'duplicate_target' });
    });

    it('does NOT touch the missing_targets path: same id missing from one side still surfaces advanced_missing_targets', async () => {
      // Disjoint check is ADVANCED-only and must not alter the
      // pre-existing advanced_missing_targets guard for half-built
      // promotions.
      const repo = makeRepo();
      const prisma = makePrisma({
        category: {
          findMany: jest.fn().mockResolvedValue([{ id: 'cat1' }]),
        },
      });
      const service = makeService(repo, prisma);

      await expect(
        service.create(
          createAdvancedDto({
            title: 'Missing GET items',
            buyTargetType: 'CATEGORIES',
            getTargetType: 'CATEGORIES',
            buyTargetItems: [{ targetId: 'cat1' }],
            getTargetItems: [], // GET side type set, but items empty → missing_targets
          }),
        ),
      ).rejects.toMatchObject({ code: 'advanced_missing_targets' });
    });
  });
});
