/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- supertest bodies and JSON payloads are untyped */
/**
 * restock-backorder / T2b — the `backorder.*` feed and the backorder sweep
 * against REAL PostgreSQL (contract v1 §4, §10; owner D3, Q6).
 *
 * Boots the REAL `BackordersModule` graph (journal writer, allocator, hook,
 * sweep) with only the bot credential repository replaced; the sweep is driven
 * through `tick(now)` with a fake clock (the production `@Interval` is gated
 * off under the integration setup). Cleanup deletes only what it created.
 *
 * Proves:
 *   - a reservation enqueues `backorder.reserved` (+ the staff notice) in the
 *     SAME transaction as the reservation, exactly once, and rolls back with it;
 *   - the reminder (3 h before) and the expiry (24 h) fire once, with a fake
 *     clock, also under two concurrent sweeps; expiry releases the stock,
 *     serves the next one and feeds `reservation_expired` + the staff notice;
 *   - the lot sweep: a swap is silent, a lost reservation feeds
 *     `reservation_lost` and the backorder keeps its place;
 *   - the safety-net allocation reserves what the stock listener missed;
 *   - sweep vs bot cancel vs arrivals: every unit released exactly once, no
 *     negative stock, no deadlock.
 */
import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { ClsModule, ClsService } from 'nestjs-cls';
import request from 'supertest';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../chatbot-api/domain/service-credential.repository';
import {
  BotCredentials,
  disconnectWorldPrisma,
  worldPrisma,
} from '../delivery-zones/test-support/delivery-zone-world';
import { StockJournalWriter } from '../inventory/infrastructure/stock-journal.writer';
import { DomainExceptionFilter } from '../shared/filters/domain-exception.filter';
import { PrismaExceptionFilter } from '../shared/filters/prisma-exception.filter';
import { createAppValidationPipe } from '../shared/listing/app-validation.pipe';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import { BackordersModule } from './backorders.module';
import { BACKORDER_SCOPES } from './domain/backorder-scopes';
import { BackorderSweepScheduler } from './infrastructure/backorder-sweep.scheduler';

const SKIP =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const d = SKIP ? describe.skip : describe;

const DAY = 86_400_000;
const HOUR = 3_600_000;
const RESOLVED_AT = new Date(Date.now() - DAY);
const SYSTEM = { id: null, displayName: 'Sistema' };
const ALL_SCOPES = [
  BACKORDER_SCOPES.create,
  BACKORDER_SCOPES.read,
  BACKORDER_SCOPES.cancel,
];

d('backorder feed and sweep (PostgreSQL)', () => {
  const prisma = worldPrisma();
  const credentials = new BotCredentials();
  const tenantIds: string[] = [];
  const createdPriceListIds: string[] = [];
  let app: INestApplication;
  let publicListId: string;
  let cls: ClsService<TenantClsStore>;
  let tenantPrisma: TenantPrismaService;
  let writer: StockJournalWriter;
  let sweep: BackorderSweepScheduler;

  beforeAll(async () => {
    const existingDefault = await prisma.globalPriceList.findFirst({
      where: { isDefault: true },
    });
    if (existingDefault) {
      publicListId = existingDefault.id;
    } else {
      const created = await prisma.globalPriceList.create({
        data: { name: `PUBLICO-sweep-${randomUUID()}`, isDefault: true },
      });
      createdPriceListIds.push(created.id);
      publicListId = created.id;
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              PROMOTIONS_BUSINESS_TIMEZONE: 'America/Mexico_City',
              JWT_SECRET: 'backorder-sweep-test-secret',
              JWT_REFRESH_SECRET: 'backorder-sweep-test-refresh',
              SPACES_BUCKET: 'unused',
              SPACES_ENDPOINT: 'https://unused.invalid',
              SPACES_REGION: 'unused',
              SPACES_ACCESS_KEY_ID: 'unused',
              SPACES_SECRET_ACCESS_KEY: 'unused',
              SPACES_PUBLIC_BASE_URL: 'https://unused.invalid',
              SPACES_UPLOAD_MAX_MB: '5',
            }),
          ],
        }),
        EventEmitterModule.forRoot(),
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        DatabaseModule,
        BackordersModule,
      ],
    })
      .overrideProvider(SERVICE_CREDENTIAL_REPOSITORY)
      .useValue(credentials.repository)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createAppValidationPipe());
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new PrismaExceptionFilter(),
    );
    await app.init();
    const get = <T>(token: new (...args: never[]) => T): T =>
      moduleRef.get(token, { strict: false });
    cls = moduleRef.get(ClsService, { strict: false });
    tenantPrisma = get(TenantPrismaService);
    writer = get(StockJournalWriter);
    sweep = get(BackorderSweepScheduler);
  });

  /**
   * The sweep is cross-tenant: with a fake clock in the future it would also
   * expire the reservations of every earlier test, so each test removes its own
   * tenants (cascade) and the counters below stay exact.
   */
  async function dropTenants(): Promise<void> {
    if (tenantIds.length === 0) return;
    const ids = tenantIds.splice(0);
    await prisma.outboxEvent.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.backorder.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
  }

  afterEach(dropTenants);

  afterAll(async () => {
    await app?.close();
    await dropTenants();
    if (createdPriceListIds.length > 0) {
      await prisma.globalPriceList.deleteMany({
        where: { id: { in: createdPriceListIds } },
      });
    }
    await disconnectWorldPrisma();
  });

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  interface World {
    tenantId: string;
    token: string;
    productId: string;
    decisionId: string;
    customers: string[];
  }

  const phoneOf = (n: number) => ({
    phoneCountryCode: '52',
    phone: `55123477${String(n).padStart(2, '0')}`,
  });

  async function world(
    options: { quantity?: number; lots?: boolean } = {},
  ): Promise<World> {
    const tenantId = randomUUID();
    tenantIds.push(tenantId);
    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: `Sucursal ${tenantId.slice(0, 6)}`,
        slug: `sw-${tenantId}`,
      },
    });
    const productId = randomUUID();
    await prisma.product.create({
      data: {
        id: productId,
        tenantId,
        name: 'Croquetas Adulto 18 kg',
        useStock: true,
        quantity: options.quantity ?? 0,
        useLotsAndExpirations: options.lots ?? false,
      },
    });
    await prisma.priceList.create({
      data: {
        tenantId,
        productId,
        globalPriceListId: publicListId,
        priceCents: 1000,
      },
    });
    const customers: string[] = [];
    for (let n = 1; n <= 8; n++) {
      const id = randomUUID();
      await prisma.customer.create({
        data: { id, tenantId, firstName: `Cliente${n}`, ...phoneOf(n) },
      });
      customers.push(id);
    }
    const decision = await prisma.humanDecision.create({
      data: {
        tenantId,
        source: 'houndfe-chatbot',
        sourceRequestId: randomUUID(),
        type: 'RESTOCK',
        canonicalRequestHash: 'h'.repeat(64),
        submittedCredentialId: 'cred',
        branchId: tenantId,
        branchName: 'Centro',
        productId,
        productName: 'Croquetas',
        variantId: null,
        status: 'RESOLVED',
        version: 2,
        resolutionAction: 'PROVIDE_RESTOCK_ESTIMATE',
        restockDays: 7,
        resolutionRequestId: randomUUID(),
        resolvedAt: RESOLVED_AT,
        resolvedByActorId: 'actor',
        resolvedByDisplayName: 'Gerente',
      },
    });
    return {
      tenantId,
      token: credentials.register(tenantId, ALL_SCOPES),
      productId,
      decisionId: decision.id,
      customers,
    };
  }

  /** WAITING backorders in queue order (scheduledAt strictly increasing). */
  async function waiting(
    w: World,
    specs: Array<{
      quantity: number;
      referencePriceCents?: number;
      variantId?: string | null;
    }>,
    customerOffset = 0,
  ) {
    const base = Date.now() - 10 * HOUR;
    const rows: Array<Awaited<ReturnType<typeof prisma.backorder.create>>> = [];
    for (const [i, spec] of specs.entries()) {
      rows.push(
        await prisma.backorder.create({
          data: {
            tenantId: w.tenantId,
            folio: `BO-${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
            customerId: w.customers[customerOffset + i],
            productId: w.productId,
            variantId: spec.variantId ?? null,
            quantity: spec.quantity,
            referencePriceCents: spec.referencePriceCents ?? 1000,
            scheduledAt: new Date(base + i * 1000),
            estimatedArrivalDays: 7,
            estimatedAt: new Date(Date.now() + 7 * DAY),
            sourceDecisionId: w.decisionId,
            idempotencyKey: randomUUID(),
            requestHash: 'a'.repeat(64),
          },
        }),
      );
    }
    return rows;
  }

  const inTenant = <T>(w: World, work: () => T): T =>
    cls.runWith(
      { tenantId: w.tenantId, userId: 'test', isSuperAdmin: false },
      work,
    );
  const inTx = <T>(w: World, work: () => Promise<T>): Promise<T> =>
    inTenant(w, () => tenantPrisma.runInTransaction(work));

  /** An arrival: +delta on the untracked bucket through the journal (allocator runs in the same tx). */
  const arrive = (w: World, delta: number, group = randomUUID()) =>
    inTx(w, () =>
      writer.apply(
        [
          {
            bucket: { kind: 'PRODUCT_UNTRACKED', productId: w.productId },
            delta,
          },
        ],
        {
          type: 'ADJUSTMENT',
          groupType: 'ADJUSTMENT',
          groupId: group,
          actor: SYSTEM,
        },
      ),
    );

  const backorder = (id: string) =>
    prisma.backorder.findUniqueOrThrow({ where: { id } });
  const quantityOf = async (productId: string) =>
    (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
      .quantity;
  const items = (w: World, type?: string, backorderId?: string) =>
    prisma.chatbotFeedItem.findMany({
      where: {
        tenantId: w.tenantId,
        backorderId: backorderId ?? { not: null },
        ...(type ? { type } : {}),
      },
      orderBy: { cursor: 'asc' },
    });
  const notices = async (w: World, backorderId?: string) =>
    (
      await prisma.outboxEvent.findMany({
        where: {
          tenantId: w.tenantId,
          aggregateType: 'Backorder',
          ...(backorderId ? { aggregateId: backorderId } : {}),
        },
        orderBy: { createdAt: 'asc' },
      })
    ).map((event) => event.payload as Record<string, unknown>);
  const journal = (w: World, groupId: string) =>
    prisma.stockMovement.findMany({
      where: { tenantId: w.tenantId, groupId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  const cancel = (token: string, id: string) =>
    request(app.getHttpServer())
      .post(`/chatbot-api/backorders/${id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
  const deadlocks = (results: PromiseSettledResult<unknown>[]) =>
    results.filter(
      (r) =>
        r.status === 'rejected' &&
        /deadlock|40P01/i.test(
          String((r.reason as Error)?.message ?? r.reason),
        ),
    );
  const at = (row: { reservedUntil: Date | null }, offsetMs: number) =>
    new Date((row.reservedUntil as Date).getTime() + offsetMs);

  // ---------------------------------------------------------------------------
  // backorder.reserved: same transaction as the reservation
  // ---------------------------------------------------------------------------

  describe('backorder.reserved (contract §10)', () => {
    it('is enqueued in the reserving transaction, exactly once, with the contract payload and the customer chat', async () => {
      const w = await world();
      const [a] = await waiting(w, [
        { quantity: 2, referencePriceCents: 1500 },
      ]);
      await prisma.chatbotConversation.create({
        data: {
          tenantId: w.tenantId,
          conversationRef: 'wa:5215512347701',
          customerKey: '525512347701',
        },
      });

      await arrive(w, 2);

      const row = await backorder(a.id);
      expect(row.status).toBe('RESERVED');
      const reserved = await items(w, 'backorder.reserved');
      expect(reserved).toHaveLength(1);
      expect(reserved[0]).toMatchObject({
        backorderId: a.id,
        requestId: null,
        saleId: null,
        conversationRef: 'wa:5215512347701',
        ackedAt: null,
        outcome: null,
      });
      expect(reserved[0].payload).toEqual({
        backorderId: a.id,
        folio: a.folio,
        productName: 'Croquetas Adulto 18 kg',
        variantName: null,
        quantity: 2,
        branchName: expect.stringMatching(/^Sucursal /) as string,
        customerFirstName: 'Cliente1',
        version: row.version,
        referencePriceCents: 1500,
        currentPriceCents: 1000,
        finalPriceCents: 1000,
        reservedUntil: row.reservedUntil!.toISOString(),
        reminderAt: row.reminderAt!.toISOString(),
      });
      // The staff notice rides the same transaction (outbox).
      expect(await notices(w, a.id)).toEqual([
        expect.objectContaining({
          type: 'BACKORDER_RESERVED',
          backorderId: a.id,
          folio: a.folio,
          quantity: 2,
          dedupKey: `backorder-reserved:${a.id}:${row.version}`,
        }),
      ]);
      // A second allocation pass does not enqueue it again.
      await arrive(w, 1);
      expect(await items(w, 'backorder.reserved')).toHaveLength(1);
    });

    it('a customer without a mirrored chat gets conversationRef null', async () => {
      const w = await world();
      await waiting(w, [{ quantity: 1 }]);
      await arrive(w, 1);
      const [item] = await items(w, 'backorder.reserved');
      expect(item.conversationRef).toBeNull();
    });

    it('rolls the item and the staff notice back with the reservation when the caller fails', async () => {
      const w = await world();
      const [a] = await waiting(w, [{ quantity: 2 }]);
      await expect(
        inTx(w, async () => {
          await writer.apply(
            [
              {
                bucket: { kind: 'PRODUCT_UNTRACKED', productId: w.productId },
                delta: 5,
              },
            ],
            {
              type: 'ADJUSTMENT',
              groupType: 'ADJUSTMENT',
              groupId: 'g',
              actor: SYSTEM,
            },
          );
          expect(
            await tenantPrisma
              .getClient()
              .chatbotFeedItem.count({ where: { backorderId: a.id } }),
          ).toBe(1);
          throw new Error('caller failed after the stock write');
        }),
      ).rejects.toThrow('caller failed');
      expect(await items(w)).toEqual([]);
      expect(await notices(w)).toEqual([]);
      expect((await backorder(a.id)).status).toBe('WAITING');
    });

    it('one item per backorder: a queue of three reserved at once gets three items', async () => {
      const w = await world();
      const queue = await waiting(w, [
        { quantity: 1 },
        { quantity: 1 },
        { quantity: 1 },
      ]);
      await arrive(w, 3);
      const reserved = await items(w, 'backorder.reserved');
      expect(reserved.map((item) => item.backorderId)).toEqual(
        queue.map((q) => q.id),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Reminder and expiry (D3)
  // ---------------------------------------------------------------------------

  describe('reminder (3 h before) and expiry (24 h)', () => {
    async function reserved(quantity = 2) {
      const w = await world();
      const queue = await waiting(w, [{ quantity }, { quantity }]);
      await arrive(w, quantity);
      const a = await backorder(queue[0].id);
      expect(a.status).toBe('RESERVED');
      return { w, a, b: queue[1] };
    }

    it('does nothing before reminderAt', async () => {
      const { w, a } = await reserved();
      const result = await sweep.tick(new Date(a.reminderAt!.getTime() - 1000));
      expect(result.reminders).toBe(0);
      expect(await items(w, 'backorder.reservation_reminder')).toEqual([]);
      expect((await backorder(a.id)).reservationStage).toBe(0);
    });

    it('sends the reminder once: stage 1, the deadline in the payload, UTC Z', async () => {
      const { w, a } = await reserved();
      const now = new Date(a.reminderAt!.getTime() + 1000);

      const first = await sweep.tick(now);
      const second = await sweep.tick(new Date(now.getTime() + 30_000));

      expect(first.reminders).toBe(1);
      expect(second.reminders).toBe(0);
      const row = await backorder(a.id);
      expect(row).toMatchObject({ status: 'RESERVED', reservationStage: 1 });
      const sent = await items(w, 'backorder.reservation_reminder');
      expect(sent).toHaveLength(1);
      expect(sent[0].payload).toMatchObject({
        backorderId: a.id,
        folio: a.folio,
        version: row.version,
        reservedUntil: a.reservedUntil!.toISOString(),
      });
      // The reminder is customer-facing only: no staff notice.
      expect(await notices(w, a.id)).toEqual([
        expect.objectContaining({ type: 'BACKORDER_RESERVED' }),
      ]);
    });

    it('two sweeps at once send ONE reminder (row lock + stage + unique index)', async () => {
      const { w, a } = await reserved();
      const now = new Date(a.reminderAt!.getTime() + 1000);
      const results = await Promise.allSettled([
        sweep.tick(now),
        sweep.tick(now),
        sweep.tick(now),
      ]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      expect(await items(w, 'backorder.reservation_reminder')).toHaveLength(1);
      expect((await backorder(a.id)).reservationStage).toBe(1);
    });

    it('expiry: EXPIRED, units released, the next backorder reserved, items and staff notice once', async () => {
      const { w, a, b } = await reserved(2);
      // b (2) waits behind a; nothing is left for it.
      expect(await quantityOf(w.productId)).toBe(0);
      const now = at(a, 1000);

      const result = await sweep.tick(now);

      expect(result.expired).toBe(1);
      const expired = await backorder(a.id);
      expect(expired).toMatchObject({ status: 'EXPIRED', reservationStage: 2 });
      expect(expired.expiredAt).toEqual(now);
      expect(expired.version).toBe(a.version + 1);
      // The units went to the next in queue (still reserved, not general stock).
      expect(await quantityOf(w.productId)).toBe(0);
      const next = await backorder(b.id);
      expect(next.status).toBe('RESERVED');
      expect(
        (await journal(w, a.id)).map((m) => `${m.type}:${m.delta}`),
      ).toEqual(['BACKORDER_RESERVE:-2', 'BACKORDER_RELEASE:2']);

      const lapsed = await items(w, 'backorder.reservation_expired');
      expect(lapsed).toHaveLength(1);
      expect(lapsed[0].backorderId).toBe(a.id);
      expect(lapsed[0].payload).toMatchObject({
        backorderId: a.id,
        folio: a.folio,
        expiredAt: now.toISOString(),
        version: expired.version,
      });
      // `a` was served first, then the freed units reserved `b`.
      expect(
        (await items(w, 'backorder.reserved')).map((item) => item.backorderId),
      ).toEqual([a.id, b.id]);
      expect(await notices(w, a.id)).toEqual([
        expect.objectContaining({ type: 'BACKORDER_RESERVED' }),
        expect.objectContaining({
          type: 'BACKORDER_EXPIRED',
          dedupKey: `backorder-expired:${a.id}`,
        }),
      ]);

      // Idempotent: a later sweep finds nothing to do for `a`.
      const again = await sweep.tick(new Date(now.getTime() + 30_000));
      expect(again.expired).toBe(0);
      expect(await items(w, 'backorder.reservation_expired')).toHaveLength(1);
    });

    it('with no one waiting the units go back to general stock', async () => {
      const w = await world();
      const [a] = await waiting(w, [{ quantity: 3 }]);
      await arrive(w, 3);
      expect(await quantityOf(w.productId)).toBe(0);
      const row = await backorder(a.id);

      await sweep.tick(at(row, 1000));

      expect((await backorder(a.id)).status).toBe('EXPIRED');
      expect(await quantityOf(w.productId)).toBe(3);
    });

    it('a sweep that was down past both deadlines expires without a reminder', async () => {
      const { w, a } = await reserved();
      await sweep.tick(at(a, 5 * HOUR));
      expect((await backorder(a.id)).status).toBe('EXPIRED');
      expect(await items(w, 'backorder.reservation_reminder')).toEqual([]);
      expect(await items(w, 'backorder.reservation_expired')).toHaveLength(1);
    });

    it('a reminded backorder still expires at its deadline', async () => {
      const { w, a } = await reserved();
      await sweep.tick(new Date(a.reminderAt!.getTime() + 1000));
      await sweep.tick(at(a, 1000));
      expect((await backorder(a.id)).status).toBe('EXPIRED');
      expect(await items(w, 'backorder.reservation_reminder')).toHaveLength(1);
      expect(await items(w, 'backorder.reservation_expired')).toHaveLength(1);
    });

    it('two sweeps at once expire it once: one release, one item, one notice', async () => {
      const { w, a } = await reserved();
      const now = at(a, 1000);
      const results = await Promise.allSettled([
        sweep.tick(now),
        sweep.tick(now),
        sweep.tick(now),
      ]);
      expect(deadlocks(results)).toEqual([]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      expect(
        (await journal(w, a.id)).filter((m) => m.type === 'BACKORDER_RELEASE'),
      ).toHaveLength(1);
      expect(await items(w, 'backorder.reservation_expired')).toHaveLength(1);
      expect(
        (await notices(w, a.id)).filter((n) => n.type === 'BACKORDER_EXPIRED'),
      ).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Lots (Q6)
  // ---------------------------------------------------------------------------

  describe('reserved lot expiry (owner Q6)', () => {
    const dateOnly = (offsetDays: number) => {
      const t = new Date();
      return new Date(
        Date.UTC(
          t.getUTCFullYear(),
          t.getUTCMonth(),
          t.getUTCDate() + offsetDays,
        ),
      );
    };
    const lot = (w: World, lotNumber: string, expiresInDays: number) =>
      prisma.lot.create({
        data: {
          tenantId: w.tenantId,
          productId: w.productId,
          lotNumber,
          quantity: 0,
          expirationDate: dateOnly(expiresInDays),
        },
      });
    const arriveInLot = (w: World, lotId: string, delta: number) =>
      inTx(w, () =>
        writer.apply(
          [
            {
              bucket: { kind: 'LOT', productId: w.productId, lotId },
              delta,
            },
          ],
          {
            type: 'ADJUSTMENT',
            groupType: 'ADJUSTMENT',
            groupId: randomUUID(),
            actor: SYSTEM,
          },
        ),
      );
    /** Keeps the 24 h window open so only the lot expiry is under test. */
    const keepOpen = (id: string) =>
      prisma.backorder.update({
        where: { id },
        data: {
          reservedUntil: new Date(Date.now() + 30 * DAY),
          reminderAt: new Date(Date.now() + 29 * DAY),
        },
      });

    it('swaps silently: no feed item, stays RESERVED', async () => {
      const w = await world({ lots: true });
      const lotA = await lot(w, 'A', 2);
      const lotB = await lot(w, 'B', 60);
      const [a] = await waiting(w, [{ quantity: 8 }]);
      await arriveInLot(w, lotA.id, 8);
      await arriveInLot(w, lotB.id, 10);
      await keepOpen(a.id);
      const before = await items(w);

      const result = await sweep.tick(new Date(Date.now() + 5 * DAY));

      expect(result.swapped).toBe(1);
      expect(result.lost).toBe(0);
      expect((await backorder(a.id)).status).toBe('RESERVED');
      expect(await items(w)).toHaveLength(before.length);
      expect(await items(w, 'backorder.reservation_lost')).toEqual([]);
      // Nothing left to do on the next tick.
      expect((await sweep.tick(new Date(Date.now() + 5 * DAY))).swapped).toBe(
        0,
      );
    });

    it('reservation lost: back to WAITING at its place, backorder.reservation_lost with the queue position', async () => {
      const w = await world({ lots: true });
      const lotA = await lot(w, 'A', 2);
      const lotB = await lot(w, 'B', 60);
      const [a] = await waiting(w, [{ quantity: 8 }]);
      await arriveInLot(w, lotA.id, 8);
      expect((await backorder(a.id)).status).toBe('RESERVED');
      await arriveInLot(w, lotB.id, 3);
      await keepOpen(a.id);
      const before = await backorder(a.id);

      const result = await sweep.tick(new Date(Date.now() + 5 * DAY));

      expect(result.lost).toBe(1);
      const lost = await backorder(a.id);
      expect(lost).toMatchObject({
        status: 'WAITING',
        reservedUntil: null,
        reservationStage: 0,
      });
      expect(lost.scheduledAt).toEqual(before.scheduledAt);
      const sent = await items(w, 'backorder.reservation_lost');
      expect(sent).toHaveLength(1);
      expect(sent[0].payload).toEqual({
        backorderId: a.id,
        folio: a.folio,
        productName: 'Croquetas Adulto 18 kg',
        variantName: null,
        quantity: 8,
        branchName: expect.stringMatching(/^Sucursal /) as string,
        customerFirstName: 'Cliente1',
        version: lost.version,
        reason: 'LOT_EXPIRED',
        queuePosition: 1,
        estimatedAt: lost.estimatedAt.toISOString(),
      });
      // Exactly once.
      await sweep.tick(new Date(Date.now() + 5 * DAY));
      expect(await items(w, 'backorder.reservation_lost')).toHaveLength(1);
    });

    it('a reservation lost twice (a later re-reservation) is a new version and a new item', async () => {
      const w = await world({ lots: true });
      const lotA = await lot(w, 'A', 2);
      const [a] = await waiting(w, [{ quantity: 4 }]);
      await arriveInLot(w, lotA.id, 4);
      await keepOpen(a.id);
      await sweep.tick(new Date(Date.now() + 5 * DAY)); // lost #1
      const lotC = await lot(w, 'C', 3);
      await arriveInLot(w, lotC.id, 4); // re-reserved from lot C
      expect((await backorder(a.id)).status).toBe('RESERVED');
      await keepOpen(a.id);
      await sweep.tick(new Date(Date.now() + 8 * DAY)); // lot C expired too: lost #2
      expect(await items(w, 'backorder.reservation_lost')).toHaveLength(2);
      expect(await items(w, 'backorder.reserved')).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Recovery pointer (contract §10)
  // ---------------------------------------------------------------------------

  describe('GET /chatbot-api/backorders?updatedSince (feed recovery)', () => {
    const list = (token: string, query: Record<string, string>) =>
      request(app.getHttpServer())
        .get('/chatbot-api/backorders')
        .set('Authorization', `Bearer ${token}`)
        .query(query);

    it('adds the feed position of the oldest unacknowledged backorder item, only on a recovery read', async () => {
      const w = await world();
      const [a, b] = await waiting(w, [{ quantity: 1 }, { quantity: 1 }]);
      await arrive(w, 2);
      const [first, second] = await items(w, 'backorder.reserved');
      expect([first.backorderId, second.backorderId]).toEqual([a.id, b.id]);
      const since = new Date(Date.now() - DAY).toISOString();

      const plain = await list(w.token, { status: 'RESERVED' });
      expect(plain.status).toBe(200);
      expect(Object.keys(plain.body)).toEqual(['items']);

      const recovery = await list(w.token, { updatedSince: since });
      expect(recovery.status).toBe(200);
      expect(recovery.body.items).toHaveLength(2);
      expect(recovery.body.backorderUndeliveredResumeAfter).toBe(
        String(first.cursor - 1n).padStart(12, '0'),
      );

      // Acknowledged items are not re-served: the pointer moves to the next one.
      await prisma.chatbotFeedItem.update({
        where: { cursor: first.cursor },
        data: {
          outcome: 'PROVIDER_ACCEPTED',
          attemptId: randomUUID(),
          evidenceHash: 'h'.repeat(64),
          ackedAt: new Date(),
        },
      });
      expect(
        (await list(w.token, { updatedSince: since })).body
          .backorderUndeliveredResumeAfter,
      ).toBe(String(second.cursor - 1n).padStart(12, '0'));
    });

    it('is null when nothing is pending, and never leaks another tenant’s items', async () => {
      const w = await world();
      const other = await world();
      await waiting(other, [{ quantity: 1 }]);
      await arrive(other, 1);
      const since = new Date(Date.now() - DAY).toISOString();
      const res = await list(w.token, { updatedSince: since });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        items: [],
        backorderUndeliveredResumeAfter: null,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Safety net
  // ---------------------------------------------------------------------------

  describe('safety-net allocation', () => {
    it('reserves a waiting backorder that the stock listener missed, with its feed item', async () => {
      const w = await world({ quantity: 5 }); // stock already there, queue formed after
      const [a, b] = await waiting(w, [{ quantity: 2 }, { quantity: 9 }]);

      const result = await sweep.tick(new Date());

      expect(result.allocated).toBe(1);
      expect((await backorder(a.id)).status).toBe('RESERVED');
      expect((await backorder(b.id)).status).toBe('WAITING');
      expect(await quantityOf(w.productId)).toBe(3);
      expect(await items(w, 'backorder.reserved')).toHaveLength(1);
      // Nothing more to do.
      expect((await sweep.tick(new Date())).allocated).toBe(0);
    });

    it("a variant queue is served from that variant's own stock only, with the variant name in the item", async () => {
      const w = await world();
      await prisma.product.update({
        where: { id: w.productId },
        data: { hasVariants: true },
      });
      const variant = await prisma.variant.create({
        data: {
          productId: w.productId,
          tenantId: w.tenantId,
          name: 'Grande',
          quantity: 3,
        },
      });
      const other = await prisma.variant.create({
        data: {
          productId: w.productId,
          tenantId: w.tenantId,
          name: 'Chica',
          quantity: 0,
        },
      });
      const list = await prisma.priceList.findFirstOrThrow({
        where: { tenantId: w.tenantId, productId: w.productId },
      });
      await prisma.variantPrice.create({
        data: {
          tenantId: w.tenantId,
          variantId: variant.id,
          priceListId: list.id,
          priceCents: 1000,
        },
      });
      const [a, b] = await waiting(w, [
        { quantity: 2, variantId: variant.id },
        { quantity: 1, variantId: other.id },
      ]);

      await sweep.tick(new Date());

      expect((await backorder(a.id)).status).toBe('RESERVED');
      expect((await backorder(b.id)).status).toBe('WAITING');
      const [item] = await items(w, 'backorder.reserved');
      expect(item.payload).toMatchObject({
        backorderId: a.id,
        variantName: 'Grande',
      });
    });

    it('does nothing for a product without sellable stock, and never touches other tenants', async () => {
      const w = await world({ quantity: 0 });
      const other = await world({ quantity: 0 });
      const [a] = await waiting(w, [{ quantity: 2 }]);
      await sweep.tick(new Date());
      expect((await backorder(a.id)).status).toBe('WAITING');
      expect(await items(other)).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Concurrency (item 4)
  // ---------------------------------------------------------------------------

  describe('concurrency: sweep vs bot cancel vs arrivals', () => {
    it('the sweep expiring a backorder while the bot cancels it releases the units exactly once', async () => {
      const outcomes = { cancelled: 0, expired: 0 };
      for (let round = 0; round < 6; round++) {
        const w = await world();
        const [a] = await waiting(w, [{ quantity: 2 }]);
        await arrive(w, 2);
        const row = await backorder(a.id);
        const now = at(row, 1000);

        const results = await Promise.allSettled([
          sweep.tick(now),
          cancel(w.token, a.id),
        ]);

        expect(deadlocks(results)).toEqual([]);
        const [tick, cancelled] = results;
        expect(tick.status).toBe('fulfilled');
        expect(cancelled.status).toBe('fulfilled');
        const status = (cancelled as PromiseFulfilledResult<{ status: number }>)
          .value.status;
        const final = await backorder(a.id);
        // Exactly one of the two closed it; units went back once.
        expect(['CANCELLED', 'EXPIRED']).toContain(final.status);
        if (final.status === 'CANCELLED') {
          expect(status).toBe(200);
          outcomes.cancelled++;
          expect(await items(w, 'backorder.reservation_expired')).toEqual([]);
        } else {
          expect(status).toBe(409);
          outcomes.expired++;
          expect(await items(w, 'backorder.reservation_expired')).toHaveLength(
            1,
          );
        }
        expect(await quantityOf(w.productId)).toBe(2);
        expect(
          (await journal(w, a.id)).filter(
            (m) => m.type === 'BACKORDER_RELEASE',
          ),
        ).toHaveLength(1);
      }
      expect(outcomes.cancelled + outcomes.expired).toBe(6);
    });

    it('expiry racing an arrival and a sweep: no deadlock, no negative stock, every unit accounted for', async () => {
      for (let round = 0; round < 4; round++) {
        const w = await world();
        const queue = await waiting(w, [
          { quantity: 2 },
          { quantity: 2 },
          { quantity: 2 },
        ]);
        await arrive(w, 2); // queue[0] reserved
        const first = await backorder(queue[0].id);
        const now = at(first, 1000);

        const results = await Promise.allSettled([
          sweep.tick(now),
          arrive(w, 2),
          sweep.tick(now),
          cancel(w.token, queue[1].id),
        ]);

        expect(deadlocks(results)).toEqual([]);
        expect(results.slice(0, 3).every((r) => r.status === 'fulfilled')).toBe(
          true,
        );
        expect(await quantityOf(w.productId)).toBeGreaterThanOrEqual(0);
        const all = await Promise.all(queue.map((q) => backorder(q.id)));
        const heldUnits = all
          .filter((row) => row.status === 'RESERVED')
          .reduce((sum, row) => sum + row.quantity, 0);
        // 4 units ever arrived; whatever is not reserved is on the shelf.
        expect(heldUnits + (await quantityOf(w.productId))).toBe(4);
        // Reserved rows hold exactly their units in the journal.
        for (const row of all) {
          const movements = await journal(w, row.id);
          const held = -movements.reduce((sum, m) => sum + m.delta, 0);
          expect(held + 0).toBe(row.status === 'RESERVED' ? row.quantity : 0);
        }
      }
    });
  });
});
