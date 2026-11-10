/**
 * human-intervention / unit 5, slice 5a — the bot's create and customer cancel
 * against real PostgreSQL (contract §3.2, §3.4, §3.5, §6.4):
 *   - create per subtype, the wrapped ones through the legacy intake and its
 *     unit-3 hook (exactly one wrapper);
 *   - dedup merge, the merge race and idempotent replay;
 *   - CUSTOMER_OPEN_LIMIT (20, `{limit, open}`) and the hourly creation limit;
 *   - customer cancel per kind, the §2.1 invariant (`--check`) and tenant
 *     boundaries;
 *   - 20 parallel creates and cancels on one customer: no deadlock.
 *
 * Every call runs in its own nestjs-cls ALS context and its own interactive
 * transaction on one shared pool, like concurrent HTTP requests.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { ClsService } from 'nestjs-cls';
import { integrationPrisma } from '../../test/integration/reset-db';
import { PrismaDeliveryZoneBotRepository } from '../delivery-zones/infrastructure/prisma-delivery-zone-bot.repository';
import { PrismaExpirationIntakeRepository } from '../human-decisions/infrastructure/prisma-expiration-intake.repository';
import { PrismaRestockIntakeRepository } from '../human-decisions/infrastructure/prisma-restock-intake.repository';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import {
  BotRequestIntakeService,
  type BotCreateResult,
} from './application/bot-request-intake.service';
import { ChatbotRequestCommandError } from './application/chatbot-request-commands.service';
import { checkInvariant } from './infrastructure/chatbot-request-backfill';
import type { IntakeLimits } from './infrastructure/chatbot-request-intake-writes';
import { ChatbotRequestWrapper } from './infrastructure/chatbot-request-wrapper';
import { LegacyIntakeAdapter } from './infrastructure/legacy-intake.adapter';
import { PrismaBotIntakeStore } from './infrastructure/prisma-bot-intake.store';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

const DEADLOCK_GUARD_MS = 20_000;
const CRED = 'cred-bot-1';
const PHONE = { phoneCountryCode: '52', phone: '5512345678' };
const KEY = '525512345678';

describeIfDb('bot request intake (PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const cls = new ClsService<TenantClsStore>(
    new AsyncLocalStorage<TenantClsStore>(),
  );
  const tenantPrisma = new TenantPrismaService(
    prisma as unknown as ConstructorParameters<typeof TenantPrismaService>[0],
    cls,
  );
  const wrapper = new ChatbotRequestWrapper(tenantPrisma);
  const store = new PrismaBotIntakeStore(tenantPrisma);
  const legacy = new LegacyIntakeAdapter(
    new PrismaRestockIntakeRepository(tenantPrisma, wrapper),
    new PrismaExpirationIntakeRepository(tenantPrisma, wrapper),
    new PrismaDeliveryZoneBotRepository(tenantPrisma, wrapper),
  );
  const serviceWith = (limits?: IntakeLimits) =>
    new BotRequestIntakeService(store, legacy, wrapper, limits);
  const service = serviceWith();
  const tenants: string[] = [];

  const inTenant = <T>(tenantId: string, work: () => Promise<T>) =>
    cls.runWith({ tenantId, userId: 'test', isSuperAdmin: false }, work);

  async function newTenant(): Promise<string> {
    const id = randomUUID();
    tenants.push(id);
    await prisma.tenant.create({
      data: { id, name: 'Sucursal Centro', slug: `cr-bot-${id}` },
    });
    return id;
  }

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
  });

  const direct = (over: Record<string, unknown> = {}) => ({
    sourceRequestId: randomUUID(),
    subtype: 'UNKNOWN_QUESTION',
    customer: PHONE,
    conversationRef: 'wa:5215512345678',
    lastCustomerMessageAt: '2026-11-09T16:02:11.000Z',
    summary: '¿El shampoo X sirve para cachorros?',
    needs: 'Pregunta si es apto.',
    context: { productIds: ['p1'] },
    triggerWaMessageId: 'wamid.1',
    ...over,
  });

  const create = (
    tenantId: string,
    body: { sourceRequestId: string; [key: string]: unknown },
    svc = service,
  ): Promise<BotCreateResult> =>
    inTenant(tenantId, () =>
      svc.create({
        credentialId: CRED,
        idempotencyKey: body.sourceRequestId,
        body,
      }),
    );

  const cancel = (
    tenantId: string,
    requestId: string,
    over: { key?: string; reason?: string } = {},
  ) =>
    inTenant(tenantId, () =>
      service.cancel({
        credentialId: CRED,
        idempotencyKey: over.key ?? randomUUID(),
        requestId,
        body: {
          reason: over.reason ?? 'CUSTOMER_WITHDREW',
          triggerWaMessageId: 'wamid.cancel',
        },
      }),
    );

  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: unknown) => {
        if (error instanceof ChatbotRequestCommandError) return error;
        throw error;
      },
    );

  const guarded = <T>(promise: Promise<T>) =>
    Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('possible deadlock: no result')),
          DEADLOCK_GUARD_MS,
        ),
      ),
    ]);

  const requestsOf = (tenantId: string, where: Record<string, unknown> = {}) =>
    prisma.chatbotRequest.findMany({
      where: { tenantId, ...where },
      orderBy: { folio: 'asc' },
    });
  const eventsOf = (requestId: string) =>
    prisma.chatbotRequestEvent.findMany({
      where: { requestId },
      orderBy: { createdAt: 'asc' },
    });
  const group = (tenantId: string, customerKey: string) =>
    prisma.chatbotCustomerGroup.findUnique({
      where: { tenantId_customerKey: { tenantId, customerKey } },
    });

  /** Open requests seeded straight into the table, like earlier intakes. */
  async function seedRequests(
    tenantId: string,
    count: number,
    over: Record<string, unknown> = {},
  ) {
    await prisma.chatbotRequest.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        tenantId,
        folio: 1000 + i + Math.floor(Math.random() * 1e6),
        kind: 'CLARIFICATION' as const,
        subtype: 'UNKNOWN_QUESTION' as const,
        customerKey: KEY,
        summary: `seed ${i}`,
        source: 'seed',
        sourceRequestId: randomUUID(),
        ...over,
      })),
    });
    await inTenant(tenantId, () =>
      tenantPrisma.runInTransaction(async () => {
        const { refreshCustomerGroup } =
          await import('./infrastructure/chatbot-request-writes');
        await refreshCustomerGroup(tenantPrisma.getClient(), tenantId, KEY);
      }),
    );
  }

  // ------------------------------------------------------------ create

  describe('create per subtype', () => {
    it.each([
      ['UNKNOWN_QUESTION', 'CLARIFICATION'],
      ['TALK_TO_HUMAN', 'CONVERSATION'],
      ['COMPLAINT', 'CONVERSATION'],
    ])('creates %s as a %s request', async (subtype, kind) => {
      const tenantId = await newTenant();
      const body = direct({ subtype, dedupKey: `${subtype}:a` });

      const result = await create(tenantId, body);

      expect(result.httpStatus).toBe(201);
      expect(result.body).toMatchObject({
        status: 'NEW',
        outcome: 'CREATED',
        mergedIntoId: null,
        folio: 'S-000001',
      });
      const [request] = await requestsOf(tenantId);
      expect(request).toMatchObject({
        id: result.body.id,
        kind,
        subtype,
        status: 'NEW',
        version: 1,
        customerKey: KEY,
        phoneCountryCode: '52',
        phone: '5512345678',
        conversationRef: 'wa:5215512345678',
        summary: '¿El shampoo X sirve para cachorros?',
        needs: 'Pregunta si es apto.',
        dedupKey: `${subtype}:a`,
        source: 'houndfe-chatbot',
        sourceRequestId: body.sourceRequestId,
        submittedCredentialId: CRED,
        folio: 1,
      });
      expect(request.canonicalRequestHash).toHaveLength(64);
      expect(request.context).toEqual({ productIds: ['p1'] });
      expect(request.whatsappWindowClosesAt?.toISOString()).toBe(
        '2026-11-10T16:02:11.000Z',
      );
      expect(await eventsOf(request.id)).toEqual([
        expect.objectContaining({
          type: 'CREATED',
          actorKind: 'SERVICE',
          actorId: CRED,
          toStatus: 'NEW',
          version: 1,
          data: {
            subtype,
            sourceRequestId: body.sourceRequestId,
            triggerWaMessageId: 'wamid.1',
          },
        }),
      ]);
      expect(await group(tenantId, KEY)).toMatchObject({ openCount: 1 });
    });

    it('links the only matching customer and flags an ambiguous number', async () => {
      const tenantId = await newTenant();
      const other = await newTenant();
      const only = await prisma.customer.create({
        data: {
          tenantId,
          firstName: 'Ana',
          phoneCountryCode: '521',
          phone: '5512345678',
        },
      });
      await prisma.customer.create({
        data: {
          tenantId: other,
          firstName: 'Otra',
          phoneCountryCode: '52',
          phone: '5512345678',
        },
      });

      await create(tenantId, direct());
      expect((await requestsOf(tenantId))[0]).toMatchObject({
        customerId: only.id,
        ambiguousCustomer: false,
      });

      await prisma.customer.create({
        data: {
          tenantId: other,
          firstName: 'Otra2',
          phoneCountryCode: '52',
          phone: '5512345678',
        },
      });
      await create(other, direct());
      expect((await requestsOf(other))[0]).toMatchObject({
        customerId: null,
        ambiguousCustomer: true,
      });
    });

    it('refuses a scheduled conversation and a receipt without writing', async () => {
      const tenantId = await newTenant();

      expect(
        (
          await failure(
            create(
              tenantId,
              direct({ scheduledFor: '2026-11-12T15:00:00.000Z' }),
            ),
          )
        )?.code,
      ).toBe('SCHEDULING_DISABLED');
      expect(
        (
          await failure(
            create(tenantId, {
              sourceRequestId: randomUUID(),
              subtype: 'TRANSFER_RECEIPT',
            }),
          )
        )?.code,
      ).toBe('SUBTYPE_DISABLED');
      expect(await requestsOf(tenantId)).toEqual([]);
    });
  });

  describe('wrapped subtypes (legacy intake + hook)', () => {
    const restock = (id: string, over: Record<string, unknown> = {}) => ({
      sourceRequestId: id,
      subtype: 'RESTOCK',
      detail: {
        sourceRequestId: id,
        type: 'RESTOCK',
        productId: randomUUID(),
        productName: 'Croquetas 20 kg',
      },
      ...over,
    });

    it('wraps a RESTOCK exactly once with the envelope applied', async () => {
      const tenantId = await newTenant();
      const id = randomUUID();
      const body = restock(id, {
        customer: PHONE,
        summary: 'Stock de croquetas',
        dedupKey: 'RESTOCK:variant:1',
        conversationRef: 'wa:5215512345678',
      });

      const result = await create(tenantId, body);

      expect(result.httpStatus).toBe(201);
      expect(result.body).toMatchObject({
        outcome: 'CREATED',
        status: 'NEW',
        folio: 'S-000001',
        legacy: { id: expect.any(String) as string, status: 'PENDING' },
      });
      const requests = await requestsOf(tenantId);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        id: result.body.id,
        subtype: 'RESTOCK',
        kind: 'DECISION',
        source: 'WRAP:HUMAN_DECISION',
        customerKey: KEY,
        summary: 'Stock de croquetas',
        dedupKey: 'RESTOCK:variant:1',
        submittedCredentialId: CRED,
        conversationRef: 'wa:5215512345678',
      });
      expect(requests[0].canonicalRequestHash).toHaveLength(64);
      expect(requests[0].humanDecisionId).toBe(
        (result.body.legacy as { id: string }).id,
      );
      expect(await eventsOf(requests[0].id)).toEqual([
        expect.objectContaining({
          type: 'CREATED',
          actorKind: 'SERVICE',
          actorId: CRED,
        }),
      ]);
      expect(await group(tenantId, KEY)).toMatchObject({ openCount: 1 });
    });

    it('replays by the legacy identity and conflicts when the envelope changes', async () => {
      const tenantId = await newTenant();
      const id = randomUUID();
      const body = restock(id, { customer: PHONE });
      const first = await create(tenantId, body);

      const again = await create(tenantId, body);
      expect(again.httpStatus).toBe(200);
      expect(again.body).toMatchObject({
        id: first.body.id,
        outcome: 'REPLAYED',
      });
      expect(
        (await failure(create(tenantId, { ...body, summary: 'otro' })))?.code,
      ).toBe('IDEMPOTENCY_CONFLICT');
      expect(await requestsOf(tenantId)).toHaveLength(1);
      expect(await prisma.humanDecision.count({ where: { tenantId } })).toBe(1);
    });

    it('wraps an EXPIRATION through its own parser', async () => {
      const tenantId = await newTenant();
      const product = await prisma.product.create({
        data: { tenantId, name: 'Pastilla antipulgas' },
      });
      const id = randomUUID();

      const result = await create(tenantId, {
        sourceRequestId: id,
        subtype: 'EXPIRATION',
        detail: {
          sourceRequestId: id,
          type: 'EXPIRATION',
          productId: product.id,
          variantId: null,
        },
      });

      expect(result.body.outcome).toBe('CREATED');
      expect(await requestsOf(tenantId)).toEqual([
        expect.objectContaining({
          subtype: 'EXPIRATION',
          summary: 'Caducidad: Pastilla antipulgas',
        }),
      ]);
    });

    it('wraps a zone requester under the customer of its own detail', async () => {
      const tenantId = await newTenant();
      const id = randomUUID();
      const zone = (zipCode: string, sourceRequestId: string) => ({
        sourceRequestId,
        subtype: 'DELIVERY_ZONE',
        customer: PHONE,
        dedupKey: `DELIVERY_ZONE:${zipCode}`,
        detail: {
          sourceRequestId,
          type: 'DELIVERY_ZONE',
          zipCode,
          state: 'Nuevo León',
          municipality: 'Monterrey',
          neighborhood: 'Centro',
          phoneCountryCode: '52',
          phone: '5512345678',
          conversationRef: 'wa:5215512345678',
          lastCustomerMessageAt: new Date().toISOString(),
        },
      });

      const first = await create(tenantId, zone('64000', id));
      expect(first.body).toMatchObject({ outcome: 'CREATED', status: 'NEW' });
      const [request] = await requestsOf(tenantId);
      expect(request).toMatchObject({
        subtype: 'DELIVERY_ZONE',
        customerKey: KEY,
        conversationRef: 'wa:5215512345678',
        dedupKey: 'DELIVERY_ZONE:64000',
      });
      expect(request.deliveryZoneRequestId).not.toBeNull();

      // The same customer asking again for the postal code merges.
      const second = await create(tenantId, zone('64000', randomUUID()));
      expect(second.body).toMatchObject({ outcome: 'MERGED', id: request.id });
      expect(
        await prisma.deliveryZoneRequest.count({ where: { tenantId } }),
      ).toBe(1);

      // A zone that already exists has no request to wrap (§2.3).
      await prisma.deliveryZone.create({
        data: {
          tenantId,
          zipCode: '66000',
          type: 'FREE',
          etaDays: 2,
          approvedById: 'u',
          approvedByDisplayName: 'U',
          approvedAt: new Date(),
        },
      });
      const known = await create(tenantId, zone('66000', randomUUID()));
      expect(known.body).toMatchObject({
        id: null,
        status: 'RESOLVED',
        outcome: 'CREATED',
      });
      expect(await requestsOf(tenantId)).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------- merge

  describe('dedup merge (§3.5)', () => {
    it('merges a repeated question into the open request and replays the merge', async () => {
      const tenantId = await newTenant();
      const first = await create(tenantId, direct({ dedupKey: 'UQ:p1' }));
      const repeat = direct({
        dedupKey: 'UQ:p1',
        lastCustomerMessageAt: '2026-11-09T18:00:00.000Z',
      });

      const merged = await create(tenantId, repeat);

      expect(merged.httpStatus).toBe(200);
      expect(merged.body).toMatchObject({
        id: first.body.id,
        outcome: 'MERGED',
        mergedIntoId: first.body.id,
      });
      expect(await requestsOf(tenantId)).toHaveLength(1);
      const events = await eventsOf(first.body.id as string);
      expect(events.map((event) => event.type)).toEqual(['CREATED', 'MERGED']);
      expect(events[1]).toMatchObject({
        actorKind: 'SERVICE',
        version: 1,
        data: { sourceRequestId: repeat.sourceRequestId },
      });
      const [request] = await requestsOf(tenantId);
      expect(request.whatsappWindowClosesAt?.toISOString()).toBe(
        '2026-11-10T18:00:00.000Z',
      );
      expect(request.version).toBe(1);

      // The merge key replays, even after the request is closed.
      await prisma.chatbotRequest.update({
        where: { id: request.id },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          closedAt: new Date(),
          resolvedByActorId: 'u',
          resolvedByDisplayName: 'U',
        },
      });
      const replay = await create(tenantId, repeat);
      expect(replay).toEqual(merged);
      expect(
        (await failure(create(tenantId, { ...repeat, summary: 'otro' })))?.code,
      ).toBe('IDEMPOTENCY_CONFLICT');
      expect(await requestsOf(tenantId)).toHaveLength(1);
    });

    it('does not merge across customers, tenants or closed requests', async () => {
      const tenantId = await newTenant();
      const other = await newTenant();
      await create(tenantId, direct({ dedupKey: 'UQ:p1' }));

      const otherCustomer = await create(
        tenantId,
        direct({
          dedupKey: 'UQ:p1',
          customer: { phoneCountryCode: '52', phone: '5587654321' },
        }),
      );
      const otherTenant = await create(other, direct({ dedupKey: 'UQ:p1' }));

      expect(otherCustomer.body.outcome).toBe('CREATED');
      expect(otherTenant.body.outcome).toBe('CREATED');
      await prisma.chatbotRequest.updateMany({
        where: { tenantId, customerKey: KEY },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelReason: 'STAFF',
          staffCancelReason: 'DUPLICATE',
          closedAt: new Date(),
        },
      });
      const reopened = await create(tenantId, direct({ dedupKey: 'UQ:p1' }));
      expect(reopened.body.outcome).toBe('CREATED');
    });

    it('merges a repeated wrapped request and leaves no second wrapped row', async () => {
      const tenantId = await newTenant();
      const make = () => {
        const id = randomUUID();
        return {
          sourceRequestId: id,
          subtype: 'RESTOCK',
          customer: PHONE,
          dedupKey: 'RESTOCK:variant:9',
          detail: {
            sourceRequestId: id,
            type: 'RESTOCK',
            productId: randomUUID(),
            productName: 'Arena',
          },
        };
      };
      const first = await create(tenantId, make());

      const second = make();
      const merged = await create(tenantId, second);

      expect(merged.body).toMatchObject({
        outcome: 'MERGED',
        id: first.body.id,
        status: 'NEW',
      });
      expect(await requestsOf(tenantId)).toHaveLength(1);
      expect(await prisma.humanDecision.count({ where: { tenantId } })).toBe(1);
      expect((await create(tenantId, second)).body).toEqual(merged.body);
    });
  });

  describe('races', () => {
    it('two identical creates at once: one request, one CREATED, one REPLAYED', async () => {
      const tenantId = await newTenant();
      const body = direct({ dedupKey: 'UQ:same' });

      const results = await guarded(
        Promise.all([create(tenantId, body), create(tenantId, body)]),
      );

      expect(results.map((r) => r.body.outcome).sort()).toEqual([
        'CREATED',
        'REPLAYED',
      ]);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(await requestsOf(tenantId)).toHaveLength(1);
      expect(
        await prisma.chatbotRequestEvent.count({ where: { tenantId } }),
      ).toBe(1);
    });

    it('two creates with one dedup key at once: one request and one MERGED event', async () => {
      const tenantId = await newTenant();

      const results = await guarded(
        Promise.all([
          create(tenantId, direct({ dedupKey: 'UQ:race' })),
          create(tenantId, direct({ dedupKey: 'UQ:race' })),
        ]),
      );

      expect(results.map((r) => r.body.outcome).sort()).toEqual([
        'CREATED',
        'MERGED',
      ]);
      const requests = await requestsOf(tenantId);
      expect(requests).toHaveLength(1);
      const events = await eventsOf(requests[0].id);
      expect(events.map((event) => event.type).sort()).toEqual([
        'CREATED',
        'MERGED',
      ]);
      expect(await group(tenantId, KEY)).toMatchObject({ openCount: 1 });
    });

    it('two wrapped creates with one dedup key at once: one request, one decision', async () => {
      const tenantId = await newTenant();
      const make = () => {
        const id = randomUUID();
        return {
          sourceRequestId: id,
          subtype: 'RESTOCK',
          customer: PHONE,
          dedupKey: 'RESTOCK:variant:race',
          detail: {
            sourceRequestId: id,
            type: 'RESTOCK',
            productId: randomUUID(),
            productName: 'Pienso',
          },
        };
      };

      const results = await guarded(
        Promise.all([create(tenantId, make()), create(tenantId, make())]),
      );

      expect(results.map((r) => r.body.outcome).sort()).toEqual([
        'CREATED',
        'MERGED',
      ]);
      expect(await requestsOf(tenantId)).toHaveLength(1);
      expect(await prisma.humanDecision.count({ where: { tenantId } })).toBe(1);
    });

    it('never passes the open limit under concurrency: 5 creates at 19 open, one wins', async () => {
      const tenantId = await newTenant();
      await seedRequests(tenantId, 19);
      const limits = { openLimit: 20, creationsPerHour: 100 };

      const results = await guarded(
        Promise.all(
          Array.from({ length: 5 }, (_, i) =>
            failure(
              create(
                tenantId,
                direct({ summary: `carrera ${i}` }),
                serviceWith(limits),
              ),
            ),
          ),
        ),
      );

      expect(results.filter((error) => error === null)).toHaveLength(1);
      expect(
        results.filter((error) => error?.code === 'CUSTOMER_OPEN_LIMIT'),
      ).toHaveLength(4);
      expect(await prisma.chatbotRequest.count({ where: { tenantId } })).toBe(
        20,
      );
      expect(await group(tenantId, KEY)).toMatchObject({ openCount: 20 });
    });

    it('20 parallel creates for one customer all land, in distinct folios, with no deadlock', async () => {
      const tenantId = await newTenant();
      const roomy = serviceWith({ openLimit: 50, creationsPerHour: 100 });

      const results = await guarded(
        Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            create(tenantId, direct({ summary: `pregunta ${i}` }), roomy),
          ),
        ),
      );

      expect(results.every((r) => r.body.outcome === 'CREATED')).toBe(true);
      const requests = await requestsOf(tenantId);
      expect(requests.map((r) => r.folio)).toEqual(
        Array.from({ length: 20 }, (_, i) => i + 1),
      );
      expect(await group(tenantId, KEY)).toMatchObject({ openCount: 20 });
    });

    it('creates, merges and cancels on one customer in parallel without deadlock', async () => {
      const tenantId = await newTenant();
      const roomy = serviceWith({ openLimit: 50, creationsPerHour: 100 });
      const existing = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          create(tenantId, direct({ summary: `previa ${i}` }), roomy),
        ),
      );

      const results = await guarded(
        Promise.all([
          ...existing.map((r) => cancel(tenantId, r.body.id as string)),
          ...Array.from({ length: 10 }, (_, i) =>
            create(tenantId, direct({ dedupKey: `UQ:${i % 3}` }), roomy),
          ),
        ]),
      );

      expect(results).toHaveLength(15);
      const open = await prisma.chatbotRequest.count({
        where: { tenantId, status: { in: ['NEW', 'IN_PROGRESS'] } },
      });
      expect(open).toBe(3);
      expect(await group(tenantId, KEY)).toMatchObject({ openCount: 3 });
    });
  });

  // ------------------------------------------------------------ limits

  describe('limits (§6.4)', () => {
    it('answers CUSTOMER_OPEN_LIMIT {limit, open} at 20 open requests, but still merges', async () => {
      const tenantId = await newTenant();
      await seedRequests(tenantId, 19);
      await create(
        tenantId,
        direct({ dedupKey: 'UQ:open' }),
        serviceWith({ openLimit: 20, creationsPerHour: 100 }),
      );

      const error = await failure(
        create(
          tenantId,
          direct(),
          serviceWith({ openLimit: 20, creationsPerHour: 100 }),
        ),
      );

      expect(error).toMatchObject({
        code: 'CUSTOMER_OPEN_LIMIT',
        httpStatus: 409,
        extra: { limit: 20, open: 20 },
      });
      const merged = await create(
        tenantId,
        direct({ dedupKey: 'UQ:open' }),
        serviceWith({ openLimit: 20, creationsPerHour: 100 }),
      );
      expect(merged.body.outcome).toBe('MERGED');
      expect(await prisma.chatbotRequest.count({ where: { tenantId } })).toBe(
        20,
      );
      // the rejected create burned no folio
      const next = await prisma.chatbotRequestFolioCounter.findUnique({
        where: { tenantId },
      });
      expect(next?.lastNumber).toBe(1);
    });

    it('counts the limit across subtypes and per customer', async () => {
      const tenantId = await newTenant();
      await seedRequests(tenantId, 20, {
        subtype: 'COMPLAINT',
        kind: 'CONVERSATION',
      });

      expect((await failure(create(tenantId, direct())))?.code).toBe(
        'CUSTOMER_OPEN_LIMIT',
      );
      const other = await create(
        tenantId,
        direct({ customer: { phoneCountryCode: '52', phone: '5587654321' } }),
      );
      expect(other.body.outcome).toBe('CREATED');
    });

    it('answers CUSTOMER_RATE_LIMITED after 10 creations in an hour, counted in the database', async () => {
      const tenantId = await newTenant();
      await seedRequests(tenantId, 10, {
        status: 'RESOLVED',
        resolvedAt: new Date(),
        closedAt: new Date(),
        resolvedByActorId: 'u',
        resolvedByDisplayName: 'U',
      });

      const error = await failure(create(tenantId, direct()));

      expect(error).toMatchObject({
        code: 'CUSTOMER_RATE_LIMITED',
        httpStatus: 429,
      });
      expect(error?.extra).toMatchObject({ limit: 10 });
      expect(error?.extra?.retryAfterSeconds).toBeGreaterThan(0);
      expect(error?.extra?.retryAfterSeconds).toBeLessThanOrEqual(3600);

      // creations older than an hour do not count
      await prisma.chatbotRequest.updateMany({
        where: { tenantId },
        data: { createdAt: new Date(Date.now() - 2 * 3_600_000) },
      });
      expect((await create(tenantId, direct())).body.outcome).toBe('CREATED');
    });

    it('rolls a wrapped create back when the limit trips: no decision, no folio', async () => {
      const tenantId = await newTenant();
      await seedRequests(tenantId, 20);
      const id = randomUUID();

      const error = await failure(
        create(tenantId, {
          sourceRequestId: id,
          subtype: 'RESTOCK',
          customer: PHONE,
          detail: {
            sourceRequestId: id,
            type: 'RESTOCK',
            productId: randomUUID(),
            productName: 'Arena',
          },
        }),
      );

      expect(error?.code).toBe('CUSTOMER_OPEN_LIMIT');
      expect(await prisma.humanDecision.count({ where: { tenantId } })).toBe(0);
    });
  });

  // ------------------------------------------------------------ cancel

  describe('customer cancel (§3.4)', () => {
    it.each([
      ['a clarification', 'UNKNOWN_QUESTION'],
      ['a conversation not yet started', 'TALK_TO_HUMAN'],
    ])('cancels %s and clears its group', async (_label, subtype) => {
      const tenantId = await newTenant();
      const made = await create(tenantId, direct({ subtype }));

      const result = await cancel(tenantId, made.body.id as string, {
        reason: 'AUTO_RESOLVED',
      });

      expect(result).toMatchObject({
        id: made.body.id,
        status: 'CANCELLED',
        reason: 'AUTO_RESOLVED',
      });
      const [request] = await requestsOf(tenantId);
      expect(request).toMatchObject({
        status: 'CANCELLED',
        cancelReason: 'AUTO_RESOLVED',
        version: 2,
      });
      expect(request.cancelledAt).not.toBeNull();
      expect(request.closedAt).not.toBeNull();
      const events = await eventsOf(request.id);
      expect(events[1]).toMatchObject({
        type: 'CANCELLED',
        actorKind: 'SERVICE',
        actorId: CRED,
        fromStatus: 'NEW',
        toStatus: 'CANCELLED',
        data: { reason: 'AUTO_RESOLVED', triggerWaMessageId: 'wamid.cancel' },
      });
      expect(await group(tenantId, KEY)).toBeNull();
    });

    it('cancels a claimed request (IN_PROGRESS) too', async () => {
      const tenantId = await newTenant();
      const made = await create(tenantId, direct());
      await prisma.chatbotRequest.update({
        where: { id: made.body.id as string },
        data: {
          status: 'IN_PROGRESS',
          assigneeUserId: 'u',
          assigneeDisplayName: 'U',
          claimedAt: new Date(),
        },
      });

      expect((await cancel(tenantId, made.body.id as string)).status).toBe(
        'CANCELLED',
      );
    });

    it('closes only the common request of a wrapped decision and keeps the invariant', async () => {
      const tenantId = await newTenant();
      const id = randomUUID();
      const made = await create(tenantId, {
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

      await cancel(tenantId, made.body.id as string);

      const decision = await prisma.humanDecision.findFirstOrThrow({
        where: { tenantId },
      });
      expect(decision).toMatchObject({ status: 'PENDING', version: 1 });
      const [check] = (await checkInvariant(prisma, { tenantIds: [tenantId] }))
        .tenants;
      expect(check.mismatches).toEqual([]);
      expect(await group(tenantId, KEY)).toBeNull();
    });

    it('closes a zone requester under the postal-code lock and bumps the set version', async () => {
      const tenantId = await newTenant();
      const id = randomUUID();
      const made = await create(tenantId, {
        sourceRequestId: id,
        subtype: 'DELIVERY_ZONE',
        detail: {
          sourceRequestId: id,
          type: 'DELIVERY_ZONE',
          zipCode: '64000',
          state: 'Nuevo León',
          municipality: 'Monterrey',
          neighborhood: 'Centro',
          phoneCountryCode: '52',
          phone: '5512345678',
          conversationRef: 'wa:5215512345678',
          lastCustomerMessageAt: new Date().toISOString(),
        },
      });
      const before = await prisma.chatbotRequest.findUniqueOrThrow({
        where: { id: made.body.id as string },
      });

      await guarded(cancel(tenantId, made.body.id as string));

      expect(
        await prisma.deliveryZoneRequest.findFirstOrThrow({
          where: { tenantId },
        }),
      ).toMatchObject({ status: 'PENDING' });
      expect(before.customerKey).toBe(KEY);
      const [check] = (await checkInvariant(prisma, { tenantIds: [tenantId] }))
        .tenants;
      expect(check.mismatches).toEqual([]);
    });

    it('answers ALREADY_RESOLVED with the answer, and REQUEST_CLOSED once cancelled', async () => {
      const tenantId = await newTenant();
      const made = await create(tenantId, direct());
      const requestId = made.body.id as string;
      await prisma.chatbotRequest.update({
        where: { id: requestId },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          closedAt: new Date(),
          resolvedByActorId: 'u',
          resolvedByDisplayName: 'U',
          resolution: { action: 'REPLY', text: 'Sí, desde las 8 semanas.' },
        },
      });

      const resolved = await failure(cancel(tenantId, requestId));
      expect(resolved).toMatchObject({
        code: 'ALREADY_RESOLVED',
        httpStatus: 409,
        extra: {
          resolution: { action: 'REPLY', text: 'Sí, desde las 8 semanas.' },
        },
      });

      const second = await create(
        tenantId,
        direct({ customer: { phoneCountryCode: '52', phone: '5587654321' } }),
      );
      await cancel(tenantId, second.body.id as string);
      expect(
        (await failure(cancel(tenantId, second.body.id as string)))?.code,
      ).toBe('REQUEST_CLOSED');
    });

    it('replays the same key, conflicts on another body, and 404s a foreign id', async () => {
      const tenantId = await newTenant();
      const other = await newTenant();
      const made = await create(tenantId, direct());
      const requestId = made.body.id as string;
      const key = randomUUID();

      const first = await cancel(tenantId, requestId, { key });
      const replay = await cancel(tenantId, requestId, { key });
      expect(replay).toEqual(first);
      expect(
        (
          await failure(
            cancel(tenantId, requestId, { key, reason: 'AUTO_RESOLVED' }),
          )
        )?.code,
      ).toBe('IDEMPOTENCY_CONFLICT');
      expect(
        (await eventsOf(requestId)).filter((e) => e.type === 'CANCELLED'),
      ).toHaveLength(1);

      const foreign = await create(other, direct());
      expect(
        (await failure(cancel(tenantId, foreign.body.id as string)))?.code,
      ).toBe('NOT_FOUND');
      expect(
        (
          await prisma.chatbotRequest.findUniqueOrThrow({
            where: { id: foreign.body.id as string },
          })
        ).status,
      ).toBe('NEW');
      expect((await failure(cancel(tenantId, randomUUID())))?.httpStatus).toBe(
        404,
      );
    });
  });
});
