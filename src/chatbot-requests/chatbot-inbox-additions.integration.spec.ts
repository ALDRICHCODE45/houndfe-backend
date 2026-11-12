/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- supertest response bodies are untyped JSON and the query log event is untyped */
/**
 * S8 (unit 4 additions) end to end against REAL PostgreSQL: Supertest → the
 * staff controllers (stub guards that set the caller's role) → real services,
 * stores and the real tenant settings reader.
 *
 *   - per-row `allowedActions` / `deniedActions`, Manager vs Cashier vs read-only;
 *   - close cause (`cancelReason`, `staffCancelReason`, `mergedInto`) through
 *     the real merge and cancel commands, and no internal note on any row;
 *   - `resolved7d` / `cancelled7d` / `openGroups` (and their EXPLAIN);
 *   - `slaLevel` against the milestones the REAL sweep recorded;
 *   - fail-soft on unbuildable settings;
 *   - R12 masking unchanged;
 *   - no N+1: the number of statements of a read does not grow with the rows.
 *
 * The clock is injected (`now`); the schedule is the default Mon-Sat 09:00-19:00
 * America/Mexico_City (UTC-6 in November).
 */
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ClsModule, ClsService } from 'nestjs-cls';
import request from 'supertest';
import { integrationPrisma } from '../../test/integration/reset-db';
import { PERMISSIONS_KEY } from '../auth/authorization/decorators/require-permissions.decorator';
import { InsufficientPermissionsError } from '../shared/domain/domain-error';
import type {
  AppAbility,
  AppActions,
  AppSubjects,
} from '../auth/authorization/domain/permission';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { ActiveUserGuard } from '../auth/guards/active-user.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { createAppValidationPipe } from '../shared/listing/app-validation.pipe';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { PrismaService } from '../shared/prisma/prisma.service';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { defaultSettings } from '../chatbot-settings/domain/chatbot-attention-settings';
import {
  CHATBOT_REQUEST_RELATION_STORE,
  ChatbotRequestRelationsService,
} from './application/chatbot-request-relations.service';
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
import { CustomerKeySealer } from './domain/customer-key-sealer';
import { PrismaChatbotRequestCommandStore } from './infrastructure/prisma-chatbot-request-command.store';
import { PrismaChatbotRequestReadStore } from './infrastructure/prisma-chatbot-request-read.store';
import { PrismaChatbotRequestRelationStore } from './infrastructure/prisma-chatbot-request-relation.store';
import { PrismaSlaPauseReader } from './infrastructure/prisma-sla-pause.reader';
import { ChatbotSlaSweepScheduler } from './infrastructure/chatbot-sla-sweep.scheduler';
import { ChatbotSlaSweepStore } from './infrastructure/chatbot-sla-sweep.store';
import { ChatbotRequestCommandsController } from './presentation/chatbot-request-commands.controller';
import { ChatbotRequestHttpFilter } from './presentation/chatbot-request-http.filter';
import { ChatbotRequestReadsController } from './presentation/chatbot-request-reads.controller';
import { ChatbotRequestRelationsController } from './presentation/chatbot-request-relations.controller';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

type Grant = [AppActions, AppSubjects];
const READ_UPDATE: Grant[] = [
  ['read', 'ChatbotRequest'],
  ['update', 'ChatbotRequest'],
];
const LEGACY: Grant[] = [
  ['update', 'HumanDecision'],
  ['validate', 'DeliveryZone'],
  ['update', 'ReceiptEvidence'],
];
const ROLES: Record<string, Grant[]> = {
  manager: [
    ...READ_UPDATE,
    ['update', 'ChatbotRequestAssignment'],
    ['read', 'ChatbotConversation'],
    ['read', 'CustomerPhone'],
    ...LEGACY,
  ],
  cashier: [...READ_UPDATE, ['read', 'ChatbotConversation']],
  readOnly: [['read', 'ChatbotRequest']],
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

const SECRET = 'integration-secret-of-some-length';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (v: string) => new Date(v);
/** A full number as 10 digits or E.164, with or without `+`, not inside an id. */
const LEAK = /(?<![0-9A-Za-z-])\+?\d{10,15}(?![0-9A-Za-z-])/;

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

describeIfDb('chatbot inbox additions, S8 (PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const sealer = new CustomerKeySealer(SECRET);
  // The app's own client logs every statement, so the N+1 and EXPLAIN checks
  // look at what the stores really ran.
  const appPrisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
    log: [{ emit: 'event', level: 'query' }],
  });
  const log: Array<{ query: string; params: string }> = [];
  (appPrisma as any).$on('query', (event: any) =>
    log.push({ query: event.query, params: event.params }),
  );

  let app: INestApplication;
  let now = at('2026-11-10T10:30:00-06:00');
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const tenantC = randomUUID();
  const tenantNoise = randomUUID();
  const tenants = [tenantA, tenantB, tenantC, tenantNoise];
  const users = { ana: randomUUID(), luis: randomUUID() };
  const folios = new Map<string, number>();
  let seq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        DatabaseModule,
      ],
      controllers: [
        ChatbotRequestReadsController,
        ChatbotRequestCommandsController,
        ChatbotRequestRelationsController,
      ],
      providers: [
        ChatbotRequestHttpFilter,
        ChatbotRequestCommandsService,
        ChatbotRequestRelationsService,
        {
          provide: CHATBOT_REQUEST_RELATION_STORE,
          useClass: PrismaChatbotRequestRelationStore,
        },
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
        { provide: INBOX_CLOCK, useValue: () => now },
        { provide: SLA_PAUSE_READER, useClass: PrismaSlaPauseReader },
        {
          provide: CHATBOT_REQUEST_RESOLVER,
          useValue: { resolve: () => Promise.resolve() },
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
    for (const id of tenants) {
      await prisma.tenant.create({
        data: { id, name: 'Adiciones S8', slug: `cr-s8-${id}` },
      });
    }
    for (const [name, id] of Object.entries(users)) {
      await prisma.user.create({
        data: { id, email: `${id}@s8.test`, hashedPassword: 'x', name },
      });
    }
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await appPrisma.$disconnect();
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.user.deleteMany({
      where: { id: { in: Object.values(users) } },
    });
  });

  // -------------------------------------------------------------- helpers

  const as = (role: string, tenantId: string, userId: string = users.ana) => ({
    'x-test-role': role,
    'x-test-tenant': tenantId,
    'x-test-user': userId,
  });
  const http = () =>
    request(app.getHttpServer() as Parameters<typeof request>[0]);
  const get = (path: string, role = 'manager', tenantId = tenantA) =>
    http().get(path).set(as(role, tenantId));
  const post = (
    path: string,
    body: object,
    role = 'manager',
    tenantId = tenantA,
  ) =>
    http()
      .post(path)
      .set(as(role, tenantId))
      .set('Idempotency-Key', randomUUID())
      .send(body);

  /** A request inserted directly (the writers are covered by their own specs). */
  async function insert(
    tenantId: string,
    over: Record<string, unknown> = {},
  ): Promise<{ id: string; customerKey: string }> {
    const folio = (folios.get(tenantId) ?? 0) + 1;
    folios.set(tenantId, folio);
    const customerKey =
      (over.customerKey as string) ??
      `52552000${String(++seq).padStart(4, '0')}`;
    const row = await prisma.chatbotRequest.create({
      data: {
        tenantId,
        folio,
        kind: 'CLARIFICATION',
        subtype: 'UNKNOWN_QUESTION',
        summary: `Pregunta ${folio}`,
        phoneCountryCode: '52',
        phone: customerKey.slice(2),
        source: 'chatbot',
        sourceRequestId: randomUUID(),
        createdAt: at('2026-11-10T10:00:00-06:00'),
        slaPolicyVersion: 0,
        ...over,
        customerKey,
      } as never,
      select: { id: true },
    });
    return { id: row.id, customerKey };
  }

  /** Same definition `refreshCustomerGroup` uses, for rows inserted directly. */
  const refreshGroups = async (tenantId: string) => {
    await prisma.chatbotCustomerGroup.deleteMany({ where: { tenantId } });
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "chatbot_customer_groups"
        ("tenantId", "customerKey", "openCount", "mostUrgentAt", "hasOverdue", "updatedAt")
      SELECT "tenantId", "customerKey", count(*)::int,
             min(CASE WHEN "status" = 'NEW' THEN "claimDeadlineAt" ELSE "resolveDeadlineAt" END),
             coalesce(bool_or("overdueAt" IS NOT NULL), false), now()
      FROM "chatbot_requests"
      WHERE "tenantId" = ${tenantId} AND "status" IN ('NEW', 'IN_PROGRESS')
      GROUP BY "tenantId", "customerKey"`);
  };

  const claimedBy = (userId: string, name: string) => ({
    status: 'IN_PROGRESS',
    assigneeUserId: userId,
    assigneeDisplayName: name,
    claimedAt: at('2026-11-10T10:05:00-06:00'),
    version: 2,
  });

  const rowsOf = (res: any): any[] =>
    res.body.items.flatMap((g: any) => g.requests);
  const byFolioLabel = (rows: any[]) =>
    Object.fromEntries(rows.map((r) => [r.summary, r]));

  const queriesDuring = async (work: () => Promise<unknown>) => {
    log.length = 0;
    await work();
    return log.length;
  };

  // ------------------------------------------------ actions on every row

  describe('allowedActions and deniedActions on every row', () => {
    let restock: { id: string; customerKey: string };

    beforeAll(async () => {
      const decision = await prisma.humanDecision.create({
        data: {
          tenantId: tenantA,
          source: 'chatbot',
          sourceRequestId: randomUUID(),
          canonicalRequestHash: 'h',
          submittedCredentialId: 'cred',
          branchId: tenantA,
          branchName: 'Centro',
          productId: randomUUID(),
          productName: 'Croquetas 20 kg',
          requestedQuantity: 3,
        },
      });
      const key = '525520009001';
      restock = await insert(tenantA, {
        kind: 'DECISION',
        subtype: 'RESTOCK',
        humanDecisionId: decision.id,
        customerKey: key,
        summary: 'restock',
      });
      await insert(tenantA, { customerKey: key, summary: 'free' });
      await insert(tenantA, {
        customerKey: key,
        summary: 'theirs',
        ...claimedBy(users.luis, 'Luis'),
      });
      await insert(tenantA, {
        customerKey: key,
        summary: 'mine',
        ...claimedBy(users.ana, 'Ana'),
      });
      await refreshGroups(tenantA);
    });

    const groupRows = async (role: string) => {
      const res = await get('/chatbot-requests/groups?limit=50', role);
      expect(res.status).toBe(200);
      return byFolioLabel(rowsOf(res));
    };

    it('manager: from the row state and abilities, MERGE and LINK_CUSTOMER never on a row', async () => {
      const rows = await groupRows('manager');
      expect(rows.free).toMatchObject({
        allowedActions: ['CLAIM', 'CANCEL'],
        deniedActions: [],
      });
      expect(rows.mine).toMatchObject({
        allowedActions: ['RELEASE', 'REASSIGN', 'CANCEL'],
        deniedActions: [],
      });
      expect(rows.theirs).toMatchObject({
        allowedActions: ['RELEASE', 'REASSIGN', 'CANCEL'],
        deniedActions: [{ action: 'CLAIM', code: 'REQUEST_CLAIMED_BY_OTHER' }],
      });
      expect(rows.restock).toMatchObject({
        allowedActions: ['CLAIM', 'RESOLVE'],
        deniedActions: [{ action: 'CANCEL', code: 'CANCEL_NOT_ALLOWED' }],
      });
      for (const row of Object.values<any>(rows)) {
        const all = JSON.stringify([row.allowedActions, row.deniedActions]);
        expect(all).not.toContain('MERGE');
        expect(all).not.toContain('LINK_CUSTOMER');
      }
    });

    it('cashier: the same state, other abilities, codes only', async () => {
      const rows = await groupRows('cashier');
      expect(rows.free.allowedActions).toEqual(['CLAIM', 'CANCEL']);
      expect(rows.mine.allowedActions).toEqual(['RELEASE', 'CANCEL']);
      expect(rows.mine.deniedActions).toEqual([
        { action: 'REASSIGN', code: 'INSUFFICIENT_PERMISSIONS' },
      ]);
      expect(rows.theirs.allowedActions).toEqual([]);
      expect(rows.theirs.deniedActions).toEqual([
        { action: 'CLAIM', code: 'REQUEST_CLAIMED_BY_OTHER' },
        { action: 'RELEASE', code: 'NOT_ASSIGNEE' },
        { action: 'REASSIGN', code: 'INSUFFICIENT_PERMISSIONS' },
        { action: 'CANCEL', code: 'NOT_ASSIGNEE' },
      ]);
      expect(rows.restock.allowedActions).toEqual(['CLAIM']);
      expect(rows.restock.deniedActions).toEqual([
        { action: 'RESOLVE', code: 'INSUFFICIENT_PERMISSIONS' },
        { action: 'CANCEL', code: 'CANCEL_NOT_ALLOWED' },
      ]);
      // Nothing about the holder beyond what the row already shows.
      expect(JSON.stringify(rows.theirs.deniedActions)).not.toContain('Luis');
    });

    it('read-only: nothing allowed, a permission code for what applies', async () => {
      const rows = await groupRows('readOnly');
      expect(rows.free.allowedActions).toEqual([]);
      expect(rows.free.deniedActions).toEqual([
        { action: 'CLAIM', code: 'INSUFFICIENT_PERMISSIONS' },
        { action: 'CANCEL', code: 'INSUFFICIENT_PERMISSIONS' },
      ]);
    });

    it('the codes are the ones the commands answer (differential against the real routes)', async () => {
      const rows = await groupRows('cashier');
      const theirs = rows.theirs;
      const claim = await post(
        `/chatbot-requests/${theirs.id}/claim`,
        { expectedVersion: theirs.version },
        'cashier',
      );
      expect(claim.status).toBe(409);
      expect(claim.body.code).toBe('REQUEST_CLAIMED_BY_OTHER');
      const release = await post(
        `/chatbot-requests/${theirs.id}/release`,
        { expectedVersion: theirs.version },
        'cashier',
      );
      expect(release.body.code).toBe('NOT_ASSIGNEE');
      const reassign = await post(
        `/chatbot-requests/${theirs.id}/reassign`,
        { expectedVersion: theirs.version, toUserId: users.ana },
        'cashier',
      );
      expect(reassign.body.code).toBe('INSUFFICIENT_PERMISSIONS');
      const cancelDecision = await post(
        `/chatbot-requests/${restock.id}/cancel`,
        { expectedVersion: 1, reason: 'DUPLICATE' },
        'manager',
      );
      expect(cancelDecision.body.code).toBe('CANCEL_NOT_ALLOWED');
      const resolve = await post(
        `/chatbot-requests/${restock.id}/resolve`,
        {
          expectedVersion: 1,
          action: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
        },
        'cashier',
      );
      expect(resolve.body.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('by-customer rows, detail (own lists and other open rows) and history carry them', async () => {
      const groups = await get('/chatbot-requests/groups?limit=50');
      const key = groups.body.items[0].customerKey;
      const list = await get(`/chatbot-requests?customerKey=${key}`, 'cashier');
      expect(list.status).toBe(200);
      for (const row of list.body.items) {
        expect(Array.isArray(row.allowedActions)).toBe(true);
        expect(Array.isArray(row.deniedActions)).toBe(true);
      }
      const free = byFolioLabel(list.body.items).free;
      expect(free.allowedActions).toEqual(['CLAIM', 'CANCEL']);

      const detail = await get(`/chatbot-requests/${free.id}`, 'cashier');
      expect(detail.status).toBe(200);
      expect(detail.body.allowedActions).toEqual(['CLAIM', 'CANCEL']);
      expect(detail.body.deniedActions).toEqual([]);
      expect(detail.body.otherOpenRequests.length).toBeGreaterThan(0);
      for (const other of detail.body.otherOpenRequests) {
        expect(other).toHaveProperty('allowedActions');
        expect(other).toHaveProperty('deniedActions');
      }
      const managerDetail = await get(`/chatbot-requests/${free.id}`);
      // The detail alone may add MERGE (needs a merge candidate in the same conversation).
      expect(managerDetail.body.allowedActions).toEqual(
        expect.arrayContaining(['CLAIM', 'CANCEL']),
      );

      const old = await insert(tenantA, {
        summary: 'old',
        status: 'RESOLVED',
        version: 3,
        resolvedAt: new Date(now.getTime() - 20 * DAY),
        closedAt: new Date(now.getTime() - 20 * DAY),
        resolvedByActorId: users.luis,
        resolvedByDisplayName: 'Luis',
      });
      const history = await get('/chatbot-requests/history?limit=50');
      const oldRow = history.body.items.find((r: any) => r.id === old.id);
      expect(oldRow).toMatchObject({
        allowedActions: [],
        deniedActions: [],
        slaLevel: null,
        cancelReason: null,
      });
    });

    it('merge candidates carry the lists too', async () => {
      const a = await insert(tenantA, {
        summary: 'twin-a',
        conversationRef: 'wa:twins',
      });
      await insert(tenantA, {
        customerKey: a.customerKey,
        summary: 'twin-b',
        conversationRef: 'wa:twins',
      });
      await refreshGroups(tenantA);
      const res = await get(`/chatbot-requests/${a.id}/merge-candidates`);
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].allowedActions).toEqual(['CLAIM', 'CANCEL']);
    });
  });

  // ------------------------------------------------------ close cause

  describe('close cause on rows and detail', () => {
    it('staff cancel, staff merge, customer causes, resolved and open rows', async () => {
      const conversationRef = 'wa:cause';
      const customerKey = '525520008001';
      const source = await insert(tenantB, {
        customerKey,
        conversationRef,
        summary: 'source',
      });
      const target = await insert(tenantB, {
        customerKey,
        conversationRef,
        summary: 'target',
      });
      const cancelled = await insert(tenantB, {
        summary: 'cancelled-by-staff',
      });
      await refreshGroups(tenantB);

      const merge = await post(
        `/chatbot-requests/${source.id}/merge`,
        {
          expectedVersion: 1,
          intoRequestId: target.id,
          intoExpectedVersion: 1,
        },
        'manager',
        tenantB,
      );
      expect(merge.status).toBe(200);
      const cancel = await post(
        `/chatbot-requests/${cancelled.id}/cancel`,
        {
          expectedVersion: 1,
          reason: 'OTHER',
          note: 'nota interna secreta',
          customerNote: 'texto para el cliente',
        },
        'manager',
        tenantB,
      );
      expect(cancel.status).toBe(200);
      const withdrew = await insert(tenantB, {
        summary: 'withdrew',
        status: 'CANCELLED',
        version: 2,
        cancelReason: 'CUSTOMER_WITHDREW',
        cancelledAt: now,
        closedAt: now,
      });
      const auto = await insert(tenantB, {
        summary: 'auto',
        status: 'CANCELLED',
        version: 2,
        cancelReason: 'AUTO_RESOLVED',
        cancelledAt: now,
        closedAt: now,
      });
      await insert(tenantB, {
        summary: 'resolved',
        status: 'RESOLVED',
        version: 2,
        resolvedAt: now,
        closedAt: now,
        resolvedByActorId: users.luis,
        resolvedByDisplayName: 'Luis',
      });

      const targetFolio = (
        await prisma.chatbotRequest.findFirstOrThrow({
          where: { id: target.id },
        })
      ).folio;
      const res = await get(
        '/chatbot-requests/groups?status=cancelled&limit=50',
        'cashier',
        tenantB,
      );
      const rows = byFolioLabel(rowsOf(res));
      expect(rows.source).toMatchObject({
        cancelReason: 'SUPERSEDED',
        staffCancelReason: null,
        mergedInto: {
          id: target.id,
          folio: `S-${String(targetFolio).padStart(6, '0')}`,
        },
      });
      expect(rows['cancelled-by-staff']).toMatchObject({
        cancelReason: 'STAFF',
        staffCancelReason: 'OTHER',
        mergedInto: null,
      });
      expect(rows.withdrew).toMatchObject({
        cancelReason: 'CUSTOMER_WITHDREW',
        staffCancelReason: null,
        mergedInto: null,
      });
      expect(rows.auto.cancelReason).toBe('AUTO_RESOLVED');
      // No internal note, no customer note, on any row of the response.
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('nota interna secreta');
      expect(body).not.toContain('texto para el cliente');

      const resolved = await get(
        '/chatbot-requests/groups?status=resolved&limit=50',
        'cashier',
        tenantB,
      );
      expect(byFolioLabel(rowsOf(resolved)).resolved).toMatchObject({
        cancelReason: null,
        staffCancelReason: null,
        mergedInto: null,
      });
      const open = await get(
        '/chatbot-requests/groups?limit=50',
        'cashier',
        tenantB,
      );
      expect(byFolioLabel(rowsOf(open)).target).toMatchObject({
        cancelReason: null,
        staffCancelReason: null,
        mergedInto: null,
      });

      // The detail carries the same fields, and still no note (the audit has
      // always shown the staff's own `note` and `customerNote` in `data`:
      // unchanged, and only the row fields are asserted here).
      const detail = await get(
        `/chatbot-requests/${source.id}`,
        'cashier',
        tenantB,
      );
      expect(detail.body).toMatchObject({
        cancelReason: 'SUPERSEDED',
        mergedInto: { id: target.id },
      });
      const staffDetail = await get(
        `/chatbot-requests/${cancelled.id}`,
        'cashier',
        tenantB,
      );
      expect(staffDetail.body).toMatchObject({
        cancelReason: 'STAFF',
        staffCancelReason: 'OTHER',
      });
      expect(withdrew.id).toBeDefined();
      expect(auto.id).toBeDefined();
    });
  });

  // ---------------------------------------------------------------- counts

  describe('counts: resolved7d, cancelled7d, openGroups', () => {
    const closeWith = (
      status: 'RESOLVED' | 'CANCELLED',
      closedAt: Date,
      summary: string,
      tenantId = tenantC,
    ) =>
      insert(tenantId, {
        summary,
        status,
        version: 2,
        closedAt,
        ...(status === 'RESOLVED'
          ? {
              resolvedAt: closedAt,
              resolvedByActorId: users.luis,
              resolvedByDisplayName: 'Luis',
            }
          : { cancelledAt: closedAt, cancelReason: 'CUSTOMER_WITHDREW' }),
      });

    beforeAll(async () => {
      const cutoff = new Date(now.getTime() - 7 * DAY);
      await closeWith('RESOLVED', new Date(now.getTime() - 1 * HOUR), 'r1');
      await closeWith('RESOLVED', new Date(now.getTime() - 3 * DAY), 'r2');
      // Exactly on the window edge: inside (closedAt >= now - 7 d), like the tab.
      await closeWith('RESOLVED', cutoff, 'r-edge');
      await closeWith('RESOLVED', new Date(cutoff.getTime() - 1), 'r-out');
      await closeWith('CANCELLED', new Date(now.getTime() - 2 * DAY), 'c1');
      await closeWith('CANCELLED', new Date(cutoff.getTime() - DAY), 'c-out');
      // Open requests: three customers, one with two requests.
      const shared = '525520007001';
      await insert(tenantC, { summary: 'o1', customerKey: shared });
      await insert(tenantC, { summary: 'o2', customerKey: shared });
      await insert(tenantC, { summary: 'o3' });
      await insert(tenantC, { summary: 'o4', ...claimedBy(users.ana, 'Ana') });
      await refreshGroups(tenantC);
      // Another sucursal's closed requests never count here.
      await closeWith(
        'RESOLVED',
        new Date(now.getTime() - HOUR),
        'noise',
        tenantNoise,
      );
    });

    it('counts closedAt inside the same 7-day window as the tabs, per sucursal', async () => {
      const counts = await get('/chatbot-requests/counts', 'manager', tenantC);
      expect(counts.status).toBe(200);
      expect(counts.body).toMatchObject({
        new: 3,
        inProgress: 1,
        mine: 1,
        resolved7d: 3,
        cancelled7d: 1,
        openGroups: 3,
      });
      const resolvedTab = await get(
        '/chatbot-requests/groups?status=resolved&limit=50',
        'manager',
        tenantC,
      );
      expect(rowsOf(resolvedTab)).toHaveLength(counts.body.resolved7d);
      const cancelledTab = await get(
        '/chatbot-requests/groups?status=cancelled&limit=50',
        'manager',
        tenantC,
      );
      expect(rowsOf(cancelledTab)).toHaveLength(counts.body.cancelled7d);
      const openTab = await get(
        '/chatbot-requests/groups?limit=50',
        'manager',
        tenantC,
      );
      expect(openTab.body.items).toHaveLength(counts.body.openGroups);
    });

    it('follows the wall clock and the tenant, with the same visibility for every role', async () => {
      const manager = await get('/chatbot-requests/counts', 'manager', tenantC);
      const cashier = await get('/chatbot-requests/counts', 'cashier', tenantC);
      const readOnly = await get(
        '/chatbot-requests/counts',
        'readOnly',
        tenantC,
      );
      expect(cashier.body).toEqual(manager.body);
      expect(readOnly.body).toEqual(manager.body);
      const noise = await get(
        '/chatbot-requests/counts',
        'manager',
        tenantNoise,
      );
      expect(noise.body).toMatchObject({
        resolved7d: 1,
        cancelled7d: 0,
        openGroups: 0,
      });
      // Two days later the 1 h and 3 d old ones have moved: 3 d -> 5 d (in),
      // 7 d edge and older -> out.
      const real = now;
      now = new Date(real.getTime() + 2 * DAY);
      try {
        const later = await get('/chatbot-requests/counts', 'manager', tenantC);
        expect(later.body).toMatchObject({ resolved7d: 2, cancelled7d: 1 });
      } finally {
        now = real;
      }
    });
  });

  describe('counts at scale: index-backed (EXPLAIN) and inside the perf target', () => {
    const big = randomUUID();

    beforeAll(async () => {
      tenants.push(big);
      await prisma.tenant.create({
        data: { id: big, name: 'Escala S8', slug: `cr-s8-${big}` },
      });
      // 12,000 closed requests over 400 days (closed rows are kept
      // forever, so the 7-day window is a small slice, about 2 %) and 3,000 open customers' groups, then ANALYZE, so the planner
      // chooses on real statistics, not on an empty table.
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO "chatbot_requests"
          ("id", "tenantId", "folio", "kind", "subtype", "status", "customerKey",
           "summary", "source", "sourceRequestId", "resolvedAt", "resolvedByActorId",
           "resolvedByDisplayName", "cancelledAt", "cancelReason", "closedAt",
           "createdAt", "updatedAt")
        SELECT gen_random_uuid()::text, ${big}, g, 'CLARIFICATION', 'UNKNOWN_QUESTION',
          (CASE WHEN g % 2 = 0 THEN 'RESOLVED' ELSE 'CANCELLED' END)::"ChatbotRequestStatus",
          '5255' || lpad((g % 4000)::text, 8, '0'), 'cerrada', 'perf', gen_random_uuid()::text,
          CASE WHEN g % 2 = 0 THEN closed_at END,
          CASE WHEN g % 2 = 0 THEN ${users.luis} END,
          CASE WHEN g % 2 = 0 THEN 'Luis' END,
          CASE WHEN g % 2 = 1 THEN closed_at END,
          (CASE WHEN g % 2 = 1 THEN 'CUSTOMER_WITHDREW' END)::"ChatbotRequestCancelReason",
          closed_at, closed_at - interval '1 hour', closed_at
        FROM (SELECT g, ${now}::timestamp - (g * interval '400 days' / 12000) AS closed_at
              FROM generate_series(1, 12000) AS g) s`);
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO "chatbot_customer_groups"
          ("tenantId", "customerKey", "openCount", "updatedAt")
        SELECT ${big}, '5256' || lpad(g::text, 8, '0'), 1, now()
        FROM generate_series(1, 3000) AS g`);
      await prisma.$executeRawUnsafe('VACUUM ANALYZE "chatbot_requests"');
      await prisma.$executeRawUnsafe(
        'VACUUM ANALYZE "chatbot_customer_groups"',
      );
    }, 120_000);

    type PlanNode = {
      'Node Type': string;
      'Index Name'?: string;
      'Relation Name'?: string;
      Plans?: PlanNode[];
    };
    const nodesOf = (node: PlanNode): PlanNode[] => [
      node,
      ...(node.Plans ?? []).flatMap(nodesOf),
    ];

    it('closed counts use the partial history index and no sequential scan of the requests table', async () => {
      const res = await get('/chatbot-requests/counts', 'manager', big);
      expect(res.body.openGroups).toBe(3000);
      expect(res.body.resolved7d + res.body.cancelled7d).toBeGreaterThan(100);

      log.length = 0;
      await get('/chatbot-requests/counts', 'manager', big);
      const counted = log.find((entry) => entry.query.includes('"openGroups"'));
      expect(counted).toBeDefined();
      const sql = inline(counted!.query, counted!.params);
      const rows = await prisma.$queryRawUnsafe<any[]>(
        `EXPLAIN (FORMAT JSON) ${sql}`,
      );
      const nodes = nodesOf(rows[0]['QUERY PLAN'][0].Plan as PlanNode);
      const scans = nodes.filter((n) => n['Relation Name']);
      // The requests table is never scanned sequentially. (The group table
      // holds one row per customer with open requests, a few thousand at the
      // sized load, and the planner may count it either way.)
      expect(
        scans
          .filter((n) => n['Node Type'] === 'Seq Scan')
          .map((n) => n['Relation Name'])
          .filter((name) => name === 'chatbot_requests'),
      ).toEqual([]);
      const indexes = scans.map((n) => n['Index Name']);
      expect(indexes).toContain('chatbot_requests_history_idx');
      // Bounded: no Sort and no GROUP BY over the table (only plain counts).
      expect(nodes.map((n) => n['Node Type'])).not.toContain('Sort');
      expect(nodes.map((n) => n['Node Type'])).not.toContain('HashAggregate');
    });

    it('keeps the counts well inside the perf target (p95 < 200 ms)', async () => {
      const samples: number[] = [];
      for (let i = 0; i < 40; i++) {
        const t0 = process.hrtime.bigint();
        const res = await get('/chatbot-requests/counts', 'manager', big);
        samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
        expect(res.status).toBe(200);
      }
      samples.sort((a, b) => a - b);
      const p95 = samples[Math.ceil(0.95 * samples.length) - 1];
      expect(p95).toBeLessThan(200);
    });
  });

  describe('groups with the S8 columns at scale (p95 < 200 ms)', () => {
    it('4,000 open requests over 1,500 customers: a page of 25 groups stays far inside the target', async () => {
      const heavy = randomUUID();
      tenants.push(heavy);
      await prisma.tenant.create({
        data: { id: heavy, name: 'Carga S8', slug: `cr-s8-${heavy}` },
      });
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO "chatbot_requests"
          ("id", "tenantId", "folio", "kind", "subtype", "status", "customerKey",
           "summary", "source", "sourceRequestId", "claimDeadlineAt",
           "resolveDeadlineAt", "assigneeUserId", "assigneeDisplayName", "claimedAt",
           "createdAt", "updatedAt")
        SELECT gen_random_uuid()::text, ${heavy}, g, 'CLARIFICATION', 'UNKNOWN_QUESTION',
          (CASE WHEN g % 10 < 3 THEN 'IN_PROGRESS' ELSE 'NEW' END)::"ChatbotRequestStatus",
          '5257' || lpad((g % 1500)::text, 8, '0'), 'abierta', 'perf', gen_random_uuid()::text,
          ${now}::timestamp + ((g % 500) - 100) * interval '1 minute',
          ${now}::timestamp + ((g % 500) - 100) * interval '1 minute',
          CASE WHEN g % 10 < 3 THEN ${users.luis} END,
          CASE WHEN g % 10 < 3 THEN 'Luis' END,
          CASE WHEN g % 10 < 3 THEN ${now}::timestamp END,
          ${now}::timestamp - (g % 600) * interval '1 minute', ${now}::timestamp
        FROM generate_series(1, 4000) AS g`);
      // A third of the NEW ones were released once (the claim clock restarted).
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO "chatbot_request_events"
          ("id", "tenantId", "requestId", "type", "actorKind", "version", "data", "createdAt")
        SELECT gen_random_uuid()::text, "tenantId", "id", 'RELEASED', 'SYSTEM', 2, '{}',
               ${now}::timestamp - interval '5 minutes'
        FROM "chatbot_requests"
        WHERE "tenantId" = ${heavy} AND "status" = 'NEW' AND "folio" % 3 = 0`);
      await refreshGroups(heavy);
      await prisma.$executeRawUnsafe('VACUUM ANALYZE "chatbot_requests"');
      await prisma.$executeRawUnsafe('VACUUM ANALYZE "chatbot_request_events"');

      const first = await get(
        '/chatbot-requests/groups?limit=25',
        'cashier',
        heavy,
      );
      expect(first.status).toBe(200);
      const rows = rowsOf(first);
      expect(rows.length).toBeGreaterThan(25);
      expect(rows.every((r: any) => typeof r.slaLevel === 'string')).toBe(true);
      const samples: number[] = [];
      for (let i = 0; i < 30; i++) {
        const t0 = process.hrtime.bigint();
        const res = await get(
          '/chatbot-requests/groups?limit=25',
          'cashier',
          heavy,
        );
        samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
        expect(res.status).toBe(200);
      }
      samples.sort((a, b) => a - b);
      expect(samples[Math.ceil(0.95 * samples.length) - 1]).toBeLessThan(200);
    }, 120_000);
  });

  // ---------------------------------------------- slaLevel vs the sweep

  describe('slaLevel agrees with the milestones the real sweep recorded', () => {
    const expectedFromSweep = async (
      tenantId: string,
      id: string,
      status: string,
    ) => {
      const clock = status === 'NEW' ? 'CLAIM' : 'RESOLVE';
      const events = await prisma.chatbotRequestEvent.findMany({
        where: { tenantId, requestId: id, type: 'SLA_MILESTONE' },
      });
      const order = ['HALF', 'ESCALATION', 'OVERDUE'];
      let level = 'OK';
      for (const event of events) {
        const data = event.data as { clock: string; milestone: string };
        if (data.clock !== clock) continue;
        if (order.indexOf(data.milestone) >= order.indexOf(level))
          level = data.milestone;
        if (level === 'OK') level = data.milestone;
      }
      return level;
    };

    const sweepAt = async (instant: Date) => {
      now = instant;
      const store = new ChatbotSlaSweepStore(appPrisma as never, {
        clock: () => now,
      });
      await new ChatbotSlaSweepScheduler(store).tick();
    };

    it('every level, resolve clock, and a deadline that spans a closed weekend', async () => {
      const due = { nextSlaCheckAt: at('2026-11-01T00:00:00Z') };
      const ids: Record<string, { id: string; status: string }> = {};
      const add = async (
        label: string,
        createdAt: string,
        extra: Record<string, unknown> = {},
      ) => {
        const created = await insert(tenantA, {
          summary: label,
          createdAt: at(createdAt),
          ...due,
          ...extra,
        });
        ids[label] = {
          id: created.id,
          status: (extra.status as string | undefined) ?? 'NEW',
        };
      };
      // Phase 1: Tuesday 10:30 Mexico City, claim window of 30 business min.
      await add('lvl-ok', '2026-11-10T10:20:00-06:00');
      await add('lvl-half', '2026-11-10T10:12:00-06:00');
      await add('lvl-esc', '2026-11-10T10:05:00-06:00');
      await add('lvl-over', '2026-11-10T09:45:00-06:00');
      // Claimed: the resolve clock (120 min) is at 90 min -> HALF.
      await add('lvl-prog', '2026-11-10T09:00:00-06:00', {
        ...claimedBy(users.ana, 'Ana'),
      });
      await refreshGroups(tenantA);

      const check = async (
        labels: string[],
        expected: Record<string, string>,
      ) => {
        const res = await get('/chatbot-requests/groups?limit=50');
        const rows = byFolioLabel(rowsOf(res));
        for (const label of labels) {
          const fromSweep = await expectedFromSweep(
            tenantA,
            ids[label].id,
            ids[label].status,
          );
          expect(rows[label].slaLevel).toBe(fromSweep);
          expect(rows[label].slaLevel).toBe(expected[label]);
          const detail = await get(`/chatbot-requests/${ids[label].id}`);
          expect(detail.body.slaLevel).toBe(fromSweep);
        }
      };

      await sweepAt(at('2026-11-10T10:30:00-06:00'));
      await check(['lvl-ok', 'lvl-half', 'lvl-esc', 'lvl-over', 'lvl-prog'], {
        'lvl-ok': 'OK',
        'lvl-half': 'HALF',
        'lvl-esc': 'ESCALATION',
        'lvl-over': 'OVERDUE',
        'lvl-prog': 'HALF',
      });

      // Phase 2: Saturday 18:50 + 30 business min = Monday 09:20; 80 % is 09:14.
      await add('lvl-weekend', '2026-11-14T18:50:00-06:00');
      await refreshGroups(tenantA);
      await sweepAt(at('2026-11-15T12:00:00-06:00')); // Sunday: paused
      await check(['lvl-weekend'], { 'lvl-weekend': 'OK' });
      await sweepAt(at('2026-11-16T09:14:00-06:00'));
      await check(['lvl-weekend'], { 'lvl-weekend': 'ESCALATION' });
      await sweepAt(at('2026-11-16T09:20:00-06:00'));
      await check(['lvl-weekend'], { 'lvl-weekend': 'OVERDUE' });
      now = at('2026-11-10T10:30:00-06:00');
    });

    it('a request claimed after its claim deadline stays OVERDUE (overdueAt wins over the resolve clock)', async () => {
      const created = await insert(tenantB, {
        summary: 'late-claim',
        createdAt: at('2026-11-10T10:00:00-06:00'),
        nextSlaCheckAt: at('2026-11-01T00:00:00Z'),
      });
      await refreshGroups(tenantB);
      // The sweep marks it overdue at 10:40 (claim deadline 10:30).
      await sweepAt(at('2026-11-10T10:40:00-06:00'));
      const marked = await prisma.chatbotRequest.findFirstOrThrow({
        where: { id: created.id },
      });
      expect(marked.overdueAt).not.toBeNull();
      // A manager claims it late: the active clock becomes the resolve clock
      // (120 business min from 10:00), only a third used.
      const claim = await post(
        `/chatbot-requests/${created.id}/claim`,
        { expectedVersion: marked.version },
        'manager',
        tenantB,
      );
      expect(claim.status).toBe(200);
      const rows = byFolioLabel(
        rowsOf(
          await get('/chatbot-requests/groups?limit=50', 'cashier', tenantB),
        ),
      );
      expect(rows['late-claim']).toMatchObject({
        status: 'IN_PROGRESS',
        displayStatus: 'EXPIRED',
        slaLevel: 'OVERDUE',
      });
      const detail = await get(
        `/chatbot-requests/${created.id}`,
        'cashier',
        tenantB,
      );
      expect(detail.body.slaLevel).toBe('OVERDUE');
      // Closed rows stay null.
      await prisma.chatbotRequest.update({
        where: { id: created.id },
        data: {
          status: 'RESOLVED',
          resolvedAt: now,
          closedAt: now,
          resolvedByActorId: users.luis,
          resolvedByDisplayName: 'Luis',
          nextSlaCheckAt: null,
        },
      });
      const closed = await get(
        `/chatbot-requests/${created.id}`,
        'cashier',
        tenantB,
      );
      expect(closed.body.slaLevel).toBeNull();
      now = at('2026-11-10T10:30:00-06:00');
    });
  });

  // --------------------------------------------------------- fail soft

  describe('fail soft on unbuildable settings', () => {
    it('answers 200 with slaLevel null and slaPaused false, and logs once by tenant', async () => {
      const bad = randomUUID();
      tenants.push(bad);
      await prisma.tenant.create({
        data: { id: bad, name: 'Ajustes rotos', slug: `cr-s8-${bad}` },
      });
      const settings = defaultSettings();
      await prisma.chatbotAttentionSettings.create({
        data: {
          tenantId: bad,
          version: 1,
          timeZone: 'Not/AZone',
          // The policy of this tenant cannot be built (no such IANA zone).
          days: settings.openingHours.days as never,
          closedDates: [],
          slas: settings.slas as never,
          windowWarningMinutes: 120,
          templateCostText: 'x',
          enabledSubtypes: [],
          receiptCloseMarginMinutes: 60,
          schedulingEnabled: false,
          slotMinutes: 30,
          slotsOffered: 3,
          maxScheduledPerSlot: 3,
        },
      });
      await insert(bad, { summary: 'a' });
      await insert(bad, { summary: 'b' });
      await refreshGroups(bad);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      try {
        const res = await get(
          '/chatbot-requests/groups?limit=50',
          'manager',
          bad,
        );
        expect(res.status).toBe(200);
        const rows = rowsOf(res);
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row).toMatchObject({ slaLevel: null, slaPaused: false });
          expect(row.allowedActions).toEqual(['CLAIM', 'CANCEL']);
        }
        const lines = warn.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.includes('sla '));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(bad);
      } finally {
        warn.mockRestore();
      }
    });
  });

  // -------------------------------------------------------- R12 + N+1

  describe('R12 masking unchanged', () => {
    it('no full phone in any new field or response for a caller without read:CustomerPhone', async () => {
      const paths = [
        '/chatbot-requests/groups?limit=50',
        '/chatbot-requests/groups?status=cancelled&limit=50',
        '/chatbot-requests/history?limit=50',
        '/chatbot-requests/counts',
      ];
      for (const path of paths) {
        const res = await get(path, 'cashier');
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toMatch(LEAK);
      }
      const first = await get('/chatbot-requests/groups?limit=50', 'cashier');
      const id = rowsOf(first)[0].id;
      const detail = await get(`/chatbot-requests/${id}`, 'cashier');
      expect(JSON.stringify(detail.body)).not.toMatch(LEAK);
      expect(detail.body.customer.phone).toMatch(/\*\*\*\*/);
      const manager = await get(`/chatbot-requests/${id}`, 'manager');
      expect(manager.body.customer.phone).toMatch(/^\+52/);
    });
  });

  describe('no N+1', () => {
    it('the number of statements of a read does not grow with the rows', async () => {
      // 30 customers with 3 open requests each, plus 10 closed superseded ones.
      for (let c = 0; c < 30; c++) {
        const customerKey = `52553000${String(c).padStart(4, '0')}`;
        for (let i = 0; i < 3; i++) {
          await insert(tenantC, {
            summary: `n${c}-${i}`,
            customerKey,
            conversationRef: `wa:${customerKey}`,
          });
        }
      }
      await refreshGroups(tenantC);
      const closedKey = '525530009999';
      for (let i = 0; i < 10; i++) {
        await insert(tenantC, {
          summary: `sup${i}`,
          customerKey: closedKey,
          status: 'CANCELLED',
          version: 3,
          cancelReason: 'SUPERSEDED',
          cancelledAt: new Date(now.getTime() - i * 1000),
          closedAt: new Date(now.getTime() - i * 1000),
        });
      }

      const groupsFew = await queriesDuring(() =>
        get('/chatbot-requests/groups?limit=2', 'cashier', tenantC),
      );
      const groupsMany = await queriesDuring(() =>
        get('/chatbot-requests/groups?limit=50', 'cashier', tenantC),
      );
      expect(groupsMany).toBe(groupsFew);

      const closedFew = await queriesDuring(() =>
        get(
          '/chatbot-requests/groups?status=cancelled&limit=1',
          'cashier',
          tenantC,
        ),
      );
      const closedMany = await queriesDuring(() =>
        get(
          '/chatbot-requests/groups?status=cancelled&limit=50',
          'cashier',
          tenantC,
        ),
      );
      expect(closedMany).toBe(closedFew);

      const history = await get(
        '/chatbot-requests/history?limit=1',
        'cashier',
        tenantC,
      );
      expect(history.status).toBe(200);
      const histFew = await queriesDuring(() =>
        get('/chatbot-requests/history?limit=1', 'cashier', tenantC),
      );
      const histMany = await queriesDuring(() =>
        get('/chatbot-requests/history?limit=50', 'cashier', tenantC),
      );
      expect(histMany).toBe(histFew);

      const key = (
        await get('/chatbot-requests/groups?limit=1', 'cashier', tenantC)
      ).body.items[0].customerKey;
      const listFew = await queriesDuring(() =>
        get(`/chatbot-requests?customerKey=${key}&limit=1`, 'cashier', tenantC),
      );
      const listMany = await queriesDuring(() =>
        get(
          `/chatbot-requests?customerKey=${key}&limit=50`,
          'cashier',
          tenantC,
        ),
      );
      expect(listMany).toBe(listFew);

      // Detail: one customer with 3 open rows vs the same with 20 more.
      const sample = await get(
        `/chatbot-requests?customerKey=${key}`,
        'cashier',
        tenantC,
      );
      const id = sample.body.items[0].id;
      const detailBefore = await queriesDuring(() =>
        get(`/chatbot-requests/${id}`, 'cashier', tenantC),
      );
      const customerKey = (
        await prisma.chatbotRequest.findFirstOrThrow({ where: { id } })
      ).customerKey;
      for (let i = 0; i < 15; i++) {
        await insert(tenantC, {
          summary: `extra${i}`,
          customerKey,
          conversationRef: `wa:${customerKey}`,
        });
      }
      await refreshGroups(tenantC);
      const detailAfter = await queriesDuring(() =>
        get(`/chatbot-requests/${id}`, 'cashier', tenantC),
      );
      expect(detailAfter).toBe(detailBefore);
    });
  });
});
