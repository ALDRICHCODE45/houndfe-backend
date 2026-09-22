/** Unit proof for the ambient-transaction-only capacity claim/restore repository. */
import { MODULE_METADATA } from '@nestjs/common/constants';
import { PrismaPromotionUsageRepository } from './prisma-promotion-usage.repository';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { OutboxWriterService } from '../../shared/outbox/outbox-writer.service';
import {
  PROMOTION_USAGE_REPOSITORY,
  type PromotionCapacityClaim,
} from '../domain/promotion-usage.repository';
import { PromotionsModule } from '../promotions.module';
import { OutboxModule } from '../../shared/outbox/outbox.module';

const PG_INT_MAX = 2_147_483_647;

/**
 * The `UPDATE ... RETURNING` row for a claim; `maxProductUnits` is nullable
 * and drives the finite-cap crossing decision.
 */
type ReturnedCounterRow = {
  consumedProductUnits: number;
  maxProductUnits: number | null;
};

type PrismaMock = {
  promotionUsage: {
    createMany: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
  };
  $executeRaw: jest.Mock;
  $queryRaw: jest.Mock;
};

/** Structural single-method stand-in that keeps `.mock` introspectable. */
type OutboxMock = {
  publish: jest.Mock<Promise<void>, Parameters<OutboxWriterService['publish']>>;
};

function makeHarness(inTransaction = true) {
  const prisma: PrismaMock = {
    promotionUsage: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
    // Default: unlimited cap, so the generic claim path never crosses.
    $queryRaw: jest
      .fn()
      .mockResolvedValue([{ consumedProductUnits: 1, maxProductUnits: null }]),
  };
  const tenantPrisma = {
    isInTransaction: jest.fn().mockReturnValue(inTransaction),
    getTenantId: jest.fn().mockReturnValue('tenant-1'),
    getClient: jest.fn().mockReturnValue(prisma),
  };
  // Structural typing makes the single-method service a valid stand-in.
  const outbox: OutboxMock = {
    publish: jest
      .fn<Promise<void>, Parameters<OutboxWriterService['publish']>>()
      .mockResolvedValue(undefined),
  };
  return {
    repo: new PrismaPromotionUsageRepository(
      tenantPrisma as unknown as TenantPrismaService,
      outbox,
    ),
    tenantPrisma,
    prisma,
    outbox,
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

const executedSql = (call: unknown[]): string =>
  (call[0] as { sql: string }).sql;

const isStampCall = (call: unknown[]): boolean =>
  executedSql(call).includes('"promotion_usages"');

// Stamp binds (tenantId, saleId, promotionId); decrement binds
// (units, promotionId, tenantId). Both expose the promotionId at a
// different value index, so the helper branches on the statement.
const writtenPromotionId = (call: unknown[]): unknown => {
  const { values } = call[0] as { values: unknown[] };
  return isStampCall(call) ? values[2] : values[1];
};

const ledgerRow = (promotionId: string, units: number) => ({
  promotionId,
  units,
});

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
    expect(prisma.$queryRaw.mock.calls.map(executedPromotionId)).toEqual([
      'alpha',
      'zeta',
    ]);
  });

  it('inserts the unique row then atomically increments with RETURNING under tenant-qualified guards', async () => {
    const { repo, prisma, outbox } = makeHarness();

    await repo.claimForSale('sale-1', [claim('p', 2)]);

    expect(prisma.promotionUsage.createMany).toHaveBeenCalledWith({
      data: [
        { tenantId: 'tenant-1', saleId: 'sale-1', promotionId: 'p', units: 2 },
      ],
      skipDuplicates: true,
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    const [rawCall] = prisma.$queryRaw.mock.calls as Array<[unknown]>;
    const { sql, values } = rawCall[0] as { sql: string; values: unknown[] };
    expect(sql).toContain('"consumedProductUnits" = "consumedProductUnits" +');
    expect(sql).toContain('"id" =');
    expect(sql).toContain('"tenantId" =');
    expect(sql).toContain('"maxProductUnits" IS NULL');
    expect(sql).toContain('"maxProductUnits" -');
    expect(sql).toContain(
      'RETURNING "consumedProductUnits", "maxProductUnits"',
    );
    expect(values).toEqual([2, 'p', 'tenant-1', PG_INT_MAX, 2, 2]);
    expect(outbox.publish).not.toHaveBeenCalled();
  });

  it('throws PROMOTION_CAPACITY_EXCEEDED when the conditional update matches no row', async () => {
    const { repo, prisma, outbox } = makeHarness();
    prisma.$queryRaw.mockResolvedValue([] as ReturnedCounterRow[]);

    await expect(
      repo.claimForSale('sale-1', [claim('p', 5)]),
    ).rejects.toMatchObject({
      code: 'PROMOTION_CAPACITY_EXCEEDED',
      details: { saleId: 'sale-1', promotionId: 'p', units: 5 },
    });
    expect(outbox.publish).not.toHaveBeenCalled();
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
    const { repo, prisma, outbox } = makeHarness();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        { consumedProductUnits: 1, maxProductUnits: null },
      ])
      .mockResolvedValueOnce([]);

    await expect(
      repo.claimForSale('sale-1', [claim('beta', 1), claim('alpha', 1)]),
    ).rejects.toMatchObject({ code: 'PROMOTION_CAPACITY_EXCEEDED' });
    expect(prisma.promotionUsage.createMany).toHaveBeenCalledTimes(2);
    expect(prisma.$queryRaw.mock.calls.map(executedPromotionId)).toEqual([
      'alpha',
      'beta',
    ]);
    expect(outbox.publish).not.toHaveBeenCalled();
  });

  describe('near-capacity outbox emission', () => {
    const FIXED_NOW = new Date('2026-02-03T04:05:06.000Z');

    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(FIXED_NOW);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    const crossingRow = (
      consumed: number,
      max: number,
    ): ReturnedCounterRow => ({
      consumedProductUnits: consumed,
      maxProductUnits: max,
    });

    const publishedPayloads = (
      outbox: OutboxMock,
    ): Array<Parameters<OutboxWriterService['publish']>[5]> =>
      outbox.publish.mock.calls.map((call) => call[5]);

    it('publishes one event through the ambient transaction client on an exact-80 boundary crossing', async () => {
      const { repo, prisma, outbox } = makeHarness();
      prisma.$queryRaw.mockResolvedValue([crossingRow(80, 100)]);

      await repo.claimForSale('sale-1', [claim('p', 10)]);

      expect(outbox.publish).toHaveBeenCalledTimes(1);
      const call = outbox.publish.mock.calls[0];
      expect(call[0]).toBe(prisma);
      expect(call[1]).toBe('tenant-1');
      expect(call[2]).toBe('Promotion');
      expect(call[3]).toBe('p');
      expect(call[4]).toBe('promotion.near_capacity.detected');
      expect(call[5]).toEqual({
        tenantId: 'tenant-1',
        promotionId: 'p',
        saleId: 'sale-1',
        previousConsumedProductUnits: 70,
        consumedProductUnits: 80,
        maxProductUnits: 100,
        occurredAt: FIXED_NOW.toISOString(),
      });
    });

    it('publishes when a below-threshold increment crosses to above the threshold', async () => {
      const { repo, prisma, outbox } = makeHarness();
      prisma.$queryRaw.mockResolvedValue([crossingRow(81, 100)]);

      await repo.claimForSale('sale-1', [claim('p', 11)]);

      expect(publishedPayloads(outbox)).toEqual([
        {
          tenantId: 'tenant-1',
          promotionId: 'p',
          saleId: 'sale-1',
          previousConsumedProductUnits: 70,
          consumedProductUnits: 81,
          maxProductUnits: 100,
          occurredAt: FIXED_NOW.toISOString(),
        },
      ]);
    });

    it.each<[string, ReturnedCounterRow, number]>([
      ['a below-threshold increment stays below', crossingRow(79, 100), 9],
      [
        'the counter is already exactly at the threshold',
        crossingRow(85, 100),
        5,
      ],
      ['the counter is already above the threshold', crossingRow(130, 100), 30],
      ['the increment lands below the threshold', crossingRow(1, 10), 1],
    ])('emits nothing when %s', async (_label, row, units) => {
      const { repo, prisma, outbox } = makeHarness();
      prisma.$queryRaw.mockResolvedValue([row]);

      await repo.claimForSale('sale-1', [claim('p', units)]);

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(outbox.publish).not.toHaveBeenCalled();
    });

    it('emits nothing for an unlimited promotion', async () => {
      const { repo, prisma, outbox } = makeHarness();
      prisma.$queryRaw.mockResolvedValue([
        { consumedProductUnits: 1_000_000, maxProductUnits: null },
      ]);

      await repo.claimForSale('sale-1', [claim('p', 1_000)]);

      expect(outbox.publish).not.toHaveBeenCalled();
    });

    it('emits nothing on an idempotent same-sale retry', async () => {
      const { repo, prisma, outbox } = makeHarness();
      prisma.promotionUsage.createMany.mockResolvedValue({ count: 0 });
      prisma.promotionUsage.findUnique.mockResolvedValue({
        units: 10,
        restoredAt: null,
      });

      await repo.claimForSale('sale-1', [claim('p', 10)]);

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(outbox.publish).not.toHaveBeenCalled();
    });

    it('publishes one event per crossing promotion in ascending promotion order', async () => {
      const { repo, prisma, outbox } = makeHarness();
      prisma.$queryRaw.mockResolvedValue([crossingRow(85, 100)]);

      await repo.claimForSale('sale-1', [
        claim('zeta', 10),
        claim('alpha', 10),
      ]);

      expect(outbox.publish).toHaveBeenCalledTimes(2);
      expect(outbox.publish.mock.calls.map((call) => call[3])).toEqual([
        'alpha',
        'zeta',
      ]);
    });

    it('emits nothing on the restore path', async () => {
      const { repo, prisma, outbox } = makeHarness();
      prisma.promotionUsage.findMany.mockResolvedValue([ledgerRow('p', 3)]);

      await repo.restoreForSale('sale-1');

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(outbox.publish).not.toHaveBeenCalled();
    });
  });
});

describe('PrismaPromotionUsageRepository.restoreForSale', () => {
  it('rejects without transaction authority before any client access or write', async () => {
    const { repo, tenantPrisma, prisma } = makeHarness(false);

    await expect(repo.restoreForSale('sale-1')).rejects.toMatchObject({
      code: 'PROMOTION_CAPACITY_RESTORE_OUTSIDE_TRANSACTION',
    });
    await expect(repo.restoreForSale('')).rejects.toMatchObject({
      code: 'PROMOTION_CAPACITY_RESTORE_OUTSIDE_TRANSACTION',
    });
    expect(tenantPrisma.getClient).not.toHaveBeenCalled();
    expect(prisma.promotionUsage.findMany).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('rejects an empty sale id before any read or write', async () => {
    const { repo, tenantPrisma, prisma } = makeHarness();

    await expect(repo.restoreForSale('')).rejects.toMatchObject({
      code: 'PROMOTION_CAPACITY_RESTORE_INVALID',
    });
    expect(tenantPrisma.getClient).not.toHaveBeenCalled();
    expect(prisma.promotionUsage.findMany).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('no-ops for an empty active ledger without writing', async () => {
    const { repo, prisma } = makeHarness();
    prisma.promotionUsage.findMany.mockResolvedValue([]);

    await expect(repo.restoreForSale('sale-1')).resolves.toBeUndefined();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('reads only the active rows with an explicit tenant-qualified filter and locale-independent order', async () => {
    const { repo, prisma } = makeHarness();

    await repo.restoreForSale('sale-1');

    expect(prisma.promotionUsage.findMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', saleId: 'sale-1', restoredAt: null },
      select: { promotionId: true, units: true },
      orderBy: { promotionId: 'asc' },
    });
    expect(prisma.promotionUsage.createMany).not.toHaveBeenCalled();
  });

  it('guards the stamp and the decrement with tenant-qualified conditions', async () => {
    const { repo, prisma } = makeHarness();
    prisma.promotionUsage.findMany.mockResolvedValue([ledgerRow('p', 3)]);

    await repo.restoreForSale('sale-1');

    const [stampCall, decrementCall] = prisma.$executeRaw.mock.calls as Array<
      [{ sql: string; values: unknown[] }]
    >;
    expect(stampCall[0].sql).toContain('UPDATE "promotion_usages"');
    expect(stampCall[0].sql).toContain('"restoredAt" = NOW()');
    expect(stampCall[0].sql).toContain('"restoredAt" IS NULL');
    expect(stampCall[0].sql).toContain('"tenantId" =');
    expect(stampCall[0].sql).toContain('"saleId" =');
    expect(stampCall[0].values).toEqual(['tenant-1', 'sale-1', 'p']);

    expect(decrementCall[0].sql).toContain('UPDATE "promotions"');
    expect(decrementCall[0].sql).toContain(
      '"consumedProductUnits" = "consumedProductUnits" -',
    );
    expect(decrementCall[0].sql).toContain('"consumedProductUnits" >=');
    expect(decrementCall[0].sql).toContain('"updatedAt" = NOW()');
    // `units` is bound twice: once in the SET and once in the `>=` guard.
    expect(decrementCall[0].values).toEqual([3, 'p', 'tenant-1', 3]);
  });

  it('stamps then decrements every ledger row in ascending promotion order', async () => {
    const { repo, prisma } = makeHarness();
    prisma.promotionUsage.findMany.mockResolvedValue([
      ledgerRow('alpha', 2),
      ledgerRow('zeta', 5),
    ]);

    await repo.restoreForSale('sale-1');

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(4);
    expect(prisma.$executeRaw.mock.calls.map(isStampCall)).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect(prisma.$executeRaw.mock.calls.map(writtenPromotionId)).toEqual([
      'alpha',
      'alpha',
      'zeta',
      'zeta',
    ]);
  });

  it('skips the decrement when a concurrent retry already stamped the row', async () => {
    const { repo, prisma } = makeHarness();
    prisma.promotionUsage.findMany.mockResolvedValue([ledgerRow('p', 2)]);
    prisma.$executeRaw.mockResolvedValue(0);

    await expect(repo.restoreForSale('sale-1')).resolves.toBeUndefined();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(isStampCall(prisma.$executeRaw.mock.calls[0] as unknown[])).toBe(
      true,
    );
  });

  it('decrements only for rows won by this retry during a partial concurrent restore', async () => {
    const { repo, prisma } = makeHarness();
    prisma.promotionUsage.findMany.mockResolvedValue([
      ledgerRow('alpha', 2),
      ledgerRow('beta', 4),
    ]);
    prisma.$executeRaw
      .mockResolvedValueOnce(1) // alpha stamp won
      .mockResolvedValueOnce(1) // alpha decrement
      .mockResolvedValueOnce(0); // beta stamp lost to a concurrent retry

    await expect(repo.restoreForSale('sale-1')).resolves.toBeUndefined();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(3);
    expect(prisma.$executeRaw.mock.calls.map(writtenPromotionId)).toEqual([
      'alpha',
      'alpha',
      'beta',
    ]);
  });

  it('throws PROMOTION_CAPACITY_RESTORE_COUNTER_MISMATCH with the ledger context', async () => {
    const { repo, prisma } = makeHarness();
    prisma.promotionUsage.findMany.mockResolvedValue([ledgerRow('p', 7)]);
    prisma.$executeRaw.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await expect(repo.restoreForSale('sale-1')).rejects.toMatchObject({
      code: 'PROMOTION_CAPACITY_RESTORE_COUNTER_MISMATCH',
      details: { saleId: 'sale-1', promotionId: 'p', units: 7 },
    });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('stops at the first mismatch and leaves rollback of earlier writes to the ambient transaction', async () => {
    const { repo, prisma } = makeHarness();
    prisma.promotionUsage.findMany.mockResolvedValue([
      ledgerRow('alpha', 1),
      ledgerRow('beta', 1),
    ]);
    prisma.$executeRaw
      .mockResolvedValueOnce(1) // alpha stamp
      .mockResolvedValueOnce(1) // alpha decrement
      .mockResolvedValueOnce(1) // beta stamp
      .mockResolvedValueOnce(0); // beta decrement mismatch

    await expect(repo.restoreForSale('sale-1')).rejects.toMatchObject({
      code: 'PROMOTION_CAPACITY_RESTORE_COUNTER_MISMATCH',
      details: { saleId: 'sale-1', promotionId: 'beta', units: 1 },
    });
    // No compensating writes: the caller's transaction owns rollback.
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(4);
    expect(prisma.$executeRaw.mock.calls.map(writtenPromotionId)).toEqual([
      'alpha',
      'alpha',
      'beta',
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

  it('imports OutboxModule so the near-capacity writer resolves at runtime', () => {
    const imports: unknown = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      PromotionsModule,
    );

    expect(imports).toContain(OutboxModule);
  });
});
