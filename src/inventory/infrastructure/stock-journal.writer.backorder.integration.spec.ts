/**
 * StockJournalWriter — backorder reservation primitives against REAL PostgreSQL
 * (restock-backorder T2a, contract v1 §3/§4). Nothing mocked: locks, FEFO,
 * expired lots, the held-bucket fold, the lot swap and the increase-listener
 * seam (savepoint isolation included). Fixtures live under a pinned tenant and
 * are removed by tenant afterwards.
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
import { InsufficientStockError } from '../domain/stock-journal.errors';
import type {
  AppliedStockMovement,
  StockIncreaseListener,
  StockIncreaseTarget,
} from '../domain/stock-journal.types';
import { StockJournalWriter } from './stock-journal.writer';

const SKIP =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP ? describe.skip : describe;

const TENANT = '00000000-0000-0000-0000-0000000000e2';
const ACTOR = { id: null, displayName: 'Sistema' };
const NOW = new Date('2026-11-04T18:00:00.000Z'); // 2026-11-04 in Mexico City
const LATER = new Date('2026-11-15T18:00:00.000Z'); // lot A (2026-11-10) expired
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describeIfDb('StockJournalWriter backorder primitives (PostgreSQL)', () => {
  const db = () => integrationPrisma();
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
  const newWriter = () =>
    new StockJournalWriter(tenantPrisma, {
      get: (_key: string, fallback: string) => fallback,
    } as unknown as ConfigService);
  let writer = newWriter();
  const tx = <T>(work: () => Promise<T>) =>
    als.run(
      new Map<string, unknown>([
        ['tenantId', TENANT],
        ['isSuperAdmin', false],
      ]),
      () => tenantPrisma.runInTransaction(work),
    );

  const cleanup = async () => {
    await db().stockMovement.deleteMany({ where: { tenantId: TENANT } });
    await db().product.deleteMany({ where: { tenantId: TENANT } });
  };

  /** untracked 5 + lot A 8 (exp 2026-11-10) + lot B 7 (exp 2026-12-10) + lot X 50 (expired 2026-11-01). */
  const seedLotsProduct = async (bQuantity = 7) => {
    const product = await db().product.create({
      data: {
        name: 'Lotes',
        tenantId: TENANT,
        quantity: 5 + 8 + bQuantity + 50,
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
      mk('B', bQuantity, '2026-12-10'),
      mk('X', 50, '2026-11-01'),
    ]);
    return { product, a, b, x };
  };

  const qty = async (productId: string) => ({
    product: (
      await db().product.findUniqueOrThrow({ where: { id: productId } })
    ).quantity,
    lots: Object.fromEntries(
      (await db().lot.findMany({ where: { productId } })).map((l) => [
        l.lotNumber,
        l.quantity,
      ]),
    ),
  });

  const reserve = (
    backorderId: string,
    productId: string,
    quantity: number,
    variantId: string | null = null,
    at = NOW,
  ) =>
    tx(() =>
      writer.reserveBackorder(
        { backorderId, productId, variantId, quantity, actor: ACTOR },
        at,
      ),
    );

  beforeAll(async () => {
    await db().tenant.upsert({
      where: { id: TENANT },
      update: {},
      create: {
        id: TENANT,
        name: 'Backorder journal IT',
        slug: 'backorder-journal-it',
      },
    });
  });
  beforeEach(async () => {
    writer = newWriter();
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await db().tenant.deleteMany({ where: { id: TENANT } });
    await disconnectIntegrationPrisma();
  });

  describe('reserve', () => {
    it('takes a variant line out of the variant and journals BACKORDER_RESERVE grouped by backorder', async () => {
      const product = await db().product.create({
        data: { name: 'Variantes', tenantId: TENANT, hasVariants: true },
      });
      const variant = await db().variant.create({
        data: {
          productId: product.id,
          tenantId: TENANT,
          name: 'Grande',
          quantity: 10,
        },
      });
      const rows = await reserve('bo-1', product.id, 4, variant.id);
      expect(
        rows.map((r) => [
          r.type,
          r.groupType,
          r.groupId,
          r.delta,
          r.balanceAfter,
        ]),
      ).toEqual([['BACKORDER_RESERVE', 'BACKORDER', 'bo-1', -4, 6]]);
      expect(
        (await db().variant.findUniqueOrThrow({ where: { id: variant.id } }))
          .quantity,
      ).toBe(6);
      const stored = await db().stockMovement.findMany({
        where: { tenantId: TENANT, groupType: 'BACKORDER', groupId: 'bo-1' },
      });
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        type: 'BACKORDER_RESERVE',
        variantId: variant.id,
        bucketKind: 'VARIANT',
        actorDisplayName: 'Sistema',
      });
    });

    it('takes a lot-tracked product FEFO over NON-expired lots then untracked, never the expired lot', async () => {
      const { product, a, b, x } = await seedLotsProduct();
      const rows = await reserve('bo-2', product.id, 18);
      expect(rows.map((r) => [r.lotId, r.delta])).toEqual([
        [a.id, -8],
        [b.id, -7],
        [null, -3],
      ]);
      expect(await qty(product.id)).toEqual({
        product: 70 - 18,
        lots: { A: 0, B: 0, X: x.quantity },
      });
    });

    it('rejects more than the sellable units (expired lot stock does not count) and writes nothing', async () => {
      const { product } = await seedLotsProduct();
      await expect(reserve('bo-3', product.id, 21)).rejects.toBeInstanceOf(
        InsufficientStockError,
      );
      expect((await qty(product.id)).product).toBe(70);
      expect(
        await db().stockMovement.count({ where: { tenantId: TENANT } }),
      ).toBe(0);
    });

    it('lockSellable reports exactly what a reservation may take (null when stock is not tracked)', async () => {
      const { product } = await seedLotsProduct();
      expect(await tx(() => writer.lockSellable(product.id, null, NOW))).toBe(
        20,
      );
      const service = await db().product.create({
        data: { name: 'Servicio', tenantId: TENANT, useStock: false },
      });
      expect(
        await tx(() => writer.lockSellable(service.id, null, NOW)),
      ).toBeNull();
    });
  });

  describe('release', () => {
    it('returns the units to the SAME buckets, net zero, and is idempotent', async () => {
      const { product, a, b } = await seedLotsProduct();
      await reserve('bo-4', product.id, 18);
      const rows = await tx(() =>
        writer.releaseBackorder({ backorderId: 'bo-4', actor: ACTOR }, NOW),
      );
      expect(rows.map((r) => [r.type, r.groupType, r.lotId, r.delta])).toEqual([
        ['BACKORDER_RELEASE', 'BACKORDER', a.id, 8],
        ['BACKORDER_RELEASE', 'BACKORDER', b.id, 7],
        ['BACKORDER_RELEASE', 'BACKORDER', null, 3],
      ]);
      expect(await qty(product.id)).toEqual({
        product: 70,
        lots: { A: 8, B: 7, X: 50 },
      });
      expect(
        await tx(() =>
          writer.releaseBackorder({ backorderId: 'bo-4', actor: ACTOR }, NOW),
        ),
      ).toEqual([]);
      expect((await qty(product.id)).product).toBe(70);
    });

    it('releases a variant reservation back to the variant', async () => {
      const product = await db().product.create({
        data: { name: 'Variantes', tenantId: TENANT, hasVariants: true },
      });
      const variant = await db().variant.create({
        data: {
          productId: product.id,
          tenantId: TENANT,
          name: 'Grande',
          quantity: 10,
        },
      });
      await reserve('bo-5', product.id, 10, variant.id);
      await tx(() =>
        writer.releaseBackorder({ backorderId: 'bo-5', actor: ACTOR }, NOW),
      );
      expect(
        (await db().variant.findUniqueOrThrow({ where: { id: variant.id } }))
          .quantity,
      ).toBe(10);
    });

    it('a lot deleted since the reservation returns its units to the untracked portion', async () => {
      const { product, a, b } = await seedLotsProduct();
      await reserve('bo-6', product.id, 18);
      await db().lot.delete({ where: { id: b.id } });
      await tx(() =>
        writer.releaseBackorder({ backorderId: 'bo-6', actor: ACTOR }, NOW),
      );
      const lotA = await db().lot.findUniqueOrThrow({ where: { id: a.id } });
      expect(lotA.quantity).toBe(8);
      // 52 + 18 returned; lot B's 7 went to untracked together with its own 3.
      expect((await qty(product.id)).product).toBe(70);
    });

    it('release of an unknown backorder writes nothing', async () => {
      await expect(
        tx(() =>
          writer.releaseBackorder({ backorderId: 'ghost', actor: ACTOR }, NOW),
        ),
      ).resolves.toEqual([]);
    });
  });

  describe('revalidate (owner Q6: «Cambiar a un lote vigente o volver a esperar»)', () => {
    const revalidate = (backorderId: string, at: Date) =>
      tx(() => writer.revalidateBackorder({ backorderId, actor: ACTOR }, at));

    it('NOT_HELD for a backorder with no reservation', async () => {
      expect(await revalidate('ghost', NOW)).toEqual({
        status: 'NOT_HELD',
        movements: [],
      });
    });

    it('VALID and nothing written while no held lot is expired', async () => {
      const { product } = await seedLotsProduct();
      await reserve('bo-7', product.id, 8);
      const before = await db().stockMovement.count({
        where: { tenantId: TENANT },
      });
      expect(await revalidate('bo-7', NOW)).toEqual({
        status: 'VALID',
        movements: [],
      });
      expect(
        await db().stockMovement.count({ where: { tenantId: TENANT } }),
      ).toBe(before);
    });

    it('SWAPPED: the expired lot gets its units back and the same quantity is re-reserved from a valid lot', async () => {
      const { product } = await seedLotsProduct(10); // B has 10
      await reserve('bo-8', product.id, 8); // FEFO: all 8 from lot A
      const outcome = await revalidate('bo-8', LATER); // A expired on 11-10
      if (outcome.status !== 'SWAPPED') throw new Error(outcome.status);
      expect(
        outcome.movements.map((m) => [m.type, m.lotNumber, m.delta]),
      ).toEqual([
        ['BACKORDER_RELEASE', 'A', 8],
        ['BACKORDER_RESERVE', 'B', -8],
      ]);
      // A holds its (now expired, unsellable) units again; B gave 8; untracked untouched.
      expect(await qty(product.id)).toEqual({
        product: 5 + 8 + 10 + 50 - 8,
        lots: { A: 8, B: 2, X: 50 },
      });
      // The swap is stable: nothing is held in an expired lot any more.
      expect((await revalidate('bo-8', LATER)).status).toBe('VALID');
      // and a later release returns the units to lot B, not to the expired lot.
      await tx(() =>
        writer.releaseBackorder({ backorderId: 'bo-8', actor: ACTOR }, LATER),
      );
      expect((await qty(product.id)).lots).toEqual({ A: 8, B: 10, X: 50 });
    });

    it('LOST: valid stock cannot cover it, so EVERYTHING is released (valid lots too)', async () => {
      const { product } = await seedLotsProduct(); // B has 7
      await reserve('bo-9', product.id, 11); // FEFO: A 8 + B 3
      // Counter sales take the remaining valid units (B 4 + untracked 5).
      await tx(() =>
        writer.charge(
          [{ productId: product.id, quantity: 9 }],
          { saleId: 'counter', actor: ACTOR },
          NOW,
        ),
      );
      const outcome = await revalidate('bo-9', LATER);
      if (outcome.status !== 'LOST') throw new Error(outcome.status);
      expect(
        outcome.movements.every((m) => m.type === 'BACKORDER_RELEASE'),
      ).toBe(true);
      expect(
        outcome.movements.map((m) => [m.lotNumber, m.delta]).sort(),
      ).toEqual([
        ['A', 8],
        ['B', 3],
      ]);
      // Nothing is held any more.
      expect(
        await tx(() =>
          writer.releaseBackorder({ backorderId: 'bo-9', actor: ACTOR }, LATER),
        ),
      ).toEqual([]);
      expect((await qty(product.id)).lots).toEqual({ A: 8, B: 3, X: 50 });
    });
  });

  describe('stock increase listeners (the allocator seam)', () => {
    const recorder = () => {
      const calls: StockIncreaseTarget[][] = [];
      const listener: StockIncreaseListener = {
        onStockIncreased: (targets) => {
          calls.push(targets);
          return Promise.resolve([]);
        },
      };
      return { calls, listener };
    };

    it('without listeners apply returns exactly what it wrote', async () => {
      const product = await db().product.create({
        data: { name: 'Sin oyentes', tenantId: TENANT, quantity: 1 },
      });
      const rows = await tx(() =>
        writer.apply(
          [
            {
              bucket: { kind: 'PRODUCT_UNTRACKED', productId: product.id },
              delta: 3,
            },
          ],
          {
            type: 'ADJUSTMENT',
            groupType: 'ADJUSTMENT',
            groupId: 'g-1',
            actor: ACTOR,
          },
          NOW,
        ),
      );
      expect(rows).toHaveLength(1);
    });

    it('fires after a positive apply with the touched product/variant, and appends the listener movements', async () => {
      const product = await db().product.create({
        data: { name: 'Con oyente', tenantId: TENANT, quantity: 1 },
      });
      const extra = { id: 'extra' } as AppliedStockMovement;
      const calls: StockIncreaseTarget[][] = [];
      writer.registerStockIncreaseListener({
        onStockIncreased: (targets) => {
          calls.push(targets);
          return Promise.resolve([extra]);
        },
      });
      const rows = await tx(() =>
        writer.apply(
          [
            {
              bucket: { kind: 'PRODUCT_UNTRACKED', productId: product.id },
              delta: 3,
            },
          ],
          {
            type: 'ADJUSTMENT',
            groupType: 'ADJUSTMENT',
            groupId: 'g-2',
            actor: ACTOR,
          },
          NOW,
        ),
      );
      expect(calls).toEqual([[{ productId: product.id, variantId: null }]]);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toBe(extra);
    });

    it('does not fire for decreases, charges or a reservation', async () => {
      const { product } = await seedLotsProduct();
      const { calls, listener } = recorder();
      writer.registerStockIncreaseListener(listener);
      await tx(() =>
        writer.apply(
          [
            {
              bucket: { kind: 'PRODUCT_UNTRACKED', productId: product.id },
              delta: -2,
            },
          ],
          {
            type: 'ADJUSTMENT',
            groupType: 'ADJUSTMENT',
            groupId: 'g-3',
            actor: ACTOR,
          },
          NOW,
        ),
      );
      await tx(() =>
        writer.charge(
          [{ productId: product.id, quantity: 1 }],
          { saleId: 's-3', actor: ACTOR },
          NOW,
        ),
      );
      await reserve('bo-10', product.id, 2);
      expect(calls).toEqual([]);
    });

    it('fires after a sale reversal and after a release (unless allocate is false)', async () => {
      const { product } = await seedLotsProduct();
      const { calls, listener } = recorder();
      writer.registerStockIncreaseListener(listener);
      await tx(() =>
        writer.charge(
          [{ productId: product.id, quantity: 3 }],
          { saleId: 's-4', actor: ACTOR },
          NOW,
        ),
      );
      await tx(() => writer.reverseSale({ saleId: 's-4', actor: ACTOR }, NOW));
      expect(calls).toHaveLength(1);
      await reserve('bo-11', product.id, 2);
      await tx(() =>
        writer.releaseBackorder(
          { backorderId: 'bo-11', actor: ACTOR, allocate: false },
          NOW,
        ),
      );
      expect(calls).toHaveLength(1);
      await reserve('bo-12', product.id, 2);
      await tx(() =>
        writer.releaseBackorder({ backorderId: 'bo-12', actor: ACTOR }, NOW),
      );
      expect(calls).toHaveLength(2);
    });

    it('a failing listener is rolled back to its savepoint: the increase still commits, no partial writes', async () => {
      const { product } = await seedLotsProduct();
      writer.registerStockIncreaseListener({
        onStockIncreased: async () => {
          // Writes a reservation, then blows up.
          await writer.reserveBackorder(
            {
              backorderId: 'bo-doomed',
              productId: product.id,
              variantId: null,
              quantity: 2,
              actor: ACTOR,
            },
            NOW,
          );
          throw new Error('allocator exploded');
        },
      });
      const rows = await tx(() =>
        writer.apply(
          [
            {
              bucket: { kind: 'PRODUCT_UNTRACKED', productId: product.id },
              delta: 4,
            },
          ],
          {
            type: 'ADJUSTMENT',
            groupType: 'ADJUSTMENT',
            groupId: 'g-4',
            actor: ACTOR,
          },
          NOW,
        ),
      );
      expect(rows).toHaveLength(1);
      expect((await qty(product.id)).product).toBe(74);
      expect(
        await db().stockMovement.count({
          where: { tenantId: TENANT, groupId: 'bo-doomed' },
        }),
      ).toBe(0);
    });
  });
});
