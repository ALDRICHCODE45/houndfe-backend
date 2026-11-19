/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- load-test harness: untyped JSON bodies and a printed report */
/**
 * human-intervention / unit 5, slice 5c — load test of the bot feed and of the
 * recovery route against REAL PostgreSQL (contract §10.1 "Cómo se demuestra";
 * performance row "Feed del bot": < 1 s p95 commit→bot, an idle request uses no
 * CPU and no pool connection, index `(tenantId, cursor)`, sized for 5 000 open
 * requests and 200 000 messages per tenant).
 *
 * OFF by default: it seeds ~250 000 rows and runs for minutes. Run it through
 * the project's integration harness (which owns the test-DB URL guard):
 *
 *   node scripts/perf/chatbot-feed-load.cjs          # sets PERF=1 and runs
 *   PERF=1 pnpm test:integration src/chatbot-requests/chatbot-feed-load.integration.spec.ts
 *
 * Measures: (a) commit→long-poll-return latency over >= 200 enqueues, one at a
 * time and from parallel transactions; (b) the feed read, pending-deliveries
 * and recovery queries at size; (c) that idle long-polls use no DB connection
 * and no queries; (d) the throughput of the per-tenant enqueue lock. Captures
 * EXPLAIN (ANALYZE, BUFFERS) of the real statements. The report goes to stdout
 * and to PERF_REPORT_PATH (default /tmp/chatbot-feed-load-report.json). Targets
 * are reported, not asserted, unless PERF_ENFORCE=1.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { createHash, randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import type { AddressInfo } from 'net';
import os from 'os';
import { performance } from 'perf_hooks';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { ClsModule, ClsService } from 'nestjs-cls';
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
import { enqueueCancelled } from './infrastructure/chatbot-feed-writes';
import { PgFeedWakeup } from './infrastructure/feed-wakeup';
import {
  PrismaChatbotFeedStore,
  tenantHeadCursor,
} from './infrastructure/prisma-chatbot-feed.store';
import { PrismaChatbotRecoveryStore } from './infrastructure/prisma-chatbot-recovery.store';
import { BotFeedController } from './presentation/bot-feed.controller';
import { BotRecoveryController } from './presentation/bot-recovery.controller';
import { ChatbotRequestHttpFilter } from './presentation/chatbot-request-http.filter';

const PERF =
  process.env.PERF === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  process.env.SKIP_DB_INTEGRATION !== '1';
const describePerf = PERF ? describe : describe.skip;

const int = (name: string, fallback: number) =>
  process.env[name] ? Number(process.env[name]) : fallback;

const SIZE = {
  openRequests: int('PERF_OPEN', 5_000),
  closedRequests: int('PERF_CLOSED', 20_000),
  feedItems: int('PERF_FEED_ITEMS', 200_000),
  noiseOpen: int('PERF_NOISE_OPEN', 2_500),
  noiseClosed: int('PERF_NOISE_CLOSED', 10_000),
  noiseFeedItems: int('PERF_NOISE_FEED_ITEMS', 100_000),
  sequentialSamples: int('PERF_SAMPLES', 200),
  parallelRounds: int('PERF_PARALLEL_ROUNDS', 20),
  parallelWidth: int('PERF_PARALLEL_WIDTH', 10),
  idlePolls: int('PERF_IDLE_POLLS', 50),
  writerSeconds: int('PERF_WRITER_SECONDS', 4),
};

const TARGETS = {
  commitToBotP95Ms: 1_000,
  idleCpuMsPerSecond: 50, // 5 % of one core
  poolProbeP95Ms: 100,
};

// ------------------------------------------------------------------ helpers

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value: number) => Math.round(value * 100) / 100;

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) =>
    sorted[
      Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
    ];
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min: round(sorted[0]),
    mean: round(sum / sorted.length),
    p50: round(at(50)),
    p95: round(at(95)),
    p99: round(at(99)),
    max: round(sorted[sorted.length - 1]),
  };
}

/** `$n` → a literal, so EXPLAIN plans the statement the app really ran. */
function inline(query: string, rawParams: string): string {
  // Integers beyond 2^53 (the cursor's upper bound) would lose digits as JS
  // numbers: keep them as strings, which PostgreSQL reads as untyped literals.
  const params: unknown[] = JSON.parse(
    rawParams.replace(/(?<![\d."])(\d{16,})(?![\d."])/g, '"$1"'),
  );
  const literal = (value: unknown): string => {
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (Array.isArray(value)) {
      return `ARRAY[${value.map(literal).join(',')}]::text[]`;
    }
    return `'${String(value).replace(/'/g, "''")}'`;
  };
  return query.replace(/\$(\d+)/g, (_m, n: string) =>
    literal(params[Number(n) - 1]),
  );
}

const planLines = (rows: Array<Record<string, string>>) =>
  rows.map((row) => row['QUERY PLAN']);

describePerf('chatbot feed load test (PostgreSQL, PERF=1)', () => {
  jest.setTimeout(3_600_000);

  const adminPrisma = new PrismaClient();
  const cls = new ClsService<TenantClsStore>(
    new AsyncLocalStorage<TenantClsStore>(),
  );

  // Writers (the staff side): their own pool, big enough for 10 parallel
  // transactions, with query events so EXPLAIN can capture the real SQL.
  const withLimit = (limit: number) => {
    const base = process.env.DATABASE_URL as string;
    return `${base}${base.includes('?') ? '&' : '?'}connection_limit=${limit}&pool_timeout=30`;
  };
  const writerPrisma = new PrismaClient({
    datasources: { db: { url: withLimit(30) } },
    log: [{ emit: 'event', level: 'query' }],
  });
  const writerTenant = new TenantPrismaService(
    writerPrisma as unknown as PrismaService,
    cls,
  );
  const captured: Array<{ query: string; params: string }> = [];
  (writerPrisma as any).$on('query', (event: any) =>
    captured.push({ query: event.query, params: event.params }),
  );
  const inTenant = <T>(tenantId: string, work: () => Promise<T>) =>
    cls.runWith({ tenantId, userId: 'perf', isSuperAdmin: false }, work);

  const tenants: string[] = [];
  const credentials: string[] = [];
  const report: Record<string, any> = {};
  const verdicts: Array<{
    target: string;
    limit: string;
    measured: string;
    pass: boolean;
  }> = [];
  const verdict = (
    target: string,
    limit: string,
    measured: string,
    pass: boolean,
  ) => verdicts.push({ target, limit, measured, pass });

  const apps: INestApplication[] = [];
  let main: {
    app: INestApplication;
    base: string;
    feedService: ChatbotFeedService;
  };
  let A: { tenantId: string; token: string; credentialId: string };
  let B: { tenantId: string };
  let quiet: string;
  let stalled: string;
  let gap: string;
  let cancelledPool: string[] = [];
  let cancelledNext = 0;

  async function createTenant(label: string) {
    const id = randomUUID();
    tenants.push(id);
    await adminPrisma.tenant.create({
      data: { id, name: `Perf ${label}`, slug: `perf-feed-${id}` },
    });
    return id;
  }

  async function createCredential(
    tenantId: string,
    scopes = ['requests:read', 'feed:read', 'feed:ack'],
  ) {
    const token = `svc_${randomUUID()}`;
    const credential = await adminPrisma.serviceCredential.create({
      data: {
        tenantId,
        name: 'perf-bot',
        hashedKey: createHash('sha256').update(token).digest('hex'),
        scopes,
        rateLimit: 9_999_999,
        rateLimits: { read: 9_999_999, feed: 9_999_999, write: 9_999_999 },
      },
    });
    credentials.push(credential.id);
    return { tenantId, token, credentialId: credential.id };
  }

  /** Synthetic requests of one tenant, in SQL (fast, no ORM). */
  async function seedRequests(tenantId: string, open: number, closed: number) {
    if (open > 0) {
      await adminPrisma.$executeRaw(Prisma.sql`
        INSERT INTO "chatbot_requests"
          ("id", "tenantId", "folio", "kind", "subtype", "status", "customerKey",
           "conversationRef", "summary", "source", "sourceRequestId", "createdAt", "updatedAt")
        SELECT gen_random_uuid()::text, ${tenantId}, g,
               'CLARIFICATION'::"ChatbotRequestKind",
               'UNKNOWN_QUESTION'::"ChatbotRequestSubtype",
               'NEW'::"ChatbotRequestStatus",
               '5255' || lpad(g::text, 8, '0'), 'wa:5255' || lpad(g::text, 8, '0'),
               'Pregunta de prueba', 'perf', gen_random_uuid()::text,
               now() - ((${open}::int - g) * interval '7 minutes') - interval '1 hour',
               now() - ((${open}::int - g) * interval '7 minutes')
        FROM generate_series(1, ${open}::int) AS g`);
    }
    if (closed > 0) {
      await adminPrisma.$executeRaw(Prisma.sql`
        INSERT INTO "chatbot_requests"
          ("id", "tenantId", "folio", "kind", "subtype", "status", "customerKey",
           "conversationRef", "summary", "source", "sourceRequestId", "createdAt",
           "updatedAt", "closedAt", "resolvedAt", "cancelledAt", "cancelReason")
        SELECT gen_random_uuid()::text, ${tenantId}, ${open}::int + g,
               'CLARIFICATION'::"ChatbotRequestKind",
               'UNKNOWN_QUESTION'::"ChatbotRequestSubtype",
               (CASE WHEN g % 2 = 0 THEN 'RESOLVED' ELSE 'CANCELLED' END)::"ChatbotRequestStatus",
               '5256' || lpad(g::text, 8, '0'), 'wa:5256' || lpad(g::text, 8, '0'),
               'Pregunta cerrada', 'perf', gen_random_uuid()::text,
               closed_at - interval '2 hours', closed_at, closed_at,
               CASE WHEN g % 2 = 0 THEN closed_at END,
               CASE WHEN g % 2 = 1 THEN closed_at END,
               (CASE WHEN g % 2 = 1 THEN 'CUSTOMER_WITHDREW' END)::"ChatbotRequestCancelReason"
        FROM (SELECT g, now() - ((${closed}::int - g) * (interval '40 days' / ${closed}::int)) AS closed_at
              FROM generate_series(1, ${closed}::int) AS g) AS s`);
    }
  }

  /**
   * Feed items `from..to` (of `feedItems`) of one tenant: 99 % terminal
   * (PROVIDER_ACCEPTED), 0.5 % deferred (both reasons) and the newest 1 000
   * never attempted, which is what a live feed looks like. Tenants are seeded
   * in alternating slices so their cursors interleave.
   */
  async function seedFeed(
    tenantId: string,
    requests: number,
    feedItems: number,
    from: number,
    to: number,
  ) {
    if (to >= from) {
      await adminPrisma.$executeRaw(Prisma.sql`
        INSERT INTO "chatbot_feed_items"
          ("tenantId", "requestId", "type", "conversationRef", "payload",
           "createdAt", "ackedAt", "outcome", "attemptId", "evidenceHash", "attemptedAt")
        SELECT ${tenantId}, r."id",
               CASE WHEN s.g % 10 < 7 THEN 'request.answered' ELSE 'request.cancelled' END,
               r."conversationRef",
               jsonb_build_object('kind', 'DECISION', 'subtype', 'RESTOCK',
                 'action', 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE', 'legacyId', r."id",
                 'text', 'Por ahora no tenemos una fecha estimada de reposición para «Croquetas 20 kg».',
                 'prefix', NULL, 'productName', 'Croquetas 20 kg'),
               s.created_at,
               CASE WHEN s.state = 'terminal' THEN s.created_at + interval '1 second' END,
               CASE s.state WHEN 'terminal' THEN 'PROVIDER_ACCEPTED'
                            WHEN 'deferred_window' THEN 'DEFERRED_WINDOW_CLOSED'
                            WHEN 'deferred_human' THEN 'DEFERRED_HUMAN_SESSION' END,
               CASE WHEN s.state <> 'new' THEN gen_random_uuid()::text END,
               CASE WHEN s.state <> 'new' THEN md5(s.g::text) || md5(s.g::text) END,
               CASE WHEN s.state <> 'new' THEN s.created_at END
        FROM (SELECT g,
                     ((g - 1) % ${requests}::int) + 1 AS rn,
                     now() - ((${feedItems}::int - g) * (interval '29 days' / ${feedItems}::int)) AS created_at,
                     CASE WHEN g > ${feedItems}::int - 1000 THEN 'new'
                          WHEN g % 400 = 0 THEN 'deferred_human'
                          WHEN g % 200 = 0 THEN 'deferred_window'
                          ELSE 'terminal' END AS state
              FROM generate_series(${from}::int, ${to}::int) AS g) AS s
        JOIN (SELECT "id", "conversationRef", row_number() OVER (ORDER BY "folio") AS rn
              FROM "chatbot_requests" WHERE "tenantId" = ${tenantId}) AS r ON r.rn = s.rn
        ORDER BY s.g`);
    }
  }

  async function createBotApp(prisma?: PrismaClient) {
    const builder = Test.createTestingModule({
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
    });
    const moduleRef = await (
      prisma
        ? builder.overrideProvider(PrismaService).useValue(prisma)
        : builder
    ).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    apps.push(app);
    const port = (app.getHttpServer().address() as AddressInfo).port;
    return {
      app,
      base: `http://127.0.0.1:${port}`,
      feedService: app.get(ChatbotFeedService),
    };
  }

  const waitingCount = (service: ChatbotFeedService) =>
    [...((service as any).waiting as Map<string, number>).values()].reduce(
      (a, b) => a + b,
      0,
    );

  async function http(
    base: string,
    path: string,
    who: { token: string; tenantId: string },
    signal?: AbortSignal,
  ) {
    const t0 = performance.now();
    const response = await fetch(`${base}${path}`, {
      headers: {
        Authorization: `Bearer ${who.token}`,
        'X-Branch-Id': who.tenantId,
      },
      signal,
    });
    const body: any = await response.json();
    return { status: response.status, body, t0, t1: performance.now() };
  }

  const maxCursor = async (tenantId: string) => {
    const [row] = await adminPrisma.$queryRaw<{ c: bigint }[]>(
      Prisma.sql`SELECT COALESCE(max("cursor"), 0) AS c FROM "chatbot_feed_items" WHERE "tenantId" = ${tenantId}`,
    );
    return row.c;
  };
  const pad = (n: bigint | string) => String(n).padStart(12, '0');

  const enqueue = (tenantId: string, requestId: string) =>
    inTenant(tenantId, () =>
      writerTenant.runInTransaction(async () => {
        await enqueueCancelled(
          writerTenant.getClient(),
          tenantId,
          requestId,
          'NOT_ACTIONABLE',
        );
      }),
    );
  const nextCancelled = () =>
    cancelledPool[cancelledNext++ % cancelledPool.length];

  // ------------------------------------------------------------------ setup

  beforeAll(async () => {
    const seeding = performance.now();
    A = { ...(await createCredential(await createTenant('A'))) };
    B = { tenantId: await createTenant('noise') };
    // B: a big neighbour. C: a quiet tenant with a handful of items.
    const C = await createTenant('quiet');
    // D: a mid-size tenant that went quiet early, while the others kept writing.
    const D = await createTenant('stalled');
    // E: a mid-share tenant with 50k items early and a few at the very end,
    // so a bot that polls after its first block faces a gap of foreign rows.
    const E = await createTenant('gap');
    await seedRequests(A.tenantId, SIZE.openRequests, SIZE.closedRequests);
    await seedRequests(B.tenantId, SIZE.noiseOpen, SIZE.noiseClosed);
    await seedRequests(C, 20, 80);
    await seedRequests(D, 100, 100);
    await seedRequests(E, 200, 200);
    const slices = 40;
    const slice = (n: number, i: number): [number, number] => [
      Math.floor((n * i) / slices) + 1,
      Math.floor((n * (i + 1)) / slices),
    ];
    for (let i = 0; i < slices; i++) {
      const [fromA, toA] = slice(SIZE.feedItems, i);
      await seedFeed(
        A.tenantId,
        SIZE.openRequests + SIZE.closedRequests,
        SIZE.feedItems,
        fromA,
        toA,
      );
      const [fromB, toB] = slice(SIZE.noiseFeedItems, i);
      await seedFeed(
        B.tenantId,
        SIZE.noiseOpen + SIZE.noiseClosed,
        SIZE.noiseFeedItems,
        fromB,
        toB,
      );
      if (i % 10 === 0) await seedFeed(C, 100, 4, i / 10 + 1, i / 10 + 1);
      if (i < 10)
        await seedFeed(E, 400, 60_000, i * 5_000 + 1, (i + 1) * 5_000);
      if (i === slices - 1) await seedFeed(E, 400, 60_000, 50_001, 60_000);
      if (i < 4)
        await seedFeed(D, 200, 40_000, i * 10_000 + 1, (i + 1) * 10_000);
    }
    quiet = C;
    stalled = D;
    gap = E;
    // A fresh table has no statistics; autovacuum would not have run yet.
    await adminPrisma.$executeRawUnsafe('ANALYZE "chatbot_requests"');
    await adminPrisma.$executeRawUnsafe('ANALYZE "chatbot_feed_items"');
    cancelledPool = (
      await adminPrisma.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id" FROM "chatbot_requests"
        WHERE "tenantId" = ${A.tenantId} AND "status" = 'CANCELLED'
        ORDER BY "folio" DESC LIMIT 4000`)
    ).map((row) => row.id);
    main = await createBotApp();

    const [version] = await adminPrisma.$queryRaw<
      { v: string }[]
    >`SELECT version() AS v`;
    const [shared] = await adminPrisma.$queryRaw<
      { s: string }[]
    >`SELECT current_setting('shared_buffers') AS s`;
    const counts = await adminPrisma.$queryRaw<any[]>(Prisma.sql`
      SELECT (SELECT count(*) FROM "chatbot_requests" WHERE "tenantId" = ${A.tenantId} AND "status" IN ('NEW','IN_PROGRESS'))::int AS open,
             (SELECT count(*) FROM "chatbot_requests" WHERE "tenantId" = ${A.tenantId})::int AS requests,
             (SELECT count(*) FROM "chatbot_feed_items" WHERE "tenantId" = ${A.tenantId})::int AS feed,
             (SELECT count(*) FROM "chatbot_feed_items" WHERE "tenantId" = ${A.tenantId} AND "ackedAt" IS NULL)::int AS undelivered,
             (SELECT count(*) FROM "chatbot_requests")::int AS "tableRequests",
             (SELECT count(*) FROM "chatbot_feed_items")::int AS "tableFeed"`);
    report.machine = {
      cpu: `${os.cpus()[0].model} x${os.cpus().length}`,
      memoryGb: round(os.totalmem() / 1024 ** 3),
      node: process.version,
      postgres: version.v,
      sharedBuffers: shared.s,
      note: 'Local Docker PostgreSQL, the load generator, the Nest app and the writers share one machine and one Node process: numbers are conservative for latency and not representative of production hardware.',
    };
    report.sizes = {
      ...SIZE,
      tenantA: counts[0],
      seedSeconds: round((performance.now() - seeding) / 1000),
    };
  }, 1_800_000);

  afterAll(async () => {
    for (const app of apps) await app.close();
    await adminPrisma.serviceRateBucket.deleteMany({
      where: { credentialId: { in: credentials } },
    });
    await adminPrisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await writerPrisma.$disconnect();
    await adminPrisma.$disconnect();
    const path =
      process.env.PERF_REPORT_PATH ?? '/tmp/chatbot-feed-load-report.json';
    report.verdicts = verdicts;
    writeFileSync(path, JSON.stringify(report, null, 2));
    console.log(
      `\n[perf] report written to ${path}\n${JSON.stringify({ sizes: report.sizes, verdicts }, null, 2)}`,
    );
    if (process.env.PERF_ENFORCE === '1') {
      expect(verdicts.filter((v) => !v.pass)).toEqual([]);
    }
  }, 600_000);

  // ----------------------------------------- (a) commit → long-poll return

  it('(a) commit → long-poll return latency, one enqueue at a time and from parallel transactions', async () => {
    // (a1) A poll is waiting, one transaction enqueues and commits.
    const commitToBot: number[] = [];
    const startToBot: number[] = [];
    for (let i = 0; i < SIZE.sequentialSamples; i++) {
      const requestId = nextCancelled();
      const after = await maxCursor(A.tenantId);
      const poll = http(
        main.base,
        `/chatbot-api/feed?after=${pad(after)}&waitSeconds=25`,
        A,
      );
      for (let spins = 0; waitingCount(main.feedService) < 1; spins++) {
        if (spins > 2_000) throw new Error('the poll never started waiting');
        await sleep(1);
      }
      const tStart = performance.now();
      await enqueue(A.tenantId, requestId);
      const tCommit = performance.now();
      const answer = await poll;
      expect(answer.status).toBe(200);
      expect(answer.body.items.map((item: any) => item.requestId)).toEqual([
        requestId,
      ]);
      commitToBot.push(Math.max(0, answer.t1 - tCommit));
      startToBot.push(answer.t1 - tStart);
    }

    // (a2) Parallel writers, one reader that loops on the feed.
    const total = SIZE.parallelRounds * SIZE.parallelWidth;
    const committedAt = new Map<string, number>();
    const seenAt = new Map<string, number>();
    const cursors: bigint[] = [];
    const stop = new AbortController();
    let cursor = pad(await maxCursor(A.tenantId));
    const reader = (async () => {
      while (!stop.signal.aborted) {
        try {
          const answer = await http(
            main.base,
            `/chatbot-api/feed?after=${cursor}&limit=50&waitSeconds=25`,
            A,
            stop.signal,
          );
          for (const item of answer.body.items) {
            if (!seenAt.has(item.requestId))
              seenAt.set(item.requestId, answer.t1);
            cursors.push(BigInt(item.cursor));
          }
          cursor = answer.body.nextCursor;
        } catch {
          return;
        }
      }
    })();
    const startedAt = performance.now();
    for (let round = 0; round < SIZE.parallelRounds; round++) {
      await Promise.all(
        Array.from({ length: SIZE.parallelWidth }, async () => {
          const requestId = nextCancelled();
          await enqueue(A.tenantId, requestId);
          committedAt.set(requestId, performance.now());
        }),
      );
    }
    for (let spins = 0; seenAt.size < total && spins < 10_000; spins++)
      await sleep(1);
    stop.abort();
    await reader;
    expect(seenAt.size).toBe(total);
    expect(cursors).toHaveLength(total);
    // Cursor order as the bot receives it: strictly ascending, no repeat.
    expect(cursors.every((c, i) => i === 0 || c > cursors[i - 1])).toBe(true);
    let seenBeforeAck = 0;
    const parallel = [...committedAt].map(([requestId, committed]) => {
      const delta = (seenAt.get(requestId) as number) - committed;
      if (delta < 0) seenBeforeAck++;
      return Math.max(0, delta);
    });

    const all = [...commitToBot, ...parallel];
    report.a = {
      samples: all.length,
      sequential: {
        commitToBotMs: stats(commitToBot),
        transactionStartToBotMs: stats(startToBot),
      },
      parallel: {
        writers: SIZE.parallelWidth,
        rounds: SIZE.parallelRounds,
        commitToBotMs: stats(parallel),
        seenBeforeCommitAck: seenBeforeAck,
        wallSeconds: round((performance.now() - startedAt) / 1000),
        cursorOrderStrictlyAscending: true,
        itemsDelivered: seenAt.size,
      },
      allCommitToBotMs: stats(all),
    };
    verdict(
      'Feed: commit → bot p95 (all samples)',
      `< ${TARGETS.commitToBotP95Ms} ms`,
      `p95 ${report.a.allCommitToBotMs.p95} ms (p50 ${report.a.allCommitToBotMs.p50}, p99 ${report.a.allCommitToBotMs.p99}, n=${all.length})`,
      report.a.allCommitToBotMs.p95 < TARGETS.commitToBotP95Ms,
    );
  }, 900_000);

  // --------------------------------------------- (b) queries at this size

  it('(b) feed read, pending-deliveries and recovery latency at size, plus EXPLAIN (ANALYZE, BUFFERS)', async () => {
    const [{ lo, hi }] = await adminPrisma.$queryRaw<
      { lo: bigint; hi: bigint }[]
    >(Prisma.sql`
      SELECT min("cursor") AS lo, max("cursor") AS hi FROM "chatbot_feed_items" WHERE "tenantId" = ${A.tenantId}`);
    const span = Number(hi - lo);
    const random = (n: number) => Math.floor(Math.random() * n);
    const samples = 200;

    const timed = async (
      _label: string,
      n: number,
      make: (i: number) => string,
    ) => {
      const ms: number[] = [];
      for (let i = 0; i < n; i++) {
        const answer = await http(main.base, make(i), A);
        expect(answer.status).toBe(200);
        ms.push(answer.t1 - answer.t0);
      }
      return stats(ms);
    };

    // Warm the app (guard, plans) before measuring.
    for (let i = 0; i < 20; i++)
      await http(main.base, '/chatbot-api/feed?waitSeconds=0&limit=50', A);

    const deferredRows = await adminPrisma.$queryRaw<
      { conversationRef: string; requestId: string }[]
    >(Prisma.sql`
      SELECT "conversationRef", "requestId" FROM "chatbot_feed_items"
      WHERE "tenantId" = ${A.tenantId} AND "outcome" LIKE 'DEFERRED_%' AND "ackedAt" IS NULL
      ORDER BY "cursor" DESC LIMIT 300`);

    const feedRandom = await timed(
      '',
      samples,
      () =>
        `/chatbot-api/feed?after=${pad(lo + BigInt(random(span)))}&limit=50&waitSeconds=0`,
    );
    const feedTail = await timed(
      '',
      samples,
      () => `/chatbot-api/feed?after=${pad(hi - 10n)}&limit=50&waitSeconds=0`,
    );
    const pendingByConversation = await timed(
      '',
      samples,
      (i) =>
        `/chatbot-api/requests/pending-deliveries?conversationRef=${encodeURIComponent(deferredRows[i % deferredRows.length].conversationRef)}`,
    );
    const pendingByRequest = await timed(
      '',
      samples,
      (i) =>
        `/chatbot-api/requests/pending-deliveries?requestId=${deferredRows[i % deferredRows.length].requestId}`,
    );

    // Recovery: walk every page, as the bot does after a 410.
    const walk = async (query: string) => {
      const pageMs: number[] = [];
      let cursorToken: string | null = null;
      let items = 0;
      let nextCursor = '';
      const t0 = performance.now();
      do {
        const answer = await http(
          main.base,
          `/chatbot-api/requests?${query}&limit=50${cursorToken ? `&cursor=${cursorToken}` : ''}`,
          A,
        );
        expect(answer.status).toBe(200);
        pageMs.push(answer.t1 - answer.t0);
        items += answer.body.items.length;
        nextCursor = answer.body.nextCursor;
        cursorToken = answer.body.nextPage;
      } while (cursorToken);
      const decile = Math.max(1, Math.floor(pageMs.length / 10));
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      return {
        pages: pageMs.length,
        items,
        totalSeconds: round((performance.now() - t0) / 1000),
        pageMs: stats(pageMs),
        firstDecileMeanMs: round(mean(pageMs.slice(0, decile))),
        lastDecileMeanMs: round(mean(pageMs.slice(-decile))),
        nextCursor,
      };
    };
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const recoveryOpen = await walk('status=open');
    const recoverySince = await walk(
      `status=open&updatedSince=${thirtyDaysAgo}`,
    );

    report.b = {
      http: {
        note: 'Through the real Nest app over HTTP: guard + rate-bucket write + query + serialization.',
        feedReadRandomCursor: feedRandom,
        feedReadNearTail: feedTail,
        pendingDeliveriesByConversationRef: pendingByConversation,
        pendingDeliveriesByRequestId: pendingByRequest,
        recoveryWalkOpenOnly: recoveryOpen,
        recoveryWalkUpdatedSince30d: recoverySince,
      },
    };
    expect(recoveryOpen.items).toBe(SIZE.openRequests);
    verdict(
      'Feed read (50 items) at 200k items',
      'no contract target; informational',
      `p95 ${feedRandom.p95} ms over HTTP (n=${samples})`,
      true,
    );
    verdict(
      'Recovery page (50 requests), full walk of the open set',
      'no contract target; informational',
      `p95 ${recoveryOpen.pageMs.p95} ms/page, ${recoveryOpen.pages} pages in ${recoveryOpen.totalSeconds} s; first-decile mean ${recoveryOpen.firstDecileMeanMs} ms vs last-decile ${recoveryOpen.lastDecileMeanMs} ms (flat = O(page))`,
      true,
    );

    // EXPLAIN (ANALYZE, BUFFERS) of the statements the stores really run.
    const feedStore = new PrismaChatbotFeedStore(
      writerTenant,
      writerPrisma as unknown as PrismaService,
    );
    const recoveryStore = new PrismaChatbotRecoveryStore(writerTenant);
    const explain: Record<string, string[]> = {};
    const midCursor = lo + BigInt(Math.floor(span / 2));
    const requestIds = (
      await adminPrisma.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id" FROM "chatbot_requests"
        WHERE "tenantId" = ${A.tenantId} AND "status" = 'NEW' ORDER BY "updatedAt" OFFSET ${Math.floor(SIZE.openRequests / 2)} LIMIT 50`)
    ).map((row) => row.id);
    const midOpen = (
      await adminPrisma.$queryRaw<{ id: string; updatedAt: Date }[]>(Prisma.sql`
        SELECT "id", "updatedAt" FROM "chatbot_requests"
        WHERE "tenantId" = ${A.tenantId} AND "status" = 'NEW' ORDER BY "updatedAt", "id" OFFSET ${Math.floor(SIZE.openRequests / 2)} LIMIT 1`)
    )[0];
    const midClosed = (
      await adminPrisma.$queryRaw<{ id: string; updatedAt: Date }[]>(Prisma.sql`
        SELECT "id", "updatedAt" FROM "chatbot_requests"
        WHERE "tenantId" = ${A.tenantId} AND "status" IN ('RESOLVED','CANCELLED')
        ORDER BY "updatedAt", "id" OFFSET ${Math.floor(SIZE.closedRequests / 2)} LIMIT 1`)
    )[0];
    const since = new Date(Date.now() - 30 * 86_400_000);

    async function explainLast(
      label: string,
      run: () => Promise<unknown>,
      tenantId = A.tenantId,
    ) {
      for (let attempt = 0; attempt < 2; attempt++) {
        captured.length = 0;
        // Await INSIDE the context: Prisma promises run when awaited.
        await inTenant(tenantId, async () => {
          await run();
        });
        const statement = [...captured]
          .reverse()
          .find(
            (event) =>
              /^\s*(SELECT|WITH)/i.test(event.query) &&
              /chatbot_/.test(event.query),
          );
        if (!statement) throw new Error(`no statement captured for ${label}`);
        const sql = inline(statement.query, statement.params);
        const rows = await adminPrisma.$queryRawUnsafe<
          Array<Record<string, string>>
        >(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`);
        // The second run is the warm one; keep it.
        if (attempt === 1)
          explain[label] = [
            `-- ${sql.replace(/\s+/g, ' ')}`,
            ...planLines(rows),
          ];
      }
    }
    await explainLast('feed read: readAfter(after=mid, limit 50)', () =>
      feedStore.readAfter(midCursor, 50),
    );
    await explainLast('feed read: assertCursorRetained(after=mid)', () =>
      feedStore.assertCursorRetained(midCursor),
    );
    await explainLast('feed read: nearest-tail readAfter(after=max-10)', () =>
      feedStore.readAfter(hi - 10n, 50),
    );
    await explainLast('pending-deliveries by conversationRef', () =>
      feedStore.pendingDeferred(
        { conversationRef: deferredRows[0].conversationRef },
        50,
      ),
    );
    await explainLast('pending-deliveries by requestId', () =>
      feedStore.pendingDeferred({ requestId: deferredRows[0].requestId }, 50),
    );
    await explainLast('recovery: first page, open only', () =>
      recoveryStore.readPage({ since: null, after: null, limit: 51 }),
    );
    await explainLast('recovery: middle page, open only', () =>
      recoveryStore.readPage({
        since: null,
        after: { updatedAt: midOpen.updatedAt, id: midOpen.id },
        limit: 51,
      }),
    );
    await explainLast(
      'recovery: first page, updatedSince = 30 days ago (open + closed branches)',
      () => recoveryStore.readPage({ since, after: null, limit: 51 }),
    );
    await explainLast('recovery: middle page, updatedSince = 30 days ago', () =>
      recoveryStore.readPage({
        since,
        after: { updatedAt: midClosed.updatedAt, id: midClosed.id },
        limit: 51,
      }),
    );
    await explainLast(
      'recovery: undelivered items of 50 requests (LATERAL)',
      () => recoveryStore.undelivered(requestIds, 5),
    );
    await explainLast('recovery: current feed cursor', () =>
      recoveryStore.currentFeedCursor(),
    );
    // The same read for a big neighbour and for a quiet tenant: the planner
    // picks per tenant, so the (tenantId, cursor) index has to win where the
    // tenant is a small share of the table.
    const range = async (tenantId: string) =>
      (
        await adminPrisma.$queryRaw<{ lo: bigint; hi: bigint }[]>(Prisma.sql`
          SELECT min("cursor") AS lo, max("cursor") AS hi FROM "chatbot_feed_items" WHERE "tenantId" = ${tenantId}`)
      )[0];
    const neighbour = await range(B.tenantId);
    const sparse = await range(quiet);
    await explainLast(
      'feed read, big neighbour tenant B: readAfter(after=mid)',
      () =>
        feedStore.readAfter(
          neighbour.lo + (neighbour.hi - neighbour.lo) / 2n,
          50,
        ),
      B.tenantId,
    );
    await explainLast(
      'feed read, quiet tenant C: readAfter(after=0)',
      () => feedStore.readAfter(0n, 50),
      quiet,
    );
    await explainLast(
      'feed read, quiet tenant C: poll at its own tail (after=its max, others keep writing)',
      () => feedStore.readAfter(sparse.hi, 50),
      quiet,
    );
    const idle = await range(stalled);
    await explainLast(
      'feed read, stalled tenant D (40k items, none for a long time): poll at its own tail (after=its max)',
      () => feedStore.readAfter(idle.hi, 50),
      stalled,
    );
    // E: after its first block of 50 000 items, the next item of E is behind a
    // gap of foreign rows. The shape this slice replaced (a head-cursor bound
    // on `tenantId = $1 AND cursor > $2`) is explained next to the current one.
    const endOfFirstBlock = (
      await adminPrisma.$queryRaw<{ cursor: bigint }[]>(Prisma.sql`
        SELECT "cursor" FROM "chatbot_feed_items" WHERE "tenantId" = ${gap}
        ORDER BY "cursor" OFFSET 49999 LIMIT 1`)
    )[0].cursor;
    const gapLabel =
      'feed read, mid-share tenant E after a gap of foreign rows: readAfter(after = end of its first block)';
    const legacyLabel =
      'feed read, tenant E after the gap, PREVIOUS shape (tenantId = $1 AND cursor > $2 AND cursor <= head): for comparison only';
    await explainLast(
      gapLabel,
      () => feedStore.readAfter(endOfFirstBlock, 50),
      gap,
    );
    await explainLast(
      legacyLabel,
      () =>
        writerTenant.getClient().$queryRaw(Prisma.sql`
          SELECT "cursor", "deliveryId"::text AS "deliveryId", "type", "requestId",
                 "conversationRef", "payload"
          FROM "chatbot_feed_items"
          WHERE "tenantId" = ${gap} AND "cursor" > ${endOfFirstBlock}
            AND "cursor" <= ${tenantHeadCursor(gap)}
          ORDER BY "cursor" LIMIT 50`),
      gap,
    );
    report.explain = explain;

    const FEED_INDEX = 'chatbot_feed_items_tenantId_cursor_idx';
    const planOf = (label: string) => (explain[label] ?? []).join('\n');
    const executionMs = (label: string) =>
      Number(/Execution Time: ([\d.]+) ms/.exec(planOf(label))?.[1] ?? NaN);
    const buffers = (label: string) => {
      const line = /Buffers: shared (hit=\d+)?(?: )?(read=\d+)?/.exec(
        planOf(label),
      );
      return (line?.slice(1) ?? []).reduce(
        (sum, part) => sum + Number(part?.split('=')[1] ?? 0),
        0,
      );
    };
    const usedIndex = (label: string) =>
      /Index (?:Only )?Scan(?: Backward)? using "?([\w]+)"? on chatbot_feed_items(?! chatbot_feed_items_1)/.exec(
        planOf(label),
      )?.[1] ?? '?';
    const feedLabels = [
      'feed read: readAfter(after=mid, limit 50)',
      'feed read: nearest-tail readAfter(after=max-10)',
      'feed read, big neighbour tenant B: readAfter(after=mid)',
      'feed read, quiet tenant C: readAfter(after=0)',
      'feed read, quiet tenant C: poll at its own tail (after=its max, others keep writing)',
      'feed read, stalled tenant D (40k items, none for a long time): poll at its own tail (after=its max)',
      gapLabel,
    ];
    verdict(
      'Feed read always uses index (tenantId, cursor): every tenant shape, including a mid-share tenant after a gap',
      `Index Scan on ${FEED_INDEX} for all ${feedLabels.length} cases`,
      feedLabels
        .map((label) =>
          usedIndex(label) === FEED_INDEX ? 'yes' : `NO (${usedIndex(label)})`,
        )
        .join(' / '),
      feedLabels.every((label) => usedIndex(label) === FEED_INDEX),
    );
    verdict(
      'Feed read after a gap of foreign rows (tenant E) reads a bounded number of buffers',
      'under 100 buffers',
      `${buffers(gapLabel)} buffers, ${executionMs(gapLabel)} ms (previous shape: ${usedIndex(legacyLabel)}, ${buffers(legacyLabel)} buffers, ${executionMs(legacyLabel)} ms)`,
      buffers(gapLabel) < 100,
    );
    verdict(
      'Feed read plans of the big tenants are fast',
      'under 5 ms',
      `A ${executionMs('feed read: readAfter(after=mid, limit 50)')} ms, B ${executionMs('feed read, big neighbour tenant B: readAfter(after=mid)')} ms, D (idle) ${executionMs(feedLabels[5])} ms`,
      feedLabels.every((label) => executionMs(label) < 5),
    );
    // The invariant this slice's query shape exists for.
    expect(usedIndex(gapLabel)).toBe(FEED_INDEX);
    expect(buffers(gapLabel)).toBeLessThan(100);
  }, 1_800_000);

  // ------------------------------------------- (c) an idle long-poll is free

  it('(c) idle long-polls hold no pool connection, open no connection and issue no queries', async () => {
    const queries: string[] = [];
    const limited = new PrismaClient({
      // Named, so its server connections can be counted apart from the rest.
      datasources: {
        db: { url: `${withLimit(1)}&application_name=perf-idle-app` },
      },
      log: [{ emit: 'event', level: 'query' }],
    });
    (limited as any).$on('query', (event: any) => queries.push(event.query));
    const idle = await createBotApp(limited);
    const bots = await Promise.all(
      Array.from({ length: Math.ceil(SIZE.idlePolls / 2) }, () =>
        createCredential(A.tenantId),
      ),
    );
    // Server connections of the idle app's pool (one slot) and of the whole
    // database (informational: the harness' own pools come and go).
    const connections = async () => {
      const [row] = await adminPrisma.$queryRaw<
        { app: bigint; busy: bigint; total: bigint }[]
      >`SELECT count(*) FILTER (WHERE application_name = 'perf-idle-app') AS app,
               count(*) FILTER (WHERE application_name = 'perf-idle-app' AND state <> 'idle') AS busy,
               count(*) AS total
        FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()`;
      return {
        app: Number(row.app),
        busy: Number(row.busy),
        total: Number(row.total),
      };
    };
    // Process-wide CPU (user + system) over `count` windows of `ms`; the median
    // ignores a stray GC or a worker tick. Queries are the app Prisma client's.
    const cpuWindow = async (count: number, ms: number) => {
      const perWindow: number[] = [];
      const queriesBefore = queries.length;
      for (let i = 0; i < count; i++) {
        const before = process.cpuUsage();
        await sleep(ms);
        const cpu = process.cpuUsage(before);
        perWindow.push(round((cpu.user + cpu.system) / 1000 / (ms / 1000)));
      }
      const sorted = [...perWindow].sort((a, b) => a - b);
      return {
        cpuMsPerSecond: sorted[Math.floor(sorted.length / 2)],
        cpuMsPerSecondWindows: perWindow,
        appQueries: queries.length - queriesBefore,
      };
    };

    // Warm the idle app: its pool connection and the LISTEN connection exist
    // from here on, so the polls below are compared against a settled baseline.
    await http(
      idle.base,
      `/chatbot-api/feed?after=${pad(await maxCursor(A.tenantId))}&waitSeconds=1`,
      bots[0],
    );
    // The first seconds after a busy phase carry GC and pool housekeeping CPU.
    await sleep(6_000);
    const baselineConnections = await connections();
    const baseline = await cpuWindow(int('PERF_CPU_WINDOWS', 3), 1_500);

    const abort = new AbortController();
    const after = pad(await maxCursor(A.tenantId));
    const polls = Array.from({ length: SIZE.idlePolls }, (_v, i) =>
      http(
        idle.base,
        `/chatbot-api/feed?after=${after}&waitSeconds=25`,
        bots[Math.floor(i / 2)],
        abort.signal,
      ).catch(() => null),
    );
    for (
      let spins = 0;
      waitingCount(idle.feedService) < SIZE.idlePolls;
      spins++
    ) {
      if (spins > 5_000)
        throw new Error(
          `only ${waitingCount(idle.feedService)} polls are waiting`,
        );
      await sleep(1);
    }
    const waiting = waitingCount(idle.feedService);
    const connectionsWhileWaiting = await connections();
    // The app's pool has ONE connection: if a waiting poll held it, this blocks.
    const probe: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      await limited.$queryRaw`SELECT 1`;
      probe.push(performance.now() - t0);
    }
    const idleWindow = await cpuWindow(int('PERF_CPU_WINDOWS', 3), 1_500);
    abort.abort();
    await Promise.all(polls);
    for (
      let spins = 0;
      waitingCount(idle.feedService) > 0 && spins < 5_000;
      spins++
    )
      await sleep(1);
    const freed = waitingCount(idle.feedService) === 0;
    await limited.$disconnect();

    report.c = {
      waitingLongPolls: waiting,
      credentials: bots.length,
      appPoolConnectionLimit: 1,
      idleAppConnectionsBefore: baselineConnections.app,
      idleAppConnectionsWhileWaiting: connectionsWhileWaiting.app,
      idleAppBusyConnectionsWhileWaiting: connectionsWhileWaiting.busy,
      databaseConnectionsBefore: baselineConnections.total,
      databaseConnectionsWhileWaiting: connectionsWhileWaiting.total,
      poolProbeSelect1Ms: stats(probe),
      baselineWindows: baseline,
      idleWindows: idleWindow,
      slotsFreedAfterAbort: freed,
      note: 'appQueries counts statements issued by the app Prisma client; the NOTIFY listener is a separate pg connection opened at boot.',
    };
    verdict(
      `Idle long-polls (${waiting} waiting) do not hold the pool`,
      `SELECT 1 on a 1-connection pool p95 < ${TARGETS.poolProbeP95Ms} ms`,
      `p95 ${report.c.poolProbeSelect1Ms.p95} ms`,
      report.c.poolProbeSelect1Ms.p95 < TARGETS.poolProbeP95Ms,
    );
    verdict(
      `Idle long-polls open no DB connection (${waiting} polls, a pool of 1)`,
      "the app's server connections while waiting <= before, and none busy",
      `${baselineConnections.app} → ${connectionsWhileWaiting.app} (busy ${connectionsWhileWaiting.busy}); whole database ${baselineConnections.total} → ${connectionsWhileWaiting.total} (informational)`,
      connectionsWhileWaiting.app <= baselineConnections.app &&
        connectionsWhileWaiting.busy === 0,
    );
    verdict(
      'Idle long-polls issue no queries',
      '0 app queries over the idle windows',
      `${idleWindow.appQueries} (baseline ${baseline.appQueries})`,
      idleWindow.appQueries === 0,
    );
    verdict(
      'Idle long-polls use no CPU',
      `< ${TARGETS.idleCpuMsPerSecond} CPU ms per second`,
      `${idleWindow.cpuMsPerSecond} ms/s (baseline without polls ${baseline.cpuMsPerSecond} ms/s)`,
      idleWindow.cpuMsPerSecond < TARGETS.idleCpuMsPerSecond,
    );
    expect(freed).toBe(true);
  }, 300_000);

  // ------------------------------------ (d) the per-tenant enqueue lock

  it('(d) throughput of the per-tenant enqueue lock', async () => {
    const run = async (
      label: string,
      writers: Array<{ tenantId: string; ids: string[] }>,
    ) => {
      const latencies: number[] = [];
      let errors = 0;
      const deadline = performance.now() + SIZE.writerSeconds * 1000;
      const t0 = performance.now();
      await Promise.all(
        writers.map(async (writer, index) => {
          for (
            let i = index;
            performance.now() < deadline;
            i += writers.length
          ) {
            const started = performance.now();
            try {
              await enqueue(writer.tenantId, writer.ids[i % writer.ids.length]);
              latencies.push(performance.now() - started);
            } catch {
              errors++;
            }
          }
        }),
      );
      const seconds = (performance.now() - t0) / 1000;
      return {
        label,
        writers: writers.length,
        enqueues: latencies.length,
        errors,
        enqueuesPerSecond: round(latencies.length / seconds),
        transactionMs: stats(latencies),
      };
    };
    const own = Array.from({ length: 10 }, () => ({
      tenantId: '',
      ids: [] as string[],
    }));
    for (const writer of own) {
      writer.tenantId = await createTenant('writer');
      await seedRequests(writer.tenantId, 0, 1_000);
      writer.ids = (
        await adminPrisma.$queryRaw<{ id: string }[]>(Prisma.sql`
          SELECT "id" FROM "chatbot_requests" WHERE "tenantId" = ${writer.tenantId} AND "status" = 'CANCELLED'`)
      ).map((row) => row.id);
    }
    const sameTenant = (n: number) =>
      Array.from({ length: n }, () => ({
        tenantId: A.tenantId,
        ids: cancelledPool,
      }));

    await run('warm-up', sameTenant(2));
    const single = await run('1 writer, one tenant', sameTenant(1));
    const contended = await run(
      '10 writers, ONE tenant (per-tenant lock contended)',
      sameTenant(10),
    );
    const independent = await run(
      '10 writers, 10 tenants (no lock contention)',
      own,
    );
    report.d = {
      seconds: SIZE.writerSeconds,
      single,
      contended,
      independent,
      designLoad:
        'The design is sized for ~60 inbound messages per minute per branch (1 enqueue/s).',
    };
    expect(contended.errors + single.errors + independent.errors).toBe(0);
    verdict(
      'Per-tenant enqueue lock throughput (10 parallel writers, one tenant)',
      'no contract target; informational (design load ~1 enqueue/s per branch)',
      `${contended.enqueuesPerSecond} enqueues/s (1 writer ${single.enqueuesPerSecond}/s; 10 writers on 10 tenants ${independent.enqueuesPerSecond}/s); tx p95 ${contended.transactionMs.p95} ms`,
      true,
    );
  }, 600_000);
});
