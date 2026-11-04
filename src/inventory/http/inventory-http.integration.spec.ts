/**
 * Inventory HTTP commands/queries — real PostgreSQL integration spec
 * (O1 / T5). Locks, CAS, receipts, authority and tenancy run unmocked against
 * the integration database; fixtures live under random tenants removed
 * afterwards.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { normalizeTestDatabaseUrl } from '../../../test/integration/setup/test-database-url';
import { StockJournalWriter } from '../infrastructure/stock-journal.writer';
import { InventoryCommands } from './inventory-commands';
import { InventoryContractError } from './inventory-contract';
import { InventoryCursor } from './inventory-cursor';
import { InventoryQueries } from './inventory-queries';
import { InventoryStockReader } from './inventory-stock-reader';

const describeDb =
  process.env.SKIP_DB_INTEGRATION === '1' ? describe.skip : describe;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describeDb('inventory HTTP commands and queries (PostgreSQL)', () => {
  let db: PrismaClient;
  const tenants: string[] = [];
  const users: string[] = [];
  beforeAll(() => {
    normalizeTestDatabaseUrl(process.env.DATABASE_URL, '[inventory-http]');
    db = new PrismaClient();
  });
  afterAll(async () => {
    await db.product.deleteMany({ where: { tenantId: { in: tenants } } });
    await db.tenant.deleteMany({ where: { id: { in: tenants } } });
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  });

  async function seedTenant(
    grants: [string, string][] = [
      ['InventoryJournal', 'read'],
      ['InventoryAdjustment', 'create'],
    ],
  ) {
    const tenantId = randomUUID();
    const actorId = randomUUID();
    const roleId = randomUUID();
    tenants.push(tenantId);
    users.push(actorId);
    await db.$transaction(async (tx) => {
      await tx.tenant.create({
        data: { id: tenantId, name: 'Inventory IT', slug: tenantId },
      });
      await tx.user.create({
        data: {
          id: actorId,
          email: `${actorId}@inventory.invalid`,
          name: 'Ana Pérez',
          hashedPassword: 'not-a-login-hash',
        },
      });
      await tx.role.create({
        data: { id: roleId, tenantId, name: `Inventory ${roleId}` },
      });
      for (const [subject, action] of grants) {
        const permission = await tx.permission.upsert({
          where: { subject_action: { subject, action } },
          create: { subject, action },
          update: {},
        });
        await tx.rolePermission.create({
          data: { roleId, permissionId: permission.id },
        });
      }
      await tx.tenantMembership.create({
        data: { tenantId, userId: actorId, roleId },
      });
    });
    return { tenantId, actorId, roleId };
  }

  function harness(tenantId: string, actorId: string) {
    const cls = new ClsService<TenantClsStore>(new AsyncLocalStorage());
    // SAFETY: services use the Prisma API only, not Nest lifecycle hooks.
    const tenantDb = new TenantPrismaService(db as PrismaService, cls);
    const config = {
      get: (_key: string, fallback: string) => fallback,
    } as unknown as ConfigService;
    const writer = new StockJournalWriter(tenantDb, config);
    const reader = new InventoryStockReader(tenantDb, config);
    const commands = new InventoryCommands(tenantDb, cls, writer, reader);
    const queries = new InventoryQueries(
      tenantDb,
      cls,
      new InventoryCursor('integration-secret'),
      reader,
    );
    const run = <T>(work: () => T): T =>
      cls.runWith({ tenantId, userId: actorId, isSuperAdmin: false }, work);
    return { commands, queries, run };
  }

  async function fixture(grants?: [string, string][]) {
    const base = await seedTenant(grants);
    const h = harness(base.tenantId, base.actorId);
    const product = await db.product.create({
      data: {
        tenantId: base.tenantId,
        name: 'Leche',
        quantity: 20,
        useLotsAndExpirations: true,
      },
    });
    const lot = await db.lot.create({
      data: {
        productId: product.id,
        tenantId: base.tenantId,
        lotNumber: 'L1',
        quantity: 8,
        expirationDate: day('2099-01-01'),
      },
    });
    return { ...base, ...h, product, lot };
  }

  const code = async (work: Promise<unknown>) => {
    const error: unknown = await work.then(
      () => null,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(InventoryContractError);
    return (error as InventoryContractError).code;
  };
  const body = (
    target: object,
    expectedVersion: number,
    delta: number,
    extra: object = {},
  ) => ({ target, expectedVersion, delta, reason: 'DAMAGE', ...extra });
  const counts = async (tenantId: string) => ({
    movements: await db.stockMovement.count({ where: { tenantId } }),
    receipts: await db.inventoryAdjustmentReceipt.count({
      where: { tenantId },
    }),
  });

  it('adjusts the untracked portion: 201 body, journal row, CAS bump, users.name snapshot', async () => {
    const f = await fixture();
    const result = await f.run(() =>
      f.commands.adjust(
        'key-1',
        body({ productId: f.product.id }, 0, -4, {
          reason: 'OTHER',
          note: ' conteo ',
        }),
      ),
    );
    expect(result.statusCode).toBe(201);
    expect(result.body.movement).toMatchObject({
      type: 'ADJUSTMENT',
      bucket: 'PRODUCT_UNTRACKED',
      productId: f.product.id,
      variantId: null,
      lotId: null,
      labels: { product: 'Leche', variant: null, lot: null },
      delta: -4,
      balanceAfter: 8,
      productBalanceAfter: 16,
      reason: 'OTHER',
      note: 'conteo',
      removalCause: null,
      actor: { displayName: 'Ana Pérez' },
    });
    expect(result.body.movement.group.type).toBe('ADJUSTMENT');
    expect(result.body.stock.product).toMatchObject({
      quantity: 16,
      untracked: { quantity: 8, version: 1 },
      sellable: 16,
    });
    const stored = await db.product.findUniqueOrThrow({
      where: { id: f.product.id },
    });
    expect([stored.quantity, stored.stockVersion]).toEqual([16, 1]);
    expect(await counts(f.tenantId)).toEqual({ movements: 1, receipts: 1 });
  });

  it('replays the same key and body with the stored response and writes once', async () => {
    const f = await fixture();
    const request = body({ productId: f.product.id }, 0, -4);
    const first = await f.run(() => f.commands.adjust('key-r', request));
    const second = await f.run(() => f.commands.adjust('key-r', request));
    expect(second).toEqual(first);
    expect(await counts(f.tenantId)).toEqual({ movements: 1, receipts: 1 });
    expect(
      (await db.product.findUniqueOrThrow({ where: { id: f.product.id } }))
        .quantity,
    ).toBe(16);
    expect(
      await code(
        f.run(() =>
          f.commands.adjust('key-r', body({ productId: f.product.id }, 0, -5)),
        ),
      ),
    ).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect((await counts(f.tenantId)).movements).toBe(1);
  });

  it('rejects a stale expectedVersion with STOCK_VERSION_CONFLICT and changes nothing', async () => {
    const f = await fixture();
    await f.run(() =>
      f.commands.adjust('k1', body({ productId: f.product.id }, 0, 1)),
    );
    const before = await counts(f.tenantId);
    expect(
      await code(
        f.run(() =>
          f.commands.adjust('k2', body({ productId: f.product.id }, 0, 1)),
        ),
      ),
    ).toBe('STOCK_VERSION_CONFLICT');
    expect(await counts(f.tenantId)).toEqual(before);
    expect(
      (await db.product.findUniqueOrThrow({ where: { id: f.product.id } }))
        .quantity,
    ).toBe(21);
  });

  it('rejects results below zero in the untracked, lot and variant buckets (S4)', async () => {
    const f = await fixture();
    const variantProduct = await db.product.create({
      data: { tenantId: f.tenantId, name: 'Camisa', hasVariants: true },
    });
    const variant = await db.variant.create({
      data: {
        tenantId: f.tenantId,
        productId: variantProduct.id,
        name: 'Roja',
        quantity: 2,
      },
    });
    const attempts = [
      body({ productId: f.product.id }, 0, -13), // untracked is 12
      body({ productId: f.product.id, lotId: f.lot.id }, 0, -9), // lot is 8
      body({ productId: variantProduct.id, variantId: variant.id }, 0, -3),
    ];
    for (const [index, attempt] of attempts.entries())
      expect(
        await code(f.run(() => f.commands.adjust(`neg-${index}`, attempt))),
      ).toBe('INSUFFICIENT_STOCK');
    expect(await counts(f.tenantId)).toEqual({ movements: 0, receipts: 0 });
    const [p, l, v] = await Promise.all([
      db.product.findUniqueOrThrow({ where: { id: f.product.id } }),
      db.lot.findUniqueOrThrow({ where: { id: f.lot.id } }),
      db.variant.findUniqueOrThrow({ where: { id: variant.id } }),
    ]);
    expect([p.quantity, p.stockVersion, l.quantity, l.stockVersion]).toEqual([
      20, 0, 8, 0,
    ]);
    expect([v.quantity, v.stockVersion]).toEqual([2, 0]);
  });

  it('adjusts a lot (product total moves, untracked version does not) and a variant', async () => {
    const f = await fixture();
    const lotResult = await f.run(() =>
      f.commands.adjust(
        'lot',
        body({ productId: f.product.id, lotId: f.lot.id }, 0, 5, {
          reason: 'PHYSICAL_COUNT',
        }),
      ),
    );
    expect(lotResult.body.movement).toMatchObject({
      bucket: 'LOT',
      lotId: f.lot.id,
      labels: { lot: 'L1' },
      delta: 5,
      balanceAfter: 13,
      productBalanceAfter: 25,
      reason: 'PHYSICAL_COUNT',
    });
    expect(lotResult.body.stock.product).toMatchObject({
      quantity: 25,
      untracked: { quantity: 12, version: 0 },
    });
    expect(lotResult.body.stock.lots[0]).toMatchObject({
      id: f.lot.id,
      quantity: 13,
      version: 1,
      expired: false,
      expirationDate: '2099-01-01',
    });

    const variantProduct = await db.product.create({
      data: { tenantId: f.tenantId, name: 'Camisa', hasVariants: true },
    });
    const variant = await db.variant.create({
      data: {
        tenantId: f.tenantId,
        productId: variantProduct.id,
        name: 'Roja',
        quantity: 2,
      },
    });
    const variantResult = await f.run(() =>
      f.commands.adjust(
        'variant',
        body({ productId: variantProduct.id, variantId: variant.id }, 0, 3),
      ),
    );
    expect(variantResult.body.movement).toMatchObject({
      bucket: 'VARIANT',
      variantId: variant.id,
      labels: { variant: 'Roja' },
      balanceAfter: 5,
      productBalanceAfter: 5,
    });
    expect(variantResult.body.stock.variants).toEqual([
      { id: variant.id, label: 'Roja', quantity: 5, version: 1 },
    ]);
  });

  it('answers STOCK_NOT_TRACKED for useStock=false and SERVICE products without writing', async () => {
    const f = await fixture();
    const untracked = await db.product.create({
      data: { tenantId: f.tenantId, name: 'Sin stock', useStock: false },
    });
    const service = await db.product.create({
      data: { tenantId: f.tenantId, name: 'Servicio', type: 'SERVICE' },
    });
    for (const [index, product] of [untracked, service].entries())
      expect(
        await code(
          f.run(() =>
            f.commands.adjust(
              `nt-${index}`,
              body({ productId: product.id }, 0, 1),
            ),
          ),
        ),
      ).toBe('STOCK_NOT_TRACKED');
    expect(await counts(f.tenantId)).toEqual({ movements: 0, receipts: 0 });
  });

  it('answers NOT_FOUND for unknown, cross-tenant and mismatched targets', async () => {
    const f = await fixture();
    const other = await fixture();
    const otherVariantProduct = await db.product.create({
      data: { tenantId: f.tenantId, name: 'V', hasVariants: true },
    });
    const cases = [
      { productId: randomUUID() },
      { productId: other.product.id },
      { productId: f.product.id, lotId: other.lot.id },
      { productId: f.product.id, lotId: randomUUID() },
      { productId: f.product.id, variantId: randomUUID() },
      { productId: otherVariantProduct.id }, // variant product has no untracked bucket
    ];
    for (const [index, target] of cases.entries())
      expect(
        await code(
          f.run(() => f.commands.adjust(`nf-${index}`, body(target, 0, 1))),
        ),
      ).toBe('NOT_FOUND');
    expect(await counts(f.tenantId)).toEqual({ movements: 0, receipts: 0 });
    expect(await counts(other.tenantId)).toEqual({ movements: 0, receipts: 0 });
    expect(
      (await db.product.findUniqueOrThrow({ where: { id: other.product.id } }))
        .quantity,
    ).toBe(20);
  });

  it('rechecks persisted authority: read-only actors cannot adjust, revoked actors are refused', async () => {
    const f = await fixture([['InventoryJournal', 'read']]);
    expect(
      await code(
        f.run(() =>
          f.commands.adjust('k', body({ productId: f.product.id }, 0, 1)),
        ),
      ),
    ).toBe('FORBIDDEN');
    expect(await counts(f.tenantId)).toEqual({ movements: 0, receipts: 0 });
    await expect(
      f.run(() => f.queries.getStock(f.product.id)),
    ).resolves.toBeDefined();

    const noGrants = await fixture([['Product', 'read']]);
    expect(
      await code(
        noGrants.run(() => noGrants.queries.getStock(noGrants.product.id)),
      ),
    ).toBe('FORBIDDEN');
    await db.user.update({
      where: { id: noGrants.actorId },
      data: { isActive: false },
    });
    expect(
      await code(
        noGrants.run(() => noGrants.queries.getStock(noGrants.product.id)),
      ),
    ).toBe('UNAUTHORIZED');
  });

  it('serialises concurrent adjustments on one version: exactly one wins, the other is a CAS conflict', async () => {
    const f = await fixture();
    const outcomes = await Promise.allSettled(
      ['a', 'b'].map((key) =>
        f.run(() =>
          f.commands.adjust(key, body({ productId: f.product.id }, 0, -1)),
        ),
      ),
    );
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const failure = outcomes.find((o) => o.status === 'rejected');
    expect((failure as PromiseRejectedResult).reason).toMatchObject({
      code: 'STOCK_VERSION_CONFLICT',
    });
    expect(await counts(f.tenantId)).toEqual({ movements: 1, receipts: 1 });
    expect(
      (await db.product.findUniqueOrThrow({ where: { id: f.product.id } }))
        .quantity,
    ).toBe(19);
  });

  it('treats a concurrent duplicate key as replay or in-flight, never a second write', async () => {
    const f = await fixture();
    const request = body({ productId: f.product.id }, 0, -1);
    const outcomes = await Promise.allSettled([
      f.run(() => f.commands.adjust('dup', request)),
      f.run(() => f.commands.adjust('dup', request)),
    ]);
    for (const outcome of outcomes)
      if (outcome.status === 'rejected')
        expect((outcome.reason as InventoryContractError).code).toBe(
          'IDEMPOTENCY_KEY_IN_FLIGHT',
        );
    expect(outcomes.some((o) => o.status === 'fulfilled')).toBe(true);
    expect(await counts(f.tenantId)).toEqual({ movements: 1, receipts: 1 });
  });

  it('refuses a quantity beyond the INT column as MALFORMED and changes nothing', async () => {
    const f = await fixture();
    await db.product.update({
      where: { id: f.product.id },
      data: { quantity: 2_147_483_000 },
    });
    expect(
      await code(
        f.run(() =>
          f.commands.adjust('big', body({ productId: f.product.id }, 0, 1_000)),
        ),
      ),
    ).toBe('MALFORMED');
    expect(await counts(f.tenantId)).toEqual({ movements: 0, receipts: 0 });
  });

  it('reads stock: tenant-scoped, 404 for foreign products', async () => {
    const f = await fixture();
    await db.lot.create({
      data: {
        productId: f.product.id,
        tenantId: f.tenantId,
        lotNumber: 'OLD',
        quantity: 5,
        expirationDate: day('2020-01-01'),
      },
    });
    await db.product.update({
      where: { id: f.product.id },
      data: { quantity: 25 },
    });
    const stock = await f.run(() => f.queries.getStock(f.product.id));
    expect(stock.product).toEqual({
      id: f.product.id,
      name: 'Leche',
      useStock: true,
      quantity: 25,
      untracked: { quantity: 12, version: 0 },
      sellable: 20,
    });
    expect(stock.lots.map((l) => [l.lotNumber, l.expired])).toEqual([
      ['OLD', true],
      ['L1', false],
    ]);
    const other = await fixture();
    expect(await code(f.run(() => f.queries.getStock(other.product.id)))).toBe(
      'NOT_FOUND',
    );
  });

  it('lists movements newest first with signed cursor pagination and bucket filters', async () => {
    const f = await fixture();
    for (const [index, delta] of [-1, -2, -3].entries())
      await f.run(() =>
        f.commands.adjust(
          `m-${index}`,
          body({ productId: f.product.id }, index, delta),
        ),
      );
    await f.run(() =>
      f.commands.adjust(
        'lot',
        body({ productId: f.product.id, lotId: f.lot.id }, 0, 2),
      ),
    );
    const first = await f.run(() =>
      f.queries.listMovements({ productId: f.product.id, limit: '3' }),
    );
    expect(first.items.map((m) => [m.bucket, m.delta])).toEqual([
      ['LOT', 2],
      ['PRODUCT_UNTRACKED', -3],
      ['PRODUCT_UNTRACKED', -2],
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await f.run(() =>
      f.queries.listMovements({
        productId: f.product.id,
        limit: '3',
        cursor: first.nextCursor,
      }),
    );
    expect(second.items.map((m) => m.delta)).toEqual([-1]);
    expect(second.nextCursor).toBeNull();

    const lotOnly = await f.run(() =>
      f.queries.listMovements({ productId: f.product.id, lotId: f.lot.id }),
    );
    expect(lotOnly.items.map((m) => m.bucket)).toEqual(['LOT']);

    // A cursor is bound to its filters.
    expect(
      await code(
        f.run(() =>
          f.queries.listMovements({
            productId: f.product.id,
            lotId: f.lot.id,
            cursor: first.nextCursor,
          }),
        ),
      ),
    ).toBe('MALFORMED');
    expect(
      await code(
        f.run(() =>
          f.queries.listMovements({
            productId: f.product.id,
            cursor: 'garbage',
          }),
        ),
      ),
    ).toBe('MALFORMED');
  });

  it('never exposes another tenant’s movements', async () => {
    const f = await fixture();
    const other = await fixture();
    await other.run(() =>
      other.commands.adjust('x', body({ productId: other.product.id }, 0, -1)),
    );
    const page = await f.run(() =>
      f.queries.listMovements({ productId: other.product.id }),
    );
    expect(page).toEqual({ items: [], nextCursor: null });
  });
});
