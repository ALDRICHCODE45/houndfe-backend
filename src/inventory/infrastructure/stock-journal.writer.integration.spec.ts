/**
 * StockJournalWriter — real PostgreSQL integration spec (O1 / T2).
 * Nothing is mocked: locks, CAS, FEFO, rollback and reversal run against the
 * integration database. Fixtures live under a pinned tenant and are removed by
 * tenant afterwards (no truncation, so parallel specs are unaffected).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ConfigService } from '@nestjs/config';
import type { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import {
  disconnectIntegrationPrisma,
  integrationPrisma,
} from '../../../test/integration/reset-db';
import {
  InsufficientStockError,
  StockVersionConflictError,
} from '../domain/stock-journal.errors';
import { StockJournalWriter } from './stock-journal.writer';

const SKIP =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP ? describe.skip : describe;

const TENANT = '00000000-0000-0000-0000-0000000000e1';
const ACTOR = { id: null, displayName: 'Sistema' };
const NOW = new Date('2026-11-04T18:00:00.000Z'); // 2026-11-04 in Mexico City
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describeIfDb('StockJournalWriter (PostgreSQL integration)', () => {
  const db = () => integrationPrisma();
  // One CLS store per simulated request, so concurrent transactions do not
  // join each other's ambient transaction.
  const als = new AsyncLocalStorage<Map<string, unknown>>();
  const cls = {
    get: (k: string) => als.getStore()?.get(k),
    set: (k: string, v: unknown) => void als.getStore()?.set(k, v),
  } as unknown as ClsService<TenantClsStore>;
  const prismaService = Object.assign(
    Object.create(PrismaService.prototype) as PrismaService,
    integrationPrisma(),
  );
  const tenantPrisma = new TenantPrismaService(prismaService, cls);
  const writer = new StockJournalWriter(tenantPrisma, {
    get: (_key: string, fallback: string) => fallback,
  } as unknown as ConfigService);
  const tx = <T>(work: () => Promise<T>) =>
    als.run(
      new Map<string, unknown>([
        ['tenantId', TENANT],
        ['isSuperAdmin', false],
      ]),
      () => tenantPrisma.runInTransaction(work),
    );

  const deadlocks = (results: PromiseSettledResult<unknown>[]) =>
    results.filter(
      (r) =>
        r.status === 'rejected' &&
        /deadlock|40P01/i.test(
          String((r.reason as Error)?.message ?? r.reason),
        ),
    );

  const cleanup = async () => {
    await db().stockMovement.deleteMany({ where: { tenantId: TENANT } });
    await db().product.deleteMany({ where: { tenantId: TENANT } });
  };

  // Product with untracked 5, lot A (8, exp soon), lot B (7, later), lot X (expired, 50).
  const seedLotsProduct = async (name = 'Lotes') => {
    const product = await db().product.create({
      data: {
        name,
        tenantId: TENANT,
        quantity: 70,
        useLotsAndExpirations: true,
      },
    });
    const mk = (lotNumber: string, quantity: number, exp: string) =>
      db().lot.create({
        data: {
          productId: product.id,
          tenantId: TENANT,
          lotNumber,
          quantity,
          expirationDate: day(exp),
        },
      });
    const [a, b, x] = await Promise.all([
      mk('A', 8, '2026-11-10'),
      mk('B', 7, '2026-12-10'),
      mk('X', 50, '2026-11-01'),
    ]);
    return { product, a, b, x };
  };

  beforeAll(async () => {
    await db().tenant.upsert({
      where: { id: TENANT },
      update: {},
      create: {
        id: TENANT,
        name: 'Inventory journal IT',
        slug: 'inventory-journal-it',
      },
    });
  });
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await db().tenant.deleteMany({ where: { id: TENANT } });
    await disconnectIntegrationPrisma();
  });

  it('refuses to run outside an ambient transaction', async () => {
    await expect(
      writer.charge([], { saleId: 's', actor: ACTOR }),
    ).rejects.toThrow('runInTransaction');
  });

  it('charges FEFO across lots and untracked, journaling one SALE row per bucket', async () => {
    const { product, a, b, x } = await seedLotsProduct();
    const rows = await tx(() =>
      writer.charge(
        [{ productId: product.id, quantity: 18 }],
        { saleId: 'sale-1', actor: ACTOR },
        NOW,
      ),
    );
    expect(
      rows.map((r) => [
        r.lotId,
        r.delta,
        r.balanceAfter,
        r.productBalanceAfter,
      ]),
    ).toEqual([
      [a.id, -8, 0, 62],
      [b.id, -7, 0, 55],
      [null, -3, 2, 52],
    ]);
    const [p, lotA, lotB, lotX] = await Promise.all([
      db().product.findUniqueOrThrow({ where: { id: product.id } }),
      db().lot.findUniqueOrThrow({ where: { id: a.id } }),
      db().lot.findUniqueOrThrow({ where: { id: b.id } }),
      db().lot.findUniqueOrThrow({ where: { id: x.id } }),
    ]);
    expect([p.quantity, lotA.quantity, lotB.quantity, lotX.quantity]).toEqual([
      52, 0, 0, 50,
    ]);
    expect([
      p.stockVersion,
      lotA.stockVersion,
      lotB.stockVersion,
      lotX.stockVersion,
    ]).toEqual([1, 1, 1, 0]);
    const stored = await db().stockMovement.findMany({
      where: { tenantId: TENANT, groupType: 'SALE', groupId: 'sale-1' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    expect(stored.map((m) => m.delta)).toEqual([-3, -7, -8]);
    expect(stored[2]).toEqual(
      expect.objectContaining({
        lotNumber: 'A',
        productName: 'Lotes',
        type: 'SALE',
        actorDisplayName: 'Sistema',
      }),
    );
  });

  it('rolls everything back when a later bucket is insufficient (S4)', async () => {
    const { product } = await seedLotsProduct();
    await expect(
      tx(() =>
        writer.charge(
          [{ productId: product.id, quantity: 21 }],
          { saleId: 'sale-2', actor: ACTOR },
          NOW,
        ),
      ),
    ).rejects.toBeInstanceOf(InsufficientStockError);
    expect(
      (await db().product.findUniqueOrThrow({ where: { id: product.id } }))
        .quantity,
    ).toBe(70);
    expect(
      await db().stockMovement.count({ where: { tenantId: TENANT } }),
    ).toBe(0);
  });

  it('serialises concurrent charges so exactly one of two oversells fails', async () => {
    const product = await db().product.create({
      data: { name: 'Race', tenantId: TENANT, quantity: 10 },
    });
    const attempt = (saleId: string) =>
      tx(() =>
        writer.charge(
          [{ productId: product.id, quantity: 8 }],
          { saleId, actor: ACTOR },
          NOW,
        ),
      );
    const results = await Promise.allSettled([attempt('r1'), attempt('r2')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(InsufficientStockError);
    expect(
      (await db().product.findUniqueOrThrow({ where: { id: product.id } }))
        .quantity,
    ).toBe(2);
  });

  it('reverses a sale into the same lots, sending a deleted lot to untracked (S7)', async () => {
    const { product, a, b } = await seedLotsProduct();
    await tx(() =>
      writer.charge(
        [{ productId: product.id, quantity: 18 }],
        { saleId: 'sale-3', actor: ACTOR },
        NOW,
      ),
    );
    await db().lot.update({ where: { id: b.id }, data: { quantity: 0 } });
    await db().lot.delete({ where: { id: b.id } });
    const outcome = await tx(() =>
      writer.reverseSale({ saleId: 'sale-3', actor: ACTOR }, NOW),
    );
    if (outcome.status !== 'REVERSED') throw new Error(outcome.status);
    expect(outcome.movements.map((m) => [m.type, m.lotId, m.delta])).toEqual([
      ['SALE_CANCELLATION', a.id, 8],
      ['SALE_CANCELLATION', null, 7],
      ['SALE_CANCELLATION', null, 3],
    ]);
    const lotA = await db().lot.findUniqueOrThrow({ where: { id: a.id } });
    const p = await db().product.findUniqueOrThrow({
      where: { id: product.id },
    });
    // 70 total - 18 sold = 52; restore 8 to lot A and 10 (7 from the deleted lot + 3) to untracked.
    expect([lotA.quantity, p.quantity]).toEqual([8, 70]);
    expect(
      await tx(() =>
        writer.reverseSale({ saleId: 'sale-3', actor: ACTOR }, NOW),
      ),
    ).toEqual({
      status: 'ALREADY_REVERSED',
      movements: [],
    });
    expect(
      await tx(() =>
        writer.reverseSale({ saleId: 'never-journaled', actor: ACTOR }, NOW),
      ),
    ).toEqual({
      status: 'NOTHING_TO_RESTORE',
      movements: [],
    });
  });

  it('applies adjustments with bucket CAS and variant product balances', async () => {
    const product = await db().product.create({
      data: { name: 'Camisa', tenantId: TENANT, hasVariants: true },
    });
    const [v1, v2] = await Promise.all([
      db().variant.create({
        data: {
          productId: product.id,
          tenantId: TENANT,
          name: 'S',
          quantity: 3,
        },
      }),
      db().variant.create({
        data: {
          productId: product.id,
          tenantId: TENANT,
          name: 'M',
          quantity: 4,
        },
      }),
    ]);
    const rows = await tx(() =>
      writer.apply(
        [
          {
            bucket: {
              kind: 'VARIANT',
              productId: product.id,
              variantId: v2.id,
            },
            delta: -1,
            expectedVersion: 0,
          },
        ],
        {
          type: 'ADJUSTMENT',
          reason: 'DAMAGE',
          groupType: 'ADJUSTMENT',
          groupId: 'adj-1',
          actor: { id: 'u1', displayName: 'Ana' },
        },
        NOW,
      ),
    );
    expect(rows[0]).toEqual(
      expect.objectContaining({
        balanceAfter: 3,
        productBalanceAfter: 6,
        bucketVersionAfter: 1,
      }),
    );
    await expect(
      tx(() =>
        writer.apply(
          [
            {
              bucket: {
                kind: 'VARIANT',
                productId: product.id,
                variantId: v2.id,
              },
              delta: 1,
              expectedVersion: 0,
            },
          ],
          {
            type: 'ADJUSTMENT',
            reason: 'PHYSICAL_COUNT',
            groupType: 'ADJUSTMENT',
            groupId: 'adj-2',
            actor: ACTOR,
          },
          NOW,
        ),
      ),
    ).rejects.toBeInstanceOf(StockVersionConflictError);
    expect(
      (await db().variant.findUniqueOrThrow({ where: { id: v1.id } }))
        .stockVersion,
    ).toBe(0);
    const stored = await db().stockMovement.findFirstOrThrow({
      where: { tenantId: TENANT },
    });
    expect(stored).toEqual(
      expect.objectContaining({
        reason: 'DAMAGE',
        actorId: 'u1',
        actorDisplayName: 'Ana',
        variantLabel: 'M',
      }),
    );
  });
  // Replace the live lock-order scenarios of the retired repository charge:
  // the journal locks product rows in id order, then lots/variants.
  describe('lock ordering under concurrency', () => {
    const ROUNDS = 8;

    it('commits opposite-order multi-product charges without a deadlock', async () => {
      const [p1, p2] = await Promise.all(
        ['Uno', 'Dos'].map((name) =>
          db().product.create({
            data: { name, tenantId: TENANT, quantity: 10 * ROUNDS },
          }),
        ),
      );
      const charge = (saleId: string, ids: string[]) =>
        tx(() =>
          writer.charge(
            ids.map((productId) => ({ productId, quantity: 1 })),
            { saleId, actor: ACTOR },
            NOW,
          ),
        );
      const results: PromiseSettledResult<unknown>[] = [];
      for (let round = 0; round < ROUNDS; round += 1) {
        results.push(
          ...(await Promise.allSettled([
            charge(`fwd-${round}`, [p1.id, p2.id]),
            charge(`rev-${round}`, [p2.id, p1.id]),
          ])),
        );
      }
      expect(deadlocks(results)).toEqual([]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      const rows = await db().product.findMany({
        where: { id: { in: [p1.id, p2.id] } },
        orderBy: { id: 'asc' },
      });
      expect(rows.map((r) => r.quantity)).toEqual([
        10 * ROUNDS - 2 * ROUNDS,
        10 * ROUNDS - 2 * ROUNDS,
      ]);
    });

    it('lets two sibling-variant charges of one product both commit', async () => {
      const product = await db().product.create({
        data: { name: 'Hermanas', tenantId: TENANT, hasVariants: true },
      });
      const [m, l] = await Promise.all(
        ['M', 'L'].map((name) =>
          db().variant.create({
            data: {
              productId: product.id,
              tenantId: TENANT,
              name,
              quantity: 10,
            },
          }),
        ),
      );
      const results = await Promise.allSettled(
        [m, l].map((variant, index) =>
          tx(() =>
            writer.charge(
              [
                {
                  productId: product.id,
                  variantId: variant.id,
                  quantity: 1,
                },
              ],
              { saleId: `sib-${index}`, actor: ACTOR },
              NOW,
            ),
          ),
        ),
      );
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      const rows = await db().variant.findMany({
        where: { productId: product.id },
      });
      expect(rows.map((r) => r.quantity)).toEqual([9, 9]);
    });

    it('serialises a mixed variant+parent charge with a legacy mixed restore without a deadlock', async () => {
      const product = await db().product.create({
        data: { name: 'Mixto', tenantId: TENANT, quantity: 10 },
      });
      const variant = await db().variant.create({
        data: {
          productId: product.id,
          tenantId: TENANT,
          name: 'V',
          quantity: 10,
        },
      });
      const results: PromiseSettledResult<unknown>[] = [];
      for (let round = 0; round < ROUNDS; round += 1) {
        results.push(
          ...(await Promise.allSettled([
            tx(() =>
              writer.reverseSale(
                {
                  saleId: `legacy-${round}`,
                  actor: ACTOR,
                  confirmedAt: new Date('2020-01-01T00:00:00.000Z'),
                  lines: [
                    {
                      productId: product.id,
                      variantId: variant.id,
                      quantity: 2,
                    },
                    { productId: product.id, quantity: 2 },
                  ],
                },
                NOW,
              ),
            ),
            tx(() =>
              writer.charge(
                [
                  { productId: product.id, quantity: 1 },
                  { productId: product.id, variantId: variant.id, quantity: 1 },
                ],
                { saleId: `mix-${round}`, actor: ACTOR },
                NOW,
              ),
            ),
          ])),
        );
      }
      expect(deadlocks(results)).toEqual([]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      const [p, v] = await Promise.all([
        db().product.findUniqueOrThrow({ where: { id: product.id } }),
        db().variant.findUniqueOrThrow({ where: { id: variant.id } }),
      ]);
      expect([p.quantity, v.quantity]).toEqual([10 + ROUNDS, 10 + ROUNDS]);
    });
  });
});
