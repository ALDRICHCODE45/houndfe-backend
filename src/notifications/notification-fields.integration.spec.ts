/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- supertest response bodies are untyped JSON and the query log event is untyped */
/**
 * S10 (FE notification panel notes) end to end against REAL PostgreSQL:
 * Supertest → `NotificationsController` and the staff command controllers (stub
 * guards that set the caller) → real services and stores; the overdue notices
 * come from the REAL SLA sweep and the REAL notify consumer.
 *
 *   1. `folio`, `subtype`, `cause` on every item, null for older rows;
 *   2. `reason` ASSIGNEE | ESCALATION on 80 % / overdue notices, decided when
 *      the row is created (assignee wins over escalation holder);
 *   3. `requestOpen` from a join in the list statement (no N+1, tenant scoped),
 *      flipping when the request closes;
 *   4. cause MERGED after a real merge;
 *   5. the list item and the `notification.created` payload (realtime reader,
 *      `eventView`) have the same shape and values.
 */
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  Injectable,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ClsModule, ClsService } from 'nestjs-cls';
import request from 'supertest';
import { integrationPrisma } from '../../test/integration/reset-db';
import type {
  AppAbility,
  AppActions,
  AppSubjects,
} from '../auth/authorization/domain/permission';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { ActiveUserGuard } from '../auth/guards/active-user.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  CHATBOT_REQUEST_COMMAND_STORE,
  CHATBOT_REQUEST_RESOLVER,
  ChatbotRequestCommandsService,
} from '../chatbot-requests/application/chatbot-request-commands.service';
import {
  CHATBOT_REQUEST_RELATION_STORE,
  ChatbotRequestRelationsService,
} from '../chatbot-requests/application/chatbot-request-relations.service';
import {
  slaColumnsForTransition,
  type RawDb,
} from '../chatbot-requests/infrastructure/chatbot-sla-policy';
import { ChatbotSlaSweepStore } from '../chatbot-requests/infrastructure/chatbot-sla-sweep.store';
import {
  allocateFolio,
  refreshCustomerGroup,
} from '../chatbot-requests/infrastructure/chatbot-request-writes';
import { PrismaChatbotRequestCommandStore } from '../chatbot-requests/infrastructure/prisma-chatbot-request-command.store';
import { PrismaChatbotRequestRelationStore } from '../chatbot-requests/infrastructure/prisma-chatbot-request-relation.store';
import { ChatbotRequestCommandsController } from '../chatbot-requests/presentation/chatbot-request-commands.controller';
import { ChatbotRequestHttpFilter } from '../chatbot-requests/presentation/chatbot-request-http.filter';
import { ChatbotRequestRelationsController } from '../chatbot-requests/presentation/chatbot-request-relations.controller';
import { PrismaNotificationEventReader } from '../realtime/infrastructure/prisma-notification-event.reader';
import { createAppValidationPipe } from '../shared/listing/app-validation.pipe';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { PrismaService } from '../shared/prisma/prisma.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import { NotificationsService } from './application/notifications.service';
import type { NotificationEventsPort } from './domain/notification-events.port';
import { ChatbotRequestNotifyConsumer } from './outbox/chatbot-request-notify.consumer';
import { NotificationsController } from './presentation/notifications.controller';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

type Grant = [AppActions, AppSubjects];
const MANAGER: Grant[] = [
  ['read', 'ChatbotRequest'],
  ['update', 'ChatbotRequest'],
  ['update', 'ChatbotRequestAssignment'],
  ['validate', 'DeliveryZone'],
];

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
    for (const [action, subject] of MANAGER) can(action, subject);
    req.user = { userId, tenantId, isSuperAdmin: false };
    req.ability = build();
    this.cls.set('tenantId', tenantId);
    this.cls.set('userId', userId);
    return true;
  }
}

const at = (v: string) => new Date(v);
const folioText = (n: number) => `S-${String(n).padStart(6, '0')}`;

const ITEM_KEYS = [
  'body',
  'cause',
  'createdAt',
  'folio',
  'id',
  'level',
  'readAt',
  'reason',
  'requestId',
  'requestOpen',
  'subtype',
  'title',
  'type',
];

describeIfDb('notification item fields, S10 (PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const root = prisma as unknown as PrismaService;
  // The app's own client logs every statement, so the N+1 check looks at what
  // the list really ran.
  const appPrisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
    log: [{ emit: 'event', level: 'query' }],
  });
  const log: string[] = [];
  (appPrisma as any).$on('query', (event: any) => log.push(event.query));

  let app: INestApplication;
  let tenantPrisma: TenantPrismaService;
  let cls: ClsService<TenantClsStore>;
  let service: NotificationsService;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const tenants = [tenantA, tenantB];
  const u = {
    ana: randomUUID(), // handler, no escalation grant
    esc: randomUUID(), // read:ChatbotEscalation only
    both: randomUUID(), // handler AND escalation holder
    boss: randomUUID(), // acts (merges, resolves)
    foreign: randomUUID(),
  };
  const extraUsers: string[] = [];
  let seq = 0;

  const noEvents: NotificationEventsPort = {
    publishCreated: () => Promise.resolve(),
  };
  const consumer = new ChatbotRequestNotifyConsumer(
    root,
    noEvents,
    () => new Date(),
    25,
    3,
  );
  async function drain(): Promise<void> {
    for (let i = 0; i < 200 && (await consumer.processOne()); i++) {
      /* keep going */
    }
  }
  const sweepAt = (now: Date) =>
    new ChatbotSlaSweepStore(root, { clock: () => now }).runBatch('due');

  const grant = (subject: string, action: string) =>
    prisma.permission.upsert({
      where: { subject_action: { subject, action } },
      update: {},
      create: { subject, action },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        DatabaseModule,
      ],
      controllers: [
        NotificationsController,
        ChatbotRequestCommandsController,
        ChatbotRequestRelationsController,
      ],
      providers: [
        ChatbotRequestHttpFilter,
        NotificationsService,
        ChatbotRequestCommandsService,
        ChatbotRequestRelationsService,
        {
          provide: CHATBOT_REQUEST_COMMAND_STORE,
          useClass: PrismaChatbotRequestCommandStore,
        },
        {
          provide: CHATBOT_REQUEST_RELATION_STORE,
          useClass: PrismaChatbotRequestRelationStore,
        },
        {
          // The wrapped use cases have their own specs: this stand-in settles
          // the zone rows like the real resolve does.
          provide: CHATBOT_REQUEST_RESOLVER,
          inject: [TenantPrismaService],
          useFactory: (tenants: TenantPrismaService) => ({
            resolve: async ({
              row,
            }: {
              row: { deliveryZoneRequestId: string | null };
            }) => {
              const db = tenants.getClient();
              const zone = await db.deliveryZoneRequest.findFirstOrThrow({
                where: { id: row.deliveryZoneRequestId ?? '' },
              });
              await db.deliveryZoneRequest.updateMany({
                where: { validationId: zone.validationId },
                data: {
                  status: 'RESOLVED',
                  version: 2,
                  resolutionSource: 'VALIDATION',
                  zoneType: 'DENIED',
                  resolvedAt: new Date(),
                },
              });
            },
          }),
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
      .useClass(StubGuard)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createAppValidationPipe());
    await app.init();
    tenantPrisma = moduleRef.get(TenantPrismaService);
    cls = moduleRef.get<ClsService<TenantClsStore>>(ClsService);
    service = moduleRef.get(NotificationsService);

    for (const id of tenants) {
      await prisma.tenant.create({
        data: { id, name: 'Campos S10', slug: `nf-s10-${id}` },
      });
    }
    const [read, update, escalation] = await Promise.all([
      grant('ChatbotRequest', 'read'),
      grant('ChatbotRequest', 'update'),
      grant('ChatbotEscalation', 'read'),
    ]);
    const role = (tenantId: string, name: string, ids: string[]) =>
      prisma.role.create({
        data: {
          tenantId,
          name: `${name} ${tenantId}`,
          permissions: {
            create: ids.map((permissionId) => ({ permissionId })),
          },
        },
      });
    const handlers = await role(tenantA, 'Atiende', [read.id, update.id]);
    const escalators = await role(tenantA, 'Escala', [escalation.id]);
    const both = await role(tenantA, 'AtiendeYEscala', [
      read.id,
      update.id,
      escalation.id,
    ]);
    const foreignRole = await role(tenantB, 'Atiende', [read.id, update.id]);
    for (const [name, id] of Object.entries(u)) {
      await prisma.user.create({
        data: {
          id,
          email: `${name}-${id}@s10.test`,
          hashedPassword: 'x',
          name,
        },
      });
    }
    await prisma.tenantMembership.createMany({
      data: [
        { userId: u.ana, tenantId: tenantA, roleId: handlers.id },
        { userId: u.boss, tenantId: tenantA, roleId: handlers.id },
        { userId: u.esc, tenantId: tenantA, roleId: escalators.id },
        { userId: u.both, tenantId: tenantA, roleId: both.id },
        { userId: u.foreign, tenantId: tenantB, roleId: foreignRole.id },
      ],
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await appPrisma.$disconnect();
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.user.deleteMany({
      where: { id: { in: [...Object.values(u), ...extraUsers] } },
    });
  });

  // -------------------------------------------------------------- helpers

  const as = (userId: string, tenantId: string = tenantA) => ({
    'x-test-role': 'manager',
    'x-test-tenant': tenantId,
    'x-test-user': userId,
  });
  const http = () =>
    request(app.getHttpServer() as Parameters<typeof request>[0]);
  const list = async (
    userId: string,
    query = 'limit=50',
    tenantId: string = tenantA,
  ) => {
    const res = await http()
      .get(`/notifications?${query}`)
      .set(as(userId, tenantId))
      .expect(200);
    return res.body as {
      items: Array<Record<string, any>>;
      nextCursor: string | null;
    };
  };
  const itemsFor = async (userId: string, requestId: string | null) =>
    (await list(userId)).items.filter((item) => item.requestId === requestId);
  const post = (path: string, body: object, userId: string = u.boss) =>
    http()
      .post(path)
      .set(as(userId))
      .set('Idempotency-Key', randomUUID())
      .send(body);

  /** A request inserted through the real folio allocator. */
  async function create(
    over: Record<string, unknown> = {},
    tenantId: string = tenantA,
  ): Promise<{ id: string; customerKey: string; folio: number }> {
    const customerKey =
      (over.customerKey as string) ??
      `52554100${String(++seq).padStart(4, '0')}`;
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
              conversationRef: `wa:${customerKey}`,
              source: 'chatbot',
              sourceRequestId: randomUUID(),
              slaPolicyVersion: 0,
              ...over,
              customerKey,
            } as never,
          });
          await refreshCustomerGroup(tx, tenantId, customerKey);
          return created;
        }),
    );
    return { id: row.id, customerKey, folio: row.folio };
  }

  /** Held by `userId` since `claimedAt`, with the resolve clock of the claim. */
  async function claimed(
    userId: string,
    name: string,
    claimedAt: Date,
  ): Promise<{ id: string; folio: number }> {
    const made = await create({
      createdAt: claimedAt,
      status: 'IN_PROGRESS',
      assigneeUserId: userId,
      assigneeDisplayName: name,
      claimedAt,
    });
    const columns = await slaColumnsForTransition(
      root as unknown as RawDb,
      tenantA,
      made.id,
      'IN_PROGRESS',
      claimedAt,
    );
    await prisma.chatbotRequest.update({
      where: { id: made.id },
      data: {
        claimDeadlineAt: null,
        resolveDeadlineAt: columns?.resolveDeadlineAt ?? null,
        slaPolicyVersion: columns?.slaPolicyVersion,
        nextSlaCheckAt: columns?.nextSlaCheckAt ?? null,
      },
    });
    return made;
  }

  const notice = (
    userId: string,
    over: {
      type?: string;
      requestId?: string | null;
      payload?: object;
      tenantId?: string;
      createdAt?: Date;
      readAt?: Date | null;
    } = {},
  ) =>
    prisma.notification.create({
      data: {
        tenantId: over.tenantId ?? tenantA,
        userId,
        type: over.type ?? 'REQUEST_CREATED',
        requestId: over.requestId === undefined ? null : over.requestId,
        payload: over.payload ?? {},
        dedupKey: randomUUID(),
        ...(over.createdAt ? { createdAt: over.createdAt } : {}),
        ...(over.readAt ? { readAt: over.readAt } : {}),
      },
      select: { id: true },
    });

  // ------------------------------------------------ 1 + 2: sweep notices

  describe('overdue and 80 % notices from the real sweep: folio, subtype, cause, reason, requestOpen', () => {
    const claimedAt = at('2030-01-07T09:00:00-06:00'); // Monday, resolve 120 min
    let early: { id: string; folio: number };
    let byAna: { id: string; folio: number };
    let byBoth: { id: string; folio: number };

    beforeAll(async () => {
      // 80 % of 120 min is 10:36: swept at 10:40 it is an ESCALATION notice.
      early = await claimed(u.ana, 'Ana', claimedAt);
      await sweepAt(at('2030-01-07T10:40:00-06:00'));
      await drain();
      // The others are swept after their deadline (11:00): REQUEST_OVERDUE.
      byAna = await claimed(u.ana, 'Ana', claimedAt);
      byBoth = await claimed(u.both, 'Both', claimedAt);
      await sweepAt(at('2030-01-07T14:00:00-06:00'));
      await drain();
    }, 60_000);

    it('the assignee gets reason ASSIGNEE and an escalation holder gets ESCALATION on the same overdue notice', async () => {
      const [mine] = await itemsFor(u.ana, byAna.id);
      expect(mine).toMatchObject({
        type: 'REQUEST_OVERDUE',
        title: 'Solicitud vencida',
        requestId: byAna.id,
        folio: folioText(byAna.folio),
        subtype: 'UNKNOWN_QUESTION',
        cause: null,
        reason: 'ASSIGNEE',
        requestOpen: true,
      });
      expect(Object.keys(mine).sort()).toEqual(ITEM_KEYS);

      const [escalation] = await itemsFor(u.esc, byAna.id);
      expect(escalation).toMatchObject({
        type: 'REQUEST_OVERDUE',
        reason: 'ESCALATION',
        folio: folioText(byAna.folio),
        requestOpen: true,
      });
      // `both` holds escalation but is not the assignee of this one
      const [viaGrant] = await itemsFor(u.both, byAna.id);
      expect(viaGrant).toMatchObject({ reason: 'ESCALATION' });
    });

    it('a person who is assignee AND escalation holder gets ONE notice, with ASSIGNEE', async () => {
      const own = await itemsFor(u.both, byBoth.id);
      expect(own).toHaveLength(1);
      expect(own[0]).toMatchObject({
        type: 'REQUEST_OVERDUE',
        reason: 'ASSIGNEE',
      });
      const [other] = await itemsFor(u.esc, byBoth.id);
      expect(other).toMatchObject({ reason: 'ESCALATION' });
    });

    it('someone with neither role in the request gets nothing', async () => {
      expect(await itemsFor(u.boss, byAna.id)).toEqual([]);
      expect(await itemsFor(u.ana, byBoth.id)).toEqual([]);
    });

    it('the 80 % notice (REQUEST_ESCALATION) carries the reason too', async () => {
      // the request went overdue later in the same test run: take the 80 % ones
      const items = (await itemsFor(u.ana, early.id)).concat(
        await itemsFor(u.esc, early.id),
      );
      const eighty = items.filter((i) => i.type === 'REQUEST_ESCALATION');
      expect(eighty.map((i) => i.reason).sort()).toEqual([
        'ASSIGNEE',
        'ESCALATION',
      ]);
      for (const item of eighty) {
        expect(item).toMatchObject({
          title: 'Solicitud por vencer',
          folio: folioText(early.folio),
        });
      }
    });

    it('types that are not escalations never have a reason', async () => {
      const made = await create();
      await notice(u.ana, {
        type: 'REQUEST_CREATED',
        requestId: made.id,
        payload: { folio: made.folio, subtype: 'UNKNOWN_QUESTION' },
      });
      const [item] = await itemsFor(u.ana, made.id);
      expect(item).toMatchObject({
        reason: null,
        cause: null,
        folio: folioText(made.folio),
        requestOpen: true,
      });
    });
  });

  // ------------------------------------------------------- 4: merge cause

  it('a real merge tells the assignee of the source with cause MERGED, and the source is no longer open', async () => {
    const customerKey = `52554200${String(++seq).padStart(4, '0')}`;
    const source = await create({
      customerKey,
      status: 'IN_PROGRESS',
      assigneeUserId: u.ana,
      assigneeDisplayName: 'Ana',
      claimedAt: new Date(),
    });
    const target = await create({ customerKey });
    await post(`/chatbot-requests/${source.id}/merge`, {
      expectedVersion: 1,
      intoRequestId: target.id,
      intoExpectedVersion: 1,
    }).expect(200);
    await drain();

    const [item] = await itemsFor(u.ana, source.id);
    expect(item).toMatchObject({
      type: 'REQUEST_CANCELLED',
      title: 'Otra persona la unió con otra solicitud del cliente',
      folio: folioText(source.folio),
      subtype: 'UNKNOWN_QUESTION',
      cause: 'MERGED',
      reason: null,
      requestOpen: false,
    });
    // the person who merged is never told
    expect(await itemsFor(u.boss, source.id)).toEqual([]);
  });

  // ---------------------------------------------------- 3: requestOpen

  describe('requestOpen', () => {
    it('flips to false after the request is resolved, and a read does not change it', async () => {
      const key = `52554300${String(++seq).padStart(4, '0')}`;
      const phone = key.slice(2);
      const zip = String(80_000 + ++seq);
      const validation = await prisma.deliveryZoneValidation.create({
        data: {
          tenantId: tenantA,
          zipCode: zip,
          state: 'CDMX',
          municipality: 'Cuauhtémoc',
          neighborhood: 'Centro',
          branchName: 'Centro',
        },
      });
      const wrapped = await prisma.deliveryZoneRequest.create({
        data: {
          tenantId: tenantA,
          source: 'chatbot',
          sourceRequestId: randomUUID(),
          canonicalRequestHash: 'h',
          submittedCredentialId: 'cred',
          validationId: validation.id,
          branchName: 'Centro',
          zipCode: zip,
          state: 'CDMX',
          municipality: 'Cuauhtémoc',
          neighborhood: 'Centro',
          customerPhoneCountryCode: '52',
          customerPhone: phone,
          conversationRef: `wa:${key}`,
          lastCustomerMessageAt: new Date(),
        },
      });
      const zone = await create({
        customerKey: key,
        kind: 'DECISION',
        subtype: 'DELIVERY_ZONE',
        deliveryZoneRequestId: wrapped.id,
        phoneCountryCode: '52',
        phone,
      });
      const made = await notice(u.ana, {
        requestId: zone.id,
        payload: { folio: zone.folio, subtype: 'DELIVERY_ZONE' },
      });

      expect((await itemsFor(u.ana, zone.id))[0].requestOpen).toBe(true);
      await http()
        .post(`/notifications/${made.id}/read`)
        .set(as(u.ana))
        .expect(200);
      expect((await itemsFor(u.ana, zone.id))[0]).toMatchObject({
        requestOpen: true,
      });

      const impact = await http()
        .get(`/chatbot-requests/${zone.id}/zone-impact`)
        .set(as(u.boss))
        .expect(200);
      await post(`/chatbot-requests/${zone.id}/resolve`, {
        expectedVersion: 1,
        action: 'REJECT_DELIVERY_ZONE',
        expectedZoneSetVersion: impact.body.setVersion,
      }).expect(200);

      expect((await itemsFor(u.ana, zone.id))[0].requestOpen).toBe(false);
      // `unread=true` and the item for a closed request still list the same way
      expect((await list(u.ana, 'unread=true&limit=50')).items).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: made.id })]),
      );
    });

    it('is true for IN_PROGRESS and false for a cancelled request', async () => {
      const held = await create({
        status: 'IN_PROGRESS',
        assigneeUserId: u.ana,
        assigneeDisplayName: 'Ana',
        claimedAt: new Date(),
      });
      const closedAt = new Date();
      const gone = await create({
        status: 'CANCELLED',
        cancelReason: 'CUSTOMER_WITHDREW',
        cancelledAt: closedAt,
        closedAt,
      });
      await notice(u.ana, { requestId: held.id, payload: { folio: 1 } });
      await notice(u.ana, { requestId: gone.id, payload: { folio: 2 } });
      expect((await itemsFor(u.ana, held.id))[0].requestOpen).toBe(true);
      expect((await itemsFor(u.ana, gone.id))[0].requestOpen).toBe(false);
    });

    it('is null without a request id, when the request is gone, and for another sucursal’s request (tenant scoped)', async () => {
      const foreignOpen = await create({}, tenantB);
      const noRequest = await notice(u.ana, { payload: { folio: 3 } });
      const missing = await notice(u.ana, {
        requestId: randomUUID(),
        payload: { folio: 4 },
      });
      const crossTenant = await notice(u.ana, {
        requestId: foreignOpen.id,
        payload: { folio: 5 },
      });
      const items = (await list(u.ana)).items;
      const by = (id: string) => items.find((i) => i.id === id);
      expect(by(noRequest.id)).toMatchObject({
        requestId: null,
        requestOpen: null,
      });
      expect(by(missing.id)).toMatchObject({ requestOpen: null });
      expect(by(crossTenant.id)).toMatchObject({ requestOpen: null });
    });

    it('costs no extra statement per row: one statement serves the whole page', async () => {
      const buyer = randomUUID();
      extraUsers.push(buyer);
      await prisma.user.create({
        data: {
          id: buyer,
          email: `n1-${buyer}@s10.test`,
          hashedPassword: 'x',
          name: 'n1',
        },
      });
      await prisma.tenantMembership.create({
        data: {
          userId: buyer,
          tenantId: tenantA,
          roleId: (
            await prisma.role.findFirstOrThrow({
              where: { tenantId: tenantA, name: { startsWith: 'Atiende ' } },
            })
          ).id,
        },
      });
      for (let i = 0; i < 12; i += 1) {
        const made = await create();
        await notice(buyer, {
          requestId: made.id,
          payload: { folio: made.folio, subtype: 'UNKNOWN_QUESTION' },
        });
      }
      log.length = 0;
      const page = await list(buyer, 'limit=50');
      expect(page.items).toHaveLength(12);
      expect(page.items.every((i) => i.requestOpen === true)).toBe(true);
      const touching = log.filter(
        (q) => q.includes('notifications') || q.includes('chatbot_requests'),
      );
      // the list statement, nothing per row (the page itself is one query)
      expect(touching).toHaveLength(1);
      expect(touching[0]).toContain('chatbot_requests');
    });

    it('keyset paging and the unread filter still work with the join', async () => {
      const pager = randomUUID();
      extraUsers.push(pager);
      await prisma.user.create({
        data: {
          id: pager,
          email: `pager-${pager}@s10.test`,
          hashedPassword: 'x',
          name: 'pager',
        },
      });
      const base = at('2030-02-01T10:00:00Z').getTime();
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const made = await notice(pager, {
          createdAt: new Date(base + (i % 2 === 0 ? 0 : i) * 1000),
          readAt: i === 0 ? new Date() : null,
        });
        ids.push(made.id);
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard += 1) {
        const page = await list(
          pager,
          `limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        );
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect([...seen].sort()).toEqual([...ids].sort());
      expect(new Set(seen).size).toBe(5);
      const unread = await list(pager, 'unread=true&limit=50');
      expect(unread.items).toHaveLength(4);
    });
  });

  // -------------------------------------------------- 1: older rows

  it('rows written before these fields existed list with nulls and never fail', async () => {
    const bare = await notice(u.ana, { payload: {} });
    const partial = await notice(u.ana, {
      type: 'REQUEST_CANCELLED',
      payload: { folio: 11, subtype: 'COMPLAINT' },
    });
    const oldEscalation = await notice(u.ana, {
      type: 'REQUEST_OVERDUE',
      payload: { folio: 12, subtype: 'COMPLAINT' },
    });
    const items = (await list(u.ana)).items;
    const by = (id: string) => items.find((i) => i.id === id)!;
    expect(by(bare.id)).toMatchObject({
      folio: null,
      subtype: null,
      cause: null,
      reason: null,
      requestOpen: null,
    });
    expect(by(partial.id)).toMatchObject({
      title: 'El cliente canceló la solicitud',
      folio: folioText(11),
      subtype: 'COMPLAINT',
      cause: null,
    });
    expect(by(oldEscalation.id)).toMatchObject({ reason: null });
  });

  // -------------------------------------------- 5: list ↔ SSE payload parity

  it('the list item and the notification.created payload have the same keys and values', async () => {
    const reader = new PrismaNotificationEventReader(tenantPrisma);
    const items = (await list(u.ana)).items;
    expect(items.length).toBeGreaterThan(5);
    const wanted = items.map((item) => ({ userId: u.ana, id: item.id }));
    const { views, viaEvent } = await cls.runWith(
      { tenantId: tenantA, userId: 'test', isSuperAdmin: false },
      async () => ({
        views: await reader.views(wanted),
        viaEvent: await Promise.all(
          items.slice(0, 8).map((item) => service.eventView(u.ana, item.id)),
        ),
      }),
    );
    expect(views.size).toBe(items.length);
    for (const item of items) {
      const view = views.get(item.id);
      expect(Object.keys(view ?? {}).sort()).toEqual(ITEM_KEYS);
      // the stream sends JSON: compare what the client receives
      expect(JSON.parse(JSON.stringify(view))).toEqual(item);
    }
    viaEvent.forEach((event, index) => {
      expect(JSON.parse(JSON.stringify(event?.notification))).toEqual(
        items[index],
      );
    });
  });
});
