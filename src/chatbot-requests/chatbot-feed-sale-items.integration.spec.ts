/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- supertest response bodies are untyped JSON */
/**
 * pay-in-store-pickup / T3 (S2, S3, S6) — sale-level items of the bot feed
 * against REAL PostgreSQL: `sale.pickup_reminder`, `sale.pickup_expired`,
 * `sale.pickup_extended` (`requestId` NULL, `saleId` set).
 *   - the real feed read serves them; the ACK accepts sent/unknown/stale once
 *     and refuses both deferrals; no request audit event is written;
 *   - exactly once per (sale, type, holdVersion);
 *   - conversationRef: the one chat of the sale customer's phone key, else null;
 *   - every reader that assumes a request keeps working for request items
 *     (shape, ACK audit, pending-deliveries, recovery, purge);
 *   - tenant isolation, the CHECK and the tenant-consistent sale FK.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { createHash, randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import request from 'supertest';
import { integrationPrisma } from '../../test/integration/reset-db';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../chatbot-api/domain/service-credential.repository';
import { PrismaServiceCredentialRepository } from '../chatbot-api/infrastructure/prisma-service-credential.repository';
import { BotRateLimitModule } from '../chatbot-api/presentation/guards/bot-rate-limit.module';
import { ServiceAuthGuard } from '../chatbot-api/presentation/guards/service-auth.guard';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { PrismaService } from '../shared/prisma/prisma.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { RealtimeModule } from '../shared/realtime/realtime.module';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import {
  CHATBOT_FEED_STORE,
  ChatbotFeedService,
  FEED_CLOCK,
  FEED_WAKEUP,
} from './application/chatbot-feed.service';
import {
  CHATBOT_RECOVERY_STORE,
  ChatbotRecoveryService,
} from './application/chatbot-recovery.service';
import { PgFeedWakeup } from './infrastructure/feed-wakeup';
import { PrismaChatbotFeedStore } from './infrastructure/prisma-chatbot-feed.store';
import { PrismaChatbotRecoveryStore } from './infrastructure/prisma-chatbot-recovery.store';
import {
  enqueuePickupExpired,
  enqueuePickupExpiredReview,
  enqueuePickupExtended,
  enqueuePickupReminder,
  type PickupFeedSale,
} from './infrastructure/sale-feed-writes';
import { BotFeedController } from './presentation/bot-feed.controller';
import { BotRecoveryController } from './presentation/bot-recovery.controller';
import { ChatbotRequestHttpFilter } from './presentation/chatbot-request-http.filter';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

const AT = '2026-11-18T16:20:00.000Z';
const HOLD_UNTIL = new Date('2026-11-19T18:30:00.000Z');
const pad = (cursor: bigint | number) => String(cursor).padStart(12, '0');

describeIfDb('sale-level feed items (PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const cls = new ClsService<TenantClsStore>(
    new AsyncLocalStorage<TenantClsStore>(),
  );
  const tenantPrisma = new TenantPrismaService(
    prisma as unknown as ConstructorParameters<typeof TenantPrismaService>[0],
    cls,
  );
  const feedStore = new PrismaChatbotFeedStore(
    tenantPrisma,
    prisma as unknown as PrismaService,
  );
  let app: INestApplication;
  const tenants: string[] = [];
  const credentials: string[] = [];
  const cashier = randomUUID();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        DatabaseModule,
        BotRateLimitModule,
        RealtimeModule,
      ],
      controllers: [BotFeedController, BotRecoveryController],
      providers: [
        ServiceAuthGuard,
        ChatbotRequestHttpFilter,
        ChatbotFeedService,
        ChatbotRecoveryService,
        PgFeedWakeup,
        { provide: FEED_WAKEUP, useExisting: PgFeedWakeup },
        { provide: CHATBOT_FEED_STORE, useClass: PrismaChatbotFeedStore },
        {
          provide: CHATBOT_RECOVERY_STORE,
          useClass: PrismaChatbotRecoveryStore,
        },
        { provide: FEED_CLOCK, useValue: Date.now },
        {
          provide: SERVICE_CREDENTIAL_REPOSITORY,
          useClass: PrismaServiceCredentialRepository,
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await prisma.user.create({
      data: {
        id: cashier,
        email: `${cashier}@sale-feed.test`,
        hashedPassword: 'x',
        name: 'Bot cashier',
      },
    });
  });

  afterAll(async () => {
    await app.close();
    await prisma.serviceRateBucket.deleteMany({
      where: { credentialId: { in: credentials } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.user.deleteMany({ where: { id: cashier } });
  });

  // -------------------------------------------------------------- helpers

  async function bot() {
    const id = randomUUID();
    tenants.push(id);
    await prisma.tenant.create({
      data: { id, name: 'Sucursal Apartado', slug: `sale-feed-${id}` },
    });
    const token = `svc_${randomUUID()}`;
    const credential = await prisma.serviceCredential.create({
      data: {
        tenantId: id,
        name: 'bot',
        hashedKey: createHash('sha256').update(token).digest('hex'),
        scopes: ['requests:read', 'feed:read', 'feed:ack'],
        rateLimit: 600,
      },
    });
    credentials.push(credential.id);
    return { tenantId: id, token };
  }
  type Bot = Awaited<ReturnType<typeof bot>>;

  const auth = (b: Bot, req: request.Test) =>
    req
      .set('Authorization', `Bearer ${b.token}`)
      .set('X-Branch-Id', b.tenantId);
  const http = () => request(app.getHttpServer());
  const feed = (b: Bot, query = '?waitSeconds=0') =>
    auth(b, http().get(`/chatbot-api/feed${query}`));
  const outcome = (b: Bot, deliveryId: string, body: object) =>
    auth(b, http().post(`/chatbot-api/deliveries/${deliveryId}/outcome`)).send(
      body,
    );
  const pending = (b: Bot, conversationRef: string) =>
    auth(
      b,
      http().get(
        `/chatbot-api/requests/pending-deliveries?conversationRef=${encodeURIComponent(conversationRef)}`,
      ),
    );
  const recover = (b: Bot) =>
    auth(b, http().get('/chatbot-api/requests?status=open'));

  let seq = 0;
  /** A pay-in-store sale with a customer whose phone is `phone` (or none). */
  async function sale(
    b: Bot,
    phone: string | null = `55${String(10_000_000 + ++seq)}`,
  ): Promise<PickupFeedSale & { customerKey: string | null }> {
    let customerId: string | null = null;
    if (phone) {
      const customer = await prisma.customer.create({
        data: {
          tenantId: b.tenantId,
          firstName: 'Eva',
          phoneCountryCode: '52',
          phone,
        },
      });
      customerId = customer.id;
    }
    const id = randomUUID();
    const folio = `V-${id.slice(0, 6)}`;
    await prisma.sale.create({
      data: {
        id,
        tenantId: b.tenantId,
        userId: cashier,
        customerId,
        status: 'CONFIRMED',
        channel: 'ONLINE',
        fulfillmentMode: 'PICKUP',
        paymentStatus: 'CREDIT',
        totalCents: 45_000,
        debtCents: 45_000,
        folio,
        paymentIntent: 'IN_STORE',
        holdExpiresAt: HOLD_UNTIL,
        holdVersion: 1,
      },
    });
    return {
      id,
      folio,
      holdExpiresAt: HOLD_UNTIL,
      customerId,
      customerKey: phone ? `52${phone}` : null,
    };
  }

  const chat = (b: Bot, customerKey: string, ref = `wa:${customerKey}`) =>
    prisma.chatbotConversation.create({
      data: { tenantId: b.tenantId, conversationRef: ref, customerKey },
    });

  const inTx = <T>(tenantId: string, work: () => Promise<T>) =>
    cls.runWith({ tenantId, userId: 'test', isSuperAdmin: false }, () =>
      tenantPrisma.runInTransaction(work),
    );
  const enqueue = {
    reminder: (b: Bot, s: PickupFeedSale, version: number) =>
      inTx(b.tenantId, () =>
        enqueuePickupReminder(tenantPrisma.getClient(), b.tenantId, s, version),
      ),
    expired: (b: Bot, s: PickupFeedSale, version: number) =>
      inTx(b.tenantId, () =>
        enqueuePickupExpired(tenantPrisma.getClient(), b.tenantId, s, version),
      ),
    extended: (b: Bot, s: PickupFeedSale, version: number) =>
      inTx(b.tenantId, () =>
        enqueuePickupExtended(
          tenantPrisma.getClient(),
          b.tenantId,
          { ...s, previousHoldExpiresAt: null },
          version,
        ),
      ),
    expiredReview: (b: Bot, s: PickupFeedSale, version: number) =>
      inTx(b.tenantId, () =>
        enqueuePickupExpiredReview(
          tenantPrisma.getClient(),
          b.tenantId,
          s,
          version,
        ),
      ),
  };

  const saleItems = (tenantId: string, saleId?: string) =>
    prisma.chatbotFeedItem.findMany({
      where: { tenantId, saleId: saleId ?? { not: null } },
      orderBy: { cursor: 'asc' },
    });

  let reqSeq = 0;
  async function openRequest(b: Bot, conversationRef: string) {
    return prisma.chatbotRequest.create({
      data: {
        tenantId: b.tenantId,
        folio: ++reqSeq,
        kind: 'CLARIFICATION',
        subtype: 'UNKNOWN_QUESTION',
        customerKey: `5255${String(70_000_000 + reqSeq)}`,
        conversationRef,
        summary: 'Pregunta',
        source: 'chatbot',
        sourceRequestId: randomUUID(),
      },
    });
  }
  const requestItem = (b: Bot, requestId: string, conversationRef: string) =>
    prisma.chatbotFeedItem.create({
      data: {
        tenantId: b.tenantId,
        requestId,
        type: 'request.answered',
        conversationRef,
        payload: { kind: 'CLARIFICATION', text: 'Sí' },
      },
    });

  const accepted = (attemptId = randomUUID()) => ({
    attemptId,
    outcome: 'PROVIDER_ACCEPTED',
    providerMessageId: `wamid.${attemptId}`,
    attemptedAt: AT,
  });

  // ---------------------------------------------------------------- tests

  it('a reminder is a sale item (requestId null) served by the real feed with its payload and the customer chat', async () => {
    const b = await bot();
    const s = await sale(b);
    await chat(b, s.customerKey as string);

    expect(await enqueue.reminder(b, s, 1)).toBe(true);

    const res = await feed(b).expect(200);
    expect(res.body.items).toHaveLength(1);
    const [item] = res.body.items;
    expect(item).toEqual({
      cursor: expect.stringMatching(/^\d{12}$/),
      deliveryId: expect.any(String),
      type: 'sale.pickup_reminder',
      requestId: null,
      saleId: s.id,
      conversationRef: `wa:${s.customerKey}`,
      payload: {
        saleId: s.id,
        folio: s.folio,
        branchName: 'Sucursal Apartado',
        holdUntil: HOLD_UNTIL.toISOString(),
        holdVersion: 1,
        conversationRef: `wa:${s.customerKey}`,
      },
      notBefore: null,
      expiresAt: null,
    });
    const [row] = await saleItems(b.tenantId);
    expect(row).toMatchObject({ requestId: null, saleId: s.id });
  });

  it('is exactly once per (sale, type, holdVersion); a new version or another type is a new item', async () => {
    const b = await bot();
    const s = await sale(b);

    expect(await enqueue.reminder(b, s, 1)).toBe(true);
    expect(await enqueue.reminder(b, s, 1)).toBe(false);
    expect(await enqueue.reminder(b, s, 2)).toBe(true);
    expect(await enqueue.expired(b, s, 2)).toBe(true);
    expect(await enqueue.expired(b, s, 2)).toBe(false);
    expect(await enqueue.extended(b, s, 3)).toBe(true);
    expect(await enqueue.extended(b, s, 3)).toBe(false);
    // T6 / S12: the existing expression index covers the new type too.
    expect(await enqueue.expiredReview(b, s, 3)).toBe(true);
    expect(await enqueue.expiredReview(b, s, 3)).toBe(false);

    const rows = await saleItems(b.tenantId, s.id);
    expect(
      rows.map((r) => [
        r.type,
        (r.payload as { holdVersion: number }).holdVersion,
      ]),
    ).toEqual([
      ['sale.pickup_reminder', 1],
      ['sale.pickup_reminder', 2],
      ['sale.pickup_expired', 2],
      ['sale.pickup_extended', 3],
      ['sale.pickup_expired_review', 3],
    ]);
    const expired = rows[2].payload as Record<string, unknown>;
    expect(Object.keys(expired).sort()).toEqual(
      [
        'branchName',
        'conversationRef',
        'folio',
        'holdVersion',
        'saleId',
      ].sort(),
    );
    expect(rows[4].payload).toEqual({
      saleId: s.id,
      folio: s.folio,
      branchName: 'Sucursal Apartado',
      holdVersion: 3,
      conversationRef: null,
    });
  });

  it('conversationRef is null without a customer phone, without a chat, or with several chats for the key', async () => {
    const b = await bot();
    const noPhone = await sale(b, null);
    const noChat = await sale(b);
    const twoChats = await sale(b);
    await chat(b, twoChats.customerKey as string, 'wa:first');
    await chat(b, twoChats.customerKey as string, 'wa:second');

    await enqueue.reminder(b, noPhone, 1);
    await enqueue.reminder(b, noChat, 1);
    await enqueue.reminder(b, twoChats, 1);

    const rows = await saleItems(b.tenantId);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.conversationRef).toBeNull();
      expect(
        (row.payload as { conversationRef: unknown }).conversationRef,
      ).toBe(null);
    }
  });

  it('rolls back with the caller transaction', async () => {
    const b = await bot();
    const s = await sale(b);
    await expect(
      inTx(b.tenantId, async () => {
        await enqueuePickupReminder(tenantPrisma.getClient(), b.tenantId, s, 1);
        throw new Error('caller failed');
      }),
    ).rejects.toThrow('caller failed');
    expect(await saleItems(b.tenantId)).toHaveLength(0);
  });

  it('ACK: sent/unknown/stale apply once, deferrals are 422 and no request audit event is written', async () => {
    const b = await bot();
    const s = await sale(b);
    await enqueue.reminder(b, s, 1);
    await enqueue.expired(b, s, 1);
    await enqueue.extended(b, s, 2);
    const [reminder, expired, extended] = await saleItems(b.tenantId);

    for (const outcomeName of [
      'DEFERRED_WINDOW_CLOSED',
      'DEFERRED_HUMAN_SESSION',
    ]) {
      for (const item of [reminder, expired, extended]) {
        const res = await outcome(b, item.deliveryId, {
          attemptId: randomUUID(),
          outcome: outcomeName,
          attemptedAt: AT,
        });
        expect([item.type, outcomeName, res.status, res.body.code]).toEqual([
          item.type,
          outcomeName,
          422,
          'OUTCOME_NOT_ALLOWED',
        ]);
      }
    }

    const body = accepted();
    const first = await outcome(b, reminder.deliveryId, body).expect(200);
    expect(first.body).toEqual({
      deliveryId: reminder.deliveryId,
      outcome: 'PROVIDER_ACCEPTED',
      attemptId: body.attemptId,
      ackReceivedAt: expect.any(String),
    });
    const replay = await outcome(b, reminder.deliveryId, body).expect(200);
    expect(replay.body).toEqual(first.body);
    const second = await outcome(b, reminder.deliveryId, accepted());
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('OUTCOME_ALREADY_RECORDED');
    const conflict = await outcome(b, reminder.deliveryId, {
      ...body,
      providerMessageId: 'wamid.other',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');

    await outcome(b, expired.deliveryId, {
      attemptId: randomUUID(),
      outcome: 'DELIVERY_UNKNOWN',
      attemptedAt: AT,
    }).expect(200);
    await outcome(b, extended.deliveryId, {
      attemptId: randomUUID(),
      outcome: 'STALE',
    }).expect(200);

    const rows = await saleItems(b.tenantId);
    expect(rows.map((r) => [r.outcome, r.ackedAt !== null])).toEqual([
      ['PROVIDER_ACCEPTED', true],
      ['DELIVERY_UNKNOWN', true],
      ['STALE', true],
    ]);
    expect(rows[0].providerMessageId).toBe(body.providerMessageId);
    expect(
      await prisma.chatbotRequestEvent.count({
        where: { tenantId: b.tenantId },
      }),
    ).toBe(0);
  });

  it('request items are unaffected: same shape, ACK audit event, pending-deliveries serves a deferred request item and never a sale item', async () => {
    const b = await bot();
    const ref = 'wa:5215598760000';
    const req = await openRequest(b, ref);
    const reqItem = await requestItem(b, req.id, ref);
    const s = await sale(b, '5598760000');
    await chat(b, s.customerKey as string, ref);
    await enqueue.reminder(b, s, 1);

    const page = await feed(b).expect(200);
    expect(page.body.items.map((i: { type: string }) => i.type)).toEqual([
      'request.answered',
      'sale.pickup_reminder',
    ]);
    // The request item keeps its exact envelope (no saleId key).
    expect(Object.keys(page.body.items[0]).sort()).toEqual(
      [
        'conversationRef',
        'cursor',
        'deliveryId',
        'expiresAt',
        'notBefore',
        'payload',
        'requestId',
        'type',
      ].sort(),
    );
    expect(page.body.items[0].requestId).toBe(req.id);
    expect(page.body.items[1].conversationRef).toBe(ref);

    const deferred = await outcome(b, reqItem.deliveryId, {
      attemptId: randomUUID(),
      outcome: 'DEFERRED_WINDOW_CLOSED',
      attemptedAt: AT,
    }).expect(200);
    expect(deferred.body.ackReceivedAt).toBeNull();
    const events = await prisma.chatbotRequestEvent.findMany({
      where: { tenantId: b.tenantId, requestId: req.id },
    });
    expect(events.map((e) => e.type)).toEqual(['DELIVERY_OUTCOME']);

    const served = await pending(b, ref).expect(200);
    expect(
      served.body.items.map((i: { deliveryId: string }) => i.deliveryId),
    ).toEqual([reqItem.deliveryId]);
  });

  it('recovery: saleUndeliveredResumeAfter re-serves the oldest unacknowledged sale item; request pendingDeliveries are unchanged', async () => {
    const b = await bot();
    const ref = 'wa:5215598761111';
    const req = await openRequest(b, ref);
    const reqItem = await requestItem(b, req.id, ref);
    const s = await sale(b);
    await enqueue.reminder(b, s, 1);
    await enqueue.expired(b, s, 1);
    const [reminder, expired] = await saleItems(b.tenantId);

    const res = await recover(b).expect(200);
    expect(res.body.saleUndeliveredResumeAfter).toBe(pad(reminder.cursor - 1n));
    expect(res.body.items).toHaveLength(1);
    expect(
      res.body.items[0].pendingDeliveries.map(
        (d: { deliveryId: string }) => d.deliveryId,
      ),
    ).toEqual([reqItem.deliveryId]);
    expect(res.body.nextCursor).toBe(pad(expired.cursor));

    // Resuming there serves the sale items again.
    const again = await feed(
      b,
      `?waitSeconds=0&after=${res.body.saleUndeliveredResumeAfter}`,
    ).expect(200);
    expect(
      again.body.items.map((i: { deliveryId: string }) => i.deliveryId),
    ).toEqual([reminder.deliveryId, expired.deliveryId]);

    await outcome(b, reminder.deliveryId, accepted()).expect(200);
    const afterAck = await recover(b).expect(200);
    expect(afterAck.body.saleUndeliveredResumeAfter).toBe(
      pad(expired.cursor - 1n),
    );
    await outcome(b, expired.deliveryId, accepted()).expect(200);
    expect(
      (await recover(b).expect(200)).body.saleUndeliveredResumeAfter,
    ).toBeNull();
  });

  it('the retention purge removes old sale items and raises the watermark (410)', async () => {
    const b = await bot();
    const s = await sale(b);
    await enqueue.reminder(b, s, 1);
    const [item] = await saleItems(b.tenantId);
    await prisma.chatbotFeedItem.update({
      where: { cursor: item.cursor },
      data: { createdAt: new Date('2001-01-01T00:00:00.000Z') },
    });

    await feedStore.purgeExpired(new Date());

    expect(await saleItems(b.tenantId)).toHaveLength(0);
    const watermark = await prisma.chatbotFeedRetention.findUniqueOrThrow({
      where: { tenantId: b.tenantId },
    });
    expect(watermark.purgedThroughCursor).toBe(item.cursor);
    const expired = await feed(b, `?waitSeconds=0&after=${pad(0)}`);
    // `after=0` is the start of the feed, retained by definition; one below
    // the watermark is not.
    expect(expired.status).toBe(200);
    if (item.cursor > 1n) {
      const gone = await feed(
        b,
        `?waitSeconds=0&after=${pad(item.cursor - 1n)}`,
      );
      expect(gone.status).toBe(410);
    }
  });

  it('tenant isolation: another branch neither reads nor ACKs the item, and cannot point at a foreign sale', async () => {
    const a = await bot();
    const other = await bot();
    const s = await sale(a);
    await enqueue.reminder(a, s, 1);
    const [item] = await saleItems(a.tenantId);

    expect((await feed(other).expect(200)).body.items).toEqual([]);
    const foreign = await outcome(other, item.deliveryId, accepted());
    expect(foreign.status).toBe(404);

    // The sale FK is (tenantId, saleId): the item's tenant must own the sale.
    await expect(enqueue.expired(other, s, 1)).rejects.toThrow();
    expect(await saleItems(other.tenantId)).toHaveLength(0);
  });

  it('the CHECK refuses an item with both or neither requestId and saleId', async () => {
    const b = await bot();
    const s = await sale(b);
    const req = await openRequest(b, 'wa:5215598762222');
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "chatbot_feed_items" ("tenantId", "type", "payload")
         VALUES ($1, 'sale.pickup_reminder', '{}'::jsonb)`,
        b.tenantId,
      ),
    ).rejects.toThrow(/chatbot_feed_items_subject_chk/);
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "chatbot_feed_items" ("tenantId", "requestId", "saleId", "type", "payload")
         VALUES ($1, $2, $3, 'sale.pickup_reminder', '{}'::jsonb)`,
        b.tenantId,
        req.id,
        s.id,
      ),
    ).rejects.toThrow(/chatbot_feed_items_subject_chk/);
  });
});
