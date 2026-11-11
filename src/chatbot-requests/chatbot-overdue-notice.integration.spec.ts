/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- supertest response bodies are untyped JSON */
/**
 * human-intervention / unit 7c (S3) — a REAL `request.overdue_notice` item,
 * produced by the SLA sweep, through the bot routes against PostgreSQL
 * (contract §5.4, §3.3, §4.5, §3.9):
 *   - the feed delivers it with ids, kind, clock and the assigned flag only;
 *   - `POST /chatbot-api/deliveries/:id/outcome`: PROVIDER_ACCEPTED,
 *     DELIVERY_UNKNOWN and STALE are accepted; DEFERRED_WINDOW_CLOSED and
 *     DEFERRED_HUMAN_SESSION are 422 OUTCOME_NOT_ALLOWED (it cannot be
 *     deferred) and record nothing;
 *   - `pending-deliveries` (by conversationRef and by requestId) never serves
 *     it, since only deferred items are served there;
 *   - the recovery route lists it under `pendingDeliveries` until it is acked.
 */
import { createHash, randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import { integrationPrisma } from '../../test/integration/reset-db';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../chatbot-api/domain/service-credential.repository';
import { PrismaServiceCredentialRepository } from '../chatbot-api/infrastructure/prisma-service-credential.repository';
import { BotRateLimitModule } from '../chatbot-api/presentation/guards/bot-rate-limit.module';
import { ServiceAuthGuard } from '../chatbot-api/presentation/guards/service-auth.guard';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { PrismaService } from '../shared/prisma/prisma.service';
import { RealtimeModule } from '../shared/realtime/realtime.module';
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
import { BotFeedController } from './presentation/bot-feed.controller';
import { BotRecoveryController } from './presentation/bot-recovery.controller';
import { ChatbotRequestHttpFilter } from './presentation/chatbot-request-http.filter';
import { ChatbotSlaSweepStore } from './infrastructure/chatbot-sla-sweep.store';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

describeIfDb(
  'request.overdue_notice through the bot routes (PostgreSQL)',
  () => {
    const prisma = integrationPrisma();
    let app: INestApplication;
    const tenants: string[] = [];
    const credentials: string[] = [];

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
      await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    });

    // -------------------------------------------------------------- helpers

    const AT = '2026-11-10T18:00:00.000Z';
    // 10:00 Mexico City creation, claim clock overdue at 10:30 (-06:00).
    const SWEEP_NOW = new Date('2026-11-10T12:00:00-06:00');
    let seq = 0;

    async function bot() {
      const id = randomUUID();
      tenants.push(id);
      await prisma.tenant.create({
        data: { id, name: 'Sucursal Overdue', slug: `cr-od-${id}` },
      });
      const token = `svc_${randomUUID()}`;
      const credential = await prisma.serviceCredential.create({
        data: {
          tenantId: id,
          name: 'bot',
          hashedKey: createHash('sha256').update(token).digest('hex'),
          scopes: ['requests:read', 'feed:read', 'feed:ack'],
          rateLimit: 60,
        },
      });
      credentials.push(credential.id);
      return { tenantId: id, token, folio: 0 };
    }
    type Bot = Awaited<ReturnType<typeof bot>>;

    const auth = (b: Bot, req: request.Test) =>
      req
        .set('Authorization', `Bearer ${b.token}`)
        .set('X-Branch-Id', b.tenantId);
    const get = (b: Bot, path: string) =>
      auth(b, request(app.getHttpServer()).get(path));
    const outcome = (b: Bot, deliveryId: string, body: object) =>
      auth(
        b,
        request(app.getHttpServer()).post(
          `/chatbot-api/deliveries/${deliveryId}/outcome`,
        ),
      ).send(body);

    /** An open request that went overdue; the sweep (real code) feeds the bot. */
    async function overdueRequest(b: Bot) {
      const n = ++seq;
      const created = await prisma.chatbotRequest.create({
        data: {
          tenantId: b.tenantId,
          folio: ++b.folio,
          kind: 'CLARIFICATION',
          subtype: 'UNKNOWN_QUESTION',
          customerKey: `5255700${n}`,
          conversationRef: `wa:5255700${n}`,
          summary: 'Pregunta',
          source: 'chatbot',
          sourceRequestId: randomUUID(),
          createdAt: '2026-11-10T16:00:00Z',
          slaPolicyVersion: 0,
          nextSlaCheckAt: '2026-11-10T16:15:00Z',
        },
      });
      const sweep = new ChatbotSlaSweepStore(
        prisma as unknown as PrismaService,
        {
          clock: () => SWEEP_NOW,
        },
      );
      const result = await sweep.runBatch('due');
      expect(result.feedItems).toBeGreaterThanOrEqual(1);
      const item = await prisma.chatbotFeedItem.findFirstOrThrow({
        where: {
          tenantId: b.tenantId,
          requestId: created.id,
          type: 'request.overdue_notice',
        },
      });
      return { request: created, item };
    }

    const accepted = {
      outcome: 'PROVIDER_ACCEPTED',
      attemptedAt: AT,
      providerMessageId: 'wamid.overdue1',
    };

    it('the feed delivers it with the structured payload only', async () => {
      const b = await bot();
      const { request: req, item } = await overdueRequest(b);
      const res = await get(b, '/chatbot-api/feed?waitSeconds=0').expect(200);
      const delivered = res.body.items.filter(
        (i: any) => i.type === 'request.overdue_notice',
      );
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({
        deliveryId: item.deliveryId,
        requestId: req.id,
        conversationRef: req.conversationRef,
        payload: {
          requestId: req.id,
          folio: `S-${String(req.folio).padStart(6, '0')}`,
          kind: 'CLARIFICATION',
          subtype: 'UNKNOWN_QUESTION',
          clock: 'CLAIM',
          assigned: false,
          overdueAt: '2026-11-10T16:30:00.000Z',
        },
      });
      // The conversation id is the only place the chat identity travels.
      expect(Object.keys(delivered[0].payload).sort()).toEqual([
        'assigned',
        'clock',
        'folio',
        'kind',
        'overdueAt',
        'requestId',
        'subtype',
      ]);
    });

    describe('POST /chatbot-api/deliveries/:deliveryId/outcome', () => {
      it.each([
        ['PROVIDER_ACCEPTED', accepted],
        ['DELIVERY_UNKNOWN', { outcome: 'DELIVERY_UNKNOWN', attemptedAt: AT }],
        ['STALE', { outcome: 'STALE' }],
      ])('%s is accepted and acknowledges the item', async (name, body) => {
        const b = await bot();
        const { item } = await overdueRequest(b);
        const attemptId = randomUUID();
        const res = await outcome(b, item.deliveryId, {
          attemptId,
          ...body,
        }).expect(200);
        expect(res.body).toMatchObject({
          deliveryId: item.deliveryId,
          outcome: name,
          attemptId,
        });
        const row = await prisma.chatbotFeedItem.findUniqueOrThrow({
          where: { deliveryId: item.deliveryId },
        });
        expect(row.outcome).toBe(name);
        expect(row.ackedAt).not.toBeNull();
      });

      it.each([['DEFERRED_WINDOW_CLOSED'], ['DEFERRED_HUMAN_SESSION']])(
        '%s is 422 OUTCOME_NOT_ALLOWED and records nothing',
        async (name) => {
          const b = await bot();
          const { item } = await overdueRequest(b);
          const res = await outcome(b, item.deliveryId, {
            attemptId: randomUUID(),
            outcome: name,
            attemptedAt: AT,
          }).expect(422);
          expect(res.body).toMatchObject({ code: 'OUTCOME_NOT_ALLOWED' });
          expect(
            await prisma.chatbotFeedItem.findUniqueOrThrow({
              where: { deliveryId: item.deliveryId },
            }),
          ).toMatchObject({ outcome: null, ackedAt: null });
          // still deliverable: a terminal outcome is accepted afterwards
          await outcome(b, item.deliveryId, {
            attemptId: randomUUID(),
            ...accepted,
          }).expect(200);
        },
      );
    });

    describe('pending-deliveries never serves it', () => {
      it('neither by conversationRef nor by requestId, even next to a deferred answer of the same conversation', async () => {
        const b = await bot();
        const { request: req, item } = await overdueRequest(b);
        const byConversation = () =>
          get(
            b,
            `/chatbot-api/requests/pending-deliveries?conversationRef=${encodeURIComponent(req.conversationRef as string)}`,
          ).expect(200);
        const byRequest = () =>
          get(
            b,
            `/chatbot-api/requests/pending-deliveries?requestId=${req.id}`,
          ).expect(200);
        expect((await byConversation()).body.items).toEqual([]);
        expect((await byRequest()).body.items).toEqual([]);

        // A refused deferral leaves it out of the deferred set.
        await outcome(b, item.deliveryId, {
          attemptId: randomUUID(),
          outcome: 'DEFERRED_WINDOW_CLOSED',
          attemptedAt: AT,
        }).expect(422);
        expect((await byConversation()).body.items).toEqual([]);

        // Contrast: a deferred answer of that conversation IS served, alone.
        const answered = await prisma.chatbotFeedItem.create({
          data: {
            tenantId: b.tenantId,
            requestId: req.id,
            type: 'request.answered',
            conversationRef: req.conversationRef,
            payload: { kind: 'DECISION' },
            outcome: 'DEFERRED_WINDOW_CLOSED',
            attemptId: randomUUID(),
            evidenceHash: 'h'.repeat(64),
          },
        });
        for (const res of [await byConversation(), await byRequest()]) {
          expect(res.body.items.map((i: any) => i.deliveryId)).toEqual([
            answered.deliveryId,
          ]);
        }
      });
    });

    describe('recovery route', () => {
      it('lists it under pendingDeliveries until it is acknowledged', async () => {
        const b = await bot();
        const { request: req, item } = await overdueRequest(b);
        const pendingOf = async () => {
          const res = await get(b, '/chatbot-api/requests?status=open').expect(
            200,
          );
          const found = res.body.items.find((i: any) => i.id === req.id);
          return found.pendingDeliveries as any[];
        };
        const before = await pendingOf();
        expect(before.map((d) => [d.deliveryId, d.type])).toEqual([
          [item.deliveryId, 'request.overdue_notice'],
        ]);
        expect(before[0]).toMatchObject({
          requestId: req.id,
          conversationRef: req.conversationRef,
          payload: { requestId: req.id, clock: 'CLAIM' },
        });

        // A refused deferral does not ack it.
        await outcome(b, item.deliveryId, {
          attemptId: randomUUID(),
          outcome: 'DEFERRED_HUMAN_SESSION',
          attemptedAt: AT,
        }).expect(422);
        expect(await pendingOf()).toHaveLength(1);

        await outcome(b, item.deliveryId, {
          attemptId: randomUUID(),
          ...accepted,
        }).expect(200);
        expect(await pendingOf()).toEqual([]);
      });
    });
  },
);
