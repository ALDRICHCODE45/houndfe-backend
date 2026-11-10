/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- supertest response bodies are untyped JSON */
/**
 * human-intervention / unit 5, slice 5b — the bot feed against REAL
 * PostgreSQL (contract §3.3, §3.9, §4.5, §12.14; R2, R7; performance row
 * "Feed del bot"):
 *   - the enqueue is part of the transaction of the state change (rollback
 *     leaves nothing) and cursor order is commit order for a tenant;
 *   - staff resolve, staff cancel, the zone fan-out (one item per customer)
 *     and the legacy resolve routes all feed the bot (S4: one state);
 *   - the long-poll wakes on NOTIFY, times out empty, holds no pool
 *     connection while it waits (the Prisma pool of this app has ONE
 *     connection), is capped at 2 per credential, survives a killed LISTEN
 *     connection;
 *   - the delivery outcome is idempotent, tenant-scoped and keeps a deferred
 *     delivery pending for `pending-deliveries`; retention answers 410.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { createHash, randomUUID } from 'crypto';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { ClsModule, ClsService } from 'nestjs-cls';
import request from 'supertest';
import { integrationPrisma } from '../../test/integration/reset-db';
import type {
  AppAbility,
  AppActions,
  AppSubjects,
} from '../auth/authorization/domain/permission';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../chatbot-api/domain/service-credential.repository';
import { PrismaServiceCredentialRepository } from '../chatbot-api/infrastructure/prisma-service-credential.repository';
import { BotRateLimitModule } from '../chatbot-api/presentation/guards/bot-rate-limit.module';
import { ServiceAuthGuard } from '../chatbot-api/presentation/guards/service-auth.guard';
import { DELIVERY_ZONE_TYPE } from '../delivery-zones/domain/delivery-zone-intake.request';
import { APPROVE_DELIVERY_ZONE } from '../delivery-zones/domain/delivery-zone-validation.repository';
import { PrismaDeliveryZoneBotRepository } from '../delivery-zones/infrastructure/prisma-delivery-zone-bot.repository';
import { PrismaDeliveryZoneValidationRepository } from '../delivery-zones/infrastructure/prisma-delivery-zone-validation.repository';
import { PrismaHumanDecisionReviewResolveRepository } from '../human-decisions/infrastructure/prisma-human-decision-review-resolve.repository';
import { PrismaRestockIntakeRepository } from '../human-decisions/infrastructure/prisma-restock-intake.repository';
import { ReceiptUploadService } from '../receipts/application/receipt-upload.service';
import { PrismaReceiptReviewRepository } from '../sales/review/infrastructure/prisma-receipt-review.repository';
import { ReceiptReviewService } from '../sales/review/receipt-review.service';
import type { ISaleRepository } from '../sales/domain/sale.repository';
import type { SalesService } from '../sales/sales.service';
import { OutboxWriterService } from '../shared/outbox/outbox-writer.service';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { PrismaService } from '../shared/prisma/prisma.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { PgNotificationListener } from '../shared/realtime/pg-notification-listener';
import { RealtimeModule } from '../shared/realtime/realtime.module';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import {
  CHATBOT_FEED_STORE,
  ChatbotFeedService,
  FEED_CLOCK,
  FEED_WAKEUP,
} from './application/chatbot-feed.service';
import {
  ChatbotRequestCommandsService,
  type ResolveAction,
} from './application/chatbot-request-commands.service';
import { canResolveSubtype } from './domain/resolve-permissions';
import { ChatbotRequestWrapper } from './infrastructure/chatbot-request-wrapper';
import {
  allocateFolio,
  refreshCustomerGroup,
} from './infrastructure/chatbot-request-writes';
import { PgFeedWakeup } from './infrastructure/feed-wakeup';
import { PrismaChatbotFeedStore } from './infrastructure/prisma-chatbot-feed.store';
import { PrismaChatbotRequestCommandStore } from './infrastructure/prisma-chatbot-request-command.store';
import { WrappedRequestResolver } from './infrastructure/wrapped-request-resolver';
import { BotFeedController } from './presentation/bot-feed.controller';
import { ChatbotRequestHttpFilter } from './presentation/chatbot-request-http.filter';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

const ATTEMPT = () => randomUUID();
const AT = '2026-11-10T16:20:00.000Z';

describeIfDb('chatbot feed (PostgreSQL)', () => {
  const prisma = integrationPrisma();
  // Staff side: the command service on its own CLS, like the other specs.
  const cls = new ClsService<TenantClsStore>(
    new AsyncLocalStorage<TenantClsStore>(),
  );
  const tenantPrisma = new TenantPrismaService(
    prisma as unknown as ConstructorParameters<typeof TenantPrismaService>[0],
    cls,
  );
  const wrapper = new ChatbotRequestWrapper(tenantPrisma);
  const restockIntake = new PrismaRestockIntakeRepository(
    tenantPrisma,
    wrapper,
  );
  const zoneBot = new PrismaDeliveryZoneBotRepository(tenantPrisma, wrapper);
  const decisions = new PrismaHumanDecisionReviewResolveRepository(
    tenantPrisma,
    undefined,
    wrapper,
  );
  const validations = new PrismaDeliveryZoneValidationRepository(
    tenantPrisma,
    wrapper,
  );
  const salesService = {
    addPayment: async (
      saleId: string,
      _actor: string,
      dto: { amountCents: number },
    ) => {
      const db = tenantPrisma.getClient();
      await db.$queryRaw(
        Prisma.sql`SELECT "id" FROM "sales" WHERE "id" = ${saleId} FOR UPDATE`,
      );
      const sale = await db.sale.update({
        where: { id: saleId },
        data: {
          paidCents: { increment: dto.amountCents },
          debtCents: { decrement: dto.amountCents },
          paymentStatus: 'PAID',
        },
        select: { totalCents: true, paidCents: true, debtCents: true },
      });
      return { saleId, ...sale, paymentStatus: 'PAID', paymentIds: [] };
    },
  } as unknown as SalesService;
  const receipts = new ReceiptReviewService(
    new PrismaReceiptReviewRepository(tenantPrisma),
    salesService,
    {
      runInTransaction: <T>(work: () => Promise<T>) =>
        tenantPrisma.runInTransaction(work),
    } as unknown as ISaleRepository,
    tenantPrisma,
    new OutboxWriterService(),
    wrapper,
  );
  const receiptUpload = new ReceiptUploadService(
    tenantPrisma,
    {} as never,
    {} as never,
    {
      find: () => Promise.resolve({ enabled: false, enabledActions: [] }),
    } as never,
    new OutboxWriterService(),
    wrapper,
  );
  const staff = new ChatbotRequestCommandsService(
    new PrismaChatbotRequestCommandStore(tenantPrisma),
    new WrappedRequestResolver(
      decisions,
      validations,
      receipts,
      wrapper,
      tenantPrisma,
    ),
  );
  const feedStore = new PrismaChatbotFeedStore(
    tenantPrisma,
    prisma as unknown as PrismaService,
  );

  // Bot side: a real Nest app whose Prisma pool has ONE connection.
  let app: INestApplication;
  let limitedPrisma: PrismaClient;
  const users = { ana: randomUUID(), rev: randomUUID() };
  const tenants: string[] = [];
  const credentials: string[] = [];

  const inTenant = <T>(tenantId: string, work: () => Promise<T>) =>
    cls.runWith({ tenantId, userId: 'test', isSuperAdmin: false }, work);

  beforeAll(async () => {
    const base = process.env.DATABASE_URL as string;
    limitedPrisma = new PrismaClient({
      datasources: {
        db: {
          url: `${base}${base.includes('?') ? '&' : '?'}connection_limit=1&pool_timeout=10`,
        },
      },
    });
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        DatabaseModule,
        BotRateLimitModule,
        RealtimeModule,
      ],
      controllers: [BotFeedController],
      providers: [
        ServiceAuthGuard,
        ChatbotRequestHttpFilter,
        ChatbotFeedService,
        PgFeedWakeup,
        { provide: FEED_WAKEUP, useExisting: PgFeedWakeup },
        { provide: CHATBOT_FEED_STORE, useClass: PrismaChatbotFeedStore },
        { provide: FEED_CLOCK, useValue: Date.now },
        {
          provide: SERVICE_CREDENTIAL_REPOSITORY,
          useClass: PrismaServiceCredentialRepository,
        },
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(limitedPrisma)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    for (const [name, id] of Object.entries(users)) {
      await prisma.user.create({
        data: { id, email: `${id}@feed.test`, hashedPassword: 'x', name },
      });
    }
  });

  afterAll(async () => {
    await app.close();
    await limitedPrisma.$disconnect();
    await prisma.serviceRateBucket.deleteMany({
      where: { credentialId: { in: credentials } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.user.deleteMany({
      where: { id: { in: Object.values(users) } },
    });
  });

  // -------------------------------------------------------------- helpers

  async function bot(scopes = ['feed:read', 'feed:ack']) {
    const id = randomUUID();
    tenants.push(id);
    await prisma.tenant.create({
      data: { id, name: 'Sucursal Feed', slug: `cr-feed-${id}` },
    });
    const role = await prisma.role.create({
      data: { tenantId: id, name: `r-${id}` },
    });
    await prisma.tenantMembership.createMany({
      data: Object.values(users).map((userId) => ({
        userId,
        tenantId: id,
        roleId: role.id,
      })),
    });
    const token = `svc_${randomUUID()}`;
    const credential = await prisma.serviceCredential.create({
      data: {
        tenantId: id,
        name: 'bot',
        hashedKey: createHash('sha256').update(token).digest('hex'),
        scopes,
        rateLimit: 60,
      },
    });
    credentials.push(credential.id);
    return { tenantId: id, token, credentialId: credential.id };
  }
  type Bot = Awaited<ReturnType<typeof bot>>;

  const auth = (b: Bot, req: request.Test) =>
    req
      .set('Authorization', `Bearer ${b.token}`)
      .set('X-Branch-Id', b.tenantId);
  const feed = (b: Bot, query = '') =>
    auth(b, request(app.getHttpServer()).get(`/chatbot-api/feed${query}`));
  const outcome = (b: Bot, deliveryId: string, body: object) =>
    auth(
      b,
      request(app.getHttpServer()).post(
        `/chatbot-api/deliveries/${deliveryId}/outcome`,
      ),
    ).send(body);
  const pending = (b: Bot, ref: string) =>
    auth(
      b,
      request(app.getHttpServer()).get(
        `/chatbot-api/requests/pending-deliveries?conversationRef=${encodeURIComponent(ref)}`,
      ),
    );

  let seq = 0;
  /** An open clarification the staff can cancel (the way intake will create it). */
  function openRequest(
    tenantId: string,
    conversationRef = `wa:5215500${++seq}`,
  ) {
    const customerKey = `52550000${++seq}`;
    return inTenant(tenantId, () =>
      tenantPrisma.runInTransaction(async () => {
        const tx = tenantPrisma.getClient();
        const row = await tx.chatbotRequest.create({
          data: {
            tenantId,
            folio: await allocateFolio(tx, tenantId),
            kind: 'CLARIFICATION',
            subtype: 'UNKNOWN_QUESTION',
            customerKey,
            conversationRef,
            summary: '¿Sirve para cachorros?',
            source: 'chatbot',
            sourceRequestId: randomUUID(),
          },
        });
        await refreshCustomerGroup(tx, tenantId, customerKey);
        return row;
      }),
    );
  }

  const cancel = (tenantId: string, requestId: string, customerNote?: string) =>
    inTenant(tenantId, () =>
      staff.execute({
        requestId,
        actorUserId: users.ana,
        actorCanReassign: false,
        idempotencyKey: randomUUID(),
        expectedVersion: 1,
        command: { kind: 'cancel', reason: 'NOT_ACTIONABLE', customerNote },
      }),
    );

  const items = (tenantId: string) =>
    prisma.chatbotFeedItem.findMany({
      where: { tenantId },
      orderBy: { cursor: 'asc' },
    });

  const abilityOf = (grants: [AppActions, AppSubjects][]): AppAbility => {
    const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
    for (const [action, subject] of grants) can(action, subject);
    return build();
  };
  const ALL: [AppActions, AppSubjects][] = [
    ['update', 'HumanDecision'],
    ['validate', 'DeliveryZone'],
    ['update', 'ReceiptEvidence'],
  ];
  async function resolveNew(
    tenantId: string,
    requestId: string,
    action: ResolveAction,
  ) {
    const row = await prisma.chatbotRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    const ability = abilityOf(ALL);
    return inTenant(tenantId, () =>
      staff.execute({
        requestId,
        actorUserId: users.ana,
        actorCanReassign: false,
        actorCanResolveSubtype: (subtype) =>
          canResolveSubtype(ability, subtype),
        idempotencyKey: randomUUID(),
        expectedVersion: row.version,
        command: { kind: 'resolve', action },
      }),
    );
  }

  async function submitRestock(tenantId: string) {
    const result = await inTenant(tenantId, () =>
      restockIntake.submit({
        sourceRequestId: randomUUID(),
        productId: randomUUID(),
        productName: 'Croquetas 20 kg',
        submittedCredentialId: 'cred',
      }),
    );
    return result.request.id;
  }

  async function submitZone(tenantId: string, phone: string) {
    const sourceRequestId = randomUUID();
    const result = await inTenant(tenantId, () =>
      zoneBot.submit({
        submittedCredentialId: 'cred',
        request: {
          sourceRequestId,
          originalSourceRequestId: sourceRequestId,
          type: DELIVERY_ZONE_TYPE,
          zipCode: '64000',
          state: 'Nuevo León',
          municipality: 'Monterrey',
          neighborhood: 'Centro',
          phoneCountryCode: '52',
          phone,
          conversationRef: `wa:52${phone}`,
          lastCustomerMessageAt: new Date(),
        },
      }),
    );
    return result.record;
  }

  async function submitReceipt(tenantId: string) {
    const sale = await prisma.sale.create({
      data: {
        tenantId,
        userId: users.ana,
        customerId: null,
        folio: `V-${randomUUID().slice(0, 6)}`,
        status: 'CONFIRMED',
        channel: 'ONLINE',
        totalCents: 10_000,
        paidCents: 0,
        debtCents: 10_000,
        paymentStatus: 'CREDIT',
      },
    });
    const result = await inTenant(tenantId, () =>
      receiptUpload.attachLegacyUrl({
        saleId: sale.id,
        mediaUrl: 'https://example.test/comprobante.jpg',
        declaredAmountCents: 10_000,
        declaredDate: null,
        declaredReference: null,
      }),
    );
    return { saleId: sale.id, receiptId: result.receiptId };
  }

  /** `body.items[*][key]` of a feed answer (supertest bodies are untyped). */
  const pluck = (body: { items: unknown }, key: string): string[] =>
    (body.items as Record<string, string>[]).map((item) => item[key]);

  const tick = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  // ------------------------------------------------------------- enqueue

  describe('enqueue is part of the state change', () => {
    it('staff cancel enqueues request.cancelled with reason, customerNote and conversationRef (§12.14)', async () => {
      const b = await bot();
      const req = await openRequest(b.tenantId, 'wa:5215512345678');
      await cancel(b.tenantId, req.id, 'Lo vemos mañana');

      const [item] = await items(b.tenantId);
      expect(item).toMatchObject({
        type: 'request.cancelled',
        requestId: req.id,
        conversationRef: 'wa:5215512345678',
        ackedAt: null,
        outcome: null,
        payload: {
          requestId: req.id,
          reason: 'NOT_ACTIONABLE',
          cancelledBy: 'STAFF',
          customerNote: 'Lo vemos mañana',
        },
      });
      const read = await feed(b, '?waitSeconds=0').expect(200);
      expect(read.headers['cache-control']).toBe('no-store');
      expect(read.body.items).toEqual([
        {
          cursor: item.cursor.toString().padStart(12, '0'),
          deliveryId: item.deliveryId,
          type: 'request.cancelled',
          requestId: req.id,
          conversationRef: 'wa:5215512345678',
          payload: item.payload,
          notBefore: null,
          expiresAt: null,
        },
      ]);
      expect(read.body.nextCursor).toBe(read.body.items[0].cursor);
    });

    it('a rollback leaves no item, no request change and no wake-up', async () => {
      const b = await bot();
      const req = await openRequest(b.tenantId);
      await expect(
        inTenant(b.tenantId, () =>
          tenantPrisma.runInTransaction(async () => {
            await staff.execute({
              requestId: req.id,
              actorUserId: users.ana,
              actorCanReassign: false,
              idempotencyKey: randomUUID(),
              expectedVersion: 1,
              command: { kind: 'cancel', reason: 'DUPLICATE' },
            });
            throw new Error('boom');
          }),
        ),
      ).rejects.toThrow('boom');
      expect(await items(b.tenantId)).toEqual([]);
      expect(
        await prisma.chatbotRequest.findUniqueOrThrow({
          where: { id: req.id },
        }),
      ).toMatchObject({ status: 'NEW', version: 1 });
    });

    it('a rejected command (stale version) enqueues nothing', async () => {
      const b = await bot();
      const req = await openRequest(b.tenantId);
      await expect(
        inTenant(b.tenantId, () =>
          staff.execute({
            requestId: req.id,
            actorUserId: users.ana,
            actorCanReassign: false,
            idempotencyKey: randomUUID(),
            expectedVersion: 7,
            command: { kind: 'cancel', reason: 'DUPLICATE' },
          }),
        ),
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(await items(b.tenantId)).toEqual([]);
    });

    it('cursor order is commit order: a later enqueuer waits for an earlier open transaction', async () => {
      const b = await bot();
      const first = await openRequest(b.tenantId);
      const second = await openRequest(b.tenantId);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let firstEnqueued!: () => void;
      const enqueued = new Promise<void>(
        (resolve) => (firstEnqueued = resolve),
      );

      const slow = inTenant(b.tenantId, () =>
        tenantPrisma.runInTransaction(async () => {
          await staff.execute({
            requestId: first.id,
            actorUserId: users.ana,
            actorCanReassign: false,
            idempotencyKey: randomUUID(),
            expectedVersion: 1,
            command: { kind: 'cancel', reason: 'DUPLICATE' },
          });
          firstEnqueued();
          await gate;
        }),
      );
      await enqueued;
      let secondDone = false;
      const fast = cancel(b.tenantId, second.id).then(
        () => (secondDone = true),
      );
      await tick(400);
      // Without the per-tenant lock the second would already have committed
      // with the higher cursor while the lower one was still invisible.
      expect(secondDone).toBe(false);
      release();
      await Promise.all([slow, fast]);

      const rows = await items(b.tenantId);
      expect(rows.map((row) => row.requestId)).toEqual([first.id, second.id]);
    });

    it('cursors never leak across tenants', async () => {
      const a = await bot();
      const c = await bot();
      const [ra1, rc1, ra2] = [
        await openRequest(a.tenantId),
        await openRequest(c.tenantId),
        await openRequest(a.tenantId),
      ];
      await cancel(a.tenantId, ra1.id);
      await cancel(c.tenantId, rc1.id);
      await cancel(a.tenantId, ra2.id);

      const readA = await feed(a, '?waitSeconds=0').expect(200);
      const readC = await feed(c, '?waitSeconds=0').expect(200);
      expect(pluck(readA.body, 'requestId')).toEqual([ra1.id, ra2.id]);
      expect(pluck(readC.body, 'requestId')).toEqual([rc1.id]);
      const cursors = pluck(readA.body, 'cursor').map((c) => BigInt(c));
      expect(cursors[0] < cursors[1]).toBe(true);
      // The other tenant's delivery is invisible to ACK.
      await outcome(c, readA.body.items[0].deliveryId, {
        attemptId: ATTEMPT(),
        outcome: 'STALE',
      }).expect(404);
    });
  });

  describe('feed items of the resolve paths', () => {
    it('staff resolve of a RESTOCK decision enqueues request.answered with the fixed text and fields', async () => {
      const b = await bot();
      const decisionId = await submitRestock(b.tenantId);
      const req = await prisma.chatbotRequest.findFirstOrThrow({
        where: { humanDecisionId: decisionId },
      });
      await resolveNew(b.tenantId, req.id, {
        type: 'PROVIDE_RESTOCK_ESTIMATE',
        restockDays: 7,
      });

      const [item] = await items(b.tenantId);
      expect(item).toMatchObject({
        type: 'request.answered',
        requestId: req.id,
      });
      expect(item.payload).toEqual({
        kind: 'DECISION',
        subtype: 'RESTOCK',
        action: 'PROVIDE_RESTOCK_ESTIMATE',
        legacyId: decisionId,
        text: 'El producto «Croquetas 20 kg» estará disponible en aproximadamente 7 días.',
        prefix: null,
        productName: 'Croquetas 20 kg',
        restockDays: 7,
      });
    });

    it('the legacy resolve route enqueues the same item (S4: one state)', async () => {
      const b = await bot();
      const decisionId = await submitRestock(b.tenantId);
      await inTenant(b.tenantId, () =>
        decisions.resolve({
          decisionId,
          expectedVersion: 1,
          resolutionRequestId: randomUUID(),
          action: 'PROVIDE_RESTOCK_ESTIMATE',
          restockDays: 3,
          actorUserId: users.rev,
          actorIsSuperAdmin: false,
        }),
      );
      const rows = await items(b.tenantId);
      expect(rows).toHaveLength(1);
      expect(rows[0].payload).toMatchObject({
        action: 'PROVIDE_RESTOCK_ESTIMATE',
        legacyId: decisionId,
        restockDays: 3,
      });
      // The legacy bot poll of the same decision keeps answering as before.
      const decision = await prisma.humanDecision.findUniqueOrThrow({
        where: { id: decisionId },
      });
      expect(decision).toMatchObject({
        status: 'RESOLVED',
        version: 2,
        restockDays: 3,
      });
    });

    it('a zone resolve enqueues one item per customer (R9), from the staff command', async () => {
      const b = await bot();
      const phones = ['5511111111', '5522222222', '5533333333'];
      const records: Awaited<ReturnType<typeof submitZone>>[] = [];
      for (const phone of phones)
        records.push(await submitZone(b.tenantId, phone));
      const mine = await prisma.chatbotRequest.findFirstOrThrow({
        where: { deliveryZoneRequestId: records[1].id },
      });
      const impact = await inTenant(b.tenantId, () =>
        staff.zoneImpact(mine.id),
      );
      await resolveNew(b.tenantId, mine.id, {
        type: 'APPROVE_DELIVERY_ZONE',
        settings: { type: 'SURCHARGE', surchargeCents: 5000, etaDays: 3 },
        expectedZoneSetVersion: impact.setVersion,
      });

      const rows = await items(b.tenantId);
      expect(rows).toHaveLength(3);
      expect(rows[0].requestId).toBe(mine.id);
      expect(new Set(rows.map((row) => row.conversationRef))).toEqual(
        new Set(phones.map((phone) => `wa:52${phone}`)),
      );
      for (const row of rows) {
        expect(row.payload).toMatchObject({
          subtype: 'DELIVERY_ZONE',
          action: 'APPROVE_DELIVERY_ZONE',
          zoneType: 'SURCHARGE',
          surchargeCents: 5000,
          etaDays: 3,
          zipCode: '64000',
        });
      }
      expect(
        new Set(
          rows.map((row) => (row.payload as { legacyId: string }).legacyId),
        ),
      ).toEqual(new Set(records.map((record) => record.id)));
    });

    it('the legacy zone validation resolve enqueues one item per customer too', async () => {
      const b = await bot();
      const first = await submitZone(b.tenantId, '5511111111');
      await submitZone(b.tenantId, '5522222222');
      await inTenant(b.tenantId, () =>
        validations.resolve({
          validationId: first.validationId as string,
          expectedVersion: 1,
          resolutionRequestId: randomUUID(),
          action: APPROVE_DELIVERY_ZONE,
          settings: { type: 'FREE', surchargeCents: null, etaDays: 2 },
          actorUserId: users.rev,
          actorIsSuperAdmin: false,
        }),
      );
      expect(await items(b.tenantId)).toHaveLength(2);
    });

    it('a rejected receipt carries customerReason; a legacy rejection relays the customerReason it defaults', async () => {
      const b = await bot();
      const first = await submitReceipt(b.tenantId);
      const firstRequest = await prisma.chatbotRequest.findFirstOrThrow({
        where: { receiptEvidenceId: first.receiptId },
      });
      await resolveNew(b.tenantId, firstRequest.id, {
        type: 'REJECT_RECEIPT',
        reason: 'monto distinto',
        customerReason: 'El monto no coincide, envíanos otro comprobante.',
      });
      const second = await submitReceipt(b.tenantId);
      await inTenant(b.tenantId, () =>
        receipts.reject(second.saleId, second.receiptId, users.rev, {
          reason: 'ilegible',
        }),
      );

      const [staffItem, legacyItem] = await items(b.tenantId);
      expect(staffItem.payload).toMatchObject({
        action: 'REJECT_RECEIPT',
        customerReason: 'El monto no coincide, envíanos otro comprobante.',
        text: 'El monto no coincide, envíanos otro comprobante.',
      });
      // The legacy route defaults the customer-safe reason itself; the item
      // relays whatever the wrapped row holds.
      expect(legacyItem.payload).toMatchObject({
        action: 'REJECT_RECEIPT',
        customerReason: expect.stringContaining('No pudimos validar'),
        text: expect.stringContaining('No pudimos validar'),
      });
    });
  });

  // ------------------------------------------------------------ long-poll

  describe('GET /chatbot-api/feed', () => {
    it('answers the scopes and the query errors in the sanitized envelope', async () => {
      const noScope = await bot(['feed:ack']);
      const forbidden = await feed(noScope, '?waitSeconds=0').expect(403);
      expect(forbidden.body).toMatchObject({
        statusCode: 403,
        code: 'INSUFFICIENT_SCOPE',
      });
      const b = await bot();
      for (const query of [
        '?limit=0',
        '?limit=51',
        '?waitSeconds=26',
        '?after=abc',
      ]) {
        const response = await feed(b, query).expect(400);
        expect(response.body).toMatchObject({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
        });
      }
      await request(app.getHttpServer()).get('/chatbot-api/feed').expect(401);
    });

    it('times out with an empty page that echoes the cursor', async () => {
      const b = await bot();
      const started = Date.now();
      const response = await feed(b, '?after=42&waitSeconds=1').expect(200);
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      expect(response.body).toEqual({ items: [], nextCursor: '000000000042' });
    });

    it('wakes on NOTIFY in under a second (p95) and holds no pool connection while it waits', async () => {
      const b = await bot();
      const other = await bot();
      const latencies: number[] = [];
      let after = '0';
      for (let i = 0; i < 15; i++) {
        const req = await openRequest(b.tenantId);
        const waiting = feed(b, `?after=${after}&waitSeconds=10`).then((r) => ({
          response: r,
          at: Date.now(),
        }));
        await tick(60);
        if (i === 0) {
          // The pool of this app has ONE connection and a long-poll is
          // waiting: if it held that connection these would time out.
          const t0 = Date.now();
          await feed(other, '?waitSeconds=0').expect(200);
          await outcome(other, randomUUID(), {
            attemptId: ATTEMPT(),
            outcome: 'STALE',
          }).expect(404);
          expect(Date.now() - t0).toBeLessThan(1500);
        }
        const committing = Date.now();
        await cancel(b.tenantId, req.id);
        const { response, at } = await waiting;
        expect(response.status).toBe(200);
        expect(response.body.items).toHaveLength(1);
        after = response.body.nextCursor;
        latencies.push(at - committing);
      }
      latencies.sort((x, y) => x - y);
      const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1];

      console.log(
        `[feed latency] cancel→bot, upper bound incl. the transaction: n=${latencies.length} median=${latencies[7]}ms p95=${p95}ms max=${latencies.at(-1)}ms`,
      );
      expect(p95).toBeLessThan(1000);
    });

    it('allows at most 2 waiting long-polls per credential (429) and frees the slot', async () => {
      const b = await bot();
      // supertest sends on `then`: start both polls now.
      const one = feed(b, '?waitSeconds=3').then((r) => r);
      const two = feed(b, '?waitSeconds=3').then((r) => r);
      await tick(300);
      const third = await feed(b, '?waitSeconds=3').expect(429);
      expect(third.body).toMatchObject({
        statusCode: 429,
        code: 'RATE_LIMITED',
      });
      expect(third.body).not.toHaveProperty('retryAfterSeconds');
      expect(third.headers['retry-after']).toBe('1');
      // An immediate read is not a long-poll and is not capped.
      await feed(b, '?waitSeconds=0').expect(200);

      const req = await openRequest(b.tenantId);
      await cancel(b.tenantId, req.id);
      const [r1, r2] = await Promise.all([one, two]);
      expect(r1.body.items).toHaveLength(1);
      expect(r2.body.items).toHaveLength(1);
      await feed(b, `?after=${r1.body.nextCursor}&waitSeconds=1`).expect(200);
    });

    it('delivers an item committed while the LISTEN connection is down (re-read after reconnect)', async () => {
      const b = await bot();
      const listener = app.get(PgNotificationListener);
      await listener.start();
      const pid = listener.backendPid;
      expect(pid).toEqual(expect.any(Number));
      const waiting = feed(b, '?waitSeconds=10');
      await tick(150);
      const req = await openRequest(b.tenantId);
      await prisma.$queryRaw(
        Prisma.sql`SELECT pg_terminate_backend(${pid}::int)::text`,
      );
      await cancel(b.tenantId, req.id);
      const response = await waiting;
      expect(response.status).toBe(200);
      expect(pluck(response.body, 'requestId')).toEqual([req.id]);
      expect(listener.backendPid).not.toBe(pid);
    });
  });

  // -------------------------------------------------------------- outcome

  describe('POST /chatbot-api/deliveries/:deliveryId/outcome', () => {
    async function delivery(b: Bot, conversationRef?: string) {
      const req = await openRequest(b.tenantId, conversationRef);
      await cancel(b.tenantId, req.id);
      const [item] = await items(b.tenantId);
      return { requestId: req.id, deliveryId: item.deliveryId };
    }
    const accepted = (attemptId: string) => ({
      attemptId,
      outcome: 'PROVIDER_ACCEPTED',
      attemptedAt: AT,
      providerMessageId: 'wamid.HBg1',
    });

    it('records one terminal outcome, replays it, and refuses a different one', async () => {
      const b = await bot();
      const { requestId, deliveryId } = await delivery(b);
      const attemptId = ATTEMPT();

      const first = await outcome(b, deliveryId, accepted(attemptId)).expect(
        200,
      );
      expect(first.body).toMatchObject({
        deliveryId,
        outcome: 'PROVIDER_ACCEPTED',
        attemptId,
      });
      expect(first.body.ackReceivedAt).toEqual(expect.any(String));
      expect(first.headers['cache-control']).toBe('no-store');

      const replay = await outcome(b, deliveryId, accepted(attemptId)).expect(
        200,
      );
      expect(replay.body).toEqual(first.body);

      const conflict = await outcome(b, deliveryId, {
        ...accepted(attemptId),
        providerMessageId: 'wamid.other',
      }).expect(409);
      expect(conflict.body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

      const other = await outcome(b, deliveryId, {
        attemptId: ATTEMPT(),
        outcome: 'STALE',
      }).expect(409);
      expect(other.body).toMatchObject({ code: 'OUTCOME_ALREADY_RECORDED' });

      const row = await prisma.chatbotFeedItem.findUniqueOrThrow({
        where: { deliveryId },
      });
      expect(row).toMatchObject({
        outcome: 'PROVIDER_ACCEPTED',
        attemptId,
        providerMessageId: 'wamid.HBg1',
      });
      expect(row.ackedAt).not.toBeNull();
      // The audit event is written once: the replay and the refusals add none.
      const events = await prisma.chatbotRequestEvent.findMany({
        where: { requestId, type: 'DELIVERY_OUTCOME' },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorKind: 'SERVICE',
        actorId: b.credentialId,
        data: {
          deliveryId,
          outcome: 'PROVIDER_ACCEPTED',
          needsReconciliation: false,
        },
      });
    });

    it('marks DELIVERY_UNKNOWN for reconciliation and is terminal', async () => {
      const b = await bot();
      const { requestId, deliveryId } = await delivery(b);
      await outcome(b, deliveryId, {
        attemptId: ATTEMPT(),
        outcome: 'DELIVERY_UNKNOWN',
        attemptedAt: AT,
      }).expect(200);
      expect(
        (
          await prisma.chatbotRequestEvent.findFirstOrThrow({
            where: { requestId, type: 'DELIVERY_OUTCOME' },
          })
        ).data,
      ).toMatchObject({
        outcome: 'DELIVERY_UNKNOWN',
        needsReconciliation: true,
      });
      await outcome(b, deliveryId, accepted(ATTEMPT())).expect(409);
    });

    it('answers 404 for an unknown delivery, 400 for a malformed one, 403 without feed:ack', async () => {
      const b = await bot();
      await outcome(b, randomUUID(), {
        attemptId: ATTEMPT(),
        outcome: 'STALE',
      }).expect(404);
      await outcome(b, 'not-a-uuid', {
        attemptId: ATTEMPT(),
        outcome: 'STALE',
      }).expect(400);
      const { deliveryId } = await delivery(b);
      await outcome(b, deliveryId, {
        attemptId: ATTEMPT(),
        outcome: 'FAILED',
      }).expect(400);
      const readOnly = await bot(['feed:read']);
      await outcome(readOnly, deliveryId, {
        attemptId: ATTEMPT(),
        outcome: 'STALE',
      }).expect(403);
    });

    it('a staff cancellation notice cannot be deferred (§12.14) but can be STALE', async () => {
      const b = await bot();
      const { deliveryId } = await delivery(b);
      const response = await outcome(b, deliveryId, {
        attemptId: ATTEMPT(),
        outcome: 'DEFERRED_WINDOW_CLOSED',
        attemptedAt: AT,
      }).expect(422);
      expect(response.body).toMatchObject({ code: 'OUTCOME_NOT_ALLOWED' });
      await outcome(b, deliveryId, {
        attemptId: ATTEMPT(),
        outcome: 'STALE',
      }).expect(200);
    });

    it('DEFERRED_WINDOW_CLOSED keeps the answer pending for pending-deliveries until a terminal outcome', async () => {
      const b = await bot();
      const decisionId = await submitRestock(b.tenantId);
      const req = await prisma.chatbotRequest.findFirstOrThrow({
        where: { humanDecisionId: decisionId },
      });
      // Give the request a conversation, as a bot-created one has.
      await prisma.chatbotRequest.update({
        where: { id: req.id },
        data: { conversationRef: 'wa:5215599990000' },
      });
      await resolveNew(b.tenantId, req.id, {
        type: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
      });
      const [item] = await items(b.tenantId);
      expect(item.conversationRef).toBe('wa:5215599990000');

      const deferral = {
        attemptId: ATTEMPT(),
        outcome: 'DEFERRED_WINDOW_CLOSED',
        attemptedAt: AT,
      };
      const deferred = await outcome(b, item.deliveryId, deferral).expect(200);
      expect(deferred.body).toMatchObject({
        outcome: 'DEFERRED_WINDOW_CLOSED',
        ackReceivedAt: null,
      });
      await outcome(b, item.deliveryId, deferral).expect(200);

      const listed = await pending(b, 'wa:5215599990000').expect(200);
      expect(pluck(listed.body, 'deliveryId')).toEqual([item.deliveryId]);
      expect(listed.body.items[0]).toMatchObject({
        type: 'request.answered',
        requestId: req.id,
      });
      expect((await pending(b, 'wa:other').expect(200)).body.items).toEqual([]);
      await pending(b, '').expect(400);

      // The customer wrote again; a later attempt delivers it.
      await outcome(b, item.deliveryId, accepted(ATTEMPT())).expect(200);
      expect(
        (await pending(b, 'wa:5215599990000').expect(200)).body.items,
      ).toEqual([]);
    });
  });

  // ------------------------------------------------------------ retention

  describe('retention (§3.3: 30 days)', () => {
    it('answers 410 CURSOR_EXPIRED for a cursor the purge passed, and serves a current one', async () => {
      const b = await bot();
      const req = await openRequest(b.tenantId);
      const old = new Date(Date.now() - 31 * 86_400_000);
      const stale = await prisma.chatbotFeedItem.create({
        data: {
          tenantId: b.tenantId,
          requestId: req.id,
          type: 'request.cancelled',
          payload: {},
          createdAt: old,
        },
      });
      await cancel(b.tenantId, req.id);
      expect(await feedStore.purgeExpired(new Date())).toBeGreaterThanOrEqual(
        1,
      );

      const expired = await feed(
        b,
        `?after=${stale.cursor - 1n}&waitSeconds=0`,
      ).expect(410);
      expect(expired.body).toMatchObject({
        statusCode: 410,
        code: 'CURSOR_EXPIRED',
      });
      // No cursor starts at the oldest retained item; a cursor at or past the
      // watermark is fine.
      const fresh = await feed(b, '?waitSeconds=0').expect(200);
      expect(fresh.body.items).toHaveLength(1);
      await feed(b, `?after=${stale.cursor}&waitSeconds=0`).expect(200);
    });
  });
});
