/* eslint-disable @typescript-eslint/no-unsafe-argument -- load-test harness: untyped JSON bodies and a printed report */
/**
 * human-intervention / unit 9 — load test of the conversation mirror against
 * REAL PostgreSQL (contract §10.1 "Cómo se demuestra"; performance rows
 * "Conversación paginada": p95 < 100 ms per 50 messages with 200 000 messages
 * per tenant, `unique (conversationId, seq)`; "Purga de 12 meses": batches of
 * 1 000 without blocking writes, index `(purgeAfter)`).
 *
 * OFF by default: it seeds ~270 000 rows. Run it through the project's
 * integration harness (which owns the test-DB URL guard):
 *
 *   PERF=1 pnpm test:integration src/conversations/conversation-load.integration.spec.ts
 *
 * Measures over HTTP (real guards of the bot, stubbed staff identity): (a) the
 * staff page read (latest, older pages in a 20 000-message chat, polling with
 * `after`) at size; (b) the bot's batch ingest of 50 messages into a big table;
 * (c) the purge: time per batch of 1 000 due messages, and the latency of
 * writes WHILE the purge runs against their latency without it; (d) EXPLAIN
 * (ANALYZE, BUFFERS) of the page read and the purge's due scan. The report goes
 * to stdout and PERF_REPORT_PATH (default /tmp/conversation-load-report.json).
 * Targets are reported, not asserted, unless PERF_ENFORCE=1.
 */
import { createHash, randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import os from 'os';
import { performance } from 'perf_hooks';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
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
import { ChatbotRequestHttpFilter } from '../chatbot-requests/presentation/chatbot-request-http.filter';
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
import { ConversationRetentionService } from './application/conversation-retention.service';
import { PrismaConversationMirrorStore } from './infrastructure/prisma-conversation-mirror.store';
import { PrismaConversationReadStore } from './infrastructure/prisma-conversation-read.store';
import { BotConversationController } from './presentation/bot-conversation.controller';
import { ConversationReadsController } from './presentation/conversation-reads.controller';
import { FakeMediaStorage } from './test-support/fake-media-storage';
import { StubGuard, StubPermissionsGuard } from './test-support/staff-stubs';

const PERF =
  process.env.PERF === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  process.env.SKIP_DB_INTEGRATION !== '1';
const describePerf = PERF ? describe : describe.skip;

const int = (name: string, fallback: number) =>
  process.env[name] ? Number(process.env[name]) : fallback;

const SIZE = {
  // Tenant A, the measured one: 200 000 messages in total.
  hotChatMessages: int('PERF_HOT_CHAT', 20_000),
  chats: int('PERF_CHATS', 400),
  messagesPerChat: int('PERF_PER_CHAT', 450),
  // Noise: a big neighbour.
  noiseMessages: int('PERF_NOISE', 60_000),
  // Due rows for the purge (their own tenant).
  dueMessages: int('PERF_DUE', 30_000),
  samples: int('PERF_SAMPLES', 200),
  purgeBatches: int('PERF_PURGE_BATCHES', 10),
};

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    n: sorted.length,
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted[sorted.length - 1]),
  };
};

describePerf('conversation mirror load (PostgreSQL, real HTTP)', () => {
  const prisma = integrationPrisma();
  const storage = new FakeMediaStorage();
  const report: Record<string, unknown> = {};
  const targets: Array<{
    name: string;
    limit: string;
    measured: string;
    pass: boolean;
  }> = [];
  let app: INestApplication;
  const tenants: string[] = [];
  const credentials: string[] = [];
  let tenantA = '';
  let token = '';
  let hotRef = '';
  let hotRequestId = '';
  let hotChatId = '';

  const asStaff = (path: string) =>
    request(app.getHttpServer()).get(path).set({
      'x-test-role': 'manager',
      'x-test-tenant': tenantA,
      'x-test-user': randomUUID(),
    });
  const asBot = (ref: string, body: object) =>
    request(app.getHttpServer())
      .post(
        `/chatbot-api/conversations/${encodeURIComponent(ref)}/messages:batch`,
      )
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const message = (i: number) => ({
    waMessageId: `wamid.${randomUUID()}`,
    direction: i % 2 === 0 ? 'IN' : 'OUT',
    type: 'TEXT',
    text: `Mensaje de prueba número ${i}, con un texto de largo parecido al real.`,
    providerTimestamp: new Date().toISOString(),
    observedAt: new Date().toISOString(),
  });
  const batch = (n: number) => ({
    messages: Array.from({ length: n }, (_, i) => message(i)),
  });

  async function tenant(): Promise<string> {
    const id = randomUUID();
    tenants.push(id);
    await prisma.tenant.create({
      data: { id, name: 'Carga Espejo', slug: `cv-load-${id}` },
    });
    return id;
  }

  /** `n` messages in one chat: `generate_series`, not a million round trips. */
  async function seedChat(
    tenantId: string,
    ref: string,
    n: number,
    due = false,
  ) {
    const [chat] = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO "chatbot_conversations" ("id", "tenantId", "conversationRef", "customerKey", "nextSeq", "updatedAt")
      VALUES (${randomUUID()}, ${tenantId}, ${ref}, '525512345678', ${n + 1}, now())
      RETURNING "id"`);
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "conversation_messages"
        ("id", "tenantId", "conversationId", "seq", "direction", "author", "type", "text",
         "receivedAt", "purgeAfter", "deliveryStatus")
      SELECT gen_random_uuid()::text, ${tenantId}, ${chat.id}, s,
             CASE WHEN s % 2 = 0 THEN 'IN' ELSE 'OUT' END::"ConversationMessageDirection",
             CASE WHEN s % 2 = 0 THEN 'CUSTOMER' ELSE 'BOT' END::"ConversationMessageAuthor",
             'TEXT', 'Mensaje de prueba ' || s,
             now() - interval '13 months',
             ${due ? Prisma.sql`now() - (s * interval '1 second') - interval '1 day'` : Prisma.sql`now() + interval '11 months' + (s * interval '1 second')`},
             CASE WHEN s % 2 = 0 THEN NULL ELSE 'SENT' END::"ConversationDeliveryStatus"
      FROM generate_series(1, ${n}) s`);
    return chat.id;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        DatabaseModule,
        BotRateLimitModule,
      ],
      controllers: [BotConversationController, ConversationReadsController],
      providers: [
        ServiceAuthGuard,
        ChatbotRequestHttpFilter,
        ConversationMirrorService,
        ConversationReadsService,
        {
          provide: CONVERSATION_MIRROR_STORE,
          useClass: PrismaConversationMirrorStore,
        },
        {
          provide: CONVERSATION_READ_STORE,
          useClass: PrismaConversationReadStore,
        },
        {
          provide: SERVICE_CREDENTIAL_REPOSITORY,
          useClass: PrismaServiceCredentialRepository,
        },
      ],
    })
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

    const started = performance.now();
    tenantA = await tenant();
    token = `svc_${randomUUID()}`;
    const credential = await prisma.serviceCredential.create({
      data: {
        tenantId: tenantA,
        name: 'bot',
        hashedKey: createHash('sha256').update(token).digest('hex'),
        scopes: ['conversation:write'],
        rateLimit: 60,
        // Generous budget: this measures the mirror, not the limiter.
        rateLimits: { write: 1_000_000 },
      },
    });
    credentials.push(credential.id);

    hotRef = 'wa:5215500000000';
    hotChatId = await seedChat(tenantA, hotRef, SIZE.hotChatMessages);
    const request1 = await prisma.chatbotRequest.create({
      data: {
        tenantId: tenantA,
        folio: 1,
        kind: 'CLARIFICATION',
        subtype: 'UNKNOWN_QUESTION',
        customerKey: '525500000000',
        conversationRef: hotRef,
        summary: 'Pregunta',
        source: 'chatbot',
        sourceRequestId: randomUUID(),
      } as never,
    });
    hotRequestId = request1.id;
    for (let i = 1; i <= SIZE.chats; i++) {
      await seedChat(
        tenantA,
        `wa:52551${String(i).padStart(7, '0')}`,
        SIZE.messagesPerChat,
      );
    }
    const noise = await tenant();
    await seedChat(noise, 'wa:5215599999999', SIZE.noiseMessages);
    const dueTenant = await tenant();
    for (let i = 0; i < 30; i++) {
      await seedChat(
        dueTenant,
        `wa:52552${String(i).padStart(7, '0')}`,
        Math.ceil(SIZE.dueMessages / 30),
        true,
      );
    }
    await prisma.$executeRaw`ANALYZE "conversation_messages"`;
    await prisma.$executeRaw`ANALYZE "chatbot_conversations"`;
    report.seedSeconds =
      Math.round(((performance.now() - started) / 1000) * 100) / 100;
  }, 600_000);

  afterAll(async () => {
    await app.close();
    await prisma.serviceRateBucket.deleteMany({
      where: { credentialId: { in: credentials } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    const path =
      process.env.PERF_REPORT_PATH ?? '/tmp/conversation-load-report.json';
    const full = {
      ...report,
      targets,
      machine: {
        cpus: os.cpus().length,
        model: os.cpus()[0]?.model,
        memGb: Math.round(os.totalmem() / 1e9),
      },
      sizes: SIZE,
    };
    writeFileSync(path, JSON.stringify(full, null, 2));
    console.log(
      `conversation load report -> ${path}\n${JSON.stringify(full, null, 2)}`,
    );
    if (process.env.PERF_ENFORCE === '1') {
      expect(targets.filter((t) => !t.pass)).toEqual([]);
    }
  }, 300_000);

  async function time(
    samples: number,
    work: () => Promise<unknown>,
  ): Promise<number[]> {
    const out: number[] = [];
    for (let i = 0; i < samples; i++) {
      const start = performance.now();
      await work();
      out.push(performance.now() - start);
    }
    return out;
  }

  it('(a) the staff page read: p95 < 100 ms per 50 messages', async () => {
    const latest = await time(SIZE.samples, async () => {
      await asStaff(
        `/chatbot-requests/${hotRequestId}/conversation?limit=50`,
      ).expect(200);
    });
    const older = await time(SIZE.samples, async () => {
      const before =
        2 + Math.floor(Math.random() * (SIZE.hotChatMessages - 52));
      await asStaff(
        `/chatbot-requests/${hotRequestId}/conversation?limit=50&before=${before + 50}`,
      ).expect(200);
    });
    const polling = await time(SIZE.samples, async () => {
      const after = Math.floor(Math.random() * (SIZE.hotChatMessages - 60));
      await asStaff(
        `/chatbot-requests/${hotRequestId}/conversation?limit=50&after=${after}`,
      ).expect(200);
    });
    report.pageRead = {
      latest: summary(latest),
      olderPages: summary(older),
      polling: summary(polling),
    };
    for (const [name, values] of Object.entries({ latest, older, polling })) {
      const p95 = summary(values).p95;
      targets.push({
        name: `page read, ${name}`,
        limit: 'p95 < 100 ms',
        measured: `p95 ${p95} ms`,
        pass: p95 < 100,
      });
    }
  }, 300_000);

  it('(b) the bot batch of 50 into a big table', async () => {
    const ingest = await time(Math.min(SIZE.samples, 100), async () => {
      await asBot(hotRef, batch(50)).expect(200);
    });
    const replay = batch(50);
    await asBot(hotRef, replay).expect(200);
    const duplicates = await time(50, async () => {
      await asBot(hotRef, replay).expect(200);
    });
    // Two chats ingesting at once never wait on each other.
    const parallel = await time(20, async () => {
      await Promise.all(
        [1, 2, 3, 4, 5].map((i) =>
          asBot(`wa:52551${String(i).padStart(7, '0')}`, batch(10)).expect(200),
        ),
      );
    });
    report.ingest = {
      batchOf50NewMessages: summary(ingest),
      batchOf50DuplicatesReplayed: summary(duplicates),
      fiveChatsInParallelBatchesOf10: summary(parallel),
    };
    targets.push({
      name: 'bot batch of 50 (informational: no contract target)',
      limit: 'n/a',
      measured: `p95 ${summary(ingest).p95} ms`,
      pass: true,
    });
  }, 300_000);

  it('(c) the purge: batches of 1 000 and writes that keep their pace while it runs', async () => {
    const service = new ConversationRetentionService(
      app.get(PrismaService, { strict: false }),
      storage,
    );
    const baseline = await time(40, async () => {
      await asBot(hotRef, batch(5)).expect(200);
    });
    const batchTimes: number[] = [];
    const removed: number[] = [];
    let purging = true;
    const purge = (async () => {
      for (let i = 0; i < SIZE.purgeBatches && purging; i++) {
        const start = performance.now();
        const result = await service.purgeBatch({ batchSize: 1000 });
        batchTimes.push(performance.now() - start);
        removed.push(result.messagesDeleted);
        if (result.messagesDeleted === 0) break;
      }
      purging = false;
    })();
    const during: number[] = [];
    while (purging) {
      const start = performance.now();
      await asBot(hotRef, batch(5)).expect(200);
      during.push(performance.now() - start);
    }
    await purge;
    report.purge = {
      batchSize: 1000,
      messagesRemovedPerBatch: removed,
      batchMs: summary(batchTimes),
      writesWithoutPurge: summary(baseline),
      writesDuringPurge: summary(during.length ? during : [0]),
    };
    const baseP95 = summary(baseline).p95;
    const duringP95 = summary(during.length ? during : [0]).p95;
    targets.push({
      name: 'purge batch of 1 000',
      limit:
        'does not block writes: p95 of writes during the purge < 3x baseline (+25 ms)',
      measured: `writes p95 ${duringP95} ms vs ${baseP95} ms without; batch p50 ${summary(batchTimes).p50} ms`,
      pass: duringP95 < baseP95 * 3 + 25,
    });
  }, 600_000);

  it('(d) EXPLAIN (ANALYZE, BUFFERS) of the page read and of the purge due scan', async () => {
    const plan = async (statement: Prisma.Sql) =>
      (await prisma.$queryRaw<Array<Record<string, string>>>(statement)).map(
        (r) => r['QUERY PLAN'],
      );
    const hotBefore = Math.floor(SIZE.hotChatMessages / 2);
    const pageStatement = Prisma.sql`EXPLAIN (ANALYZE, BUFFERS)
      SELECT "id", "seq", "direction", "author", "type", "text", "deliveryStatus"
      FROM "conversation_messages"
      WHERE "tenantId" = ${tenantA} AND "conversationId" = ${hotChatId} AND "seq" < ${hotBefore}
      ORDER BY "seq" DESC LIMIT 51`;
    const pagePlan = await plan(pageStatement);
    const duePlan = await plan(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS)
      SELECT "id" FROM "conversation_messages"
      WHERE "purgeAfter" < now() ORDER BY "purgeAfter", "id" LIMIT 1000 FOR UPDATE SKIP LOCKED`);
    report.explain = { pageRead: pagePlan, purgeDueScan: duePlan };
    const text = (lines: string[]) => lines.join('\n');
    targets.push({
      name: 'page read uses unique (conversationId, seq)',
      limit: 'index scan on conversation_messages_conversationId_seq_key',
      measured: /conversationId_seq_key/.test(text(pagePlan)) ? 'yes' : 'NO',
      pass: /conversationId_seq_key/.test(text(pagePlan)),
    });
    targets.push({
      name: 'purge due scan uses index (purgeAfter)',
      limit: 'index scan on conversation_messages_purgeAfter_idx',
      measured: /purgeAfter_idx/.test(text(duePlan))
        ? 'yes'
        : 'NO (small table may seq scan: informational)',
      pass:
        /purgeAfter_idx/.test(text(duePlan)) ||
        !/Seq Scan on conversation_messages/.test(text(duePlan)),
    });
  }, 120_000);
});

// The shared client keeps a pool open for the whole run unless it is closed:
// the integration suite runs every spec in one process against one database.
afterAll(async () => {
  await integrationPrisma().$disconnect();
});
