/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- supertest response bodies are untyped JSON and the query log event is untyped */
/**
 * human-intervention / unit 9, S12 — `unreadCustomerMessages` against REAL
 * PostgreSQL, through HTTP.
 *
 * Owner decision (verbatim in odd/tasks/human-intervention.md S12): the counter
 * of a request's row is the number of CUSTOMER messages of its conversation
 * since the last time ANY staff member opened the conversation, and it goes to
 * 0 for everyone on open. An assignee who only gets the empty page (no
 * `read:ChatbotConversation`) did not open anything.
 *
 *   - counts customer messages only (bot and staff messages never count);
 *   - every row of the inbox (groups, by-customer list, detail) agrees;
 *   - opening the conversation resets it for every staff member;
 *   - reading an older page, or an empty page, never marks newer messages read;
 *   - the empty page of an assignee without the permission resets nothing;
 *   - the marker is durable (the row, not memory) and per conversation;
 *   - realtime: a customer message and an open both log `request.updated` for
 *     every open request of the chat, so the row the stream builds carries the
 *     new count;
 *   - no N+1: one statement serves the whole page, whatever its size.
 */
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import { integrationPrisma } from '../../test/integration/reset-db';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { ActiveUserGuard } from '../auth/guards/active-user.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../chatbot-api/domain/service-credential.repository';
import { PrismaServiceCredentialRepository } from '../chatbot-api/infrastructure/prisma-service-credential.repository';
import { BotRateLimitModule } from '../chatbot-api/presentation/guards/bot-rate-limit.module';
import { ServiceAuthGuard } from '../chatbot-api/presentation/guards/service-auth.guard';
import {
  CHATBOT_REQUEST_READ_STORE,
  ChatbotRequestReadsService,
  CUSTOMER_KEY_SEALER,
  INBOX_CLOCK,
} from '../chatbot-requests/application/chatbot-request-reads.service';
import { CustomerKeySealer } from '../chatbot-requests/domain/customer-key-sealer';
import { PrismaChatbotRequestReadStore } from '../chatbot-requests/infrastructure/prisma-chatbot-request-read.store';
import { ChatbotRequestHttpFilter } from '../chatbot-requests/presentation/chatbot-request-http.filter';
import { ChatbotRequestReadsController } from '../chatbot-requests/presentation/chatbot-request-reads.controller';
import { createAppValidationPipe } from '../shared/listing/app-validation.pipe';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { PrismaService } from '../shared/prisma/prisma.service';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import {
  CONVERSATION_MIRROR_STORE,
  ConversationMirrorService,
} from './application/conversation-mirror.service';
import {
  CONVERSATION_READ_STORE,
  ConversationReadsService,
} from './application/conversation-reads.service';
import { PrismaConversationMirrorStore } from './infrastructure/prisma-conversation-mirror.store';
import { PrismaConversationReadStore } from './infrastructure/prisma-conversation-read.store';
import { BotConversationController } from './presentation/bot-conversation.controller';
import { ConversationReadsController } from './presentation/conversation-reads.controller';
import { StubGuard, StubPermissionsGuard } from './test-support/staff-stubs';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

const SECRET = 'integration-secret-of-some-length';
const NOW = () => new Date().toISOString();

describeIfDb('conversation unread counter, S12 (PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const sealer = new CustomerKeySealer(SECRET);
  // The app's own client logs every statement, so the N+1 check reads what the
  // inbox really ran.
  const appPrisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
    log: [{ emit: 'event', level: 'query' }],
  });
  const log: string[] = [];
  (appPrisma as any).$on('query', (event: any) => log.push(event.query));

  let app: INestApplication;
  const tenants: string[] = [];
  const credentials: string[] = [];
  const users = { ana: randomUUID(), luis: randomUUID() };
  let counter = 0;
  let phoneSeq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        DatabaseModule,
        BotRateLimitModule,
      ],
      controllers: [
        BotConversationController,
        ConversationReadsController,
        ChatbotRequestReadsController,
      ],
      providers: [
        ServiceAuthGuard,
        ChatbotRequestHttpFilter,
        ConversationMirrorService,
        ConversationReadsService,
        ChatbotRequestReadsService,
        {
          provide: CONVERSATION_MIRROR_STORE,
          useClass: PrismaConversationMirrorStore,
        },
        {
          provide: CONVERSATION_READ_STORE,
          useClass: PrismaConversationReadStore,
        },
        {
          provide: CHATBOT_REQUEST_READ_STORE,
          useClass: PrismaChatbotRequestReadStore,
        },
        { provide: CUSTOMER_KEY_SEALER, useValue: sealer },
        { provide: INBOX_CLOCK, useValue: () => new Date() },
        {
          provide: SERVICE_CREDENTIAL_REPOSITORY,
          useClass: PrismaServiceCredentialRepository,
        },
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(appPrisma)
      .overrideGuard(JwtAuthGuard)
      .useClass(StubGuard)
      .overrideGuard(TenantContextGuard)
      .useClass(StubGuard)
      .overrideGuard(ActiveUserGuard)
      .useClass(StubGuard)
      .overrideGuard(PermissionsGuard)
      .useClass(StubPermissionsGuard)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    for (const [name, id] of Object.entries(users)) {
      await prisma.user.create({
        data: { id, email: `${id}@unread.test`, hashedPassword: 'x', name },
      });
    }
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await appPrisma.$disconnect();
    await prisma.serviceRateBucket.deleteMany({
      where: { credentialId: { in: credentials } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.user.deleteMany({
      where: { id: { in: Object.values(users) } },
    }); // The shared client would otherwise keep its pool open for the whole run.
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------- helpers

  async function bot() {
    const id = randomUUID();
    tenants.push(id);
    await prisma.tenant.create({
      data: { id, name: 'Sucursal Unread', slug: `cv-unread-${id}` },
    });
    const token = `svc_${randomUUID()}`;
    const credential = await prisma.serviceCredential.create({
      data: {
        tenantId: id,
        name: 'bot',
        hashedKey: createHash('sha256').update(token).digest('hex'),
        scopes: ['conversation:write'],
        rateLimit: 600,
      },
    });
    credentials.push(credential.id);
    return { tenantId: id, token };
  }
  type Bot = Awaited<ReturnType<typeof bot>>;

  const phoneRef = () => `wa:52551234${String(++phoneSeq).padStart(4, '0')}`;
  const keyOf = (ref: string) => ref.slice(3);

  const msg = (over: Record<string, unknown> = {}) => ({
    waMessageId: `wamid.${randomUUID()}`,
    direction: 'IN',
    type: 'TEXT',
    text: 'Hola, ¿tienen croquetas?',
    providerTimestamp: NOW(),
    observedAt: NOW(),
    ...over,
  });
  const outMsg = (over: Record<string, unknown> = {}) =>
    msg({ direction: 'OUT', text: 'Claro que sí', ...over });

  const post = (b: Bot, ref: string, messages: unknown[]) =>
    request(app.getHttpServer())
      .post(
        `/chatbot-api/conversations/${encodeURIComponent(ref)}/messages:batch`,
      )
      .set('Authorization', `Bearer ${b.token}`)
      .set('X-Branch-Id', b.tenantId)
      .send({ messages })
      .expect(200);

  const as = (role: string, tenantId: string, userId = users.ana) => ({
    'x-test-role': role,
    'x-test-tenant': tenantId,
    'x-test-user': userId,
  });
  const get = (
    path: string,
    role: string,
    tenantId: string,
    userId = users.ana,
  ) =>
    request(app.getHttpServer())
      .get(path)
      .set(as(role, tenantId, userId));

  async function openRequest(
    tenantId: string,
    ref: string,
    over: Record<string, unknown> = {},
  ) {
    const row = await prisma.chatbotRequest.create({
      data: {
        tenantId,
        folio: ++counter,
        kind: 'CLARIFICATION',
        subtype: 'UNKNOWN_QUESTION',
        customerKey: keyOf(ref),
        phoneCountryCode: '52',
        phone: keyOf(ref).slice(2),
        conversationRef: ref,
        summary: 'Pregunta',
        source: 'chatbot',
        sourceRequestId: randomUUID(),
        slaPolicyVersion: 0,
        ...over,
      } as never,
      select: { id: true, customerKey: true },
    });
    await prisma.$executeRaw`
      INSERT INTO "chatbot_customer_groups"
        ("tenantId", "customerKey", "openCount", "updatedAt")
      VALUES (${tenantId}, ${row.customerKey}, 1, now())
      ON CONFLICT ("tenantId", "customerKey") DO NOTHING`;
    return row.id;
  }

  const detailUnread = async (
    tenantId: string,
    id: string,
    role = 'manager',
  ): Promise<number> =>
    (await get(`/chatbot-requests/${id}`, role, tenantId).expect(200)).body
      .unreadCustomerMessages;

  const groupUnread = async (
    tenantId: string,
    role = 'manager',
  ): Promise<Map<string, number>> => {
    const res = await get(
      '/chatbot-requests/groups?limit=50',
      role,
      tenantId,
    ).expect(200);
    const out = new Map<string, number>();
    for (const group of res.body.items) {
      for (const row of group.requests) {
        out.set(row.id, row.unreadCustomerMessages);
      }
    }
    return out;
  };

  const open = (
    id: string,
    tenantId: string,
    role = 'cashier',
    userId = users.ana,
    query = '',
  ) =>
    get(`/chatbot-requests/${id}/conversation${query}`, role, tenantId, userId);

  const requestEvents = (tenantId: string) =>
    prisma.$queryRaw<
      Array<{ type: string; requestId: string; payload: any }>
    >`SELECT "type", "requestId", "payload" FROM "realtime_events"
      WHERE "tenantId" = ${tenantId} AND "type" = 'request.updated'
        AND "payload" ->> 'cause' IN ('CUSTOMER_MESSAGE', 'CONVERSATION_READ')
      ORDER BY "id"`;

  // ---------------------------------------------------------------- counts

  it('counts the customer messages only: bot messages never count', async () => {
    const b = await bot();
    const ref = phoneRef();
    const id = await openRequest(b.tenantId, ref);
    expect(await detailUnread(b.tenantId, id)).toBe(0);
    await post(b, ref, [msg(), outMsg(), msg(), outMsg(), outMsg()]);
    expect(await detailUnread(b.tenantId, id)).toBe(2);
  });

  it('the groups row, the by-customer list and the detail agree', async () => {
    const b = await bot();
    const ref = phoneRef();
    const id = await openRequest(b.tenantId, ref);
    await post(b, ref, [msg(), msg(), msg()]);
    expect((await groupUnread(b.tenantId)).get(id)).toBe(3);
    expect(await detailUnread(b.tenantId, id)).toBe(3);
    const sealed = (
      await get('/chatbot-requests/groups', 'manager', b.tenantId).expect(200)
    ).body.items[0].customerKey;
    const list = await get(
      `/chatbot-requests?customerKey=${encodeURIComponent(sealed)}`,
      'manager',
      b.tenantId,
    ).expect(200);
    expect(list.body.items.map((r: any) => r.unreadCustomerMessages)).toEqual([
      3,
    ]);
  });

  it('a request with no conversation, or one never mirrored, reads 0', async () => {
    const b = await bot();
    const none = await openRequest(b.tenantId, phoneRef(), {
      conversationRef: null,
    });
    const unmirrored = await openRequest(b.tenantId, phoneRef());
    const counts = await groupUnread(b.tenantId);
    expect(counts.get(none)).toBe(0);
    expect(counts.get(unmirrored)).toBe(0);
  });

  it("another chat's messages do not count", async () => {
    const b = await bot();
    const ref = phoneRef();
    const id = await openRequest(b.tenantId, ref);
    await post(b, phoneRef(), [msg(), msg()]);
    await post(b, ref, [msg()]);
    expect(await detailUnread(b.tenantId, id)).toBe(1);
  });

  it("another tenant's chat with the same reference does not count", async () => {
    const a = await bot();
    const c = await bot();
    const ref = phoneRef();
    const id = await openRequest(a.tenantId, ref);
    await post(c, ref, [msg(), msg(), msg()]);
    expect(await detailUnread(a.tenantId, id)).toBe(0);
  });

  it('a closed request reads 0 (nothing is waiting for an answer)', async () => {
    const b = await bot();
    const ref = phoneRef();
    const id = await openRequest(b.tenantId, ref, {
      status: 'CANCELLED',
      cancelReason: 'CUSTOMER_WITHDREW',
      cancelledAt: new Date(),
      closedAt: new Date(),
    });
    await post(b, ref, [msg(), msg()]);
    expect(await detailUnread(b.tenantId, id)).toBe(0);
  });

  // ------------------------------------------------------------------ open

  it('opening the conversation resets it to 0 for EVERY staff member', async () => {
    const b = await bot();
    const ref = phoneRef();
    const id = await openRequest(b.tenantId, ref);
    await post(b, ref, [msg(), msg(), msg()]);
    expect(await detailUnread(b.tenantId, id, 'manager')).toBe(3);
    const page = await open(id, b.tenantId, 'cashier', users.luis).expect(200);
    expect(page.body.items).toHaveLength(3);
    // Another person, another role: the same 0.
    expect(await detailUnread(b.tenantId, id, 'manager')).toBe(0);
    expect((await groupUnread(b.tenantId, 'readOnly')).get(id)).toBe(0);
  });

  it('counts again from the next customer message after an open', async () => {
    const b = await bot();
    const ref = phoneRef();
    const id = await openRequest(b.tenantId, ref);
    await post(b, ref, [msg(), msg()]);
    await open(id, b.tenantId).expect(200);
    await post(b, ref, [outMsg(), msg()]);
    expect(await detailUnread(b.tenantId, id)).toBe(1);
    await open(id, b.tenantId).expect(200);
    expect(await detailUnread(b.tenantId, id)).toBe(0);
  });

  it('the marker is stored on the conversation row (durable, per chat)', async () => {
    const b = await bot();
    const ref = phoneRef();
    const id = await openRequest(b.tenantId, ref);
    await post(b, ref, [msg(), outMsg(), msg()]);
    await open(id, b.tenantId).expect(200);
    const [row] = await prisma.$queryRaw<
      Array<{ lastStaffReadSeq: number; lastStaffReadAt: Date | null }>
    >`SELECT "lastStaffReadSeq", "lastStaffReadAt" FROM "chatbot_conversations"
      WHERE "tenantId" = ${b.tenantId} AND "conversationRef" = ${ref}`;
    expect(row.lastStaffReadSeq).toBe(3);
    expect(row.lastStaffReadAt).toBeInstanceOf(Date);
  });

  it('an assignee without read:ChatbotConversation gets the empty page and resets nothing', async () => {
    const b = await bot();
    const ref = phoneRef();
    const id = await openRequest(b.tenantId, ref, {
      status: 'IN_PROGRESS',
      assigneeUserId: users.luis,
      assigneeDisplayName: 'Luis',
      claimedAt: new Date(),
      version: 2,
    });
    await post(b, ref, [msg(), msg()]);
    const page = await open(id, b.tenantId, 'updateOnly', users.luis).expect(
      200,
    );
    expect(page.body).toEqual({ items: [], hasMoreBefore: false });
    expect(await detailUnread(b.tenantId, id)).toBe(2);
  });

  it('a 403 (no permission, not the assignee) resets nothing', async () => {
    const b = await bot();
    const ref = phoneRef();
    const id = await openRequest(b.tenantId, ref);
    await post(b, ref, [msg()]);
    await open(id, b.tenantId, 'updateOnly').expect(403);
    expect(await detailUnread(b.tenantId, id)).toBe(1);
  });

  it('an older page never marks the newer messages as read', async () => {
    const b = await bot();
    const ref = phoneRef();
    const id = await openRequest(b.tenantId, ref);
    await post(b, ref, [msg(), msg(), msg(), msg()]);
    // Seqs 1 and 2 only: 3 and 4 were never shown.
    await open(id, b.tenantId, 'cashier', users.ana, '?before=3').expect(200);
    expect(await detailUnread(b.tenantId, id)).toBe(2);
  });

  it('an `after` poll that shows only part of the news leaves the rest unread', async () => {
    const b = await bot();
    const ref = phoneRef();
    const id = await openRequest(b.tenantId, ref);
    await post(b, ref, [msg(), msg(), msg(), msg()]);
    await open(id, b.tenantId, 'cashier', users.ana, '?after=0&limit=2').expect(
      200,
    );
    expect(await detailUnread(b.tenantId, id)).toBe(2);
    // Nothing new: an empty poll changes nothing (and writes nothing).
    await open(id, b.tenantId, 'cashier', users.ana, '?after=4').expect(200);
    expect(await detailUnread(b.tenantId, id)).toBe(2);
    await open(id, b.tenantId).expect(200);
    expect(await detailUnread(b.tenantId, id)).toBe(0);
  });

  it('the marker never moves back', async () => {
    const b = await bot();
    const ref = phoneRef();
    const id = await openRequest(b.tenantId, ref);
    await post(b, ref, [msg(), msg(), msg()]);
    await open(id, b.tenantId).expect(200);
    await open(id, b.tenantId, 'cashier', users.ana, '?before=3').expect(200);
    expect(await detailUnread(b.tenantId, id)).toBe(0);
  });

  it('two requests of one chat share the conversation: opening through one clears both', async () => {
    const b = await bot();
    const ref = phoneRef();
    const one = await openRequest(b.tenantId, ref);
    const two = await openRequest(b.tenantId, ref, {
      subtype: 'TALK_TO_HUMAN',
      kind: 'CONVERSATION',
    });
    await post(b, ref, [msg(), msg()]);
    const before = await groupUnread(b.tenantId);
    expect([before.get(one), before.get(two)]).toEqual([2, 2]);
    await open(one, b.tenantId).expect(200);
    const after = await groupUnread(b.tenantId);
    expect([after.get(one), after.get(two)]).toEqual([0, 0]);
  });

  // -------------------------------------------------------------- realtime

  it('logs request.updated for each open request on a customer message and on an open', async () => {
    const b = await bot();
    const ref = phoneRef();
    const one = await openRequest(b.tenantId, ref);
    const two = await openRequest(b.tenantId, ref, {
      subtype: 'TALK_TO_HUMAN',
      kind: 'CONVERSATION',
    });
    await openRequest(b.tenantId, ref, {
      status: 'RESOLVED',
      resolvedAt: new Date(),
      closedAt: new Date(),
    });
    // A bot-only batch changes no count: no request event.
    await post(b, ref, [outMsg()]);
    expect(await requestEvents(b.tenantId)).toEqual([]);

    await post(b, ref, [msg(), msg()]);
    const afterMessage = await requestEvents(b.tenantId);
    // One per open request per batch (not per message).
    expect(afterMessage.map((e) => e.payload.cause)).toEqual([
      'CUSTOMER_MESSAGE',
      'CUSTOMER_MESSAGE',
    ]);
    expect(new Set(afterMessage.map((e) => e.requestId))).toEqual(
      new Set([one, two]),
    );

    await open(one, b.tenantId).expect(200);
    const afterOpen = (await requestEvents(b.tenantId)).slice(2);
    expect(afterOpen.map((e) => e.payload.cause)).toEqual([
      'CONVERSATION_READ',
      'CONVERSATION_READ',
    ]);
    expect(new Set(afterOpen.map((e) => e.requestId))).toEqual(
      new Set([one, two]),
    );
    // The log holds ids and a cause only.
    expect(JSON.stringify(afterOpen)).not.toMatch(/Hola|5512|wa:/);

    // Opening again with nothing new moves nothing and logs nothing.
    await open(one, b.tenantId).expect(200);
    expect(await requestEvents(b.tenantId)).toHaveLength(4);
  });

  it('a duplicate replay logs no request event', async () => {
    const b = await bot();
    const ref = phoneRef();
    await openRequest(b.tenantId, ref);
    const same = msg();
    await post(b, ref, [same]);
    await post(b, ref, [same]);
    expect(await requestEvents(b.tenantId)).toHaveLength(1);
  });

  // ------------------------------------------------------------------ perf

  const PERF = process.env.PERF === '1';
  const itPerf = PERF ? it : it.skip;

  /**
   * OFF unless PERF=1 (`PERF=1 pnpm test:integration src/conversations/
   * conversation-unread.integration.spec.ts`). Seeds PERF_REQUESTS open requests
   * (default 1 000, over 400 customers), each with a chat of PERF_PER_CHAT
   * messages (default 100, half from the customer) and a read marker somewhere
   * in the middle, then measures the inbox page that now computes the counter
   * per row (limit 25 groups, 10 rows each), over HTTP with stub guards, and
   * prints the plan of the unread subquery. Target: p95 < 200 ms (§10.1 "Bandeja
   * agrupada por cliente"), the same bar as the rest of the inbox.
   */
  itPerf(
    'PERF: the inbox page with the unread counter stays far inside the 200 ms bar',
    async () => {
      const requests = Number(process.env.PERF_REQUESTS ?? 1000);
      const perChat = Number(process.env.PERF_PER_CHAT ?? 100);
      const b = await bot();
      const t = b.tenantId;
      await prisma.$executeRaw`
        INSERT INTO "chatbot_conversations"
          ("id", "tenantId", "conversationRef", "customerKey", "nextSeq", "lastStaffReadSeq", "updatedAt")
        SELECT 'perf-' || ${t} || '-' || g, ${t}, 'wa:5215700' || lpad(g::text, 6, '0'),
               '5215700' || lpad(g::text, 6, '0'), ${perChat + 1}, (g % ${perChat}), now()
        FROM generate_series(1, ${requests}) g`;
      await prisma.$executeRaw`
        INSERT INTO "conversation_messages"
          ("id", "tenantId", "conversationId", "seq", "direction", "author", "type", "text",
           "receivedAt", "purgeAfter")
        SELECT gen_random_uuid()::text, ${t}, 'perf-' || ${t} || '-' || g, s,
               (CASE WHEN s % 2 = 1 THEN 'IN' ELSE 'OUT' END)::"ConversationMessageDirection",
               (CASE WHEN s % 2 = 1 THEN 'CUSTOMER' ELSE 'BOT' END)::"ConversationMessageAuthor",
               'TEXT', 'x', now(), now() + interval '12 months'
        FROM generate_series(1, ${requests}) g, generate_series(1, ${perChat}) s`;
      await prisma.chatbotRequest.createMany({
        data: Array.from({ length: requests }, (_v, i) => ({
          tenantId: t,
          folio: i + 1,
          kind: 'CLARIFICATION',
          subtype: 'UNKNOWN_QUESTION',
          // Four requests share each customer: realistic groups of up to 10.
          customerKey: `5215800${String(i % 400).padStart(6, '0')}`,
          conversationRef: `wa:5215700${String(i + 1).padStart(6, '0')}`,
          summary: 'Pregunta',
          source: 'chatbot',
          sourceRequestId: randomUUID(),
          slaPolicyVersion: 0,
        })) as never,
      });
      await prisma.$executeRaw`
        INSERT INTO "chatbot_customer_groups" ("tenantId", "customerKey", "openCount", "updatedAt")
        SELECT ${t}, "customerKey", count(*)::int, now() FROM "chatbot_requests"
        WHERE "tenantId" = ${t} GROUP BY "customerKey"`;
      await prisma.$executeRawUnsafe('ANALYZE "conversation_messages"');
      await prisma.$executeRawUnsafe('ANALYZE "chatbot_conversations"');
      await prisma.$executeRawUnsafe('ANALYZE "chatbot_requests"');

      const samples: number[] = [];
      let rowsSeen = 0;
      for (let i = 0; i < 60; i += 1) {
        const started = performance.now();
        const res = await get(
          '/chatbot-requests/groups?limit=25',
          'manager',
          t,
        ).expect(200);
        samples.push(performance.now() - started);
        rowsSeen = res.body.items.reduce(
          (n: number, g: any) => n + g.requests.length,
          0,
        );
      }
      samples.sort((a, b) => a - b);
      const p95 = samples[Math.floor(samples.length * 0.95) - 1];
      const plan = await prisma.$queryRawUnsafe<Array<Record<string, string>>>(
        `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
         SELECT r."id", (CASE WHEN r."conversationRef" IS NOT NULL
           AND r."status" IN ('NEW','IN_PROGRESS') THEN (
             SELECT count(*)::int FROM "chatbot_conversations" cv
             JOIN "conversation_messages" cm ON cm."conversationId" = cv."id"
              AND cm."seq" > cv."lastStaffReadSeq" AND cm."author" = 'CUSTOMER'
             WHERE cv."tenantId" = r."tenantId" AND cv."conversationRef" = r."conversationRef"
               AND cm."tenantId" = r."tenantId") ELSE 0 END) AS "unread"
         FROM "chatbot_requests" r WHERE r."tenantId" = '${t}' LIMIT 250`,
      );
      console.log(
        JSON.stringify({
          perf: 'unread-inbox',
          requests,
          perChat,
          rowsInPage: rowsSeen,
          p50: samples[Math.floor(samples.length / 2)],
          p95,
          max: samples[samples.length - 1],
          plan: plan.map((r) => r['QUERY PLAN']),
        }),
      );
      expect(rowsSeen).toBeGreaterThan(0);
      if (process.env.PERF_ENFORCE === '1') expect(p95).toBeLessThan(200);
    },
    300_000,
  );

  it('one statement serves a whole page of rows: no N+1, same count for 1 or 12 rows', async () => {
    const b = await bot();
    const statementsFor = async (): Promise<number> => {
      log.length = 0;
      await get('/chatbot-requests/groups?limit=50', 'manager', b.tenantId)
        .expect(200)
        .then((r) => r.body.items.length);
      return log.filter((q) => /chatbot_requests/.test(q)).length;
    };
    const first = phoneRef();
    await openRequest(b.tenantId, first);
    await post(b, first, [msg(), msg()]);
    const one = await statementsFor();
    for (let i = 0; i < 11; i += 1) {
      const ref = phoneRef();
      await openRequest(b.tenantId, ref);
      await post(b, ref, [msg(), msg(), msg()]);
    }
    const many = await statementsFor();
    expect(many).toBe(one);
    const counts = await groupUnread(b.tenantId);
    expect([...counts.values()].filter((n) => n > 0)).toHaveLength(12);
  });
});
