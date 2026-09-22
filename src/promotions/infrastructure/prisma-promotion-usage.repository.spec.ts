/** Unit proof for the ambient-transaction-only capacity claim repository. */
import { MODULE_METADATA } from '@nestjs/common/constants';
import { PrismaPromotionUsageRepository } from './prisma-promotion-usage.repository';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  PROMOTION_USAGE_REPOSITORY,
  type PromotionCapacityClaim,
} from '../domain/promotion-usage.repository';
import { PromotionsModule } from '../promotions.module';

const PG_INT_MAX = 2_147_483_647;

type PrismaMock = {
  promotionUsage: { createMany: jest.Mock; findUnique: jest.Mock };
  $executeRaw: jest.Mock;
};

function makeHarness(inTransaction = true) {
  const prisma: PrismaMock = {
    promotionUsage: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  const tenantPrisma = {
    isInTransaction: jest.fn().mockReturnValue(inTransaction),
    getTenantId: jest.fn().mockReturnValue('tenant-1'),
    getClient: jest.fn().mockReturnValue(prisma),
  };
  return {
    repo: new PrismaPromotionUsageRepository(
      tenantPrisma as unknown as TenantPrismaService,
    ),
    tenantPrisma,
    prisma,
  };
}

const claim = (promotionId: string, units: number): PromotionCapacityClaim => ({
  promotionId,
  units,
});

const createdPromotionId = (call: unknown[]): unknown =>
  (call[0] as { data: PromotionCapacityClaim[] }).data[0].promotionId;

const executedPromotionId = (call: unknown[]): unknown =>
  (call[0] as { values: unknown[] }).values[1];

describe('PrismaPromotionUsageRepository.claimForSale', () => {
  it('rejects without transaction authority before any client access or write', async () => {
    const { repo, tenantPrisma, prisma } = makeHarness(false);

    await expect(
      repo.claimForSale('sale-1', [claim('p', 1)]),
    ).rejects.toMatchObject({
      code: 'PROMOTION_CAPACITY_CLAIM_OUTSIDE_TRANSACTION',
    });
    await expect(repo.claimForSale('sale-1', [])).rejects.toMatchObject({
      code: 'PROMOTION_CAPACITY_CLAIM_OUTSIDE_TRANSACTION',
    });
    expect(tenantPrisma.getClient).not.toHaveBeenCalled();
    expect(prisma.promotionUsage.createMany).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('no-ops for empty claims inside a transaction without touching the client', async () => {
    const { repo, tenantPrisma, prisma } = makeHarness();

    await expect(repo.claimForSale('sale-1', [])).resolves.toBeUndefined();
    expect(tenantPrisma.getClient).not.toHaveBeenCalled();
    expect(prisma.promotionUsage.createMany).not.toHaveBeenCalled();
  });

  it.each<[string, PromotionCapacityClaim[], string]>([
    ['empty promotionId', [claim('', 1)], 'PROMOTION_CAPACITY_CLAIM_INVALID'],
    ['zero units', [claim('p', 0)], 'PROMOTION_CAPACITY_CLAIM_INVALID'],
    ['negative units', [claim('p', -1)], 'PROMOTION_CAPACITY_CLAIM_INVALID'],
    ['fractional units', [claim('p', 1.5)], 'PROMOTION_CAPACITY_CLAIM_INVALID'],
    [
      'units above PostgreSQL INTEGER',
      [claim('p', PG_INT_MAX + 1)],
      'PROMOTION_CAPACITY_CLAIM_INVALID',
    ],
    [
      'unsafe integer units',
      [claim('p', Number.MAX_SAFE_INTEGER + 1)],
      'PROMOTION_CAPACITY_CLAIM_INVALID',
    ],
    [
      'duplicate promotionId',
      [claim('p', 1), claim('p', 2)],
      'PROMOTION_CAPACITY_CLAIM_DUPLICATE',
    ],
  ])('rejects %s before any write', async (_label, claims, code) => {
    const { repo, prisma } = makeHarness();

    await expect(repo.claimForSale('sale-1', claims)).rejects.toMatchObject({
      code,
    });
    expect(prisma.promotionUsage.createMany).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('writes in ascending promotionId order and keeps the input unmodified', async () => {
    const { repo, prisma } = makeHarness();
    const claims = [claim('zeta', 1), claim('alpha', 2)];

    await repo.claimForSale('sale-1', claims);

    expect(claims.map((c) => c.promotionId)).toEqual(['zeta', 'alpha']);
    expect(
      prisma.promotionUsage.createMany.mock.calls.map(createdPromotionId),
    ).toEqual(['alpha', 'zeta']);
    expect(prisma.$executeRaw.mock.calls.map(executedPromotionId)).toEqual([
      'alpha',
      'zeta',
    ]);
  });

  it('inserts the unique row then conditionally increments under tenant-qualified guards', async () => {
    const { repo, prisma } = makeHarness();

    await repo.claimForSale('sale-1', [claim('p', 2)]);

    expect(prisma.promotionUsage.createMany).toHaveBeenCalledWith({
      data: [
        { tenantId: 'tenant-1', saleId: 'sale-1', promotionId: 'p', units: 2 },
      ],
      skipDuplicates: true,
    });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const [rawCall] = prisma.$executeRaw.mock.calls as Array<[unknown]>;
    const { sql, values } = rawCall[0] as { sql: string; values: unknown[] };
    expect(sql).toContain('"consumedProductUnits" = "consumedProductUnits" +');
    expect(sql).toContain('"id" =');
    expect(sql).toContain('"tenantId" =');
    expect(sql).toContain('"maxProductUnits" IS NULL');
    expect(sql).toContain('"maxProductUnits" -');
    expect(values).toEqual([2, 'p', 'tenant-1', PG_INT_MAX, 2, 2]);
  });

  it('throws PROMOTION_CAPACITY_EXCEEDED when the conditional update matches no row', async () => {
    const { repo, prisma } = makeHarness();
    prisma.$executeRaw.mockResolvedValue(0);

    await expect(
      repo.claimForSale('sale-1', [claim('p', 5)]),
    ).rejects.toMatchObject({
      code: 'PROMOTION_CAPACITY_EXCEEDED',
      details: { saleId: 'sale-1', promotionId: 'p', units: 5 },
    });
  });

  it('skips the increment for an equal active ledger row (same-sale retry)', async () => {
    const { repo, prisma } = makeHarness();
    prisma.promotionUsage.createMany.mockResolvedValue({ count: 0 });
    prisma.promotionUsage.findUnique.mockResolvedValue({
      units: 3,
      restoredAt: null,
    });

    await expect(
      repo.claimForSale('sale-1', [claim('p', 3)]),
    ).resolves.toBeUndefined();
    expect(prisma.promotionUsage.findUnique).toHaveBeenCalledWith({
      where: {
        tenantId_saleId_promotionId: {
          tenantId: 'tenant-1',
          saleId: 'sale-1',
          promotionId: 'p',
        },
      },
    });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it.each<[string, unknown]>([
    ['missing row', null],
    ['mismatched units', { units: 2, restoredAt: null }],
    ['restored row', { units: 3, restoredAt: new Date() }],
  ])('throws PROMOTION_CAPACITY_CLAIM_MISMATCH for %s', async (_label, row) => {
    const { repo, prisma } = makeHarness();
    prisma.promotionUsage.createMany.mockResolvedValue({ count: 0 });
    prisma.promotionUsage.findUnique.mockResolvedValue(row);

    await expect(
      repo.claimForSale('sale-1', [claim('p', 3)]),
    ).rejects.toMatchObject({
      code: 'PROMOTION_CAPACITY_CLAIM_MISMATCH',
      details: { saleId: 'sale-1', promotionId: 'p', units: 3 },
    });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('propagates a later failure after earlier ordered writes (caller rolls back)', async () => {
    const { repo, prisma } = makeHarness();
    prisma.$executeRaw.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await expect(
      repo.claimForSale('sale-1', [claim('beta', 1), claim('alpha', 1)]),
    ).rejects.toMatchObject({ code: 'PROMOTION_CAPACITY_EXCEEDED' });
    expect(prisma.promotionUsage.createMany).toHaveBeenCalledTimes(2);
    expect(prisma.$executeRaw.mock.calls.map(executedPromotionId)).toEqual([
      'alpha',
      'beta',
    ]);
  });
});

describe('PromotionsModule capacity claim wiring', () => {
  it('registers and exports the usage repository symbol', () => {
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      PromotionsModule,
    ) as unknown[];
    const exports = Reflect.getMetadata(
      MODULE_METADATA.EXPORTS,
      PromotionsModule,
    ) as unknown[];

    expect(providers).toContainEqual({
      provide: PROMOTION_USAGE_REPOSITORY,
      useClass: PrismaPromotionUsageRepository,
    });
    expect(exports).toContain(PROMOTION_USAGE_REPOSITORY);
  });
});
