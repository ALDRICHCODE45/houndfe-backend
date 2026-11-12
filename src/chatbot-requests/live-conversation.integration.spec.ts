/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- supertest response bodies are untyped JSON */
/**
 * human-intervention / unit 11, slice 1 — the live conversation end to end
 * through HTTP and the real sweeps against REAL PostgreSQL (bot contract
 * "Live conversation (unit 11)", proposal §4.1 to §4.8, §12.15):
 *
 *   claim → STARTING + `conversation.started` → bot `session-ack STARTED` →
 *   ACTIVE → staff messages → outcome (status + wamid stored once) → customer
 *   messages readable from `startSeq` → finish → ENDING + `conversation.ended`
 *   → bot `session-ack ENDED` → ENDED; START / ENDING / idle timeouts by the
 *   sweep (time is driven through `tick(now)`); release refused while live;
 *   races; overdue notice suppressed while live; `liveSession` on the inbox.
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
import {
  CONVERSATION_READ_STORE,
  ConversationReadsService,
} from '../conversations/application/conversation-reads.service';
import { PrismaConversationMirrorStore } from '../conversations/infrastructure/prisma-conversation-mirror.store';
import { PrismaConversationReadStore } from '../conversations/infrastructure/prisma-conversation-read.store';
import { BotConversationController } from '../conversations/presentation/bot-conversation.controller';
import { ConversationReadsController } from '../conversations/presentation/conversation-reads.controller';
import { InsufficientPermissionsError } from '../shared/domain/domain-error';
import { createAppValidationPipe } from '../shared/listing/app-validation.pipe';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import type { PrismaService } from '../shared/prisma/prisma.service';
import { RealtimeModule } from '../shared/realtime/realtime.module';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
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
import { CustomerKeySealer } from './domain/customer-key-sealer';
import { ChatbotSlaSweepStore } from './infrastructure/chatbot-sla-sweep.store';
import { PgFeedWakeup } from './infrastructure/feed-wakeup';
import { LiveSessionSweepScheduler } from './infrastructure/live-session-sweep.scheduler';
import { LiveSessionSweepStore } from './infrastructure/live-session-sweep.store';
import { PrismaChatbotFeedStore } from './infrastructure/prisma-chatbot-feed.store';
import { PrismaChatbotRecoveryStore } from './infrastructure/prisma-chatbot-recovery.store';
import { PrismaChatbotRequestCommandStore } from './infrastructure/prisma-chatbot-request-command.store';
import { PrismaChatbotRequestReadStore } from './infrastructure/prisma-chatbot-request-read.store';
import { PrismaChatbotRequestRelationStore } from './infrastructure/prisma-chatbot-request-relation.store';
import { PrismaLiveConversationStore } from './infrastructure/prisma-live-conversation.store';
import { PrismaSlaPauseReader } from './infrastructure/prisma-sla-pause.reader';
import { BotFeedController } from './presentation/bot-feed.controller';
import { BotRecoveryController } from './presentation/bot-recovery.controller';
import { ChatbotRequestCommandsController } from './presentation/chatbot-request-commands.controller';
import { ChatbotRequestHttpFilter } from './presentation/chatbot-request-http.filter';
import { ChatbotRequestReadsController } from './presentation/chatbot-request-reads.controller';
import { ChatbotRequestRelationsController } from './presentation/chatbot-request-relations.controller';
import {
  BotLiveConversationController,
  LiveConversationStaffController,
} from './presentation/live-conversation.controller';

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
  // An attendee: no `read:ChatbotConversation`, so the chat is cut at `startSeq`.
  attendee: READ_UPDATE,
  // A reassigner: may force a finish, sees the whole chat.
  manager: [
    ...READ_UPDATE,
    ['update', 'ChatbotRequestAssignment'],
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

const SECRET = 'integration-secret-of-some-length';
const AT = '2026-11-12T18:05:00.000Z';
const MIN = 60_000;

describeIfDb('live conversation (PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const sealer = new CustomerKeySealer(SECRET);
  let app: INestApplication;
  const tenants: string[] = [];
  const credentials: string[] = [];
  const users = { ana: randomUUID(), luis: randomUUID() };
  let seq = 0;

  const sweepScheduler = () =>
    new LiveSessionSweepScheduler(
      new LiveSessionSweepStore(prisma as unknown as PrismaService),
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        DatabaseModule,
        BotRateLimitModule,
        RealtimeModule,
      ],
      controllers: [
        ChatbotRequestCommandsController,
        ChatbotRequestRelationsController,
        ChatbotRequestReadsController,
        LiveConversationStaffController,
        BotLiveConversationController,
        BotFeedController,
        BotRecoveryController,
        BotConversationController,
        ConversationReadsController,
      ],
      providers: [
        ServiceAuthGuard,
        ChatbotRequestHttpFilter,
        ChatbotRequestCommandsService,
        ChatbotRequestRelationsService,
        {
          provide: CHATBOT_REQUEST_RELATION_STORE,
          useClass: PrismaChatbotRequestRelationStore,
        },
        ChatbotRequestReadsService,
        ChatbotFeedService,
        ChatbotRecoveryService,
        ConversationMirrorService,
        ConversationReadsService,
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
          provide: CHATBOT_RECOVERY_STORE,
          useClass: PrismaChatbotRecoveryStore,
        },
        {
          provide: CONVERSATION_MIRROR_STORE,
          useClass: PrismaConversationMirrorStore,
        },
        {
          provide: CONVERSATION_READ_STORE,
          useClass: PrismaConversationReadStore,
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
    for (const [name, id] of Object.entries(users)) {
      await prisma.user.create({
        data: {
          id,
          email: `${id}@live.test`,
          hashedPassword: 'x',
          name: name === 'ana' ? 'Ana García' : 'Luis Pérez',
        },
      });
    }
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await prisma.serviceRateBucket.deleteMany({
      where: { credentialId: { in: credentials } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.user.deleteMany({
      where: { id: { in: Object.values(users) } },
    });
  });

  // -------------------------------------------------------------- helpers

  async function branch() {
    const id = randomUUID();
    tenants.push(id);
    await prisma.tenant.create({
      data: { id, name: 'Sucursal Viva', slug: `cr-live-${id}` },
    });
    const token = `svc_${randomUUID()}`;
    const credential = await prisma.serviceCredential.create({
      data: {
        tenantId: id,
        name: 'bot',
        hashedKey: createHash('sha256').update(token).digest('hex'),
        scopes: [
          'requests:read',
          'feed:read',
          'feed:ack',
          'conversation:write',
        ],
        rateLimit: 600,
      },
    });
    credentials.push(credential.id);
    return { tenantId: id, token, folio: 0 };
  }
  type Branch = Awaited<ReturnType<typeof branch>>;

  const as = (b: Branch, role = 'attendee', userId: string = users.ana) => ({
    'x-test-role': role,
    'x-test-tenant': b.tenantId,
    'x-test-user': userId,
  });
  const server = () => request(app.getHttpServer());
  const asBot = (b: Branch, req: request.Test) =>
    req
      .set('Authorization', `Bearer ${b.token}`)
      .set('X-Branch-Id', b.tenantId);
  const staffPost = (
    b: Branch,
    path: string,
    body: object,
    opts: { role?: string; userId?: string; key?: string } = {},
  ) =>
    server()
      .post(path)
      .set(as(b, opts.role, opts.userId))
      .set('Idempotency-Key', opts.key ?? randomUUID())
      .send(body);
  const claim = (b: Branch, id: string, version = 1, userId = users.ana) =>
    staffPost(
      b,
      `/chatbot-requests/${id}/claim`,
      { expectedVersion: version },
      { userId },
    );
  const finish = (
    b: Branch,
    id: string,
    version: number,
    opts: { role?: string; userId?: string } = {},
  ) =>
    staffPost(
      b,
      `/chatbot-requests/${id}/finish`,
      { expectedVersion: version, note: 'Resuelto por teléfono.' },
      opts,
    );
  const say = (
    b: Branch,
    id: string,
    epoch: number,
    text: string,
    clientMessageId: string = randomUUID(),
  ) =>
    staffPost(
      b,
      `/chatbot-requests/${id}/messages`,
      { clientMessageId, expectedEpoch: epoch, text },
      { key: clientMessageId },
    );
  const sessionAck = (b: Branch, ref: string, body: object) =>
    asBot(
      b,
      server().post(
        `/chatbot-api/conversations/${encodeURIComponent(ref)}/session-ack`,
      ),
    ).send(body);
  const state = (b: Branch, ref: string) =>
    asBot(
      b,
      server().get(
        `/chatbot-api/conversations/${encodeURIComponent(ref)}/state`,
      ),
    );
  const outcome = (b: Branch, deliveryId: string, body: object) =>
    asBot(
      b,
      server().post(`/chatbot-api/deliveries/${deliveryId}/outcome`),
    ).send(body);
  const accepted = (wamid: string) => ({
    attemptId: randomUUID(),
    outcome: 'PROVIDER_ACCEPTED',
    attemptedAt: AT,
    providerMessageId: wamid,
  });
  const mirrorIn = (b: Branch, ref: string, text: string) => {
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
          text,
          providerTimestamp: now,
          observedAt: now,
        },
      ],
    });
  };

  /**
   * An open TALK_TO_HUMAN request of a chat that already has two customer
   * messages (seq 1 and 2, before any session) and an open 24 h window.
   */
  async function liveRequest(b: Branch, over: Record<string, unknown> = {}) {
    const n = ++seq;
    const ref = `wa:5255830${String(n).padStart(4, '0')}`;
    const created = await prisma.chatbotRequest.create({
      data: {
        tenantId: b.tenantId,
        folio: ++b.folio,
        kind: 'CONVERSATION',
        subtype: 'TALK_TO_HUMAN',
        customerKey: ref.slice(3),
        conversationRef: ref,
        summary: 'Quiere hablar con una persona',
        source: 'chatbot',
        sourceRequestId: randomUUID(),
        lastCustomerMessageAt: new Date(),
        whatsappWindowClosesAt: new Date(Date.now() + 23 * 60 * MIN),
        ...over,
      },
    });
    for (const text of ['Hola', 'Necesito ayuda']) {
      await mirrorIn(b, ref, text).expect(200);
    }
    return { id: created.id, ref, key: ref.slice(3) };
  }
  type Live = Awaited<ReturnType<typeof liveRequest>>;

  /** claim + bot ack: an ACTIVE session of epoch 1. Returns the request version. */
  async function activeSession(b: Branch, l: Live) {
    const claimed = await claim(b, l.id).expect(200);
    await sessionAck(b, l.ref, { epoch: 1, state: 'STARTED' }).expect(200);
    return { version: await versionOf(l.id), claimed };
  }

  const row = (id: string) =>
    prisma.chatbotRequest.findUniqueOrThrow({ where: { id } });
  const versionOf = async (id: string) => (await row(id)).version;
  const sessions = (b: Branch, requestId: string) =>
    prisma.chatbotLiveSession.findMany({
      where: { tenantId: b.tenantId, requestId },
      orderBy: { epoch: 'asc' },
    });
  const conversation = (b: Branch, ref: string) =>
    prisma.chatbotConversation.findFirstOrThrow({
      where: { tenantId: b.tenantId, conversationRef: ref },
    });
  const items = (b: Branch, requestId: string, type?: string) =>
    prisma.chatbotFeedItem.findMany({
      where: {
        tenantId: b.tenantId,
        requestId,
        ...(type ? { type } : { type: { startsWith: 'conversation.' } }),
      },
      orderBy: { cursor: 'asc' },
    });
  const events = (requestId: string) =>
    prisma.chatbotRequestEvent.findMany({
      where: { requestId },
      orderBy: [{ version: 'asc' }, { createdAt: 'asc' }],
    });
  const realtime = async (b: Branch, requestId: string) =>
    (
      await prisma.$queryRaw<
        Array<{ type: string; payload: Record<string, unknown> }>
      >`SELECT "type", "payload" FROM "realtime_events"
        WHERE "tenantId" = ${b.tenantId} AND "requestId" = ${requestId}
        ORDER BY "id"`
    ).filter((e) => e.type.startsWith('session.'));
  const msgs = (b: Branch, ref: string) =>
    conversation(b, ref).then((c) =>
      prisma.conversationMessage.findMany({
        where: { tenantId: b.tenantId, conversationId: c.id },
        orderBy: { seq: 'asc' },
      }),
    );

  // ------------------------------------------------------------ the loop

  describe('the whole loop', () => {
    it('claim → STARTING with conversation.started (epoch 1, startSeq after the existing chat, mode HUMAN, request version +1, session.starting)', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      const res = await claim(b, l.id).expect(200);
      expect(res.body.request).toMatchObject({
        id: l.id,
        status: 'IN_PROGRESS',
        version: 2,
        assignee: { id: users.ana },
      });

      const [session] = await sessions(b, l.id);
      expect(session).toMatchObject({
        epoch: 1,
        state: 'STARTING',
        staffUserId: users.ana,
        startSeq: 3,
        activeAt: null,
        endingAt: null,
      });
      expect(await conversation(b, l.ref)).toMatchObject({
        mode: 'HUMAN',
        handoffEpoch: 1,
      });

      const started = await items(b, l.id, 'conversation.started');
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({
        conversationRef: l.ref,
        payload: {
          requestId: l.id,
          handoffEpoch: 1,
          staffFirstName: 'Ana',
        },
      });
      expect(
        (started[0].payload as { whatsappWindowClosesAt: string })
          .whatsappWindowClosesAt,
      ).toMatch(/Z$/);

      expect((await realtime(b, l.id)).map((e) => e.type)).toEqual([
        'session.starting',
      ]);
      expect((await realtime(b, l.id))[0].payload).toEqual({ version: 2 });

      // the bot sees it on the feed with the common envelope
      const feed = await asBot(
        b,
        server().get('/chatbot-api/feed?waitSeconds=0'),
      ).expect(200);
      const delivered = feed.body.items.filter(
        (i: any) => i.type === 'conversation.started',
      );
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({
        requestId: l.id,
        conversationRef: l.ref,
        notBefore: null,
        expiresAt: null,
        payload: { handoffEpoch: 1, staffFirstName: 'Ana' },
      });

      // the reconciliation read
      const s = await state(b, l.ref).expect(200);
      expect(s.body).toEqual({
        mode: 'HUMAN',
        handoffEpoch: 1,
        sessionState: 'STARTING',
        requestId: l.id,
        assigneeFirstName: 'Ana',
      });
    });

    it('session-ack STARTED → ACTIVE (200 with the state after the call, session.active); the same call again is idempotent', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      await claim(b, l.id).expect(200);
      const res = await sessionAck(b, l.ref, {
        epoch: 1,
        state: 'STARTED',
        providerMessageId: 'wamid.greeting1',
      }).expect(200);
      expect(res.body).toEqual({
        epoch: 1,
        state: 'STARTED',
        sessionState: 'ACTIVE',
      });
      const [session] = await sessions(b, l.id);
      expect(session.state).toBe('ACTIVE');
      expect(session.activeAt).not.toBeNull();

      const again = await sessionAck(b, l.ref, {
        epoch: 1,
        state: 'STARTED',
      }).expect(200);
      expect(again.body.sessionState).toBe('ACTIVE');
      expect((await realtime(b, l.id)).map((e) => e.type)).toEqual([
        'session.starting',
        'session.active',
      ]);
      expect((await sessions(b, l.id))[0].activeAt).toEqual(session.activeAt);
      expect((await state(b, l.ref).expect(200)).body.sessionState).toBe(
        'ACTIVE',
      );
    });

    it('session-ack rules: bad body 400, unknown conversation 404, a higher epoch 409 STALE_EPOCH, ENDED of a live session 409 SESSION_NOT_ENDING', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      await claim(b, l.id).expect(200);
      await sessionAck(b, l.ref, {
        epoch: 1,
        state: 'STARTED',
        extra: 1,
      }).expect(400);
      await sessionAck(b, l.ref, { epoch: 0, state: 'STARTED' }).expect(400);
      await sessionAck(b, 'wa:unknown-chat', {
        epoch: 1,
        state: 'STARTED',
      }).expect(404);
      await state(b, 'wa:unknown-chat').expect(404);
      const stale = await sessionAck(b, l.ref, {
        epoch: 2,
        state: 'STARTED',
      }).expect(409);
      expect(stale.body).toMatchObject({
        code: 'STALE_EPOCH',
        currentEpoch: 1,
        mode: 'HUMAN',
        sessionState: 'STARTING',
      });
      const notEnding = await sessionAck(b, l.ref, {
        epoch: 1,
        state: 'ENDED',
      }).expect(409);
      expect(notEnding.body.code).toBe('SESSION_NOT_ENDING');
      expect((await sessions(b, l.id))[0].state).toBe('STARTING');
    });

    it('a staff message is stored QUEUED with the next seq, enqueues one conversation.staff_message, announces it and the clientMessageId makes the POST idempotent', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      const { version } = await activeSession(b, l);
      const clientMessageId = randomUUID();
      const res = await say(
        b,
        l.id,
        1,
        'Hola, soy Ana.\nEn qué ayudo',
        clientMessageId,
      ).expect(200);
      expect(res.body.message).toMatchObject({
        seq: 3,
        direction: 'OUT',
        author: 'STAFF',
        type: 'TEXT',
        text: 'Hola, soy Ana.\nEn qué ayudo',
        deliveryStatus: 'QUEUED',
        clientMessageId,
        staff: { id: users.ana },
      });

      const staffItems = await items(b, l.id, 'conversation.staff_message');
      expect(staffItems).toHaveLength(1);
      expect(staffItems[0]).toMatchObject({
        conversationRef: l.ref,
        payload: {
          requestId: l.id,
          handoffEpoch: 1,
          seq: 3,
          messageId: res.body.message.id,
          type: 'TEXT',
          text: 'Hola, soy Ana.\nEn qué ayudo',
        },
      });

      // idempotent replay: same body → same message, nothing new
      const replay = await say(
        b,
        l.id,
        1,
        'Hola, soy Ana.\nEn qué ayudo',
        clientMessageId,
      ).expect(200);
      expect(replay.body.message.id).toBe(res.body.message.id);
      // the same clientMessageId with other text is a conflict
      const conflict = await say(
        b,
        l.id,
        1,
        'otro texto',
        clientMessageId,
      ).expect(409);
      expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(await items(b, l.id, 'conversation.staff_message')).toHaveLength(
        1,
      );
      expect(
        (await msgs(b, l.ref)).filter((m) => m.author === 'STAFF'),
      ).toHaveLength(1);
      // a staff message is not a request change
      expect(await versionOf(l.id)).toBe(version);
      expect(
        (
          await prisma.chatbotLiveSession.findFirstOrThrow({
            where: { requestId: l.id },
          })
        ).lastStaffActivityAt,
      ).not.toBeNull();
    });

    it('the staff-side checks: wrong epoch 409 STALE_EPOCH, not the assignee 403, STARTING 409 SESSION_NOT_ACTIVE, closed window 409 WINDOW_CLOSED; none enqueues anything', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      await claim(b, l.id).expect(200);
      const early = await say(b, l.id, 1, 'antes del ack').expect(409);
      expect(early.body.code).toBe('SESSION_NOT_ACTIVE');
      await sessionAck(b, l.ref, { epoch: 1, state: 'STARTED' }).expect(200);

      const wrong = await say(b, l.id, 7, 'época vieja').expect(409);
      expect(wrong.body).toMatchObject({
        code: 'STALE_EPOCH',
        currentEpoch: 1,
      });
      const other = await staffPost(
        b,
        `/chatbot-requests/${l.id}/messages`,
        { clientMessageId: randomUUID(), expectedEpoch: 1, text: 'soy Luis' },
        { userId: users.luis },
      );
      // Idempotency-Key differs from clientMessageId → 400 before anything else
      expect(other.status).toBe(400);
      const luisId = randomUUID();
      const notMine = await staffPost(
        b,
        `/chatbot-requests/${l.id}/messages`,
        { clientMessageId: luisId, expectedEpoch: 1, text: 'soy Luis' },
        { userId: users.luis, key: luisId },
      ).expect(403);
      expect(notMine.body.code).toBe('NOT_ASSIGNEE');

      // the window closes (the customer wrote > 24 h ago)
      const c = await conversation(b, l.ref);
      await prisma.$executeRaw`UPDATE "chatbot_conversations"
        SET "lastCustomerMessageAt" = now() - interval '25 hours' WHERE "id" = ${c.id}`;
      await prisma.chatbotRequest.update({
        where: { id: l.id },
        data: { lastCustomerMessageAt: new Date(Date.now() - 25 * 60 * MIN) },
      });
      const closed = await say(b, l.id, 1, 'ventana cerrada').expect(409);
      expect(closed.body).toMatchObject({
        code: 'WINDOW_CLOSED',
        templateAllowed: false,
      });
      expect(await items(b, l.id, 'conversation.staff_message')).toHaveLength(
        0,
      );
      expect(
        (await msgs(b, l.ref)).filter((m) => m.author === 'STAFF'),
      ).toHaveLength(0);
    });

    it('outcome PROVIDER_ACCEPTED → message SENT and the wamid stored once (replay 200, a second wamid is refused, the trigger keeps it)', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      await activeSession(b, l);
      const res = await say(b, l.id, 1, 'Un momento por favor').expect(200);
      const item = (await items(b, l.id, 'conversation.staff_message'))[0];
      const body = accepted('wamid.staff1');
      const ok = await outcome(b, item.deliveryId, body).expect(200);
      expect(ok.body).toMatchObject({
        deliveryId: item.deliveryId,
        outcome: 'PROVIDER_ACCEPTED',
        attemptId: body.attemptId,
      });
      const stored = await prisma.conversationMessage.findUniqueOrThrow({
        where: { id: res.body.message.id },
      });
      expect(stored).toMatchObject({
        deliveryStatus: 'SENT',
        waMessageId: 'wamid.staff1',
        author: 'STAFF',
        direction: 'OUT',
        text: 'Un momento por favor',
      });

      await outcome(b, item.deliveryId, body).expect(200);
      const late = await outcome(
        b,
        item.deliveryId,
        accepted('wamid.other'),
      ).expect(409);
      expect(late.body.code).toBe('OUTCOME_ALREADY_RECORDED');
      expect(
        (
          await prisma.conversationMessage.findUniqueOrThrow({
            where: { id: res.body.message.id },
          })
        ).waMessageId,
      ).toBe('wamid.staff1');

      // the database itself refuses a second wamid or any other column edit
      await expect(
        prisma.$executeRaw`UPDATE "conversation_messages" SET "waMessageId" = 'wamid.hack' WHERE "id" = ${res.body.message.id}`,
      ).rejects.toThrow(/immutable/);
      await expect(
        prisma.$executeRaw`UPDATE "conversation_messages" SET "text" = 'editado' WHERE "id" = ${res.body.message.id}`,
      ).rejects.toThrow(/immutable/);

      // the bot's later statuses:batch finds the message by that wamid
      const read = await asBot(
        b,
        server().post(`/chatbot-api/messages/statuses:batch`),
      ).send({
        statuses: [
          {
            providerMessageId: 'wamid.staff1',
            status: 'DELIVERED',
            occurredAt: new Date().toISOString(),
          },
        ],
      });
      expect(read.status).toBe(200);
      expect(read.body).toEqual({ applied: 1, ignored: 0, unknown: [] });
      expect(
        (
          await prisma.conversationMessage.findUniqueOrThrow({
            where: { id: res.body.message.id },
          })
        ).deliveryStatus,
      ).toBe('DELIVERED');
    });

    it('the other outcomes: DELIVERY_UNKNOWN → UNKNOWN, STALE → FAILED, DEFERRED_WINDOW_CLOSED → DEFERRED (accepted) while DEFERRED_HUMAN_SESSION is 422 OUTCOME_NOT_ALLOWED', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      await activeSession(b, l);
      const sent: Array<{ id: string; deliveryId: string }> = [];
      for (const text of ['uno', 'dos', 'tres', 'cuatro']) {
        const res = await say(b, l.id, 1, text).expect(200);
        sent.push({ id: res.body.message.id, deliveryId: '' });
      }
      const feedItems = await items(b, l.id, 'conversation.staff_message');
      expect(feedItems.map((i) => (i.payload as any).text)).toEqual([
        'uno',
        'dos',
        'tres',
        'cuatro',
      ]);
      const statusOf = async (id: string) =>
        (await prisma.conversationMessage.findUniqueOrThrow({ where: { id } }))
          .deliveryStatus;
      const o = (outcomeName: string) => ({
        attemptId: randomUUID(),
        outcome: outcomeName,
        attemptedAt: AT,
      });
      await outcome(b, feedItems[0].deliveryId, o('DELIVERY_UNKNOWN')).expect(
        200,
      );
      await outcome(b, feedItems[1].deliveryId, o('STALE')).expect(200);
      await outcome(
        b,
        feedItems[2].deliveryId,
        o('DEFERRED_WINDOW_CLOSED'),
      ).expect(200);
      const refused = await outcome(
        b,
        feedItems[3].deliveryId,
        o('DEFERRED_HUMAN_SESSION'),
      ).expect(422);
      expect(refused.body.code).toBe('OUTCOME_NOT_ALLOWED');
      expect(await statusOf(sent[0].id)).toBe('UNKNOWN');
      expect(await statusOf(sent[1].id)).toBe('FAILED');
      expect(await statusOf(sent[2].id)).toBe('DEFERRED');
      expect(await statusOf(sent[3].id)).toBe('QUEUED');
    });

    it('outcome rules per type: conversation.started and conversation.ended accept no deferral (422 OUTCOME_NOT_ALLOWED), STALE is fine and the item stays pending after a 422', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      await claim(b, l.id).expect(200);
      const started = (await items(b, l.id, 'conversation.started'))[0];
      for (const name of ['DEFERRED_WINDOW_CLOSED', 'DEFERRED_HUMAN_SESSION']) {
        const res = await outcome(b, started.deliveryId, {
          attemptId: randomUUID(),
          outcome: name,
          attemptedAt: AT,
        }).expect(422);
        expect(res.body.code).toBe('OUTCOME_NOT_ALLOWED');
      }
      await outcome(b, started.deliveryId, {
        attemptId: randomUUID(),
        outcome: 'STALE',
      }).expect(200);
    });

    it('a customer message mirrored during the session is readable by the attendee from startSeq (the chat before it is not), moves the chat window and shows unread for the attendee', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      await activeSession(b, l);
      const before = (await conversation(b, l.ref)).lastCustomerMessageAt;
      await new Promise((r) => setTimeout(r, 20));
      const mirrored = await mirrorIn(
        b,
        l.ref,
        'Sigo aquí, ¿me ayudan?',
      ).expect(200);
      expect(mirrored.body.accepted).toHaveLength(1);
      expect(mirrored.body.accepted[0].seq).toBe(3);
      await say(b, l.id, 1, 'Claro que sí').expect(200);

      const page = await server()
        .get(`/chatbot-requests/${l.id}/conversation`)
        .set(as(b, 'attendee'))
        .expect(200);
      expect(page.body.items.map((m: any) => m.seq)).toEqual([3, 4]);
      expect(page.body.items[0]).toMatchObject({
        direction: 'IN',
        author: 'CUSTOMER',
        text: 'Sigo aquí, ¿me ayudan?',
      });
      expect(page.body.items[1]).toMatchObject({
        direction: 'OUT',
        author: 'STAFF',
        text: 'Claro que sí',
      });
      // a reassigner reads the whole chat
      const all = await server()
        .get(`/chatbot-requests/${l.id}/conversation`)
        .set(as(b, 'manager', users.luis))
        .expect(200);
      expect(all.body.items.map((m: any) => m.seq)).toEqual([1, 2, 3, 4]);

      const after = (await conversation(b, l.ref)).lastCustomerMessageAt;
      expect(after!.getTime()).toBeGreaterThan(before!.getTime());
    });

    it('finish → ENDING + RESOLVED + conversation.ended{FINISHED, farewell true}; bot ack ENDED → ENDED, mode BOT; replay and a late ack are idempotent', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      const { version } = await activeSession(b, l);
      const res = await finish(b, l.id, version).expect(200);
      expect(res.body.request).toMatchObject({
        id: l.id,
        status: 'RESOLVED',
        version: version + 1,
      });
      const resolved = await row(l.id);
      expect(resolved).toMatchObject({
        status: 'RESOLVED',
        resolvedByActorId: users.ana,
        nextSlaCheckAt: null,
      });
      expect(resolved.closedAt).not.toBeNull();
      expect(resolved.resolution).toMatchObject({
        action: 'FINISH',
        note: 'Resuelto por teléfono.',
      });
      expect((await sessions(b, l.id))[0]).toMatchObject({
        state: 'ENDING',
        endReason: 'FINISHED',
      });
      const ended = await items(b, l.id, 'conversation.ended');
      expect(ended).toHaveLength(1);
      expect(ended[0].payload).toEqual({
        requestId: l.id,
        handoffEpoch: 1,
        reason: 'FINISHED',
        farewell: true,
        resumeNotice: false,
      });
      // still HUMAN until the bot confirms
      expect(await conversation(b, l.ref)).toMatchObject({ mode: 'HUMAN' });
      expect((await state(b, l.ref).expect(200)).body).toMatchObject({
        mode: 'HUMAN',
        sessionState: 'ENDING',
      });

      // finish twice → not ACTIVE any more
      const twice = await finish(b, l.id, version + 1).expect(409);
      expect(['SESSION_NOT_ACTIVE', 'REQUEST_CLOSED']).toContain(
        twice.body.code,
      );
      // the attendee can no longer write
      expect((await say(b, l.id, 1, 'tarde').expect(409)).body.code).toBe(
        'SESSION_NOT_ACTIVE',
      );

      const ack = await sessionAck(b, l.ref, {
        epoch: 1,
        state: 'ENDED',
      }).expect(200);
      expect(ack.body).toEqual({
        epoch: 1,
        state: 'ENDED',
        sessionState: 'ENDED',
      });
      await sessionAck(b, l.ref, { epoch: 1, state: 'ENDED' }).expect(200);
      expect((await sessions(b, l.id))[0].state).toBe('ENDED');
      expect(await conversation(b, l.ref)).toMatchObject({
        mode: 'BOT',
        handoffEpoch: 1,
      });
      expect((await state(b, l.ref).expect(200)).body).toEqual({
        mode: 'BOT',
        handoffEpoch: 1,
        sessionState: null,
        requestId: null,
        assigneeFirstName: null,
      });
      // a STARTED for an ended epoch is the late ack after a revert/end
      const late = await sessionAck(b, l.ref, {
        epoch: 1,
        state: 'STARTED',
      }).expect(409);
      expect(late.body.code).toBe('STALE_EPOCH');
      expect((await realtime(b, l.id)).map((e) => e.type)).toEqual([
        'session.starting',
        'session.active',
        'session.ending',
        'session.ended',
      ]);
      expect(await items(b, l.id, 'conversation.ended')).toHaveLength(1);
      const audit = (await events(l.id)).map((e) => e.type);
      expect(audit.filter((t) => t === 'CLAIMED')).toHaveLength(1);
    });

    it('a reassigner forces the finish (FORCED); another cashier-level user gets 403 NOT_ASSIGNEE', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      const { version } = await activeSession(b, l);
      await finish(b, l.id, version, { userId: users.luis }).expect(403);
      await finish(b, l.id, version, {
        role: 'manager',
        userId: users.luis,
      }).expect(200);
      const ended = (await items(b, l.id, 'conversation.ended'))[0];
      expect(ended.payload).toMatchObject({ reason: 'FORCED', farewell: true });
      expect((await sessions(b, l.id))[0].endReason).toBe('FORCED');
    });

    it('release of an ACTIVE (and a STARTING) session is 422 ACTION_NOT_ALLOWED: nothing changes', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      await claim(b, l.id).expect(200);
      const starting = await staffPost(b, `/chatbot-requests/${l.id}/release`, {
        expectedVersion: 2,
      }).expect(422);
      expect(starting.body.code).toBe('ACTION_NOT_ALLOWED');
      await sessionAck(b, l.ref, { epoch: 1, state: 'STARTED' }).expect(200);
      const version = await versionOf(l.id);
      const active = await staffPost(b, `/chatbot-requests/${l.id}/release`, {
        expectedVersion: version,
      }).expect(422);
      expect(active.body.code).toBe('ACTION_NOT_ALLOWED');
      expect(await row(l.id)).toMatchObject({
        status: 'IN_PROGRESS',
        assigneeUserId: users.ana,
        version,
      });
      expect((await sessions(b, l.id))[0].state).toBe('ACTIVE');
      // cancel is refused while live too (409)
      await staffPost(b, `/chatbot-requests/${l.id}/cancel`, {
        expectedVersion: version,
        reason: 'DUPLICATE',
      }).expect(409);
    });
  });

  // ------------------------------------------------------------ the sweep

  describe('the sweep (time driven through tick(now))', () => {
    it('START timeout: STARTING with no ack for 60 s reverts the claim (NEW, mode BOT, epoch kept) and sends conversation.ended{START_TIMEOUT, farewell false}; a late ack STARTED is 409 STALE_EPOCH; a new claim is epoch 2', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      await claim(b, l.id).expect(200);
      const tickAt = (ms: number) =>
        sweepScheduler().tick(new Date(Date.now() + ms));

      // not due yet
      await tickAt(30_000);
      expect((await sessions(b, l.id))[0].state).toBe('STARTING');

      await tickAt(61_000);
      const [session] = await sessions(b, l.id);
      expect(session).toMatchObject({
        state: 'ENDED',
        endReason: 'START_TIMEOUT',
        epoch: 1,
      });
      expect(await row(l.id)).toMatchObject({
        status: 'NEW',
        assigneeUserId: null,
        assigneeDisplayName: null,
        claimedAt: null,
        version: 3,
      });
      expect(await conversation(b, l.ref)).toMatchObject({
        mode: 'BOT',
        handoffEpoch: 1,
      });
      const ended = await items(b, l.id, 'conversation.ended');
      expect(ended).toHaveLength(1);
      expect(ended[0].payload).toEqual({
        requestId: l.id,
        handoffEpoch: 1,
        reason: 'START_TIMEOUT',
        farewell: false,
        resumeNotice: true,
      });
      const released = (await events(l.id)).filter(
        (e) => e.type === 'AUTO_RELEASED',
      );
      expect(released).toHaveLength(1);
      expect(released[0]).toMatchObject({
        actorKind: 'SYSTEM',
        fromStatus: 'IN_PROGRESS',
        toStatus: 'NEW',
        version: 3,
        data: { reason: 'START_TIMEOUT', handoffEpoch: 1 },
      });
      expect((await realtime(b, l.id)).map((e) => e.type)).toEqual([
        'session.starting',
        'session.ended',
      ]);
      // a second tick does nothing more
      await tickAt(120_000);
      expect(await items(b, l.id, 'conversation.ended')).toHaveLength(1);
      expect(await versionOf(l.id)).toBe(3);

      const late = await sessionAck(b, l.ref, {
        epoch: 1,
        state: 'STARTED',
      }).expect(409);
      expect(late.body).toMatchObject({
        code: 'STALE_EPOCH',
        currentEpoch: 1,
        mode: 'BOT',
      });
      // ENDED for a session that ended for any reason is always welcome
      await sessionAck(b, l.ref, { epoch: 1, state: 'ENDED' }).expect(200);

      // the claim can be made again: a NEW epoch
      await claim(b, l.id, 3).expect(200);
      const all = await sessions(b, l.id);
      expect(all.map((s) => [s.epoch, s.state])).toEqual([
        [1, 'ENDED'],
        [2, 'STARTING'],
      ]);
      expect(all[1].startSeq).toBe(3);
      expect(
        (await items(b, l.id, 'conversation.started')).map(
          (i) => (i.payload as any).handoffEpoch,
        ),
      ).toEqual([1, 2]);
    });

    it('ENDING with no ack ENDED for 10 minutes is marked ENDED by the sweep (no new item); the bot ack ENDED afterwards is 200', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      const { version } = await activeSession(b, l);
      await finish(b, l.id, version).expect(200);
      await sweepScheduler().tick(new Date(Date.now() + 5 * MIN));
      expect((await sessions(b, l.id))[0].state).toBe('ENDING');
      await sweepScheduler().tick(new Date(Date.now() + 11 * MIN));
      expect((await sessions(b, l.id))[0].state).toBe('ENDED');
      expect(await conversation(b, l.ref)).toMatchObject({ mode: 'BOT' });
      expect(await items(b, l.id, 'conversation.ended')).toHaveLength(1);
      expect((await row(l.id)).status).toBe('RESOLVED');
      expect((await realtime(b, l.id)).map((e) => e.type).at(-1)).toBe(
        'session.ended',
      );
      await sessionAck(b, l.ref, { epoch: 1, state: 'ENDED' }).expect(200);
    });

    it('idle timeout: ACTIVE with a silent customer for 2 h → ENDING, request RESOLVED with the automatic note, conversation.ended{IDLE_TIMEOUT, farewell true}', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      const { version } = await activeSession(b, l);
      await sweepScheduler().tick(new Date(Date.now() + 119 * MIN));
      expect((await sessions(b, l.id))[0].state).toBe('ACTIVE');

      await sweepScheduler().tick(new Date(Date.now() + 125 * MIN));
      expect((await sessions(b, l.id))[0]).toMatchObject({
        state: 'ENDING',
        endReason: 'IDLE_TIMEOUT',
      });
      const resolved = await row(l.id);
      expect(resolved).toMatchObject({
        status: 'RESOLVED',
        version: version + 1,
      });
      expect(JSON.stringify(resolved.resolution)).toContain(
        'no contestó en 2 horas',
      );
      const ended = await items(b, l.id, 'conversation.ended');
      expect(ended).toHaveLength(1);
      expect(ended[0].payload).toEqual({
        requestId: l.id,
        handoffEpoch: 1,
        reason: 'IDLE_TIMEOUT',
        farewell: true,
        resumeNotice: false,
      });
      expect((await realtime(b, l.id)).map((e) => e.type).at(-1)).toBe(
        'session.ending',
      );
      await sweepScheduler().tick(new Date(Date.now() + 126 * MIN));
      expect(await items(b, l.id, 'conversation.ended')).toHaveLength(1);
      await sessionAck(b, l.ref, { epoch: 1, state: 'ENDED' }).expect(200);
      expect((await sessions(b, l.id))[0].state).toBe('ENDED');
    });

    it("idle clock counts from the customer's last message: a customer message 90 minutes in postpones the end", async () => {
      const b = await branch();
      const l = await liveRequest(b);
      await activeSession(b, l);
      // the customer's last message was 90 minutes ago
      const c = await conversation(b, l.ref);
      await prisma.$executeRaw`UPDATE "chatbot_live_sessions"
        SET "activeAt" = now() - interval '3 hours' WHERE "requestId" = ${l.id}`;
      await prisma.$executeRaw`UPDATE "chatbot_conversations"
        SET "lastCustomerMessageAt" = now() - interval '90 minutes' WHERE "id" = ${c.id}`;
      await sweepScheduler().tick(new Date());
      expect((await sessions(b, l.id))[0].state).toBe('ACTIVE');
      await sweepScheduler().tick(new Date(Date.now() + 31 * MIN));
      expect((await sessions(b, l.id))[0].state).toBe('ENDING');
    });
  });

  // ------------------------------------------------------------------ races

  describe('races (parallel requests, exactly one wins, no duplicate feed items)', () => {
    it('two parallel claims of the same request: one 200 (epoch 1), one conflict; one session and one conversation.started', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      const results = await Promise.all([
        claim(b, l.id, 1, users.ana),
        claim(b, l.id, 1, users.luis),
      ]);
      const codes = results.map((r) => r.status).sort();
      expect(codes[0]).toBe(200);
      expect(codes[1]).toBeGreaterThanOrEqual(409);
      expect(await sessions(b, l.id)).toHaveLength(1);
      expect(await items(b, l.id, 'conversation.started')).toHaveLength(1);
      expect(await versionOf(l.id)).toBe(2);
      expect(await conversation(b, l.ref)).toMatchObject({ handoffEpoch: 1 });
    });

    it('two live requests of the same chat claimed in parallel: one session wins, the other is refused (one open session per conversation)', async () => {
      const b = await branch();
      const first = await liveRequest(b);
      const second = await prisma.chatbotRequest.create({
        data: {
          tenantId: b.tenantId,
          folio: ++b.folio,
          kind: 'CONVERSATION',
          subtype: 'COMPLAINT',
          customerKey: first.key,
          conversationRef: first.ref,
          summary: 'Queja',
          source: 'chatbot',
          sourceRequestId: randomUUID(),
          lastCustomerMessageAt: new Date(),
          whatsappWindowClosesAt: new Date(Date.now() + 23 * 60 * MIN),
        },
      });
      const results = await Promise.all([
        claim(b, first.id, 1, users.ana),
        claim(b, second.id, 1, users.luis),
      ]);
      const codes = results.map((r) => r.status).sort();
      expect(codes[0]).toBe(200);
      expect(codes[1]).toBe(422);
      const open = await prisma.chatbotLiveSession.findMany({
        where: { tenantId: b.tenantId, state: { not: 'ENDED' } },
      });
      expect(open).toHaveLength(1);
      expect(
        await prisma.chatbotFeedItem.count({
          where: { tenantId: b.tenantId, type: 'conversation.started' },
        }),
      ).toBe(1);
      expect(await conversation(b, first.ref)).toMatchObject({
        handoffEpoch: 1,
      });
    });

    it('claim-side ack race: the same session-ack STARTED sent in parallel is applied once (both 200, one session.active, one activation)', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      await claim(b, l.id).expect(200);
      const results = await Promise.all(
        [1, 2, 3].map(() =>
          sessionAck(b, l.ref, { epoch: 1, state: 'STARTED' }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(
        (await realtime(b, l.id)).filter((e) => e.type === 'session.active'),
      ).toHaveLength(1);
      expect((await sessions(b, l.id))[0].state).toBe('ACTIVE');
    });

    it('session-ack STARTED vs the START-timeout sweep: exactly one wins and the result is consistent', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      await claim(b, l.id).expect(200);
      const [ack] = await Promise.all([
        sessionAck(b, l.ref, { epoch: 1, state: 'STARTED' }),
        sweepScheduler().tick(new Date(Date.now() + 61_000)),
      ]);
      const [session] = await sessions(b, l.id);
      const ended = await items(b, l.id, 'conversation.ended');
      if (ack.status === 200) {
        // the ack won: ACTIVE, nothing reverted
        expect(session.state).toBe('ACTIVE');
        expect(ended).toHaveLength(0);
        expect((await row(l.id)).status).toBe('IN_PROGRESS');
      } else {
        // the sweep won: reverted, the late ack is STALE_EPOCH
        expect(ack.status).toBe(409);
        expect(ack.body.code).toBe('STALE_EPOCH');
        expect(session).toMatchObject({
          state: 'ENDED',
          endReason: 'START_TIMEOUT',
        });
        expect(ended).toHaveLength(1);
        expect((await row(l.id)).status).toBe('NEW');
      }
      const types = (await realtime(b, l.id)).map((e) => e.type);
      expect(
        types.filter((t) => t === 'session.active' || t === 'session.ended'),
      ).toHaveLength(1);
    });

    it('finish vs finish in parallel: one 200, the other refused; one conversation.ended', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      const { version } = await activeSession(b, l);
      const results = await Promise.all([
        finish(b, l.id, version),
        finish(b, l.id, version),
      ]);
      const codes = results.map((r) => r.status).sort();
      expect(codes[0]).toBe(200);
      expect(codes[1]).toBeGreaterThanOrEqual(409);
      expect(await items(b, l.id, 'conversation.ended')).toHaveLength(1);
      expect(await versionOf(l.id)).toBe(version + 1);
      expect((await sessions(b, l.id))[0].state).toBe('ENDING');
    });

    it('finish vs the idle sweep: exactly one ends the session, exactly one conversation.ended, one resolution', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      const { version } = await activeSession(b, l);
      const [fin] = await Promise.all([
        finish(b, l.id, version),
        sweepScheduler().tick(new Date(Date.now() + 125 * MIN)),
      ]);
      const ended = await items(b, l.id, 'conversation.ended');
      expect(ended).toHaveLength(1);
      const [session] = await sessions(b, l.id);
      // the sweep clock runs ahead, so its second batch may already have
      // marked the ENDING session ENDED (10 min): both are consistent
      expect(['ENDING', 'ENDED']).toContain(session.state);
      // the sweep's second batch marking ENDED bumps the version once more
      expect(await versionOf(l.id)).toBe(
        version + 1 + (session.state === 'ENDED' ? 1 : 0),
      );
      if (fin.status === 200) {
        expect(ended[0].payload).toMatchObject({ reason: 'FINISHED' });
      } else {
        expect(fin.status).toBeGreaterThanOrEqual(409);
        expect(ended[0].payload).toMatchObject({ reason: 'IDLE_TIMEOUT' });
      }
      expect(
        (await events(l.id)).filter(
          (e) => e.toStatus === 'RESOLVED' && e.fromStatus === 'IN_PROGRESS',
        ),
      ).toHaveLength(1);
    });

    it('finish vs session-ack ENDED racing the ack (ack before finish is SESSION_NOT_ENDING; after it is applied): never two ENDED transitions', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      const { version } = await activeSession(b, l);
      const [fin, ack] = await Promise.all([
        finish(b, l.id, version),
        sessionAck(b, l.ref, { epoch: 1, state: 'ENDED' }),
      ]);
      expect(fin.status).toBe(200);
      const [session] = await sessions(b, l.id);
      if (ack.status === 200) {
        expect(session.state).toBe('ENDED');
      } else {
        expect(ack.status).toBe(409);
        expect(ack.body.code).toBe('SESSION_NOT_ENDING');
        expect(session.state).toBe('ENDING');
        await sessionAck(b, l.ref, { epoch: 1, state: 'ENDED' }).expect(200);
      }
      expect(await items(b, l.id, 'conversation.ended')).toHaveLength(1);
      expect(
        (await realtime(b, l.id)).filter((e) => e.type === 'session.ended'),
      ).toHaveLength(1);
    });
  });

  // ------------------------------------------------- overdue, inbox, EXPLAIN

  describe('overdue notice and the inbox row', () => {
    it('the SLA sweep records the overdue but does NOT send request.overdue_notice while a session is live (a request without one does get it)', async () => {
      const b = await branch();
      const overdue = async (n: number) => {
        const ref = `wa:5255840${n}`;
        const created = await prisma.chatbotRequest.create({
          data: {
            tenantId: b.tenantId,
            folio: ++b.folio,
            kind: 'CONVERSATION',
            subtype: 'TALK_TO_HUMAN',
            customerKey: ref.slice(3),
            conversationRef: ref,
            summary: 'Quiere hablar',
            source: 'chatbot',
            sourceRequestId: randomUUID(),
            createdAt: '2026-11-10T16:00:00Z',
            slaPolicyVersion: 0,
            nextSlaCheckAt: '2026-11-10T16:15:00Z',
          },
        });
        await mirrorIn(b, ref, 'hola').expect(200);
        return { ...created, ref };
      };
      const control = await overdue(1);
      const liveOne = await overdue(2);
      // the live one has a running session (seeded to isolate the sweep guard)
      const c = await conversation(b, liveOne.ref);
      await prisma.chatbotLiveSession.create({
        data: {
          tenantId: b.tenantId,
          requestId: liveOne.id,
          conversationId: c.id,
          epoch: 1,
          state: 'ACTIVE',
          staffUserId: users.ana,
          startSeq: 2,
          activeAt: new Date(),
        },
      });
      const sweep = new ChatbotSlaSweepStore(
        prisma as unknown as PrismaService,
        {
          clock: () => new Date('2026-11-10T12:00:00-06:00'),
        },
      );
      await sweep.runBatch('due');

      const notices = (id: string) =>
        prisma.chatbotFeedItem.count({
          where: {
            tenantId: b.tenantId,
            requestId: id,
            type: 'request.overdue_notice',
          },
        });
      expect(await notices(control.id)).toBe(1);
      expect(await notices(liveOne.id)).toBe(0);
      const marked = await row(liveOne.id);
      expect(marked.overdueAt).not.toBeNull();
      expect(
        (await events(liveOne.id)).some((e) => e.type === 'SLA_MILESTONE'),
      ).toBe(true);
    });

    it('the inbox row carries liveSession per state (null before any session, STARTING, ACTIVE with the activity times, ENDING) and GET groups/list agree', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      const list = () =>
        server()
          .get(
            `/chatbot-requests?customerKey=${encodeURIComponent(sealer.seal(b.tenantId, l.key))}&limit=5`,
          )
          .set(as(b, 'attendee', users.ana))
          .expect(200)
          .then((r) => (r.body.items ?? r.body.requests ?? []) as any[]);
      expect((await list())[0].liveSession).toBeNull();

      await claim(b, l.id).expect(200);
      expect((await list())[0].liveSession).toMatchObject({
        state: 'STARTING',
        handoffEpoch: 1,
      });
      expect((await list())[0].liveSession.lastStaffActivityAt).toMatch(/Z$/);

      await sessionAck(b, l.ref, { epoch: 1, state: 'STARTED' }).expect(200);
      await say(b, l.id, 1, 'hola').expect(200);
      const active = (await list())[0];
      expect(active.liveSession).toMatchObject({
        state: 'ACTIVE',
        handoffEpoch: 1,
      });
      expect(active.liveSession.lastStaffActivityAt).toMatch(/Z$/);
      expect(active.liveSession.lastCustomerMessageAt).toMatch(/Z$/);
      expect(active.allowedActions).toEqual(
        expect.arrayContaining(['SEND_MESSAGE', 'FINISH']),
      );
      expect(active.allowedActions).not.toContain('RELEASE');

      await finish(b, l.id, await versionOf(l.id)).expect(200);
      // a finished request leaves the open tab: the resolved tab shows it
      const closed = async () =>
        (
          await server()
            .get(
              `/chatbot-requests?customerKey=${encodeURIComponent(sealer.seal(b.tenantId, l.key))}&status=resolved&limit=5`,
            )
            .set(as(b, 'attendee', users.ana))
            .expect(200)
        ).body.items.find((r: any) => r.id === l.id);
      expect((await closed()).liveSession).toMatchObject({
        state: 'ENDING',
      });
      await sessionAck(b, l.ref, { epoch: 1, state: 'ENDED' }).expect(200);
      expect((await closed()).liveSession).toMatchObject({
        state: 'ENDED',
      });
    });

    it('EXPLAIN of the inbox read with the liveSession subqueries (one query on seeded data)', async () => {
      const b = await branch();
      for (let i = 0; i < 30; i++) {
        const l = await liveRequest(b);
        if (i % 3 === 0) await claim(b, l.id).expect(200);
      }
      const explain = (
        tx: Pick<typeof prisma, '$queryRaw'>,
      ): Promise<Array<Record<string, string>>> =>
        tx.$queryRaw`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF)
         SELECT r."id",
           (CASE WHEN r."kind" <> 'CONVERSATION' THEN NULL ELSE (SELECT
              CASE WHEN s."state" <> 'ENDED' THEN s."state"
                   WHEN r."status" IN ('NEW','IN_PROGRESS') THEN 'WAITING' ELSE 'ENDED' END
            FROM "chatbot_live_sessions" s
            WHERE s."tenantId" = r."tenantId" AND s."requestId" = r."id"
            ORDER BY s."epoch" DESC LIMIT 1) END) AS "liveState",
           (CASE WHEN r."kind" = 'CONVERSATION' THEN (SELECT s."epoch" FROM "chatbot_live_sessions" s
            WHERE s."tenantId" = r."tenantId" AND s."requestId" = r."id"
            ORDER BY s."epoch" DESC LIMIT 1) END) AS "liveEpoch"
         FROM "chatbot_requests" r
         WHERE r."tenantId" = ${b.tenantId}
         ORDER BY r."createdAt" DESC LIMIT 50`;
      const natural = await explain(prisma);
      // On a table this small the planner prefers a sequential scan; with it
      // disabled the plan shows the index the subqueries are written for.
      const indexed = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
        return explain(tx);
      });
      const render = (rows: Array<Record<string, string>>) =>
        rows.map((r) => r['QUERY PLAN']).join('\n');
      console.log(
        `EXPLAIN inbox liveSession (natural)\n${render(natural)}\n\nEXPLAIN (enable_seqscan=off)\n${render(indexed)}`,
      );
      expect(render(indexed)).toContain(
        'chatbot_live_sessions_tenantId_requestId_epoch_idx',
      );
    });
  });
});
