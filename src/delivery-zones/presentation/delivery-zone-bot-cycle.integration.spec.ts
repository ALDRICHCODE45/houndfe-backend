/**
 * shipping-zones / T1 (S2, S3) — DELIVERY_ZONE bot cycle + store validation
 * against REAL PostgreSQL, the REAL bot routes (intake / poll / ACK
 * controllers of the human-decisions module) and the REAL store guards.
 *
 * Proves: requester idempotency per sourceRequestId, one validation per
 * postal code shared by several requesters, immediate resolution when a zone
 * exists, the email outbox row, atomic resolve (zone + every requester), the
 * per-requester poll/ACK, 403 without DeliveryZone:validate, tenant isolation
 * and that RESTOCK intake/poll stay unchanged next to DELIVERY_ZONE rows.
 */
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../../chatbot-api/domain/service-credential.repository';
import { ServiceAuthGuard } from '../../chatbot-api/presentation/guards/service-auth.guard';
import { BOT_APPLICATION_OUTCOME_REPOSITORY } from '../../human-decisions/domain/bot-application-outcome.repository';
import { BOT_RESTOCK_POLL_REPOSITORY } from '../../human-decisions/domain/bot-restock-poll.repository';
import { EXPIRATION_INTAKE_REPOSITORY } from '../../human-decisions/domain/expiration-intake.repository';
import { RESTOCK_INTAKE_REPOSITORY } from '../../human-decisions/domain/restock-intake.repository';
import { PrismaBotApplicationOutcomeRepository } from '../../human-decisions/infrastructure/prisma-bot-application-outcome.repository';
import { PrismaBotRestockPollRepository } from '../../human-decisions/infrastructure/prisma-bot-restock-poll.repository';
import { PrismaExpirationIntakeRepository } from '../../human-decisions/infrastructure/prisma-expiration-intake.repository';
import { PrismaRestockIntakeRepository } from '../../human-decisions/infrastructure/prisma-restock-intake.repository';
import { BotApplicationOutcomeController } from '../../human-decisions/presentation/bot-application-outcome.controller';
import { BotRestockIntakeController } from '../../human-decisions/presentation/bot-restock-intake.controller';
import { BotRestockPollController } from '../../human-decisions/presentation/bot-restock-poll.controller';
import { HumanDecisionHttpFilter } from '../../human-decisions/presentation/filters/human-decision-http.filter';
import { DELIVERY_ZONE_BOT_REPOSITORY } from '../domain/delivery-zone-bot.repository';
import { DELIVERY_ZONE_REPOSITORY } from '../domain/delivery-zone.repository';
import { DELIVERY_ZONE_VALIDATION_REPOSITORY } from '../domain/delivery-zone-validation.repository';
import { PrismaDeliveryZoneBotRepository } from '../infrastructure/prisma-delivery-zone-bot.repository';
import { PrismaDeliveryZoneRepository } from '../infrastructure/prisma-delivery-zone.repository';
import { PrismaDeliveryZoneValidationRepository } from '../infrastructure/prisma-delivery-zone-validation.repository';
import {
  BotCredentials,
  createZoneTestApp,
  disconnectWorldPrisma,
  SKIP_DB_INTEGRATION,
  worldPrisma,
  ZoneWorld,
  type SeededMember,
} from '../test-support/delivery-zone-world';
import { DeliveryZoneValidationsController } from './delivery-zone-validations.controller';
import { DeliveryZonesController } from './delivery-zones.controller';

const describeIfDb = SKIP_DB_INTEGRATION ? describe.skip : describe;

const INTAKE_URL = '/chatbot-api/human-decisions';

interface BotBody {
  id: string;
  sourceRequestId: string;
  type: string;
  status: string;
  version: number;
  decisionId: string | null;
  snapshot: Record<string, unknown>;
  resolution: Record<string, unknown> | null;
  applyBefore: string | null;
}

interface ValidationBody {
  id: string;
  zipCode: string;
  status: string;
  version: number;
  requesterCount: number;
  lastCustomerMessageAt: string | null;
  urgency: { deadlineAt: string; hoursLeft: number; level: string } | null;
  resolution: Record<string, unknown> | null;
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function intakeBody(overrides: Record<string, unknown> = {}) {
  return {
    sourceRequestId: randomUUID(),
    type: 'DELIVERY_ZONE',
    zipCode: '06700',
    state: 'Ciudad de México',
    municipality: 'Cuauhtémoc',
    neighborhood: 'Roma Norte',
    phoneCountryCode: '52',
    phone: '5512345678',
    conversationRef: `wa:${randomUUID()}`,
    lastCustomerMessageAt: minutesAgo(30),
    ...overrides,
  };
}

describeIfDb('DELIVERY_ZONE bot cycle + store validation (PostgreSQL)', () => {
  let app: INestApplication;
  const server = () => app.getHttpServer() as App;
  const world = new ZoneWorld();
  const credentials = new BotCredentials();
  let tenantA: string;
  let tenantB: string;
  let botA: string;
  let botB: string;
  let validatorA: SeededMember;
  let readerA: SeededMember;
  let validatorB: SeededMember;

  beforeAll(async () => {
    app = await createZoneTestApp({
      controllers: [
        BotRestockIntakeController,
        BotRestockPollController,
        BotApplicationOutcomeController,
        DeliveryZonesController,
        DeliveryZoneValidationsController,
      ],
      providers: [
        HumanDecisionHttpFilter,
        ServiceAuthGuard,
        {
          provide: SERVICE_CREDENTIAL_REPOSITORY,
          useValue: credentials.repository,
        },
        {
          provide: RESTOCK_INTAKE_REPOSITORY,
          useClass: PrismaRestockIntakeRepository,
        },
        {
          provide: EXPIRATION_INTAKE_REPOSITORY,
          useClass: PrismaExpirationIntakeRepository,
        },
        {
          provide: BOT_RESTOCK_POLL_REPOSITORY,
          useClass: PrismaBotRestockPollRepository,
        },
        {
          provide: BOT_APPLICATION_OUTCOME_REPOSITORY,
          useClass: PrismaBotApplicationOutcomeRepository,
        },
        {
          provide: DELIVERY_ZONE_BOT_REPOSITORY,
          useClass: PrismaDeliveryZoneBotRepository,
        },
        {
          provide: DELIVERY_ZONE_REPOSITORY,
          useClass: PrismaDeliveryZoneRepository,
        },
        {
          provide: DELIVERY_ZONE_VALIDATION_REPOSITORY,
          useClass: PrismaDeliveryZoneValidationRepository,
        },
      ],
    });
  });

  beforeEach(async () => {
    tenantA = await world.tenant('Sucursal A');
    tenantB = await world.tenant('Sucursal B');
    botA = credentials.register(tenantA);
    botB = credentials.register(tenantB);
    validatorA = await world.member(tenantA, 'Validadora A', [
      'DeliveryZone:read',
      'DeliveryZone:validate',
    ]);
    readerA = await world.member(tenantA, 'Lector A', ['DeliveryZone:read']);
    validatorB = await world.member(tenantB, 'Validador B', [
      'DeliveryZone:validate',
    ]);
  });

  afterEach(() => world.cleanup());

  afterAll(async () => {
    await app?.close();
    await disconnectWorldPrisma();
  });

  const intake = (
    bot: string,
    body: Record<string, unknown> & { sourceRequestId: string },
  ) =>
    request(server())
      .post(INTAKE_URL)
      .set('Authorization', `Bearer ${bot}`)
      .set('X-Idempotency-Key', body.sourceRequestId)
      .send(body);

  const poll = (bot: string, id: string) =>
    request(server())
      .get(`${INTAKE_URL}/${id}`)
      .set('Authorization', `Bearer ${bot}`);

  const pending = (member: SeededMember) =>
    request(server())
      .get('/delivery-zone-validations')
      .set('Authorization', `Bearer ${member.token}`);

  const resolve = (member: SeededMember, id: string, body: object) =>
    request(server())
      .post(`/delivery-zone-validations/${id}/resolve`)
      .set('Authorization', `Bearer ${member.token}`)
      .send(body);

  async function enableEmail(tenantId: string): Promise<void> {
    const prisma = worldPrisma();
    await prisma.notificationSettings.create({
      data: { tenantId, enabled: true },
    });
    await prisma.notificationAction.create({
      data: { tenantId, action: 'DELIVERY_ZONE_VALIDATION_REQUESTED' },
    });
  }

  it('opens one validation per postal code, replays per sourceRequestId and attaches every requester', async () => {
    await enableEmail(tenantA);
    // 13 h ago -> 11 h left in the 24 h window -> WARNING (< 12 h).
    const first = intakeBody({ lastCustomerMessageAt: minutesAgo(780) });
    const created = await intake(botA, first).expect(201);
    const body = created.body as BotBody;
    expect(body).toMatchObject({
      sourceRequestId: first.sourceRequestId,
      type: 'DELIVERY_ZONE',
      status: 'PENDING',
      version: 1,
      resolution: null,
      applyBefore: null,
      snapshot: {
        branchName: 'Sucursal A',
        zipCode: '06700',
        state: 'Ciudad de México',
        municipality: 'Cuauhtémoc',
        neighborhood: 'Roma Norte',
      },
    });
    expect(body.decisionId).toEqual(expect.any(String));
    expect(JSON.stringify(body)).not.toContain('5512345678');

    const replay = await intake(botA, first).expect(200);
    expect(replay.body).toEqual(created.body);

    const conflict = await intake(botA, {
      ...first,
      phone: '5599999999',
    }).expect(409);
    expect((conflict.body as { code: string }).code).toBe(
      'IDEMPOTENCY_CONFLICT',
    );

    const second = await intake(
      botA,
      intakeBody({ lastCustomerMessageAt: minutesAgo(5) }),
    ).expect(201);
    const secondBody = second.body as BotBody;
    expect(secondBody.id).not.toBe(body.id);
    expect(secondBody.decisionId).toBe(body.decisionId);

    const prisma = worldPrisma();
    expect(
      await prisma.deliveryZoneValidation.count({
        where: { tenantId: tenantA },
      }),
    ).toBe(1);
    expect(
      await prisma.deliveryZoneRequest.count({ where: { tenantId: tenantA } }),
    ).toBe(2);
    const outbox = await prisma.outboxEvent.findMany({
      where: { tenantId: tenantA },
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      eventType: 'delivery_zone.validation.requested',
      aggregateType: 'DeliveryZoneValidation',
      aggregateId: body.decisionId,
      status: 'PENDING',
    });
    expect(outbox[0].payload).toMatchObject({
      tenantId: tenantA,
      validationId: body.decisionId,
      zipCode: '06700',
      lastCustomerMessageAt: first.lastCustomerMessageAt,
    });

    const list = await pending(validatorA).expect(200);
    const items = (list.body as { data: ValidationBody[] }).data;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: body.decisionId,
      zipCode: '06700',
      status: 'PENDING',
      requesterCount: 2,
      lastCustomerMessageAt: first.lastCustomerMessageAt,
      resolution: null,
    });
    expect(items[0].urgency?.level).toBe('WARNING');
    expect(items[0].urgency?.hoursLeft).toBeGreaterThanOrEqual(10.8);
    expect(items[0].urgency?.hoursLeft).toBeLessThanOrEqual(11);
  });

  it('writes no outbox row while the notification action is disabled', async () => {
    await intake(botA, intakeBody()).expect(201);
    expect(
      await worldPrisma().outboxEvent.count({ where: { tenantId: tenantA } }),
    ).toBe(0);
  });

  it('sorts pending validations by the oldest requester message first', async () => {
    await intake(
      botA,
      intakeBody({ zipCode: '06700', lastCustomerMessageAt: minutesAgo(10) }),
    ).expect(201);
    await intake(
      botA,
      intakeBody({ zipCode: '03100', lastCustomerMessageAt: minutesAgo(900) }),
    ).expect(201);
    const list = await pending(validatorA).expect(200);
    const zips = (list.body as { data: ValidationBody[] }).data.map(
      (item) => item.zipCode,
    );
    expect(zips).toEqual(['03100', '06700']);
  });

  it('filters pending validations by ?zipCode within the tenant', async () => {
    const roma = (
      await intake(botA, intakeBody({ zipCode: '06700' })).expect(201)
    ).body as BotBody;
    await intake(
      botA,
      intakeBody({ zipCode: '03100', lastCustomerMessageAt: minutesAgo(900) }),
    ).expect(201);
    await intake(botB, intakeBody({ zipCode: '06700' })).expect(201);

    const filtered = await request(server())
      .get('/delivery-zone-validations?zipCode=06700')
      .set('Authorization', `Bearer ${validatorA.token}`)
      .expect(200);
    const body = filtered.body as {
      data: ValidationBody[];
      pagination: unknown;
    };
    expect(body.data.map((item) => item.id)).toEqual([roma.decisionId]);
    expect(body.data[0]).toMatchObject({
      zipCode: '06700',
      status: 'PENDING',
      requesterCount: 1,
    });
    expect(body.pagination).toEqual({
      pageIndex: 0,
      pageSize: 20,
      totalCount: 1,
      pageCount: 1,
    });

    const none = await request(server())
      .get('/delivery-zone-validations?zipCode=11000')
      .set('Authorization', `Bearer ${validatorA.token}`)
      .expect(200);
    expect(none.body).toEqual({
      data: [],
      pagination: { pageIndex: 0, pageSize: 20, totalCount: 0, pageCount: 0 },
    });

    const all = await pending(validatorA).expect(200);
    expect(
      (all.body as { data: ValidationBody[] }).data.map((item) => item.zipCode),
    ).toEqual(['03100', '06700']);
  });

  it('rejects a malformed ?zipCode with the validation-pipe 400', async () => {
    for (const zipCode of ['6700', '067000', '06a00']) {
      const res = await request(server())
        .get(`/delivery-zone-validations?zipCode=${zipCode}`)
        .set('Authorization', `Bearer ${validatorA.token}`)
        .expect(400);
      expect(res.body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: [
          {
            property: 'zipCode',
            children: [],
            constraints: { matches: 'zipCode must be exactly five digits' },
          },
        ],
      });
    }
  });

  it('resolves atomically: creates the zone and settles every requester, then each requester ACKs on its own', async () => {
    const a = (await intake(botA, intakeBody()).expect(201)).body as BotBody;
    const b = (await intake(botA, intakeBody()).expect(201)).body as BotBody;
    const decisionId = a.decisionId as string;
    const resolutionRequestId = randomUUID();
    const approve = {
      expectedVersion: 1,
      resolutionRequestId,
      action: 'APPROVE_DELIVERY_ZONE',
      zoneType: 'SURCHARGE',
      surchargeCents: 4500,
      etaDays: 2,
    };

    const resolved = await resolve(validatorA, decisionId, approve).expect(200);
    expect(resolved.body).toMatchObject({
      validation: {
        id: decisionId,
        status: 'RESOLVED',
        version: 2,
        requesterCount: 2,
        urgency: null,
        resolution: {
          action: 'APPROVE_DELIVERY_ZONE',
          zoneType: 'SURCHARGE',
          surchargeCents: 4500,
          etaDays: 2,
          resolvedBy: { id: validatorA.userId, displayName: 'Validadora A' },
        },
      },
      zone: {
        zipCode: '06700',
        type: 'SURCHARGE',
        surchargeCents: 4500,
        etaDays: 2,
        isActive: true,
        sourceValidationId: decisionId,
      },
    });

    const replay = await resolve(validatorA, decisionId, approve).expect(200);
    expect(replay.body).toEqual(resolved.body);
    const other = await resolve(validatorA, decisionId, {
      ...approve,
      resolutionRequestId: randomUUID(),
    }).expect(409);
    expect((other.body as { code: string }).code).toBe('ALREADY_RESOLVED');

    for (const requester of [a, b]) {
      const polled = (await poll(botA, requester.id).expect(200))
        .body as BotBody;
      expect(polled).toMatchObject({
        id: requester.id,
        status: 'RESOLVED',
        version: 2,
        decisionId,
        resolution: {
          source: 'VALIDATION',
          zoneType: 'SURCHARGE',
          surchargeCents: 4500,
          etaDays: 2,
        },
      });
      expect(polled.applyBefore).toEqual(expect.any(String));
    }

    const attemptedAt = new Date().toISOString();
    const ackBody = {
      expectedResolutionVersion: 2,
      attemptId: randomUUID(),
      outcome: 'PROVIDER_ACCEPTED',
      attemptedAt,
      providerMessageId: 'wamid.test-1',
      providerAcceptedObservedAt: attemptedAt,
    };
    const ack = await request(server())
      .post(`${INTAKE_URL}/${a.id}/application-outcome`)
      .set('Authorization', `Bearer ${botA}`)
      .send(ackBody)
      .expect(200);
    expect(ack.body).toMatchObject({
      id: a.id,
      version: 2,
      attemptId: ackBody.attemptId,
      outcome: 'PROVIDER_ACCEPTED',
    });
    await request(server())
      .post(`${INTAKE_URL}/${a.id}/application-outcome`)
      .set('Authorization', `Bearer ${botA}`)
      .send(ackBody)
      .expect(200);
    const rows = await worldPrisma().deliveryZoneRequest.findMany({
      where: { tenantId: tenantA },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((row) => row.applicationOutcome)).toEqual([
      'PROVIDER_ACCEPTED',
      null,
    ]);
  });

  it('rejects as DENIED and answers later intakes immediately from the zone', async () => {
    const a = (await intake(botA, intakeBody()).expect(201)).body as BotBody;
    await resolve(validatorA, a.decisionId as string, {
      expectedVersion: 1,
      resolutionRequestId: randomUUID(),
      action: 'REJECT_DELIVERY_ZONE',
    }).expect(200);

    const late = (await intake(botA, intakeBody()).expect(201)).body as BotBody;
    expect(late).toMatchObject({
      status: 'RESOLVED',
      version: 2,
      decisionId: null,
      resolution: { source: 'EXISTING_ZONE', zoneType: 'DENIED' },
    });
    expect(late.resolution).not.toHaveProperty('surchargeCents');
    expect(late.resolution).not.toHaveProperty('etaDays');
    expect(
      await worldPrisma().deliveryZoneValidation.count({
        where: { tenantId: tenantA },
      }),
    ).toBe(1);
  });

  it('rejects a bad resolve body (400) and requires DeliveryZone:validate (403)', async () => {
    const a = (await intake(botA, intakeBody()).expect(201)).body as BotBody;
    const decisionId = a.decisionId as string;
    await resolve(validatorA, decisionId, {
      expectedVersion: 1,
      resolutionRequestId: randomUUID(),
      action: 'APPROVE_DELIVERY_ZONE',
      zoneType: 'DENIED',
    }).expect(400);
    await resolve(validatorA, decisionId, {
      expectedVersion: 1,
      resolutionRequestId: randomUUID(),
      action: 'APPROVE_DELIVERY_ZONE',
      zoneType: 'SURCHARGE',
      etaDays: 2,
    }).expect(400);
    await pending(readerA).expect(403);
    await resolve(readerA, decisionId, {
      expectedVersion: 1,
      resolutionRequestId: randomUUID(),
      action: 'REJECT_DELIVERY_ZONE',
    }).expect(403);
    const row = await worldPrisma().deliveryZoneValidation.findUniqueOrThrow({
      where: { id: decisionId },
    });
    expect(row.status).toBe('PENDING');
  });

  it('isolates tenants across intake, poll, list and resolve', async () => {
    const a = (await intake(botA, intakeBody()).expect(201)).body as BotBody;
    await poll(botB, a.id).expect(404);
    const listB = await pending(validatorB).expect(200);
    expect((listB.body as { data: unknown[] }).data).toEqual([]);
    const foreign = await resolve(validatorB, a.decisionId as string, {
      expectedVersion: 1,
      resolutionRequestId: randomUUID(),
      action: 'REJECT_DELIVERY_ZONE',
    }).expect(404);
    expect((foreign.body as { code: string }).code).toBe(
      'DELIVERY_ZONE_VALIDATION_NOT_FOUND',
    );
    // The same postal code in tenant B opens its own validation.
    const b = (await intake(botB, intakeBody()).expect(201)).body as BotBody;
    expect(b.decisionId).not.toBe(a.decisionId);
  });

  it('keeps RESTOCK intake and poll unchanged next to DELIVERY_ZONE rows', async () => {
    await intake(botA, intakeBody()).expect(201);
    const restock = {
      sourceRequestId: randomUUID(),
      type: 'RESTOCK',
      productId: randomUUID(),
      productName: 'Cafe de altura',
      variantId: null,
      sku: 'SKU-1',
      requestedQuantity: 3,
      observedStockAtRequest: 5,
      stockObservedAt: '2026-06-01T10:00:00.000Z',
      supersedesDecisionId: null,
    };
    const created = await intake(botA, restock).expect(201);
    const receipt = created.body as Record<string, unknown>;
    expect(Object.keys(receipt).sort()).toEqual([
      'applyBefore',
      'createdAt',
      'id',
      'resolution',
      'snapshot',
      'sourceRequestId',
      'status',
      'supersedesDecisionId',
      'type',
      'version',
    ]);
    expect(receipt.type).toBe('RESTOCK');
    const polled = await poll(botA, receipt.id as string).expect(200);
    expect((polled.body as { type: string }).type).toBe('RESTOCK');
    expect(
      await worldPrisma().humanDecision.count({ where: { tenantId: tenantA } }),
    ).toBe(1);
  });
});
