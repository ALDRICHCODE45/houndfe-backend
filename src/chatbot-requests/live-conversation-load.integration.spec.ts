/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- load-test harness: untyped query events, supertest bodies and a printed report */
/**
 * human-intervention / unit 11 — load test of the live conversation against
 * REAL PostgreSQL (contract §10.1 "Cómo se demuestra": a reproducible load
 * test with synthetic data on the test database plus the `EXPLAIN (ANALYZE,
 * BUFFERS)` of the real statements; a missed target is reported with its
 * numbers). Document: `docs/perf/unit-11-live-conversation.md`.
 *
 * OFF by default (skipped without PERF=1). Run it through the project's
 * integration harness (it owns the test-DB URL guard):
 *
 *   PERF=1 pnpm test:integration src/chatbot-requests/live-conversation-load.integration.spec.ts
 *
 * Seeds ONE production-sized tenant (5 000 open requests over ~2 000
 * customers, 20 000 closed, 4 000 chats with 200 000 messages, ~13 000 ended
 * sessions and 1 200 LIVE sessions in every state, some of them due) and two
 * noise tenants (the sweep's candidate queries are global), then measures,
 * over HTTP through the real controllers and guards:
 *
 *   - the staff inbox with the `liveSession` fields (groups first page, a full
 *     walk, counts, detail, the customer list)          target p95 < 200 ms (§10.1)
 *   - the bot's bulk `GET /chatbot-api/conversations/state?mode=HUMAN` pages
 *   - `session-ack` (STARTED, ENDED, replay)
 *   - the staff `POST /chatbot-requests/:id/messages`
 *   - the live session sweep (start / ENDING / idle phases and the notice
 *     phase): drained to zero, then the cost of a tick with nothing due
 *                                                     target < 50 ms per tick (§10.1)
 *
 * and captures EXPLAIN (ANALYZE, BUFFERS) of the inbox `liveSession`
 * subqueries, the bulk read and both sweep candidate queries. Targets are
 * ASSERTED. The report (every number and plan) goes to stdout and to
 * PERF_REPORT_PATH (default /tmp/live-conversation-load-report.json); it is
 * written before the assertion so a failing run still leaves its numbers.
 * Knobs: PERF_OPEN, PERF_CUSTOMERS, PERF_CLOSED, PERF_LIVE, PERF_MSGS,
 * PERF_NOISE_OPEN, PERF_NOISE_CLOSED, PERF_NOISE_LIVE, PERF_SAMPLES.
 */
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import { AsyncLocalStorage } from 'async_hooks';
import { createHash, randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import { ClsModule, ClsService } from 'nestjs-cls';
import { performance } from 'perf_hooks';
import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { PERMISSIONS_KEY } from '../auth/authorization/decorators/require-permissions.decorator';
import type {
  AppAbility,
  AppActions,
  AppSubjects,
} from '../auth/authorization/domain/permission';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { ActiveUserGuard } from '../auth/guards/active-user.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../chatbot-api/domain/service-credential.repository';
import { PrismaServiceCredentialRepository } from '../chatbot-api/infrastructure/prisma-service-credential.repository';
import { BotRateLimitModule } from '../chatbot-api/presentation/guards/bot-rate-limit.module';
import { ServiceAuthGuard } from '../chatbot-api/presentation/guards/service-auth.guard';
import {
  CONVERSATION_MEDIA_STORAGE,
  CONVERSATION_MEDIA_STORE,
  ConversationMediaService,
} from '../conversations/application/conversation-media.service';
import { PrismaConversationMediaStore } from '../conversations/infrastructure/prisma-conversation-media.store';
import { FakeMediaStorage } from '../conversations/test-support/fake-media-storage';
import { InsufficientPermissionsError } from '../shared/domain/domain-error';
import { createAppValidationPipe } from '../shared/listing/app-validation.pipe';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import type { PrismaService } from '../shared/prisma/prisma.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { RealtimeModule } from '../shared/realtime/realtime.module';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import {
  CHATBOT_REQUEST_READ_STORE,
  ChatbotRequestReadsService,
  CUSTOMER_KEY_SEALER,
  INBOX_CLOCK,
  SLA_PAUSE_READER,
} from './application/chatbot-request-reads.service';
import { CustomerKeySealer } from './domain/customer-key-sealer';
import { LiveSessionSweepScheduler } from './infrastructure/live-session-sweep.scheduler';
import { LiveSessionSweepStore } from './infrastructure/live-session-sweep.store';
import { PrismaChatbotRequestReadStore } from './infrastructure/prisma-chatbot-request-read.store';
import { PrismaLiveConversationStore } from './infrastructure/prisma-live-conversation.store';
import { PrismaSlaPauseReader } from './infrastructure/prisma-sla-pause.reader';
import { ChatbotRequestHttpFilter } from './presentation/chatbot-request-http.filter';
import { ChatbotRequestReadsController } from './presentation/chatbot-request-reads.controller';
import {
  BotLiveConversationController,
  LiveConversationStaffController,
} from './presentation/live-conversation.controller';

const PERF =
  process.env.PERF === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  process.env.SKIP_DB_INTEGRATION !== '1';
const describePerf = PERF ? describe : describe.skip;

const int = (name: string, fallback: number) =>
  process.env[name] ? Number(process.env[name]) : fallback;

const SIZE = {
  open: int('PERF_OPEN', 5_000),
  customers: int('PERF_CUSTOMERS', 2_000),
  closed: int('PERF_CLOSED', 20_000),
  /** Open conversation requests that hold a session of the current epoch. */
  live: int('PERF_LIVE', 1_200),
  /** Messages per chat; the chats are 2 × customers (4 000 × 50 = 200 000). */
  msgs: int('PERF_MSGS', 50),
  noiseOpen: int('PERF_NOISE_OPEN', 2_500),
  noiseClosed: int('PERF_NOISE_CLOSED', 10_000),
  noiseLive: int('PERF_NOISE_LIVE', 600),
  samples: int('PERF_SAMPLES', 200),
};

/**
 * §10.1: the grouped inbox is p95 < 200 ms per page; the sweep is < 50 ms per
 * tick. The live conversation has no row of its own: the other hot paths
 * (single-row commands, one page of the bulk read, one sweep candidate) use the
 * 100 ms bar of the paged conversation read. Those are DERIVED, and the
 * document says so.
 */
const TARGETS = { inboxP95Ms: 200, tickMs: 50, derivedP95Ms: 100 };

const SECRET = 'perf-secret-of-some-length';
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
    min: round(sorted[0] ?? 0),
    mean: round(sum / (sorted.length || 1)),
    p50: round(at(50) ?? 0),
    p95: round(at(95) ?? 0),
    p99: round(at(99) ?? 0),
    max: round(sorted[sorted.length - 1] ?? 0),
  };
}

/** `$n` → a literal, so EXPLAIN plans the statement the app really ran. */
function inline(query: string, rawParams: string): string {
  const params: unknown[] = JSON.parse(rawParams);
  const literal = (value: unknown): string => {
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (value === null) return 'NULL';
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return `'${text.replace(/'/g, "''")}'`;
  };
  return query.replace(/\$(\d+)/g, (_m, n: string) =>
    literal(params[Number(n) - 1]),
  );
}

type Grant = [AppActions, AppSubjects];
const ROLES: Record<string, Grant[]> = {
  attendee: [
    ['read', 'ChatbotRequest'],
    ['update', 'ChatbotRequest'],
  ],
  reader: [
    ['read', 'ChatbotRequest'],
    ['read', 'ChatbotConversation'],
    ['read', 'CustomerPhone'],
  ],
};

@Injectable()
class StubGuard implements CanActivate {
  constructor(private readonly cls: ClsService) {}
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string>;
      user: unknown;
      ability: AppAbility;
    }>();
    const tenantId = req.headers['x-test-tenant'];
    const userId = req.headers['x-test-user'];
    const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
    for (const [action, subject] of ROLES[req.headers['x-test-role']] ?? [])
      can(action, subject);
    req.user = { userId, tenantId, isSuperAdmin: false };
    req.ability = build();
    this.cls.set('tenantId', tenantId);
    this.cls.set('userId', userId);
    return true;
  }
}

@Injectable()
class StubPermissionsGuard extends StubGuard {
  constructor(
    cls: ClsService,
    private readonly reflector: Reflector,
  ) {
    super(cls);
  }
  override canActivate(context: ExecutionContext): boolean {
    super.canActivate(context);
    const required = this.reflector.get<Array<[AppActions, AppSubjects]>>(
      PERMISSIONS_KEY,
      context.getHandler(),
    );
    const { ability } = context
      .switchToHttp()
      .getRequest<{ ability: AppAbility }>();
    for (const [action, subject] of required ?? []) {
      if (!ability.can(action, subject))
        throw new InsufficientPermissionsError();
    }
    return true;
  }
}

describePerf('live conversation load test (PostgreSQL, PERF=1)', () => {
  jest.setTimeout(3_600_000);

  const adminPrisma = new PrismaClient();
  const cls = new ClsService<TenantClsStore>(
    new AsyncLocalStorage<TenantClsStore>(),
  );
  // A client that logs every statement: the source of the EXPLAIN inputs.
  const loggedPrisma = new PrismaClient({
    log: [{ emit: 'event', level: 'query' }],
  });
  const tenantPrisma = new TenantPrismaService(
    loggedPrisma as unknown as PrismaService,
    cls,
  );
  const captured: Array<{ query: string; params: string }> = [];
  (loggedPrisma as any).$on('query', (event: any) =>
    captured.push({ query: event.query, params: event.params }),
  );
  const sealer = new CustomerKeySealer(SECRET);
  const reads = new ChatbotRequestReadsService(
    new PrismaChatbotRequestReadStore(tenantPrisma),
    sealer,
    () => new Date(),
  );
  const liveStore = new PrismaLiveConversationStore(tenantPrisma);
  const readerUser = { userId: 'perf-reader', ability: { can: () => false } };
  const inTenant = <T>(tenantId: string, work: () => Promise<T>) =>
    cls.runWith({ tenantId, userId: 'perf-reader', isSuperAdmin: false }, work);

  let app: INestApplication;
  let baseUrl = '';
  const tenants: string[] = [];
  const credentials: string[] = [];
  const staffUserId = randomUUID();
  let A = '';
  let token = '';
  /** The frozen "now" of the seed; the sweep is driven with it (`tick(now)`). */
  let T0 = new Date();
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

  // ------------------------------------------------------------------ seed

  async function seedTenant(
    tenantId: string,
    size: { open: number; closed: number; live: number },
  ) {
    const t0 = T0.toISOString();
    const { open, closed } = size;
    const chats = SIZE.customers * 2;
    // Requests: open (70 % NEW, 30 % IN_PROGRESS; a third are clarifications)
    // and closed over the last 40 days. Every request carries its chat's ref.
    await adminPrisma.$executeRaw(Prisma.sql`
      INSERT INTO "chatbot_requests"
        ("id", "tenantId", "folio", "kind", "subtype", "status", "customerKey",
         "conversationRef", "phoneCountryCode", "phone", "assigneeUserId",
         "assigneeDisplayName", "claimedAt", "claimDeadlineAt", "resolveDeadlineAt",
         "overdueAt", "lastCustomerMessageAt", "whatsappWindowClosesAt",
         "summary", "source", "sourceRequestId", "createdAt", "updatedAt")
      SELECT gen_random_uuid()::text, ${tenantId}, g,
        (CASE WHEN g % 3 = 0 THEN 'CLARIFICATION' ELSE 'CONVERSATION' END)::"ChatbotRequestKind",
        (CASE g % 3 WHEN 0 THEN 'UNKNOWN_QUESTION' WHEN 1 THEN 'TALK_TO_HUMAN' ELSE 'COMPLAINT' END)::"ChatbotRequestSubtype",
        (CASE WHEN g % 10 < 3 THEN 'IN_PROGRESS' ELSE 'NEW' END)::"ChatbotRequestStatus",
        '5255' || lpad(c::text, 8, '0'), 'wa:5255' || lpad(c::text, 8, '0'),
        '52', '55' || lpad(c::text, 8, '0'),
        CASE WHEN g % 10 < 3 THEN 'perf-user-' || (g % 4 + 1) END,
        CASE WHEN g % 10 < 3 THEN 'Perf ' || (g % 4 + 1) END,
        CASE WHEN g % 10 < 3 THEN ${t0}::timestamp - interval '10 minutes' END,
        CASE WHEN g % 10 >= 3 AND g % 7 <> 0 THEN ${t0}::timestamp + ((g % 500) - 100) * interval '1 minute' END,
        CASE WHEN g % 10 < 3 AND g % 7 <> 0 THEN ${t0}::timestamp + ((g % 500) - 100) * interval '1 minute' END,
        CASE WHEN g % 10 = 0 THEN ${t0}::timestamp - interval '5 minutes' END,
        CASE WHEN g % 5 < 2 THEN ${t0}::timestamp - ((g % 24) * interval '1 hour') END,
        CASE WHEN g % 5 < 2 THEN ${t0}::timestamp + ((24 - g % 24) * interval '1 hour') END,
        'Pregunta de prueba', 'perf', gen_random_uuid()::text,
        ${t0}::timestamp - ((${open}::int - g) * interval '3 minutes'), ${t0}::timestamp
      FROM (SELECT g, ((g * 7919) % ${SIZE.customers}::int) + 1 AS c
            FROM generate_series(1, ${open}::int) AS g) s`);
    await adminPrisma.$executeRaw(Prisma.sql`
      INSERT INTO "chatbot_requests"
        ("id", "tenantId", "folio", "kind", "subtype", "status", "customerKey",
         "conversationRef", "phoneCountryCode", "phone", "resolvedByActorId",
         "resolvedByDisplayName", "resolvedAt", "cancelledAt", "cancelReason",
         "closedAt", "summary", "source", "sourceRequestId", "createdAt", "updatedAt")
      SELECT gen_random_uuid()::text, ${tenantId}, ${open}::int + g,
        (CASE WHEN g % 3 = 0 THEN 'CLARIFICATION' ELSE 'CONVERSATION' END)::"ChatbotRequestKind",
        (CASE g % 3 WHEN 0 THEN 'UNKNOWN_QUESTION' WHEN 1 THEN 'TALK_TO_HUMAN' ELSE 'COMPLAINT' END)::"ChatbotRequestSubtype",
        (CASE WHEN g % 2 = 0 THEN 'RESOLVED' ELSE 'CANCELLED' END)::"ChatbotRequestStatus",
        '5255' || lpad(c::text, 8, '0'), 'wa:5255' || lpad(c::text, 8, '0'),
        '52', '55' || lpad(c::text, 8, '0'),
        CASE WHEN g % 2 = 0 THEN 'perf-user-' || (g % 4 + 1) END,
        CASE WHEN g % 2 = 0 THEN 'Perf ' || (g % 4 + 1) END,
        CASE WHEN g % 2 = 0 THEN closed_at END,
        CASE WHEN g % 2 = 1 THEN closed_at END,
        (CASE WHEN g % 2 = 1 THEN 'CUSTOMER_WITHDREW' END)::"ChatbotRequestCancelReason",
        closed_at, 'Pregunta cerrada', 'perf', gen_random_uuid()::text,
        closed_at - interval '2 hours', closed_at
      FROM (SELECT g, ((g * 104729) % ${chats}::int) + 1 AS c,
                   ${t0}::timestamp - ((${closed}::int - g) * (interval '40 days' / ${closed}::int)) AS closed_at
            FROM generate_series(1, ${closed}::int) AS g) s`);

    // Chats and their messages (author alternates customer / bot).
    await adminPrisma.$executeRaw(Prisma.sql`
      INSERT INTO "chatbot_conversations"
        ("id", "tenantId", "conversationRef", "customerKey", "lastCustomerMessageAt",
         "mode", "handoffEpoch", "nextSeq", "createdAt", "updatedAt")
      SELECT gen_random_uuid()::text, ${tenantId}, 'wa:5255' || lpad(c::text, 8, '0'),
        '5255' || lpad(c::text, 8, '0'), ${t0}::timestamp - (c % 20) * interval '1 hour',
        'BOT'::"ConversationMode", 0, ${SIZE.msgs}::int + 1,
        ${t0}::timestamp - interval '30 days', ${t0}::timestamp
      FROM generate_series(1, ${chats}::int) AS c`);
    await adminPrisma.$executeRaw(Prisma.sql`
      INSERT INTO "conversation_messages"
        ("id", "tenantId", "conversationId", "seq", "direction", "author", "type",
         "text", "providerTimestamp", "observedAt", "receivedAt", "purgeAfter")
      SELECT gen_random_uuid()::text, c."tenantId", c."id", s,
        (CASE WHEN s % 2 = 1 THEN 'IN' ELSE 'OUT' END)::"ConversationMessageDirection",
        (CASE WHEN s % 2 = 1 THEN 'CUSTOMER' ELSE 'BOT' END)::"ConversationMessageAuthor",
        'TEXT'::"ConversationMessageType", 'Mensaje de prueba ' || s,
        ${t0}::timestamp - (${SIZE.msgs}::int - s) * interval '1 minute',
        ${t0}::timestamp - (${SIZE.msgs}::int - s) * interval '1 minute',
        ${t0}::timestamp - (${SIZE.msgs}::int - s) * interval '1 minute',
        ${t0}::timestamp + interval '11 months'
      FROM "chatbot_conversations" c
      CROSS JOIN generate_series(1, ${SIZE.msgs}::int) AS s
      WHERE c."tenantId" = ${tenantId}`);

    // History: an ENDED session for every closed conversation request, epochs
    // counted per chat (about 3 per chat, so the "newest epoch" lookups see a
    // real history).
    await adminPrisma.$executeRaw(Prisma.sql`
      INSERT INTO "chatbot_live_sessions"
        ("id", "tenantId", "requestId", "conversationId", "epoch", "state",
         "endReason", "staffUserId", "startSeq", "startedAt", "activeAt",
         "endingAt", "endedAt", "lastStaffActivityAt", "createdAt", "updatedAt")
      SELECT gen_random_uuid()::text, r."tenantId", r."id", c."id",
        row_number() OVER (PARTITION BY c."id" ORDER BY r."folio"), 'ENDED',
        CASE WHEN r."folio" % 5 = 0 THEN 'START_TIMEOUT'
             WHEN r."folio" % 5 = 1 THEN 'IDLE_TIMEOUT' ELSE 'FINISHED' END,
        ${staffUserId}, 1, r."closedAt" - interval '2 hours',
        CASE WHEN r."folio" % 5 = 0 THEN NULL ELSE r."closedAt" - interval '119 minutes' END,
        r."closedAt" - interval '5 minutes', r."closedAt" - interval '1 minute',
        r."closedAt" - interval '10 minutes', r."closedAt" - interval '2 hours',
        r."closedAt"
      FROM "chatbot_requests" r
      JOIN "chatbot_conversations" c
        ON c."tenantId" = r."tenantId" AND c."conversationRef" = r."conversationRef"
      WHERE r."tenantId" = ${tenantId} AND r."kind" = 'CONVERSATION'
        AND r."status" IN ('RESOLVED', 'CANCELLED')`);

    // LIVE sessions on distinct chats (the one-live-session index), on the
    // oldest open conversation request of each customer. By n % 20: 0-3
    // STARTING (n % 20 = 0 overdue), 4-16 ACTIVE, 17-19 ENDING (17 overdue).
    // An ACTIVE session is one of: idle (8 %), long-running with a recent
    // customer (15 %), waiting under 5 min and already noticed (12 %),
    // waiting 6 min (4 %, level-5 notice due), waiting 16 min (2 %, level-15
    // due), a customer message not yet noticed (3 %), or normal (56 %).
    // Every 10th has an earlier reverted epoch on the same request.
    await adminPrisma.$executeRaw(Prisma.sql`
      WITH pick AS (
        SELECT DISTINCT ON (r."customerKey") r."id", r."customerKey", c."id" AS cid
        FROM "chatbot_requests" r
        JOIN "chatbot_conversations" c
          ON c."tenantId" = r."tenantId" AND c."conversationRef" = r."conversationRef"
        WHERE r."tenantId" = ${tenantId} AND r."kind" = 'CONVERSATION'
          AND r."status" IN ('NEW', 'IN_PROGRESS')
        ORDER BY r."customerKey", r."folio"
      ), ranked AS (
        SELECT p.*, row_number() OVER (ORDER BY p."customerKey") AS n FROM pick p
      ), base AS (
        SELECT k.*, (k.n % 20) AS m, ((k.n * 7) % 100) AS j,
          coalesce((SELECT max(s."epoch") FROM "chatbot_live_sessions" s
                    WHERE s."tenantId" = ${tenantId} AND s."conversationId" = k.cid), 0)
            + 1 + (CASE WHEN k.n % 10 = 0 THEN 1 ELSE 0 END) AS epoch
        FROM ranked k WHERE k.n <= ${size.live}::int
      ), spec AS (
        SELECT b.*,
          (CASE WHEN m < 4 THEN 'STARTING' WHEN m < 17 THEN 'ACTIVE' ELSE 'ENDING' END) AS state,
          CASE WHEN m < 4 OR m >= 17 THEN ${t0}::timestamp - interval '3 hours'
               WHEN j < 8 THEN ${t0}::timestamp - interval '150 minutes'
               WHEN j < 23 THEN ${t0}::timestamp - interval '10 minutes'
               WHEN j < 35 THEN ${t0}::timestamp - interval '2 minutes'
               WHEN j < 39 THEN ${t0}::timestamp - interval '6 minutes'
               WHEN j < 41 THEN ${t0}::timestamp - interval '16 minutes'
               WHEN j < 44 THEN ${t0}::timestamp - interval '1 minute'
               ELSE ${t0}::timestamp - interval '40 minutes' END AS lc,
          CASE WHEN m < 4 OR m >= 17 THEN ${t0}::timestamp - interval '2 minutes'
               WHEN j < 8 THEN ${t0}::timestamp - interval '144 minutes'
               WHEN j < 23 THEN ${t0}::timestamp - interval '5 minutes'
               WHEN j < 44 THEN ${t0}::timestamp - interval '30 minutes'
               ELSE ${t0}::timestamp - interval '15 minutes' END AS last_staff,
          CASE WHEN j < 23 THEN ${t0}::timestamp - interval '3 hours'
               WHEN j < 44 THEN ${t0}::timestamp - interval '1 hour'
               ELSE ${t0}::timestamp - interval '20 minutes' END AS active_at
        FROM base b
      ), prior AS (
        INSERT INTO "chatbot_live_sessions"
          ("id", "tenantId", "requestId", "conversationId", "epoch", "state",
           "endReason", "staffUserId", "startSeq", "startedAt", "endedAt",
           "lastStaffActivityAt", "createdAt", "updatedAt")
        SELECT gen_random_uuid()::text, ${tenantId}, sp."id", sp.cid, sp.epoch - 1,
          'ENDED', 'START_TIMEOUT', ${staffUserId}, 1,
          ${t0}::timestamp - interval '1 hour', ${t0}::timestamp - interval '58 minutes',
          ${t0}::timestamp - interval '1 hour', ${t0}::timestamp - interval '1 hour',
          ${t0}::timestamp - interval '58 minutes'
        FROM spec sp WHERE sp.n % 10 = 0
        RETURNING 1
      ), ins AS (
        INSERT INTO "chatbot_live_sessions"
          ("id", "tenantId", "requestId", "conversationId", "epoch", "state",
           "endReason", "staffUserId", "startSeq", "startedAt", "startDeadlineAt",
           "activeAt", "endingAt", "lastStaffActivityAt", "customerNoticeAt",
           "unansweredLevel", "createdAt", "updatedAt")
        SELECT gen_random_uuid()::text, ${tenantId}, sp."id", sp.cid, sp.epoch,
          sp.state, CASE WHEN sp.state = 'ENDING' THEN 'FINISHED' END,
          ${staffUserId}, ${SIZE.msgs}::int + 1,
          CASE WHEN sp.state = 'STARTING' AND sp.m = 0 THEN ${t0}::timestamp - interval '150 seconds'
               WHEN sp.state = 'STARTING' THEN ${t0}::timestamp - interval '20 seconds'
               WHEN sp.state = 'ACTIVE' THEN sp.active_at - interval '10 seconds'
               ELSE ${t0}::timestamp - interval '1 hour' END,
          CASE WHEN sp.state = 'STARTING' AND sp.m = 0 THEN ${t0}::timestamp - interval '30 seconds'
               WHEN sp.state = 'STARTING' THEN ${t0}::timestamp + interval '100 seconds' END,
          CASE WHEN sp.state = 'ACTIVE' THEN sp.active_at END,
          CASE WHEN sp.state = 'ENDING' AND sp.m = 17 THEN ${t0}::timestamp - interval '11 minutes'
               WHEN sp.state = 'ENDING' THEN ${t0}::timestamp - interval '2 minutes' END,
          sp.last_staff,
          CASE WHEN sp.state = 'ACTIVE' AND sp.j BETWEEN 23 AND 40 THEN sp.lc END,
          CASE WHEN sp.state = 'ACTIVE' AND sp.j BETWEEN 39 AND 40 THEN 5 ELSE 0 END,
          ${t0}::timestamp - interval '1 hour', ${t0}::timestamp
        FROM spec sp
        RETURNING 1
      ), chat AS (
        UPDATE "chatbot_conversations" c
        SET "mode" = 'HUMAN'::"ConversationMode", "handoffEpoch" = sp.epoch,
            "lastCustomerMessageAt" = sp.lc
        FROM spec sp WHERE c."id" = sp.cid
        RETURNING 1
      )
      UPDATE "chatbot_requests" r
      SET "status" = (CASE WHEN sp.state = 'ENDING' THEN 'RESOLVED' ELSE 'IN_PROGRESS' END)::"ChatbotRequestStatus",
          "assigneeUserId" = ${staffUserId}, "assigneeDisplayName" = 'Perf Staff',
          "claimedAt" = ${t0}::timestamp - interval '1 hour',
          "resolvedAt" = CASE WHEN sp.state = 'ENDING' THEN ${t0}::timestamp - interval '5 minutes' END,
          "closedAt" = CASE WHEN sp.state = 'ENDING' THEN ${t0}::timestamp - interval '5 minutes' END,
          "resolvedByActorId" = CASE WHEN sp.state = 'ENDING' THEN ${staffUserId} END,
          "resolvedByDisplayName" = CASE WHEN sp.state = 'ENDING' THEN 'Perf Staff' END,
          "nextSlaCheckAt" = CASE WHEN sp.state = 'ENDING' THEN NULL ELSE r."nextSlaCheckAt" END,
          "lastCustomerMessageAt" = sp.lc, "whatsappWindowClosesAt" = sp.lc + interval '24 hours'
      FROM spec sp WHERE r."id" = sp."id"`);

    // The group table (what refreshCustomerGroup maintains), after the states.
    await adminPrisma.$executeRaw(Prisma.sql`
      INSERT INTO "chatbot_customer_groups"
        ("tenantId", "customerKey", "mostUrgentAt", "openCount", "hasOverdue", "updatedAt")
      SELECT "tenantId", "customerKey",
             min(CASE WHEN "status" = 'NEW' THEN "claimDeadlineAt" ELSE "resolveDeadlineAt" END),
             count(*)::int, coalesce(bool_or("overdueAt" IS NOT NULL), false), now()
      FROM "chatbot_requests"
      WHERE "tenantId" = ${tenantId} AND "status" IN ('NEW', 'IN_PROGRESS')
      GROUP BY "tenantId", "customerKey"`);
  }

  // ------------------------------------------------------------------ boot

  beforeAll(async () => {
    const [{ t0 }] = await adminPrisma.$queryRaw<{ t0: Date }[]>(
      Prisma.sql`SELECT now()::timestamp(3) AS t0`,
    );
    T0 = t0;
    await adminPrisma.user.create({
      data: {
        id: staffUserId,
        email: `${staffUserId}@perf.test`,
        hashedPassword: 'x',
        name: 'Perf Staff',
      },
    });
    const started = performance.now();
    for (const [label, size] of [
      ['main', { open: SIZE.open, closed: SIZE.closed, live: SIZE.live }],
      [
        'noise-1',
        {
          open: SIZE.noiseOpen,
          closed: SIZE.noiseClosed,
          live: SIZE.noiseLive,
        },
      ],
      [
        'noise-2',
        {
          open: SIZE.noiseOpen,
          closed: SIZE.noiseClosed,
          live: SIZE.noiseLive,
        },
      ],
    ] as const) {
      const id = randomUUID();
      tenants.push(id);
      await adminPrisma.tenant.create({
        data: { id, name: `Perf ${label}`, slug: `perf-live-${id}` },
      });
      await seedTenant(id, size);
    }
    A = tenants[0];
    await adminPrisma.$executeRawUnsafe('ANALYZE "chatbot_requests"');
    await adminPrisma.$executeRawUnsafe('ANALYZE "chatbot_conversations"');
    await adminPrisma.$executeRawUnsafe('ANALYZE "conversation_messages"');
    await adminPrisma.$executeRawUnsafe('ANALYZE "chatbot_live_sessions"');
    await adminPrisma.$executeRawUnsafe('ANALYZE "chatbot_customer_groups"');
    report.seedSeconds = round((performance.now() - started) / 1000);

    token = `svc_${randomUUID()}`;
    const credential = await adminPrisma.serviceCredential.create({
      data: {
        tenantId: A,
        name: 'perf-bot',
        hashedKey: createHash('sha256').update(token).digest('hex'),
        scopes: ['requests:read', 'conversation:write'],
        rateLimit: 9_999_999,
        rateLimits: {
          read: 9_999_999,
          write: 9_999_999,
          feed: 9_999_999,
          control: 9_999_999,
        },
      },
    });
    credentials.push(credential.id);

    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        DatabaseModule,
        BotRateLimitModule,
        RealtimeModule,
      ],
      controllers: [
        ChatbotRequestReadsController,
        LiveConversationStaffController,
        BotLiveConversationController,
      ],
      providers: [
        ServiceAuthGuard,
        ChatbotRequestHttpFilter,
        ChatbotRequestReadsService,
        ConversationMediaService,
        {
          provide: CONVERSATION_MEDIA_STORE,
          useClass: PrismaConversationMediaStore,
        },
        {
          provide: CONVERSATION_MEDIA_STORAGE,
          useValue: new FakeMediaStorage(),
        },
        PrismaLiveConversationStore,
        {
          provide: CHATBOT_REQUEST_READ_STORE,
          useClass: PrismaChatbotRequestReadStore,
        },
        { provide: CUSTOMER_KEY_SEALER, useValue: sealer },
        { provide: INBOX_CLOCK, useValue: () => new Date() },
        { provide: SLA_PAUSE_READER, useClass: PrismaSlaPauseReader },
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
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  }, 3_600_000);

  afterAll(async () => {
    await app?.close();
    await adminPrisma.serviceRateBucket.deleteMany({
      where: { credentialId: { in: credentials } },
    });
    await adminPrisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await adminPrisma.user.deleteMany({ where: { id: staffUserId } });
    await adminPrisma.$disconnect();
    await loggedPrisma.$disconnect();
  });

  // --------------------------------------------------------------- helpers

  const server = () => request(baseUrl);
  const staffHeaders = (role: string, userId = 'perf-reader') => ({
    'x-test-role': role,
    'x-test-tenant': A,
    'x-test-user': userId,
  });
  const asBot = (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`).set('X-Branch-Id', A);

  async function timeHttp(
    run: () => request.Test,
    expected = 200,
  ): Promise<{ ms: number; body: any }> {
    const started = performance.now();
    const res = await run();
    const ms = performance.now() - started;
    if (res.status !== expected) {
      throw new Error(
        `expected ${expected}, got ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`,
      );
    }
    return { ms, body: res.body };
  }

  async function sampleHttp(
    n: number,
    run: (i: number) => request.Test,
    expected = 200,
  ) {
    for (let i = 0; i < 5; i++) await timeHttp(() => run(i), expected);
    const values: number[] = [];
    for (let i = 0; i < n; i++) {
      values.push((await timeHttp(() => run(i), expected)).ms);
    }
    return stats(values);
  }

  /** EXPLAIN (ANALYZE, BUFFERS) twice (the second is the warm run). */
  async function explainSql(sql: string) {
    let plan: string[] = [];
    for (let i = 0; i < 2; i++) {
      const rows = await adminPrisma.$queryRawUnsafe<
        Array<Record<string, string>>
      >(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`);
      plan = rows.map((row) => row['QUERY PLAN']);
    }
    return plan;
  }

  /** Runs `run` under the logged client and explains the statement `match` finds. */
  async function explainCaptured(
    tenantId: string,
    match: RegExp,
    run: () => Promise<unknown>,
  ) {
    captured.length = 0;
    await inTenant(tenantId, async () => {
      await run();
    });
    const statement = [...captured]
      .reverse()
      .find((e) => /^\s*(SELECT|WITH)/i.test(e.query) && match.test(e.query));
    if (!statement) throw new Error(`no statement captured for ${match}`);
    const sql = inline(statement.query, statement.params);
    return { sql: sql.replace(/\s+/g, ' '), plan: await explainSql(sql) };
  }

  const usesIndex = (plan: string[], name: string) =>
    plan.some((line) => line.includes(name));
  const seqScans = (plan: string[]) =>
    plan.filter((line) => /Seq Scan on chatbot_live_sessions/.test(line));

  // ------------------------------------------------------------- the test

  it('measures the live conversation at scale and captures EXPLAIN (ANALYZE, BUFFERS)', async () => {
    report.sizes = SIZE;
    const sizes = await adminPrisma.$queryRaw<
      Array<{ tenant: string; what: string; n: number }>
    >(Prisma.sql`
      SELECT CASE WHEN "tenantId" = ${A} THEN 'A' ELSE 'noise' END AS tenant,
             'sessions ' || "state" AS what, count(*)::int AS n
      FROM "chatbot_live_sessions" WHERE "tenantId" = ANY(${tenants})
      GROUP BY 1, 2 ORDER BY 1, 2`);
    const [totals] = await adminPrisma.$queryRaw<
      Array<Record<string, number>>
    >(Prisma.sql`
      SELECT
        (SELECT count(*)::int FROM "chatbot_live_sessions") AS sessions,
        (SELECT count(*)::int FROM "chatbot_requests") AS requests,
        (SELECT count(*)::int FROM "chatbot_conversations") AS chats,
        (SELECT count(*)::int FROM "conversation_messages") AS messages,
        (SELECT count(*)::int FROM "chatbot_requests"
          WHERE "tenantId" = ${A} AND "status" IN ('NEW', 'IN_PROGRESS')) AS "openA",
        (SELECT count(*)::int FROM "conversation_messages"
          WHERE "tenantId" = ${A}) AS "messagesA",
        (SELECT count(*)::int FROM "chatbot_conversations"
          WHERE "tenantId" = ${A} AND "mode" = 'HUMAN') AS "humanA"`);
    report.seed = { bySessionState: sizes, tables: totals };

    // ---------------------------------------------------- (a) staff inbox
    const reader = (path: string) =>
      server().get(path).set(staffHeaders('reader'));
    const groupsPath = (cursor?: string) =>
      `/chatbot-requests/groups?limit=25${cursor ? `&cursor=${cursor}` : ''}`;
    report.inboxGroupsFirstPage = await sampleHttp(SIZE.samples, () =>
      reader(groupsPath()),
    );
    const walk: number[] = [];
    let cursor: string | undefined;
    let liveRows = 0;
    let groupsSeen = 0;
    let firstCustomerKey = '';
    do {
      const { ms, body } = await timeHttp(() => reader(groupsPath(cursor)));
      walk.push(ms);
      groupsSeen += body.items.length;
      liveRows += (JSON.stringify(body).match(/"liveSession":\{/g) ?? [])
        .length;
      if (!firstCustomerKey) firstCustomerKey = body.items[0].customerKey;
      cursor = body.nextCursor ?? undefined;
    } while (cursor);
    report.inboxGroupsWalk = {
      ...stats(walk),
      pages: walk.length,
      groups: groupsSeen,
      rowsWithLiveSession: liveRows,
    };
    report.inboxCounts = await sampleHttp(SIZE.samples, () =>
      reader('/chatbot-requests/counts'),
    );
    const liveIds = await adminPrisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT s."requestId" AS id FROM "chatbot_live_sessions" s
      WHERE s."tenantId" = ${A} AND s."state" <> 'ENDED'
      ORDER BY s."id" LIMIT 500`);
    report.inboxDetailLive = await sampleHttp(SIZE.samples, (i) =>
      reader(`/chatbot-requests/${liveIds[i % liveIds.length].id}`),
    );
    report.inboxCustomerList = await sampleHttp(SIZE.samples, () =>
      reader(
        `/chatbot-requests?customerKey=${encodeURIComponent(firstCustomerKey)}`,
      ),
    );

    // ------------------------------------------- (b) bulk state (mode=HUMAN)
    const bulk = (limit: number, cursor?: string) =>
      asBot(
        server().get(
          `/chatbot-api/conversations/state?mode=HUMAN&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`,
        ),
      );
    report.bulkFirstPage100 = await sampleHttp(SIZE.samples, () => bulk(100));
    report.bulkFirstPage500 = await sampleHttp(100, () => bulk(500));
    const bulkWalk: number[] = [];
    let bulkCursor: string | undefined;
    let bulkItems = 0;
    do {
      const { ms, body } = await timeHttp(() => bulk(100, bulkCursor));
      bulkWalk.push(ms);
      bulkItems += body.items.length;
      bulkCursor = body.nextCursor ?? undefined;
    } while (bulkCursor);
    report.bulkWalk = { ...stats(bulkWalk), pages: bulkWalk.length, bulkItems };

    // --------------------------------------------------- (c) session-ack
    const ackRows = async (state: 'STARTING' | 'ENDING') =>
      adminPrisma.$queryRaw<{ ref: string; epoch: number }[]>(Prisma.sql`
        SELECT c."conversationRef" AS ref, s."epoch"
        FROM "chatbot_live_sessions" s
        JOIN "chatbot_conversations" c
          ON c."tenantId" = s."tenantId" AND c."id" = s."conversationId"
        WHERE s."tenantId" = ${A} AND s."state" = ${state}
          AND ${
            state === 'STARTING'
              ? Prisma.sql`s."startDeadlineAt" > ${T0}`
              : Prisma.sql`s."endingAt" > ${new Date(T0.getTime() - 10 * 60_000)}`
          }
        ORDER BY s."id"`);
    const ack = (ref: string, body: object) =>
      asBot(
        server().post(
          `/chatbot-api/conversations/${encodeURIComponent(ref)}/session-ack`,
        ),
      ).send(body);
    const starting = await ackRows('STARTING');
    const ending = await ackRows('ENDING');
    const ackStarted: number[] = [];
    for (const row of starting) {
      ackStarted.push(
        (
          await timeHttp(() =>
            ack(row.ref, { epoch: row.epoch, state: 'STARTED' }),
          )
        ).ms,
      );
    }
    const ackEnded: number[] = [];
    for (const row of ending) {
      ackEnded.push(
        (
          await timeHttp(() =>
            ack(row.ref, { epoch: row.epoch, state: 'ENDED' }),
          )
        ).ms,
      );
    }
    const replays: number[] = [];
    for (let i = 0; i < Math.min(SIZE.samples, starting.length); i++) {
      const row = starting[i];
      replays.push(
        (
          await timeHttp(() =>
            ack(row.ref, { epoch: row.epoch, state: 'STARTED' }),
          )
        ).ms,
      );
    }
    const stale: number[] = [];
    for (let i = 0; i < Math.min(100, starting.length); i++) {
      const row = starting[i];
      stale.push(
        (
          await timeHttp(
            () => ack(row.ref, { epoch: row.epoch + 5, state: 'STARTED' }),
            409,
          )
        ).ms,
      );
    }
    report.ackStarted = stats(ackStarted);
    report.ackEnded = stats(ackEnded);
    report.ackReplay = stats(replays);
    report.ackStaleEpoch409 = stats(stale);

    // ------------------------------------------------- (d) staff message
    const normal = await adminPrisma.$queryRaw<
      { id: string; epoch: number }[]
    >(Prisma.sql`
      SELECT s."requestId" AS id, s."epoch"
      FROM "chatbot_live_sessions" s
      JOIN "chatbot_conversations" c
        ON c."tenantId" = s."tenantId" AND c."id" = s."conversationId"
      WHERE s."tenantId" = ${A} AND s."state" = 'ACTIVE'
        AND c."lastCustomerMessageAt" <= s."lastStaffActivityAt"
        AND s."activeAt" <= ${T0}
      ORDER BY s."id" LIMIT 500`);
    const send = (row: { id: string; epoch: number }, text: string) => {
      const clientMessageId = randomUUID();
      return server()
        .post(`/chatbot-requests/${row.id}/messages`)
        .set(staffHeaders('attendee', staffUserId))
        .set('Idempotency-Key', clientMessageId)
        .send({ clientMessageId, expectedEpoch: row.epoch, text });
    };
    for (let i = 0; i < 5; i++) {
      await timeHttp(() => send(normal[400 + i], 'Calentamiento'));
    }
    const sends: number[] = [];
    for (let i = 0; i < Math.min(300, normal.length - 10); i++) {
      sends.push(
        (await timeHttp(() => send(normal[i], 'Hola, ¿en qué te ayudo?'))).ms,
      );
    }
    report.staffSend = stats(sends);
    // The same attendee in a busy chat: 40 messages in a row to one session.
    const busy: number[] = [];
    for (let i = 0; i < 40; i++) {
      busy.push((await timeHttp(() => send(normal[0], `Mensaje ${i}`))).ms);
    }
    report.staffSendSameSession = stats(busy);
    // Concurrency (informational): 10 attendees at once, 10 rounds.
    const parallel: number[] = [];
    for (let round_ = 0; round_ < 10; round_++) {
      const batch = await Promise.all(
        Array.from({ length: 10 }, (_, k) =>
          timeHttp(() => send(normal[100 + round_ * 10 + k], 'En paralelo')),
        ),
      );
      parallel.push(...batch.map((x) => x.ms));
    }
    report.staffSendParallel10 = stats(parallel);

    // ---------------------------------------- (e) EXPLAIN: inbox and bulk
    const plans: Record<string, { sql: string; plan: string[] }> = {};
    plans['inbox groups, first page (liveSession subqueries)'] =
      await explainCaptured(A, /liveSessionState/, () =>
        reads.groups(readerUser, {
          tab: 'open',
          filters: {},
          limit: 25,
        } as never),
      );
    plans['inbox detail of a live request'] = await explainCaptured(
      A,
      /liveSessionState/,
      () => reads.detail(readerUser, liveIds[0].id),
    );
    plans['bulk state, first page of 100'] = await explainCaptured(
      A,
      /"mode" = 'HUMAN'/,
      () => liveStore.listHumanConversations(100, null),
    );
    const humanRefs = await adminPrisma.$queryRaw<{ ref: string }[]>(Prisma.sql`
      SELECT "conversationRef" AS ref FROM "chatbot_conversations"
      WHERE "tenantId" = ${A} AND "mode" = 'HUMAN'
      ORDER BY "conversationRef" OFFSET 600 LIMIT 1`);
    plans['bulk state, a later page'] = await explainCaptured(
      A,
      /"mode" = 'HUMAN'/,
      () => liveStore.listHumanConversations(100, humanRefs[0].ref),
    );

    // ----------------------------------------------------------- (f) sweep
    const ours = tenants;
    const dueNow = async (now: Date) => {
      const [row] = await adminPrisma.$queryRaw<
        Array<Record<string, number>>
      >(Prisma.sql`
        SELECT
          (SELECT count(*)::int FROM "chatbot_live_sessions" s
            WHERE s."tenantId" = ANY(${ours}) AND s."state" = 'STARTING'
              AND coalesce(s."startDeadlineAt", s."startedAt" + interval '120 seconds') <= ${now}) AS starting,
          (SELECT count(*)::int FROM "chatbot_live_sessions" s
            WHERE s."tenantId" = ANY(${ours}) AND s."state" = 'ENDING'
              AND s."endingAt" <= ${new Date(now.getTime() - 10 * 60_000)}) AS ending,
          (SELECT count(*)::int FROM "chatbot_live_sessions" s
            JOIN "chatbot_conversations" c
              ON c."tenantId" = s."tenantId" AND c."id" = s."conversationId"
            WHERE s."tenantId" = ANY(${ours}) AND s."state" = 'ACTIVE'
              AND greatest(coalesce(s."activeAt", s."startedAt"),
                           coalesce(c."lastCustomerMessageAt", '-infinity'))
                  <= ${new Date(now.getTime() - 2 * 3_600_000)}) AS idle,
          (SELECT count(*)::int FROM "chatbot_live_sessions" s
            JOIN "chatbot_conversations" c
              ON c."tenantId" = s."tenantId" AND c."id" = s."conversationId"
            JOIN "chatbot_requests" r
              ON r."tenantId" = s."tenantId" AND r."id" = s."requestId"
            WHERE s."tenantId" = ANY(${ours}) AND s."state" = 'ACTIVE'
              AND r."status" = 'IN_PROGRESS'
              AND c."lastCustomerMessageAt" > s."lastStaffActivityAt"
              AND (s."customerNoticeAt" IS DISTINCT FROM c."lastCustomerMessageAt"
                   OR (s."unansweredLevel" < 5
                       AND c."lastCustomerMessageAt" <= ${new Date(now.getTime() - 5 * 60_000)})
                   OR (s."unansweredLevel" < 15
                       AND c."lastCustomerMessageAt" <= ${new Date(now.getTime() - 15 * 60_000)}))) AS notice`);
      return row;
    };

    // The sweep store on a client that times every per-candidate transaction
    // (and classifies it by what it returned) and logs its statements.
    const timings: Array<{ kind: string; ms: number }> = [];
    const wrap = (dry: boolean) =>
      new Proxy(loggedPrisma, {
        get(target, prop) {
          if (prop === '$transaction') {
            return async (fn: any) => {
              if (dry) return null;
              const started = performance.now();
              const value = await target.$transaction(fn);
              timings.push({
                kind:
                  typeof value === 'number'
                    ? 'notice'
                    : String(value ?? 'skipped'),
                ms: performance.now() - started,
              });
              return value;
            };
          }
          const member = Reflect.get(target, prop, target);
          return typeof member === 'function' ? member.bind(target) : member;
        },
      }) as unknown as PrismaService;
    const sweepPlans = async (label: string) => {
      const dry = new LiveSessionSweepStore(wrap(true));
      captured.length = 0;
      await dry.runBatch(T0);
      const batch = captured.find((e) => /^\s*SELECT/i.test(e.query));
      captured.length = 0;
      await dry.runNoticeBatch(T0);
      const notice = captured.find((e) => /^\s*SELECT/i.test(e.query));
      if (!batch || !notice) throw new Error('sweep statements not captured');
      for (const [name, statement] of [
        [`sweep candidates (start / ENDING / idle), ${label}`, batch],
        [`sweep notice candidates, ${label}`, notice],
      ] as const) {
        const sql = inline(statement.query, statement.params);
        plans[name] = {
          sql: sql.replace(/\s+/g, ' '),
          plan: await explainSql(sql),
        };
      }
    };

    const dueBefore = await dueNow(T0);
    report.sweepDueBefore = dueBefore;
    await sweepPlans('before the drain');

    const store = new LiveSessionSweepStore(wrap(false));
    const scheduler = new LiveSessionSweepScheduler(store);
    const ticks: Array<Record<string, number>> = [];
    let remaining = dueBefore;
    for (let i = 0; i < 40; i++) {
      const started = performance.now();
      const result = await scheduler.tick(T0);
      const ms = performance.now() - started;
      remaining = await dueNow(T0);
      ticks.push({ tick: i + 1, ms: round(ms), ...result, ...remaining });
      const progress =
        result.reverted + result.ended + result.idleEnded + result.noticed;
      if (
        remaining.starting +
          remaining.ending +
          remaining.idle +
          remaining.notice ===
          0 ||
        progress === 0
      ) {
        break;
      }
    }
    report.sweepDrain = { ticks, dueAfter: remaining };
    const byKind = (kind: string) =>
      timings.filter((t) => t.kind === kind).map((t) => t.ms);
    report.sweepPerCandidate = {
      start: byKind('REVERT_START').length
        ? stats(byKind('REVERT_START'))
        : null,
      ending: byKind('MARK_ENDED').length ? stats(byKind('MARK_ENDED')) : null,
      idle: byKind('IDLE_END').length ? stats(byKind('IDLE_END')) : null,
      notice: byKind('notice').length ? stats(byKind('notice')) : null,
      skipped: byKind('skipped').length ? stats(byKind('skipped')) : null,
    };

    // A tick with nothing due: what the sweep costs every 10 s.
    const steady: number[] = [];
    let steadyResult: Record<string, number> = {};
    for (let i = 0; i < 30; i++) {
      const started = performance.now();
      steadyResult = { ...(await scheduler.tick(T0)) };
      steady.push(performance.now() - started);
    }
    report.sweepSteadyTick = { ...stats(steady.slice(5)), last: steadyResult };
    await sweepPlans('steady state, after the drain');
    report.explain = plans;

    // ------------------------------------------------------- (g) verdicts
    const lim = (ms: number) => `< ${ms} ms`;
    const p95 = (x: { p95: number }) => `${x.p95} ms`;
    const inboxP95 = TARGETS.inboxP95Ms;
    verdict(
      'inbox groups, first page (liveSession fields) p95',
      lim(inboxP95),
      p95(report.inboxGroupsFirstPage),
      report.inboxGroupsFirstPage.p95 < inboxP95,
    );
    verdict(
      'inbox groups, every page of a full walk p95',
      lim(inboxP95),
      `${report.inboxGroupsWalk.p95} ms over ${report.inboxGroupsWalk.pages} pages`,
      report.inboxGroupsWalk.p95 < inboxP95,
    );
    verdict(
      'inbox counts / detail of a live request / customer list p95',
      lim(inboxP95),
      `${report.inboxCounts.p95} / ${report.inboxDetailLive.p95} / ${report.inboxCustomerList.p95} ms`,
      report.inboxCounts.p95 < inboxP95 &&
        report.inboxDetailLive.p95 < inboxP95 &&
        report.inboxCustomerList.p95 < inboxP95,
    );
    verdict(
      'the walk really carried liveSession rows',
      '> 0',
      `${liveRows} rows`,
      liveRows > 0,
    );
    for (const name of [
      'inbox groups, first page (liveSession subqueries)',
      'inbox detail of a live request',
    ]) {
      const plan = plans[name].plan;
      verdict(
        `${name}: sessions read through (tenantId, requestId, epoch DESC), no seq scan`,
        'index scan, 0 seq scans',
        `${usesIndex(plan, 'chatbot_live_sessions_tenantId_requestId_epoch_idx') ? 'index' : 'NO index'}, ${seqScans(plan).length} seq scans`,
        usesIndex(plan, 'chatbot_live_sessions_tenantId_requestId_epoch_idx') &&
          seqScans(plan).length === 0,
      );
    }
    verdict(
      'bulk state page of 100 p95 (every page of the walk)',
      lim(TARGETS.derivedP95Ms),
      `${report.bulkFirstPage100.p95} ms first page; ${report.bulkWalk.p95} ms over ${report.bulkWalk.pages} pages; ${report.bulkFirstPage500.p95} ms for 500`,
      report.bulkFirstPage100.p95 < TARGETS.derivedP95Ms &&
        report.bulkWalk.p95 < TARGETS.derivedP95Ms,
    );
    verdict(
      'bulk state returns every HUMAN chat once',
      `${totals.humanA}`,
      `${report.bulkWalk.bulkItems}`,
      report.bulkWalk.bulkItems === totals.humanA,
    );
    // The only Sort in the plan is the one-row `ORDER BY epoch DESC LIMIT 1`
    // inside the per-chat lateral; the page order itself comes from the index.
    const bulkPlan = plans['bulk state, a later page'].plan;
    const bulkIndexed =
      usesIndex(bulkPlan, 'chatbot_conversations_human_idx') &&
      !bulkPlan.some((l) => /Sort Key:.*conversationRef/.test(l));
    verdict(
      'bulk state reads through chatbot_conversations_human_idx, page order from the index (no sort of the chats)',
      'index scan, no chat sort',
      bulkIndexed ? 'yes' : 'no',
      bulkIndexed,
    );
    verdict(
      'session-ack STARTED / ENDED / replay / 409 p95',
      lim(TARGETS.derivedP95Ms),
      `${report.ackStarted.p95} / ${report.ackEnded.p95} / ${report.ackReplay.p95} / ${report.ackStaleEpoch409.p95} ms`,
      Math.max(
        report.ackStarted.p95,
        report.ackEnded.p95,
        report.ackReplay.p95,
        report.ackStaleEpoch409.p95,
      ) < TARGETS.derivedP95Ms,
    );
    verdict(
      'staff message p95 (distinct sessions / same session)',
      lim(TARGETS.derivedP95Ms),
      `${report.staffSend.p95} / ${report.staffSendSameSession.p95} ms (10 in parallel: ${report.staffSendParallel10.p95} ms, informational)`,
      report.staffSend.p95 < TARGETS.derivedP95Ms &&
        report.staffSendSameSession.p95 < TARGETS.derivedP95Ms,
    );
    verdict(
      'sweep drains every due session (start, ENDING, idle, notice)',
      '0 left',
      `${JSON.stringify(remaining)} after ${ticks.length} ticks`,
      remaining.starting +
        remaining.ending +
        remaining.idle +
        remaining.notice ===
        0,
    );
    const slowest = Math.max(
      0,
      ...['start', 'ending', 'idle', 'notice'].map(
        (k) => report.sweepPerCandidate[k]?.p95 ?? 0,
      ),
    );
    verdict(
      'sweep: one candidate (own transaction) p95, slowest phase',
      lim(TARGETS.derivedP95Ms),
      `${slowest} ms`,
      slowest < TARGETS.derivedP95Ms,
    );
    verdict(
      'sweep: a tick with nothing due (p95)',
      lim(TARGETS.tickMs),
      `${report.sweepSteadyTick.p95} ms`,
      report.sweepSteadyTick.p95 < TARGETS.tickMs,
    );
    for (const name of Object.keys(plans).filter((n) =>
      n.startsWith('sweep'),
    )) {
      const plan = plans[name].plan;
      const partial = plan.some((l) =>
        /chatbot_live_sessions_(starting|starting_deadline|ending|active)_idx/.test(
          l,
        ),
      );
      verdict(
        `${name}: partial index, no seq scan of the sessions`,
        'index scan, 0 seq scans',
        `${partial ? 'partial index' : 'NO index'}, ${seqScans(plan).length} seq scans`,
        partial && seqScans(plan).length === 0,
      );
    }
    report.verdicts = verdicts;

    const path =
      process.env.PERF_REPORT_PATH ?? '/tmp/live-conversation-load-report.json';
    writeFileSync(path, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, explain: undefined }, null, 2));
    console.log(`full report with EXPLAIN plans: ${path}`);
    expect(verdicts.filter((v) => !v.pass)).toEqual([]);
  });
});
