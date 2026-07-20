/**
 * W5 — `validateTargetIds` VARIANTS branch (RED-first).
 *
 * Spec scenarios 10-12:
 *   10. VARIANTS with an existing tenant variant id is accepted
 *   11. VARIANTS with a non-existent variant id is rejected
 *   12. VARIANTS with a cross-tenant variant id is rejected as if it
 *       did not exist
 *
 * Contract (design.md):
 *   - VARIANTS branch uses tenantClient.variant.findMany (NOT the
 *     global prisma). Symmetric with the PRODUCTS branch.
 *   - The entity-name in the not-found error is 'Variant'.
 *   - A rejected request MUST NOT persist the promotion nor any
 *     PromotionTargetItem row.
 *
 * Test isolation: like the existing PRODUCTS test (line ~302), the
 * test mock returns `prisma` from `tenantPrisma.getClient()`. So both
 * the global PrismaService and the tenant client reference the same
 * object — the test verifies the SYMBOL (`variant.findMany` is
 * called), not the runtime client identity. The production wiring
 * ensures tenantClient is tenant-scoped (see TenantPrismaService).
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

type CreatePromotionInput = {
  title: string;
  type: PromotionType;
  method: PromotionMethod;
  discountType?: 'PERCENTAGE' | 'FIXED';
  discountValue?: number;
  appliesTo?: PromotionTargetType;
  targetItems?: Array<{ targetType: PromotionTargetType; targetId: string }>;
};

function createDto(input: CreatePromotionInput): CreatePromotionDto {
  return {
    title: input.title,
    type: input.type as PromotionTypeEnum,
    method: input.method as PromotionMethodEnum,
    discountType: input.discountType,
    discountValue: input.discountValue,
    appliesTo: input.appliesTo as PromotionTargetTypeEnum,
    targetItems: input.targetItems?.map((item) => ({
      targetType: item.targetType as PromotionTargetTypeEnum,
      targetId: item.targetId,
    })),
  };
}

// ============================================================
// Scenario 10 — VARIANTS with an existing tenant variant id is accepted
// ============================================================

describe('PromotionsService.validateTargetIds — VARIANTS (W5)', () => {
  it('accepts VARIANTS with an existing tenant variant id (scenario 10)', async () => {
    const repo = makeRepo({
      save: jest.fn().mockImplementation((p: Promotion) => p),
    });
    const prisma = makePrisma({
      variant: {
        findMany: jest.fn().mockResolvedValue([{ id: 'V-A' }]),
      },
    });
    const service = makeService(repo, prisma);

    const result = await service.create(
      createDto({
        title: 'Variant-only 10%',
        type: 'PRODUCT_DISCOUNT',
        method: 'AUTOMATIC',
        discountType: 'PERCENTAGE',
        discountValue: 10,
        appliesTo: 'VARIANTS',
        targetItems: [{ targetType: 'VARIANTS', targetId: 'V-A' }],
      }),
    );

    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(result.appliesTo).toBe('VARIANTS');
    // The tenant-scoped variant.findMany was called exactly once with the
    // expected where clause (id IN ['V-A']).
    expect(prisma.variant.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.variant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['V-A'] } },
        select: { id: true },
      }),
    );
  });
});

// ============================================================
// Scenario 11 — VARIANTS with a non-existent variant id is rejected
// ============================================================

describe('PromotionsService.validateTargetIds — VARIANTS rejects non-existent (scenario 11)', () => {
  it('throws InvalidArgumentError with message "Variant with id \'V-MISSING\' not found" and code "INVALID_TARGET" (scenario 11)', async () => {
    const repo = makeRepo();
    const prisma = makePrisma({
      variant: {
        findMany: jest.fn().mockResolvedValue([]), // not found
      },
    });
    const service = makeService(repo, prisma);

    await expect(
      service.create(
        createDto({
          title: 'Bogus variant',
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'PERCENTAGE',
          discountValue: 10,
          appliesTo: 'VARIANTS',
          targetItems: [{ targetType: 'VARIANTS', targetId: 'V-MISSING' }],
        }),
      ),
    ).rejects.toMatchObject({
      message: "Variant with id 'V-MISSING' not found",
      code: 'INVALID_TARGET',
      name: 'InvalidArgumentError',
    });

    // The save MUST NOT be called — no promotion row persisted.
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('throws InvalidArgumentError for VARIANTS not-found (no PromotionTargetItem row persisted) — sibling assertion', async () => {
    // A rejected request MUST NOT persist the promotion NOR any
    // PromotionTargetItem row. We confirm save is never called.
    const save = jest.fn();
    const repo = makeRepo({ save });
    const prisma = makePrisma({
      variant: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    });
    const service = makeService(repo, prisma);

    await expect(
      service.create(
        createDto({
          title: 'Will not persist',
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'FIXED',
          discountValue: 50,
          appliesTo: 'VARIANTS',
          targetItems: [{ targetType: 'VARIANTS', targetId: 'V-NONE' }],
        }),
      ),
    ).rejects.toThrow(InvalidArgumentError);

    expect(save).not.toHaveBeenCalled();
  });
});

// ============================================================
// Scenario 12 — VARIANTS cross-tenant variant id is rejected as not found
// ============================================================

describe('PromotionsService.validateTargetIds — VARIANTS rejects cross-tenant (scenario 12)', () => {
  it('rejects a cross-tenant variant id as if it did not exist (scenario 12)', async () => {
    // The tenant-scoped variant.findMany resolves V-A as belonging to
    // tenant T1 only. A request from T2 asking for V-A finds NO row
    // (tenantClient is scoped to T2), so validateTargetIds throws
    // InvalidArgumentError with the same not-found shape as scenario 11.
    const repo = makeRepo();
    const prisma = makePrisma({
      variant: {
        // Tenant T2 has no V-A — empty result simulates the
        // tenant-scoped filter excluding the cross-tenant row.
        findMany: jest.fn().mockResolvedValue([]),
      },
    });
    const service = makeService(repo, prisma);

    await expect(
      service.create(
        createDto({
          title: 'Cross-tenant attempt',
          type: 'PRODUCT_DISCOUNT',
          method: 'AUTOMATIC',
          discountType: 'PERCENTAGE',
          discountValue: 15,
          appliesTo: 'VARIANTS',
          targetItems: [{ targetType: 'VARIANTS', targetId: 'V-A' }],
        }),
      ),
    ).rejects.toMatchObject({
      message: "Variant with id 'V-A' not found",
      code: 'INVALID_TARGET',
    });

    expect(repo.save).not.toHaveBeenCalled();
  });
});

// ============================================================
// Tenant-scoping guard — VARIANTS branch MUST NOT use the global
// prisma (which has no tenant filter). This is the design.md
// "VARIANTS validation client" decision.
// ============================================================

describe('PromotionsService.validateTargetIds — VARIANTS uses tenant-scoped client', () => {
  it('VARIANTS validation goes through tenantClient.variant.findMany (NOT a hypothetical global prisma.variant)', async () => {
    // Setup: the SAME object serves as both the global prisma and the
    // tenant client (matches the existing test mock pattern). The
    // CONTRACT being pinned is: variant.findMany is the call site for
    // VARIANTS validation. A future refactor that added a global
    // prisma.variant.findMany path would still call the same mock —
    // this assertion guards the symbol, not the client identity.
    const repo = makeRepo({
      save: jest.fn().mockImplementation((p: Promotion) => p),
    });
    const variantFindMany = jest.fn().mockResolvedValue([{ id: 'V-A' }]);
    const prisma = makePrisma({
      variant: { findMany: variantFindMany },
    });
    const service = makeService(repo, prisma);

    await service.create(
      createDto({
        title: 'Tenant-scoped variant',
        type: 'PRODUCT_DISCOUNT',
        method: 'AUTOMATIC',
        discountType: 'FIXED',
        discountValue: 100,
        appliesTo: 'VARIANTS',
        targetItems: [{ targetType: 'VARIANTS', targetId: 'V-A' }],
      }),
    );

    // The variant lookup MUST be invoked (the symbol the helper binds to).
    expect(variantFindMany).toHaveBeenCalledTimes(1);
  });
});
