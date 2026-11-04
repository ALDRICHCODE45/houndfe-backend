/**
 * SaleStockService — real PostgreSQL integration spec (O1 / T4, S6 S7).
 * The journal writer, alert-state repository and outbox writer are the real
 * adapters; fixtures live under a pinned tenant and are removed by tenant.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { ClsService } from 'nestjs-cls';
import { StockJournalWriter } from '../inventory/infrastructure/stock-journal.writer';
import { PrismaService } from '../shared/prisma/prisma.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { OutboxWriterService } from '../shared/outbox/outbox-writer.service';
import { BusinessRuleViolationError } from '../shared/domain/domain-error';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import { PrismaStockAlertStateRepository } from '../stock-alerts/infrastructure/prisma-stock-alert-state.repository';
import {
  disconnectIntegrationPrisma,
  integrationPrisma,
} from '../../test/integration/reset-db';
import { SaleStockService } from './sale-stock.service';

const SKIP =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP ? describe.skip : describe;

const TENANT = '00000000-0000-0000-0000-0000000000f4';
const NOW = new Date('2026-11-04T18:00:00.000Z'); // 2026-11-04 in Mexico City
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describeIfDb('SaleStockService (PostgreSQL integration)', () => {
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
  const journal = new StockJournalWriter(tenantPrisma, {
    get: (_key: string, fallback: string) => fallback,
  } as unknown as ConfigService);
  const service = new SaleStockService(
    journal,
    tenantPrisma,
    new OutboxWriterService(),
    new PrismaStockAlertStateRepository(),
  );
  const tx = <T>(work: () => Promise<T>) =>
    als.run(
      new Map<string, unknown>([
        ['tenantId', TENANT],
        ['isSuperAdmin', false],
      ]),
      () => tenantPrisma.runInTransaction(work),
    );

  let userId: string;

  const cleanup = async () => {
    await db().outboxEvent.deleteMany({ where: { tenantId: TENANT } });
    await db().stockAlertState.deleteMany({ where: { tenantId: TENANT } });
    await db().stockMovement.deleteMany({ where: { tenantId: TENANT } });
    await db().product.deleteMany({ where: { tenantId: TENANT } });
  };

  const seedProduct = (quantity: number, minQuantity = 0) =>
    db().product.create({
      data: { name: 'Plain', tenantId: TENANT, quantity, minQuantity },
    });

  // Lot A (8, soon) + lot B (7, later) + expired lot X (50) + 5 untracked.
  const seedLotsProduct = async () => {
    const product = await db().product.create({
      data: {
        name: 'Lotes',
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

  const stockAlerts = () =>
    db().outboxEvent.findMany({
      where: { tenantId: TENANT, eventType: 'stock.low.detected' },
    });

  beforeAll(async () => {
    await db().tenant.upsert({
      where: { id: TENANT },
      update: {},
      create: { id: TENANT, name: 'Sale stock IT', slug: 'sale-stock-it' },
    });
    userId = randomUUID();
    await db().user.create({
      data: {
        id: userId,
        name: 'Cajera Uno',
        email: `${userId}@example.invalid`,
        hashedPassword: 'unused',
      },
    });
  });
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await db().tenant.deleteMany({ where: { id: TENANT } });
    await db().user.deleteMany({ where: { id: userId } });
    await disconnectIntegrationPrisma();
  });

  describe('charge (S6)', () => {
    it('consumes lots FEFO and journals the POS user display name as actor', async () => {
      const { product, a, b, x } = await seedLotsProduct();
      await tx(() =>
        service.charge({
          saleId: 'sale-1',
          items: [{ productId: product.id, quantity: 18 }],
          actor: { kind: 'user', userId },
          now: NOW,
        }),
      );

      const rows = await db().stockMovement.findMany({
        where: { tenantId: TENANT, groupId: 'sale-1' },
        orderBy: { createdAt: 'asc' },
      });
      expect(
        rows.map((r) => [r.type, r.lotId, r.delta, r.actorDisplayName]),
      ).toEqual([
        ['SALE', a.id, -8, 'Cajera Uno'],
        ['SALE', b.id, -7, 'Cajera Uno'],
        ['SALE', null, -3, 'Cajera Uno'],
      ]);
      expect(rows[0].actorId).toBe(userId);
      const lotX = await db().lot.findUniqueOrThrow({ where: { id: x.id } });
      expect(lotX.quantity).toBe(50);
    });

    it('stamps bot sales with the stable actor name "Bot"', async () => {
      const product = await seedProduct(5);
      await tx(() =>
        service.charge({
          saleId: 'sale-bot',
          items: [{ productId: product.id, quantity: 2 }],
          actor: { kind: 'bot', userId },
          now: NOW,
        }),
      );
      const row = await db().stockMovement.findFirstOrThrow({
        where: { tenantId: TENANT, groupId: 'sale-bot' },
      });
      expect([row.actorDisplayName, row.actorId]).toEqual(['Bot', userId]);
    });

    it('rejects selling into expired lot stock with STOCK_INSUFFICIENT_AT_CONFIRM and writes nothing', async () => {
      // 20 sellable (8 + 7 + 5 untracked) while the expired lot holds 50.
      const { product } = await seedLotsProduct();
      const error = await tx(() =>
        service.charge({
          saleId: 'sale-expired',
          items: [{ productId: product.id, quantity: 21 }],
          actor: { kind: 'user', userId },
          now: NOW,
        }),
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BusinessRuleViolationError);
      expect((error as BusinessRuleViolationError).code).toBe(
        'STOCK_INSUFFICIENT_AT_CONFIRM',
      );
      const stored = await db().product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(stored.quantity).toBe(70);
      expect(
        await db().stockMovement.count({ where: { tenantId: TENANT } }),
      ).toBe(0);
    });

    it('maps a missing product to the same insufficient-stock code', async () => {
      const error = await tx(() =>
        service.charge({
          saleId: 'sale-ghost',
          items: [{ productId: randomUUID(), quantity: 1 }],
          actor: { kind: 'user', userId },
          now: NOW,
        }),
      ).catch((e: unknown) => e);
      expect((error as BusinessRuleViolationError).code).toBe(
        'STOCK_INSUFFICIENT_AT_CONFIRM',
      );
    });

    it('emits exactly one low-stock outbox row when the charge crosses minQuantity', async () => {
      const product = await seedProduct(5, 3);
      await tx(() =>
        service.charge({
          saleId: 'sale-cross',
          items: [{ productId: product.id, quantity: 3 }], // 5 -> 2 <= 3
          actor: { kind: 'user', userId },
          now: NOW,
        }),
      );

      const events = await stockAlerts();
      expect(events).toHaveLength(1);
      expect(events[0].aggregateId).toBe(`${product.id}:__PRODUCT__`);
      expect(events[0].payload).toMatchObject({
        productId: product.id,
        variantId: null,
        newQuantity: 2,
        minQuantity: 3,
        alertEpoch: 1,
      });
      const state = await db().stockAlertState.findFirstOrThrow({
        where: { tenantId: TENANT, productId: product.id },
      });
      expect(state.alerted).toBe(true);

      // Already below the line: a further sale must not alert again.
      await tx(() =>
        service.charge({
          saleId: 'sale-cross-2',
          items: [{ productId: product.id, quantity: 1 }],
          actor: { kind: 'user', userId },
          now: NOW,
        }),
      );
      expect(await stockAlerts()).toHaveLength(1);
    });

    it('emits no outbox row when the charge stays above minQuantity', async () => {
      const product = await seedProduct(10, 3);
      await tx(() =>
        service.charge({
          saleId: 'sale-calm',
          items: [{ productId: product.id, quantity: 2 }], // 10 -> 8
          actor: { kind: 'user', userId },
          now: NOW,
        }),
      );
      expect(await stockAlerts()).toHaveLength(0);
    });

    it('never alerts for lot-tracked products (same gate as the products repository)', async () => {
      const { product } = await seedLotsProduct();
      await db().product.update({
        where: { id: product.id },
        data: { minQuantity: 69 },
      });
      await tx(() =>
        service.charge({
          saleId: 'sale-lots-alert',
          items: [{ productId: product.id, quantity: 5 }],
          actor: { kind: 'user', userId },
          now: NOW,
        }),
      );
      expect(await stockAlerts()).toHaveLength(0);
    });

    it('alerts per variant using the variant minQuantity', async () => {
      const product = await db().product.create({
        data: { name: 'Var', tenantId: TENANT, hasVariants: true, quantity: 0 },
      });
      const variant = await db().variant.create({
        data: {
          productId: product.id,
          tenantId: TENANT,
          name: 'M',
          quantity: 4,
          minQuantity: 2,
        },
      });
      await tx(() =>
        service.charge({
          saleId: 'sale-var',
          items: [
            { productId: product.id, variantId: variant.id, quantity: 3 },
          ],
          actor: { kind: 'user', userId },
          now: NOW,
        }),
      );
      const events = await stockAlerts();
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({
        productId: product.id,
        variantId: variant.id,
        newQuantity: 1,
        minQuantity: 2,
      });
    });
  });

  describe('reverse (S7)', () => {
    it('restores the consumed lots, re-arms the alert, and is idempotent', async () => {
      const product = await seedProduct(5, 3);
      await tx(() =>
        service.charge({
          saleId: 'sale-r',
          items: [{ productId: product.id, quantity: 3 }],
          actor: { kind: 'user', userId },
          now: NOW,
        }),
      );
      expect(
        (
          await db().stockAlertState.findFirstOrThrow({
            where: { tenantId: TENANT, productId: product.id },
          })
        ).alerted,
      ).toBe(true);

      const first = await tx(() =>
        service.reverse({
          saleId: 'sale-r',
          actor: { kind: 'user', userId },
          now: NOW,
        }),
      );
      expect(first.status).toBe('REVERSED');
      expect(
        (await db().product.findUniqueOrThrow({ where: { id: product.id } }))
          .quantity,
      ).toBe(5);
      expect(
        (
          await db().stockAlertState.findFirstOrThrow({
            where: { tenantId: TENANT, productId: product.id },
          })
        ).alerted,
      ).toBe(false);

      const second = await tx(() =>
        service.reverse({
          saleId: 'sale-r',
          actor: { kind: 'user', userId },
          now: NOW,
        }),
      );
      expect(second.status).toBe('ALREADY_REVERSED');
      expect(
        (await db().product.findUniqueOrThrow({ where: { id: product.id } }))
          .quantity,
      ).toBe(5);
      expect(
        await db().stockMovement.count({
          where: { tenantId: TENANT, type: 'SALE_CANCELLATION' },
        }),
      ).toBe(1);
    });

    it('restores the same FEFO lots a lots sale consumed', async () => {
      const { product, a, b } = await seedLotsProduct();
      await tx(() =>
        service.charge({
          saleId: 'sale-rl',
          items: [{ productId: product.id, quantity: 18 }],
          actor: { kind: 'user', userId },
          now: NOW,
        }),
      );
      await tx(() =>
        service.reverse({
          saleId: 'sale-rl',
          actor: { kind: 'bot', userId },
          now: NOW,
        }),
      );
      const [lotA, lotB, stored] = await Promise.all([
        db().lot.findUniqueOrThrow({ where: { id: a.id } }),
        db().lot.findUniqueOrThrow({ where: { id: b.id } }),
        db().product.findUniqueOrThrow({ where: { id: product.id } }),
      ]);
      expect([lotA.quantity, lotB.quantity, stored.quantity]).toEqual([
        8, 7, 70,
      ]);
      const cancellations = await db().stockMovement.findMany({
        where: { tenantId: TENANT, type: 'SALE_CANCELLATION' },
      });
      expect(cancellations.map((m) => m.actorDisplayName)).toEqual([
        'Bot',
        'Bot',
        'Bot',
      ]);
    });

    it('reports LEGACY (nothing written) for a sale charged before the journal', async () => {
      const product = await seedProduct(5);
      const outcome = await tx(() =>
        service.reverse({
          saleId: 'sale-legacy',
          actor: { kind: 'user', userId },
          now: NOW,
        }),
      );
      expect(outcome.status).toBe('LEGACY');
      expect(
        (await db().product.findUniqueOrThrow({ where: { id: product.id } }))
          .quantity,
      ).toBe(5);
      expect(
        await db().stockMovement.count({ where: { tenantId: TENANT } }),
      ).toBe(0);
    });
  });
});
