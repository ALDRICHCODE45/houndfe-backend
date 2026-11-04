/**
 * Product-side stock writers through the inventory journal — real PostgreSQL
 * integration spec (O1 / T3, S2 + S8). Nothing is mocked below the HTTP layer:
 * `ProductsService` runs on the real repository, `StockJournalWriter` and
 * tenant-scoped Prisma. Fixtures live under two pinned tenants and are removed
 * by tenant afterwards.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ConfigService } from '@nestjs/config';
import type { ClsService } from 'nestjs-cls';
import { StockJournalWriter } from '../inventory/infrastructure/stock-journal.writer';
import { PrismaService } from '../shared/prisma/prisma.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import {
  disconnectIntegrationPrisma,
  integrationPrisma,
} from '../../test/integration/reset-db';
import { PrismaProductRepository } from './infrastructure/prisma-product.repository';
import { ProductStockJournal } from './infrastructure/product-stock-journal';
import { ProductsService } from './products.service';

const SKIP =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP ? describe.skip : describe;

const TENANT = '00000000-0000-0000-0000-0000000000e3';
const OTHER_TENANT = '00000000-0000-0000-0000-0000000000e4';
const USER = '00000000-0000-0000-0000-0000000000a3';
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describeIfDb('Product stock writers through the journal (PostgreSQL)', () => {
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
  const writer = new StockJournalWriter(tenantPrisma, {
    get: (_key: string, fallback: string) => fallback,
  } as unknown as ConfigService);
  const unused = (label: string) =>
    new Proxy(
      {},
      {
        get() {
          throw new Error(`Unexpected collaborator: ${label}`);
        },
      },
    );
  const service = new ProductsService(
    new PrismaProductRepository(
      tenantPrisma,
      unused('OutboxWriterService') as never,
      unused('IStockAlertStateRepository') as never,
    ),
    prismaService,
    unused('FilesService') as never,
    tenantPrisma,
    unused('SatCatalogService') as never,
    new ProductStockJournal(writer, tenantPrisma, prismaService, cls, {
      get: (_key: string, fallback: string) => fallback,
    } as unknown as ConfigService),
  );
  const as = <T>(tenantId: string, work: () => Promise<T>) =>
    als.run(
      new Map<string, unknown>([
        ['tenantId', tenantId],
        ['userId', USER],
        ['isSuperAdmin', false],
      ]),
      work,
    );
  const asTenant = <T>(work: () => Promise<T>) => as(TENANT, work);

  const movements = (productId: string) =>
    db().stockMovement.findMany({
      where: { tenantId: TENANT, productId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  const stored = (productId: string) =>
    db().product.findUniqueOrThrow({ where: { id: productId } });
  const seedProduct = (data: Record<string, unknown> = {}) =>
    db().product.create({
      data: { name: 'Seed', tenantId: TENANT, ...data } as never,
    });
  const seedLot = (productId: string, lotNumber: string, quantity: number) =>
    db().lot.create({
      data: {
        productId,
        tenantId: TENANT,
        lotNumber,
        quantity,
        expirationDate: day('2027-01-01'),
      },
    });
  const seedVariant = (productId: string, name: string, quantity: number) =>
    db().variant.create({
      data: { productId, tenantId: TENANT, name, quantity },
    });

  const cleanup = async () => {
    await db().stockMovement.deleteMany({
      where: { tenantId: { in: [TENANT, OTHER_TENANT] } },
    });
    await db().product.deleteMany({
      where: { tenantId: { in: [TENANT, OTHER_TENANT] } },
    });
  };

  beforeAll(async () => {
    for (const [id, slug] of [
      [TENANT, 'products-stock-journal-it'],
      [OTHER_TENANT, 'products-stock-journal-it-other'],
    ]) {
      await db().tenant.upsert({
        where: { id },
        update: {},
        create: { id, name: slug, slug },
      });
    }
    await db().user.upsert({
      where: { id: USER },
      update: { name: 'Ana Pérez' },
      create: {
        id: USER,
        email: 'products-stock-journal-it@example.test',
        hashedPassword: 'x',
        name: 'Ana Pérez',
      },
    });
  });
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await db().tenant.deleteMany({
      where: { id: { in: [TENANT, OTHER_TENANT] } },
    });
    await db().user.deleteMany({ where: { id: USER } });
    await disconnectIntegrationPrisma();
  });

  describe('S2 — no direct quantity edits', () => {
    it.each([5, 0, null])(
      'rejects PATCH product with quantity %p and changes nothing',
      async (quantity) => {
        const product = await seedProduct({ quantity: 7 });
        await expect(
          asTenant(() =>
            service.update(product.id, { name: 'Renamed', quantity } as never),
          ),
        ).rejects.toMatchObject({ code: 'STOCK_QUANTITY_READ_ONLY' });
        const after = await stored(product.id);
        expect([after.name, after.quantity, after.stockVersion]).toEqual([
          'Seed',
          7,
          0,
        ]);
        expect(await movements(product.id)).toHaveLength(0);
      },
    );

    it('rejects PATCH variant with quantity and changes nothing', async () => {
      const product = await seedProduct({ hasVariants: true });
      const variant = await seedVariant(product.id, 'M', 4);
      await expect(
        asTenant(() =>
          service.updateVariant(product.id, variant.id, {
            name: 'L',
            quantity: 9,
          } as never),
        ),
      ).rejects.toMatchObject({ code: 'STOCK_QUANTITY_READ_ONLY' });
      const after = await db().variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      expect([after.name, after.quantity]).toEqual(['M', 4]);
    });

    it('rejects PATCH lot with quantity and changes nothing', async () => {
      const product = await seedProduct({
        useLotsAndExpirations: true,
        quantity: 6,
      });
      const lot = await seedLot(product.id, 'L1', 6);
      await expect(
        asTenant(() =>
          service.updateLot(product.id, lot.id, { quantity: 1 } as never),
        ),
      ).rejects.toMatchObject({ code: 'STOCK_QUANTITY_READ_ONLY' });
      expect(
        (await db().lot.findUniqueOrThrow({ where: { id: lot.id } })).quantity,
      ).toBe(6);
    });

    it('a non-stock edit never rewrites or zeroes the stored quantity', async () => {
      // Lots product: untracked 5 + lots 4 + 6 => Product.quantity 15.
      const product = await seedProduct({
        useLotsAndExpirations: true,
        quantity: 15,
      });
      await seedLot(product.id, 'L1', 4);
      await seedLot(product.id, 'L2', 6);
      await asTenant(() => service.update(product.id, { name: 'Renamed' }));
      const after = await stored(product.id);
      expect([after.name, after.quantity, after.stockVersion]).toEqual([
        'Renamed',
        15,
        0,
      ]);
      expect(await movements(product.id)).toHaveLength(0);
    });
  });

  describe('create / add variant / add lot — INITIAL movements', () => {
    it('records the initial product quantity as an INITIAL movement', async () => {
      const created = await asTenant(() =>
        service.create({ name: 'Con stock', quantity: 12 }),
      );
      const rows = await movements(created.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(
        expect.objectContaining({
          type: 'INITIAL',
          bucketKind: 'PRODUCT_UNTRACKED',
          delta: 12,
          balanceAfter: 12,
          productBalanceAfter: 12,
          groupType: 'PRODUCT',
          groupId: created.id,
          actorId: USER,
          actorDisplayName: 'Ana Pérez',
        }),
      );
      expect((await stored(created.id)).quantity).toBe(12);
    });

    it('writes no movement for a product created without stock', async () => {
      const created = await asTenant(() => service.create({ name: 'Vacío' }));
      expect(await movements(created.id)).toHaveLength(0);
    });

    it('journals inline variants and inline lots, keeping quantity >= sum(lots)', async () => {
      const withVariants = await asTenant(() =>
        service.create({
          name: 'Camisa',
          hasVariants: true,
          variants: [
            { name: 'S', quantity: 3 },
            { name: 'M' },
            { name: 'L', quantity: 5 },
          ],
        }),
      );
      const variantRows = await movements(withVariants.id);
      expect(
        variantRows.map((r) => [r.type, r.bucketKind, r.variantLabel, r.delta]),
      ).toEqual([
        ['INITIAL', 'VARIANT', 'S', 3],
        ['INITIAL', 'VARIANT', 'L', 5],
      ]);
      expect((await stored(withVariants.id)).quantity).toBe(0);

      const withLots = await asTenant(() =>
        service.create({
          name: 'Leche',
          useLotsAndExpirations: true,
          lots: [
            { lotNumber: 'A', quantity: 4, expirationDate: '2027-01-01' },
            { lotNumber: 'B', quantity: 6, expirationDate: '2027-02-01' },
          ],
        }),
      );
      const lotRows = await movements(withLots.id);
      expect(lotRows.map((r) => [r.bucketKind, r.lotNumber, r.delta])).toEqual([
        ['LOT', 'A', 4],
        ['LOT', 'B', 6],
      ]);
      expect(lotRows[1].productBalanceAfter).toBe(10);
      expect((await stored(withLots.id)).quantity).toBe(10);
    });

    it('rolls back product and movements when a later create step fails', async () => {
      await expect(
        asTenant(() =>
          service.create({
            name: 'Se cae',
            quantity: 3,
            priceLists: [
              {
                priceListId: '00000000-0000-4000-8000-000000000999',
                priceCents: 100,
              },
            ],
          }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(await db().product.count({ where: { tenantId: TENANT } })).toBe(0);
      expect(
        await db().stockMovement.count({ where: { tenantId: TENANT } }),
      ).toBe(0);
    });

    it('addLot with quantity journals INITIAL and raises Product.quantity', async () => {
      const product = await seedProduct({
        useLotsAndExpirations: true,
        quantity: 3, // untracked portion
      });
      const lot = await asTenant(() =>
        service.addLot(product.id, {
          lotNumber: 'N1',
          quantity: 5,
          expirationDate: '2027-03-01',
        }),
      );
      expect(lot.quantity).toBe(5);
      expect((await stored(product.id)).quantity).toBe(8);
      const rows = await movements(product.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(
        expect.objectContaining({
          type: 'INITIAL',
          bucketKind: 'LOT',
          lotId: lot.id,
          delta: 5,
          balanceAfter: 5,
          productBalanceAfter: 8,
        }),
      );
    });

    it('addLot without quantity creates an empty lot and no movement', async () => {
      const product = await seedProduct({ useLotsAndExpirations: true });
      const lot = await asTenant(() =>
        service.addLot(product.id, {
          lotNumber: 'N0',
          expirationDate: '2027-03-01',
        }),
      );
      expect(lot.quantity).toBe(0);
      expect(await movements(product.id)).toHaveLength(0);
    });

    it('addVariant journals the first-variant zeroing, then the variant INITIAL', async () => {
      const product = await seedProduct({
        useLotsAndExpirations: true,
        quantity: 14, // untracked 9 + lot 5
      });
      await seedLot(product.id, 'L1', 5);
      const variant = await asTenant(() =>
        service.addVariant(product.id, { name: 'Roja', quantity: 4 }),
      );
      expect(variant.quantity).toBe(4);
      const after = await stored(product.id);
      expect([after.hasVariants, after.quantity]).toEqual([true, 0]);
      const rows = await movements(product.id);
      expect(
        rows.map((r) => [r.type, r.removalCause, r.bucketKind, r.delta]),
      ).toEqual([
        ['REMOVAL', 'FIRST_VARIANT_ZEROING', 'LOT', -5],
        ['REMOVAL', 'FIRST_VARIANT_ZEROING', 'PRODUCT_UNTRACKED', -9],
        ['INITIAL', null, 'VARIANT', 4],
      ]);
    });

    it('PATCH hasVariants=true on a product with stock journals the zeroing', async () => {
      const product = await seedProduct({ quantity: 6 });
      await asTenant(() => service.update(product.id, { hasVariants: true }));
      const after = await stored(product.id);
      expect([after.hasVariants, after.quantity]).toEqual([true, 0]);
      const rows = await movements(product.id);
      expect(rows.map((r) => [r.type, r.removalCause, r.delta])).toEqual([
        ['REMOVAL', 'FIRST_VARIANT_ZEROING', -6],
      ]);
    });
  });

  describe('S8 — removals keep the history', () => {
    it('removeVariant journals a VARIANT_DELETED REMOVAL before the row goes', async () => {
      const product = await seedProduct({ hasVariants: true });
      const variant = await seedVariant(product.id, 'M', 7);
      await asTenant(() => service.removeVariant(product.id, variant.id));
      expect(await db().variant.count({ where: { id: variant.id } })).toBe(0);
      const rows = await movements(product.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(
        expect.objectContaining({
          type: 'REMOVAL',
          removalCause: 'VARIANT_DELETED',
          variantId: variant.id,
          variantLabel: 'M',
          delta: -7,
          balanceAfter: 0,
          productBalanceAfter: 0,
        }),
      );
    });

    it('removeVariant of an empty variant writes no movement', async () => {
      const product = await seedProduct({ hasVariants: true });
      const variant = await seedVariant(product.id, 'M', 0);
      await asTenant(() => service.removeVariant(product.id, variant.id));
      expect(await movements(product.id)).toHaveLength(0);
    });

    it('removing a product journals lots, untracked and variants as PRODUCT_DELETED', async () => {
      const product = await seedProduct({
        useLotsAndExpirations: true,
        quantity: 9, // untracked 4 + lots 2 + 3
      });
      await seedLot(product.id, 'L1', 2);
      await seedLot(product.id, 'L2', 3);
      await asTenant(() => service.remove(product.id));
      expect(await db().product.count({ where: { id: product.id } })).toBe(0);
      const rows = await movements(product.id);
      // Lot rows follow the (random) lot id order, so compare by bucket.
      const key = (r: (typeof rows)[number]) => `${r.bucketKind}${r.lotNumber}`;
      expect(
        [...rows]
          .sort((a, b) => key(a).localeCompare(key(b)))
          .map((r) => [r.bucketKind, r.lotNumber, r.delta, r.removalCause]),
      ).toEqual([
        ['LOT', 'L1', -2, 'PRODUCT_DELETED'],
        ['LOT', 'L2', -3, 'PRODUCT_DELETED'],
        ['PRODUCT_UNTRACKED', null, -4, 'PRODUCT_DELETED'],
      ]);
      expect(rows.every((r) => r.productName === 'Seed')).toBe(true);
    });

    it('removing a variant product journals every variant', async () => {
      const product = await seedProduct({ hasVariants: true });
      await seedVariant(product.id, 'S', 2);
      await seedVariant(product.id, 'M', 5);
      await asTenant(() => service.remove(product.id));
      const rows = await movements(product.id);
      expect(rows.map((r) => [r.variantLabel, r.delta]).sort()).toEqual([
        ['M', -5],
        ['S', -2],
      ]);
    });

    it('removing a product without stock writes no movement', async () => {
      const product = await seedProduct();
      await asTenant(() => service.remove(product.id));
      expect(await movements(product.id)).toHaveLength(0);
    });

    it('removeLot with stock is LOT_HAS_STOCK and keeps lot and product intact', async () => {
      const product = await seedProduct({
        useLotsAndExpirations: true,
        quantity: 5,
      });
      const lot = await seedLot(product.id, 'L1', 5);
      await expect(
        asTenant(() => service.removeLot(product.id, lot.id)),
      ).rejects.toMatchObject({ code: 'LOT_HAS_STOCK' });
      expect(await db().lot.count({ where: { id: lot.id } })).toBe(1);
      expect((await stored(product.id)).quantity).toBe(5);
    });

    it('removeLot of an empty lot deletes it', async () => {
      const product = await seedProduct({ useLotsAndExpirations: true });
      const lot = await seedLot(product.id, 'L1', 0);
      await asTenant(() => service.removeLot(product.id, lot.id));
      expect(await db().lot.count({ where: { id: lot.id } })).toBe(0);
    });

    it('lot update and delete are tenant-scoped', async () => {
      const foreignProduct = await db().product.create({
        data: {
          name: 'Ajeno',
          tenantId: OTHER_TENANT,
          useLotsAndExpirations: true,
        },
      });
      const foreignLot = await db().lot.create({
        data: {
          productId: foreignProduct.id,
          tenantId: OTHER_TENANT,
          lotNumber: 'F1',
          expirationDate: day('2027-01-01'),
        },
      });
      await expect(
        asTenant(() =>
          service.updateLot(foreignProduct.id, foreignLot.id, {
            expirationDate: '2030-01-01',
          }),
        ),
      ).rejects.toMatchObject({ code: 'ENTITY_NOT_FOUND' });
      await expect(
        asTenant(() => service.removeLot(foreignProduct.id, foreignLot.id)),
      ).rejects.toMatchObject({ code: 'ENTITY_NOT_FOUND' });
      const after = await db().lot.findUniqueOrThrow({
        where: { id: foreignLot.id },
      });
      expect(after.expirationDate).toEqual(day('2027-01-01'));
    });

    it('updateLot still edits dates of its own lot', async () => {
      const product = await seedProduct({
        useLotsAndExpirations: true,
        quantity: 2,
      });
      const lot = await seedLot(product.id, 'L1', 2);
      const updated = await asTenant(() =>
        service.updateLot(product.id, lot.id, { expirationDate: '2028-05-05' }),
      );
      expect(updated.expirationDate).toEqual(day('2028-05-05'));
      expect(updated.quantity).toBe(2);
    });
  });

  describe('S6 — sellable stock for sale drafts', () => {
    it('excludes stock held in expired lots from checkStockAvailability', async () => {
      // Untracked 3 + expired lot 4 + valid lot 6 => quantity 13, sellable 9.
      const product = await seedProduct({
        useLotsAndExpirations: true,
        quantity: 13,
      });
      await db().lot.create({
        data: {
          productId: product.id,
          tenantId: TENANT,
          lotNumber: 'OLD',
          quantity: 4,
          expirationDate: day('2020-01-01'),
        },
      });
      await db().lot.create({
        data: {
          productId: product.id,
          tenantId: TENANT,
          lotNumber: 'NEW',
          quantity: 6,
          expirationDate: day('2099-01-01'),
        },
      });
      const check = (requested: number) =>
        asTenant(() =>
          service.checkStockAvailability(product.id, null, requested),
        );
      await expect(check(9)).resolves.toEqual({
        available: true,
        currentStock: 9,
      });
      await expect(check(10)).resolves.toEqual({
        available: false,
        currentStock: 9,
      });
    });

    it('keeps the plain quantity for products without expired lots', async () => {
      const product = await seedProduct({ quantity: 5 });
      await expect(
        asTenant(() => service.checkStockAvailability(product.id, null, 5)),
      ).resolves.toEqual({ available: true, currentStock: 5 });
    });
  });
});
