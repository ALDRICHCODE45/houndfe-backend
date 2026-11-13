/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- supertest response bodies are untyped JSON */
/**
 * human-intervention / unit 14, part 2 — scheduled conversations end to end
 * through HTTP against REAL PostgreSQL (bot contract "Scheduled conversations
 * (unit 14)", proposal §4.9, S19, S20):
 *
 *   slots route → booking (seat taken in the insert's transaction) →
 *   reschedule (bot and staff) → cancel / merge (seat released or kept) →
 *   claim guard → staff inbox fields → `scheduledRequest` on the state routes.
 *
 * The branch is open around the clock in these tests so that the real clock
 * never decides the outcome; times come from the slots route or from the
 * block grid, never from a hard-coded date.
 */
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import { createHash, randomUUID } from 'crypto';
import { ClsModule, ClsService } from 'nestjs-cls';
import request from 'supertest';
import { integrationPrisma } from '../../test/integration/reset-db';
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
  CONVERSATION_MIRROR_STORE,
  ConversationMirrorService,
} from '../conversations/application/conversation-mirror.service';
import { PrismaConversationMirrorStore } from '../conversations/infrastructure/prisma-conversation-mirror.store';
import { BotConversationController } from '../conversations/presentation/bot-conversation.controller';
import { defaultSettings } from '../chatbot-settings/domain/chatbot-attention-settings';
import { InsufficientPermissionsError } from '../shared/domain/domain-error';
import { createAppValidationPipe } from '../shared/listing/app-validation.pipe';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { PrismaService } from '../shared/prisma/prisma.service';
import { NOTICE_NOTIFY_EVENT_TYPE } from '../notifications/domain/chatbot-request-notice';
import { RealtimeModule } from '../shared/realtime/realtime.module';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { WEEKDAYS } from '../shipping/pickup/domain/opening-hours';
import {
  BOT_INTAKE_STORE,
  BotRequestIntakeService,
  LEGACY_INTAKE,
} from './application/bot-request-intake.service';
import {
  CHATBOT_FEED_STORE,
  ChatbotFeedService,
  FEED_CLOCK,
  FEED_WAKEUP,
} from './application/chatbot-feed.service';
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
  CHATBOT_REQUEST_RELATION_STORE,
  ChatbotRequestRelationsService,
} from './application/chatbot-request-relations.service';
import {
  SCHEDULING_STORE,
  SchedulingService,
} from './application/scheduling.service';
import { CustomerKeySealer } from './domain/customer-key-sealer';
import { ChatbotRequestWrapper } from './infrastructure/chatbot-request-wrapper';
import { PgFeedWakeup } from './infrastructure/feed-wakeup';
import { PrismaBotIntakeStore } from './infrastructure/prisma-bot-intake.store';
import { PrismaChatbotFeedStore } from './infrastructure/prisma-chatbot-feed.store';
import { PrismaChatbotRequestCommandStore } from './infrastructure/prisma-chatbot-request-command.store';
import { PrismaChatbotRequestReadStore } from './infrastructure/prisma-chatbot-request-read.store';
import { PrismaChatbotRequestRelationStore } from './infrastructure/prisma-chatbot-request-relation.store';
import { PrismaLiveConversationStore } from './infrastructure/prisma-live-conversation.store';
import { PrismaSchedulingStore } from './infrastructure/prisma-scheduling.store';
import {
  ScheduleSweepStore,
  type ScheduleDueCursor,
} from './infrastructure/schedule-sweep.store';
import { ScheduleSweepScheduler } from './infrastructure/schedule-sweep.scheduler';
import { flagUnbookableSchedules } from './infrastructure/scheduled-reschedule-flag';
import { PrismaSlaPauseReader } from './infrastructure/prisma-sla-pause.reader';
import { BotFeedController } from './presentation/bot-feed.controller';
import { BotRequestsController } from './presentation/bot-requests.controller';
import { BotSchedulingController } from './presentation/bot-scheduling.controller';
import { ChatbotRequestCommandsController } from './presentation/chatbot-request-commands.controller';
import { ChatbotRequestHttpFilter } from './presentation/chatbot-request-http.filter';
import { ChatbotRequestReadsController } from './presentation/chatbot-request-reads.controller';
import { ChatbotRequestRelationsController } from './presentation/chatbot-request-relations.controller';
import { ChatbotRequestSchedulingController } from './presentation/chatbot-request-scheduling.controller';
import { BotLiveConversationController } from './presentation/live-conversation.controller';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

type Grant = [AppActions, AppSubjects];
const READ_UPDATE: Grant[] = [
  ['read', 'ChatbotRequest'],
  ['update', 'ChatbotRequest'],
];
const ROLES: Record<string, Grant[]> = {
  attendee: READ_UPDATE,
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

const SECRET = 'integration-secret-of-some-length';
const MIN = 60_000;
const ZONE = 'America/Mexico_City';
const AT = new Date().toISOString();

/** The branch's local calendar date (`YYYY-MM-DD`) of an instant. */
const localDate = (instant: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);

describeIfDb('scheduled conversations (PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const sealer = new CustomerKeySealer(SECRET);
  let app: INestApplication;
  const tenants: string[] = [];
  const credentials: string[] = [];
  const users = { ana: randomUUID() };
  let seq = 0;

  beforeAll(async () => {
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
        ChatbotRequestRelationsController,
        ChatbotRequestReadsController,
        BotFeedController,
        BotLiveConversationController,
        BotConversationController,
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
        ScheduleSweepStore,
        ScheduleSweepScheduler,
        ChatbotRequestCommandsService,
        ChatbotRequestRelationsService,
        {
          provide: CHATBOT_REQUEST_RELATION_STORE,
          useClass: PrismaChatbotRequestRelationStore,
        },
        ChatbotRequestReadsService,
        ChatbotFeedService,
        ConversationMirrorService,
        PrismaLiveConversationStore,
        PgFeedWakeup,
        { provide: FEED_WAKEUP, useExisting: PgFeedWakeup },
        { provide: FEED_CLOCK, useValue: Date.now },
        {
          provide: CHATBOT_REQUEST_COMMAND_STORE,
          useClass: PrismaChatbotRequestCommandStore,
        },
        {
          provide: CHATBOT_REQUEST_READ_STORE,
          useClass: PrismaChatbotRequestReadStore,
        },
        { provide: CHATBOT_FEED_STORE, useClass: PrismaChatbotFeedStore },
        {
          provide: CONVERSATION_MIRROR_STORE,
          useClass: PrismaConversationMirrorStore,
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
    await prisma.user.create({
      data: {
        id: users.ana,
        email: `${users.ana}@sched.test`,
        hashedPassword: 'x',
        name: 'Ana García',
      },
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await prisma.serviceRateBucket.deleteMany({
      where: { credentialId: { in: credentials } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.user.deleteMany({ where: { id: users.ana } });
  });

  // -------------------------------------------------------------- helpers

  interface BranchOptions {
    /** `false`: no settings row at all (scheduling off, the default). */
    settings?: boolean;
    enabled?: boolean;
    max?: number;
    offered?: number;
    closedDates?: string[];
    scopes?: string[];
  }

  async function branch(options: BranchOptions = {}) {
    const id = randomUUID();
    tenants.push(id);
    await prisma.tenant.create({
      data: { id, name: 'Sucursal Agenda', slug: `cr-sched-${id}` },
    });
    const token = `svc_${randomUUID()}`;
    const credential = await prisma.serviceCredential.create({
      data: {
        tenantId: id,
        name: 'bot',
        hashedKey: createHash('sha256').update(token).digest('hex'),
        scopes: options.scopes ?? [
          'requests:create',
          'requests:read',
          'requests:cancel',
          'feed:read',
          'feed:ack',
          'conversation:write',
        ],
        rateLimit: 600,
      },
    });
    credentials.push(credential.id);
    if (options.settings !== false) {
      await prisma.chatbotAttentionSettings.create({
        data: {
          tenantId: id,
          version: 1,
          timeZone: ZONE,
          days: WEEKDAYS.map((day) => ({
            day,
            ranges: [{ open: '00:00', close: '23:59' }],
          })) as unknown as Prisma.InputJsonArray,
          closedDates: options.closedDates ?? [],
          slas: defaultSettings().slas as unknown as Prisma.InputJsonArray,
          windowWarningMinutes: 120,
          templateCostText: 'x',
          enabledSubtypes: [],
          receiptCloseMarginMinutes: 60,
          schedulingEnabled: options.enabled ?? true,
          slotMinutes: 30,
          slotsOffered: options.offered ?? 3,
          maxScheduledPerSlot: options.max ?? 3,
        },
      });
    }
    return { tenantId: id, token, folio: 0 };
  }
  type Branch = Awaited<ReturnType<typeof branch>>;

  const server = () => request(app.getHttpServer());
  const asBot = (b: Branch, req: request.Test) =>
    req
      .set('Authorization', `Bearer ${b.token}`)
      .set('X-Branch-Id', b.tenantId);
  const as = (b: Branch, role = 'attendee') => ({
    'x-test-role': role,
    'x-test-tenant': b.tenantId,
    'x-test-user': users.ana,
  });

  const customerOf = () => {
    const n = ++seq;
    return {
      phoneCountryCode: '52',
      phone: `55${String(20000000 + n)}`,
      key: `5255${20000000 + n}`,
      ref: `wa:5255${20000000 + n}`,
    };
  };
  type Customer = ReturnType<typeof customerOf>;

  const slotsOf = (b: Branch, ref: string, extra = '') =>
    asBot(
      b,
      server().get(
        `/chatbot-api/scheduling/slots?conversationRef=${encodeURIComponent(ref)}${extra}`,
      ),
    );

  const bookBody = (
    c: Customer,
    scheduledFor: string | null,
    over: Record<string, unknown> = {},
  ) => ({
    sourceRequestId: randomUUID(),
    subtype: 'TALK_TO_HUMAN',
    customer: { phoneCountryCode: c.phoneCountryCode, phone: c.phone },
    conversationRef: c.ref,
    lastCustomerMessageAt: new Date(Date.now() - 10 * MIN).toISOString(),
    summary: 'Quiere hablar con una persona',
    ...(scheduledFor ? { scheduledFor } : {}),
    ...over,
  });
  const create = (b: Branch, body: { sourceRequestId: string }) =>
    asBot(
      b,
      server()
        .post('/chatbot-api/requests')
        .set('X-Idempotency-Key', body.sourceRequestId),
    ).send(body);
  const book = (
    b: Branch,
    c: Customer,
    scheduledFor: string,
    over: Record<string, unknown> = {},
  ) => create(b, bookBody(c, scheduledFor, over));

  /** The first offered block of the branch, for this chat. */
  async function firstSlot(b: Branch, c: Customer, skip = 0): Promise<string> {
    const { body } = await slotsOf(b, c.ref).expect(200);
    return body.slots[skip].startsAt;
  }
  async function bookOk(
    b: Branch,
    c: Customer,
    over: Record<string, unknown> = {},
    skip = 0,
  ) {
    const startsAt = await firstSlot(b, c, skip);
    const res = await book(b, c, startsAt, over).expect(201);
    return { id: res.body.id as string, startsAt, body: res.body };
  }

  const reschedule = (
    b: Branch,
    id: string,
    body: object,
    key: string | null = randomUUID(),
  ) => {
    const call = asBot(
      b,
      server().post(`/chatbot-api/requests/${id}/reschedule`),
    );
    if (key) call.set('X-Idempotency-Key', key);
    return call.send(body);
  };
  const cancel = (b: Branch, id: string) =>
    asBot(
      b,
      server()
        .post(`/chatbot-api/requests/${id}/cancel`)
        .set('X-Idempotency-Key', randomUUID()),
    ).send({ reason: 'CUSTOMER_WITHDREW', triggerWaMessageId: 'wamid.c' });
  const staffPost = (
    b: Branch,
    path: string,
    body: object,
    opts: { role?: string; key?: string } = {},
  ) =>
    server()
      .post(path)
      .set(as(b, opts.role))
      .set('Idempotency-Key', opts.key ?? randomUUID())
      .send(body);
  const staffReschedule = (
    b: Branch,
    id: string,
    version: number,
    scheduledFor: string,
    opts: { role?: string; key?: string } = {},
  ) =>
    staffPost(
      b,
      `/chatbot-requests/${id}/reschedule`,
      { expectedVersion: version, scheduledFor },
      opts,
    );
  const detail = (b: Branch, id: string) =>
    server().get(`/chatbot-requests/${id}`).set(as(b));
  const state = (b: Branch, ref: string) =>
    asBot(
      b,
      server().get(
        `/chatbot-api/conversations/${encodeURIComponent(ref)}/state`,
      ),
    );

  const row = (id: string) =>
    prisma.chatbotRequest.findUniqueOrThrow({ where: { id } });
  const booked = async (b: Branch, startsAt: string) =>
    (
      await prisma.scheduledSlotCounter.findUnique({
        where: {
          tenantId_startsAt: {
            tenantId: b.tenantId,
            startsAt: new Date(startsAt),
          },
        },
      })
    )?.booked ?? 0;
  const eventsOf = (id: string, type?: string) =>
    prisma.chatbotRequestEvent.findMany({
      where: { requestId: id, ...(type ? { type: type as 'CREATED' } : {}) },
      orderBy: { createdAt: 'asc' },
    });
  const feedOf = (b: Branch, id: string, type: string) =>
    prisma.chatbotFeedItem.findMany({
      where: { tenantId: b.tenantId, requestId: id, type },
      orderBy: { cursor: 'asc' },
    });
  const mirrorIn = (b: Branch, ref: string) => {
    const now = new Date().toISOString();
    return asBot(
      b,
      server().post(
        `/chatbot-api/conversations/${encodeURIComponent(ref)}/messages:batch`,
      ),
    ).send({
      messages: [
        {
          waMessageId: `wamid.in.${randomUUID()}`,
          direction: 'IN',
          type: 'TEXT',
          text: 'Hola',
          providerTimestamp: now,
          observedAt: now,
        },
      ],
    });
  };
  /** A request with no schedule (the unit 11 out-of-hours create). */
  async function plainRequest(b: Branch, c: Customer) {
    const created = await prisma.chatbotRequest.create({
      data: {
        tenantId: b.tenantId,
        folio: 1000 + ++b.folio,
        kind: 'CONVERSATION',
        subtype: 'TALK_TO_HUMAN',
        customerKey: c.key,
        conversationRef: c.ref,
        summary: 'Quiere hablar con una persona',
        source: 'chatbot',
        sourceRequestId: randomUUID(),
        lastCustomerMessageAt: new Date(),
        whatsappWindowClosesAt: new Date(Date.now() + 23 * 60 * MIN),
      },
    });
    return created.id;
  }

  // ------------------------------------------------------------ 1. slots

  describe('GET /chatbot-api/scheduling/slots', () => {
    it('is 422 SCHEDULING_DISABLED when the branch has scheduling off (or no settings)', async () => {
      const off = await branch({ enabled: false });
      const none = await branch({ settings: false });
      for (const b of [off, none]) {
        const res = await slotsOf(b, customerOf().ref).expect(422);
        expect(res.body).toMatchObject({
          statusCode: 422,
          code: 'SCHEDULING_DISABLED',
        });
        expect(res.headers['cache-control']).toBe('no-store');
      }
    });

    it('lists the next free blocks with businessHours, weekly ranges and closed dates', async () => {
      const b = await branch({ closedDates: ['2099-12-25'] });
      const c = customerOf();
      const before = Date.now();
      // the customer wrote 10 min ago (an unknown time is a closed window)
      const wrote = before - 10 * MIN;
      const { body } = await slotsOf(
        b,
        c.ref,
        `&lastCustomerMessageAt=${encodeURIComponent(new Date(wrote).toISOString())}`,
      ).expect(200);
      expect(body.timeZone).toBe(ZONE);
      expect(body.slots).toHaveLength(3);
      for (const slot of body.slots) {
        expect(slot).toEqual({
          startsAt: expect.any(String),
          withinWindow: true,
          available: true,
        });
        const at = new Date(slot.startsAt).getTime();
        expect(at).toBeGreaterThanOrEqual(before + 10 * MIN);
        expect(at % (30 * MIN)).toBe(0);
      }
      const starts = body.slots.map((s: any) => Date.parse(s.startsAt));
      expect(starts).toEqual([...starts].sort((x, y) => x - y));
      expect(Date.parse(body.whatsappWindowClosesAt)).toBe(
        wrote + 24 * 60 * MIN,
      );
      expect(body.businessHours).toMatchObject({
        openNow: true,
        timeZone: ZONE,
        closedDates: [],
      });
      expect(body.businessHours.nextOpenAt).toEqual(expect.any(String));
      expect(body.businessHours.weeklyRanges).toHaveLength(7);
      expect(body.businessHours.weeklyRanges[0]).toEqual({
        day: 'MONDAY',
        ranges: [{ open: '00:00', close: '23:59' }],
      });
    });

    it('honours slotsOffered and skips closed dates (listing them for the next 14 days)', async () => {
      const today = localDate(new Date());
      const tomorrow = localDate(new Date(Date.now() + 24 * 60 * MIN));
      const b = await branch({ offered: 2, closedDates: [today, tomorrow] });
      const { body } = await slotsOf(b, customerOf().ref).expect(200);
      expect(body.slots).toHaveLength(2);
      for (const slot of body.slots) {
        expect([today, tomorrow]).not.toContain(
          localDate(new Date(slot.startsAt)),
        );
      }
      expect(body.businessHours.openNow).toBe(false);
      expect(body.businessHours.closedDates).toEqual([today, tomorrow].sort());
    });

    it('skips a full block', async () => {
      const b = await branch({ max: 1 });
      const first = customerOf();
      const { startsAt } = await bookOk(b, first);
      const { body } = await slotsOf(b, customerOf().ref).expect(200);
      expect(body.slots.map((s: any) => s.startsAt)).not.toContain(startsAt);
      expect(body.slots).toHaveLength(3);
    });

    it('validates the query and the scope', async () => {
      const b = await branch();
      await asBot(b, server().get('/chatbot-api/scheduling/slots')).expect(400);
      await slotsOf(
        b,
        customerOf().ref,
        `&lastCustomerMessageAt=${new Date(Date.now() - 31 * 86_400_000).toISOString()}`,
      ).expect(400);
      await slotsOf(
        b,
        customerOf().ref,
        `&lastCustomerMessageAt=${new Date(Date.now() + 30 * MIN).toISOString()}`,
      ).expect(400);
      const noScope = await branch({ scopes: ['requests:create'] });
      await slotsOf(noScope, customerOf().ref).expect(403);
    });

    it('a customer message older than 24 h puts every offered block outside the free window', async () => {
      const b = await branch();
      const old = new Date(Date.now() - 23 * 60 * MIN - 50 * MIN).toISOString();
      const { body } = await slotsOf(
        b,
        customerOf().ref,
        `&lastCustomerMessageAt=${encodeURIComponent(old)}`,
      ).expect(200);
      expect(body.slots.length).toBeGreaterThan(0);
      // 23 h 50 min old: the window closes in 10 min, no block keeps its greeting free
      expect(body.slots.every((s: any) => s.withinWindow === false)).toBe(true);
    });

    it('with no customer message time known anywhere the window is closed now (bot and staff picker)', async () => {
      const b = await branch();
      const c = customerOf();
      const before = Date.now();
      const bot = await slotsOf(b, c.ref).expect(200);
      expect(bot.body.slots.length).toBeGreaterThan(0);
      expect(bot.body.slots.every((s: any) => s.withinWindow === false)).toBe(
        true,
      );
      expect(Date.parse(bot.body.whatsappWindowClosesAt)).toBeLessThanOrEqual(
        Date.now(),
      );
      expect(
        Date.parse(bot.body.whatsappWindowClosesAt),
      ).toBeGreaterThanOrEqual(before - 1_000);

      // a request that never learned the time, and a chat the mirror never saw
      const created = await prisma.chatbotRequest.create({
        data: {
          tenantId: b.tenantId,
          folio: 1000 + ++b.folio,
          kind: 'CONVERSATION',
          subtype: 'TALK_TO_HUMAN',
          customerKey: c.key,
          conversationRef: c.ref,
          summary: 'Quiere hablar con una persona',
          source: 'chatbot',
          sourceRequestId: randomUUID(),
        },
      });
      const picker = await server()
        .get(`/chatbot-requests/${created.id}/scheduling/slots`)
        .set(as(b, 'reader'))
        .expect(200);
      expect(picker.body.slots.length).toBeGreaterThan(0);
      expect(
        picker.body.slots.every((s: any) => s.withinWindow === false),
      ).toBe(true);
    });
  });

  // ---------------------------------------------------------- 2. booking

  describe('POST /chatbot-api/requests with scheduledFor', () => {
    it('takes the seat in the same transaction and answers the scheduled shape', async () => {
      const b = await branch();
      const c = customerOf();
      const startsAt = await firstSlot(b, c);
      const res = await book(b, c, startsAt).expect(201);
      expect(res.body).toMatchObject({
        status: 'NEW',
        outcome: 'CREATED',
        mergedIntoId: null,
        scheduledFor: startsAt,
        scheduleVersion: 1,
        requiresTemplateAtStart: false,
        whatsappWindowClosesAt: expect.any(String),
        businessHours: { openNow: true, timeZone: ZONE },
      });
      expect(await booked(b, startsAt)).toBe(1);
      const stored = await row(res.body.id);
      expect(stored.scheduledFor?.toISOString()).toBe(startsAt);
      expect(stored.scheduleVersion).toBe(1);
      expect(stored.scheduleStage).toBe(0);
      expect(stored.scheduleDueAt?.getTime()).toBe(
        new Date(startsAt).getTime() - 10 * MIN,
      );
      // the claim clock starts at scheduledFor, not at creation
      expect(stored.claimDeadlineAt!.getTime()).toBeGreaterThan(
        new Date(startsAt).getTime(),
      );
      const [created] = await eventsOf(res.body.id, 'CREATED');
      expect(created.data).toMatchObject({
        scheduledFor: startsAt,
        requiresTemplate: false,
        scheduleVersion: 1,
      });
      // "solicitud nueva" waits for scheduledFor: nothing at booking time
      expect(
        await prisma.outboxEvent.count({
          where: { tenantId: b.tenantId, eventType: 'chatbot_request.notify' },
        }),
      ).toBe(0);
    });

    it('a 2xx replay answers the same body and keeps one seat; a replay survives a later cancel', async () => {
      const b = await branch();
      const c = customerOf();
      const startsAt = await firstSlot(b, c);
      const body = bookBody(c, startsAt);
      const first = await create(b, body).expect(201);
      const replay = await create(b, body).expect(200);
      expect(replay.body).toEqual({ ...first.body, outcome: 'REPLAYED' });
      expect(await booked(b, startsAt)).toBe(1);
      await cancel(b, first.body.id).expect(200);
      const late = await create(b, body).expect(200);
      expect(late.body).toEqual({ ...first.body, outcome: 'REPLAYED' });
      expect(await booked(b, startsAt)).toBe(0);
    });

    it('rejects scheduledFor on another subtype with 400', async () => {
      const b = await branch();
      const c = customerOf();
      const startsAt = await firstSlot(b, c);
      await book(b, c, startsAt, { subtype: 'UNKNOWN_QUESTION' }).expect(400);
      expect(await booked(b, startsAt)).toBe(0);
    });

    it('is 422 SCHEDULING_DISABLED when the branch has scheduling off', async () => {
      const b = await branch({ enabled: false });
      const c = customerOf();
      const res = await book(
        b,
        c,
        new Date(
          Math.ceil((Date.now() + 40 * MIN) / (30 * MIN)) * 30 * MIN,
        ).toISOString(),
      ).expect(422);
      expect(res.body.code).toBe('SCHEDULING_DISABLED');
    });

    it('answers 409 SLOT_UNAVAILABLE with the fresh list for a bad grid, too soon, too far and a closed date', async () => {
      const today = localDate(new Date());
      const b = await branch({ closedDates: [today] });
      const c = customerOf();
      const good = await firstSlot(b, c);
      const offGrid = new Date(Date.parse(good) + 60_000).toISOString();
      const tooFar = new Date(Date.parse(good) + 15 * 86_400_000).toISOString();
      const closedToday = new Date(
        Math.ceil((Date.now() + 30 * MIN) / (30 * MIN)) * 30 * MIN,
      ).toISOString();
      const tooSoon = new Date(
        Math.floor((Date.now() + 5 * MIN) / (30 * MIN)) * 30 * MIN + 30 * MIN,
      ).toISOString();
      for (const startsAt of [offGrid, tooFar, closedToday, tooSoon]) {
        const res = await book(b, c, startsAt).expect(409);
        expect(res.body).toMatchObject({
          statusCode: 409,
          code: 'SLOT_UNAVAILABLE',
          timeZone: ZONE,
          whatsappWindowClosesAt: expect.any(String),
        });
        expect(res.body.slots.length).toBeGreaterThan(0);
        expect(res.body.slots[0]).toMatchObject({ available: true });
        expect(await booked(b, startsAt)).toBe(0);
      }
      expect(
        await prisma.chatbotRequest.count({ where: { tenantId: b.tenantId } }),
      ).toBe(0);
    });

    it('a full block is 409 SLOT_UNAVAILABLE, stores nothing, and the same sourceRequestId may book another slot', async () => {
      const b = await branch({ max: 1 });
      const first = customerOf();
      const { startsAt } = await bookOk(b, first);
      const second = customerOf();
      const body = bookBody(second, startsAt);
      const res = await create(b, body).expect(409);
      expect(res.body.code).toBe('SLOT_UNAVAILABLE');
      expect(res.body.slots.map((s: any) => s.startsAt)).not.toContain(
        startsAt,
      );
      // S20 1: the 4xx is not stored for replay
      expect(
        await prisma.chatbotBotReceipt.count({
          where: { tenantId: b.tenantId, idempotencyKey: body.sourceRequestId },
        }),
      ).toBe(0);
      expect(
        await prisma.chatbotRequest.count({
          where: {
            tenantId: b.tenantId,
            sourceRequestId: body.sourceRequestId,
          },
        }),
      ).toBe(0);
      const other = res.body.slots[0].startsAt;
      const retry = await create(b, {
        ...body,
        scheduledFor: other,
      } as any).expect(201);
      expect(retry.body.scheduledFor).toBe(other);
      expect(await booked(b, startsAt)).toBe(1);
      expect(await booked(b, other)).toBe(1);
    });

    it('one open scheduled request per customer and subtype: 409 ALREADY_SCHEDULED; a TALK and a COMPLAINT may both be booked', async () => {
      const b = await branch();
      const c = customerOf();
      const first = await bookOk(b, c);
      const again = await book(b, c, await firstSlot(b, c, 1)).expect(409);
      expect(again.body).toMatchObject({
        statusCode: 409,
        code: 'ALREADY_SCHEDULED',
        requestId: first.id,
        scheduledFor: first.startsAt,
      });
      // the failed attempt held no seat
      expect(await booked(b, await firstSlot(b, c, 1))).toBe(0);
      // the same customer written with another phone format is the same identity
      const reformatted = await book(b, c, await firstSlot(b, c, 1), {
        customer: {
          phoneCountryCode: c.phoneCountryCode,
          phone: `${c.phone.slice(0, 2)} ${c.phone.slice(2, 6)} ${c.phone.slice(6)}`,
        },
      }).expect(409);
      expect(reformatted.body.code).toBe('ALREADY_SCHEDULED');
      const complaint = await book(b, c, await firstSlot(b, c, 1), {
        subtype: 'COMPLAINT',
      }).expect(201);
      expect(complaint.body.scheduleVersion).toBe(1);
      // once the first is cancelled the customer may book TALK again
      await cancel(b, first.id).expect(200);
      await book(b, c, await firstSlot(b, c)).expect(201);
    });

    it('parallel bookings for the last seat: exactly one 2xx, the counter never passes the limit', async () => {
      const b = await branch({ max: 1 });
      const slot = await firstSlot(b, customerOf());
      const results = await Promise.all(
        Array.from({ length: 8 }, () => book(b, customerOf(), slot)),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(7);
      expect(await booked(b, slot)).toBe(1);
      expect(
        await prisma.chatbotRequest.count({
          where: { tenantId: b.tenantId, scheduledFor: new Date(slot) },
        }),
      ).toBe(1);
    });

    it('a scheduled create never merges into an open request with the same dedupKey', async () => {
      const b = await branch();
      const c = customerOf();
      const slot = await firstSlot(b, c);
      const plain = await create(
        b,
        bookBody(c, null, { dedupKey: 'hablar' }),
      ).expect(201);
      const scheduled = await book(b, c, slot, { dedupKey: 'hablar' }).expect(
        201,
      );
      expect(scheduled.body.id).not.toBe(plain.body.id);
      expect(scheduled.body.outcome).toBe('CREATED');
    });
  });

  // ------------------------------------------------------ 3. reschedule

  describe('POST /chatbot-api/requests/:id/reschedule (bot)', () => {
    it('moves the seat, bumps scheduleVersion, clears needsReschedule, audits RESCHEDULED and sends no feed item', async () => {
      const b = await branch();
      const c = customerOf();
      const { id, startsAt } = await bookOk(b, c);
      await prisma.chatbotRequest.update({
        where: { id },
        data: { needsReschedule: true },
      });
      const target = await firstSlot(b, c, 2);
      const res = await reschedule(b, id, {
        scheduledFor: target,
        triggerWaMessageId: 'wamid.re',
      }).expect(200);
      expect(res.body).toMatchObject({
        id,
        status: 'NEW',
        outcome: 'RESCHEDULED',
        scheduledFor: target,
        previousScheduledFor: startsAt,
        scheduleVersion: 2,
        requiresTemplateAtStart: false,
        whatsappWindowClosesAt: expect.any(String),
      });
      expect(await booked(b, startsAt)).toBe(0);
      expect(await booked(b, target)).toBe(1);
      const stored = await row(id);
      expect(stored.scheduledFor?.toISOString()).toBe(target);
      expect(stored.needsReschedule).toBe(false);
      expect(stored.scheduleVersion).toBe(2);
      expect(stored.scheduleDueAt?.getTime()).toBe(
        Date.parse(target) - 10 * MIN,
      );
      expect(stored.version).toBe(2);
      const [event] = await eventsOf(id, 'RESCHEDULED');
      expect(event).toMatchObject({ actorKind: 'SERVICE', version: 2 });
      expect(event.data).toMatchObject({
        from: startsAt,
        to: target,
        scheduleVersion: 2,
        triggerWaMessageId: 'wamid.re',
      });
      expect(await feedOf(b, id, 'conversation.rescheduled')).toHaveLength(0);
    });

    it('the same time is UNCHANGED: nothing moves, nothing is counted twice', async () => {
      const b = await branch();
      const { id, startsAt } = await bookOk(b, customerOf());
      const res = await reschedule(b, id, { scheduledFor: startsAt }).expect(
        200,
      );
      expect(res.body).toMatchObject({
        outcome: 'UNCHANGED',
        scheduledFor: startsAt,
        scheduleVersion: 1,
      });
      expect(await booked(b, startsAt)).toBe(1);
      expect((await row(id)).version).toBe(1);
      expect(await eventsOf(id, 'RESCHEDULED')).toHaveLength(0);
    });

    it('a full target is 409 SLOT_UNAVAILABLE and nothing changes (the old seat is kept)', async () => {
      const b = await branch({ max: 1 });
      const mine = await bookOk(b, customerOf());
      const other = await bookOk(b, customerOf());
      const res = await reschedule(b, mine.id, {
        scheduledFor: other.startsAt,
      }).expect(409);
      expect(res.body).toMatchObject({ code: 'SLOT_UNAVAILABLE' });
      expect(res.body.slots.map((s: any) => s.startsAt)).not.toContain(
        other.startsAt,
      );
      expect(await booked(b, mine.startsAt)).toBe(1);
      expect(await booked(b, other.startsAt)).toBe(1);
      const stored = await row(mine.id);
      expect(stored.scheduledFor?.toISOString()).toBe(mine.startsAt);
      expect(stored.scheduleVersion).toBe(1);
      expect(await eventsOf(mine.id, 'RESCHEDULED')).toHaveLength(0);
    });

    it('answers the contract errors: NOT_SCHEDULED, REQUEST_CLOSED, RESCHEDULE_NOT_ALLOWED, NOT_FOUND, SCHEDULING_DISABLED', async () => {
      const b = await branch();
      const c = customerOf();
      const target = await firstSlot(b, c);
      const plain = await plainRequest(b, customerOf());
      expect(
        (await reschedule(b, plain, { scheduledFor: target }).expect(409)).body
          .code,
      ).toBe('NOT_SCHEDULED');

      const closed = await bookOk(b, customerOf());
      await cancel(b, closed.id).expect(200);
      expect(
        (await reschedule(b, closed.id, { scheduledFor: target }).expect(409))
          .body.code,
      ).toBe('REQUEST_CLOSED');

      // a live session has started: only after its instant can staff claim
      const live = customerOf();
      const started = await bookOk(b, live);
      await prisma.chatbotRequest.update({
        where: { id: started.id },
        data: { scheduledFor: new Date(Date.now() + 2 * MIN) },
      });
      await mirrorIn(b, live.ref).expect(200);
      await staffPost(b, `/chatbot-requests/${started.id}/claim`, {
        expectedVersion: 1,
      }).expect(200);
      expect(
        (await reschedule(b, started.id, { scheduledFor: target }).expect(409))
          .body.code,
      ).toBe('RESCHEDULE_NOT_ALLOWED');

      await reschedule(b, randomUUID(), { scheduledFor: target }).expect(404);
      const other = await branch();
      await reschedule(other, closed.id, {
        scheduledFor: await firstSlot(other, customerOf()),
      }).expect(404);

      const off = await branch({ enabled: false });
      const offId = await plainRequest(off, customerOf());
      expect(
        (await reschedule(off, offId, { scheduledFor: target }).expect(422))
          .body.code,
      ).toBe('SCHEDULING_DISABLED');
    });

    it('is idempotent on the Idempotency-Key and validates the body', async () => {
      const b = await branch();
      const c = customerOf();
      const { id } = await bookOk(b, c);
      const target = await firstSlot(b, c, 2);
      const key = randomUUID();
      const first = await reschedule(
        b,
        id,
        { scheduledFor: target },
        key,
      ).expect(200);
      const replay = await reschedule(
        b,
        id,
        { scheduledFor: target },
        key,
      ).expect(200);
      expect(replay.body).toEqual(first.body);
      expect((await row(id)).scheduleVersion).toBe(2);
      const conflict = await reschedule(
        b,
        id,
        { scheduledFor: await firstSlot(b, c, 1) },
        key,
      ).expect(409);
      expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
      await reschedule(b, id, { scheduledFor: target }, null).expect(400);
      await reschedule(b, id, { scheduledFor: target, extra: 1 }).expect(400);
      await reschedule(b, id, {}).expect(400);
      await reschedule(b, 'not-a-uuid', { scheduledFor: target }).expect(400);
    });
  });

  describe('POST /chatbot-requests/:id/reschedule (staff)', () => {
    it('moves the seat, answers customerNotice and emits conversation.rescheduled + RESCHEDULED audit', async () => {
      const b = await branch();
      const c = customerOf();
      const { id, startsAt } = await bookOk(b, c);
      const target = await firstSlot(b, c, 2);
      const key = randomUUID();
      const res = await staffReschedule(b, id, 1, target, { key }).expect(200);
      expect(res.body.customerNotice).toEqual({ expected: true });
      expect(res.body.request).toMatchObject({
        id,
        version: 2,
        scheduledFor: target,
        previousScheduledFor: startsAt,
        scheduleVersion: 2,
        requiresTemplateAtStart: false,
      });
      expect(await booked(b, startsAt)).toBe(0);
      expect(await booked(b, target)).toBe(1);
      const [event] = await eventsOf(id, 'RESCHEDULED');
      expect(event).toMatchObject({ actorKind: 'USER', actorId: users.ana });
      expect(event.data).toMatchObject({
        from: startsAt,
        to: target,
        requiresTemplate: false,
        byUser: { id: users.ana },
      });
      const [item] = await feedOf(b, id, 'conversation.rescheduled');
      expect(item.conversationRef).toBe(c.ref);
      expect(item.payload).toMatchObject({
        requestId: id,
        scheduledFor: target,
        previousScheduledFor: startsAt,
        scheduleVersion: 2,
        timeZone: ZONE,
        requiresTemplateAtStart: false,
        whatsappWindowClosesAt: expect.any(String),
      });
      // replay of the same key: same answer, no second item
      const replay = await staffReschedule(b, id, 1, target, { key }).expect(
        200,
      );
      expect(replay.body).toEqual(res.body);
      expect(await feedOf(b, id, 'conversation.rescheduled')).toHaveLength(1);
      expect((await row(id)).scheduleVersion).toBe(2);
    });

    it('window closed: customerNotice.expected is false and the bot ACKs STALE; deferrals are 422', async () => {
      const b = await branch();
      const c = customerOf();
      const { id } = await bookOk(b, c, {
        lastCustomerMessageAt: new Date(
          Date.now() - 23 * 60 * MIN - 59 * MIN,
        ).toISOString(),
      });
      await prisma.chatbotRequest.update({
        where: { id },
        data: {
          lastCustomerMessageAt: new Date(Date.now() - 25 * 60 * MIN),
          whatsappWindowClosesAt: new Date(Date.now() - 60 * MIN),
        },
      });
      const target = await firstSlot(b, c, 2);
      const res = await staffReschedule(b, id, 1, target).expect(200);
      expect(res.body.customerNotice).toEqual({ expected: false });
      const feed = await asBot(
        b,
        server().get('/chatbot-api/feed?waitSeconds=0'),
      ).expect(200);
      const item = feed.body.items.find(
        (i: any) => i.type === 'conversation.rescheduled',
      );
      expect(item).toMatchObject({
        requestId: id,
        notBefore: null,
        expiresAt: null,
        payload: { scheduledFor: target, scheduleVersion: 2 },
      });
      const outcome = (body: object) =>
        asBot(
          b,
          server().post(`/chatbot-api/deliveries/${item.deliveryId}/outcome`),
        ).send({ attemptId: randomUUID(), attemptedAt: AT, ...body });
      expect(
        (await outcome({ outcome: 'DEFERRED_WINDOW_CLOSED' }).expect(422)).body
          .code,
      ).toBe('OUTCOME_NOT_ALLOWED');
      expect(
        (await outcome({ outcome: 'DEFERRED_HUMAN_SESSION' }).expect(422)).body
          .code,
      ).toBe('OUTCOME_NOT_ALLOWED');
      await outcome({ outcome: 'STALE' }).expect(200);
    });

    it('a booking with no known window stays requiresTemplateAtStart after a staff reschedule and expects no customer notice', async () => {
      const b = await branch();
      const c = customerOf();
      const startsAt = await firstSlot(b, c, 2);
      const booked1 = await book(b, c, startsAt).expect(201);
      const id = booked1.body.id as string;
      // the bot always sends the time, so forget it here: nothing knows it now
      await prisma.chatbotRequest.update({
        where: { id },
        data: {
          lastCustomerMessageAt: null,
          whatsappWindowClosesAt: null,
          requiresTemplateAtStart: true,
        },
      });
      const target = await firstSlot(b, c, 0);
      expect(Date.parse(target)).toBeLessThan(Date.parse(startsAt));
      const res = await staffReschedule(b, id, 1, target).expect(200);
      expect(res.body.customerNotice).toEqual({ expected: false });
      expect(res.body.request).toMatchObject({
        id,
        scheduledFor: target,
        previousScheduledFor: startsAt,
        requiresTemplateAtStart: true,
      });
      expect((await row(id)).requiresTemplateAtStart).toBe(true);
      const [event] = await eventsOf(id, 'RESCHEDULED');
      expect(event.data).toMatchObject({ requiresTemplate: true });
    });

    it('answers VERSION_CONFLICT, SLOT_UNAVAILABLE {slots}, REQUEST_CLOSED, NOT_SCHEDULED and refuses a reader', async () => {
      const b = await branch({ max: 1 });
      const c = customerOf();
      const mine = await bookOk(b, c);
      const other = await bookOk(b, customerOf());
      expect(
        (
          await staffReschedule(b, mine.id, 7, await firstSlot(b, c)).expect(
            409,
          )
        ).body.code,
      ).toBe('VERSION_CONFLICT');
      const full = await staffReschedule(b, mine.id, 1, other.startsAt).expect(
        409,
      );
      expect(full.body).toMatchObject({ code: 'SLOT_UNAVAILABLE' });
      expect(full.body.slots.length).toBeGreaterThan(0);
      expect(await booked(b, mine.startsAt)).toBe(1);
      expect((await row(mine.id)).version).toBe(1);
      const plain = await plainRequest(b, customerOf());
      expect(
        (await staffReschedule(b, plain, 1, await firstSlot(b, c)).expect(409))
          .body.code,
      ).toBe('NOT_SCHEDULED');
      await cancel(b, other.id).expect(200);
      expect(
        (
          await staffReschedule(b, other.id, 1, await firstSlot(b, c)).expect(
            409,
          )
        ).body.code,
      ).toBe('REQUEST_CLOSED');
      await staffReschedule(b, mine.id, 1, await firstSlot(b, c, 2), {
        role: 'reader',
      }).expect(403);
    });

    it('GET /chatbot-requests/:id/scheduling/slots lists up to 24 blocks for the picker', async () => {
      const b = await branch();
      const { id } = await bookOk(b, customerOf());
      const res = await server()
        .get(`/chatbot-requests/${id}/scheduling/slots`)
        .set(as(b, 'reader'))
        .expect(200);
      expect(res.body.timeZone).toBe(ZONE);
      expect(res.body.slots).toHaveLength(24);
      expect(res.body.slots[0]).toMatchObject({
        withinWindow: true,
        available: true,
      });
      await server()
        .get(`/chatbot-requests/${randomUUID()}/scheduling/slots`)
        .set(as(b))
        .expect(404);
    });
  });

  // ---------------------------------------------- 4. cancel, merge, claim

  describe('cancel, merge and claim', () => {
    it('bot cancel releases the seat and answers scheduleVersion', async () => {
      const b = await branch();
      const { id, startsAt } = await bookOk(b, customerOf());
      const res = await cancel(b, id).expect(200);
      expect(res.body).toMatchObject({
        id,
        status: 'CANCELLED',
        scheduleVersion: 2,
      });
      expect(await booked(b, startsAt)).toBe(0);
      const stored = await row(id);
      expect(stored.scheduleVersion).toBe(2);
      expect(stored.scheduleDueAt).toBeNull();
    });

    it('staff cancel releases the seat too', async () => {
      const b = await branch();
      const c = customerOf();
      const { id, startsAt } = await bookOk(b, c);
      await staffPost(b, `/chatbot-requests/${id}/cancel`, {
        expectedVersion: 1,
        reason: 'NOT_ACTIONABLE',
      }).expect(200);
      expect(await booked(b, startsAt)).toBe(0);
      expect((await row(id)).scheduleDueAt).toBeNull();
      // freed: the customer may book again
      await book(b, c, await firstSlot(b, c)).expect(201);
    });

    it('merging a request into a scheduled one keeps its single seat; a scheduled request cannot be merged away', async () => {
      const b = await branch();
      const c = customerOf();
      const target = await bookOk(b, c);
      const duplicate = await plainRequest(b, c);
      const merged = await staffPost(
        b,
        `/chatbot-requests/${duplicate}/merge`,
        {
          expectedVersion: 1,
          intoRequestId: target.id,
          intoExpectedVersion: 1,
        },
      ).expect(200);
      expect(merged.body.request.status).toBe('CANCELLED');
      expect(await booked(b, target.startsAt)).toBe(1);
      expect((await row(target.id)).scheduledFor?.toISOString()).toBe(
        target.startsAt,
      );

      const other = customerOf();
      const scheduledSource = await bookOk(b, other, {}, 1);
      const plainTarget = await plainRequest(b, other);
      const refused = await staffPost(
        b,
        `/chatbot-requests/${scheduledSource.id}/merge`,
        {
          expectedVersion: 1,
          intoRequestId: plainTarget,
          intoExpectedVersion: 1,
        },
      ).expect(422);
      expect(refused.body.code).toBe('MERGE_NOT_ALLOWED');
      expect(await booked(b, scheduledSource.startsAt)).toBe(1);
    });

    it('claim before scheduledFor - 5 min is 409 SCHEDULED_TOO_EARLY {claimableAt}; at the instant it works', async () => {
      const b = await branch();
      const c = customerOf();
      const { id, startsAt } = await bookOk(b, c);
      const early = await staffPost(b, `/chatbot-requests/${id}/claim`, {
        expectedVersion: 1,
      }).expect(409);
      expect(early.body).toMatchObject({
        code: 'SCHEDULED_TOO_EARLY',
        claimableAt: new Date(Date.parse(startsAt) - 5 * MIN).toISOString(),
      });
      expect((await row(id)).status).toBe('NEW');
      await mirrorIn(b, c.ref).expect(200);
      await prisma.chatbotRequest.update({
        where: { id },
        data: { scheduledFor: new Date(Date.now() + 4 * MIN) },
      });
      await staffPost(b, `/chatbot-requests/${id}/claim`, {
        expectedVersion: 1,
      }).expect(200);
    });

    it('the inbox detail exposes scheduledFor, scheduleVersion, needsReschedule and RESCHEDULE; CLAIM is denied with SCHEDULED_TOO_EARLY', async () => {
      const b = await branch();
      const { id, startsAt } = await bookOk(b, customerOf());
      const res = await detail(b, id).expect(200);
      expect(res.body).toMatchObject({
        scheduledFor: startsAt,
        scheduleVersion: 1,
        needsReschedule: false,
        requiresTemplateAtStart: false,
      });
      expect(res.body.allowedActions).toContain('RESCHEDULE');
      expect(res.body.allowedActions).not.toContain('CLAIM');
      expect(res.body.deniedActions).toContainEqual({
        action: 'CLAIM',
        code: 'SCHEDULED_TOO_EARLY',
      });
      const groups = await server()
        .get('/chatbot-requests/groups')
        .set(as(b))
        .expect(200);
      expect(JSON.stringify(groups.body)).toContain(startsAt);
      const reader = await detail(b, id).set(as(b, 'reader')).expect(200);
      expect(reader.body.allowedActions).not.toContain('RESCHEDULE');
      // a request that is not scheduled never offers it
      const plain = await plainRequest(b, customerOf());
      expect(
        (await detail(b, plain).expect(200)).body.allowedActions,
      ).not.toContain('RESCHEDULE');
    });
  });

  // ------------------------------------------------------ 5. state routes

  describe('scheduledRequest on the state routes', () => {
    it('GET conversations/:ref/state carries the open scheduled request, null after a cancel', async () => {
      const b = await branch();
      const c = customerOf();
      const { id, startsAt } = await bookOk(b, c);
      await mirrorIn(b, c.ref).expect(200);
      const res = await state(b, c.ref).expect(200);
      expect(res.body).toMatchObject({
        mode: 'BOT',
        sessionState: null,
        requestId: null,
        scheduledRequest: {
          requestId: id,
          subtype: 'TALK_TO_HUMAN',
          scheduledFor: startsAt,
          needsReschedule: false,
          scheduleVersion: 1,
        },
      });
      const target = await firstSlot(b, c, 2);
      await reschedule(b, id, { scheduledFor: target }).expect(200);
      expect(
        (await state(b, c.ref).expect(200)).body.scheduledRequest,
      ).toMatchObject({
        scheduledFor: target,
        scheduleVersion: 2,
      });
      await cancel(b, id).expect(200);
      expect(
        (await state(b, c.ref).expect(200)).body.scheduledRequest,
      ).toBeNull();
    });

    it('a booked chat the mirror has not seen yet still answers its scheduledRequest', async () => {
      const b = await branch();
      const c = customerOf();
      const { id } = await bookOk(b, c);
      const res = await state(b, c.ref).expect(200);
      expect(res.body).toMatchObject({
        mode: 'BOT',
        handoffEpoch: 0,
        scheduledRequest: { requestId: id },
      });
      await state(b, customerOf().ref).expect(404);
    });

    it('the bulk route carries scheduledRequest for each HUMAN chat (null when it has none)', async () => {
      const b = await branch();
      const withBooking = customerOf();
      const without = customerOf();
      const { id } = await bookOk(b, withBooking);
      for (const ref of [withBooking.ref, without.ref]) {
        await prisma.chatbotConversation.create({
          data: {
            tenantId: b.tenantId,
            conversationRef: ref,
            mode: 'HUMAN',
            handoffEpoch: 1,
          },
        });
      }
      const res = await asBot(
        b,
        server().get('/chatbot-api/conversations/state?mode=HUMAN'),
      ).expect(200);
      const by = (ref: string) =>
        res.body.items.find((i: any) => i.conversationRef === ref);
      expect(by(withBooking.ref).scheduledRequest).toMatchObject({
        requestId: id,
        subtype: 'TALK_TO_HUMAN',
        needsReschedule: false,
        scheduleVersion: 1,
      });
      expect(by(without.ref).scheduledRequest).toBeNull();
    });
  });
  // ---------------------------------------------------- 7. schedule sweep

  describe('schedule sweep (reminder, "solicitud nueva" at scheduledFor, needsReschedule)', () => {
    const sweep = () => app.get(ScheduleSweepScheduler);
    const minus = (startsAt: string, minutes: number) =>
      new Date(new Date(startsAt).getTime() + minutes * MIN);
    const remindersOf = (b: Branch, id: string) =>
      feedOf(b, id, 'conversation.scheduled_reminder');
    const noticesOf = (b: Branch, id: string) =>
      prisma.outboxEvent.findMany({
        where: {
          tenantId: b.tenantId,
          aggregateId: id,
          eventType: NOTICE_NOTIFY_EVENT_TYPE,
        },
      });
    /** Settings change with a version bump (the calendar is cached per version). */
    const changeSettings = (
      b: Branch,
      data: { closedDates?: string[]; days?: Prisma.InputJsonArray },
    ) =>
      prisma.chatbotAttentionSettings.update({
        where: { tenantId: b.tenantId },
        data: { ...data, version: { increment: 1 } },
      });

    class PeekStore extends ScheduleSweepStore {
      hook: (() => Promise<void>) | null = null;
      peek(now: Date, after: ScheduleDueCursor | null = null) {
        return this.readCandidates(now, after);
      }
      protected override async readCandidates(
        now: Date,
        after: ScheduleDueCursor | null,
      ) {
        const rows = await super.readCandidates(now, after);
        await this.hook?.();
        return rows;
      }
    }
    const peekStore = () => new PeekStore(app.get(PrismaService));

    it('creates the reminder at the lead time, once, and serves it on the feed; the claim and overdue clocks stay anchored at scheduledFor', async () => {
      const b = await branch();
      const c = customerOf();
      const { id, startsAt } = await bookOk(b, c);
      const before = await row(id);
      expect(before.scheduleStage).toBe(0);
      expect(before.scheduleDueAt).toEqual(minus(startsAt, -10));

      await sweep().tick(minus(startsAt, -11));
      expect(await remindersOf(b, id)).toHaveLength(0);

      await sweep().tick(minus(startsAt, -10));
      const [item] = await remindersOf(b, id);
      expect(item.payload).toMatchObject({
        requestId: id,
        scheduledFor: startsAt,
        scheduleVersion: 1,
        minutesBefore: 10,
        timeZone: ZONE,
        requiresTemplateAtStart: false,
      });
      expect(item.conversationRef).toBe(c.ref);
      const after = await row(id);
      expect(after.scheduleStage).toBe(1);
      expect(after.scheduleDueAt).toEqual(new Date(startsAt));
      expect(await noticesOf(b, id)).toHaveLength(0);

      await sweep().tick(minus(startsAt, -9));
      expect(await remindersOf(b, id)).toHaveLength(1);

      const feed = await asBot(
        b,
        server().get('/chatbot-api/feed?waitSeconds=0'),
      ).expect(200);
      expect(
        feed.body.items.filter(
          (i: any) => i.type === 'conversation.scheduled_reminder',
        ),
      ).toHaveLength(1);

      // The SLA clock starts at scheduledFor: nothing is due before it.
      const sla = await row(id);
      expect(
        sla.nextSlaCheckAt === null ||
          sla.nextSlaCheckAt.getTime() >= new Date(startsAt).getTime(),
      ).toBe(true);
      expect(await eventsOf(id, 'SLA_MILESTONE')).toHaveLength(0);
    });

    it('writes the "solicitud nueva" notice at scheduledFor, once, and finishes the schedule', async () => {
      const b = await branch();
      const c = customerOf();
      const { id, startsAt } = await bookOk(b, c);
      await sweep().tick(minus(startsAt, -10));
      expect(await noticesOf(b, id)).toHaveLength(0);

      await sweep().tick(minus(startsAt, -0.5));
      expect(await noticesOf(b, id)).toHaveLength(0);

      await sweep().tick(new Date(startsAt));
      const notices = await noticesOf(b, id);
      expect(notices).toHaveLength(1);
      expect(notices[0].payload).toMatchObject({
        type: 'REQUEST_CREATED',
        requestId: id,
        dedupKey: `created:${id}`,
      });
      // Open at that hour: not held.
      expect(notices[0].nextAttemptAt.getTime()).toBeLessThanOrEqual(
        new Date(startsAt).getTime(),
      );
      const done = await row(id);
      expect(done.scheduleStage).toBe(2);
      expect(done.scheduleDueAt).toBeNull();

      await sweep().tick(minus(startsAt, 5));
      expect(await noticesOf(b, id)).toHaveLength(1);
      expect(await remindersOf(b, id)).toHaveLength(1);
    });

    it('never creates the reminder with less than 3 minutes left (exactly 3 still does)', async () => {
      const b = await branch({ max: 3 });
      const late = await bookOk(b, customerOf(), {}, 0);
      const edge = await bookOk(b, customerOf(), {}, 1);
      await sweep().tick(minus(late.startsAt, -2));
      expect(await remindersOf(b, late.id)).toHaveLength(0);
      expect((await row(late.id)).scheduleStage).toBe(1);
      await sweep().tick(minus(edge.startsAt, -3));
      expect(await remindersOf(b, edge.id)).toHaveLength(1);
    });

    it('a sweep that ran after scheduledFor sends no reminder, only the notice', async () => {
      const b = await branch();
      const { id, startsAt } = await bookOk(b, customerOf());
      await sweep().tick(minus(startsAt, 1));
      expect(await remindersOf(b, id)).toHaveLength(0);
      expect(await noticesOf(b, id)).toHaveLength(1);
      expect((await row(id)).scheduleStage).toBe(2);
    });

    it('suppresses the reminder while needsReschedule is set; the notice still comes', async () => {
      const b = await branch();
      const { id, startsAt } = await bookOk(b, customerOf());
      await prisma.chatbotRequest.update({
        where: { id },
        data: { needsReschedule: true },
      });
      await sweep().tick(minus(startsAt, -10));
      expect(await remindersOf(b, id)).toHaveLength(0);
      expect((await row(id)).scheduleStage).toBe(1);
      await sweep().tick(new Date(startsAt));
      expect(await noticesOf(b, id)).toHaveLength(1);
    });

    it('a reschedule moves the stages: the old time never fires, the new one does with the new version', async () => {
      const b = await branch();
      const c = customerOf();
      const { id, startsAt } = await bookOk(b, c);
      const target = await firstSlot(b, c, 2);
      await staffReschedule(b, id, (await row(id)).version, target).expect(200);
      const moved = await row(id);
      expect(moved.scheduleStage).toBe(0);
      expect(moved.scheduleDueAt).toEqual(minus(target, -10));

      await sweep().tick(minus(startsAt, -10));
      expect(await remindersOf(b, id)).toHaveLength(0);
      await sweep().tick(minus(target, -10));
      const [item] = await remindersOf(b, id);
      expect(item.payload).toMatchObject({
        scheduledFor: target,
        scheduleVersion: 2,
      });
    });

    it('a cancel stops the schedule: nothing is due and nothing is sent', async () => {
      const b = await branch();
      const { id, startsAt } = await bookOk(b, customerOf());
      await cancel(b, id).expect(200);
      expect((await row(id)).scheduleDueAt).toBeNull();
      await sweep().tick(new Date(startsAt));
      expect(await remindersOf(b, id)).toHaveLength(0);
      expect(await noticesOf(b, id)).toHaveLength(0);
    });

    it('a candidate that a reschedule or a cancel moved after it was read is stale and left alone', async () => {
      const b = await branch();
      const c1 = customerOf();
      const first = await bookOk(b, c1, {}, 0);
      const second = await bookOk(b, customerOf(), {}, 1);
      const target = await firstSlot(b, c1, 2);
      const store = peekStore();
      store.hook = async () => {
        store.hook = null;
        await staffReschedule(
          b,
          first.id,
          (await row(first.id)).version,
          target,
        ).expect(200);
        await cancel(b, second.id).expect(200);
      };
      const result = await store.runBatch(minus(second.startsAt, -10));
      expect(result.stale).toBeGreaterThanOrEqual(2);
      expect(await remindersOf(b, first.id)).toHaveLength(0);
      expect(await remindersOf(b, second.id)).toHaveLength(0);
      const moved = await row(first.id);
      expect(moved.scheduleStage).toBe(0);
      expect(moved.scheduleDueAt).toEqual(minus(target, -10));
      expect((await row(second.id)).scheduleDueAt).toBeNull();
    });

    it('a second pass over a reset row cannot repeat the reminder (unique per version)', async () => {
      const b = await branch();
      const { id, startsAt } = await bookOk(b, customerOf());
      await sweep().tick(minus(startsAt, -10));
      await prisma.chatbotRequest.update({
        where: { id },
        data: { scheduleStage: 0, scheduleDueAt: minus(startsAt, -10) },
      });
      const result = await sweep().tick(minus(startsAt, -9));
      expect(result.failed).toBe(0);
      expect(await remindersOf(b, id)).toHaveLength(1);
      expect((await row(id)).scheduleStage).toBe(1);
    });

    it('reads due rows only, oldest due first, with a keyset, through the due index', async () => {
      const b = await branch();
      const first = await bookOk(b, customerOf(), {}, 0);
      const second = await bookOk(b, customerOf(), {}, 1);
      const store = peekStore();
      const ours = (rows: Array<{ id: string; tenantId: string }>) =>
        rows.filter((r) => r.tenantId === b.tenantId).map((r) => r.id);

      expect(ours(await store.peek(minus(first.startsAt, -11)))).toEqual([]);
      const both = await store.peek(minus(second.startsAt, -10));
      expect(ours(both)).toEqual([first.id, second.id]);
      const head = both.find((r) => r.id === first.id)!;
      const rest = await store.peek(minus(second.startsAt, -10), {
        dueAt: head.dueAt,
        id: head.id,
      });
      expect(ours(rest)).toEqual([second.id]);

      const plan = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
        return tx.$queryRaw<Array<Record<string, string>>>(Prisma.sql`
          EXPLAIN SELECT r."id" FROM "chatbot_requests" r
          WHERE r."scheduleDueAt" IS NOT NULL AND r."scheduleDueAt" <= ${new Date()}
          ORDER BY r."scheduleDueAt", r."id" LIMIT 100`);
      });
      expect(plan.map((l) => l['QUERY PLAN']).join('\n')).toContain(
        'chatbot_requests_schedule_due_idx',
      );
    });

    it('holds the notice to the next opening when the branch is closed at scheduledFor (L69) and flags the request when its reminder falls due', async () => {
      const b = await branch();
      const { id, startsAt } = await bookOk(b, customerOf());
      const versionBefore = (await row(id)).version;
      await changeSettings(b, { closedDates: [localDate(new Date(startsAt))] });

      await sweep().tick(minus(startsAt, -10));
      const flagged = await row(id);
      expect(flagged.needsReschedule).toBe(true);
      expect(flagged.version).toBe(versionBefore + 1);
      expect(await remindersOf(b, id)).toHaveLength(0);
      const events = await prisma.realtimeEvent.findMany({
        where: { tenantId: b.tenantId, requestId: id, type: 'request.updated' },
      });
      expect(events.map((e) => e.payload)).toContainEqual({
        version: versionBefore + 1,
        cause: 'NEEDS_RESCHEDULE',
      });

      await sweep().tick(new Date(startsAt));
      const [notice] = await noticesOf(b, id);
      expect(notice.nextAttemptAt.getTime()).toBeGreaterThan(
        new Date(startsAt).getTime(),
      );
      // Flagged and unclaimed at scheduledFor: still a normal claimable request.
      expect((await row(id)).status).toBe('NEW');
    });

    describe('needsReschedule when the settings change (S19 Q6)', () => {
      it('flags a closed date or shortened hours on open future scheduled requests, tells nobody, and a reschedule clears it', async () => {
        const b = await branch();
        const flaggedC = customerOf();
        const { id, startsAt } = await bookOk(b, flaggedC);
        const cancelled = await bookOk(b, customerOf(), {}, 1);
        await cancel(b, cancelled.id).expect(200);
        const past = await bookOk(b, customerOf(), {}, 2);
        await prisma.chatbotRequest.update({
          where: { id: past.id },
          data: { scheduledFor: new Date(Date.now() - 60 * MIN) },
        });
        const prisma2 = app.get(PrismaService);

        // A closed date elsewhere changes nothing.
        await changeSettings(b, { closedDates: ['2099-01-01'] });
        expect(await flagUnbookableSchedules(prisma2, b.tenantId)).toEqual({
          flagged: 0,
        });

        await changeSettings(b, {
          closedDates: [localDate(new Date(startsAt))],
        });
        const versionBefore = (await row(id)).version;
        expect(await flagUnbookableSchedules(prisma2, b.tenantId)).toEqual({
          flagged: 1,
        });
        const after = await row(id);
        expect(after.needsReschedule).toBe(true);
        expect(after.version).toBe(versionBefore + 1);
        expect((await row(cancelled.id)).needsReschedule).toBe(false);
        expect((await row(past.id)).needsReschedule).toBe(false);
        // Not told to the customer: no feed item at all, no audit event.
        expect(
          await prisma.chatbotFeedItem.count({ where: { requestId: id } }),
        ).toBe(0);
        expect(await eventsOf(id, 'RESCHEDULED')).toHaveLength(0);
        const realtime = await prisma.realtimeEvent.findMany({
          where: {
            tenantId: b.tenantId,
            requestId: id,
            type: 'request.updated',
          },
        });
        expect(realtime.map((e) => e.payload)).toContainEqual({
          version: versionBefore + 1,
          cause: 'NEEDS_RESCHEDULE',
        });
        // Idempotent: an already flagged request is not touched again.
        expect(await flagUnbookableSchedules(prisma2, b.tenantId)).toEqual({
          flagged: 0,
        });
        expect((await row(id)).version).toBe(versionBefore + 1);
        const inbox = await detail(b, id).expect(200);
        expect(inbox.body.needsReschedule).toBe(true);

        // The customer reschedules: the flag clears.
        const target = await firstSlot(b, flaggedC, 0);
        await staffReschedule(b, id, (await row(id)).version, target).expect(
          200,
        );
        expect((await row(id)).needsReschedule).toBe(false);
      });

      it('flags when the business hours are shortened so that the booked time is outside them', async () => {
        const b = await branch();
        const { id } = await bookOk(b, customerOf());
        await changeSettings(b, {
          days: WEEKDAYS.map((day) => ({
            day,
            ranges: [{ open: '00:00', close: '00:01' }],
          })) as unknown as Prisma.InputJsonArray,
        });
        expect(
          await flagUnbookableSchedules(app.get(PrismaService), b.tenantId),
        ).toEqual({ flagged: 1 });
        expect((await row(id)).needsReschedule).toBe(true);
      });
    });
  });

  // ------------------------------------------------- parallel commands (verify)

  describe('parallel commands on the same seats (no deadlock, one consistent outcome)', () => {
    /**
     * Seats = scheduled requests not cancelled, per block: every counter row
     * equals the count of non-CANCELLED scheduled rows at that instant, and
     * every such instant has a counter row.
     */
    async function expectSeatsConsistent(b: Branch) {
      const counters = await prisma.scheduledSlotCounter.findMany({
        where: { tenantId: b.tenantId },
      });
      const rows = await prisma.chatbotRequest.groupBy({
        by: ['scheduledFor'],
        where: {
          tenantId: b.tenantId,
          scheduledFor: { not: null },
          status: { not: 'CANCELLED' },
        },
        _count: { _all: true },
      });
      const expected = new Map(
        rows.map((r) => [r.scheduledFor!.getTime(), r._count._all]),
      );
      const actual = new Map(
        counters
          .filter((c) => c.booked > 0)
          .map((c) => [c.startsAt.getTime(), c.booked]),
      );
      expect(actual).toEqual(expected);
      for (const c of counters) expect(c.booked).toBeGreaterThanOrEqual(0);
    }
    /** What the settings PUT does: the write, then the post-commit flag pass. */
    const putClosedDays = async (b: Branch, instants: string[]) => {
      await prisma.chatbotAttentionSettings.update({
        where: { tenantId: b.tenantId },
        data: {
          closedDates: [
            ...new Set(instants.map((i) => localDate(new Date(i)))),
          ],
          version: { increment: 1 },
        },
      });
      return flagUnbookableSchedules(app.get(PrismaService), b.tenantId);
    };
    const noServerError = (statuses: number[]) => {
      for (const status of statuses) expect(status).toBeLessThan(500);
    };

    it('cancel vs reschedule of the same request: the request ends CANCELLED with no seat anywhere, whichever goes first', async () => {
      for (let round = 0; round < 6; round++) {
        const b = await branch();
        const c = customerOf();
        const { id, startsAt } = await bookOk(b, c);
        const target = await firstSlot(b, c, 2);
        const [cancelled, moved] = await Promise.all([
          cancel(b, id),
          reschedule(b, id, { scheduledFor: target }),
        ]);
        noServerError([cancelled.status, moved.status]);
        // Cancel always lands; a reschedule that lost is REQUEST_CLOSED.
        expect(cancelled.status).toBe(200);
        expect([200, 409]).toContain(moved.status);
        if (moved.status === 409)
          expect(moved.body).toMatchObject({ code: 'REQUEST_CLOSED' });
        const stored = await row(id);
        expect(stored.status).toBe('CANCELLED');
        expect(stored.scheduleDueAt).toBeNull();
        expect(await booked(b, startsAt)).toBe(0);
        expect(await booked(b, target)).toBe(0);
        await expectSeatsConsistent(b);
      }
    });

    it('two reschedules of the same request to different blocks: both apply in some order, one block ends with the seat', async () => {
      for (let round = 0; round < 6; round++) {
        const b = await branch();
        const c = customerOf();
        const { id, startsAt } = await bookOk(b, c);
        const first = await firstSlot(b, c, 1);
        const second = await firstSlot(b, c, 2);
        const results = await Promise.all([
          reschedule(b, id, { scheduledFor: first }),
          reschedule(b, id, { scheduledFor: second }),
        ]);
        noServerError(results.map((r) => r.status));
        expect(results.map((r) => r.status)).toEqual([200, 200]);
        const stored = await row(id);
        expect([first, second]).toContain(stored.scheduledFor?.toISOString());
        // Each applied move bumped the version once: the loser of the lock ran second.
        expect(stored.scheduleVersion).toBe(3);
        expect(await eventsOf(id, 'RESCHEDULED')).toHaveLength(2);
        expect(await booked(b, startsAt)).toBe(0);
        expect(await booked(b, stored.scheduledFor!.toISOString())).toBe(1);
        const other =
          stored.scheduledFor!.toISOString() === first ? second : first;
        expect(await booked(b, other)).toBe(0);
        await expectSeatsConsistent(b);
      }
    });

    it('a booking racing a settings PUT that closes its day: refused (409, nothing stored) or booked and then flagged needsReschedule', async () => {
      const outcomes = new Set<number>();
      for (let round = 0; round < 8; round++) {
        const b = await branch();
        const c = customerOf();
        const slot = await firstSlot(b, c);
        const [booking] = await Promise.all([
          book(b, c, slot),
          putClosedDays(b, [slot]),
        ]);
        noServerError([booking.status]);
        outcomes.add(booking.status);
        const rows = await prisma.chatbotRequest.findMany({
          where: { tenantId: b.tenantId, scheduledFor: { not: null } },
        });
        if (booking.status === 409) {
          expect(booking.body).toMatchObject({ code: 'SLOT_UNAVAILABLE' });
          expect(rows).toHaveLength(0);
          expect(await booked(b, slot)).toBe(0);
        } else {
          expect(booking.status).toBe(201);
          expect(rows).toHaveLength(1);
          // The booking read the old hours and committed first: the flag pass
          // (or, if it skipped a locked row, the backstop pass below, which
          // stands for the schedule sweep) marks it.
          await flagUnbookableSchedules(app.get(PrismaService), b.tenantId);
          expect((await row(rows[0].id)).needsReschedule).toBe(true);
        }
        await expectSeatsConsistent(b);
      }
      expect([...outcomes].every((s) => s === 201 || s === 409)).toBe(true);
    });

    it('a reschedule racing a settings PUT that closes the day of its target: moved or refused, seats consistent, needsReschedule set for the final time', async () => {
      for (let round = 0; round < 8; round++) {
        const b = await branch();
        const c = customerOf();
        const { id, startsAt } = await bookOk(b, c);
        const target = await firstSlot(b, c, 2);
        const [moved] = await Promise.all([
          reschedule(b, id, { scheduledFor: target }),
          putClosedDays(b, [startsAt, target]),
        ]);
        noServerError([moved.status]);
        expect([200, 409]).toContain(moved.status);
        const stored = await row(id);
        if (moved.status === 409) {
          expect(moved.body).toMatchObject({ code: 'SLOT_UNAVAILABLE' });
          expect(stored.scheduledFor?.toISOString()).toBe(startsAt);
          expect(await booked(b, target)).toBe(0);
        } else {
          expect(stored.scheduledFor?.toISOString()).toBe(target);
          expect(await booked(b, startsAt)).toBe(0);
        }
        expect(await booked(b, stored.scheduledFor!.toISOString())).toBe(1);
        // Both days are closed, so the final time is not bookable. The flag pass
        // of the PUT may have skipped the row the command held (SKIP LOCKED);
        // the second pass stands for the schedule sweep that catches it.
        await flagUnbookableSchedules(app.get(PrismaService), b.tenantId);
        expect((await row(id)).needsReschedule).toBe(true);
        await expectSeatsConsistent(b);
      }
    });
  });
});
