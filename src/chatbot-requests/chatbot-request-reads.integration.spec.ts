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
  Logger,
  RequestMethod,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Prisma } from '@prisma/client';
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
  CHATBOT_REQUEST_RELATION_STORE,
  ChatbotRequestRelationsService,
} from './application/chatbot-request-relations.service';
import { PrismaChatbotRequestRelationStore } from './infrastructure/prisma-chatbot-request-relation.store';
import { ChatbotRequestRelationsController } from './presentation/chatbot-request-relations.controller';
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
import { PrismaDeliveryZoneValidationRepository } from '../delivery-zones/infrastructure/prisma-delivery-zone-validation.repository';
import { defaultSettings } from '../chatbot-settings/domain/chatbot-attention-settings';
import { CustomerKeySealer } from './domain/customer-key-sealer';
import {
  allocateFolio,
  refreshCustomerGroup,
} from './infrastructure/chatbot-request-writes';
import { PrismaChatbotRequestCommandStore } from './infrastructure/prisma-chatbot-request-command.store';
import { PrismaChatbotRequestReadStore } from './infrastructure/prisma-chatbot-request-read.store';
import { PrismaSlaPauseReader } from './infrastructure/prisma-sla-pause.reader';
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
        { provide: INBOX_CLOCK, useValue: () => NOW },
        // The real pause reader, as the module wires it (§5.4).
        { provide: SLA_PAUSE_READER, useClass: PrismaSlaPauseReader },
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

  /**
   * A zone validation with `n` requesters, each with its own customer and its
   * own `ChatbotRequest` (R9). The first one is the walk's customer (KEY).
   */
  async function zoneRequests(n: number, tenantId: string = tenantA) {
    // `(tenantId, zipCode)` is unique, so every fixture gets its own code.
    const zipCode = String(10_000 + ++seq);
    const validation = await prisma.deliveryZoneValidation.create({
      data: {
        tenantId,
        zipCode,
        state: 'CDMX',
        municipality: 'Cuauhtémoc',
        neighborhood: 'Centro',
        branchName: 'Centro',
      },
    });
    const requests: Array<{
      id: string;
      customerKey: string;
      lastMessageAt: Date;
    }> = [];
    for (let i = 0; i < n; i++) {
      const lastMessageAt = new Date(NOW.getTime() - (i + 1) * HOUR);
      const customerKey =
        i === 0 ? KEY : `52551100${String(++seq).padStart(4, '0')}`;
      const phone =
        i === 0
          ? PHONE
          : { phoneCountryCode: '52', phone: customerKey.slice(2) };
      const wrapped = await prisma.deliveryZoneRequest.create({
        data: {
          tenantId,
          source: 'chatbot',
          sourceRequestId: randomUUID(),
          canonicalRequestHash: 'h',
          submittedCredentialId: 'cred',
          validationId: validation.id,
          branchName: 'Centro',
          zipCode,
          state: 'CDMX',
          municipality: 'Cuauhtémoc',
          neighborhood: 'Centro',
          customerPhoneCountryCode: phone.phoneCountryCode,
          customerPhone: phone.phone,
          conversationRef: `wa:${customerKey}`,
          lastCustomerMessageAt: lastMessageAt,
        },
      });
      const created = await create(
        {
          kind: 'DECISION',
          subtype: 'DELIVERY_ZONE',
          deliveryZoneRequestId: wrapped.id,
          customerKey,
          ...phone,
        },
        tenantId,
      );
      requests.push({ id: created.id, customerKey, lastMessageAt });
    }
    return { validationId: validation.id, zipCode, requests };
  }

  async function receiptRequest(
    receipt: Record<string, unknown> = {},
    over: Record<string, unknown> = {},
  ) {
    const sale = await prisma.sale.create({
      data: {
        tenantId: tenantA,
        userId: users.ana,
        status: 'CONFIRMED',
        totalCents: 20_000,
        paidCents: 5_000,
        debtCents: 15_000,
        folio: 'V-77',
      },
    });
    const evidence = await prisma.receiptEvidence.create({
      data: {
        tenantId: tenantA,
        saleId: sale.id,
        declaredAmountCents: 5_000,
        declaredDate: new Date('2026-11-09T00:00:00.000Z'),
        declaredReference: 'ABC123',
        mimeType: 'image/jpeg',
        sizeBytes: 1234,
        previewStatus: 'READY',
        storageKey: 'receipts/k',
        extracted: { amountCents: 5_000 },
        mismatch: { kind: 'AMOUNT' },
        ...receipt,
      },
    });
    const request = await create({
      kind: 'DECISION',
      subtype: 'TRANSFER_RECEIPT',
      receiptEvidenceId: evidence.id,
      ...over,
    });
    return { ...request, saleId: sale.id, receiptId: evidence.id };
  }

  async function expirationRequest(
    decision: Record<string, unknown> = {},
    over: Record<string, unknown> = {},
  ) {
    const created = await prisma.humanDecision.create({
      data: {
        tenantId: tenantA,
        source: 'chatbot',
        sourceRequestId: randomUUID(),
        type: 'EXPIRATION',
        canonicalRequestHash: 'h',
        submittedCredentialId: 'cred',
        branchId: tenantA,
        branchName: 'Centro',
        productId: randomUUID(),
        productName: 'Alimento húmedo',
        productUnit: 'lata',
        ...decision,
      },
    });
    const request = await create({
      kind: 'DECISION',
      subtype: 'EXPIRATION',
      humanDecisionId: created.id,
      ...over,
    });
    return { ...request, decision: created };
  }

  const cursorOf = (...parts: Array<string | null>) =>
    Buffer.from(JSON.stringify(parts)).toString('base64url');

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
        (await get('/chatbot-requests/history?q=juan', 'manager', t)).status,
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
        // S8 additions (no closed requests here; one group per open customer).
        resolved7d: 0,
        cancelled7d: 0,
        openGroups: 4,
        // S9: open requests with no assignee (the two NEW ones).
        unassigned: 2,
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

  // ------------------------------------------- slaPaused and corrupt settings

  describe('slaPaused derived from the tenant calendar', () => {
    const corruptSettings = (tenantId: string) =>
      prisma.chatbotAttentionSettings.create({
        data: {
          tenantId,
          version: 1,
          // The policy of this tenant cannot be built (no such IANA zone).
          timeZone: 'Not/AZone',
          days: defaultSettings().openingHours
            .days as unknown as Prisma.InputJsonArray,
          closedDates: [],
          slas: defaultSettings().slas as unknown as Prisma.InputJsonArray,
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

    it('NOW is 06:00 in Mexico City (closed): an open request of a default tenant reads as paused', async () => {
      const own = await create({ summary: 'paused-default' });
      const res = await get('/chatbot-requests/groups?limit=50');
      expect(res.status).toBe(200);
      const row = res.body.items
        .flatMap((g: any) => g.requests)
        .find((r: any) => r.id === own.id);
      expect(row).toMatchObject({ slaPaused: true });
      expect(row.slaResumesAt).toBe('2026-11-11T15:00:00.000Z');
    });

    it('a tenant whose policy cannot be built still gets 200 on every read, with slaPaused false', async () => {
      const t = randomUUID();
      await prisma.tenant.create({
        data: { id: t, name: 'Corrupta', slug: `cr-corrupt-${t}` },
      });
      try {
        const own = await create({ summary: 'corrupt-tenant' }, t);
        await corruptSettings(t);
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

        const groups = await get(
          '/chatbot-requests/groups?limit=50',
          'manager',
          t,
        );
        expect(groups.status).toBe(200);
        expect(groups.body.items[0].requests[0]).toMatchObject({
          summary: 'corrupt-tenant',
          slaPaused: false,
          slaResumesAt: null,
        });
        const byCustomer = await get(
          `/chatbot-requests?customerKey=${token(own.customerKey, t)}`,
          'manager',
          t,
        );
        expect(byCustomer.status).toBe(200);
        expect(byCustomer.body.items[0]).toMatchObject({ slaPaused: false });
        const detail = await get(`/chatbot-requests/${own.id}`, 'manager', t);
        expect(detail.status).toBe(200);
        expect(detail.body).toMatchObject({
          slaPaused: false,
          slaResumesAt: null,
        });
        expect(
          (
            await get(
              `/chatbot-requests/${own.id}/merge-candidates`,
              'manager',
              t,
            )
          ).status,
        ).toBe(200);

        // One line per failed lookup, the tenant id and no settings value.
        expect(warn).toHaveBeenCalled();
        for (const [line] of warn.mock.calls) {
          expect(String(line)).toContain(t);
          expect(String(line)).not.toContain('Not/AZone');
        }
      } finally {
        jest.restoreAllMocks();
        await prisma.chatbotAttentionSettings.deleteMany({
          where: { tenantId: t },
        });
        await prisma.$executeRaw`ALTER TABLE "chatbot_requests" DISABLE TRIGGER "chatbot_requests_keep_forever"`;
        await prisma.$executeRaw`ALTER TABLE "chatbot_request_events" DISABLE TRIGGER "chatbot_request_events_append_only"`;
        try {
          await prisma.chatbotRequestEvent.deleteMany({
            where: { tenantId: t },
          });
          await prisma.chatbotCustomerGroup.deleteMany({
            where: { tenantId: t },
          });
          await prisma.chatbotRequest.deleteMany({ where: { tenantId: t } });
        } finally {
          await prisma.$executeRaw`ALTER TABLE "chatbot_requests" ENABLE TRIGGER "chatbot_requests_keep_forever"`;
          await prisma.$executeRaw`ALTER TABLE "chatbot_request_events" ENABLE TRIGGER "chatbot_request_events_append_only"`;
        }
        await prisma.tenant.delete({ where: { id: t } });
      }
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
      // no customer of that phone exists, so LINK_CUSTOMER is not offered (R1)
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

    it('exposes templateCostText (the tenant setting, or null with no row) on the detail to a reader without ChatbotSettings, and never on list rows', async () => {
      const { id } = await restockRequest();
      // `tenantA` has no settings row here: the detail says null.
      const bare = await get(`/chatbot-requests/${id}`, 'readOnly');
      expect(bare.status).toBe(200);
      expect(bare.body.templateCostText).toBeNull();

      const base = defaultSettings();
      await prisma.chatbotAttentionSettings.create({
        data: {
          tenantId: tenantA,
          version: 1,
          timeZone: base.openingHours.timeZone,
          days: base.openingHours.days as never,
          closedDates: [],
          slas: base.slas as never,
          windowWarningMinutes: base.windowWarningMinutes,
          templateCostText: 'Cada plantilla cuesta 2 pesos.',
          enabledSubtypes: base.enabledSubtypes,
          receiptCloseMarginMinutes: base.receiptCloseMarginMinutes,
          schedulingEnabled: false,
          slotMinutes: 30,
          slotsOffered: 3,
          maxScheduledPerSlot: 3,
        },
      });
      try {
        for (const role of ['readOnly', 'cashier', 'manager']) {
          const res = await get(`/chatbot-requests/${id}`, role);
          expect(res.body.templateCostText).toBe(
            'Cada plantilla cuesta 2 pesos.',
          );
        }
        // Not on the list rows nor on the other open rows of the detail.
        const groups = await get(
          '/chatbot-requests/groups?limit=50',
          'manager',
        );
        const rows = groups.body.items.flatMap((g: any) => g.requests);
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows)
          expect(row).not.toHaveProperty('templateCostText');
        const detail = await get(`/chatbot-requests/${id}`, 'manager');
        for (const row of detail.body.otherOpenRequests) {
          expect(row).not.toHaveProperty('templateCostText');
        }
      } finally {
        await prisma.chatbotAttentionSettings.deleteMany({
          where: { tenantId: tenantA },
        });
      }
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
      const conversationRef = 'wa:merge-candidates';
      const { id, customerKey } = await create({ conversationRef });
      const twin = await create({ customerKey, conversationRef });
      // same customer and subtype but another conversation: not a candidate
      await create({ customerKey, conversationRef: 'wa:elsewhere' });
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

  // ----------------------------------------- decision projection (§12.6)

  describe('GET /chatbot-requests/:id: decision per subtype and zoneImpact', () => {
    const legacyValidations = () =>
      new PrismaDeliveryZoneValidationRepository(tenantPrisma);
    const legacyCount = (validationId: string) =>
      cls.runWith(
        { tenantId: tenantA, userId: 'test', isSuperAdmin: false },
        () => legacyValidations().findById(validationId),
      );
    const closeRequests = (ids: string[], data: Record<string, unknown>) =>
      prisma.chatbotRequest.updateMany({
        where: { id: { in: ids } },
        data: { nextSlaCheckAt: null, ...data },
      });

    it('DELIVERY_ZONE: zone fields, zoneImpact with validationId and the route answering the same', async () => {
      const zone = await zoneRequests(3);
      const [first] = zone.requests;
      const detail = await get(`/chatbot-requests/${first.id}`);
      expect(detail.status).toBe(200);
      expect(detail.body.decision).toEqual({
        subtype: 'DELIVERY_ZONE',
        validationId: zone.validationId,
        zipCode: zone.zipCode,
        state: 'CDMX',
        municipality: 'Cuauhtémoc',
        neighborhood: 'Centro',
        requesterCount: 3,
        lastCustomerMessageAt: first.lastMessageAt.toISOString(),
        resolution: null,
      });
      expect(detail.body.zoneImpact).toEqual({
        validationId: zone.validationId,
        requests: 3,
        customers: 3,
        setVersion: 3,
      });
      const route = await get(`/chatbot-requests/${first.id}/zone-impact`);
      expect(route.body).toEqual(detail.body.zoneImpact);
      // the wrapped row's customer phone and conversation never come out
      expect(JSON.stringify(detail.body)).not.toContain('wa:');
      // LINK_CUSTOMER depends on whether customers of this shared phone exist
      expect(
        (detail.body.allowedActions as string[]).filter(
          (action) => action !== 'LINK_CUSTOMER',
        ),
      ).toEqual(['CLAIM', 'RESOLVE']);
    });

    it('DELIVERY_ZONE: requesterCount counts every requester like the legacy projection, also after resolution', async () => {
      const zone = await zoneRequests(3);
      const [first, second, third] = zone.requests;
      const at = new Date(NOW.getTime() - HOUR);
      await closeRequests([third.id], {
        status: 'CANCELLED',
        cancelledAt: at,
        closedAt: at,
        cancelReason: 'CUSTOMER_WITHDREW',
      });
      const open = await get(`/chatbot-requests/${first.id}`);
      const legacy = await legacyCount(zone.validationId);
      expect(legacy?.requesterCount).toBe(3);
      expect(open.body.decision.requesterCount).toBe(legacy?.requesterCount);
      expect(open.body.zoneImpact.requests).toBe(2); // only the open ones

      await closeRequests([first.id, second.id], {
        status: 'RESOLVED',
        resolvedAt: at,
        closedAt: at,
        resolvedByActorId: users.luis,
        resolvedByDisplayName: 'Luis',
        assigneeUserId: users.luis,
        assigneeDisplayName: 'Luis',
        claimedAt: at,
        resolution: {
          action: 'APPROVE_DELIVERY_ZONE',
          zoneType: 'FREE',
          surchargeCents: null,
          etaDays: null,
        },
      });
      const closed = await get(`/chatbot-requests/${first.id}`);
      expect(closed.body.decision.requesterCount).toBe(legacy?.requesterCount);
      expect(closed.body.zoneImpact).toMatchObject({
        requests: 0,
        customers: 0,
      });
      expect(closed.body.decision.resolution).toEqual({
        action: 'APPROVE_DELIVERY_ZONE',
        zoneType: 'FREE',
        surchargeCents: null,
        etaDays: null,
        resolvedBy: { id: users.luis, displayName: 'Luis' },
        resolvedAt: at.toISOString(),
      });
      expect(closed.body.allowedActions).toEqual([]);
    });

    it('DELIVERY_ZONE without a validation: no zoneImpact, no RESOLVE, and the routes answer 422 / 404', async () => {
      const wrapped = await prisma.deliveryZoneRequest.create({
        data: {
          tenantId: tenantA,
          source: 'chatbot',
          sourceRequestId: randomUUID(),
          canonicalRequestHash: 'h',
          submittedCredentialId: 'cred',
          zipCode: '02000',
          state: 'CDMX',
          municipality: 'Azcapotzalco',
          neighborhood: 'Centro',
          customerPhoneCountryCode: '52',
          customerPhone: '5598765432',
          conversationRef: 'wa:orphan',
          lastCustomerMessageAt: NOW,
          // The CHECKs allow no validation only for a requester resolved at
          // intake by an existing zone.
          status: 'RESOLVED',
          version: 2,
          resolutionSource: 'EXISTING_ZONE',
          zoneType: 'FREE',
          etaDays: 1,
          resolvedAt: NOW,
        },
      });
      const { id } = await create({
        kind: 'DECISION',
        subtype: 'DELIVERY_ZONE',
        deliveryZoneRequestId: wrapped.id,
      });
      const detail = await get(`/chatbot-requests/${id}`);
      expect(detail.status).toBe(200);
      expect(detail.body.zoneImpact).toBeUndefined();
      expect(detail.body.decision).toMatchObject({
        subtype: 'DELIVERY_ZONE',
        validationId: null,
        requesterCount: 1,
      });
      expect(detail.body.allowedActions).toEqual(['CLAIM']);
      expect((await get(`/chatbot-requests/${id}/zone-impact`)).status).toBe(
        422,
      );
      const resolve = await post(`/chatbot-requests/${id}/resolve`, {
        expectedVersion: 1,
        action: 'REJECT_DELIVERY_ZONE',
        expectedZoneSetVersion: 1,
      });
      expect(resolve.status).toBe(404);
    });

    it('TRANSFER_RECEIPT: sale totals, file links, extraction and mismatch; purged and undeclared variants', async () => {
      const receipt = await receiptRequest();
      const base = `/sales/${receipt.saleId}/receipts/${receipt.receiptId}`;
      const detail = await get(`/chatbot-requests/${receipt.id}`);
      expect(detail.body.decision).toEqual({
        subtype: 'TRANSFER_RECEIPT',
        receiptId: receipt.receiptId,
        saleId: receipt.saleId,
        saleFolio: 'V-77',
        declaredAmountCents: 5_000,
        declaredAmountProvided: true,
        declaredDate: '2026-11-09T00:00:00.000Z',
        declaredReference: 'ABC123',
        saleTotalCents: 20_000,
        salePaidCents: 5_000,
        saleDebtCents: 15_000,
        file: {
          mimeType: 'image/jpeg',
          sizeBytes: 1234,
          previewStatus: 'READY',
          originalUrl: `${base}/file`,
          previewUrl: `${base}/preview`,
        },
        extracted: { amountCents: 5_000 },
        mismatch: { kind: 'AMOUNT' },
        resolution: null,
      });
      expect(detail.body.zoneImpact).toBeUndefined();

      await prisma.receiptEvidence.update({
        where: { id: receipt.receiptId },
        data: { purgedAt: NOW },
      });
      const purged = await get(`/chatbot-requests/${receipt.id}`);
      expect(purged.body.decision.file).toMatchObject({
        originalUrl: null,
        previewUrl: null,
      });

      const bare = await receiptRequest({
        declaredAmountCents: null,
        declaredDate: null,
        declaredReference: null,
        mimeType: null,
        sizeBytes: null,
        previewStatus: null,
        storageKey: null,
        extracted: undefined,
        mismatch: undefined,
        mediaUrl: 'https://legacy.example/receipt.jpg',
      });
      const legacy = await get(`/chatbot-requests/${bare.id}`);
      expect(legacy.body.decision).toMatchObject({
        declaredAmountCents: 0,
        declaredAmountProvided: false,
        declaredDate: null,
        file: null,
        extracted: null,
        mismatch: null,
      });
    });

    it('TRANSFER_RECEIPT: a receipt whose preview is not ready has no previewUrl', async () => {
      const receipt = await receiptRequest({ previewStatus: 'UNAVAILABLE' });
      const detail = await get(`/chatbot-requests/${receipt.id}`);
      expect(detail.body.decision.file).toMatchObject({
        previewStatus: 'UNAVAILABLE',
        previewUrl: null,
        originalUrl: expect.stringContaining('/file'),
      });
    });

    it('EXPIRATION: snapshot with unit and variant fields, with and without a variant', async () => {
      const plain = await expirationRequest();
      const detail = await get(`/chatbot-requests/${plain.id}`);
      expect(detail.body.decision).toEqual({
        subtype: 'EXPIRATION',
        snapshot: {
          branchId: tenantA,
          branchName: 'Centro',
          productId: plain.decision.productId,
          productName: 'Alimento húmedo',
          unit: 'lata',
          variantId: null,
          variantName: null,
          variantOption: null,
          variantValue: null,
        },
        resolution: null,
      });
      expect(detail.body.allowedActions).toEqual(['CLAIM', 'RESOLVE']);

      const variantId = randomUUID();
      const variant = await expirationRequest({
        variantId,
        variantName: 'Grande',
        variantOption: 'Tamaño',
        variantValue: 'L',
      });
      const withVariant = await get(`/chatbot-requests/${variant.id}`);
      expect(withVariant.body.decision.snapshot).toMatchObject({
        variantId,
        variantName: 'Grande',
        variantOption: 'Tamaño',
        variantValue: 'L',
      });
    });
  });

  // ------------------------------------------- cursors and dates are validated

  describe('a well-formed cursor or date range with a bad part is a 400', () => {
    const DATE = '2026-11-10T00:00:00.000Z';
    it.each([
      [
        'groups: bad date',
        () => `/chatbot-requests/groups?cursor=${cursorOf('nope', token(KEY))}`,
      ],
      [
        'groups: closed tab with a null date',
        () =>
          `/chatbot-requests/groups?status=resolved&cursor=${cursorOf(null, token(KEY))}`,
      ],
      [
        'groups: key that is not a token',
        () => `/chatbot-requests/groups?cursor=${cursorOf(DATE, KEY)}`,
      ],
      [
        'customer list: bad date',
        () =>
          `/chatbot-requests?customerKey=${token(KEY)}&cursor=${cursorOf('2026-02-30T00:00:00.000Z', DATE, randomUUID())}`,
      ],
      [
        'customer list: bad id',
        () =>
          `/chatbot-requests?customerKey=${token(KEY)}&cursor=${cursorOf(null, DATE, 'not-a-uuid')}`,
      ],
      [
        'customer list closed: bad id',
        () =>
          `/chatbot-requests?customerKey=${token(KEY)}&status=resolved&cursor=${cursorOf(DATE, 'x')}`,
      ],
      [
        'history: year 0',
        () =>
          `/chatbot-requests/history?cursor=${cursorOf('0000-01-01T00:00:00.000Z', randomUUID())}`,
      ],
      [
        'history: bad id',
        () => `/chatbot-requests/history?cursor=${cursorOf(DATE, 'x')}`,
      ],
      [
        'history: year 1 range',
        () =>
          `/chatbot-requests/history?from=0001-01-01T00:00:00.000Z&to=0001-02-01T00:00:00.000Z`,
      ],
    ])('%s', async (_name, path) => {
      const res = await get(path());
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('audit: bad date and bad id', async () => {
      const { id } = await create({});
      for (const cursor of [
        cursorOf('2026-02-30T00:00:00.000Z', randomUUID()),
        cursorOf(DATE, 'nope'),
      ]) {
        const res = await get(`/chatbot-requests/${id}/audit?cursor=${cursor}`);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------- R12

  describe('R12: no full phone without read:CustomerPhone, on every staff route', () => {
    type Run = () => Promise<request.Response | request.Response[]>;
    const walk = new Map<string, Run>();
    let walkRole = 'managerNoPhone';
    let ids: {
      question: string;
      ambiguous: string;
      linkCandidate: string;
      mergeInto: string;
      restock: string;
      zone: string;
      /** The detail of every subtype and of a zone, a receipt and an expiry. */
      details: string[];
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
      const mine = { customerKey: KEY, customerId: customer.id, ...PHONE };
      const question = await create(mine);
      const restock = await restockRequest(mine);
      // A REAL zone request (the first requester is the walk's customer), a
      // receipt and an expiry, all with the phone in their own tables.
      const zone = await zoneRequests(2);
      const receipt = await receiptRequest({}, mine);
      const expiry = await expirationRequest({}, mine);
      // Events for the audit cursor and old closed requests for the history one.
      for (let i = 0; i < 3; i++) {
        await prisma.chatbotRequestEvent.create({
          data: {
            tenantId: tenantA,
            requestId: question.id,
            type: 'SLA_MILESTONE',
            actorKind: 'SYSTEM',
            version: 1,
            data: { milestone: 'HALF' },
            createdAt: new Date(NOW.getTime() + i * 1000),
          },
        });
      }
      for (let i = 1; i <= 3; i++) {
        await create({
          ...mine,
          summary: `old-${i}`,
          ...closed('RESOLVED', new Date(NOW.getTime() - (10 + i) * DAY)),
        });
      }
      // R1: two customers share a phone; the ambiguous request's detail lists
      // them as link candidates, which must stay masked too.
      const AMBIGUOUS_KEY = '525598765432';
      const ambiguousPhone = { phoneCountryCode: '52', phone: '5598765432' };
      for (const firstName of ['Ana', 'Ani']) {
        await prisma.customer.create({
          data: { tenantId: tenantA, firstName, ...ambiguousPhone },
        });
      }
      const ambiguous = await create({
        customerKey: AMBIGUOUS_KEY,
        ambiguousCustomer: true,
        ...ambiguousPhone,
      });
      const linkCandidate = await prisma.customer.findFirstOrThrow({
        where: { tenantId: tenantA, ...ambiguousPhone },
      });
      // a pair of the walk's customer for merge
      const mergeInto = await create(mine);
      ids = {
        ambiguous: ambiguous.id,
        linkCandidate: linkCandidate.id,
        mergeInto: mergeInto.id,
        question: question.id,
        restock: restock.id,
        zone: zone.requests[0].id,
        details: [
          ambiguous.id,
          question.id,
          restock.id,
          zone.requests[0].id,
          receipt.id,
          expiry.id,
        ],
        customerKey: token(KEY),
      };
    });

    const R = (method: 'GET' | 'POST', path: string, run: Run) =>
      walk.set(`${method} ${path}`, run);
    const id = () => ids.question;
    beforeAll(() => {
      // `limit=1` makes every list hand out a cursor, which the walk decodes.
      R('GET', 'groups', () => call('get', '/chatbot-requests/groups?limit=1'));
      R('GET', 'counts', () => call('get', '/chatbot-requests/counts'));
      R('GET', 'history', () =>
        call('get', '/chatbot-requests/history?limit=1'),
      );
      R('GET', '', () =>
        call('get', `/chatbot-requests?customerKey=${ids.customerKey}&limit=1`),
      );
      R('GET', ':id', () =>
        Promise.all(
          ids.details.map((detailId) =>
            call('get', `/chatbot-requests/${detailId}`),
          ),
        ),
      );
      R('GET', ':id/audit', () =>
        call('get', `/chatbot-requests/${id()}/audit?limit=1`),
      );
      R('GET', ':id/merge-candidates', () =>
        call('get', `/chatbot-requests/${id()}/merge-candidates`),
      );
      R('GET', 'assignable-users', () =>
        call('get', '/chatbot-requests/assignable-users'),
      );
      R('POST', ':id/merge', () =>
        call('post', `/chatbot-requests/${id()}/merge`, {
          expectedVersion: 1,
          intoRequestId: ids.mergeInto,
          intoExpectedVersion: 1,
        }),
      );
      R('POST', ':id/link-customer', () =>
        // a candidate of the ambiguous request: phone-mismatch errors and the
        // success body must not leak either
        Promise.all([
          call('post', `/chatbot-requests/${ids.ambiguous}/link-customer`, {
            expectedVersion: 1,
            customerId: ids.linkCandidate,
          }),
          call('post', `/chatbot-requests/${id()}/link-customer`, {
            expectedVersion: 1,
            customerId: ids.linkCandidate,
          }),
        ]),
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
      // Unit 10: the reply's answer (and its error, whichever state the walk
      // left the question in) must not leak a phone either.
      R('POST', ':id/reply', () =>
        call('post', `/chatbot-requests/${id()}/reply`, {
          expectedVersion: 1,
          text: 'Sí, es apto desde las 8 semanas.',
        }),
      );
      // Unit 11: finishing a live conversation. The walk's request is not a
      // live one, so this is the error path; it must not leak a phone either.
      R('POST', ':id/finish', () =>
        call('post', `/chatbot-requests/${id()}/finish`, {
          expectedVersion: 1,
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
        ChatbotRequestRelationsController,
      ]
        .flatMap(routesOf)
        .sort();
      expect(discovered.length).toBeGreaterThanOrEqual(16);
      expect([...walk.keys()].sort()).toEqual(discovered);
    });

    /** Every `nextCursor` / `auditNextCursor` in a body, decoded. */
    const cursorsIn = (text: string) =>
      [...text.matchAll(/"(?:audit)?[nN]extCursor":"([^"]+)"/g)].map((match) =>
        Buffer.from(match[1], 'base64url').toString('utf8'),
      );

    it.each(['managerNoPhone', 'cashier', 'updateOnly', 'readOnly'])(
      'leaks no phone to %s on any route, in a body or inside a cursor',
      async (role) => {
        walkRole = role;
        const decoded: string[] = [];
        let zoneDetails = 0;
        for (const [route, run] of walk) {
          const out = await run();
          for (const res of Array.isArray(out) ? out : [out]) {
            const text = JSON.stringify(res.body);
            expect({ route, role, leak: LEAK.exec(text)?.[0] }).toEqual({
              route,
              role,
              leak: undefined,
            });
            expect(text).not.toContain('5512345678');
            expect(res.headers['cache-control']).toBe('no-store');
            decoded.push(...cursorsIn(text));
            if (res.body?.decision?.subtype === 'DELIVERY_ZONE') zoneDetails++;
          }
        }
        // groups, customer list, history and audit each handed out a cursor
        expect(decoded.length).toBeGreaterThanOrEqual(4);
        for (const cursor of decoded) {
          expect({ role, cursor, leak: LEAK.exec(cursor)?.[0] }).toEqual({
            role,
            cursor,
            leak: undefined,
          });
          expect(cursor).not.toContain('5512345678');
          expect(cursor).not.toContain(KEY);
        }
        // the walk really reached the zone, receipt and expiry projections
        expect(zoneDetails).toBe(1);
      },
    );

    it('the walk reads a real zone request, not a stand-in', async () => {
      walkRole = 'manager';
      const zone = await call(
        'get',
        `/chatbot-requests/${ids.zone}/zone-impact`,
      );
      expect(zone.status).toBe(200);
      expect(zone.body).toMatchObject({ requests: 2, customers: 2 });
      const details = await Promise.all(
        ids.details.map((detailId) =>
          call('get', `/chatbot-requests/${detailId}`),
        ),
      );
      expect(
        details.map(
          (res) =>
            (res.body.decision as { subtype?: string } | null)?.subtype ?? null,
        ),
      ).toEqual([
        null,
        null,
        'RESTOCK',
        'DELIVERY_ZONE',
        'TRANSFER_RECEIPT',
        'EXPIRATION',
      ]);
    });

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

  // ------------------------------------------- S11: windowClosingSoon setting

  describe('windowClosingSoon follows the tenant windowWarningMinutes (S11)', () => {
    const MIN = 60_000;
    /** Minutes before the WhatsApp window closes; 0 and -1 are never "soon". */
    const CLOSES_IN = [-1, 0, 30, 60, 61, 119, 120, 121, 600, 1440];
    const tenants: string[] = [];

    async function tenantWithWarning(
      minutes: number | null,
    ): Promise<{ id: string; names: Record<number, string> }> {
      const id = randomUUID();
      tenants.push(id);
      await prisma.tenant.create({
        data: { id, name: 'Ventana', slug: `cr-window-${id}` },
      });
      if (minutes !== null) {
        const base = defaultSettings();
        await prisma.chatbotAttentionSettings.create({
          data: {
            tenantId: id,
            version: 1,
            timeZone: base.openingHours.timeZone,
            days: base.openingHours.days as never,
            closedDates: [],
            slas: base.slas as never,
            windowWarningMinutes: minutes,
            templateCostText: base.templateCostText,
            enabledSubtypes: base.enabledSubtypes,
            receiptCloseMarginMinutes: base.receiptCloseMarginMinutes,
            schedulingEnabled: false,
            slotMinutes: 30,
            slotsOffered: 3,
            maxScheduledPerSlot: 3,
          },
        });
      }
      const names: Record<number, string> = {};
      for (const closesIn of CLOSES_IN) {
        const closesAt = new Date(NOW.getTime() + closesIn * MIN);
        names[closesIn] = `w${closesIn}`;
        await create(
          {
            summary: names[closesIn],
            kind: 'CONVERSATION',
            subtype: 'TALK_TO_HUMAN',
            lastCustomerMessageAt: new Date(closesAt.getTime() - DAY),
            whatsappWindowClosesAt: closesAt,
          },
          id,
        );
      }
      return { id, names };
    }

    const filtered = async (tenantId: string) =>
      (
        (await get(
          '/chatbot-requests/groups?windowClosingSoon=true&limit=50',
          'manager',
          tenantId,
        )) as { body: { items: any[] } }
      ).body.items
        .flatMap((g: any) => summaries(g.requests))
        .sort();
    const counted = async (tenantId: string) =>
      (await get('/chatbot-requests/counts', 'manager', tenantId)).body
        .windowClosingSoon;
    const only = (...closesIn: number[]) => closesIn.map((m) => `w${m}`).sort();

    afterAll(async () => {
      await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    });

    it('a tenant without a row keeps the 2 h of before: (now, now + 120 min], boundary included', async () => {
      const { id } = await tenantWithWarning(null);
      const expected = only(30, 60, 61, 119, 120);
      expect(await filtered(id)).toEqual(expected);
      expect(await counted(id)).toBe(expected.length);
    });

    it('a tenant saved at 120 behaves exactly like the default', async () => {
      const { id } = await tenantWithWarning(120);
      expect(await filtered(id)).toEqual(only(30, 60, 61, 119, 120));
      expect(await counted(id)).toBe(5);
    });

    it('a tenant at 60 minutes gets only what closes within the hour, in the filter and in the count', async () => {
      const { id } = await tenantWithWarning(60);
      expect(await filtered(id)).toEqual(only(30, 60));
      expect(await counted(id)).toBe(2);
    });

    it('a larger window widens both (1440 = everything still open)', async () => {
      const { id } = await tenantWithWarning(1440);
      expect(await filtered(id)).toEqual(
        only(30, 60, 61, 119, 120, 121, 600, 1440),
      );
      expect(await counted(id)).toBe(8);
    });

    it('0 turns the warning off: nothing is closing soon', async () => {
      const { id } = await tenantWithWarning(0);
      expect(await filtered(id)).toEqual([]);
      expect(await counted(id)).toBe(0);
    });

    it('is tenant scoped: another tenant on 60 does not move the default tenant', async () => {
      const sixty = await tenantWithWarning(60);
      const none = await tenantWithWarning(null);
      expect(await counted(sixty.id)).toBe(2);
      expect(await counted(none.id)).toBe(5);
      expect(await filtered(none.id)).toEqual(only(30, 60, 61, 119, 120));
    });

    it('the by-customer list applies the same window', async () => {
      const { id } = await tenantWithWarning(60);
      const customerKey = '525511009900';
      await create(
        {
          customerKey,
          summary: 'near',
          lastCustomerMessageAt: new Date(NOW.getTime() - 23.5 * HOUR),
          whatsappWindowClosesAt: new Date(NOW.getTime() + 30 * MIN),
        },
        id,
      );
      await create(
        {
          customerKey,
          summary: 'far',
          kind: 'CONVERSATION',
          subtype: 'TALK_TO_HUMAN',
          lastCustomerMessageAt: new Date(NOW.getTime() - 22.5 * HOUR),
          whatsappWindowClosesAt: new Date(NOW.getTime() + 90 * MIN),
        },
        id,
      );
      const list = await get(
        `/chatbot-requests?customerKey=${encodeURIComponent(token(customerKey, id))}&windowClosingSoon=true&limit=50`,
        'manager',
        id,
      );
      expect(list.status).toBe(200);
      expect(summaries(list.body.items)).toEqual(['near']);
    });

    // ---------------------------- T7g: the per-row boolean, same rule

    type Row = { summary: string; windowClosingSoon: boolean; status: string };
    const flat = (body: { items: Array<{ requests: Row[] }> }): Row[] =>
      body.items.flatMap((g) => g.requests);
    const flagged = (rows: Row[]) =>
      rows
        .filter((r) => r.windowClosingSoon)
        .map((r) => r.summary)
        .sort();

    describe.each([
      ['a tenant on 60', 60, only(30, 60)],
      ['a tenant on defaults (no row, 120)', null, only(30, 60, 61, 119, 120)],
    ])('rows carry windowClosingSoon: %s', (_label, minutes, soon) => {
      let id: string;
      beforeAll(async () => {
        id = (await tenantWithWarning(minutes)).id;
      });

      it('groups: every row of ?windowClosingSoon=true is true, and the unfiltered rows outside it are false', async () => {
        const hit = await get(
          '/chatbot-requests/groups?windowClosingSoon=true&limit=50',
          'manager',
          id,
        );
        const hitRows = flat(hit.body);
        expect(hitRows.length).toBe(soon.length);
        expect(hitRows.every((r) => r.windowClosingSoon === true)).toBe(true);
        const all = flat(
          (await get('/chatbot-requests/groups?limit=50', 'manager', id)).body,
        );
        expect(all).toHaveLength(CLOSES_IN.length);
        expect(flagged(all)).toEqual(soon);
        for (const row of all) {
          expect(typeof row.windowClosingSoon).toBe('boolean');
          if (!soon.includes(row.summary)) {
            expect(row.windowClosingSoon).toBe(false);
          }
        }
        // the count, the filter and the flags are one rule
        expect(await counted(id)).toBe(soon.length);
        expect(flagged(all)).toEqual(await filtered(id));
      });

      it('detail and otherOpenRequests, by-customer list, merge candidates', async () => {
        const customerKey = `52551177${String(minutes ?? 0).padStart(4, '0')}`;
        const conversationRef = `wa:t7g-${randomUUID()}`;
        const mk = (summary: string, closesIn: number | null) =>
          create(
            {
              customerKey,
              summary,
              conversationRef,
              kind: 'CONVERSATION',
              subtype: 'TALK_TO_HUMAN',
              ...(closesIn === null
                ? {}
                : {
                    lastCustomerMessageAt: new Date(
                      NOW.getTime() + closesIn * MIN - DAY,
                    ),
                    whatsappWindowClosesAt: new Date(
                      NOW.getTime() + closesIn * MIN,
                    ),
                  }),
            },
            id,
          );
        const main = await mk('main', 90);
        await mk('soon', 30);
        await mk('far', 600);
        await mk('gone', -1);
        await mk('nowindow', null);
        await create(
          {
            customerKey,
            summary: 'done',
            conversationRef,
            kind: 'CONVERSATION',
            subtype: 'TALK_TO_HUMAN',
            lastCustomerMessageAt: new Date(NOW.getTime() - DAY),
            whatsappWindowClosesAt: new Date(NOW.getTime() + 20 * MIN),
            ...closed('RESOLVED', new Date(NOW.getTime() - HOUR)),
          },
          id,
        );
        const expected: Record<string, boolean> = {
          main: 90 <= (minutes ?? 120),
          soon: true,
          far: false,
          gone: false,
          nowindow: false,
        };
        const check = (rows: Row[], names: string[]) => {
          expect(rows.map((r) => r.summary).sort()).toEqual([...names].sort());
          for (const row of rows) {
            expect(row.windowClosingSoon).toBe(expected[row.summary]);
          }
        };

        const detail = await get(`/chatbot-requests/${main.id}`, 'manager', id);
        expect(detail.status).toBe(200);
        expect(detail.body.windowClosingSoon).toBe(expected.main);
        check(detail.body.otherOpenRequests, [
          'soon',
          'far',
          'gone',
          'nowindow',
        ]);

        const list = await get(
          `/chatbot-requests?customerKey=${encodeURIComponent(token(customerKey, id))}&limit=50`,
          'manager',
          id,
        );
        check(list.body.items, ['main', 'soon', 'far', 'gone', 'nowindow']);

        const merge = await get(
          `/chatbot-requests/${main.id}/merge-candidates`,
          'manager',
          id,
        );
        check(merge.body.items, ['soon', 'far', 'gone', 'nowindow']);

        // closed rows: false, even with a window in range; the filter on the
        // closed tab matches nothing (same rule: open only)
        const resolved = await get(
          '/chatbot-requests/groups?status=resolved&limit=50',
          'manager',
          id,
        );
        const done = flat(resolved.body).find((r) => r.summary === 'done');
        expect(done?.windowClosingSoon).toBe(false);
        const resolvedFiltered = await get(
          '/chatbot-requests/groups?status=resolved&windowClosingSoon=true&limit=50',
          'manager',
          id,
        );
        expect(flat(resolvedFiltered.body)).toEqual([]);

        // by-customer with the filter: every row true
        const hit = await get(
          `/chatbot-requests?customerKey=${encodeURIComponent(token(customerKey, id))}&windowClosingSoon=true&limit=50`,
          'manager',
          id,
        );
        expect(hit.body.items.length).toBeGreaterThan(0);
        expect(
          hit.body.items.every((r: Row) => r.windowClosingSoon === true),
        ).toBe(true);
        expect(flagged(list.body.items)).toEqual(
          hit.body.items.map((r: Row) => r.summary).sort(),
        );
      });
    });

    it('history rows are closed: windowClosingSoon false', async () => {
      const { id } = await tenantWithWarning(60);
      await create(
        {
          summary: 'old',
          kind: 'CONVERSATION',
          subtype: 'TALK_TO_HUMAN',
          lastCustomerMessageAt: new Date(NOW.getTime() - DAY),
          whatsappWindowClosesAt: new Date(NOW.getTime() + 20 * MIN),
          ...closed('RESOLVED', new Date(NOW.getTime() - 30 * DAY)),
        },
        id,
      );
      const history = await get('/chatbot-requests/history', 'manager', id);
      expect(summaries(history.body.items)).toEqual(['old']);
      expect(history.body.items[0].windowClosingSoon).toBe(false);
    });
  });
});
