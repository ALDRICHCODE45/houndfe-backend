/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- load-test harness: untyped query events, supertest bodies and a printed report */
/**
 * human-intervention / unit 14 — load test of the scheduled conversations
 * against REAL PostgreSQL (contract §10.1 "Cómo se demuestra": a reproducible
 * load test with synthetic data on the test database plus the `EXPLAIN
 * (ANALYZE, BUFFERS)` of the real statements; a missed target is reported with
 * its numbers). Document: `docs/perf/unit-14-scheduled-conversations.md`.
 *
 * OFF by default (skipped without PERF=1). Run it through the project's
 * integration harness (it owns the test-DB URL guard):
 *
 *   PERF=1 pnpm test:integration src/chatbot-requests/scheduled-conversations-load.integration.spec.ts
 *
 * Seeds ONE production-sized tenant (3 000 plain open requests, 2 500 open
 * scheduled ones spread over six weeks with the slot counters filled and about
 * a quarter of the blocks full, 200 scheduled requests whose reminder or
 * "solicitud nueva" is due, 15 000 closed requests, 2 000 closed scheduled
 * ones), two noise tenants (the sweep and the flag pass share the table) and a
 * SPARSE tenant (3 000 open requests, 30 scheduled: the Agendadas tab's worst
 * case), then measures over HTTP through the real controllers and guards:
 *
 *   - the bot slots listing and the staff picker           target p95 < 100 ms (§10.1 "Agenda")
 *   - booking create, the same-key 2xx replay, the 409 SLOT_UNAVAILABLE
 *   - bot and staff reschedule, bot and staff cancel
 *   - the staff inbox with the scheduling fields, the Agendadas tab (first
 *     page and a full walk), counts.scheduled, the detail   target p95 < 200 ms (§10.1)
 *   - the schedule sweep: one batch of due candidates, then a tick with
 *     nothing due                                          target < 50 ms per tick (§10.1)
 *   - the post-commit `needsReschedule` flag pass after the hours change
 *
 * and captures EXPLAIN (ANALYZE, BUFFERS) of the slots counter read, the sweep
 * candidate query, the flag pass query and the inbox scheduled filter. Targets
 * are ASSERTED. §10.1 has rows for the Agenda listing, the inbox and the sweep
 * tick only; every other path (create, replay, reschedule, cancel, one sweep
 * candidate, one flag batch) uses the 100 ms bar derived from them, like
 * unit 11 did, and the document says so.
 *
 * The report (every number and plan) goes to stdout and to PERF_REPORT_PATH
 * (default /tmp/scheduled-conversations-load-report.json); it is written
 * before the assertion so a failing run still leaves its numbers. Knobs:
 * PERF_PLAIN, PERF_SCHEDULED, PERF_DUE, PERF_CLOSED, PERF_HISTORY,
 * PERF_CUSTOMERS, PERF_MSGS, PERF_NOISE_*, PERF_SPARSE_*, PERF_SAMPLES.
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
import { defaultSettings } from '../chatbot-settings/domain/chatbot-attention-settings';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../chatbot-api/domain/service-credential.repository';
import { PrismaServiceCredentialRepository } from '../chatbot-api/infrastructure/prisma-service-credential.repository';
import { BotRateLimitModule } from '../chatbot-api/presentation/guards/bot-rate-limit.module';
import { ServiceAuthGuard } from '../chatbot-api/presentation/guards/service-auth.guard';
import { InsufficientPermissionsError } from '../shared/domain/domain-error';
import { createAppValidationPipe } from '../shared/listing/app-validation.pipe';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import type { PrismaService } from '../shared/prisma/prisma.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { RealtimeModule } from '../shared/realtime/realtime.module';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { WEEKDAYS } from '../shipping/pickup/domain/opening-hours';
import {
  BOT_INTAKE_STORE,
  BotRequestIntakeService,
  LEGACY_INTAKE,
} from './application/bot-request-intake.service';
import {
  CHATBOT_REQUEST_COMMAND_STORE,
  CHATBOT_REQUEST_RESOLVER,
  ChatbotRequestCommandsService,
} from './application/chatbot-request-commands.service';
import {
  CHATBOT_REQUEST_READ_STORE,
  ChatbotRequestReadsService,
  CUSTOMER_KEY_SEALER,
  INBOX_CLOCK,
  SLA_PAUSE_READER,
} from './application/chatbot-request-reads.service';
import {
  SCHEDULING_STORE,
  SchedulingService,
} from './application/scheduling.service';
import { CustomerKeySealer } from './domain/customer-key-sealer';
import { ChatbotRequestWrapper } from './infrastructure/chatbot-request-wrapper';
import { PrismaBotIntakeStore } from './infrastructure/prisma-bot-intake.store';
import { PrismaChatbotRequestCommandStore } from './infrastructure/prisma-chatbot-request-command.store';
import { PrismaChatbotRequestReadStore } from './infrastructure/prisma-chatbot-request-read.store';
import { PrismaSchedulingStore } from './infrastructure/prisma-scheduling.store';
import { PrismaSlaPauseReader } from './infrastructure/prisma-sla-pause.reader';
import { ScheduleSweepScheduler } from './infrastructure/schedule-sweep.scheduler';
import { ScheduleSweepStore } from './infrastructure/schedule-sweep.store';
import { flagUnbookableSchedules } from './infrastructure/scheduled-reschedule-flag';
import { readFullBlocks } from './infrastructure/scheduling-store';
import { BotRequestsController } from './presentation/bot-requests.controller';
import { BotSchedulingController } from './presentation/bot-scheduling.controller';
import { ChatbotRequestCommandsController } from './presentation/chatbot-request-commands.controller';
import { ChatbotRequestHttpFilter } from './presentation/chatbot-request-http.filter';
import { ChatbotRequestReadsController } from './presentation/chatbot-request-reads.controller';
import { ChatbotRequestSchedulingController } from './presentation/chatbot-request-scheduling.controller';

const PERF =
  process.env.PERF === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  process.env.SKIP_DB_INTEGRATION !== '1';
const describePerf = PERF ? describe : describe.skip;

const int = (name: string, fallback: number) =>
  process.env[name] ? Number(process.env[name]) : fallback;

const SIZE = {
  /** Plain open requests (70 % NEW, 30 % IN_PROGRESS), no schedule. */
  plain: int('PERF_PLAIN', 3_000),
  /** Open scheduled requests, spread over six weeks of blocks. */
  scheduled: int('PERF_SCHEDULED', 2_500),
  /** Scheduled requests whose reminder is due, and as many whose notice is. */
  due: int('PERF_DUE', 100),
  closed: int('PERF_CLOSED', 15_000),
  /** Closed requests that had a schedule (resolved or cancelled). */
  history: int('PERF_HISTORY', 2_000),
  customers: int('PERF_CUSTOMERS', 2_000),
  msgs: int('PERF_MSGS', 10),
  noisePlain: int('PERF_NOISE_PLAIN', 1_500),
  noiseScheduled: int('PERF_NOISE_SCHEDULED', 1_500),
  noiseDue: int('PERF_NOISE_DUE', 50),
  noiseClosed: int('PERF_NOISE_CLOSED', 8_000),
  noiseHistory: int('PERF_NOISE_HISTORY', 1_000),
  sparsePlain: int('PERF_SPARSE_PLAIN', 3_000),
  sparseScheduled: int('PERF_SPARSE_SCHEDULED', 30),
  sparseClosed: int('PERF_SPARSE_CLOSED', 3_000),
  samples: int('PERF_SAMPLES', 200),
};

/** Six weeks of 30-minute blocks (the horizon of a booking is 14 days). */
const BLOCKS = 42 * 48;
/** The per-block cap of the seeded branches (about a quarter of the blocks full). */
const MAX_PER_SLOT = 2;
const ZONE = 'America/Mexico_City';
const MIN = 60_000;

/**
 * §10.1: the Agenda listing is p95 < 100 ms; the grouped inbox p95 < 200 ms per
 * page; the sweep < 50 ms per tick. Booking, replay, reschedule, cancel, one
 * sweep candidate and one flag batch have no row: the 100 ms bar of the Agenda
 * row is DERIVED (same as unit 11), and the document says so.
 */
const TARGETS = {
  agendaP95Ms: 100,
  inboxP95Ms: 200,
  tickMs: 50,
  derivedP95Ms: 100,
};

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
  reader: [['read', 'ChatbotRequest']],
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

interface TenantSize {
  plain: number;
  scheduled: number;
  due: number;
  closed: number;
  history: number;
  /** Customers the plain and closed requests are spread over. */
  pool: number;
}

describePerf('scheduled conversations load test (PostgreSQL, PERF=1)', () => {
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
  const readerUser = { userId: 'perf-reader', ability: { can: () => false } };
  const inTenant = <T>(tenantId: string, work: () => Promise<T>) =>
    cls.runWith({ tenantId, userId: 'perf-reader', isSuperAdmin: false }, work);

  let app: INestApplication;
  let baseUrl = '';
  const tenants: string[] = [];
  const credentials: string[] = [];
  const staffUserId = randomUUID();
  let A = '';
  /** The sparse tenant: 3 000 open requests, 30 scheduled. */
  let S = '';
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

  async function insertPlainOpen(tenantId: string, size: TenantSize) {
    const t0 = T0.toISOString();
    const { plain } = size;
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
        ${t0}::timestamp - ((${plain}::int - g) * interval '3 minutes'), ${t0}::timestamp
      FROM (SELECT g, ((g * 7919) % ${size.pool}::int) + 1 AS c
            FROM generate_series(1, ${plain}::int) AS g) s`);
  }

  /**
   * Open scheduled requests (NEW, version 1). `scheduledFor`, `stage` and
   * `dueAt` are SQL over `g`. The first `poolShare` of them belong to customers
   * that also have plain requests (so groups mix); the rest to customers of
   * their own (`custBase` keeps the three kinds apart). One open scheduled
   * request per (customer, subtype) holds by construction.
   */
  async function insertScheduled(
    tenantId: string,
    o: {
      count: number;
      folioBase: number;
      custBase: number;
      poolShare: number;
      scheduledFor: Prisma.Sql;
      stage: number;
      dueAt: Prisma.Sql;
    },
  ) {
    if (o.count === 0) return;
    const t0 = T0.toISOString();
    await adminPrisma.$executeRaw(Prisma.sql`
      INSERT INTO "chatbot_requests"
        ("id", "tenantId", "folio", "kind", "subtype", "status", "customerKey",
         "conversationRef", "phoneCountryCode", "phone", "claimDeadlineAt",
         "lastCustomerMessageAt", "whatsappWindowClosesAt", "scheduledFor",
         "requiresTemplateAtStart", "scheduleVersion", "scheduleStage",
         "scheduleDueAt", "summary", "source", "sourceRequestId", "createdAt",
         "updatedAt")
      SELECT gen_random_uuid()::text, ${tenantId}, ${o.folioBase}::int + g,
        'CONVERSATION'::"ChatbotRequestKind",
        (CASE WHEN g % 2 = 0 THEN 'TALK_TO_HUMAN' ELSE 'COMPLAINT' END)::"ChatbotRequestSubtype",
        'NEW'::"ChatbotRequestStatus", ckey, 'wa:' || ckey, '52', substr(ckey, 3),
        sf + interval '15 minutes',
        ${t0}::timestamp - interval '20 minutes',
        ${t0}::timestamp + interval '23 hours 40 minutes', sf,
        (g % 9 = 0), 1, ${o.stage}::smallint, ${o.dueAt},
        'Quiere hablar con una persona', 'perf', gen_random_uuid()::text,
        ${t0}::timestamp - (g % 600) * interval '1 minute', ${t0}::timestamp
      FROM (
        SELECT g, ${o.scheduledFor} AS sf,
          CASE WHEN g <= ${o.poolShare}::int THEN '5255' || lpad(g::text, 8, '0')
               ELSE '5256' || lpad((${o.custBase}::int + g)::text, 8, '0') END AS ckey
        FROM generate_series(1, ${o.count}::int) AS g) s`);
  }

  async function insertClosed(
    tenantId: string,
    o: { count: number; folioBase: number; pool: number; scheduled: boolean },
  ) {
    if (o.count === 0) return;
    const t0 = T0.toISOString();
    await adminPrisma.$executeRaw(Prisma.sql`
      INSERT INTO "chatbot_requests"
        ("id", "tenantId", "folio", "kind", "subtype", "status", "customerKey",
         "conversationRef", "phoneCountryCode", "phone", "resolvedByActorId",
         "resolvedByDisplayName", "resolvedAt", "cancelledAt", "cancelReason",
         "closedAt", "scheduledFor", "scheduleVersion", "scheduleStage",
         "summary", "source", "sourceRequestId", "createdAt", "updatedAt")
      SELECT gen_random_uuid()::text, ${tenantId}, ${o.folioBase}::int + g,
        (CASE WHEN g % 3 = 0 AND NOT ${o.scheduled} THEN 'CLARIFICATION' ELSE 'CONVERSATION' END)::"ChatbotRequestKind",
        (CASE WHEN g % 3 = 0 AND NOT ${o.scheduled} THEN 'UNKNOWN_QUESTION' WHEN g % 3 = 1 THEN 'TALK_TO_HUMAN' ELSE 'COMPLAINT' END)::"ChatbotRequestSubtype",
        (CASE WHEN g % 2 = 0 THEN 'RESOLVED' ELSE 'CANCELLED' END)::"ChatbotRequestStatus",
        '5255' || lpad(c::text, 8, '0'), 'wa:5255' || lpad(c::text, 8, '0'),
        '52', '55' || lpad(c::text, 8, '0'),
        CASE WHEN g % 2 = 0 THEN 'perf-user-' || (g % 4 + 1) END,
        CASE WHEN g % 2 = 0 THEN 'Perf ' || (g % 4 + 1) END,
        CASE WHEN g % 2 = 0 THEN closed_at END,
        CASE WHEN g % 2 = 1 THEN closed_at END,
        (CASE WHEN g % 2 = 1 THEN 'CUSTOMER_WITHDREW' END)::"ChatbotRequestCancelReason",
        closed_at,
        CASE WHEN ${o.scheduled} THEN closed_at - interval '1 hour' END,
        CASE WHEN ${o.scheduled} THEN (CASE WHEN g % 2 = 1 THEN 2 ELSE 1 END) ELSE 0 END,
        CASE WHEN ${o.scheduled} THEN 2 ELSE 0 END,
        'Pregunta cerrada', 'perf', gen_random_uuid()::text,
        closed_at - interval '2 hours', closed_at
      FROM (SELECT g, ((g * 104729) % ${o.pool}::int) + 1 AS c,
                   ${t0}::timestamp - ((${o.count}::int - g) * (interval '40 days' / ${o.count}::int)) AS closed_at
            FROM generate_series(1, ${o.count}::int) AS g) s`);
  }

  async function seedTenant(tenantId: string, size: TenantSize) {
    const t0 = T0.toISOString();
    // Folio ranges: plain, scheduled, due reminders, due notices, closed, history.
    const f1 = size.plain;
    const f2 = f1 + size.scheduled;
    const f3 = f2 + size.due;
    const f4 = f3 + size.due;
    const f5 = f4 + size.closed;
    const lastFolio = f5 + size.history;
    const base = Prisma.sql`(date_trunc('hour', ${t0}::timestamp) + interval '2 hours')`;

    await insertPlainOpen(tenantId, size);
    await insertScheduled(tenantId, {
      count: size.scheduled,
      folioBase: f1,
      custBase: 0,
      poolShare: Math.min(1_200, size.pool, size.scheduled),
      // A pseudo-random permutation of the blocks: 1 or 2 per block, so a
      // quarter of the blocks are full at MAX_PER_SLOT = 2.
      scheduledFor: Prisma.sql`${base} + (((g * 7919) % ${BLOCKS}::int) * interval '30 minutes')`,
      stage: 0,
      dueAt: Prisma.sql`sf - interval '10 minutes'`,
    });
    await insertScheduled(tenantId, {
      count: size.due,
      folioBase: f2,
      custBase: 100_000,
      poolShare: 0,
      // 4 to 7 minutes ahead: the reminder fell due 3 to 6 minutes ago and at
      // least 3 minutes remain, so the sweep really writes a feed item.
      scheduledFor: Prisma.sql`${t0}::timestamp + interval '4 minutes' + g * interval '2 seconds'`,
      stage: 0,
      dueAt: Prisma.sql`sf - interval '10 minutes'`,
    });
    await insertScheduled(tenantId, {
      count: size.due,
      folioBase: f3,
      custBase: 200_000,
      poolShare: 0,
      // Already at their time: the "solicitud nueva" notice is due.
      scheduledFor: Prisma.sql`${t0}::timestamp - interval '30 seconds' - g * interval '1 second'`,
      stage: 1,
      dueAt: Prisma.sql`sf`,
    });
    await insertClosed(tenantId, {
      count: size.closed,
      folioBase: f4,
      pool: size.pool,
      scheduled: false,
    });
    await insertClosed(tenantId, {
      count: size.history,
      folioBase: f5,
      pool: size.pool,
      scheduled: true,
    });

    // One chat per conversationRef, SIZE.msgs messages each (author alternates).
    await adminPrisma.$executeRaw(Prisma.sql`
      INSERT INTO "chatbot_conversations"
        ("id", "tenantId", "conversationRef", "customerKey", "lastCustomerMessageAt",
         "mode", "handoffEpoch", "nextSeq", "createdAt", "updatedAt")
      SELECT gen_random_uuid()::text, ${tenantId}, r."conversationRef", min(r."customerKey"),
        coalesce(max(r."lastCustomerMessageAt"), ${t0}::timestamp - interval '1 day'),
        'BOT'::"ConversationMode", 0, ${SIZE.msgs}::int + 1,
        ${t0}::timestamp - interval '30 days', ${t0}::timestamp
      FROM "chatbot_requests" r
      WHERE r."tenantId" = ${tenantId} AND r."conversationRef" IS NOT NULL
      GROUP BY r."conversationRef"`);
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

    // The group table (what refreshCustomerGroup maintains).
    await adminPrisma.$executeRaw(Prisma.sql`
      INSERT INTO "chatbot_customer_groups"
        ("tenantId", "customerKey", "mostUrgentAt", "openCount", "hasOverdue", "updatedAt")
      SELECT "tenantId", "customerKey",
             min(CASE WHEN "status" = 'NEW' THEN "claimDeadlineAt" ELSE "resolveDeadlineAt" END),
             count(*)::int, coalesce(bool_or("overdueAt" IS NOT NULL), false), now()
      FROM "chatbot_requests"
      WHERE "tenantId" = ${tenantId} AND "status" IN ('NEW', 'IN_PROGRESS')
      GROUP BY "tenantId", "customerKey"`);
    // The slot counters, filled from what is booked (what reserveSeat keeps).
    await adminPrisma.$executeRaw(Prisma.sql`
      INSERT INTO "scheduled_slot_counters" ("tenantId", "startsAt", "booked")
      SELECT "tenantId", "scheduledFor", count(*)::int
      FROM "chatbot_requests"
      WHERE "tenantId" = ${tenantId} AND "scheduledFor" IS NOT NULL
        AND "status" IN ('NEW', 'IN_PROGRESS')
      GROUP BY "tenantId", "scheduledFor"`);
    await adminPrisma.$executeRaw(Prisma.sql`
      INSERT INTO "chatbot_request_folio_counters" ("tenantId", "lastNumber", "updatedAt")
      VALUES (${tenantId}, ${lastFolio}::int, now())`);
    // The branch: open around the clock (so the real clock never decides a
    // measurement), scheduling on, 30-minute blocks, 3 offered, 2 per block.
    await adminPrisma.chatbotAttentionSettings.create({
      data: {
        tenantId,
        version: 1,
        timeZone: ZONE,
        days: WEEKDAYS.map((day) => ({
          day,
          ranges: [{ open: '00:00', close: '23:59' }],
        })) as unknown as Prisma.InputJsonArray,
        closedDates: [],
        slas: defaultSettings().slas as unknown as Prisma.InputJsonArray,
        windowWarningMinutes: 120,
        templateCostText: 'x',
        enabledSubtypes: [],
        receiptCloseMarginMinutes: 60,
        schedulingEnabled: true,
        slotMinutes: 30,
        slotsOffered: 3,
        maxScheduledPerSlot: MAX_PER_SLOT,
      },
    });
  }

  // ------------------------------------------------------------------ boot

  beforeAll(async () => {
    const [{ t0 }] = await adminPrisma.$queryRaw<{ t0: Date }[]>(
      Prisma.sql`SELECT (now() AT TIME ZONE 'UTC')::timestamp(3) AS t0`,
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
    const sizes: Array<[string, TenantSize]> = [
      [
        'main',
        {
          plain: SIZE.plain,
          scheduled: SIZE.scheduled,
          due: SIZE.due,
          closed: SIZE.closed,
          history: SIZE.history,
          pool: SIZE.customers,
        },
      ],
      ...(['noise-1', 'noise-2'] as const).map(
        (label): [string, TenantSize] => [
          label,
          {
            plain: SIZE.noisePlain,
            scheduled: SIZE.noiseScheduled,
            due: SIZE.noiseDue,
            closed: SIZE.noiseClosed,
            history: SIZE.noiseHistory,
            pool: SIZE.customers,
          },
        ],
      ),
      [
        'sparse',
        {
          plain: SIZE.sparsePlain,
          scheduled: SIZE.sparseScheduled,
          due: 0,
          closed: SIZE.sparseClosed,
          history: 0,
          pool: 1_500,
        },
      ],
    ];
    for (const [label, size] of sizes) {
      const id = randomUUID();
      tenants.push(id);
      await adminPrisma.tenant.create({
        data: { id, name: `Perf ${label}`, slug: `perf-sched-${id}` },
      });
      await seedTenant(id, size);
    }
    A = tenants[0];
    S = tenants[3];
    for (const analyze of [
      Prisma.sql`ANALYZE "chatbot_requests"`,
      Prisma.sql`ANALYZE "chatbot_conversations"`,
      Prisma.sql`ANALYZE "conversation_messages"`,
      Prisma.sql`ANALYZE "chatbot_customer_groups"`,
      Prisma.sql`ANALYZE "scheduled_slot_counters"`,
      Prisma.sql`ANALYZE "chatbot_attention_settings"`,
    ]) {
      await adminPrisma.$executeRaw(analyze);
    }
    report.seedSeconds = round((performance.now() - started) / 1000);

    token = `svc_${randomUUID()}`;
    const credential = await adminPrisma.serviceCredential.create({
      data: {
        tenantId: A,
        name: 'perf-bot',
        hashedKey: createHash('sha256').update(token).digest('hex'),
        scopes: ['requests:create', 'requests:read', 'requests:cancel'],
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
        BotRequestsController,
        BotSchedulingController,
        ChatbotRequestSchedulingController,
        ChatbotRequestCommandsController,
        ChatbotRequestReadsController,
      ],
      providers: [
        ServiceAuthGuard,
        ChatbotRequestHttpFilter,
        ChatbotRequestWrapper,
        BotRequestIntakeService,
        { provide: BOT_INTAKE_STORE, useClass: PrismaBotIntakeStore },
        {
          provide: LEGACY_INTAKE,
          useValue: { submit: () => Promise.reject(new Error('unused')) },
        },
        SchedulingService,
        { provide: SCHEDULING_STORE, useClass: PrismaSchedulingStore },
        ChatbotRequestCommandsService,
        ChatbotRequestReadsService,
        {
          provide: CHATBOT_REQUEST_COMMAND_STORE,
          useClass: PrismaChatbotRequestCommandStore,
        },
        {
          provide: CHATBOT_REQUEST_READ_STORE,
          useClass: PrismaChatbotRequestReadStore,
        },
        { provide: CUSTOMER_KEY_SEALER, useValue: sealer },
        { provide: INBOX_CLOCK, useValue: () => new Date() },
        { provide: SLA_PAUSE_READER, useClass: PrismaSlaPauseReader },
        {
          provide: CHATBOT_REQUEST_RESOLVER,
          useValue: { resolve: () => Promise.reject(new Error('unused')) },
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
  const staffHeaders = (role: string, tenant = A, userId = staffUserId) => ({
    'x-test-role': role,
    'x-test-tenant': tenant,
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
        `expected ${expected}, got ${res.status}: ${JSON.stringify(res.body).slice(0, 400)}`,
      );
    }
    return { ms, body: res.body };
  }

  /** Reads: 5 warm-up calls, then `n` timed ones of the same requests. */
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

  /**
   * Commands: every call changes state, so call `i` is unique. `prepare` is the
   * untimed setup of call `i` (e.g. asking the slots route), `run` the timed
   * request. 5 warm-up calls come first and are not measured.
   */
  async function sampleCommands<P>(
    n: number,
    prepare: (i: number) => Promise<P>,
    run: (i: number, prepared: P) => request.Test,
    expected: number,
  ) {
    const values: number[] = [];
    const bodies: any[] = [];
    const preparedAll: P[] = [];
    for (let i = 0; i < n + 5; i++) {
      const prepared = await prepare(i);
      const { ms, body } = await timeHttp(() => run(i, prepared), expected);
      bodies.push(body);
      preparedAll.push(prepared);
      if (i >= 5) values.push(ms);
    }
    return { summary: stats(values), bodies, prepared: preparedAll };
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

  /** EXPLAIN with `enable_seqscan = off`: proves the index plan exists. */
  async function explainNoSeqScan(sql: string) {
    return adminPrisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      let plan: string[] = [];
      for (let i = 0; i < 2; i++) {
        const rows = await tx.$queryRawUnsafe<Array<Record<string, string>>>(
          `EXPLAIN (ANALYZE, BUFFERS) ${sql}`,
        );
        plan = rows.map((row) => row['QUERY PLAN']);
      }
      return plan;
    });
  }

  const explainStatement = async (statement: {
    query: string;
    params: string;
  }) => {
    const sql = inline(statement.query, statement.params);
    return { sql: sql.replace(/\s+/g, ' '), plan: await explainSql(sql) };
  };

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
    return explainStatement(statement);
  }

  const usesIndex = (plan: string[], name: string) =>
    plan.some((line) => line.includes(name));
  const seqScans = (plan: string[], table: string) =>
    plan.filter((line) => new RegExp(`Seq Scan on ${table}\\b`).test(line));
  /** Sum of "Rows Removed by Filter" in the plan (the warm run). */
  const removedByFilter = (plan: string[]) =>
    plan.reduce((sum, line) => {
      const match = /Rows Removed by Filter: (\d+)/.exec(line);
      return sum + (match ? Number(match[1]) : 0);
    }, 0);
  const executionMs = (plan: string[]) => {
    const line = plan.find((l) => l.startsWith('Execution Time:'));
    return line ? Number(/([\d.]+) ms/.exec(line)?.[1]) : Number.NaN;
  };

  const phoneKey = (n: number) => ({
    phoneCountryCode: '52',
    phone: `55${String(n).padStart(8, '0')}`,
    ref: `wa:5255${String(n).padStart(8, '0')}`,
  });
  const lastMessageAt = () => new Date(Date.now() - 10 * MIN).toISOString();
  const slotsOf = (ref: string) =>
    asBot(
      server().get(
        `/chatbot-api/scheduling/slots?conversationRef=${encodeURIComponent(ref)}&lastCustomerMessageAt=${encodeURIComponent(lastMessageAt())}`,
      ),
    );
  const bookBody = (n: number, scheduledFor: string) => {
    const c = phoneKey(n);
    return {
      sourceRequestId: randomUUID(),
      subtype: 'TALK_TO_HUMAN',
      customer: { phoneCountryCode: c.phoneCountryCode, phone: c.phone },
      conversationRef: c.ref,
      lastCustomerMessageAt: lastMessageAt(),
      summary: 'Quiere hablar con una persona',
      scheduledFor,
    };
  };
  const create = (body: { sourceRequestId: string }) =>
    asBot(
      server()
        .post('/chatbot-api/requests')
        .set('X-Idempotency-Key', body.sourceRequestId),
    ).send(body);
  const localDate = (instant: Date) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant);

  /** A client whose every `$transaction` is timed (and optionally rolled back). */
  const ROLLBACK = new Error('dry run');
  function timedClient(
    sink: Array<{ kind: string; ms: number }>,
    mode: 'live' | 'rollback' = 'live',
  ) {
    return new Proxy(loggedPrisma, {
      get(target, prop) {
        if (prop === '$transaction') {
          return async (fn: (tx: unknown) => Promise<unknown>) => {
            const started = performance.now();
            let value: any;
            if (mode === 'rollback') {
              try {
                await target.$transaction(async (tx) => {
                  value = await fn(tx);
                  throw ROLLBACK;
                });
              } catch (error) {
                if (error !== ROLLBACK) throw error;
              }
            } else {
              value = await target.$transaction(fn as never);
            }
            sink.push({
              kind: String(value?.kind ?? 'tx'),
              ms: performance.now() - started,
            });
            return value as unknown;
          };
        }
        const member = Reflect.get(target, prop, target) as unknown;
        if (typeof member !== 'function') return member;
        const bound: unknown = (member as (...args: unknown[]) => unknown).bind(
          target,
        );
        return bound;
      },
    }) as unknown as PrismaService;
  }

  // ------------------------------------------------------------- the test

  it('measures the scheduled conversations at scale and captures EXPLAIN (ANALYZE, BUFFERS)', async () => {
    report.sizes = SIZE;
    const [totals] = await adminPrisma.$queryRaw<
      Array<Record<string, number>>
    >(Prisma.sql`
      SELECT
        (SELECT count(*)::int FROM "chatbot_requests") AS requests,
        (SELECT count(*)::int FROM "chatbot_requests"
          WHERE "scheduledFor" IS NOT NULL AND "status" IN ('NEW', 'IN_PROGRESS')) AS "openScheduled",
        (SELECT count(*)::int FROM "chatbot_requests"
          WHERE "tenantId" = ${A} AND "status" IN ('NEW', 'IN_PROGRESS')) AS "openA",
        (SELECT count(*)::int FROM "chatbot_requests"
          WHERE "tenantId" = ${A} AND "scheduledFor" IS NOT NULL
            AND "status" IN ('NEW', 'IN_PROGRESS')) AS "scheduledA",
        (SELECT count(*)::int FROM "scheduled_slot_counters") AS counters,
        (SELECT count(*)::int FROM "scheduled_slot_counters"
          WHERE "tenantId" = ${A} AND "booked" >= ${MAX_PER_SLOT}) AS "fullBlocksA",
        (SELECT count(*)::int FROM "chatbot_conversations") AS chats,
        (SELECT count(*)::int FROM "conversation_messages") AS messages`);
    report.seed = totals;

    // -------------------------------------------- (a) slots (§10.1 Agenda)
    const sampleRefs = await adminPrisma.$queryRaw<
      { ref: string }[]
    >(Prisma.sql`
      SELECT "conversationRef" AS ref FROM "chatbot_requests"
      WHERE "tenantId" = ${A} AND "scheduledFor" IS NOT NULL AND "status" = 'NEW'
      ORDER BY md5("id") LIMIT 300`);
    report.slotsBot = await sampleHttp(SIZE.samples, (i) =>
      slotsOf(sampleRefs[i % sampleRefs.length].ref),
    );
    const N = SIZE.samples + 5;
    // Rows the commands below will change (distinct, NEW, stage 0, far ahead).
    const rowsPool = await adminPrisma.$queryRaw<
      Array<{ id: string; version: number; ref: string }>
    >(Prisma.sql`
      SELECT "id", "version", "conversationRef" AS ref FROM "chatbot_requests"
      WHERE "tenantId" = ${A} AND "status" = 'NEW' AND "scheduleStage" = 0
        AND "scheduledFor" > ${new Date(T0.getTime() + 3 * 3_600_000)}
      ORDER BY md5("id" || 'r') LIMIT ${N * 5}`);
    if (rowsPool.length < N * 5) throw new Error('not enough scheduled rows');
    const slice = (k: number) => rowsPool.slice(k * N, (k + 1) * N);
    const botMove = slice(0);
    const staffMove = slice(1);
    const botCancelRows = slice(2);
    const staffCancelRows = slice(3);
    const readRows = slice(4);
    report.slotsStaffPicker = await sampleHttp(SIZE.samples, (i) =>
      server()
        .get(
          `/chatbot-requests/${readRows[i % readRows.length].id}/scheduling/slots`,
        )
        .set(staffHeaders('reader')),
    );

    // ------------------------------------------- (b) booking create + replay
    const created = await sampleCommands(
      SIZE.samples,
      async (i) => {
        const c = phoneKey(70_000_000 + i);
        const { body } = await timeHttp(() => slotsOf(c.ref));
        return bookBody(70_000_000 + i, body.slots[0].startsAt as string);
      },
      (_i, body) => create(body),
      201,
    );
    report.bookingCreate = created.summary;
    // The same keys again: the 2xx replay (a receipt lookup on its key).
    const replayed = await sampleCommands(
      SIZE.samples,
      (i) => Promise.resolve(created.prepared[i]),
      (_i, body) => create(body),
      200,
    );
    report.bookingReplay = replayed.summary;
    // A full block: 409 SLOT_UNAVAILABLE with the fresh list, nothing stored.
    const fullBlocks = await adminPrisma.$queryRaw<
      { startsAt: Date }[]
    >(Prisma.sql`
      SELECT "startsAt" FROM "scheduled_slot_counters"
      WHERE "tenantId" = ${A} AND "booked" >= ${MAX_PER_SLOT}
        AND "startsAt" > ${new Date(Date.now() + 3_600_000)}
        AND "startsAt" < ${new Date(Date.now() + 13 * 86_400_000)}
      ORDER BY "startsAt" LIMIT ${100 + 5}`);
    if (fullBlocks.length < 105) throw new Error('not enough full blocks');
    const conflict = await sampleCommands(
      100,
      (i) =>
        Promise.resolve(
          bookBody(80_000_000 + i, fullBlocks[i].startsAt.toISOString()),
        ),
      (_i, body) => create(body),
      409,
    );
    report.bookingSlotUnavailable409 = conflict.summary;

    // --------------------------------------------- (c) reschedule (bot, staff)
    interface BotMove {
      idem: string;
      payload: { scheduledFor: string; lastCustomerMessageAt: string };
    }
    const botRescheduleCall = (i: number, move: BotMove) =>
      asBot(
        server()
          .post(`/chatbot-api/requests/${botMove[i].id}/reschedule`)
          .set('X-Idempotency-Key', move.idem),
      ).send(move.payload);
    const botMoved = await sampleCommands<BotMove>(
      SIZE.samples,
      async (i) => {
        const { body } = await timeHttp(() => slotsOf(botMove[i].ref));
        return {
          idem: randomUUID(),
          payload: {
            scheduledFor: body.slots[i % body.slots.length].startsAt as string,
            lastCustomerMessageAt: lastMessageAt(),
          },
        };
      },
      botRescheduleCall,
      200,
    );
    report.rescheduleBot = botMoved.summary;
    const botReplay = await sampleCommands<BotMove>(
      100,
      (i) => Promise.resolve(botMoved.prepared[i]),
      botRescheduleCall,
      200,
    );
    report.rescheduleBotReplay = botReplay.summary;
    const staffMoved = await sampleCommands<string>(
      SIZE.samples,
      async (i) => {
        const { body } = await timeHttp(() =>
          server()
            .get(`/chatbot-requests/${staffMove[i].id}/scheduling/slots`)
            .set(staffHeaders('reader')),
        );
        return body.slots[i % body.slots.length].startsAt as string;
      },
      (i, startsAt) =>
        server()
          .post(`/chatbot-requests/${staffMove[i].id}/reschedule`)
          .set(staffHeaders('attendee'))
          .set('Idempotency-Key', randomUUID())
          .send({
            expectedVersion: staffMove[i].version,
            scheduledFor: startsAt,
          }),
      200,
    );
    report.rescheduleStaff = staffMoved.summary;

    // ------------------------------------------------------- (d) cancel
    const botCancelled = await sampleCommands(
      SIZE.samples,
      (i) => Promise.resolve(i),
      (i) =>
        asBot(
          server()
            .post(`/chatbot-api/requests/${botCancelRows[i].id}/cancel`)
            .set('X-Idempotency-Key', randomUUID()),
        ).send({ reason: 'CUSTOMER_WITHDREW', triggerWaMessageId: 'wamid.c' }),
      200,
    );
    report.cancelBot = botCancelled.summary;
    const staffCancelled = await sampleCommands(
      SIZE.samples,
      (i) => Promise.resolve(i),
      (i) =>
        server()
          .post(`/chatbot-requests/${staffCancelRows[i].id}/cancel`)
          .set(staffHeaders('attendee'))
          .set('Idempotency-Key', randomUUID())
          .send({
            expectedVersion: staffCancelRows[i].version,
            reason: 'NOT_ACTIONABLE',
          }),
      200,
    );
    report.cancelStaff = staffCancelled.summary;
    const [afterCommands] = await adminPrisma.$queryRaw<
      Array<Record<string, number>>
    >(Prisma.sql`
      SELECT
        (SELECT count(*)::int FROM "scheduled_slot_counters"
          WHERE "tenantId" = ${A} AND "booked" > ${MAX_PER_SLOT}) AS "overbooked",
        (SELECT coalesce(sum("booked"), 0)::int FROM "scheduled_slot_counters"
          WHERE "tenantId" = ${A}) AS "seats",
        (SELECT count(*)::int FROM "chatbot_requests"
          WHERE "tenantId" = ${A} AND "scheduledFor" IS NOT NULL
            AND "status" IN ('NEW', 'IN_PROGRESS')) AS "openScheduled"`);
    report.afterCommands = afterCommands;

    // ------------------------------------------------------- (e) staff inbox
    const reader = (path: string, tenant = A) =>
      server().get(path).set(staffHeaders('reader', tenant));
    const groupsPath = (status: string, cursor?: string) =>
      `/chatbot-requests/groups?${status ? `status=${status}&` : ''}limit=25${cursor ? `&cursor=${cursor}` : ''}`;
    report.inboxOpenFirstPage = await sampleHttp(SIZE.samples, () =>
      reader(groupsPath('')),
    );
    report.inboxScheduledFirstPage = await sampleHttp(SIZE.samples, () =>
      reader(groupsPath('scheduled')),
    );
    const walk: number[] = [];
    let cursor: string | undefined;
    let walkGroups = 0;
    let walkScheduledRows = 0;
    let firstCustomerKey = '';
    do {
      const { ms, body } = await timeHttp(() =>
        reader(groupsPath('scheduled', cursor)),
      );
      walk.push(ms);
      walkGroups += body.items.length;
      walkScheduledRows += (
        JSON.stringify(body).match(/"scheduledFor":"/g) ?? []
      ).length;
      if (!firstCustomerKey) firstCustomerKey = body.items[0].customerKey;
      cursor = body.nextCursor ?? undefined;
    } while (cursor);
    report.inboxScheduledWalk = {
      ...stats(walk),
      pages: walk.length,
      groups: walkGroups,
      rowsWithScheduledFor: walkScheduledRows,
    };
    const countsRes = await timeHttp(() => reader('/chatbot-requests/counts'));
    report.inboxCountsBody = countsRes.body;
    report.inboxCounts = await sampleHttp(SIZE.samples, () =>
      reader('/chatbot-requests/counts'),
    );
    report.inboxDetailScheduled = await sampleHttp(SIZE.samples, (i) =>
      reader(`/chatbot-requests/${readRows[i % readRows.length].id}`),
    );
    report.inboxCustomerListScheduled = await sampleHttp(SIZE.samples, () =>
      reader(
        `/chatbot-requests?status=scheduled&customerKey=${encodeURIComponent(firstCustomerKey)}`,
      ),
    );
    // The sparse tenant: 30 scheduled among 3 000 open (the tab's worst case).
    report.sparseScheduledFirstPage = await sampleHttp(SIZE.samples, () =>
      reader(groupsPath('scheduled'), S),
    );
    report.sparseCounts = await sampleHttp(SIZE.samples, () =>
      reader('/chatbot-requests/counts', S),
    );
    const sparseBody = (
      await timeHttp(() => reader(groupsPath('scheduled'), S))
    ).body;
    const [expectedInbox] = await adminPrisma.$queryRaw<
      Array<Record<string, number>>
    >(Prisma.sql`
      SELECT
        (SELECT count(*)::int FROM "chatbot_requests"
          WHERE "tenantId" = ${A} AND "scheduledFor" IS NOT NULL
            AND "status" IN ('NEW', 'IN_PROGRESS')) AS "scheduled",
        (SELECT count(DISTINCT "customerKey")::int FROM "chatbot_requests"
          WHERE "tenantId" = ${A} AND "scheduledFor" IS NOT NULL
            AND "status" IN ('NEW', 'IN_PROGRESS')) AS "groups",
        (SELECT count(DISTINCT "customerKey")::int FROM "chatbot_requests"
          WHERE "tenantId" = ${S} AND "scheduledFor" IS NOT NULL
            AND "status" IN ('NEW', 'IN_PROGRESS')) AS "sparseGroups"`);
    report.inboxExpected = expectedInbox;

    // ------------------------------------------- (f) EXPLAIN: reads
    const plans: Record<string, { sql: string; plan: string[] }> = {};
    plans['slots counter read (14 days)'] = await explainCaptured(
      A,
      /scheduled_slot_counters/,
      () =>
        readFullBlocks(
          tenantPrisma.getClient() as never,
          A,
          new Date(Date.now() + 10 * MIN),
          new Date(Date.now() + 14 * 86_400_000),
          MAX_PER_SLOT,
        ),
    );
    plans['inbox Agendadas, first page (dense tenant)'] = await explainCaptured(
      A,
      /chatbot_customer_groups[\s\S]*"scheduledFor" IS NOT NULL/,
      () =>
        reads.groups(
          readerUser as never,
          {
            tab: 'scheduled',
            filters: {},
            limit: 25,
          } as never,
        ),
    );
    plans['inbox Agendadas, first page (sparse tenant)'] =
      await explainCaptured(
        S,
        /chatbot_customer_groups[\s\S]*"scheduledFor" IS NOT NULL/,
        () =>
          reads.groups(
            readerUser as never,
            {
              tab: 'scheduled',
              filters: {},
              limit: 25,
            } as never,
          ),
      );
    // The planner may pick a hash semi-join with a ~1 ms seq scan of the small
    // groups table for the sparse tenant; the index plan must exist and be as fast.
    plans['inbox Agendadas, sparse tenant, seq scans disabled'] = {
      sql: plans['inbox Agendadas, first page (sparse tenant)'].sql,
      plan: await explainNoSeqScan(
        plans['inbox Agendadas, first page (sparse tenant)'].sql,
      ),
    };
    plans['inbox counts (scheduled, needsReschedule)'] = await explainCaptured(
      A,
      /AS "scheduled"/,
      () => reads.counts(readerUser as never),
    );

    // ----------------------------------------------------------- (g) sweep
    const ours = tenants;
    const dueNow = async (now: Date) => {
      const [row] = await adminPrisma.$queryRaw<
        Array<Record<string, number>>
      >(Prisma.sql`
        SELECT
          (SELECT count(*)::int FROM "chatbot_requests"
            WHERE "tenantId" = ANY(${ours}) AND "scheduleDueAt" IS NOT NULL
              AND "scheduleDueAt" <= ${now} AND "scheduleStage" = 0) AS reminders,
          (SELECT count(*)::int FROM "chatbot_requests"
            WHERE "tenantId" = ANY(${ours}) AND "scheduleDueAt" IS NOT NULL
              AND "scheduleDueAt" <= ${now} AND "scheduleStage" = 1) AS notices,
          (SELECT count(*)::int FROM "chatbot_requests"
            WHERE "tenantId" = ANY(${ours}) AND "scheduleDueAt" IS NOT NULL) AS "withDue"`);
      return row;
    };
    const sweepPlan = async (label: string) => {
      const probe = new ScheduleSweepStore(
        loggedPrisma as unknown as PrismaService,
      );
      captured.length = 0;
      await (probe as any).readCandidates(T0, null);
      const statement = captured.find(
        (e) => /^\s*SELECT/i.test(e.query) && /scheduleDueAt/.test(e.query),
      );
      if (!statement) throw new Error('sweep statement not captured');
      plans[`sweep candidates, ${label}`] = await explainStatement(statement);
    };
    const dueBefore = await dueNow(T0);
    report.sweepDueBefore = dueBefore;
    await sweepPlan('before the drain');

    const timings: Array<{ kind: string; ms: number }> = [];
    const store = new ScheduleSweepStore(timedClient(timings));
    const scheduler = new ScheduleSweepScheduler(store);
    const batches: Array<Record<string, number>> = [];
    const swept = { reminders: 0, notices: 0, failed: 0, flagged: 0 };
    for (let i = 0; i < 20; i++) {
      const started = performance.now();
      const { last, ...result } = await store.runBatch(T0);
      void last;
      const ms = performance.now() - started;
      if (result.candidates === 0) break;
      batches.push({ batch: i + 1, ms: round(ms), ...result });
      swept.reminders += result.reminders;
      swept.notices += result.notices;
      swept.failed += result.failed;
      swept.flagged += result.flagged;
    }
    const dueAfter = await dueNow(T0);
    report.sweepBatches = batches;
    report.sweepTotals = swept;
    report.sweepDueAfter = dueAfter;
    const byKind = (kind: string) =>
      timings.filter((t) => t.kind === kind).map((t) => t.ms);
    report.sweepPerCandidate = {
      reminders: byKind('reminders').length ? stats(byKind('reminders')) : null,
      notices: byKind('notices').length ? stats(byKind('notices')) : null,
      all: stats(timings.map((t) => t.ms)),
    };
    // A full batch of 100 (every batch but the last one is full).
    const fullBatches = batches.filter((b) => b.candidates === store.batchSize);
    report.sweepOneBatch = fullBatches.length
      ? stats(fullBatches.map((b) => b.ms))
      : null;
    // A tick with nothing due: what the sweep costs every 15 s.
    const steady: number[] = [];
    let steadyResult: Record<string, number> = {};
    for (let i = 0; i < 35; i++) {
      const started = performance.now();
      steadyResult = { ...(await scheduler.tick(T0)) };
      steady.push(performance.now() - started);
    }
    report.sweepSteadyTick = { ...stats(steady.slice(5)), last: steadyResult };
    await sweepPlan('steady state, after the drain');

    // ------------------------------------------- (h) needsReschedule pass
    // The hours shrink to Monday-Friday 09:00-18:00 and a closed date 10 days
    // ahead: most of the seeded times fall outside them.
    const closedDate = localDate(new Date(Date.now() + 10 * 86_400_000));
    const shrink = (tenantId: string) =>
      adminPrisma.chatbotAttentionSettings.update({
        where: { tenantId },
        data: {
          days: WEEKDAYS.map((day) => ({
            day,
            ranges:
              day === 'SATURDAY' || day === 'SUNDAY'
                ? []
                : [{ open: '09:00', close: '18:00' }],
          })) as unknown as Prisma.InputJsonArray,
          closedDates: [closedDate],
          version: { increment: 1 },
        },
      });
    const expectedFlags = async (tenantId: string, now: Date) => {
      const [row] = await adminPrisma.$queryRaw<{ n: number; total: number }[]>(
        Prisma.sql`
        SELECT count(*) FILTER (WHERE NOT (
                 extract(isodow FROM l) BETWEEN 1 AND 5
                 AND l::time >= '09:00' AND l::time < '18:00'
                 AND l::date <> ${closedDate}::date))::int AS n,
               count(*)::int AS total
        FROM (SELECT ((r."scheduledFor" AT TIME ZONE 'UTC') AT TIME ZONE ${ZONE}) AS l
              FROM "chatbot_requests" r
              WHERE r."tenantId" = ${tenantId} AND r."status" = 'NEW'
                AND r."scheduledFor" IS NOT NULL AND r."scheduledFor" > ${now}
                AND NOT r."needsReschedule") x`,
      );
      return row;
    };
    const passNow = new Date();
    await shrink(A);
    const expectedA = await expectedFlags(A, passNow);
    report.flagExpectedA = expectedA;
    // The statements of the pass, captured from a dry run that rolls back.
    captured.length = 0;
    await flagUnbookableSchedules(timedClient([], 'rollback'), A, {
      now: () => passNow,
    });
    const flagStatements = captured.filter(
      (e) => /FOR UPDATE/.test(e.query) && /^\s*SELECT/i.test(e.query),
    );
    if (flagStatements.length < 2) throw new Error('flag statements missing');
    plans['flag pass, first batch (dense tenant)'] = await explainStatement(
      flagStatements[0],
    );
    plans['flag pass, a later batch (dense tenant)'] = await explainStatement(
      flagStatements[Math.min(3, flagStatements.length - 1)],
    );
    plans['flag pass, last batch (dense tenant)'] = await explainStatement(
      flagStatements[flagStatements.length - 1],
    );
    report.flagBatchesInDryRun = flagStatements.length;
    const flagTimings: Array<{ kind: string; ms: number }> = [];
    const flagStarted = performance.now();
    const flagResult = await flagUnbookableSchedules(
      timedClient(flagTimings),
      A,
      { now: () => passNow },
    );
    report.flagPass = {
      flagged: flagResult.flagged,
      totalMs: round(performance.now() - flagStarted),
      batches: flagTimings.length,
      batch: stats(flagTimings.map((t) => t.ms)),
    };
    const secondTimings: Array<{ kind: string; ms: number }> = [];
    const secondStarted = performance.now();
    const second = await flagUnbookableSchedules(
      timedClient(secondTimings),
      A,
      { now: () => passNow },
    );
    report.flagPassSecond = {
      flagged: second.flagged,
      totalMs: round(performance.now() - secondStarted),
      batches: secondTimings.length,
      batch: stats(secondTimings.map((t) => t.ms)),
    };
    const flaggedCounts = await timeHttp(() =>
      reader('/chatbot-requests/counts'),
    );
    report.flagCountsBody = flaggedCounts.body;
    // The tenant with few scheduled rows in a table full of other tenants'.
    await shrink(S);
    const expectedS = await expectedFlags(S, passNow);
    captured.length = 0;
    await flagUnbookableSchedules(timedClient([], 'rollback'), S, {
      now: () => passNow,
    });
    const sparseFlag = captured.find(
      (e) => /FOR UPDATE/.test(e.query) && /^\s*SELECT/i.test(e.query),
    );
    if (!sparseFlag) throw new Error('sparse flag statement missing');
    plans['flag pass, first batch (sparse tenant)'] =
      await explainStatement(sparseFlag);
    const sparseTimings: Array<{ kind: string; ms: number }> = [];
    const sparseStarted = performance.now();
    const sparseResult = await flagUnbookableSchedules(
      timedClient(sparseTimings),
      S,
      { now: () => passNow },
    );
    report.flagPassSparse = {
      expected: expectedS,
      flagged: sparseResult.flagged,
      totalMs: round(performance.now() - sparseStarted),
      batches: sparseTimings.length,
      batch: stats(sparseTimings.map((t) => t.ms)),
    };
    report.explain = plans;

    // ------------------------------------------------------- (i) verdicts
    const lim = (ms: number) => `< ${ms} ms`;
    const p95 = (x: { p95: number }) => `${x.p95} ms`;
    const agenda = TARGETS.agendaP95Ms;
    const derived = TARGETS.derivedP95Ms;
    const inbox = TARGETS.inboxP95Ms;
    verdict(
      'bot slots listing p95 (§10.1 Agenda)',
      lim(agenda),
      p95(report.slotsBot),
      report.slotsBot.p95 < agenda,
    );
    verdict(
      'staff slots picker p95 (§10.1 Agenda)',
      lim(agenda),
      p95(report.slotsStaffPicker),
      report.slotsStaffPicker.p95 < agenda,
    );
    verdict(
      'booking create p95 (derived, S20 2)',
      lim(derived),
      p95(report.bookingCreate),
      report.bookingCreate.p95 < derived,
    );
    verdict(
      'same-key 2xx replay p95 (derived)',
      lim(derived),
      p95(report.bookingReplay),
      report.bookingReplay.p95 < derived,
    );
    verdict(
      '409 SLOT_UNAVAILABLE on a full block p95 (derived)',
      lim(derived),
      p95(report.bookingSlotUnavailable409),
      report.bookingSlotUnavailable409.p95 < derived,
    );
    verdict(
      'bot reschedule / its replay p95 (derived)',
      lim(derived),
      `${report.rescheduleBot.p95} / ${report.rescheduleBotReplay.p95} ms`,
      report.rescheduleBot.p95 < derived &&
        report.rescheduleBotReplay.p95 < derived,
    );
    verdict(
      'staff reschedule p95 (derived)',
      lim(derived),
      p95(report.rescheduleStaff),
      report.rescheduleStaff.p95 < derived,
    );
    verdict(
      'bot cancel / staff cancel p95 (derived)',
      lim(derived),
      `${report.cancelBot.p95} / ${report.cancelStaff.p95} ms`,
      report.cancelBot.p95 < derived && report.cancelStaff.p95 < derived,
    );
    verdict(
      'no block is ever over its cap after the commands',
      '0 overbooked',
      `${afterCommands.overbooked} overbooked`,
      afterCommands.overbooked === 0,
    );
    verdict(
      'inbox first page (open / Agendadas / sparse Agendadas) p95 (§10.1)',
      lim(inbox),
      `${report.inboxOpenFirstPage.p95} / ${report.inboxScheduledFirstPage.p95} / ${report.sparseScheduledFirstPage.p95} ms`,
      report.inboxOpenFirstPage.p95 < inbox &&
        report.inboxScheduledFirstPage.p95 < inbox &&
        report.sparseScheduledFirstPage.p95 < inbox,
    );
    verdict(
      'inbox Agendadas, every page of a full walk p95 (§10.1)',
      lim(inbox),
      `${report.inboxScheduledWalk.p95} ms over ${report.inboxScheduledWalk.pages} pages`,
      report.inboxScheduledWalk.p95 < inbox,
    );
    verdict(
      'Agendadas walk returns every customer with an open scheduled request once',
      `${expectedInbox.groups} groups`,
      `${walkGroups} groups, ${walkScheduledRows} rows with scheduledFor`,
      walkGroups === expectedInbox.groups &&
        walkScheduledRows >= expectedInbox.groups,
    );
    verdict(
      'sparse Agendadas returns its scheduled customers',
      `${expectedInbox.sparseGroups} groups`,
      `${sparseBody.items.length} groups on the first page`,
      sparseBody.items.length === Math.min(25, expectedInbox.sparseGroups),
    );
    verdict(
      'counts.scheduled matches the table',
      `${expectedInbox.scheduled}`,
      `${countsRes.body.scheduled}`,
      countsRes.body.scheduled === expectedInbox.scheduled,
    );
    verdict(
      'inbox counts / detail / customer list / sparse counts p95 (§10.1)',
      lim(inbox),
      `${report.inboxCounts.p95} / ${report.inboxDetailScheduled.p95} / ${report.inboxCustomerListScheduled.p95} / ${report.sparseCounts.p95} ms`,
      report.inboxCounts.p95 < inbox &&
        report.inboxDetailScheduled.p95 < inbox &&
        report.inboxCustomerListScheduled.p95 < inbox &&
        report.sparseCounts.p95 < inbox,
    );
    const counter = plans['slots counter read (14 days)'].plan;
    verdict(
      'slots counter read uses the primary key (tenantId, startsAt), no seq scan',
      'index scan, 0 seq scans',
      `${usesIndex(counter, 'scheduled_slot_counters_pkey') ? 'pkey' : 'NO pkey'}, ${seqScans(counter, 'scheduled_slot_counters').length} seq scans, ${executionMs(counter)} ms`,
      usesIndex(counter, 'scheduled_slot_counters_pkey') &&
        seqScans(counter, 'scheduled_slot_counters').length === 0,
    );
    for (const name of Object.keys(plans).filter((n) =>
      n.startsWith('inbox'),
    )) {
      const plan = plans[name].plan;
      // Never a seq scan of `chatbot_requests`. The small groups table may be
      // seq-scanned when that is cheaper (sparse tenant, 9k rows, ~1 ms); the
      // `seq scans disabled` plan below proves the index plan exists. The
      // counts statement also holds the unit 4 `openGroups` subquery (a seq
      // scan of the groups table): reported, not asserted.
      const seq = seqScans(plan, 'chatbot_requests').length;
      const groupsSeq = seqScans(plan, 'chatbot_customer_groups').length;
      const groupsIndex =
        usesIndex(
          plan,
          'chatbot_customer_groups_tenantId_mostUrgentAt_customerKey_idx',
        ) || name.startsWith('inbox counts');
      verdict(
        `${name}: no seq scan of requests, groups by index${groupsSeq ? ' (or forced index plan, see below)' : ''}`,
        '0 seq scans of requests',
        `${seq} seq scans of requests, ${groupsSeq} of groups, ${executionMs(plan)} ms, ${removedByFilter(plan)} rows removed by filters`,
        seq === 0 &&
          (groupsSeq === 0 ||
            name.startsWith('inbox counts') ||
            name.includes('seq scans disabled') ||
            groupsIndex ||
            usesIndex(
              plans['inbox Agendadas, sparse tenant, seq scans disabled'].plan,
              'chatbot_customer_groups_tenantId_mostUrgentAt_customerKey_idx',
            )),
      );
    }
    const countsPlan = plans['inbox counts (scheduled, needsReschedule)'].plan;
    verdict(
      'inbox counts use the open scheduled partial index',
      'chatbot_requests_open_scheduled_idx',
      usesIndex(countsPlan, 'chatbot_requests_open_scheduled_idx')
        ? 'yes'
        : 'no',
      usesIndex(countsPlan, 'chatbot_requests_open_scheduled_idx'),
    );
    verdict(
      'sweep drains every due reminder and notice, nothing fails',
      `${dueBefore.reminders} reminders, ${dueBefore.notices} notices, 0 failed`,
      `${swept.reminders} reminders, ${swept.notices} notices, ${swept.failed} failed, due after ${dueAfter.reminders}/${dueAfter.notices}`,
      swept.reminders === dueBefore.reminders &&
        swept.notices === dueBefore.notices &&
        swept.failed === 0 &&
        dueAfter.reminders === 0 &&
        dueAfter.notices === 0,
    );
    const slowest = report.sweepPerCandidate.all.p95;
    verdict(
      'sweep: one candidate (own transaction) p95 (derived)',
      lim(derived),
      `${slowest} ms`,
      slowest < derived,
    );
    verdict(
      'sweep: one batch of 100 candidates (derived: 100 x the 100 ms candidate bar is not a target; the per-candidate bar above is)',
      'reported',
      report.sweepOneBatch
        ? `${report.sweepOneBatch.max} ms max over ${report.sweepOneBatch.n} full batches`
        : 'no full batch',
      Boolean(report.sweepOneBatch),
    );
    verdict(
      'sweep: a tick with nothing due p95 (§10.1 "Barrido de tiempos")',
      lim(TARGETS.tickMs),
      `${report.sweepSteadyTick.p95} ms`,
      report.sweepSteadyTick.p95 < TARGETS.tickMs,
    );
    for (const name of Object.keys(plans).filter((n) =>
      n.startsWith('sweep'),
    )) {
      const plan = plans[name].plan;
      const ok = usesIndex(plan, 'chatbot_requests_schedule_due_idx');
      verdict(
        `${name}: partial due index, no seq scan of the requests`,
        'index scan, 0 seq scans',
        `${ok ? 'due index' : 'NO due index'}, ${seqScans(plan, 'chatbot_requests').length} seq scans, ${executionMs(plan)} ms`,
        ok && seqScans(plan, 'chatbot_requests').length === 0,
      );
    }
    verdict(
      'flag pass flags exactly the times outside the new hours',
      `${expectedA.n} of ${expectedA.total} candidates`,
      `${report.flagPass.flagged} flagged; second pass ${report.flagPassSecond.flagged}; counts.needsReschedule ${flaggedCounts.body.needsReschedule}`,
      report.flagPass.flagged === expectedA.n &&
        report.flagPassSecond.flagged === 0 &&
        flaggedCounts.body.needsReschedule >= report.flagPass.flagged,
    );
    verdict(
      'flag pass, one batch of 200 (own transaction) p95 (derived), both passes',
      lim(derived),
      `${report.flagPass.batch.p95} ms first pass (${report.flagPass.batches} batches, ${report.flagPass.totalMs} ms total); ${report.flagPassSecond.batch.p95} ms second (${report.flagPassSecond.totalMs} ms total)`,
      report.flagPass.batch.p95 < derived &&
        report.flagPassSecond.batch.p95 < derived,
    );
    verdict(
      "flag pass of the sparse tenant (30 scheduled rows among every tenant's) total (derived)",
      lim(derived),
      `${report.flagPassSparse.flagged} of ${expectedS.n} flagged in ${report.flagPassSparse.totalMs} ms`,
      report.flagPassSparse.flagged === expectedS.n &&
        report.flagPassSparse.totalMs < derived,
    );
    for (const name of Object.keys(plans).filter((n) =>
      n.startsWith('flag pass'),
    )) {
      const plan = plans[name].plan;
      // A bitmap scan of the primary key ANDed with the partial index is
      // cheap and bounded by it; the bad shape is an ordered walk of the key
      // (every tenant's rows in id order) or a seq scan.
      const bad =
        seqScans(plan, 'chatbot_requests').length +
        plan.filter((l) =>
          /Index (Only )?Scan( Backward)? using chatbot_requests_pkey/.test(l),
        ).length;
      verdict(
        `${name}: not a seq scan and not an ordered walk of the primary key`,
        '0',
        `${bad} bad nodes, ${executionMs(plan)} ms, ${removedByFilter(plan)} rows removed by filters`,
        bad === 0 && executionMs(plan) < derived,
      );
    }
    report.verdicts = verdicts;

    const path =
      process.env.PERF_REPORT_PATH ??
      '/tmp/scheduled-conversations-load-report.json';
    writeFileSync(path, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, explain: undefined }, null, 2));
    console.log(`full report with EXPLAIN plans: ${path}`);
    expect(verdicts.filter((v) => !v.pass)).toEqual([]);
  });
});
