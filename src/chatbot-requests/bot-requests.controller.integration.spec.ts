/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- supertest response bodies are untyped JSON */
/**
 * human-intervention / unit 5, slice 5a — the bot HTTP routes end to end
 * against REAL PostgreSQL: Supertest → real `ServiceAuthGuard` with the real
 * credential repository and the shared PostgreSQL route limiter → real
 * controller, service and store → the scoped error filter.
 *
 * It proves the contract's wire facts (§3.1, §3.2, §3.4, §3.9): headers and
 * scopes, the error envelope with `{limit, open}` and `Retry-After`, `no-store`,
 * and R2: the `write` budget is separate from the budget of routes that have
 * no class, and both live in `service_rate_buckets`.
 */
import { Controller, Get, INestApplication, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import { integrationPrisma } from '../../test/integration/reset-db';
import { PrismaServiceCredentialRepository } from '../chatbot-api/infrastructure/prisma-service-credential.repository';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../chatbot-api/domain/service-credential.repository';
import { RequiredScopes } from '../chatbot-api/presentation/decorators/required-scopes.decorator';
import { BotRateLimitModule } from '../chatbot-api/presentation/guards/bot-rate-limit.module';
import { ServiceAuthGuard } from '../chatbot-api/presentation/guards/service-auth.guard';
import { BotRestockIntakeController } from '../human-decisions/presentation/bot-restock-intake.controller';
import { HumanDecisionHttpFilter } from '../human-decisions/presentation/filters/human-decision-http.filter';
import { DELIVERY_ZONE_BOT_REPOSITORY } from '../delivery-zones/domain/delivery-zone-bot.repository';
import { PrismaDeliveryZoneBotRepository } from '../delivery-zones/infrastructure/prisma-delivery-zone-bot.repository';
import { EXPIRATION_INTAKE_REPOSITORY } from '../human-decisions/domain/expiration-intake.repository';
import { RESTOCK_INTAKE_REPOSITORY } from '../human-decisions/domain/restock-intake.repository';
import { PrismaExpirationIntakeRepository } from '../human-decisions/infrastructure/prisma-expiration-intake.repository';
import { PrismaRestockIntakeRepository } from '../human-decisions/infrastructure/prisma-restock-intake.repository';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import {
  BOT_INTAKE_STORE,
  BotRequestIntakeService,
  LEGACY_INTAKE,
} from './application/bot-request-intake.service';
import { ChatbotRequestWrapper } from './infrastructure/chatbot-request-wrapper';
import { LegacyIntakeAdapter } from './infrastructure/legacy-intake.adapter';
import { PrismaBotIntakeStore } from './infrastructure/prisma-bot-intake.store';
import { BotRequestsController } from './presentation/bot-requests.controller';
import { ChatbotRequestHttpFilter } from './presentation/chatbot-request-http.filter';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

/** A route with no `@BotRouteClass`, like every chatbot-api route before. */
@Controller('probe')
@UseGuards(ServiceAuthGuard)
class ProbeController {
  @Get()
  @RequiredScopes('requests:read')
  ok() {
    return { ok: true };
  }
}

describeIfDb('bot requests HTTP routes (PostgreSQL)', () => {
  const prisma = integrationPrisma();
  let app: INestApplication;
  const tenants: string[] = [];
  const PHONE = { phoneCountryCode: '52', phone: '5512345678' };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        DatabaseModule,
        BotRateLimitModule,
      ],
      controllers: [
        BotRequestsController,
        ProbeController,
        BotRestockIntakeController,
      ],
      providers: [
        ServiceAuthGuard,
        ChatbotRequestHttpFilter,
        HumanDecisionHttpFilter,
        ChatbotRequestWrapper,
        BotRequestIntakeService,
        { provide: BOT_INTAKE_STORE, useClass: PrismaBotIntakeStore },
        { provide: LEGACY_INTAKE, useClass: LegacyIntakeAdapter },
        {
          provide: RESTOCK_INTAKE_REPOSITORY,
          useClass: PrismaRestockIntakeRepository,
        },
        {
          provide: EXPIRATION_INTAKE_REPOSITORY,
          useClass: PrismaExpirationIntakeRepository,
        },
        {
          provide: DELIVERY_ZONE_BOT_REPOSITORY,
          useClass: PrismaDeliveryZoneBotRepository,
        },
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
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.serviceRateBucket.deleteMany({
      where: { credentialId: { in: credentials } },
    });
  });

  const credentials: string[] = [];

  /** A tenant with its own credential; `token` is what the bot sends. */
  async function bot(
    over: { scopes?: string[]; rateLimit?: number; rateLimits?: object } = {},
  ) {
    const tenantId = randomUUID();
    tenants.push(tenantId);
    await prisma.tenant.create({
      data: { id: tenantId, name: 'Sucursal', slug: `cr-http-${tenantId}` },
    });
    const token = `svc_${randomUUID()}`;
    const credential = await prisma.serviceCredential.create({
      data: {
        tenantId,
        name: 'bot',
        hashedKey: createHash('sha256').update(token).digest('hex'),
        scopes: over.scopes ?? [
          'requests:create',
          'requests:cancel',
          'requests:read',
        ],
        rateLimit: over.rateLimit ?? 60,
        rateLimits: over.rateLimits,
      },
    });
    credentials.push(credential.id);
    return { tenantId, token, credentialId: credential.id };
  }

  const RECENT = new Date(Date.now() - 3_600_000).toISOString();
  const envelope = (over: Record<string, unknown> = {}) => ({
    sourceRequestId: randomUUID(),
    subtype: 'UNKNOWN_QUESTION',
    customer: PHONE,
    conversationRef: 'wa:5215512345678',
    lastCustomerMessageAt: RECENT,
    summary: '¿Sirve para cachorros?',
    ...over,
  });

  const post = (
    b: { token: string; tenantId: string },
    body: { sourceRequestId?: string; [key: string]: unknown },
    over: { key?: string | null } = {},
  ) => {
    const call = request(app.getHttpServer())
      .post('/chatbot-api/requests')
      .set('Authorization', `Bearer ${b.token}`)
      .set('X-Branch-Id', b.tenantId);
    const key = over.key === undefined ? body.sourceRequestId : over.key;
    if (key) call.set('X-Idempotency-Key', key);
    return call.send(body);
  };

  const cancel = (
    b: { token: string; tenantId: string },
    id: string,
    key = randomUUID(),
  ) =>
    request(app.getHttpServer())
      .post(`/chatbot-api/requests/${id}/cancel`)
      .set('Authorization', `Bearer ${b.token}`)
      .set('X-Branch-Id', b.tenantId)
      .set('X-Idempotency-Key', key)
      .send({ reason: 'CUSTOMER_WITHDREW', triggerWaMessageId: 'wamid.1' });

  describe('auth, scopes and common rules (§3.1)', () => {
    it('answers 401 without or with a bad credential, in the sanitized envelope', async () => {
      const missing = await request(app.getHttpServer())
        .post('/chatbot-api/requests')
        .send(envelope());
      const bad = await request(app.getHttpServer())
        .post('/chatbot-api/requests')
        .set('Authorization', 'Bearer svc_nope')
        .send(envelope());

      for (const response of [missing, bad]) {
        expect(response.status).toBe(401);
        expect(response.body).toEqual({
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'Unauthorized',
        });
        expect(response.headers['cache-control']).toBe('no-store');
      }
    });

    it('answers 403 INSUFFICIENT_SCOPE per route and 403 for another branch', async () => {
      const onlyCancel = await bot({ scopes: ['requests:cancel'] });
      const onlyCreate = await bot({ scopes: ['requests:create'] });
      const other = await bot();

      const create = await post(onlyCancel, envelope());
      const cancelRes = await cancel(onlyCreate, randomUUID());
      const wrongBranch = await request(app.getHttpServer())
        .post('/chatbot-api/requests')
        .set('Authorization', `Bearer ${onlyCreate.token}`)
        .set('X-Branch-Id', other.tenantId)
        .send(envelope());

      expect(create.status).toBe(403);
      expect(create.body).toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
      expect(cancelRes.body).toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
      expect(wrongBranch.status).toBe(403);
      expect(wrongBranch.body.code).toBe('FORBIDDEN');
    });

    it('answers 400 VALIDATION_ERROR for a bad key, a bad body and an extra key', async () => {
      const b = await bot();
      const body = envelope();

      const noKey = await post(b, body, { key: null });
      const otherKey = await post(b, body, { key: randomUUID() });
      const extra = await post(b, envelope({ tenantId: 'x' }));
      const badCancel = await request(app.getHttpServer())
        .post(`/chatbot-api/requests/${randomUUID()}/cancel`)
        .set('Authorization', `Bearer ${b.token}`)
        .set('X-Idempotency-Key', 'not-a-uuid')
        .send({ reason: 'CUSTOMER_WITHDREW', triggerWaMessageId: 'w' });

      for (const response of [noKey, otherKey, extra, badCancel]) {
        expect(response.status).toBe(400);
        expect(response.body).toEqual({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
        });
      }
    });
  });

  describe('create and cancel on the wire', () => {
    it('creates 201, replays 200 REPLAYED, merges 200 MERGED, all no-store', async () => {
      const b = await bot();
      const body = envelope({ dedupKey: 'UQ:p1' });

      const created = await post(b, body);
      const replay = await post(b, body);
      const merged = await post(b, envelope({ dedupKey: 'UQ:p1' }));
      const conflict = await post(b, { ...body, summary: 'otra' });

      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        status: 'NEW',
        outcome: 'CREATED',
        mergedIntoId: null,
        businessHours: null,
        folio: 'S-000001',
      });
      expect(created.headers['cache-control']).toBe('no-store');
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({
        id: created.body.id,
        outcome: 'REPLAYED',
      });
      expect(merged.status).toBe(200);
      expect(merged.body).toMatchObject({
        id: created.body.id,
        outcome: 'MERGED',
        mergedIntoId: created.body.id,
      });
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('answers 422 for a scheduled conversation and for a receipt', async () => {
      const b = await bot();

      const scheduled = await post(
        b,
        envelope({ scheduledFor: '2026-11-12T15:00:00.000Z' }),
      );
      const receipt = await post(b, {
        sourceRequestId: randomUUID(),
        subtype: 'TRANSFER_RECEIPT',
      });

      expect(scheduled.status).toBe(422);
      expect(scheduled.body.code).toBe('SCHEDULING_DISABLED');
      expect(receipt.status).toBe(422);
      expect(receipt.body.code).toBe('SUBTYPE_DISABLED');
    });

    it('wraps a RESTOCK and returns the legacy projection next to the request', async () => {
      const b = await bot();
      const id = randomUUID();

      const response = await post(b, {
        sourceRequestId: id,
        subtype: 'RESTOCK',
        customer: PHONE,
        detail: {
          sourceRequestId: id,
          type: 'RESTOCK',
          productId: randomUUID(),
          productName: 'Croquetas',
        },
      });

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        outcome: 'CREATED',
        legacy: { status: 'PENDING', version: 1 },
      });
      expect(
        await prisma.chatbotRequest.count({
          where: { tenantId: b.tenantId, subtype: 'RESTOCK' },
        }),
      ).toBe(1);
    });

    it('answers the open limit as 409 with {limit, open}', async () => {
      const b = await bot();
      await prisma.chatbotRequest.createMany({
        data: Array.from({ length: 20 }, (_, i) => ({
          tenantId: b.tenantId,
          folio: i + 1,
          kind: 'CLARIFICATION' as const,
          subtype: 'UNKNOWN_QUESTION' as const,
          customerKey: '525512345678',
          summary: 'seed',
          source: 'seed',
          sourceRequestId: randomUUID(),
          // spread over two hours so the hourly limit stays out of the way
          createdAt: new Date(Date.now() - (i + 1) * 360_000),
        })),
      });

      const response = await post(b, envelope());

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        statusCode: 409,
        code: 'CUSTOMER_OPEN_LIMIT',
        message: 'The customer has too many open requests',
        limit: 20,
        open: 20,
      });
    });

    it('answers the hourly limit as 429 with Retry-After', async () => {
      const b = await bot();
      await prisma.chatbotRequest.createMany({
        data: Array.from({ length: 10 }, (_, i) => ({
          tenantId: b.tenantId,
          folio: i + 1,
          kind: 'CLARIFICATION' as const,
          subtype: 'UNKNOWN_QUESTION' as const,
          status: 'CANCELLED' as const,
          cancelledAt: new Date(),
          closedAt: new Date(),
          cancelReason: 'CUSTOMER_WITHDREW' as const,
          customerKey: '525512345678',
          summary: 'seed',
          source: 'seed',
          sourceRequestId: randomUUID(),
        })),
      });

      const response = await post(b, envelope());

      expect(response.status).toBe(429);
      expect(response.body).toMatchObject({
        code: 'CUSTOMER_RATE_LIMITED',
        limit: 10,
      });
      expect(response.body).not.toHaveProperty('retryAfterSeconds');
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('cancels 200, replays the same answer, 404s another branch, 409s a resolved one', async () => {
      const b = await bot();
      const other = await bot();
      const made = await post(b, envelope());
      const id = made.body.id as string;
      const key = randomUUID();

      const first = await cancel(b, id, key);
      const replay = await cancel(b, id, key);
      const foreign = await cancel(other, id);

      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        id,
        status: 'CANCELLED',
        reason: 'CUSTOMER_WITHDREW',
      });
      expect(first.headers['cache-control']).toBe('no-store');
      expect(replay.body).toEqual(first.body);
      expect(foreign.status).toBe(404);
      expect(foreign.body).toEqual({
        statusCode: 404,
        code: 'NOT_FOUND',
        message: 'Chatbot request not found',
      });

      const second = await post(
        b,
        envelope({ customer: { phoneCountryCode: '52', phone: '5587654321' } }),
      );
      await prisma.chatbotRequest.update({
        where: { id: second.body.id as string },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          closedAt: new Date(),
          resolvedByActorId: 'u',
          resolvedByDisplayName: 'U',
          resolution: { action: 'REPLY', text: 'Sí' },
        },
      });
      const resolved = await cancel(b, second.body.id as string);
      expect(resolved.status).toBe(409);
      expect(resolved.body).toMatchObject({
        code: 'ALREADY_RESOLVED',
        resolution: { action: 'REPLY', text: 'Sí' },
      });
    });
  });

  describe('R2 route budgets', () => {
    it('answers 429 RATE_LIMITED with Retry-After when the class budget is spent', async () => {
      const b = await bot({ rateLimits: { write: 2 } });

      const statuses: number[] = [];
      let last: request.Response | undefined;
      for (let i = 0; i < 3; i++) {
        last = await post(
          b,
          envelope({
            customer: { phoneCountryCode: '52', phone: `55000000${10 + i}` },
          }),
        );
        statuses.push(last.status);
      }

      expect(statuses).toEqual([201, 201, 429]);
      expect(last?.body).toEqual({
        statusCode: 429,
        code: 'RATE_LIMITED',
        message: 'Too many requests',
      });
      expect(Number(last?.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(Number(last?.headers['retry-after'])).toBeLessThanOrEqual(60);
      expect(last?.headers['cache-control']).toBe('no-store');
    });

    it('keeps the credential rateLimit for routes with no class, apart from `write`', async () => {
      const b = await bot({ rateLimit: 2, rateLimits: { write: 5 } });
      const probe = () =>
        request(app.getHttpServer())
          .get('/probe')
          .set('Authorization', `Bearer ${b.token}`);

      await post(b, envelope());
      await post(
        b,
        envelope({ customer: { phoneCountryCode: '52', phone: '5587654321' } }),
      );
      await post(
        b,
        envelope({ customer: { phoneCountryCode: '52', phone: '5587654322' } }),
      );
      const statuses = [
        (await probe()).status,
        (await probe()).status,
        (await probe()).status,
      ];

      expect(statuses).toEqual([200, 200, 429]);
      const buckets = await prisma.serviceRateBucket.findMany({
        where: { credentialId: b.credentialId },
        orderBy: { routeClass: 'asc' },
      });
      expect(
        buckets.map((bucket) => [bucket.routeClass, bucket.count]),
      ).toEqual([
        ['default', 3],
        ['write', 3],
      ]);
    });

    describe('human-decision routes have their own bucket (owner decision M1)', () => {
      const intake = (b: { token: string; tenantId: string }) => {
        const id = randomUUID();
        return request(app.getHttpServer())
          .post('/chatbot-api/human-decisions')
          .set('Authorization', `Bearer ${b.token}`)
          .set('X-Idempotency-Key', id)
          .send({
            sourceRequestId: id,
            type: 'RESTOCK',
            productId: randomUUID(),
            productName: 'Croquetas',
          });
      };
      const probe = (b: { token: string }) =>
        request(app.getHttpServer())
          .get('/probe')
          .set('Authorization', `Bearer ${b.token}`);
      const scopes = ['human-decisions:create', 'requests:read'];

      it('exhausting the stock route leaves the other chatbot-api routes untouched', async () => {
        const b = await bot({ scopes, rateLimit: 2 });

        const stock = [
          (await intake(b)).status,
          (await intake(b)).status,
          (await intake(b)).status,
        ];
        const other = [
          (await probe(b)).status,
          (await probe(b)).status,
          (await probe(b)).status,
        ];

        expect(stock).toEqual([201, 201, 429]);
        expect(other).toEqual([200, 200, 429]);
        const buckets = await prisma.serviceRateBucket.findMany({
          where: { credentialId: b.credentialId },
          orderBy: { routeClass: 'asc' },
        });
        expect(
          buckets.map((bucket) => [bucket.routeClass, bucket.count]),
        ).toEqual([
          ['default', 3],
          ['humanDecisions', 3],
        ]);
      });

      it('and the other way round, honoring a per-class override', async () => {
        const b = await bot({
          scopes,
          rateLimit: 2,
          rateLimits: { humanDecisions: 4 },
        });

        expect([
          (await probe(b)).status,
          (await probe(b)).status,
          (await probe(b)).status,
        ]).toEqual([200, 200, 429]);
        const stock: number[] = [];
        for (let i = 0; i < 5; i++) stock.push((await intake(b)).status);
        expect(stock).toEqual([201, 201, 201, 201, 429]);
      });
    });
  });
});
