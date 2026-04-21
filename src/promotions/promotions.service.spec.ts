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
    ...overrides,
  };
}

function makeService(
  repo: IPromotionRepository,
  prisma: PrismaLookupMock,
): PromotionsService {
  return new PromotionsService(repo, prisma as unknown as PrismaService);
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

    it('should create a BUY_X_GET_Y promotion', async () => {
      const saved = makePromotion({ type: 'BUY_X_GET_Y' });
      const repo = makeRepo({ save: jest.fn().mockResolvedValue(saved) });
      const prisma = makePrisma();
      const service = makeService(repo, prisma);

      const result = await service.create(
        createDto({
          title: '2x1',
          type: 'BUY_X_GET_Y',
          method: 'AUTOMATIC',
          buyQuantity: 2,
          getQuantity: 1,
          getDiscountPercent: 0,
        }),
      );

      expect(result.type).toBe('BUY_X_GET_Y');
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
      const endedPromo = makePromotion({ status: 'ENDED' });
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
});
