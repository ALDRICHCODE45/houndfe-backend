/**
 * PromotionsService — unit tests (strict TDD).
 * All repository and PrismaService calls are mocked.
 */
import { PromotionsService } from './promotions.service';
import {
  EntityNotFoundError,
  InvalidArgumentError,
} from '../shared/domain/domain-error';
import { PrismaService } from '../shared/prisma/prisma.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { ConfigService } from '@nestjs/config';
import {
  Promotion,
  PromotionProps,
  PromotionType,
  PromotionMethod,
  DiscountType,
  PromotionTargetType,
  CustomerScope,
} from './domain/promotion.entity';
import { IPromotionRepository } from './domain/promotion.repository';
import {
  CreatePromotionDto,
  CustomerScopeEnum,
  DiscountTypeEnum,
  PromotionMethodEnum,
  PromotionTargetTypeEnum,
  PromotionTypeEnum,
} from './dto/create-promotion.dto';
import {
  PromotionQueryDto,
  PromotionStatusEnum,
  SortByEnum,
  SortOrderEnum,
} from './dto/promotion-query.dto';
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
  customer: { findMany: jest.Mock };
  globalPriceList: { findMany: jest.Mock };
  variant: { findMany: jest.Mock };
};

function makePrisma(
  overrides: Partial<PrismaLookupMock> = {},
): PrismaLookupMock {
  return {
    category: { findMany: jest.fn().mockResolvedValue([]) },
    brand: { findMany: jest.fn().mockResolvedValue([]) },
    product: { findMany: jest.fn().mockResolvedValue([]) },
    customer: { findMany: jest.fn().mockResolvedValue([]) },
    globalPriceList: { findMany: jest.fn().mockResolvedValue([]) },
    variant: { findMany: jest.fn().mockResolvedValue([]) },
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

/**
 * Build a ConfigService mock that resolves PROMOTIONS_BUSINESS_TIMEZONE
 * to the given timezone (default: America/Mexico_City). Other keys fall
 * through to the underlying default. This lets every existing test
 * keep its current shape (default args) while letting the new
 * normalization tests override the timezone explicitly.
 */
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

type CreatePromotionInput = {
  title: string;
  type: PromotionType;
  method: PromotionMethod;
  customerScope?: CustomerScope;
  discountType?: DiscountType;
  discountValue?: number;
  minPurchaseAmountCents?: number;
  appliesTo?: PromotionTargetType;
  buyQuantity?: number;
  getQuantity?: number;
  getDiscountPercent?: number;
  buyTargetType?: PromotionTargetType;
  getTargetType?: PromotionTargetType;
  targetItems?: Array<{ targetType: PromotionTargetType; targetId: string }>;
  buyTargetItems?: Array<{ targetId: string }>;
  getTargetItems?: Array<{ targetId: string }>;
  customerIds?: string[];
  priceListIds?: string[];
  startDate?: string;
  endDate?: string;
};

function createDto(input: CreatePromotionInput): CreatePromotionDto {
  return {
    ...input,
    type: input.type as PromotionTypeEnum,
    method: input.method as PromotionMethodEnum,
    customerScope: input.customerScope as CustomerScopeEnum,
    discountType: input.discountType as DiscountTypeEnum,
    appliesTo: input.appliesTo as PromotionTargetTypeEnum,
    buyTargetType: input.buyTargetType as PromotionTargetTypeEnum,
    getTargetType: input.getTargetType as PromotionTargetTypeEnum,
    targetItems: input.targetItems?.map((item) => ({
      targetType: item.targetType as PromotionTargetTypeEnum,
      targetId: item.targetId,
    })),
  };
}

function updateDto(input: UpdatePromotionDto): UpdatePromotionDto {
  return input;
}

function queryDto(input: PromotionQueryDto): PromotionQueryDto {
  return input;
}

// ── Tests ─────────────────────────────────────────────────────

describe('PromotionsService', () => {
  // ── create ────────────────────────────────────────────────

  describe('create()', () => {
    it('should create a PRODUCT_DISCOUNT promotion and return it', async () => {
      const saved = makePromotion();
      const repo = makeRepo({ save: jest.fn().mockResolvedValue(saved) });
      const prisma = makePrisma();
      const service = makeService(repo, prisma);

      const result = await service.create(
        createDto({
          title: 'Test Promo',
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'PERCENTAGE',
          discountValue: 20,
          appliesTo: 'CATEGORIES',
        }),
      );

      expect(repo.save.mock.calls.length).toBe(1);
      expect(result.id).toBe('promo-1');
      expect(result.type).toBe('PRODUCT_DISCOUNT');
    });

    it('should create an ORDER_DISCOUNT promotion', async () => {
      const saved = makePromotion({ type: 'ORDER_DISCOUNT' });
      const repo = makeRepo({ save: jest.fn().mockResolvedValue(saved) });
      const prisma = makePrisma();
      const service = makeService(repo, prisma);

      const result = await service.create(
        createDto({
          title: 'Order Discount',
          type: 'ORDER_DISCOUNT',
          method: 'MANUAL',
          discountType: 'FIXED',
          discountValue: 500,
        }),
      );

      expect(result.type).toBe('ORDER_DISCOUNT');
    });

    it('should create a targeted BUY_X_GET_Y promotion', async () => {
      const saved = makePromotion({ type: 'BUY_X_GET_Y' });
      const repo = makeRepo({ save: jest.fn().mockResolvedValue(saved) });
      const prisma = makePrisma({
        product: { findMany: jest.fn().mockResolvedValue([{ id: 'product-1' }]) },
      });
      const service = makeService(repo, prisma);

      const result = await service.create(
        createDto({
          title: '2x1',
          type: 'BUY_X_GET_Y',
          method: 'AUTOMATIC',
          buyQuantity: 2,
          getQuantity: 1,
          getDiscountPercent: 100,
          appliesTo: 'PRODUCTS',
          targetItems: [{ targetType: 'PRODUCTS', targetId: 'product-1' }],
        }),
      );

      expect(result.type).toBe('BUY_X_GET_Y');
      expect(repo.save).toHaveBeenCalledTimes(1);
    });

    it('should reject BUY_X_GET_Y create without a target as INVALID_TARGET', async () => {
      const repo = makeRepo();
      const service = makeService(repo, makePrisma());

      await expect(
        service.create(
          createDto({
            title: 'Untargeted 2x1',
            type: 'BUY_X_GET_Y',
            method: 'AUTOMATIC',
            buyQuantity: 2,
            getQuantity: 1,
            getDiscountPercent: 100,
            appliesTo: 'PRODUCTS',
            targetItems: [],
          }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_TARGET' });

      expect(repo.save).not.toHaveBeenCalled();
    });

    it('should throw InvalidArgumentError when entity validation fails', async () => {
      const repo = makeRepo();
      const prisma = makePrisma();
      const service = makeService(repo, prisma);

      // Missing required discountType for PRODUCT_DISCOUNT
      await expect(
        service.create(
          createDto({
            title: 'Bad Promo',
            type: 'PRODUCT_DISCOUNT',
            method: 'AUTOMATIC',
            discountValue: 20,
            appliesTo: 'CATEGORIES',
          }),
        ),
      ).rejects.toThrow(InvalidArgumentError);
    });

    it('should validate target IDs against DB when provided', async () => {
      const repo = makeRepo();
      const prisma = makePrisma({
        category: {
          findMany: jest.fn().mockResolvedValue([]), // empty — none found
        },
      });
      const service = makeService(repo, prisma);

      await expect(
        service.create(
          createDto({
            title: 'Missing Category',
            type: 'PRODUCT_DISCOUNT',
            method: 'AUTOMATIC',
            discountType: 'PERCENTAGE',
            discountValue: 15,
            appliesTo: 'CATEGORIES',
            targetItems: [
              { targetType: 'CATEGORIES', targetId: 'cat-nonexistent' },
            ],
          }),
        ),
      ).rejects.toThrow(InvalidArgumentError);

      expect(prisma.category.findMany).toHaveBeenCalledTimes(1);
    });

    it('should validate product target IDs using tenant-scoped prisma client', async () => {
      const repo = makeRepo();
      const prisma = makePrisma({
        product: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      });
      const service = makeService(repo, prisma);

      await expect(
        service.create(
          createDto({
            title: 'Missing Product',
            type: 'PRODUCT_DISCOUNT',
            method: 'AUTOMATIC',
            discountType: 'PERCENTAGE',
            discountValue: 15,
            appliesTo: 'PRODUCTS',
            targetItems: [{ targetType: 'PRODUCTS', targetId: 'prod-missing' }],
          }),
        ),
      ).rejects.toThrow(InvalidArgumentError);

      expect(prisma.product.findMany).toHaveBeenCalledTimes(1);
    });

    it('should validate customerIds against DB when customerScope is SPECIFIC', async () => {
      const repo = makeRepo();
      const prisma = makePrisma({
        customer: {
          findMany: jest.fn().mockResolvedValue([]), // empty — none found
        },
      });
      const service = makeService(repo, prisma);

      await expect(
        service.create(
          createDto({
            title: 'Specific Customers',
            type: 'PRODUCT_DISCOUNT',
            method: 'AUTOMATIC',
            discountType: 'PERCENTAGE',
            discountValue: 10,
            appliesTo: 'CATEGORIES',
            customerScope: 'SPECIFIC',
            customerIds: ['cust-nonexistent'],
          }),
        ),
      ).rejects.toThrow(InvalidArgumentError);

      expect(prisma.customer.findMany).toHaveBeenCalledTimes(1);
    });

    it('should validate priceListIds against DB', async () => {
      const repo = makeRepo();
      const prisma = makePrisma({
        globalPriceList: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      });
      const service = makeService(repo, prisma);

      await expect(
        service.create(
          createDto({
            title: 'Specific Price Lists',
            type: 'PRODUCT_DISCOUNT',
            method: 'AUTOMATIC',
            discountType: 'PERCENTAGE',
            discountValue: 10,
            appliesTo: 'CATEGORIES',
            priceListIds: ['pl-missing'],
          }),
        ),
      ).rejects.toThrow(InvalidArgumentError);

      expect(prisma.globalPriceList.findMany).toHaveBeenCalledTimes(1);
    });

    it('should attach target items from dto when provided', async () => {
      let capturedPromotion: Promotion | null = null;
      const repo = makeRepo({
        save: jest.fn().mockImplementation((p: Promotion) => {
          capturedPromotion = p;
          return p;
        }),
      });
      const prisma = makePrisma({
        category: {
          findMany: jest.fn().mockResolvedValue([{ id: 'cat-1' }]),
        },
      });
      const service = makeService(repo, prisma);

      await service.create(
        createDto({
          title: 'With Targets',
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'PERCENTAGE',
          discountValue: 10,
          appliesTo: 'CATEGORIES',
          targetItems: [{ targetType: 'CATEGORIES', targetId: 'cat-1' }],
        }),
      );

      expect(capturedPromotion!.targetItems).toHaveLength(1);
      expect(capturedPromotion!.targetItems[0].targetId).toBe('cat-1');
      expect(capturedPromotion!.targetItems[0].side).toBe('DEFAULT');
    });

    it('should persist ADVANCED create with BUY and GET side target shapes', async () => {
      let capturedPromotion: Promotion | null = null;
      const repo = makeRepo({
        save: jest.fn().mockImplementation((p: Promotion) => {
          capturedPromotion = p;
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
        createDto({
          title: 'Compra LG, llevate Sony gratis',
          type: 'ADVANCED',
          method: 'AUTOMATIC',
          buyQuantity: 1,
          getQuantity: 1,
          getDiscountPercent: 0,
          buyTargetType: 'BRANDS',
          getTargetType: 'CATEGORIES',
          buyTargetItems: [{ targetId: 'brand-lg' }],
          getTargetItems: [{ targetId: 'cat-sony' }],
        }),
      );

      expect(capturedPromotion).not.toBeNull();
      expect(capturedPromotion!.targetItems).toHaveLength(2);
      expect(capturedPromotion!.targetItems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            side: 'BUY',
            targetType: 'BRANDS',
            targetId: 'brand-lg',
          }),
          expect.objectContaining({
            side: 'GET',
            targetType: 'CATEGORIES',
            targetId: 'cat-sony',
          }),
        ]),
      );
    });

    // ============================================================
    // DATE-RANGE NORMALIZATION (business-timezone bug fix)
    // The frontend sends UTC-midnight for date-only picks. Without
    // normalization, the backend stores those UTC-midnight instants
    // verbatim and the effective-status comparison drifts by the
    // business-tz offset (at UTC-6 the final local day is silently
    // truncated by ~6h). The service MUST normalize to business-day
    // boundaries before persisting.
    // ============================================================

    it('should normalize startDate to local midnight in business tz (America/Mexico_City, UTC-6)', async () => {
      let captured: Promotion | null = null;
      const repo = makeRepo({
        save: jest.fn().mockImplementation((p: Promotion) => {
          captured = p;
          return p;
        }),
      });
      const prisma = makePrisma();
      const service = makeService(
        repo,
        prisma,
        makeConfigService('America/Mexico_City'),
      );

      await service.create(
        createDto({
          title: 'Normalize start',
          type: 'ORDER_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'PERCENTAGE',
          discountValue: 10,
          // Frontend sends UTC-midnight for the user-picked day "1 July".
          startDate: '2026-07-01T00:00:00.000Z',
        }),
      );

      // Mexico City is UTC-6 → local midnight on 1 July = 06:00:00.000Z.
      expect(captured!.startDate?.toISOString()).toBe(
        '2026-07-01T06:00:00.000Z',
      );
    });

    it('should normalize endDate to local 23:59:59.999 in business tz (America/Mexico_City, UTC-6)', async () => {
      let captured: Promotion | null = null;
      const repo = makeRepo({
        save: jest.fn().mockImplementation((p: Promotion) => {
          captured = p;
          return p;
        }),
      });
      const prisma = makePrisma();
      const service = makeService(
        repo,
        prisma,
        makeConfigService('America/Mexico_City'),
      );

      await service.create(
        createDto({
          title: 'Normalize end',
          type: 'ORDER_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'PERCENTAGE',
          discountValue: 10,
          endDate: '2026-07-11T00:00:00.000Z',
        }),
      );

      // Mexico City end-of-day on 11 July = July 12 05:59:59.999Z.
      expect(captured!.endDate?.toISOString()).toBe('2026-07-12T05:59:59.999Z');
    });

    it('should normalize the "Promocion chida" range (1–11 July Mexico) to ACTIVE at July 10 21:46 local time (the bug fix)', async () => {
      // Reproduces the production bug. Without normalization, a range
      // 2026-07-01..2026-07-11 (UTC-midnight instants) compares as
      // ENDED at 2026-07-11T03:46Z (July 10 21:46 local). With
      // normalization, endDate becomes 2026-07-12T05:59:59.999Z and the
      // promo is ACTIVE through the entire local day of July 11.
      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date('2026-07-11T03:46:00.000Z'));

        let captured: Promotion | null = null;
        const repo = makeRepo({
          save: jest.fn().mockImplementation((p: Promotion) => {
            captured = p;
            return p;
          }),
        });
        const prisma = makePrisma();
        const service = makeService(
          repo,
          prisma,
          makeConfigService('America/Mexico_City'),
        );

        await service.create(
          createDto({
            title: 'Promocion chida',
            type: 'ORDER_DISCOUNT',
            method: 'AUTOMATIC',
            discountType: 'PERCENTAGE',
            discountValue: 10,
            startDate: '2026-07-01T00:00:00.000Z',
            endDate: '2026-07-11T00:00:00.000Z',
          }),
        );

        // Stored bounds are the inclusive business-day boundaries.
        expect(captured!.startDate?.toISOString()).toBe(
          '2026-07-01T06:00:00.000Z',
        );
        expect(captured!.endDate?.toISOString()).toBe(
          '2026-07-12T05:59:59.999Z',
        );

        // And the effective status at this now is ACTIVE.
        const now = new Date('2026-07-11T03:46:00.000Z');
        expect(captured!.getEffectiveStatus(now)).toBe('ACTIVE');
      } finally {
        jest.useRealTimers();
      }
    });

    it('should return ENDED for the same promo one local minute after the end-day midnight', async () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date('2026-07-12T06:30:00.000Z'));

        let captured: Promotion | null = null;
        const repo = makeRepo({
          save: jest.fn().mockImplementation((p: Promotion) => {
            captured = p;
            return p;
          }),
        });
        const prisma = makePrisma();
        const service = makeService(
          repo,
          prisma,
          makeConfigService('America/Mexico_City'),
        );

        await service.create(
          createDto({
            title: 'Promocion chida (past)',
            type: 'ORDER_DISCOUNT',
            method: 'AUTOMATIC',
            discountType: 'PERCENTAGE',
            discountValue: 10,
            startDate: '2026-07-01T00:00:00.000Z',
            endDate: '2026-07-11T00:00:00.000Z',
          }),
        );

        const now = new Date('2026-07-12T06:30:00.000Z');
        expect(captured!.getEffectiveStatus(now)).toBe('ENDED');
      } finally {
        jest.useRealTimers();
      }
    });

    it('a promo whose start-day is "today in Mexico" should be ACTIVE from local midnight (not 6h shifted)', async () => {
      // At 2026-07-10T01:00Z (= July 9 19:00 local Mexico), a promo that
      // starts on July 10 must still be SCHEDULED (it has not yet
      // reached local midnight in Mexico). With normalization,
      // startDate = 2026-07-10T06:00:00Z — and the comparison with now
      // (2026-07-10T01:00Z) is correctly "future".
      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date('2026-07-10T01:00:00.000Z'));

        let captured: Promotion | null = null;
        const repo = makeRepo({
          save: jest.fn().mockImplementation((p: Promotion) => {
            captured = p;
            return p;
          }),
        });
        const prisma = makePrisma();
        const service = makeService(
          repo,
          prisma,
          makeConfigService('America/Mexico_City'),
        );

        await service.create(
          createDto({
            title: 'Starts today',
            type: 'ORDER_DISCOUNT',
            method: 'AUTOMATIC',
            discountType: 'PERCENTAGE',
            discountValue: 10,
            startDate: '2026-07-10T00:00:00.000Z',
            endDate: null,
          }),
        );

        // Stored start is local midnight on 10 July (UTC-6 → 06:00:00Z).
        expect(captured!.startDate?.toISOString()).toBe(
          '2026-07-10T06:00:00.000Z',
        );
        // At 01:00Z (5h before local midnight), the promo is still SCHEDULED.
        expect(
          captured!.getEffectiveStatus(new Date('2026-07-10T01:00:00.000Z')),
        ).toBe('SCHEDULED');
        // And after local midnight (12:00Z), the promo becomes ACTIVE.
        expect(
          captured!.getEffectiveStatus(new Date('2026-07-10T12:00:00.000Z')),
        ).toBe('ACTIVE');
      } finally {
        jest.useRealTimers();
      }
    });

    it('should keep null startDate and null endDate as null (no normalization applied)', async () => {
      let captured: Promotion | null = null;
      const repo = makeRepo({
        save: jest.fn().mockImplementation((p: Promotion) => {
          captured = p;
          return p;
        }),
      });
      const prisma = makePrisma();
      const service = makeService(
        repo,
        prisma,
        makeConfigService('America/Mexico_City'),
      );

      await service.create(
        createDto({
          title: 'No dates',
          type: 'ORDER_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'PERCENTAGE',
          discountValue: 10,
        }),
      );

      expect(captured!.startDate).toBeNull();
      expect(captured!.endDate).toBeNull();
    });

    it('should respect PROMOTIONS_BUSINESS_TIMEZONE env override (UTC produces UTC-midnight / UTC-end-of-day)', async () => {
      let captured: Promotion | null = null;
      const repo = makeRepo({
        save: jest.fn().mockImplementation((p: Promotion) => {
          captured = p;
          return p;
        }),
      });
      const prisma = makePrisma();
      const service = makeService(repo, prisma, makeConfigService('UTC'));

      await service.create(
        createDto({
          title: 'UTC tz',
          type: 'ORDER_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'PERCENTAGE',
          discountValue: 10,
          startDate: '2026-07-01T00:00:00.000Z',
          endDate: '2026-07-11T00:00:00.000Z',
        }),
      );

      // In UTC, the local-midnight instant IS the UTC-midnight instant,
      // and end-of-day is 23:59:59.999Z (no offset shift).
      expect(captured!.startDate?.toISOString()).toBe(
        '2026-07-01T00:00:00.000Z',
      );
      expect(captured!.endDate?.toISOString()).toBe('2026-07-11T23:59:59.999Z');
    });
  });

  // ── findAll ───────────────────────────────────────────────

  describe('findAll()', () => {
    it('should return paginated promotions with lazy status applied', async () => {
      const promo1 = makePromotion();
      const promo2 = makePromotion({
        id: 'promo-2',
        startDate: new Date('2040-01-01'), // future — SCHEDULED
      });

      const repo = makeRepo({
        findAll: jest.fn().mockResolvedValue({
          data: [promo1, promo2],
          total: 2,
        }),
      });
      const prisma = makePrisma();
      const service = makeService(repo, prisma);

      const result = await service.findAll(queryDto({ page: 1, limit: 20 }));

      expect(result.data).toHaveLength(2);
      expect(result.meta.total).toBe(2);
      expect(result.meta.page).toBe(1);
      expect(result.meta.limit).toBe(20);
      expect(result.meta.totalPages).toBe(1);
    });

    it('should apply defaults for page and limit when not provided', async () => {
      const repo = makeRepo({
        findAll: jest.fn().mockResolvedValue({ data: [], total: 0 }),
      });
      const prisma = makePrisma();
      const service = makeService(repo, prisma);

      await service.findAll(queryDto({}));

      expect(repo.findAll.mock.calls.at(0)?.[0]).toMatchObject({
        page: 1,
        limit: 20,
      });
    });

    it('should pass customerScope filter to repository query', async () => {
      const repo = makeRepo({
        findAll: jest.fn().mockResolvedValue({ data: [], total: 0 }),
      });
      const prisma = makePrisma();
      const service = makeService(repo, prisma);

      await service.findAll(
        queryDto({ customerScope: CustomerScopeEnum.SPECIFIC }),
      );

      expect(repo.findAll.mock.calls.at(0)?.[0]).toMatchObject({
        customerScope: 'SPECIFIC',
      });
    });

    it('should forward combined list filters including customerScope', async () => {
      const repo = makeRepo({
        findAll: jest.fn().mockResolvedValue({ data: [], total: 0 }),
      });
      const prisma = makePrisma();
      const service = makeService(repo, prisma);

      await service.findAll(
        queryDto({
          type: PromotionTypeEnum.PRODUCT_DISCOUNT,
          status: PromotionStatusEnum.ACTIVE,
          method: PromotionMethodEnum.AUTOMATIC,
          customerScope: CustomerScopeEnum.SPECIFIC,
          search: 'descuento',
          page: 2,
          limit: 5,
          sortBy: SortByEnum.title,
          sortOrder: SortOrderEnum.asc,
        }),
      );

      expect(repo.findAll.mock.calls.at(0)?.[0]).toEqual({
        type: 'PRODUCT_DISCOUNT',
        status: 'ACTIVE',
        method: 'AUTOMATIC',
        customerScope: 'SPECIFIC',
        search: 'descuento',
        page: 2,
        limit: 5,
        sortBy: 'title',
        sortOrder: 'asc',
      });
    });
  });

  // ── findOne ───────────────────────────────────────────────

  describe('findOne()', () => {
    it('should return a promotion when found', async () => {
      const promo = makePromotion();
      const repo = makeRepo({ findById: jest.fn().mockResolvedValue(promo) });
      const prisma = makePrisma();
      const service = makeService(repo, prisma);

      const result = await service.findOne('promo-1');

      expect(result.id).toBe('promo-1');
    });

    it('should throw EntityNotFoundError when promotion does not exist', async () => {
      const repo = makeRepo({ findById: jest.fn().mockResolvedValue(null) });
      const prisma = makePrisma();
      const service = makeService(repo, prisma);

      await expect(service.findOne('nonexistent')).rejects.toThrow(
        EntityNotFoundError,
      );
    });

    it('should lazily transition status from SCHEDULED to ACTIVE through runtime findOne path', async () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date('2026-01-10T00:00:00.000Z'));

        const promo = makePromotion({
          status: 'ACTIVE',
          startDate: new Date('2026-01-12T00:00:00.000Z'),
          endDate: null,
        });

        const repo = makeRepo({ findById: jest.fn().mockResolvedValue(promo) });
        const prisma = makePrisma();
        const service = makeService(repo, prisma);

        const beforeStart = await service.findOne('promo-1');
        expect(beforeStart.status).toBe('SCHEDULED');

        jest.setSystemTime(new Date('2026-01-13T00:00:00.000Z'));
        const afterStart = await service.findOne('promo-1');
        expect(afterStart.status).toBe('ACTIVE');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // ── update ────────────────────────────────────────────────

  describe('update()', () => {
    it('should update allowed fields and save', async () => {
      const existing = makePromotion();
      const updated = makePromotion({ title: 'Updated Title' });
      const repo = makeRepo({
        findById: jest.fn().mockResolvedValue(existing),
        save: jest.fn().mockResolvedValue(updated),
      });
      const prisma = makePrisma();
      const service = makeService(repo, prisma);

      const result = await service.update(
        'promo-1',
        updateDto({
          title: 'Updated Title',
        }),
      );

      expect(repo.save.mock.calls.length).toBeGreaterThan(0);
      expect(result.title).toBe('Updated Title');
    });

    it('should throw EntityNotFoundError when updating non-existent promotion', async () => {
      const repo = makeRepo({ findById: jest.fn().mockResolvedValue(null) });
      const prisma = makePrisma();
      const service = makeService(repo, prisma);

      await expect(
        service.update('nonexistent', updateDto({ title: 'New' })),
      ).rejects.toThrow(EntityNotFoundError);
    });

    it('should throw InvalidArgumentError when trying to change type', async () => {
      const existing = makePromotion();
      const repo = makeRepo({
        findById: jest.fn().mockResolvedValue(existing),
      });
      const prisma = makePrisma();
      const service = makeService(repo, prisma);

      await expect(
        service.update('promo-1', {
          type: 'ORDER_DISCOUNT',
        } as unknown as UpdatePromotionDto),
      ).rejects.toThrow(InvalidArgumentError);
    });

    it('should re-validate type invariants on patch updates', async () => {
      const existing = makePromotion({
        type: 'PRODUCT_DISCOUNT',
        discountType: 'PERCENTAGE',
        discountValue: 10,
        appliesTo: 'CATEGORIES',
      });
      const repo = makeRepo({
        findById: jest.fn().mockResolvedValue(existing),
      });
      const prisma = makePrisma();
      const service = makeService(repo, prisma);

      await expect(
        service.update('promo-1', updateDto({ buyQuantity: 2 })),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN_FIELD',
      });
      expect(repo.save.mock.calls.length).toBe(0);
    });

    it('should re-validate date range on patch updates', async () => {
      const existing = makePromotion({
        startDate: new Date('2026-01-10T00:00:00.000Z'),
      });
      const repo = makeRepo({
        findById: jest.fn().mockResolvedValue(existing),
      });
      const prisma = makePrisma();
      const service = makeService(repo, prisma);

      await expect(
        service.update(
          'promo-1',
          updateDto({ endDate: '2026-01-05T00:00:00.000Z' }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_DATE_RANGE' });
      expect(repo.save.mock.calls.length).toBe(0);
    });

    it('should reject clearing BUY_X_GET_Y targets on update as INVALID_TARGET without mutating the promotion', async () => {
      const targetItem = {
        id: 'target-1',
        side: 'DEFAULT' as const,
        targetType: 'PRODUCTS' as const,
        targetId: 'product-1',
      };
      const existing = makePromotion({
        type: 'BUY_X_GET_Y',
        discountType: null,
        discountValue: null,
        appliesTo: 'PRODUCTS',
        buyQuantity: 2,
        getQuantity: 1,
        getDiscountPercent: 100,
        targetItems: [targetItem],
      });
      const repo = makeRepo({
        findById: jest.fn().mockResolvedValue(existing),
      });
      const service = makeService(repo, makePrisma());

      await expect(
        service.update('promo-1', updateDto({ targetItems: [] })),
      ).rejects.toMatchObject({ code: 'INVALID_TARGET' });

      expect(existing.appliesTo).toBe('PRODUCTS');
      expect(existing.targetItems).toEqual([targetItem]);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('should enforce ADVANCED side-target completeness on update', async () => {
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
            targetId: 'brand-1',
          },
          {
            id: 'ti-get',
            side: 'GET',
            targetType: 'CATEGORIES',
            targetId: 'cat-1',
          },
        ],
      });

      const repo = makeRepo({
        findById: jest.fn().mockResolvedValue(existing),
      });
      const prisma = makePrisma({
        brand: { findMany: jest.fn().mockResolvedValue([{ id: 'brand-1' }]) },
        category: { findMany: jest.fn().mockResolvedValue([{ id: 'cat-1' }]) },
      });
      const service = makeService(repo, prisma);

      await expect(
        service.update('promo-1', updateDto({ getTargetItems: [] })),
      ).rejects.toMatchObject({ code: 'advanced_missing_targets' });
      expect(repo.save.mock.calls.length).toBe(0);
    });

    it('should patch type-specific scalar fields without mutating unrelated fields', async () => {
      const existing = makePromotion({
        type: 'PRODUCT_DISCOUNT',
        discountType: 'PERCENTAGE',
        discountValue: 10,
        appliesTo: 'CATEGORIES',
      });

      const repo = makeRepo({
        findById: jest.fn().mockResolvedValue(existing),
        save: jest.fn().mockImplementation((promotion: Promotion) => promotion),
      });
      const prisma = makePrisma();
      const service = makeService(repo, prisma);

      const result = await service.update(
        'promo-1',
        updateDto({ discountValue: 20 }),
      );

      expect(repo.save.mock.calls.length).toBe(1);
      expect(result.discountValue).toBe(20);
      expect(result.discountType).toBe('PERCENTAGE');
      expect(result.appliesTo).toBe('CATEGORIES');

      expect(repo.save.mock.calls.at(0)?.[0]).toMatchObject({
        discountValue: 20,
        discountType: 'PERCENTAGE',
        appliesTo: 'CATEGORIES',
      });
    });

    // ============================================================
    // STATUS RECOMPUTE — invariant: update() must re-derive status
    // from the (possibly new) date window, and must NOT clear a
    // manuallyEnded override.
    // ============================================================

    it('should flip status back to ACTIVE when extending endDate past today (date-only expiration regression)', async () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));

        // Existing promotion whose window already expired.
        const existing = makePromotion({
          status: 'ENDED',
          startDate: new Date('2026-06-01T00:00:00.000Z'),
          endDate: new Date('2026-07-05T00:00:00.000Z'),
        });

        const repo = makeRepo({
          findById: jest.fn().mockResolvedValue(existing),
          save: jest
            .fn()
            .mockImplementation((promotion: Promotion) => promotion),
        });
        const prisma = makePrisma();
        const service = makeService(repo, prisma);

        const result = await service.update(
          'promo-1',
          updateDto({ endDate: '2026-08-01T00:00:00.000Z' }),
        );

        expect(result.status).toBe('ACTIVE');
      } finally {
        jest.useRealTimers();
      }
    });

    it('should flip status to SCHEDULED when pushing startDate into the future on update', async () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));

        const existing = makePromotion({
          status: 'ACTIVE',
          startDate: new Date('2026-07-01T00:00:00.000Z'),
          endDate: new Date('2026-08-01T00:00:00.000Z'),
        });

        const repo = makeRepo({
          findById: jest.fn().mockResolvedValue(existing),
          save: jest
            .fn()
            .mockImplementation((promotion: Promotion) => promotion),
        });
        const prisma = makePrisma();
        const service = makeService(repo, prisma);

        const result = await service.update(
          'promo-1',
          updateDto({ startDate: '2026-07-20T00:00:00.000Z' }),
        );

        expect(result.status).toBe('SCHEDULED');
      } finally {
        jest.useRealTimers();
      }
    });

    it('should preserve manuallyEnded override on update() when dates are valid in-window', async () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));

        // Operator manually ended this promotion before; dates are still valid.
        const existing = makePromotion({
          status: 'ENDED',
          manuallyEnded: true,
          startDate: new Date('2026-07-01T00:00:00.000Z'),
          endDate: new Date('2026-08-01T00:00:00.000Z'),
        });

        const repo = makeRepo({
          findById: jest.fn().mockResolvedValue(existing),
          save: jest
            .fn()
            .mockImplementation((promotion: Promotion) => promotion),
        });
        const prisma = makePrisma();
        const service = makeService(repo, prisma);

        // Editing just the title — should NOT silently un-end the promo.
        const result = await service.update(
          'promo-1',
          updateDto({ title: 'New Title' }),
        );

        expect(result.status).toBe('ENDED');
      } finally {
        jest.useRealTimers();
      }
    });

    // ============================================================
    // DATE-RANGE NORMALIZATION on update()
    // update() must re-normalize whenever a date input is supplied
    // (whether or not the other bound changes). The previous fix
    // already re-validates the merged payload; this fix adds the
    // tz-aware boundary computation on top of it.
    // ============================================================

    it('should re-normalize endDate when it is changed on update() (business tz)', async () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));

        // Existing promotion stored with raw UTC-midnight endDate (the
        // pre-fix shape). The update changes endDate to "2026-07-11"
        // and we expect the service to normalize it to the business-day
        // end instant.
        const existing = makePromotion({
          status: 'ACTIVE',
          startDate: new Date('2026-07-01T06:00:00.000Z'),
          endDate: new Date('2026-07-05T05:59:59.999Z'),
        });

        let captured: Promotion | null = null;
        const repo = makeRepo({
          findById: jest.fn().mockResolvedValue(existing),
          save: jest.fn().mockImplementation((p: Promotion) => {
            captured = p;
            return p;
          }),
        });
        const prisma = makePrisma();
        const service = makeService(
          repo,
          prisma,
          makeConfigService('America/Mexico_City'),
        );

        await service.update(
          'promo-1',
          updateDto({ endDate: '2026-07-11T00:00:00.000Z' }),
        );

        expect(captured!.endDate?.toISOString()).toBe(
          '2026-07-12T05:59:59.999Z',
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('should re-normalize startDate when it is changed on update()', async () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));

        const existing = makePromotion({
          status: 'ACTIVE',
          startDate: new Date('2026-07-01T06:00:00.000Z'),
          endDate: new Date('2026-07-15T05:59:59.999Z'),
        });

        let captured: Promotion | null = null;
        const repo = makeRepo({
          findById: jest.fn().mockResolvedValue(existing),
          save: jest.fn().mockImplementation((p: Promotion) => {
            captured = p;
            return p;
          }),
        });
        const prisma = makePrisma();
        const service = makeService(
          repo,
          prisma,
          makeConfigService('America/Mexico_City'),
        );

        await service.update(
          'promo-1',
          updateDto({ startDate: '2026-07-05T00:00:00.000Z' }),
        );

        // Local midnight on 5 July in Mexico City (UTC-6) → 06:00:00Z.
        expect(captured!.startDate?.toISOString()).toBe(
          '2026-07-05T06:00:00.000Z',
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('should re-normalize both bounds when the range changes via update() and re-derive status', async () => {
      jest.useFakeTimers();
      try {
        // Same instant as the production bug: July 10 21:46 local.
        jest.setSystemTime(new Date('2026-07-11T03:46:00.000Z'));

        const existing = makePromotion({
          status: 'ACTIVE',
          startDate: new Date('2026-07-01T06:00:00.000Z'),
          endDate: new Date('2026-07-05T05:59:59.999Z'),
        });

        let captured: Promotion | null = null;
        const repo = makeRepo({
          findById: jest.fn().mockResolvedValue(existing),
          save: jest.fn().mockImplementation((p: Promotion) => {
            captured = p;
            return p;
          }),
        });
        const prisma = makePrisma();
        const service = makeService(
          repo,
          prisma,
          makeConfigService('America/Mexico_City'),
        );

        await service.update(
          'promo-1',
          updateDto({ endDate: '2026-07-11T00:00:00.000Z' }),
        );

        // After normalization, endDate is 2026-07-12T05:59:59.999Z — past
        // the current instant, so the status recomputes to ACTIVE.
        expect(captured!.endDate?.toISOString()).toBe(
          '2026-07-12T05:59:59.999Z',
        );
        expect(
          captured!.getEffectiveStatus(new Date('2026-07-11T03:46:00.000Z')),
        ).toBe('ACTIVE');
      } finally {
        jest.useRealTimers();
      }
    });

    it('should NOT re-normalize the existing endDate when the update does not change dates', async () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));

        // Already-normalized values. A title-only update must not
        // perturb them (no DST rounding, no off-by-one shift).
        const existing = makePromotion({
          status: 'ACTIVE',
          startDate: new Date('2026-07-01T06:00:00.000Z'),
          endDate: new Date('2026-07-11T05:59:59.999Z'),
        });

        let captured: Promotion | null = null;
        const repo = makeRepo({
          findById: jest.fn().mockResolvedValue(existing),
          save: jest.fn().mockImplementation((p: Promotion) => {
            captured = p;
            return p;
          }),
        });
        const prisma = makePrisma();
        const service = makeService(
          repo,
          prisma,
          makeConfigService('America/Mexico_City'),
        );

        await service.update(
          'promo-1',
          updateDto({ title: 'Edited title only' }),
        );

        // Title changed but startDate/endDate preserved bit-for-bit.
        expect(captured!.startDate?.toISOString()).toBe(
          '2026-07-01T06:00:00.000Z',
        );
        expect(captured!.endDate?.toISOString()).toBe(
          '2026-07-11T05:59:59.999Z',
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('should preserve a null endDate when update() omits endDate (no normalization on null)', async () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));

        const existing = makePromotion({
          status: 'ACTIVE',
          startDate: new Date('2026-07-01T06:00:00.000Z'),
          endDate: null,
        });

        let captured: Promotion | null = null;
        const repo = makeRepo({
          findById: jest.fn().mockResolvedValue(existing),
          save: jest.fn().mockImplementation((p: Promotion) => {
            captured = p;
            return p;
          }),
        });
        const prisma = makePrisma();
        const service = makeService(
          repo,
          prisma,
          makeConfigService('America/Mexico_City'),
        );

        await service.update(
          'promo-1',
          updateDto({ title: 'Edited title only' }),
        );

        expect(captured!.endDate).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('should set endDate to null when update() explicitly passes endDate=null', async () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));

        const existing = makePromotion({
          status: 'ACTIVE',
          startDate: new Date('2026-07-01T06:00:00.000Z'),
          endDate: new Date('2026-07-11T05:59:59.999Z'),
        });

        let captured: Promotion | null = null;
        const repo = makeRepo({
          findById: jest.fn().mockResolvedValue(existing),
          save: jest.fn().mockImplementation((p: Promotion) => {
            captured = p;
            return p;
          }),
        });
        const prisma = makePrisma();
        const service = makeService(
          repo,
          prisma,
          makeConfigService('America/Mexico_City'),
        );

        // Pass null — service must propagate null, not normalize.
        await service.update(
          'promo-1',
          updateDto({ endDate: null as unknown as string }),
        );

        expect(captured!.endDate).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // ── remove ────────────────────────────────────────────────

  describe('remove()', () => {
    it('should delete the promotion when it exists', async () => {
      const existing = makePromotion();
      const repo = makeRepo({
        findById: jest.fn().mockResolvedValue(existing),
        delete: jest.fn().mockResolvedValue(undefined),
      });
      const prisma = makePrisma();
      const service = makeService(repo, prisma);

      await service.remove('promo-1');

      expect(repo.delete.mock.calls.at(0)?.[0]).toBe('promo-1');
    });

    it('should throw EntityNotFoundError when deleting non-existent promotion', async () => {
      const repo = makeRepo({ findById: jest.fn().mockResolvedValue(null) });
      const prisma = makePrisma();
      const service = makeService(repo, prisma);

      await expect(service.remove('nonexistent')).rejects.toThrow(
        EntityNotFoundError,
      );
    });

    it('should make promotion unreachable after delete in runtime service flow', async () => {
      const storedById = new Map<string, Promotion>([
        ['promo-1', makePromotion()],
      ]);

      const repo = makeRepo({
        findById: jest.fn().mockImplementation((id: string) => {
          return Promise.resolve(storedById.get(id) ?? null);
        }),
        delete: jest.fn().mockImplementation((id: string) => {
          storedById.delete(id);
          return Promise.resolve();
        }),
      });
      const prisma = makePrisma();
      const service = makeService(repo, prisma);

      await service.remove('promo-1');

      await expect(service.findOne('promo-1')).rejects.toThrow(
        EntityNotFoundError,
      );
      expect(repo.delete.mock.calls.at(0)?.[0]).toBe('promo-1');
    });
  });

  // ── endPromotion ──────────────────────────────────────────

  describe('endPromotion()', () => {
    it('should mark a promotion as ENDED', async () => {
      const existing = makePromotion();
      const repo = makeRepo({
        findById: jest.fn().mockResolvedValue(existing),
        updateStatus: jest.fn().mockResolvedValue(undefined),
      });

      // second findById call returns updated
      const endedPromo = makePromotion({
        status: 'ENDED',
        manuallyEnded: true,
      });
      repo.findById
        .mockResolvedValueOnce(existing)
        .mockResolvedValueOnce(endedPromo);

      const prisma = makePrisma();
      const service = makeService(repo, prisma);

      const result = await service.endPromotion('promo-1');

      expect(repo.updateStatus.mock.calls.at(0)?.[0]).toBe('promo-1');
      expect(repo.updateStatus.mock.calls.at(0)?.[1]).toBe('ENDED');
      expect(repo.updateStatus.mock.calls.at(0)?.[2]).toBeTruthy();
      expect(result.status).toBe('ENDED');
    });

    it('should throw EntityNotFoundError when ending non-existent promotion', async () => {
      const repo = makeRepo({ findById: jest.fn().mockResolvedValue(null) });
      const prisma = makePrisma();
      const service = makeService(repo, prisma);

      await expect(service.endPromotion('nonexistent')).rejects.toThrow(
        EntityNotFoundError,
      );
    });

    it('should be idempotent — ending already ENDED promotion succeeds', async () => {
      const alreadyEnded = makePromotion({
        status: 'ENDED',
        manuallyEnded: true,
        endDate: new Date('2026-01-05'),
      });
      const repo = makeRepo({
        findById: jest.fn().mockResolvedValue(alreadyEnded),
        updateStatus: jest.fn().mockResolvedValue(undefined),
      });

      // second call returns the same ended promo
      repo.findById.mockResolvedValue(alreadyEnded);

      const prisma = makePrisma();
      const service = makeService(repo, prisma);

      const result = await service.endPromotion('promo-1');

      expect(repo.updateStatus.mock.calls.at(0)).toEqual([
        'promo-1',
        'ENDED',
        new Date('2026-01-05T00:00:00.000Z'),
      ]);
      expect(result.id).toBe('promo-1');
      expect(result.status).toBe('ENDED');
    });
  });

  describe('create() ADVANCED target-side validation', () => {
    it('should reject ADVANCED when buyTargetType is set but buyTargetItems is missing', async () => {
      const repo = makeRepo();
      const prisma = makePrisma({
        category: {
          findMany: jest.fn().mockResolvedValue([{ id: 'cat-1' }]),
        },
      });
      const service = makeService(repo, prisma);

      await expect(
        service.create(
          createDto({
            title: 'Advanced incomplete',
            type: 'ADVANCED',
            method: 'AUTOMATIC',
            buyQuantity: 1,
            getQuantity: 1,
            getDiscountPercent: 0,
            buyTargetType: 'BRANDS',
            getTargetType: 'CATEGORIES',
            getTargetItems: [{ targetId: 'cat-1' }],
          }),
        ),
      ).rejects.toMatchObject({ code: 'advanced_missing_targets' });

      expect(repo.save.mock.calls.length).toBe(0);
    });

    it('should reject duplicate target mappings with duplicate_target code', async () => {
      const repo = makeRepo();
      const prisma = makePrisma({
        category: {
          findMany: jest.fn().mockResolvedValue([{ id: 'cat-1' }]),
        },
      });
      const service = makeService(repo, prisma);

      await expect(
        service.create(
          createDto({
            title: 'Duplicate targets',
            type: 'PRODUCT_DISCOUNT',
            method: 'AUTOMATIC',
            discountType: 'PERCENTAGE',
            discountValue: 10,
            appliesTo: 'CATEGORIES',
            targetItems: [
              { targetType: 'CATEGORIES', targetId: 'cat-1' },
              { targetType: 'CATEGORIES', targetId: 'cat-1' },
            ],
          }),
        ),
      ).rejects.toMatchObject({ code: 'duplicate_target' });

      expect(repo.save.mock.calls.length).toBe(0);
    });
  });

  // ============================================================
  // VARIANTS target-item variant-context enrichment (read path).
  //
  // The read responses (findOne / findAll) must enrich each
  // targetItem whose targetType === 'VARIANTS' with three
  // response-only fields resolved from a SEPARATE variant lookup
  // (targetId has no FK): productId, variantName, productName.
  // Non-VARIANTS items are untouched. A missing variant leaves the
  // fields absent and does NOT throw. findAll batches the lookup
  // into a single variant.findMany across the whole page.
  // ============================================================
  describe('VARIANTS target-item variant-context enrichment', () => {
    type EnrichedTargetItem = {
      id: string;
      side: string;
      targetType: string;
      targetId: string;
      productId?: string;
      variantName?: string;
      productName?: string;
    };

    it('findOne enriches VARIANTS items with productId, variantName, productName from the variant lookup', async () => {
      const promo = makePromotion({
        appliesTo: 'VARIANTS',
        targetItems: [
          {
            id: 'ti-1',
            side: 'DEFAULT',
            targetType: 'VARIANTS',
            targetId: 'var-1',
          },
        ],
      });
      const repo = makeRepo({ findById: jest.fn().mockResolvedValue(promo) });
      const prisma = makePrisma({
        variant: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'var-1',
              productId: 'prod-1',
              name: 'Rojo / M',
              product: { name: 'Playera' },
            },
          ]),
        },
      });
      const service = makeService(repo, prisma);

      const result = await service.findOne('promo-1');
      const items = result.targetItems as EnrichedTargetItem[];

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        targetType: 'VARIANTS',
        targetId: 'var-1',
        productId: 'prod-1',
        variantName: 'Rojo / M',
        productName: 'Playera',
      });
      expect(prisma.variant.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.variant.findMany.mock.calls[0][0]).toMatchObject({
        where: { id: { in: ['var-1'] } },
      });
    });

    it('findOne leaves non-VARIANTS items untouched (no new fields)', async () => {
      const promo = makePromotion({
        appliesTo: 'CATEGORIES',
        targetItems: [
          {
            id: 'ti-cat',
            side: 'DEFAULT',
            targetType: 'CATEGORIES',
            targetId: 'cat-1',
          },
        ],
      });
      const repo = makeRepo({ findById: jest.fn().mockResolvedValue(promo) });
      const prisma = makePrisma();
      const service = makeService(repo, prisma);

      const result = await service.findOne('promo-1');
      const items = result.targetItems as EnrichedTargetItem[];

      expect(items[0]).toEqual({
        id: 'ti-cat',
        side: 'DEFAULT',
        targetType: 'CATEGORIES',
        targetId: 'cat-1',
      });
      expect(items[0].productId).toBeUndefined();
      expect(items[0].variantName).toBeUndefined();
      expect(items[0].productName).toBeUndefined();
      // No VARIANTS items → no variant lookup at all.
      expect(prisma.variant.findMany).not.toHaveBeenCalled();
    });

    it('findOne does NOT throw and adds NO fields for a VARIANTS item whose variant is missing from the lookup', async () => {
      const promo = makePromotion({
        appliesTo: 'VARIANTS',
        targetItems: [
          {
            id: 'ti-missing',
            side: 'DEFAULT',
            targetType: 'VARIANTS',
            targetId: 'var-deleted',
          },
        ],
      });
      const repo = makeRepo({ findById: jest.fn().mockResolvedValue(promo) });
      const prisma = makePrisma({
        variant: { findMany: jest.fn().mockResolvedValue([]) },
      });
      const service = makeService(repo, prisma);

      const result = await service.findOne('promo-1');
      const items = result.targetItems as EnrichedTargetItem[];

      expect(items[0]).toEqual({
        id: 'ti-missing',
        side: 'DEFAULT',
        targetType: 'VARIANTS',
        targetId: 'var-deleted',
      });
      expect(items[0].productId).toBeUndefined();
    });

    it('findOne enriches VARIANTS items on BUY/GET sides (enrich by targetType, not side)', async () => {
      const promo = makePromotion({
        type: 'ADVANCED',
        discountType: null,
        discountValue: null,
        appliesTo: null,
        buyQuantity: 1,
        getQuantity: 1,
        getDiscountPercent: 0,
        buyTargetType: 'VARIANTS',
        getTargetType: 'VARIANTS',
        targetItems: [
          {
            id: 'ti-buy',
            side: 'BUY',
            targetType: 'VARIANTS',
            targetId: 'var-buy',
          },
          {
            id: 'ti-get',
            side: 'GET',
            targetType: 'VARIANTS',
            targetId: 'var-get',
          },
        ],
      });
      const repo = makeRepo({ findById: jest.fn().mockResolvedValue(promo) });
      const prisma = makePrisma({
        variant: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'var-buy',
              productId: 'prod-buy',
              name: 'Buy V',
              product: { name: 'Buy P' },
            },
            {
              id: 'var-get',
              productId: 'prod-get',
              name: 'Get V',
              product: { name: 'Get P' },
            },
          ]),
        },
      });
      const service = makeService(repo, prisma);

      const result = await service.findOne('promo-1');
      const items = result.targetItems as EnrichedTargetItem[];

      const buy = items.find((i) => i.side === 'BUY')!;
      const get = items.find((i) => i.side === 'GET')!;
      expect(buy).toMatchObject({
        productId: 'prod-buy',
        variantName: 'Buy V',
        productName: 'Buy P',
      });
      expect(get).toMatchObject({
        productId: 'prod-get',
        variantName: 'Get V',
        productName: 'Get P',
      });
      expect(prisma.variant.findMany).toHaveBeenCalledTimes(1);
    });

    it('findAll batches the variant lookup into ONE call with all distinct variant ids across the page', async () => {
      const promo1 = makePromotion({
        id: 'promo-1',
        appliesTo: 'VARIANTS',
        targetItems: [
          {
            id: 'ti-1',
            side: 'DEFAULT',
            targetType: 'VARIANTS',
            targetId: 'var-1',
          },
          {
            id: 'ti-2',
            side: 'DEFAULT',
            targetType: 'VARIANTS',
            targetId: 'var-2',
          },
        ],
      });
      const promo2 = makePromotion({
        id: 'promo-2',
        appliesTo: 'VARIANTS',
        targetItems: [
          {
            id: 'ti-3',
            side: 'DEFAULT',
            targetType: 'VARIANTS',
            // duplicate of promo1's var-2 → must be de-duped in the IN(...)
            targetId: 'var-2',
          },
          {
            id: 'ti-4',
            side: 'DEFAULT',
            targetType: 'VARIANTS',
            targetId: 'var-3',
          },
          {
            id: 'ti-cat',
            side: 'DEFAULT',
            targetType: 'CATEGORIES',
            targetId: 'cat-9',
          },
        ],
      });
      const repo = makeRepo({
        findAll: jest
          .fn()
          .mockResolvedValue({ data: [promo1, promo2], total: 2 }),
      });
      const prisma = makePrisma({
        variant: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'var-1',
              productId: 'p1',
              name: 'V1',
              product: { name: 'P1' },
            },
            {
              id: 'var-2',
              productId: 'p2',
              name: 'V2',
              product: { name: 'P2' },
            },
            {
              id: 'var-3',
              productId: 'p3',
              name: 'V3',
              product: { name: 'P3' },
            },
          ]),
        },
      });
      const service = makeService(repo, prisma);

      const result = await service.findAll(queryDto({ page: 1, limit: 20 }));

      // Exactly ONE lookup for the whole page (no N+1).
      expect(prisma.variant.findMany).toHaveBeenCalledTimes(1);
      const inArg = prisma.variant.findMany.mock.calls[0][0].where.id
        .in as string[];
      expect([...inArg].sort()).toEqual(['var-1', 'var-2', 'var-3']);

      const p1Items = result.data[0].targetItems as EnrichedTargetItem[];
      const p2Items = result.data[1].targetItems as EnrichedTargetItem[];
      expect(p1Items.find((i) => i.targetId === 'var-1')).toMatchObject({
        productId: 'p1',
        variantName: 'V1',
        productName: 'P1',
      });
      expect(p2Items.find((i) => i.targetId === 'var-3')).toMatchObject({
        productId: 'p3',
        variantName: 'V3',
        productName: 'P3',
      });
      // CATEGORIES item untouched.
      expect(p2Items.find((i) => i.targetId === 'cat-9')).toEqual({
        id: 'ti-cat',
        side: 'DEFAULT',
        targetType: 'CATEGORIES',
        targetId: 'cat-9',
      });
    });

    it('findAll does NOT call the variant lookup when the page has no VARIANTS items', async () => {
      const promo = makePromotion({
        appliesTo: 'CATEGORIES',
        targetItems: [
          {
            id: 'ti-cat',
            side: 'DEFAULT',
            targetType: 'CATEGORIES',
            targetId: 'cat-1',
          },
        ],
      });
      const repo = makeRepo({
        findAll: jest.fn().mockResolvedValue({ data: [promo], total: 1 }),
      });
      const prisma = makePrisma();
      const service = makeService(repo, prisma);

      await service.findAll(queryDto({ page: 1, limit: 20 }));

      expect(prisma.variant.findMany).not.toHaveBeenCalled();
    });
  });
});
