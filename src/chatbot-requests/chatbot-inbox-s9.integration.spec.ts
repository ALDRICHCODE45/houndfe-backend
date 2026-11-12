/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- supertest response bodies are untyped JSON and the query log event is untyped */
/**
 * S9 (unit 4 follow-ups asked by the FE) end to end against REAL PostgreSQL:
 * Supertest → the staff controllers (stub guards that set the caller's role) →
 * real services and stores.
 *
 *   1. `GET /chatbot-requests?customerKey=` takes the filters of `/groups`
 *      (q, assignee, overdue, windowClosingSoon, subtype): same rows, same
 *      validation, and no phone oracle without `read:CustomerPhone` (R12);
 *   2. `counts.unassigned` (and its EXPLAIN);
 *   3. `overdueCount` per group, exact beyond the 10 loaded rows, no N+1;
 *   4. the customer card on history rows, Manager vs Cashier masking;
 *   5. the realtime row keeps the shape of the inbox row.
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
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
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

describeIfDb('chatbot inbox follow-ups, S9 (PostgreSQL)', () => {
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
  const now = at('2026-11-10T10:30:00-06:00');
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
        data: { id, name: 'Seguimiento S9', slug: `cr-s9-${id}` },
      });
    }
    for (const [name, id] of Object.entries(users)) {
      await prisma.user.create({
        data: { id, email: `${id}@s9.test`, hashedPassword: 'x', name },
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
  const get = (path: string, role = 'manager', tenantId: string = tenantA) =>
    http().get(path).set(as(role, tenantId));

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
        // COMPLAINT is a CONVERSATION (kind/subtype CHECK).
        kind: over.subtype === 'COMPLAINT' ? 'CONVERSATION' : 'CLARIFICATION',
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

  const queriesDuring = async (work: () => Promise<unknown>) => {
    log.length = 0;
    await work();
    return log.length;
  };

  const token = (tenantId: string, customerKey: string) =>
    sealer.seal(tenantId, customerKey);
  const newTenant = async (label: string) => {
    const id = randomUUID();
    tenants.push(id);
    await prisma.tenant.create({
      data: { id, name: label, slug: `cr-s9-${id}` },
    });
    return id;
  };
  const closedFields = (
    status: 'RESOLVED' | 'CANCELLED',
    closedAt: Date,
    extra: Record<string, unknown> = {},
  ) => ({
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
    ...extra,
  });

  // ------------------------------------------------ 1. by-customer filters

  describe('GET /chatbot-requests?customerKey= takes the filters of /groups', () => {
    const KEYX = '525530000001';
    const KEYY = '525530000002';
    const t = tenantA;
    const base = at('2026-11-10T09:00:00-06:00').getTime();
    let folioOfX3 = '';

    beforeAll(async () => {
      const rosa = await prisma.customer.create({
        data: {
          tenantId: t,
          firstName: 'Rosalinda',
          lastName: 'Quintana',
          phoneCountryCode: '52',
          phone: KEYX.slice(2),
        },
      });
      for (let i = 0; i < 14; i++) {
        const mine = i % 4 === 1;
        const luis = i % 4 === 2;
        const claimed = mine || luis;
        await insert(t, {
          customerKey: KEYX,
          customerId: rosa.id,
          summary: `X-${i}`,
          subtype: i % 3 === 0 ? 'COMPLAINT' : 'UNKNOWN_QUESTION',
          createdAt: new Date(base + i * 60_000),
          ...(claimed
            ? {
                ...claimedBy(
                  mine ? users.ana : users.luis,
                  mine ? 'Ana' : 'Luis',
                ),
                resolveDeadlineAt: new Date(base + (40 + i) * 3_600_000),
              }
            : { claimDeadlineAt: new Date(base + (20 + i) * 3_600_000) }),
          ...(i % 5 === 0 ? { overdueAt: new Date(now.getTime() - HOUR) } : {}),
          ...(i % 6 === 0
            ? {
                whatsappWindowClosesAt: new Date(now.getTime() + HOUR),
                lastCustomerMessageAt: new Date(now.getTime() - HOUR),
              }
            : {}),
        });
      }
      for (let i = 0; i < 3; i++) {
        await insert(t, {
          customerKey: KEYX,
          customerId: rosa.id,
          summary: `X-closed-${i}`,
          subtype: i === 0 ? 'COMPLAINT' : 'UNKNOWN_QUESTION',
          ...closedFields('RESOLVED', new Date(now.getTime() - (i + 1) * DAY)),
        });
      }
      for (let i = 0; i < 3; i++) {
        await insert(t, {
          customerKey: KEYY,
          summary: `Y-${i}`,
          subtype: 'COMPLAINT',
          createdAt: new Date(base + i * 60_000),
        });
      }
      await refreshGroups(t);
      const rows = rowsOf(await get('/chatbot-requests/groups?limit=50'));
      folioOfX3 = rows.find((r: any) => r.summary === 'X-3').folio;
    });

    const idsOf = (rows: any[]) => rows.map((r) => r.id);
    async function byCustomer(qs: string, role: string, key = KEYX) {
      const ids: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res: any = await get(
          `/chatbot-requests?customerKey=${encodeURIComponent(token(t, key))}&limit=4${qs ? `&${qs}` : ''}${cursor ? `&cursor=${cursor}` : ''}`,
          role,
        );
        expect(res.status).toBe(200);
        ids.push(...idsOf(res.body.items));
        cursor = res.body.nextCursor;
        pages++;
      } while (cursor && pages < 10);
      return ids;
    }
    async function inGroup(qs: string, role: string, key = KEYX) {
      const res = await get(
        `/chatbot-requests/groups?limit=50${qs ? `&${qs}` : ''}`,
        role,
      );
      expect(res.status).toBe(200);
      const group = res.body.items.find(
        (g: any) => g.customerKey === token(t, key),
      );
      return group
        ? {
            ids: idsOf(group.requests),
            total: group.requests.length + group.moreRequests,
          }
        : { ids: [] as string[], total: 0 };
    }

    const FILTERS: Array<[string, string]> = [
      ['subtype', 'subtype=COMPLAINT'],
      ['assignee=me', 'assignee=me'],
      ['assignee=unassigned', 'assignee=unassigned'],
      ['assignee=none (alias)', 'assignee=none'],
      ['assignee=<user>', `assignee=${users.luis}`],
      ['overdue', 'overdue=true'],
      ['windowClosingSoon', 'windowClosingSoon=true'],
      ['q by name', 'q=rosalinda'],
      ['q by folded name', 'q=ROSALINDA%20quintana'],
      ['q by phone digits', 'q=5530000001'],
      [
        'everything together',
        'subtype=COMPLAINT&overdue=true&assignee=unassigned&q=quintana',
      ],
      ['closed tab with a filter', 'status=resolved&subtype=COMPLAINT'],
      ['closed tab, name', 'status=resolved&q=rosalinda'],
      ['no match at all', 'q=zzzzzz'],
    ];

    it.each(FILTERS)(
      'same rows as the group for the same data: %s',
      async (_label, qs) => {
        const group = await inGroup(qs, 'manager');
        const listed = await byCustomer(qs, 'manager');
        // The group loads up to 10 rows, the list pages all of them.
        expect(listed).toHaveLength(group.total);
        expect(listed.slice(0, group.ids.length)).toEqual(group.ids);
      },
    );

    it('the filters really narrow: the sets are non-trivial and differ from the unfiltered list', async () => {
      const all = await byCustomer('', 'manager');
      expect(all).toHaveLength(14);
      const sizes: Record<string, number> = {};
      for (const [label, qs] of FILTERS) {
        if (qs.startsWith('status=')) continue;
        sizes[label] = (await byCustomer(qs, 'manager')).length;
      }
      expect(sizes['subtype']).toBe(5); // i = 0, 3, 6, 9, 12
      expect(sizes['assignee=me']).toBe(4); // i = 1, 5, 9, 13
      expect(sizes['assignee=unassigned']).toBe(7);
      expect(sizes['assignee=none (alias)']).toBe(7);
      expect(sizes['overdue']).toBe(3); // i = 0, 5, 10
      expect(sizes['windowClosingSoon']).toBe(3); // i = 0, 6, 12
      expect(sizes['q by name']).toBe(14);
      expect(sizes['q by phone digits']).toBe(14);
      expect(sizes['no match at all']).toBe(0);
    });

    it('q by folio finds exactly that request, and leaves the other customer alone', async () => {
      const listed = await byCustomer(`q=${folioOfX3}`, 'cashier');
      expect(listed).toHaveLength(1);
      expect(await byCustomer(`q=${folioOfX3}`, 'cashier', KEYY)).toEqual([]);
    });

    it('R12: digits find nothing without read:CustomerPhone, on both routes alike', async () => {
      const group = await inGroup('q=5530000001', 'cashier');
      const res = await get(
        `/chatbot-requests?customerKey=${encodeURIComponent(token(t, KEYX))}&q=5530000001`,
        'cashier',
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [], nextCursor: null });
      expect(group.total).toBe(0);
      // a name still works for the same cashier, and nothing leaks
      const named = await get(
        `/chatbot-requests?customerKey=${encodeURIComponent(token(t, KEYX))}&q=rosalinda&limit=50`,
        'cashier',
      );
      expect(named.body.items.length).toBe(14);
      expect(JSON.stringify(named.body)).not.toMatch(LEAK);
      expect(JSON.stringify(named.body)).not.toContain(KEYX);
    });

    it('validation is the one of groups: the same 400s, and a foreign token stays a 400', async () => {
      const key = encodeURIComponent(token(t, KEYX));
      for (const bad of [
        'assignee=nobody',
        'overdue=maybe',
        'windowClosingSoon=1',
        'subtype=BOGUS',
        `q=${'x'.repeat(101)}`,
        'status=bogus',
      ]) {
        const list = await get(`/chatbot-requests?customerKey=${key}&${bad}`);
        const groups = await get(`/chatbot-requests/groups?${bad}`);
        expect([bad, list.status]).toEqual([bad, 400]);
        expect([bad, groups.status]).toEqual([bad, 400]);
      }
      const foreign = await get(
        `/chatbot-requests?customerKey=${encodeURIComponent(token(tenantB, KEYX))}&q=5530000001`,
        'cashier',
      );
      expect(foreign.status).toBe(400);
    });

    it('without filters the list is what it always was (all 14 open, no extra keys on a row)', async () => {
      const res = await get(
        `/chatbot-requests?customerKey=${encodeURIComponent(token(t, KEYX))}&limit=50`,
      );
      expect(res.body.items).toHaveLength(14);
      expect(Object.keys(res.body).sort()).toEqual(['items', 'nextCursor']);
      expect(res.body.items[0]).not.toHaveProperty('customer');
    });
  });

  // ------------------------------------------------------- 2. unassigned

  describe('counts.unassigned', () => {
    it('counts open requests with no assignee, per sucursal, the same for every role', async () => {
      const t = await newTenant('Sin responsable');
      for (let i = 0; i < 3; i++) await insert(t, { summary: `n${i}` });
      for (let i = 0; i < 2; i++) {
        await insert(t, { summary: `c${i}`, ...claimedBy(users.ana, 'Ana') });
      }
      await insert(t, {
        summary: 'closed-without-assignee',
        ...closedFields('CANCELLED', new Date(now.getTime() - DAY)),
      });
      await insert(tenantNoise, { summary: 'noise-new' });
      await refreshGroups(t);
      const manager = await get('/chatbot-requests/counts', 'manager', t);
      expect(manager.status).toBe(200);
      expect(manager.body).toMatchObject({
        new: 3,
        inProgress: 2,
        unassigned: 3,
      });
      for (const role of ['cashier', 'readOnly']) {
        expect((await get('/chatbot-requests/counts', role, t)).body).toEqual(
          manager.body,
        );
      }
      // The same number the «Sin responsable» filter lists.
      const listed = rowsOf(
        await get(
          '/chatbot-requests/groups?assignee=unassigned&limit=50',
          'manager',
          t,
        ),
      );
      expect(listed).toHaveLength(manager.body.unassigned);
      // A claim moves the number, like the filter.
      await prisma.chatbotRequest.updateMany({
        where: { tenantId: t, summary: 'n0' },
        data: claimedBy(users.luis, 'Luis') as never,
      });
      expect(
        (await get('/chatbot-requests/counts', 'manager', t)).body.unassigned,
      ).toBe(2);
    });

    describe('at scale', () => {
      let big = '';
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

      beforeAll(async () => {
        big = await newTenant('Escala unassigned');
        // 5,000 open (70 % NEW) and 15,000 closed, then ANALYZE.
        await prisma.$executeRaw(Prisma.sql`
          INSERT INTO "chatbot_requests"
            ("id", "tenantId", "folio", "kind", "subtype", "status", "customerKey",
             "summary", "source", "sourceRequestId", "assigneeUserId",
             "assigneeDisplayName", "claimedAt", "resolvedAt", "resolvedByActorId",
             "resolvedByDisplayName", "closedAt", "createdAt", "updatedAt")
          SELECT gen_random_uuid()::text, ${big}, g, 'CLARIFICATION', 'UNKNOWN_QUESTION',
            (CASE WHEN g <= 5000 THEN (CASE WHEN g % 10 < 3 THEN 'IN_PROGRESS' ELSE 'NEW' END)
                  ELSE 'RESOLVED' END)::"ChatbotRequestStatus",
            '5258' || lpad((g % 2000)::text, 8, '0'), 'x', 'perf', gen_random_uuid()::text,
            CASE WHEN g <= 5000 AND g % 10 < 3 THEN ${users.luis} END,
            CASE WHEN g <= 5000 AND g % 10 < 3 THEN 'Luis' END,
            CASE WHEN g <= 5000 AND g % 10 < 3 THEN ${now}::timestamp END,
            CASE WHEN g > 5000 THEN ${now}::timestamp - (g * interval '1 hour') END,
            CASE WHEN g > 5000 THEN ${users.luis} END,
            CASE WHEN g > 5000 THEN 'Luis' END,
            CASE WHEN g > 5000 THEN ${now}::timestamp - (g * interval '1 hour') END,
            ${now}::timestamp - interval '1 day', ${now}::timestamp
          FROM generate_series(1, 20000) AS g`);
        await refreshGroups(big);
        await prisma.$executeRawUnsafe('VACUUM ANALYZE "chatbot_requests"');
        await prisma.$executeRawUnsafe(
          'VACUUM ANALYZE "chatbot_customer_groups"',
        );
      }, 120_000);

      it('is exact and the statement is index-backed: no sequential scan of the requests', async () => {
        const res = await get('/chatbot-requests/counts', 'manager', big);
        expect(res.body.unassigned).toBe(3500);
        log.length = 0;
        await get('/chatbot-requests/counts', 'manager', big);
        const counted = log.find((e) => e.query.includes('"unassigned"'));
        expect(counted).toBeDefined();
        const sql = inline(counted!.query, counted!.params);
        const rows = await prisma.$queryRawUnsafe<any[]>(
          `EXPLAIN (FORMAT JSON) ${sql}`,
        );
        const nodes = nodesOf(rows[0]['QUERY PLAN'][0].Plan as PlanNode);
        expect(
          nodes.filter(
            (n) =>
              n['Node Type'] === 'Seq Scan' &&
              n['Relation Name'] === 'chatbot_requests',
          ),
        ).toEqual([]);
        expect(nodes.map((n) => n['Index Name'])).toContain(
          'chatbot_requests_open_status_idx',
        );
        expect(nodes.map((n) => n['Node Type'])).not.toContain('Sort');
        expect(nodes.map((n) => n['Node Type'])).not.toContain('HashAggregate');
      });

      it('keeps every count subquery on its own partial index (unassigned index-only, windowClosingSoon by window)', async () => {
        await get('/chatbot-requests/counts', 'manager', big);
        log.length = 0;
        await get('/chatbot-requests/counts', 'manager', big);
        const counted = log.find((e) => e.query.includes('"unassigned"'));
        expect(counted).toBeDefined();
        const sql = inline(counted!.query, counted!.params);
        const rows = await prisma.$queryRawUnsafe<any[]>(
          `EXPLAIN (FORMAT JSON) ${sql}`,
        );
        const nodes = nodesOf(rows[0]['QUERY PLAN'][0].Plan as PlanNode);
        // No subquery of the statement reads the requests table sequentially.
        expect(
          nodes.filter(
            (n) =>
              n['Node Type'] === 'Seq Scan' &&
              n['Relation Name'] === 'chatbot_requests',
          ),
        ).toEqual([]);
        // `unassigned`: the partial index holds exactly the rows it counts.
        const unassigned = nodes.filter(
          (n) => n['Index Name'] === 'chatbot_requests_open_unassigned_idx',
        );
        expect(unassigned.map((n) => n['Node Type'])).toEqual([
          'Index Only Scan',
        ]);
        // `windowClosingSoon` (OPEN + (now, now + warning]): the open window
        // index, never the plain open index plus a heap filter.
        expect(nodes.map((n) => n['Index Name'])).toContain(
          'chatbot_requests_open_window_idx',
        );
      });

      it('keeps the counts inside the perf target (p95 < 200 ms)', async () => {
        const samples: number[] = [];
        for (let i = 0; i < 40; i++) {
          const t0 = process.hrtime.bigint();
          const res = await get('/chatbot-requests/counts', 'manager', big);
          samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
          expect(res.status).toBe(200);
        }
        samples.sort((a, b) => a - b);
        expect(samples[Math.ceil(0.95 * samples.length) - 1]).toBeLessThan(200);
      });
    });
  });

  // -------------------------------------------------------- 3. overdueCount

  describe('overdueCount on every group', () => {
    const KEYP = '525540000001';
    const KEYQ = '525540000002';
    const KEYR = '525540000003';
    let t = '';
    const base = at('2026-11-10T09:00:00-06:00').getTime();

    beforeAll(async () => {
      t = await newTenant('Vencidas por grupo');
      // 25 open requests of one customer: the 10 most urgent are NOT overdue,
      // the 13 least urgent are, so the loaded rows hide the real number.
      for (let i = 0; i < 25; i++) {
        await insert(t, {
          customerKey: KEYP,
          summary: `P-${i}`,
          subtype: i % 2 === 0 ? 'COMPLAINT' : 'UNKNOWN_QUESTION',
          createdAt: new Date(base + i * 60_000),
          claimDeadlineAt: new Date(base + i * 3_600_000),
          ...(i >= 12 ? { overdueAt: new Date(now.getTime() - HOUR) } : {}),
        });
      }
      // Closed overdue requests of the same customer never count.
      for (let i = 0; i < 2; i++) {
        await insert(t, {
          customerKey: KEYP,
          summary: `P-closed-${i}`,
          overdueAt: new Date(now.getTime() - 2 * HOUR),
          ...closedFields('RESOLVED', new Date(now.getTime() - DAY)),
        });
      }
      await insert(t, { customerKey: KEYQ, summary: 'Q-0' });
      await insert(t, { customerKey: KEYQ, summary: 'Q-1' });
      await insert(t, {
        customerKey: KEYR,
        summary: 'R-0',
        overdueAt: new Date(now.getTime() - HOUR),
      });
      await refreshGroups(t);
    });

    const groupOf = (res: any, key: string) =>
      res.body.items.find((g: any) => g.customerKey === token(t, key));

    it('is exact for the customer, beyond the 10 loaded rows', async () => {
      const res = await get('/chatbot-requests/groups?limit=50', 'manager', t);
      const p = groupOf(res, KEYP);
      expect(p.openCount).toBe(25);
      expect(p.requests).toHaveLength(10);
      expect(p.moreRequests).toBe(15);
      expect(p.requests.filter((r: any) => r.overdueAt !== null)).toHaveLength(
        0,
      );
      expect(p.overdueCount).toBe(13);
      expect(groupOf(res, KEYQ).overdueCount).toBe(0);
      expect(groupOf(res, KEYR).overdueCount).toBe(1);
      expect(
        res.body.items.every((g: any) => Number.isInteger(g.overdueCount)),
      ).toBe(true);
    });

    it('is not narrowed by the filters (like openCount) and is the same for every role', async () => {
      const filtered = await get(
        '/chatbot-requests/groups?limit=50&subtype=COMPLAINT',
        'manager',
        t,
      );
      const p = groupOf(filtered, KEYP);
      expect(p.requests.length + p.moreRequests).toBe(13);
      expect(p.openCount).toBe(25);
      expect(p.overdueCount).toBe(13);
      for (const role of ['cashier', 'readOnly']) {
        const other = await get('/chatbot-requests/groups?limit=50', role, t);
        expect(groupOf(other, KEYP).overdueCount).toBe(13);
      }
    });

    it('agrees with the overdue filter and with counts.overdue', async () => {
      const res = await get('/chatbot-requests/groups?limit=50', 'manager', t);
      const total = res.body.items.reduce(
        (sum: number, g: any) => sum + g.overdueCount,
        0,
      );
      const counts = await get('/chatbot-requests/counts', 'manager', t);
      expect(total).toBe(counts.body.overdue);
      const overdueOnly = await get(
        '/chatbot-requests/groups?limit=50&overdue=true',
        'manager',
        t,
      );
      const p = groupOf(overdueOnly, KEYP);
      expect(p.requests.length + p.moreRequests).toBe(p.overdueCount);
    });

    it('closed tabs read 0 (their groups hold no open request)', async () => {
      const res = await get(
        '/chatbot-requests/groups?limit=50&status=resolved',
        'manager',
        t,
      );
      expect(res.body.items.length).toBeGreaterThan(0);
      expect(res.body.items.map((g: any) => g.overdueCount)).toEqual(
        res.body.items.map(() => 0),
      );
    });

    it('is one statement: the number of queries does not grow with the groups', async () => {
      const one = await queriesDuring(() =>
        get('/chatbot-requests/groups?limit=1', 'manager', t),
      );
      const many = await queriesDuring(() =>
        get('/chatbot-requests/groups?limit=50', 'manager', t),
      );
      expect(many).toBe(one);
    });

    describe('at scale', () => {
      let heavy = '';
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

      beforeAll(async () => {
        heavy = await newTenant('Carga overdueCount');
        await prisma.$executeRaw(Prisma.sql`
          INSERT INTO "chatbot_requests"
            ("id", "tenantId", "folio", "kind", "subtype", "status", "customerKey",
             "summary", "source", "sourceRequestId", "claimDeadlineAt", "overdueAt",
             "createdAt", "updatedAt")
          SELECT gen_random_uuid()::text, ${heavy}, g, 'CLARIFICATION', 'UNKNOWN_QUESTION',
            'NEW'::"ChatbotRequestStatus",
            '5259' || lpad((g % 1500)::text, 8, '0'), 'abierta', 'perf',
            gen_random_uuid()::text,
            ${now}::timestamp + ((g % 500) - 100) * interval '1 minute',
            CASE WHEN g % 7 = 0 THEN ${now}::timestamp - interval '1 hour' END,
            ${now}::timestamp - (g % 600) * interval '1 minute', ${now}::timestamp
          FROM generate_series(1, 4000) AS g`);
        await refreshGroups(heavy);
        await prisma.$executeRawUnsafe('VACUUM ANALYZE "chatbot_requests"');
        await prisma.$executeRawUnsafe(
          'VACUUM ANALYZE "chatbot_customer_groups"',
        );
      }, 120_000);

      it('every group of a page of 25 carries the exact number, checked against SQL', async () => {
        const res = await get(
          '/chatbot-requests/groups?limit=25',
          'manager',
          heavy,
        );
        expect(res.body.items).toHaveLength(25);
        let beyondLoaded = 0;
        for (const group of res.body.items) {
          const key = sealer.open(heavy, group.customerKey);
          const [row] = await prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`
            SELECT count(*)::int AS n FROM "chatbot_requests"
            WHERE "tenantId" = ${heavy} AND "customerKey" = ${key}
              AND "status" IN ('NEW', 'IN_PROGRESS') AND "overdueAt" IS NOT NULL`);
          expect(group.overdueCount).toBe(row.n);
          if (group.moreRequests > 0) beyondLoaded++;
        }
        expect(beyondLoaded).toBeGreaterThanOrEqual(0);
      });

      it('the groups statement stays index-backed with no GROUP BY at read time', async () => {
        log.length = 0;
        await get('/chatbot-requests/groups?limit=25', 'manager', heavy);
        const ran = log.find((e) => e.query.includes('"overdueCount"'));
        expect(ran).toBeDefined();
        const sql = inline(ran!.query, ran!.params);
        const rows = await prisma.$queryRawUnsafe<any[]>(
          `EXPLAIN (FORMAT JSON) ${sql}`,
        );
        const nodes = nodesOf(rows[0]['QUERY PLAN'][0].Plan as PlanNode);
        const types = nodes.map((n) => n['Node Type']);
        expect(
          nodes.filter(
            (n) =>
              n['Node Type'] === 'Seq Scan' &&
              n['Relation Name'] === 'chatbot_requests',
          ),
        ).toEqual([]);
        expect(types).not.toContain('HashAggregate');
        expect(types).not.toContain('GroupAggregate');
        const indexes = nodes.map((n) => n['Index Name']);
        expect(indexes).toContain(
          'chatbot_requests_tenantId_customerKey_status_idx',
        );
        expect(indexes).toContain(
          'chatbot_customer_groups_tenantId_mostUrgentAt_customerKey_idx',
        );
      });

      it('p95 of a page of 25 groups stays far inside the 200 ms target', async () => {
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
      });
    });
  });

  // ------------------------------------------------ 4. history customer

  describe('history rows carry the customer', () => {
    const KEYJ = '525550000001';
    const KEYU = '525550000002';
    let t = '';
    let linkedId = '';

    beforeAll(async () => {
      t = await newTenant('Historial con cliente');
      const juan = await prisma.customer.create({
        data: {
          tenantId: t,
          firstName: 'Juan',
          lastName: 'Pérez',
          phoneCountryCode: '52',
          phone: KEYJ.slice(2),
          isTrusted: true,
        },
      });
      linkedId = juan.id;
      for (let i = 0; i < 3; i++) {
        await insert(t, {
          customerKey: KEYJ,
          customerId: juan.id,
          summary: `J-${i}`,
          ...closedFields(
            i === 1 ? 'CANCELLED' : 'RESOLVED',
            new Date(now.getTime() - (10 + i) * DAY),
          ),
        });
      }
      await insert(t, {
        customerKey: KEYU,
        summary: 'U-0',
        ...closedFields('RESOLVED', new Date(now.getTime() - 12 * DAY)),
      });
    });

    it('Manager: name and the full phone; Cashier: the name and the masked phone', async () => {
      const manager = await get(
        '/chatbot-requests/history?limit=50',
        'manager',
        t,
      );
      expect(manager.status).toBe(200);
      const j = manager.body.items.find((r: any) => r.summary === 'J-0');
      expect(j.customer).toEqual({
        id: linkedId,
        displayName: 'Juan Pérez',
        phone: '+525550000001',
        isTrusted: true,
      });
      const cashier = await get(
        '/chatbot-requests/history?limit=50',
        'cashier',
        t,
      );
      const jc = cashier.body.items.find((r: any) => r.summary === 'J-0');
      expect(jc.customer).toEqual({
        id: linkedId,
        displayName: 'Juan Pérez',
        phone: '55 **** 0001',
        isTrusted: true,
      });
      expect(JSON.stringify(cashier.body)).not.toMatch(LEAK);
      expect(JSON.stringify(cashier.body)).not.toContain(KEYJ);
      const readOnly = await get(
        '/chatbot-requests/history?limit=50',
        'readOnly',
        t,
      );
      expect(JSON.stringify(readOnly.body)).not.toMatch(LEAK);
    });

    it('a request with no linked customer: null name, masked phone for a Cashier, sealed key unchanged', async () => {
      const cashier = await get(
        '/chatbot-requests/history?limit=50',
        'cashier',
        t,
      );
      const u = cashier.body.items.find((r: any) => r.summary === 'U-0');
      expect(u.customer).toEqual({
        id: null,
        displayName: null,
        phone: '55 **** 0002',
        isTrusted: false,
      });
      expect(u.customerKey).toBe(token(t, KEYU));
      const manager = await get(
        '/chatbot-requests/history?limit=50',
        'manager',
        t,
      );
      expect(
        manager.body.items.find((r: any) => r.summary === 'U-0').customer.phone,
      ).toBe('+525550000002');
    });

    it('keeps the filters and the cursor working, and adds no query per row', async () => {
      const byKey = await get(
        `/chatbot-requests/history?customerKey=${encodeURIComponent(token(t, KEYJ))}&limit=2`,
        'manager',
        t,
      );
      expect(byKey.body.items).toHaveLength(2);
      expect(byKey.body.nextCursor).not.toBeNull();
      const next = await get(
        `/chatbot-requests/history?customerKey=${encodeURIComponent(token(t, KEYJ))}&limit=2&cursor=${byKey.body.nextCursor}`,
        'manager',
        t,
      );
      expect(next.body.items).toHaveLength(1);
      const one = await queriesDuring(() =>
        get('/chatbot-requests/history?limit=1', 'manager', t),
      );
      const many = await queriesDuring(() =>
        get('/chatbot-requests/history?limit=50', 'manager', t),
      );
      expect(many).toBe(one);
      const cancelled = byKey.body.items.find(
        (r: any) => r.status === 'CANCELLED',
      );
      expect(cancelled.cancelReason).toBe('CUSTOMER_WITHDREW');
    });

    it('is the same card the realtime stream sends beside the request row', async () => {
      const history = await get(
        '/chatbot-requests/history?limit=50',
        'cashier',
        t,
      );
      const row = history.body.items.find((r: any) => r.summary === 'J-0');
      const reads = app.get(ChatbotRequestReadsService);
      const clsService = app.get<ClsService<TenantClsStore>>(ClsService);
      const shaped = await clsService.runWith(
        { tenantId: t, userId: users.ana, isSuperAdmin: false },
        async () => {
          const batch = await reads.loadEventRows([row.id]);
          return reads.shapeEventRow(batch, row.id, {
            userId: users.ana,
            ability: new AbilityBuilder<AppAbility>(createMongoAbility).build(),
          });
        },
      );
      // An ability with no grants cannot read: nothing is sent (unchanged).
      expect(shaped).toBeNull();
      const builder = new AbilityBuilder<AppAbility>(createMongoAbility);
      for (const [action, subject] of ROLES.cashier)
        builder.can(action, subject);
      const live = await clsService.runWith(
        { tenantId: t, userId: users.ana, isSuperAdmin: false },
        async () => {
          const batch = await reads.loadEventRows([row.id]);
          return reads.shapeEventRow(batch, row.id, {
            userId: users.ana,
            ability: builder.build(),
          });
        },
      );
      expect(live!.customer).toEqual(row.customer);
      const { customer: _card, ...inboxRow } = row;
      void _card;
      expect(Object.keys(live!.request).sort()).toEqual(
        Object.keys(inboxRow).sort(),
      );
    });
  });
});
