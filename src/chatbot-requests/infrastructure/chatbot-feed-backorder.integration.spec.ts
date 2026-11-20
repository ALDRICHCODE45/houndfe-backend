/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- supertest response bodies are untyped JSON */
/**
 * restock-backorder / T2b (contract v1 §4, §10) — the backorder-level items of
 * the bot feed against REAL PostgreSQL: `backorder.*` items (`requestId` and
 * `saleId` NULL, `backorderId` set).
 *   - the real feed serves them (envelope, payload, customer chat); request and
 *     sale items keep their exact envelope;
 *   - the ACK accepts sent / unknown / stale / PROVIDER_REJECTED once, refuses
 *     both deferrals (422 OUTCOME_NOT_ALLOWED), and PROVIDER_REJECTED on any
 *     other item is a 422 with nothing written;
 *   - PROVIDER_REJECTED of `backorder.reserved` / `backorder.reservation_reminder`
 *     creates ONE staff notice (the real notify consumer turns it into in-app
 *     notifications for `read:Backorder` holders, with the backorderId);
 *   - exactly once per (backorder, type, version); the widened subject CHECK,
 *     the tenant-consistent FK, the cascade;
 *   - recovery: the oldest unacknowledged backorder item's feed position.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { createHash, randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsModule, ClsService } from 'nestjs-cls';
import request from 'supertest';
import { integrationPrisma } from '../../../test/integration/reset-db';
import {
  enqueueBackorderCancelledByStaff,
  enqueueBackorderEtaUnavailable,
  enqueueBackorderEtaUpdated,
  enqueueBackorderReservationExpired,
  enqueueBackorderReservationLost,
  enqueueBackorderReservationReminder,
  enqueueBackorderReserved,
} from '../../backorders/infrastructure/backorder-feed-writes';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../../chatbot-api/domain/service-credential.repository';
import { PrismaServiceCredentialRepository } from '../../chatbot-api/infrastructure/prisma-service-credential.repository';
import { BotRateLimitModule } from '../../chatbot-api/presentation/guards/bot-rate-limit.module';
import { ServiceAuthGuard } from '../../chatbot-api/presentation/guards/service-auth.guard';
import type { NotificationEventsPort } from '../../notifications/domain/notification-events.port';
import { ChatbotRequestNotifyConsumer } from '../../notifications/outbox/chatbot-request-notify.consumer';
import { DatabaseModule } from '../../shared/prisma/prisma.module';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { RealtimeModule } from '../../shared/realtime/realtime.module';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import {
  CHATBOT_FEED_STORE,
  ChatbotFeedService,
  FEED_CLOCK,
  FEED_WAKEUP,
} from '../application/chatbot-feed.service';
import {
  CHATBOT_RECOVERY_STORE,
  ChatbotRecoveryService,
} from '../application/chatbot-recovery.service';
import { BotFeedController } from '../presentation/bot-feed.controller';
import { BotRecoveryController } from '../presentation/bot-recovery.controller';
import { ChatbotRequestHttpFilter } from '../presentation/chatbot-request-http.filter';
import { PgFeedWakeup } from './feed-wakeup';
import { PrismaChatbotFeedStore } from './prisma-chatbot-feed.store';
import { PrismaChatbotRecoveryStore } from './prisma-chatbot-recovery.store';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

const AT = '2026-11-21T16:20:00.000Z';
const pad = (cursor: bigint | number) => String(cursor).padStart(12, '0');

describeIfDb('backorder-level feed items (PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const cls = new ClsService<TenantClsStore>(
    new AsyncLocalStorage<TenantClsStore>(),
  );
  const tenantPrisma = new TenantPrismaService(
    prisma as unknown as ConstructorParameters<typeof TenantPrismaService>[0],
    cls,
  );
  const recoveryStore = new PrismaChatbotRecoveryStore(tenantPrisma);
  const feedStore = new PrismaChatbotFeedStore(
    tenantPrisma,
    prisma as unknown as PrismaService,
  );
  const noEvents: NotificationEventsPort = {
    publishCreated: () => Promise.resolve(),
  };
  const consumer = new ChatbotRequestNotifyConsumer(
    prisma as unknown as PrismaService,
    noEvents,
    () => new Date(),
    25,
    3,
  );
  let app: INestApplication;
  const tenants: string[] = [];
  const credentials: string[] = [];
  const users: string[] = [];

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
  });

  afterAll(async () => {
    await app.close();
    await prisma.serviceRateBucket.deleteMany({
      where: { credentialId: { in: credentials } },
    });
    await prisma.outboxEvent.deleteMany({
      where: { tenantId: { in: tenants } },
    });
    await prisma.backorder.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  });

  // -------------------------------------------------------------- helpers

  async function bot() {
    const id = randomUUID();
    tenants.push(id);
    await prisma.tenant.create({
      data: { id, name: 'Sucursal Reposición', slug: `bo-feed-${id}` },
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
  const recover = (b: Bot) =>
    auth(b, http().get('/chatbot-api/requests?status=open'));

  let seq = 0;
  /** A tenant's RESERVED backorder (a product, a customer and the RESTOCK decision behind it). */
  async function backorder(
    b: Bot,
    options: {
      status?: 'RESERVED' | 'WAITING' | 'EXPIRED' | 'CANCELLED';
      phone?: string;
    } = {},
  ) {
    const status = options.status ?? 'RESERVED';
    const n = ++seq;
    const productId = randomUUID();
    await prisma.product.create({
      data: {
        id: productId,
        tenantId: b.tenantId,
        name: 'Croquetas 18 kg',
        useStock: true,
      },
    });
    const customer = await prisma.customer.create({
      data: {
        tenantId: b.tenantId,
        firstName: 'Rosa',
        phoneCountryCode: '52',
        phone: options.phone ?? `55${String(20_000_000 + n)}`,
      },
    });
    const decision = await prisma.humanDecision.create({
      data: {
        tenantId: b.tenantId,
        source: 'houndfe-chatbot',
        sourceRequestId: randomUUID(),
        type: 'RESTOCK',
        canonicalRequestHash: 'h'.repeat(64),
        submittedCredentialId: 'cred',
        branchId: b.tenantId,
        branchName: 'Centro',
        productId,
        productName: 'Croquetas',
        variantId: null,
        status: 'RESOLVED',
        version: 2,
        resolutionAction: 'PROVIDE_RESTOCK_ESTIMATE',
        restockDays: 7,
        resolutionRequestId: randomUUID(),
        resolvedAt: new Date(),
        resolvedByActorId: 'actor',
        resolvedByDisplayName: 'Gerente',
      },
    });
    const now = Date.now();
    return prisma.backorder.create({
      data: {
        tenantId: b.tenantId,
        folio: `BO-${String(100_000 + n)}`,
        status,
        customerId: customer.id,
        productId,
        quantity: 2,
        referencePriceCents: 1500,
        scheduledAt: new Date(now - HOUR),
        estimatedArrivalDays: 7,
        estimatedAt: new Date(now + 7 * DAY),
        sourceDecisionId: decision.id,
        idempotencyKey: randomUUID(),
        requestHash: 'a'.repeat(64),
        ...(status === 'RESERVED'
          ? {
              reservedAt: new Date(now),
              reservedUntil: new Date(now + DAY),
              reminderAt: new Date(now + DAY - 3 * HOUR),
              currentPriceCents: 1000,
              finalPriceCents: 1000,
            }
          : {}),
        ...(status === 'EXPIRED' ? { expiredAt: new Date(now) } : {}),
        ...(status === 'CANCELLED'
          ? {
              cancelledAt: new Date(now),
              cancelledByKind: 'STAFF' as const,
              cancelReason: 'Sin stock',
            }
          : {}),
      },
      include: { customer: true },
    });
  }
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;

  const inTx = <T>(tenantId: string, work: () => Promise<T>) =>
    cls.runWith({ tenantId, userId: 'test', isSuperAdmin: false }, () =>
      tenantPrisma.runInTransaction(work),
    );
  const client = () => tenantPrisma.getClient();
  const enqueue = {
    reserved: (b: Bot, id: string) =>
      inTx(b.tenantId, () =>
        enqueueBackorderReserved(client(), b.tenantId, id),
      ),
    reminder: (b: Bot, id: string) =>
      inTx(b.tenantId, () =>
        enqueueBackorderReservationReminder(client(), b.tenantId, id),
      ),
    expired: (b: Bot, id: string) =>
      inTx(b.tenantId, () =>
        enqueueBackorderReservationExpired(client(), b.tenantId, id),
      ),
    cancelled: (b: Bot, id: string) =>
      inTx(b.tenantId, () =>
        enqueueBackorderCancelledByStaff(client(), b.tenantId, id),
      ),
    lost: (b: Bot, id: string) =>
      inTx(b.tenantId, () =>
        enqueueBackorderReservationLost(client(), b.tenantId, id),
      ),
    etaUpdated: (b: Bot, id: string) =>
      inTx(b.tenantId, () =>
        enqueueBackorderEtaUpdated(client(), b.tenantId, id),
      ),
    etaUnavailable: (b: Bot, id: string) =>
      inTx(b.tenantId, () =>
        enqueueBackorderEtaUnavailable(client(), b.tenantId, id),
      ),
  };

  const backorderItems = (tenantId: string, backorderId?: string) =>
    prisma.chatbotFeedItem.findMany({
      where: { tenantId, backorderId: backorderId ?? { not: null } },
      orderBy: { cursor: 'asc' },
    });
  const noticeRows = (tenantId: string, backorderId?: string) =>
    prisma.outboxEvent.findMany({
      where: {
        tenantId,
        aggregateType: 'Backorder',
        ...(backorderId ? { aggregateId: backorderId } : {}),
      },
    });

  const accepted = (attemptId = randomUUID()) => ({
    attemptId,
    outcome: 'PROVIDER_ACCEPTED',
    providerMessageId: `wamid.${attemptId}`,
    attemptedAt: AT,
  });
  const rejected = (
    reason = 'TEMPLATE_NOT_APPROVED',
    attemptId = randomUUID(),
  ) => ({
    attemptId,
    outcome: 'PROVIDER_REJECTED',
    attemptedAt: AT,
    reason,
  });

  /** A user of the tenant holding the given grants. */
  async function staff(
    tenantId: string,
    grants: Array<[string, string]>,
  ): Promise<string> {
    const id = randomUUID();
    users.push(id);
    await prisma.user.create({
      data: {
        id,
        email: `${id}@bo-feed.invalid`,
        name: 'Ana',
        hashedPassword: 'x',
        isActive: true,
      },
    });
    const role = await prisma.role.create({
      data: { tenantId, name: `Role ${id}` },
    });
    for (const [subject, action] of grants) {
      const permission = await prisma.permission.upsert({
        where: { subject_action: { subject, action } },
        update: {},
        create: { subject, action },
      });
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id },
      });
    }
    await prisma.tenantMembership.create({
      data: { tenantId, userId: id, roleId: role.id },
    });
    return id;
  }
  async function drain(): Promise<void> {
    for (let i = 0; i < 100 && (await consumer.processOne()); i++) {
      /* keep going */
    }
  }

  // ---------------------------------------------------------------- tests

  describe('serving', () => {
    it('serves a backorder item with the exact envelope: requestId null, no saleId key, the payload and the customer chat', async () => {
      const b = await bot();
      const bo = await backorder(b, { phone: '5512340001' });
      await prisma.chatbotConversation.create({
        data: {
          tenantId: b.tenantId,
          conversationRef: 'wa:525512340001',
          customerKey: '525512340001',
        },
      });
      expect(await enqueue.reserved(b, bo.id)).toBe(true);

      const res = await feed(b).expect(200);
      expect(res.body.items).toHaveLength(1);
      const [item] = res.body.items;
      expect(item).toEqual({
        cursor: expect.stringMatching(/^\d{12}$/),
        deliveryId: expect.any(String),
        type: 'backorder.reserved',
        requestId: null,
        conversationRef: 'wa:525512340001',
        payload: {
          backorderId: bo.id,
          folio: bo.folio,
          productName: 'Croquetas 18 kg',
          variantName: null,
          quantity: 2,
          branchName: 'Sucursal Reposición',
          customerFirstName: 'Rosa',
          version: bo.version,
          referencePriceCents: 1500,
          currentPriceCents: 1000,
          finalPriceCents: 1000,
          reservedUntil: bo.reservedUntil!.toISOString(),
          reminderAt: bo.reminderAt!.toISOString(),
        },
        notBefore: null,
        expiresAt: null,
      });
      expect(item).not.toHaveProperty('saleId');
      const [row] = await backorderItems(b.tenantId);
      expect(row).toMatchObject({
        requestId: null,
        saleId: null,
        backorderId: bo.id,
        ackedAt: null,
        outcome: null,
        outcomeReason: null,
      });
    });

    it('builds every contract §10 type from the row (reserved, reminder, expired, cancelled_by_staff, lost, eta_updated, eta_unavailable)', async () => {
      const b = await bot();
      const reserved = await backorder(b);
      const waiting = await backorder(b, { status: 'WAITING' });
      const expired = await backorder(b, { status: 'EXPIRED' });
      const cancelled = await backorder(b, { status: 'CANCELLED' });
      await enqueue.reserved(b, reserved.id);
      await enqueue.reminder(b, reserved.id);
      await enqueue.expired(b, expired.id);
      await enqueue.cancelled(b, cancelled.id);
      await enqueue.lost(b, waiting.id);
      await enqueue.etaUpdated(b, waiting.id);
      await enqueue.etaUnavailable(b, waiting.id);

      const items = (await feed(b).expect(200)).body.items as Array<{
        type: string;
        payload: Record<string, unknown>;
      }>;
      expect(items.map((item) => item.type)).toEqual([
        'backorder.reserved',
        'backorder.reservation_reminder',
        'backorder.reservation_expired',
        'backorder.cancelled_by_staff',
        'backorder.reservation_lost',
        'backorder.eta_updated',
        'backorder.eta_unavailable',
      ]);
      const by = (type: string) =>
        items.find((item) => item.type === type)!.payload;
      expect(by('backorder.reservation_reminder')).toMatchObject({
        reservedUntil: reserved.reservedUntil!.toISOString(),
      });
      expect(by('backorder.reservation_expired')).toMatchObject({
        expiredAt: expired.expiredAt!.toISOString(),
      });
      expect(by('backorder.cancelled_by_staff')).toMatchObject({
        reason: 'Sin stock',
      });
      expect(by('backorder.reservation_lost')).toMatchObject({
        reason: 'LOT_EXPIRED',
        queuePosition: 1,
        estimatedAt: waiting.estimatedAt.toISOString(),
      });
      expect(by('backorder.eta_updated')).toMatchObject({
        estimatedAt: waiting.estimatedAt.toISOString(),
        restockDays: 7,
      });
      expect(by('backorder.eta_unavailable')).not.toHaveProperty('estimatedAt');
    });

    it('queuePosition of reservation_lost counts the WAITING backorders ahead in its own queue', async () => {
      const b = await bot();
      const first = await backorder(b, { status: 'WAITING' });
      const second = await backorder(b, { status: 'WAITING' });
      // Same product/variant queue: move `second` onto first's product.
      await prisma.backorder.update({
        where: { id: second.id },
        data: { productId: first.productId, scheduledAt: new Date() },
      });
      await enqueue.lost(b, second.id);
      const [item] = await backorderItems(b.tenantId, second.id);
      expect((item.payload as Record<string, unknown>).queuePosition).toBe(2);
    });

    it('refuses an item of a backorder in the wrong state (nothing is written)', async () => {
      const b = await bot();
      const waiting = await backorder(b, { status: 'WAITING' });
      await expect(enqueue.reserved(b, waiting.id)).rejects.toThrow(
        'not reserved',
      );
      await expect(enqueue.expired(b, waiting.id)).rejects.toThrow(
        'not expired',
      );
      expect(await backorderItems(b.tenantId)).toEqual([]);
    });

    it('request and sale items keep their exact envelope next to backorder items', async () => {
      const b = await bot();
      const bo = await backorder(b);
      const req = await prisma.chatbotRequest.create({
        data: {
          tenantId: b.tenantId,
          folio: ++seq,
          kind: 'CLARIFICATION',
          subtype: 'UNKNOWN_QUESTION',
          customerKey: `5255${String(70_000_000 + seq)}`,
          conversationRef: 'wa:req',
          summary: 'Pregunta',
          source: 'chatbot',
          sourceRequestId: randomUUID(),
        },
      });
      const sale = await prisma.sale.create({
        data: {
          tenantId: b.tenantId,
          userId: await staff(b.tenantId, []),
          status: 'CONFIRMED',
          channel: 'ONLINE',
          fulfillmentMode: 'PICKUP',
          paymentStatus: 'CREDIT',
          totalCents: 100,
          debtCents: 100,
          folio: `V-${randomUUID().slice(0, 6)}`,
          paymentIntent: 'IN_STORE',
          holdExpiresAt: new Date(Date.now() + DAY),
          holdVersion: 1,
        },
      });
      await prisma.chatbotFeedItem.create({
        data: {
          tenantId: b.tenantId,
          requestId: req.id,
          type: 'request.answered',
          conversationRef: 'wa:req',
          payload: { kind: 'CLARIFICATION', text: 'Sí' },
        },
      });
      await prisma.chatbotFeedItem.create({
        data: {
          tenantId: b.tenantId,
          saleId: sale.id,
          type: 'sale.pickup_reminder',
          conversationRef: null,
          payload: { saleId: sale.id },
        },
      });
      await enqueue.reserved(b, bo.id);

      const items = (await feed(b).expect(200)).body.items as Array<
        Record<string, unknown>
      >;
      expect(items.map((item) => item.type)).toEqual([
        'request.answered',
        'sale.pickup_reminder',
        'backorder.reserved',
      ]);
      expect(Object.keys(items[0]).sort()).toEqual([
        'conversationRef',
        'cursor',
        'deliveryId',
        'expiresAt',
        'notBefore',
        'payload',
        'requestId',
        'type',
      ]);
      expect(items[1]).toMatchObject({ requestId: null, saleId: sale.id });
      expect(items[2]).not.toHaveProperty('saleId');
    });
  });

  describe('exactly once, subject CHECK, tenant FK, cascade', () => {
    it('one item per (backorder, type, version): a repeat is a no-op; a new version is a new item', async () => {
      const b = await bot();
      const bo = await backorder(b);
      expect(await enqueue.reserved(b, bo.id)).toBe(true);
      expect(await enqueue.reserved(b, bo.id)).toBe(false);
      expect(await enqueue.reserved(b, bo.id)).toBe(false);
      expect(await backorderItems(b.tenantId, bo.id)).toHaveLength(1);

      // Another reservation of the same backorder (version moved) is a new item.
      await prisma.backorder.update({
        where: { id: bo.id },
        data: { version: { increment: 1 } },
      });
      expect(await enqueue.reserved(b, bo.id)).toBe(true);
      expect(await backorderItems(b.tenantId, bo.id)).toHaveLength(2);
      // A different type at the same version is independent.
      expect(await enqueue.reminder(b, bo.id)).toBe(true);
    });

    it('concurrent enqueues of the same item produce one', async () => {
      const b = await bot();
      const bo = await backorder(b);
      const results = await Promise.all(
        [1, 2, 3, 4].map(() => enqueue.reserved(b, bo.id)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await backorderItems(b.tenantId, bo.id)).toHaveLength(1);
    });

    it('the database refuses an item with no subject, with two subjects, or another tenant’s backorder', async () => {
      const b = await bot();
      const other = await bot();
      const bo = await backorder(b);
      const otherBo = await backorder(other);
      const base = {
        tenantId: b.tenantId,
        type: 'backorder.reserved',
        payload: {},
      };
      await expect(
        prisma.chatbotFeedItem.create({ data: base }),
      ).rejects.toThrow(/subject_chk/);
      const req = await prisma.chatbotRequest.create({
        data: {
          tenantId: b.tenantId,
          folio: ++seq,
          kind: 'CLARIFICATION',
          subtype: 'UNKNOWN_QUESTION',
          customerKey: `5255${String(70_000_000 + seq)}`,
          conversationRef: 'wa:x',
          summary: 'x',
          source: 'chatbot',
          sourceRequestId: randomUUID(),
        },
      });
      await expect(
        prisma.chatbotFeedItem.create({
          data: { ...base, backorderId: bo.id, requestId: req.id },
        }),
      ).rejects.toThrow(/subject_chk/);
      await expect(
        prisma.chatbotFeedItem.create({
          data: { ...base, backorderId: otherBo.id },
        }),
      ).rejects.toThrow(/tenantId_backorderId_fkey|Foreign key/i);
    });

    it('a reason exists only with PROVIDER_REJECTED (CHECK)', async () => {
      const b = await bot();
      const bo = await backorder(b);
      await expect(
        prisma.chatbotFeedItem.create({
          data: {
            tenantId: b.tenantId,
            backorderId: bo.id,
            type: 'backorder.reserved',
            payload: {},
            outcome: 'PROVIDER_ACCEPTED',
            attemptId: randomUUID(),
            evidenceHash: 'h'.repeat(64),
            ackedAt: new Date(),
            outcomeReason: 'x',
          },
        }),
      ).rejects.toThrow(/outcome_reason_chk/);
    });

    it('deleting the backorder deletes its items (cascade)', async () => {
      const b = await bot();
      const bo = await backorder(b, { status: 'EXPIRED' });
      await enqueue.expired(b, bo.id);
      expect(await backorderItems(b.tenantId, bo.id)).toHaveLength(1);
      await prisma.backorder.delete({ where: { id: bo.id } });
      expect(await backorderItems(b.tenantId, bo.id)).toEqual([]);
    });
  });

  describe('ACK', () => {
    const types = [
      ['backorder.reserved', 'reserved'],
      ['backorder.reservation_reminder', 'reminder'],
    ] as const;

    it.each(['PROVIDER_ACCEPTED', 'DELIVERY_UNKNOWN', 'STALE'])(
      'accepts %s once and writes no request audit event',
      async (name) => {
        const b = await bot();
        const bo = await backorder(b);
        await enqueue.reserved(b, bo.id);
        const [item] = (await feed(b).expect(200)).body.items;
        const body =
          name === 'PROVIDER_ACCEPTED'
            ? accepted()
            : name === 'STALE'
              ? { attemptId: randomUUID(), outcome: 'STALE' }
              : { attemptId: randomUUID(), outcome: name, attemptedAt: AT };

        const res = await outcome(b, item.deliveryId, body).expect(200);

        expect(res.body).toEqual({
          deliveryId: item.deliveryId,
          outcome: name,
          attemptId: body.attemptId,
          ackReceivedAt: expect.any(String),
        });
        const [row] = await backorderItems(b.tenantId);
        expect(row).toMatchObject({
          outcome: name,
          attemptId: body.attemptId,
          outcomeReason: null,
        });
        expect(row.ackedAt).not.toBeNull();
        expect(
          await prisma.chatbotRequestEvent.count({
            where: { tenantId: b.tenantId },
          }),
        ).toBe(0);
        // A staff notice only for a PROVIDER_REJECTED.
        expect(
          (await noticeRows(b.tenantId, bo.id)).filter(
            (row) =>
              (row.payload as Record<string, unknown>).type ===
              'BACKORDER_NOTICE_UNDELIVERED',
          ),
        ).toEqual([]);
      },
    );

    it.each(['DEFERRED_WINDOW_CLOSED', 'DEFERRED_HUMAN_SESSION'])(
      'refuses %s with 422 OUTCOME_NOT_ALLOWED and writes nothing',
      async (name) => {
        const b = await bot();
        const bo = await backorder(b);
        await enqueue.reserved(b, bo.id);
        const [item] = (await feed(b).expect(200)).body.items;
        const res = await outcome(b, item.deliveryId, {
          attemptId: randomUUID(),
          outcome: name,
          attemptedAt: AT,
        });
        expect(res.status).toBe(422);
        expect(res.body.error ?? res.body.code).toBe('OUTCOME_NOT_ALLOWED');
        const [row] = await backorderItems(b.tenantId);
        expect(row).toMatchObject({
          outcome: null,
          attemptId: null,
          ackedAt: null,
        });
      },
    );

    it('one terminal ACK: the same attempt replays, another attempt is 409, same attempt other evidence is 409', async () => {
      const b = await bot();
      const bo = await backorder(b);
      await enqueue.reserved(b, bo.id);
      const [item] = (await feed(b).expect(200)).body.items;
      const body = rejected();
      const first = await outcome(b, item.deliveryId, body).expect(200);
      const replay = await outcome(b, item.deliveryId, body).expect(200);
      expect(replay.body).toEqual(first.body);
      const other = await outcome(b, item.deliveryId, accepted());
      expect(other.status).toBe(409);
      expect(other.body.error ?? other.body.code).toBe(
        'OUTCOME_ALREADY_RECORDED',
      );
      const conflict = await outcome(
        b,
        item.deliveryId,
        rejected('ANOTHER_REASON', body.attemptId),
      );
      expect(conflict.status).toBe(409);
      expect(conflict.body.error ?? conflict.body.code).toBe(
        'IDEMPOTENCY_CONFLICT',
      );
      // The replay did not create a second staff notice.
      expect(
        (await noticeRows(b.tenantId, bo.id)).filter(
          (row) =>
            (row.payload as Record<string, unknown>).type ===
            'BACKORDER_NOTICE_UNDELIVERED',
        ),
      ).toHaveLength(1);
    });

    describe.each(types)('PROVIDER_REJECTED of %s', (type, kind) => {
      it('is terminal, stores the reason and creates ONE staff notice with the backorderId', async () => {
        const b = await bot();
        const bo = await backorder(b);
        await enqueue[kind](b, bo.id);
        const [item] = (await feed(b).expect(200)).body.items;
        expect(item.type).toBe(type);
        const body = rejected('UNREACHABLE');

        const res = await outcome(b, item.deliveryId, body).expect(200);

        expect(res.body).toEqual({
          deliveryId: item.deliveryId,
          outcome: 'PROVIDER_REJECTED',
          attemptId: body.attemptId,
          ackReceivedAt: expect.any(String),
        });
        const [row] = await backorderItems(b.tenantId);
        expect(row).toMatchObject({
          outcome: 'PROVIDER_REJECTED',
          outcomeReason: 'UNREACHABLE',
          providerMessageId: null,
        });
        expect(row.ackedAt).not.toBeNull();
        const undelivered = (await noticeRows(b.tenantId, bo.id)).filter(
          (event) =>
            (event.payload as Record<string, unknown>).type ===
            'BACKORDER_NOTICE_UNDELIVERED',
        );
        expect(undelivered).toHaveLength(1);
        expect(undelivered[0].payload).toEqual({
          type: 'BACKORDER_NOTICE_UNDELIVERED',
          backorderId: bo.id,
          folio: bo.folio,
          productName: 'Croquetas 18 kg',
          variantName: null,
          quantity: 2,
          feedType: type,
          reason: 'UNREACHABLE',
          dedupKey: `backorder-undelivered:${item.deliveryId}`,
        });
      });
    });

    it.each([
      ['backorder.reservation_expired', 'expired', 'EXPIRED'],
      ['backorder.cancelled_by_staff', 'cancelled', 'CANCELLED'],
      ['backorder.reservation_lost', 'lost', 'WAITING'],
      ['backorder.eta_updated', 'etaUpdated', 'WAITING'],
      ['backorder.eta_unavailable', 'etaUnavailable', 'WAITING'],
    ] as const)(
      'PROVIDER_REJECTED of %s is just recorded: no staff notice',
      async (type, kind, status) => {
        const b = await bot();
        const bo = await backorder(b, { status });
        await enqueue[kind](b, bo.id);
        const [item] = (await feed(b).expect(200)).body.items;
        expect(item.type).toBe(type);
        await outcome(b, item.deliveryId, rejected()).expect(200);
        const [row] = await backorderItems(b.tenantId);
        expect(row).toMatchObject({
          outcome: 'PROVIDER_REJECTED',
          outcomeReason: 'TEMPLATE_NOT_APPROVED',
        });
        expect(await noticeRows(b.tenantId, bo.id)).toEqual([]);
      },
    );

    it('PROVIDER_REJECTED on a request item or a sale item is 422 OUTCOME_NOT_ALLOWED and writes nothing', async () => {
      const b = await bot();
      const req = await prisma.chatbotRequest.create({
        data: {
          tenantId: b.tenantId,
          folio: ++seq,
          kind: 'CLARIFICATION',
          subtype: 'UNKNOWN_QUESTION',
          customerKey: `5255${String(70_000_000 + seq)}`,
          conversationRef: 'wa:req',
          summary: 'Pregunta',
          source: 'chatbot',
          sourceRequestId: randomUUID(),
        },
      });
      const requestItem = await prisma.chatbotFeedItem.create({
        data: {
          tenantId: b.tenantId,
          requestId: req.id,
          type: 'request.answered',
          conversationRef: 'wa:req',
          payload: { kind: 'CLARIFICATION', text: 'Sí' },
        },
      });
      const sale = await prisma.sale.create({
        data: {
          tenantId: b.tenantId,
          userId: await staff(b.tenantId, []),
          status: 'CONFIRMED',
          channel: 'ONLINE',
          fulfillmentMode: 'PICKUP',
          paymentStatus: 'CREDIT',
          totalCents: 100,
          debtCents: 100,
          folio: `V-${randomUUID().slice(0, 6)}`,
          paymentIntent: 'IN_STORE',
          holdExpiresAt: new Date(Date.now() + DAY),
          holdVersion: 1,
        },
      });
      const saleItem = await prisma.chatbotFeedItem.create({
        data: {
          tenantId: b.tenantId,
          saleId: sale.id,
          type: 'sale.pickup_expired',
          payload: { saleId: sale.id },
        },
      });
      for (const item of [requestItem, saleItem]) {
        const res = await outcome(b, item.deliveryId, rejected());
        expect(res.status).toBe(422);
        expect(res.body.error ?? res.body.code).toBe('OUTCOME_NOT_ALLOWED');
        const row = await prisma.chatbotFeedItem.findUniqueOrThrow({
          where: { cursor: item.cursor },
        });
        expect(row).toMatchObject({
          outcome: null,
          attemptId: null,
          ackedAt: null,
        });
      }
      expect(
        await prisma.chatbotRequestEvent.count({
          where: { tenantId: b.tenantId },
        }),
      ).toBe(0);
      expect(await noticeRows(b.tenantId)).toEqual([]);
    });

    it('existing outcomes of request and sale items are unchanged (accepted on a sale item, deferred on a request item)', async () => {
      const b = await bot();
      const req = await prisma.chatbotRequest.create({
        data: {
          tenantId: b.tenantId,
          folio: ++seq,
          kind: 'CLARIFICATION',
          subtype: 'UNKNOWN_QUESTION',
          customerKey: `5255${String(70_000_000 + seq)}`,
          conversationRef: 'wa:req',
          summary: 'Pregunta',
          source: 'chatbot',
          sourceRequestId: randomUUID(),
        },
      });
      const requestItem = await prisma.chatbotFeedItem.create({
        data: {
          tenantId: b.tenantId,
          requestId: req.id,
          type: 'request.answered',
          conversationRef: 'wa:req',
          payload: { kind: 'CLARIFICATION', text: 'Sí' },
        },
      });
      const deferred = {
        attemptId: randomUUID(),
        outcome: 'DEFERRED_WINDOW_CLOSED',
        attemptedAt: AT,
      };
      const res = await outcome(b, requestItem.deliveryId, deferred).expect(
        200,
      );
      expect(res.body).toMatchObject({
        outcome: 'DEFERRED_WINDOW_CLOSED',
        ackReceivedAt: null,
      });
      const events = await prisma.chatbotRequestEvent.findMany({
        where: { tenantId: b.tenantId, requestId: req.id },
      });
      expect(events.map((event) => event.type)).toEqual(['DELIVERY_OUTCOME']);
      // And the ACK body validation of PROVIDER_REJECTED:
      await outcome(b, requestItem.deliveryId, {
        ...rejected(),
        reason: undefined,
      }).expect(400);
    });

    it.each([
      ['no reason', { reason: undefined }],
      ['an empty reason', { reason: '   ' }],
      ['a 281-character reason', { reason: 'x'.repeat(281) }],
      ['a providerMessageId', { providerMessageId: 'wamid.1' }],
    ])(
      '400 INVALID_FEED_REQUEST for PROVIDER_REJECTED with %s',
      async (_n, patch) => {
        const b = await bot();
        const bo = await backorder(b);
        await enqueue.reserved(b, bo.id);
        const [item] = (await feed(b).expect(200)).body.items;
        const res = await outcome(b, item.deliveryId, {
          ...rejected(),
          ...patch,
        });
        expect(res.status).toBe(400);
        const [row] = await backorderItems(b.tenantId);
        expect(row.outcome).toBeNull();
      },
    );

    it('a reason on any other outcome is 400', async () => {
      const b = await bot();
      const bo = await backorder(b);
      await enqueue.reserved(b, bo.id);
      const [item] = (await feed(b).expect(200)).body.items;
      await outcome(b, item.deliveryId, { ...accepted(), reason: 'x' }).expect(
        400,
      );
    });

    it('the 280-character limit holds in the database too', async () => {
      const b = await bot();
      const bo = await backorder(b);
      await enqueue.reserved(b, bo.id);
      const [item] = (await feed(b).expect(200)).body.items;
      const reason = 'é'.repeat(280);
      await outcome(b, item.deliveryId, rejected(reason)).expect(200);
      const [row] = await backorderItems(b.tenantId);
      expect(row.outcomeReason).toBe(reason);
    });
  });

  describe('staff notice (the real notify consumer)', () => {
    it('reaches every member with read:Backorder, not the ones without, with the backorderId and folio', async () => {
      const b = await bot();
      const bo = await backorder(b);
      const reader = await staff(b.tenantId, [['Backorder', 'read']]);
      const manager = await staff(b.tenantId, [['all', 'manage']]);
      const other = await staff(b.tenantId, [['Sale', 'read']]);
      await enqueue.reserved(b, bo.id);
      const [item] = (await feed(b).expect(200)).body.items;
      await outcome(b, item.deliveryId, rejected()).expect(200);

      await drain();

      const rows = await prisma.notification.findMany({
        where: { tenantId: b.tenantId, type: 'BACKORDER_NOTICE_UNDELIVERED' },
      });
      expect(rows.map((row) => row.userId).sort()).toEqual(
        [reader, manager].sort(),
      );
      expect(rows.map((row) => row.userId)).not.toContain(other);
      for (const row of rows) {
        expect(row.requestId).toBeNull();
        expect(row.payload).toEqual({
          backorderId: bo.id,
          folio: bo.folio,
          productName: 'Croquetas 18 kg',
          variantName: null,
          quantity: 2,
          feedType: 'backorder.reserved',
          reason: 'TEMPLATE_NOT_APPROVED',
        });
      }
      // Draining again changes nothing (idempotent per dedupKey, row PUBLISHED).
      await drain();
      expect(
        await prisma.notification.count({
          where: { tenantId: b.tenantId, type: 'BACKORDER_NOTICE_UNDELIVERED' },
        }),
      ).toBe(2);
    });

    it('reserved and expired staff notices are delivered too', async () => {
      const b = await bot();
      const reader = await staff(b.tenantId, [['Backorder', 'read']]);
      const bo = await backorder(b);
      const gone = await backorder(b, { status: 'EXPIRED' });
      // The notices are written by the allocator and the sweep (their own specs);
      // here only the consumer's side is proven, with the production writers.
      const { enqueueBackorderExpiredNotice, enqueueBackorderReservedNotice } =
        await import('../../notifications/infrastructure/backorder-notice.writer');
      await inTx(b.tenantId, async () => {
        await enqueueBackorderReservedNotice(client(), b.tenantId, {
          id: bo.id,
          folio: bo.folio,
          productName: 'Croquetas 18 kg',
          variantName: null,
          quantity: 2,
          version: bo.version,
        });
        await enqueueBackorderExpiredNotice(client(), b.tenantId, {
          id: gone.id,
          folio: gone.folio,
          productName: 'Croquetas 18 kg',
          variantName: null,
          quantity: 2,
        });
      });
      await drain();
      const rows = await prisma.notification.findMany({
        where: { tenantId: b.tenantId, userId: reader },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows.map((row) => row.type).sort()).toEqual([
        'BACKORDER_EXPIRED',
        'BACKORDER_RESERVED',
      ]);
    });
  });

  describe('recovery and pending-deliveries', () => {
    it('backorderResumeAfter: the oldest unacknowledged backorder item minus one; null when none; ACKed ones are skipped', async () => {
      const b = await bot();
      const other = await bot();
      const run = <T>(tenantId: string, work: () => Promise<T>) =>
        cls.runWith({ tenantId, userId: 'test', isSuperAdmin: false }, work);
      expect(
        await run(b.tenantId, () => recoveryStore.backorderResumeAfter()),
      ).toBeNull();

      const first = await backorder(b);
      const second = await backorder(b);
      await enqueue.reserved(b, first.id);
      await enqueue.reserved(b, second.id);
      await enqueue.reserved(other, (await backorder(other)).id);
      const items = await backorderItems(b.tenantId);
      expect(
        await run(b.tenantId, () => recoveryStore.backorderResumeAfter()),
      ).toBe(items[0].cursor - 1n);

      // ACK the oldest: the pointer moves to the next one.
      const feedItems = (await feed(b).expect(200)).body.items;
      await outcome(b, feedItems[0].deliveryId, accepted()).expect(200);
      expect(
        await run(b.tenantId, () => recoveryStore.backorderResumeAfter()),
      ).toBe(items[1].cursor - 1n);
      await outcome(b, feedItems[1].deliveryId, rejected()).expect(200);
      expect(
        await run(b.tenantId, () => recoveryStore.backorderResumeAfter()),
      ).toBeNull();
      // Another tenant's pending item is invisible here, and ours to them.
      expect(
        await run(other.tenantId, () => recoveryStore.backorderResumeAfter()),
      ).not.toBeNull();
    });

    it('never answers below the retention watermark', async () => {
      const b = await bot();
      const bo = await backorder(b);
      await enqueue.reserved(b, bo.id);
      const [row] = await backorderItems(b.tenantId);
      await prisma.chatbotFeedRetention.create({
        data: { tenantId: b.tenantId, purgedThroughCursor: row.cursor + 5n },
      });
      const after = await cls.runWith(
        { tenantId: b.tenantId, userId: 'test', isSuperAdmin: false },
        () => recoveryStore.backorderResumeAfter(),
      );
      expect(after).toBe(row.cursor + 5n);
      // That position can be read from the feed (never 410).
      await feed(b, `?waitSeconds=0&after=${pad(after as bigint)}`).expect(200);
    });

    it('re-serving from the pointer returns the unacknowledged backorder item', async () => {
      const b = await bot();
      const bo = await backorder(b);
      await enqueue.reserved(b, bo.id);
      const [row] = await backorderItems(b.tenantId);
      const res = await feed(
        b,
        `?waitSeconds=0&after=${pad(row.cursor - 1n)}`,
      ).expect(200);
      const served = res.body.items as Array<{ deliveryId: string }>;
      expect(served.map((item) => item.deliveryId)).toEqual([row.deliveryId]);
    });

    it('the request recovery answer keeps its shape: backorder items belong to no request and add no member', async () => {
      const b = await bot();
      await enqueue.reserved(b, (await backorder(b)).id);
      const res = await recover(b).expect(200);
      expect(Object.keys(res.body).sort()).toEqual([
        'items',
        'nextCursor',
        'nextPage',
        'saleUndeliveredResumeAfter',
      ]);
      expect(res.body.items).toEqual([]);
      expect(res.body.saleUndeliveredResumeAfter).toBeNull();
    });

    it('a backorder item is never a pending (deferred) delivery', async () => {
      const b = await bot();
      const bo = await backorder(b, { phone: '5512340099' });
      await prisma.chatbotConversation.create({
        data: {
          tenantId: b.tenantId,
          conversationRef: 'wa:525512340099',
          customerKey: '525512340099',
        },
      });
      await enqueue.reserved(b, bo.id);
      const res = await auth(
        b,
        http().get(
          '/chatbot-api/requests/pending-deliveries?conversationRef=wa%3A525512340099',
        ),
      ).expect(200);
      expect(res.body.items).toEqual([]);
    });

    it('the retention purge removes old backorder items and raises the watermark like any item', async () => {
      const b = await bot();
      const bo = await backorder(b);
      await enqueue.reserved(b, bo.id);
      await prisma.chatbotFeedItem.updateMany({
        where: { tenantId: b.tenantId, backorderId: bo.id },
        data: { createdAt: new Date(Date.now() - 40 * DAY) },
      });
      const [row] = await backorderItems(b.tenantId);
      await feedStore.purgeExpired(new Date());
      expect(await backorderItems(b.tenantId)).toEqual([]);
      const retention = await prisma.chatbotFeedRetention.findUniqueOrThrow({
        where: { tenantId: b.tenantId },
      });
      expect(retention.purgedThroughCursor).toBeGreaterThanOrEqual(row.cursor);
    });
  });
});
