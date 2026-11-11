/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- supertest response bodies are untyped JSON */
/**
 * human-intervention / unit 4 — the staff reads end to end against REAL
 * PostgreSQL: Supertest → the two staff controllers (stub guards that set the
 * caller's role) → real services and stores. Covers group ordering and
 * pagination, filters, counts, tenant isolation, the 7-day boundary between
 * inbox and history, `allowedActions` per role, the detail, and R12: a walk of
 * EVERY route of the staff controllers that fails if a full phone leaks
 * without `read:CustomerPhone` (contract §3.8, §10.1 R12).
 */
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  Injectable,
  RequestMethod,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
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
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
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
} from './application/chatbot-request-reads.service';
import { CustomerKeySealer } from './domain/customer-key-sealer';
import {
  allocateFolio,
  refreshCustomerGroup,
} from './infrastructure/chatbot-request-writes';
import { PrismaChatbotRequestCommandStore } from './infrastructure/prisma-chatbot-request-command.store';
import { PrismaChatbotRequestReadStore } from './infrastructure/prisma-chatbot-request-read.store';
import { ChatbotRequestCommandsController } from './presentation/chatbot-request-commands.controller';
import { ChatbotRequestHttpFilter } from './presentation/chatbot-request-http.filter';
import { ChatbotRequestReadsController } from './presentation/chatbot-request-reads.controller';

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
/** Owner decision L2: Manager gets everything new; Cashier only ver y atender. */
const ROLES: Record<string, Grant[]> = {
  manager: [
    ...READ_UPDATE,
    ['update', 'ChatbotRequestAssignment'],
    ['read', 'ChatbotConversation'],
    ['read', 'CustomerPhone'],
    ...LEGACY,
  ],
  managerNoPhone: [
    ...READ_UPDATE,
    ['update', 'ChatbotRequestAssignment'],
    ['read', 'ChatbotConversation'],
    ...LEGACY,
  ],
  cashier: [...READ_UPDATE, ['read', 'ChatbotConversation']],
  updateOnly: READ_UPDATE,
  readOnly: [['read', 'ChatbotRequest']],
};

/** Reads the caller from headers: the real guards are covered by their own specs. */
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

/** Enforces the route's @RequirePermissions against the stubbed ability. */
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
const NOW = new Date('2026-11-11T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PHONE = { phoneCountryCode: '52', phone: '5512345678' };
const KEY = '525512345678';
/** A full number as 10 digits or E.164, with or without `+`, not inside an id. */
const LEAK = /(?<![0-9A-Za-z-])\+?\d{10,15}(?![0-9A-Za-z-])/;

describeIfDb('chatbot request staff reads (PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const sealer = new CustomerKeySealer(SECRET);
  let app: INestApplication;
  let tenantPrisma: TenantPrismaService;
  let cls: ClsService<TenantClsStore>;
  const tenantA: string = randomUUID();
  const tenantB: string = randomUUID();
  const users = { ana: randomUUID(), luis: randomUUID() };
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
      ],
      providers: [
        ChatbotRequestHttpFilter,
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
        { provide: INBOX_CLOCK, useValue: () => NOW },
        // The wrapped use cases have their own specs; here resolve only closes.
        {
          provide: CHATBOT_REQUEST_RESOLVER,
          useValue: { resolve: () => Promise.resolve() },
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
    tenantPrisma = moduleRef.get(TenantPrismaService);
    cls = moduleRef.get<ClsService<TenantClsStore>>(ClsService);
    for (const id of [tenantA, tenantB]) {
      await prisma.tenant.create({
        data: { id, name: 'Lecturas', slug: `cr-reads-${id}` },
      });
    }
    for (const [name, id] of Object.entries(users)) {
      await prisma.user.create({
        data: { id, email: `${id}@reads.test`, hashedPassword: 'x', name },
      });
    }
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await prisma.tenant.deleteMany({
      where: { id: { in: [tenantA, tenantB] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: Object.values(users) } },
    });
  });

  // -------------------------------------------------------------- helpers

  const as = (
    role: string,
    tenantId: string = tenantA,
    userId: string = users.ana,
  ) => ({
    'x-test-role': role,
    'x-test-tenant': tenantId,
    'x-test-user': userId,
  });
  const get = (
    path: string,
    role = 'manager',
    tenantId: string = tenantA,
    userId: string = users.ana,
  ) =>
    request(app.getHttpServer() as Parameters<typeof request>[0])
      .get(path)
      .set(as(role, tenantId, userId));
  const post = (path: string, body: object, role = 'manager') =>
    request(app.getHttpServer() as Parameters<typeof request>[0])
      .post(path)
      .set(as(role))
      .set('Idempotency-Key', randomUUID())
      .send(body);
  const token = (customerKey: string, tenantId: string = tenantA) =>
    sealer.seal(tenantId, customerKey);

  /** Creates a request the way intake will: folio and group in one tx. */
  async function create(
    over: Record<string, unknown> = {},
    tenantId: string = tenantA,
  ): Promise<{ id: string; customerKey: string }> {
    const customerKey =
      (over.customerKey as string) ??
      `52551000${String(++seq).padStart(4, '0')}`;
    const row = await cls.runWith(
      { tenantId, userId: 'test', isSuperAdmin: false },
      () =>
        tenantPrisma.runInTransaction(async () => {
          const tx = tenantPrisma.getClient();
          const created = await tx.chatbotRequest.create({
            data: {
              tenantId,
              folio: await allocateFolio(tx, tenantId),
              kind: 'CLARIFICATION',
              subtype: 'UNKNOWN_QUESTION',
              summary: `Pregunta ${seq}`,
              source: 'chatbot',
              sourceRequestId: randomUUID(),
              ...over,
              customerKey,
            } as never,
          });
          await refreshCustomerGroup(tx, tenantId, customerKey);
          return created;
        }),
    );
    return { id: row.id, customerKey };
  }

  const closed = (status: 'RESOLVED' | 'CANCELLED', at: Date) =>
    status === 'RESOLVED'
      ? {
          status,
          resolvedAt: at,
          closedAt: at,
          resolvedByActorId: users.luis,
          resolvedByDisplayName: 'Luis',
        }
      : {
          status,
          cancelledAt: at,
          closedAt: at,
          cancelReason: 'CUSTOMER_WITHDREW',
        };

  const summaries = (rows: Array<{ summary: string }>) =>
    rows.map((r) => r.summary);

  async function restockRequest(over: Record<string, unknown> = {}) {
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
    return create({
      kind: 'DECISION',
      subtype: 'RESTOCK',
      humanDecisionId: decision.id,
      ...over,
    });
  }

  // ---------------------------------------------------------------- groups

  describe('GET /chatbot-requests/groups', () => {
    it('orders groups by the nearest deadline (NULL last), pages with an opaque cursor and never duplicates', async () => {
      const t = await prisma.tenant.create({
        data: {
          id: randomUUID(),
          name: 'Orden',
          slug: `cr-order-${randomUUID()}`,
        },
      });
      const tenant = t.id;
      const at = (hours: number | null) =>
        hours === null
          ? {}
          : { claimDeadlineAt: new Date(NOW.getTime() + hours * HOUR) };
      const seed = [
        ['null-b', null],
        ['soon', 1],
        ['late', 5],
        ['overdue', -2],
        ['null-a', null],
      ] as const;
      for (const [name, hours] of seed) {
        await create(
          {
            summary: name,
            ...at(hours),
            ...(name === 'overdue' ? { overdueAt: NOW } : {}),
          },
          tenant,
        );
      }
      const first = await get(
        '/chatbot-requests/groups?limit=2',
        'manager',
        tenant,
      );
      expect(first.status).toBe(200);
      expect(first.headers['cache-control']).toBe('no-store');
      const names = (body: any) =>
        body.items.map((g: any) => g.requests[0].summary);
      expect(names(first.body)).toEqual(['overdue', 'soon']);
      expect(first.body.items[0].requests[0].displayStatus).toBe('EXPIRED');
      expect(first.body.nextCursor).toEqual(expect.any(String));
      expect(
        Buffer.from(first.body.nextCursor, 'base64url').toString(),
      ).not.toMatch(LEAK);

      const second = await get(
        `/chatbot-requests/groups?limit=2&cursor=${first.body.nextCursor}`,
        'manager',
        tenant,
      );
      expect(names(second.body)).toEqual([
        'late',
        expect.stringMatching(/^null-/),
      ]);
      const third = await get(
        `/chatbot-requests/groups?limit=2&cursor=${second.body.nextCursor}`,
        'manager',
        tenant,
      );
      expect(third.body.items).toHaveLength(1);
      expect(third.body.nextCursor).toBeNull();
      const all = [
        ...names(first.body),
        ...names(second.body),
        ...names(third.body),
      ];
      expect(new Set(all).size).toBe(5);
      await prisma.tenant.delete({ where: { id: tenant } });
    });

    it('carries up to 10 rows and moreRequests; the per-customer list pages the rest', async () => {
      const key = '525599990001';
      for (let i = 0; i < 12; i++)
        await create({
          customerKey: key,
          summary: `many-${String(i).padStart(2, '0')}`,
        });
      const res = await get('/chatbot-requests/groups?limit=50');
      const group = res.body.items.find((g: any) =>
        g.requests[0].summary.startsWith('many-'),
      );
      expect(group.requests).toHaveLength(10);
      expect(group.moreRequests).toBe(2);
      expect(group.openCount).toBe(12);
      expect(group.customerKey).toBe(token(key));

      const page1 = await get(
        `/chatbot-requests?customerKey=${group.customerKey}&limit=5`,
      );
      const page2 = await get(
        `/chatbot-requests?customerKey=${group.customerKey}&limit=5&cursor=${page1.body.nextCursor}`,
      );
      const page3 = await get(
        `/chatbot-requests?customerKey=${group.customerKey}&limit=5&cursor=${page2.body.nextCursor}`,
      );
      const all = [page1, page2, page3].flatMap((p) => summaries(p.body.items));
      expect(all).toHaveLength(12);
      expect(new Set(all).size).toBe(12);
      expect(page3.body.nextCursor).toBeNull();
    });

    it('filters by subtype, assignee, overdue, scheduled and window', async () => {
      const t = randomUUID();
      await prisma.tenant.create({
        data: { id: t, name: 'Filtros', slug: `cr-filter-${t}` },
      });
      const claimed = await create(
        {
          summary: 'mine',
          status: 'IN_PROGRESS',
          assigneeUserId: users.ana,
          assigneeDisplayName: 'Ana',
          claimedAt: NOW,
        },
        t,
      );
      await create(
        {
          summary: 'theirs',
          status: 'IN_PROGRESS',
          assigneeUserId: users.luis,
          assigneeDisplayName: 'Luis',
          claimedAt: NOW,
        },
        t,
      );
      await create({ summary: 'free', overdueAt: NOW }, t);
      await create(
        {
          summary: 'talk',
          kind: 'CONVERSATION',
          subtype: 'TALK_TO_HUMAN',
          scheduledFor: new Date(NOW.getTime() + DAY),
          lastCustomerMessageAt: new Date(NOW.getTime() - 23 * HOUR),
          whatsappWindowClosesAt: new Date(NOW.getTime() + HOUR),
        },
        t,
      );
      const names = async (query: string) =>
        (
          await get(`/chatbot-requests/groups?${query}`, 'manager', t)
        ).body.items
          .flatMap((g: any) => summaries(g.requests))
          .sort();
      expect(await names('assignee=me')).toEqual(['mine']);
      expect(await names('assignee=unassigned')).toEqual(['free', 'talk']);
      expect(await names(`assignee=${users.luis}`)).toEqual(['theirs']);
      expect(await names('overdue=true')).toEqual(['free']);
      expect(await names('subtype=TALK_TO_HUMAN')).toEqual(['talk']);
      expect(await names('status=scheduled')).toEqual(['talk']);
      expect(await names('windowClosingSoon=true')).toEqual(['talk']);
      expect(await names('')).toEqual(['free', 'mine', 'talk', 'theirs']);
      expect(
        (await get('/chatbot-requests/groups?status=bogus', 'manager', t))
          .status,
      ).toBe(400);
      expect(
        (await get('/chatbot-requests/groups?q=juan', 'manager', t)).status,
      ).toBe(400);

      const counts = await get('/chatbot-requests/counts', 'manager', t);
      expect(counts.body).toEqual({
        new: 2,
        inProgress: 2,
        mine: 1,
        overdue: 1,
        windowClosingSoon: 1,
        scheduled: 1,
        needsReschedule: 0,
      });
      expect(claimed.id).toBeDefined();
      await prisma.tenant.delete({ where: { id: t } });
    });

    it('never leaks another tenant, and a foreign customerKey token is a 400', async () => {
      const other = await create({ summary: 'tenant-b-only' }, tenantB);
      const own = await create({ summary: 'tenant-a-only' });
      const seenByB = await get(
        '/chatbot-requests/groups?limit=50',
        'manager',
        tenantB,
      );
      expect(
        seenByB.body.items.flatMap((g: any) => summaries(g.requests)),
      ).toEqual(['tenant-b-only']);
      expect(
        (await get(`/chatbot-requests/${own.id}`, 'manager', tenantB)).status,
      ).toBe(404);
      expect(
        (await get(`/chatbot-requests/${own.id}/audit`, 'manager', tenantB))
          .status,
      ).toBe(404);
      expect(
        (
          await get(
            `/chatbot-requests?customerKey=${token(own.customerKey)}`,
            'manager',
            tenantB,
          )
        ).status,
      ).toBe(400);
      expect((await get('/chatbot-requests')).status).toBe(400);
      expect(
        (await get(`/chatbot-requests/${other.id}/merge-candidates`)).status,
      ).toBe(404);
    });
  });

  // ------------------------------------------------- inbox vs history, 7 days

  it('splits closed requests at exactly 7 days: inbox keeps >=, history takes <', async () => {
    const t = randomUUID();
    await prisma.tenant.create({
      data: { id: t, name: 'Ventana', slug: `cr-window-${t}` },
    });
    const edge = new Date(NOW.getTime() - 7 * DAY);
    await create({ summary: 'on-edge', ...closed('RESOLVED', edge) }, t);
    await create(
      {
        summary: 'just-older',
        ...closed('RESOLVED', new Date(edge.getTime() - 1)),
      },
      t,
    );
    await create(
      {
        summary: 'cancelled-recent',
        ...closed('CANCELLED', new Date(NOW.getTime() - DAY)),
      },
      t,
    );
    await create(
      {
        summary: 'old-cancelled',
        ...closed('CANCELLED', new Date(NOW.getTime() - 30 * DAY)),
      },
      t,
    );
    const inboxResolved = await get(
      '/chatbot-requests/groups?status=resolved',
      'manager',
      t,
    );
    const inboxCancelled = await get(
      '/chatbot-requests/groups?status=cancelled',
      'manager',
      t,
    );
    const flat = (res: any) =>
      res.body.items.flatMap((g: any) => summaries(g.requests));
    expect(flat(inboxResolved)).toEqual(['on-edge']);
    expect(flat(inboxCancelled)).toEqual(['cancelled-recent']);
    const history = await get('/chatbot-requests/history', 'manager', t);
    expect(summaries(history.body.items)).toEqual([
      'just-older',
      'old-cancelled',
    ]);
    expect(history.body.items[0].closedAt).toBe(
      new Date(edge.getTime() - 1).toISOString(),
    );

    const paged = await get('/chatbot-requests/history?limit=1', 'manager', t);
    expect(summaries(paged.body.items)).toEqual(['just-older']);
    const next = await get(
      `/chatbot-requests/history?limit=1&cursor=${paged.body.nextCursor}`,
      'manager',
      t,
    );
    expect(summaries(next.body.items)).toEqual(['old-cancelled']);
    expect(next.body.nextCursor).toBeNull();

    const byActor = await get(
      `/chatbot-requests/history?resolvedBy=${users.luis}`,
      'manager',
      t,
    );
    expect(summaries(byActor.body.items)).toEqual(['just-older']);
    const inRange = await get(
      `/chatbot-requests/history?from=${new Date(NOW.getTime() - 40 * DAY).toISOString()}&to=${new Date(NOW.getTime() - 20 * DAY).toISOString()}`,
      'manager',
      t,
    );
    expect(summaries(inRange.body.items)).toEqual(['old-cancelled']);
    const tooWide = await get(
      `/chatbot-requests/history?from=${new Date(NOW.getTime() - 200 * DAY).toISOString()}&to=${NOW.toISOString()}`,
      'manager',
      t,
    );
    expect(tooWide.status).toBe(400);
    expect(tooWide.body.code).toBe('RANGE_TOO_LARGE');
    expect(
      (
        await get(
          `/chatbot-requests/history?from=${NOW.toISOString()}`,
          'manager',
          t,
        )
      ).status,
    ).toBe(400);
    await prisma.tenant.delete({ where: { id: t } });
  });

  // ------------------------------------------------------- detail and actions

  describe('GET /chatbot-requests/:id', () => {
    it('shows allowedActions per role from the state machine and the legacy permission', async () => {
      const { id } = await restockRequest();
      const actions = async (role: string) =>
        (await get(`/chatbot-requests/${id}`, role)).body.allowedActions;
      expect(await actions('manager')).toEqual(['CLAIM', 'RESOLVE']);
      expect(await actions('cashier')).toEqual(['CLAIM']);
      expect(await actions('updateOnly')).toEqual(['CLAIM']);
      expect(await actions('readOnly')).toEqual([]);

      const claimed = await post(
        `/chatbot-requests/${id}/claim`,
        { expectedVersion: 1 },
        'cashier',
      );
      expect(claimed.status).toBe(200);
      const mine = await get(`/chatbot-requests/${id}`, 'manager');
      expect(mine.body.allowedActions).toEqual([
        'RELEASE',
        'REASSIGN',
        'RESOLVE',
      ]);
      expect(mine.body.assignee.displayName).toBeTruthy();
      expect(mine.body.audit.map((e: any) => e.type)).toEqual(['CLAIMED']);
      expect(mine.body.audit[0].actor.kind).toBe('USER');
      const other = await get(
        `/chatbot-requests/${id}`,
        'cashier',
        tenantA,
        users.luis,
      );
      expect(other.body.allowedActions).toEqual([]);
      const reassigner = await get(
        `/chatbot-requests/${id}`,
        'manager',
        tenantA,
        users.luis,
      );
      expect(reassigner.body.allowedActions).toEqual(['RELEASE', 'REASSIGN']);
    });

    it('builds the customer card, decision, other open requests, deliveries and audit', async () => {
      const customer = await prisma.customer.create({
        data: {
          tenantId: tenantA,
          firstName: 'Juan',
          lastName: 'Pérez',
          ...PHONE,
          isTrusted: true,
        },
      });
      await prisma.sale.create({
        data: {
          tenantId: tenantA,
          userId: users.ana,
          customerId: customer.id,
          status: 'CONFIRMED',
          totalCents: 12_300,
          folio: 'V-1',
        },
      });
      await prisma.sale.create({
        data: {
          tenantId: tenantA,
          userId: users.ana,
          customerId: customer.id,
          status: 'DRAFT',
          totalCents: 1,
        },
      });
      const main = await restockRequest({
        customerKey: KEY,
        customerId: customer.id,
        ...PHONE,
      });
      const sibling = await create({
        customerKey: KEY,
        summary: 'sibling',
        customerId: customer.id,
        ...PHONE,
      });
      await prisma.chatbotFeedItem.create({
        data: {
          tenantId: tenantA,
          requestId: main.id,
          type: 'request.answered',
          payload: { text: 'x' },
        },
      });

      const manager = await get(`/chatbot-requests/${main.id}`);
      expect(manager.status).toBe(200);
      expect(manager.body.customer).toMatchObject({
        id: customer.id,
        displayName: 'Juan Pérez',
        phone: '+525512345678',
        isTrusted: true,
        priceList: null,
      });
      expect(manager.body.customer.recentOrders).toEqual([
        expect.objectContaining({
          folio: 'V-1',
          totalCents: 12_300,
          status: 'CONFIRMED',
        }),
      ]);
      expect(manager.body.customerKey).toBe(token(KEY));
      expect(manager.body.decision).toMatchObject({
        subtype: 'RESTOCK',
        resolution: null,
        snapshot: { productName: 'Croquetas 20 kg', requestedQuantity: 3 },
      });
      expect(manager.body.otherOpenRequests.map((r: any) => r.id)).toEqual([
        sibling.id,
      ]);
      expect(manager.body.deliveries).toEqual([
        expect.objectContaining({
          type: 'request.answered',
          outcome: 'PENDING',
          needsReconciliation: false,
        }),
      ]);
      expect(manager.body.auditNextCursor).toBeNull();
      expect(manager.body.liveSession).toBeNull();

      const cashier = await get(`/chatbot-requests/${main.id}`, 'cashier');
      expect(cashier.body.customer.phone).toBe('55 **** 5678');
      expect(cashier.body.customer.displayName).toBe('Juan Pérez');
    });

    it('pages a long audit trail and lists merge candidates only for mergeable subtypes', async () => {
      const { id, customerKey } = await create({});
      const twin = await create({ customerKey });
      for (let i = 0; i < 22; i++) {
        await prisma.chatbotRequestEvent.create({
          data: {
            tenantId: tenantA,
            requestId: id,
            type: 'SLA_MILESTONE',
            actorKind: 'SYSTEM',
            version: 1 + i,
            data: { milestone: 'HALF' },
            createdAt: new Date(NOW.getTime() + i * 1000),
          },
        });
      }
      const detail = await get(`/chatbot-requests/${id}`);
      expect(detail.body.audit).toHaveLength(20);
      expect(detail.body.audit[0].actor).toEqual({
        kind: 'SYSTEM',
        id: null,
        displayName: null,
      });
      const rest = await get(
        `/chatbot-requests/${id}/audit?cursor=${detail.body.auditNextCursor}`,
      );
      expect(rest.body.items).toHaveLength(2);
      expect(rest.body.nextCursor).toBeNull();

      const candidates = await get(`/chatbot-requests/${id}/merge-candidates`);
      expect(candidates.body.items.map((r: any) => r.id)).toEqual([twin.id]);
      expect(
        (await get(`/chatbot-requests/${id}/merge-candidates`, 'readOnly'))
          .status,
      ).toBe(403);
      const decision = await restockRequest();
      expect(
        (await get(`/chatbot-requests/${decision.id}/merge-candidates`)).body
          .items,
      ).toEqual([]);
    });
  });

  // -------------------------------------------------------------------- R12

  describe('R12: no full phone without read:CustomerPhone, on every staff route', () => {
    const walk = new Map<string, () => Promise<request.Response>>();
    let walkRole = 'managerNoPhone';
    let ids: {
      question: string;
      restock: string;
      zone: string;
      customerKey: string;
    };
    const call = (method: 'get' | 'post', path: string, body?: object) => {
      const req = request(app.getHttpServer() as Parameters<typeof request>[0])
        [method](path)
        .set(as(walkRole));
      return method === 'post'
        ? req.set('Idempotency-Key', randomUUID()).send(body)
        : req;
    };

    beforeAll(async () => {
      const customer = await prisma.customer.create({
        data: { tenantId: tenantA, firstName: 'Rosa', ...PHONE },
      });
      const question = await create({
        customerKey: KEY,
        customerId: customer.id,
        ...PHONE,
      });
      const restock = await restockRequest({
        customerKey: KEY,
        customerId: customer.id,
        ...PHONE,
      });
      const zone = await create({
        customerKey: KEY,
        kind: 'DECISION',
        subtype: 'DELIVERY_ZONE' as never,
      }).catch(() => question);
      ids = {
        question: question.id,
        restock: restock.id,
        zone: zone.id,
        customerKey: token(KEY),
      };
    });

    const R = (
      method: 'GET' | 'POST',
      path: string,
      run: () => Promise<request.Response>,
    ) => walk.set(`${method} ${path}`, run);
    const id = () => ids.question;
    beforeAll(() => {
      R('GET', 'groups', () => call('get', '/chatbot-requests/groups'));
      R('GET', 'counts', () => call('get', '/chatbot-requests/counts'));
      R('GET', 'history', () => call('get', '/chatbot-requests/history'));
      R('GET', '', () =>
        call('get', `/chatbot-requests?customerKey=${ids.customerKey}`),
      );
      R('GET', ':id', () => call('get', `/chatbot-requests/${id()}`));
      R('GET', ':id/audit', () =>
        call('get', `/chatbot-requests/${id()}/audit`),
      );
      R('GET', ':id/merge-candidates', () =>
        call('get', `/chatbot-requests/${id()}/merge-candidates`),
      );
      R('GET', ':id/zone-impact', () =>
        call('get', `/chatbot-requests/${ids.zone}/zone-impact`),
      );
      R('POST', ':id/claim', () =>
        call('post', `/chatbot-requests/${id()}/claim`, { expectedVersion: 1 }),
      );
      R('POST', ':id/release', () =>
        call('post', `/chatbot-requests/${id()}/release`, {
          expectedVersion: 2,
        }),
      );
      R('POST', ':id/reassign', () =>
        call('post', `/chatbot-requests/${id()}/reassign`, {
          expectedVersion: 1,
          toUserId: users.luis,
        }),
      );
      R('POST', ':id/cancel', () =>
        call('post', `/chatbot-requests/${id()}/cancel`, {
          expectedVersion: 1,
          reason: 'DUPLICATE',
        }),
      );
      R('POST', ':id/resolve', () =>
        call('post', `/chatbot-requests/${ids.restock}/resolve`, {
          expectedVersion: 1,
          action: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE',
        }),
      );
    });

    const routesOf = (controller: { prototype: object }) =>
      Object.getOwnPropertyNames(controller.prototype)
        .map((name) => (controller.prototype as Record<string, unknown>)[name])
        .filter(
          (handler): handler is () => void =>
            typeof handler === 'function' &&
            Reflect.hasMetadata(METHOD_METADATA, handler),
        )
        .map(
          (handler) =>
            `${RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number]} ${String(Reflect.getMetadata(PATH_METADATA, handler)).replace(/^\/?$/, '')}`,
        );

    it('the walk covers every route of both staff controllers', () => {
      const discovered = [
        ChatbotRequestReadsController,
        ChatbotRequestCommandsController,
      ]
        .flatMap(routesOf)
        .sort();
      expect(discovered.length).toBeGreaterThanOrEqual(13);
      expect([...walk.keys()].sort()).toEqual(discovered);
    });

    it.each(['managerNoPhone', 'cashier', 'updateOnly', 'readOnly'])(
      'leaks no phone to %s on any route (success and error bodies)',
      async (role) => {
        walkRole = role;
        for (const [route, run] of walk) {
          const res = await run();
          const text = JSON.stringify(res.body);
          expect({ route, role, leak: LEAK.exec(text)?.[0] }).toEqual({
            route,
            role,
            leak: undefined,
          });
          expect(text).not.toContain('5512345678');
          expect(res.headers['cache-control']).toBe('no-store');
        }
      },
    );

    it('shows the full number only with read:CustomerPhone, where the contract puts it', async () => {
      walkRole = 'manager';
      const detail = await call('get', `/chatbot-requests/${ids.question}`);
      expect(detail.body.customer.phone).toBe('+525512345678');
      const groups = await call('get', '/chatbot-requests/groups?limit=50');
      const mine = groups.body.items.find(
        (g: any) => g.customerKey === ids.customerKey,
      );
      expect(mine.customer.phone).toBe('+525512345678');
      // even then, customerKey stays opaque in every body
      expect(JSON.stringify([detail.body, groups.body])).not.toMatch(
        /(?<!\+)525512345678/,
      );
      walkRole = 'cashier';
      const masked = await call('get', '/chatbot-requests/groups?limit=50');
      expect(
        masked.body.items.find((g: any) => g.customerKey === ids.customerKey)
          .customer.phone,
      ).toBe('55 **** 5678');
    });
  });
});
