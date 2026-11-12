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
  CONVERSATION_MEDIA_STORAGE,
  CONVERSATION_MEDIA_STORE,
  ConversationMediaService,
} from '../conversations/application/conversation-media.service';
import {
  CONVERSATION_MIRROR_STORE,
  ConversationMirrorService,
} from '../conversations/application/conversation-mirror.service';
import {
  CONVERSATION_READ_STORE,
  ConversationReadsService,
} from '../conversations/application/conversation-reads.service';
import { PrismaConversationMediaStore } from '../conversations/infrastructure/prisma-conversation-media.store';
import { PrismaConversationMirrorStore } from '../conversations/infrastructure/prisma-conversation-mirror.store';
import { PrismaConversationReadStore } from '../conversations/infrastructure/prisma-conversation-read.store';
import { BotConversationController } from '../conversations/presentation/bot-conversation.controller';
import { BotMediaController } from '../conversations/presentation/bot-media.controller';
import { ConversationMediaController } from '../conversations/presentation/conversation-media.controller';
import { ConversationReadsController } from '../conversations/presentation/conversation-reads.controller';
import { FakeMediaStorage } from '../conversations/test-support/fake-media-storage';
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
import { defaultSettings } from '../chatbot-settings/domain/chatbot-attention-settings';
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
  const mediaStorage = new FakeMediaStorage();

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
        BotMediaController,
        ConversationMediaController,
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
        ConversationMediaService,
        {
          provide: CONVERSATION_MEDIA_STORE,
          useClass: PrismaConversationMediaStore,
        },
        { provide: CONVERSATION_MEDIA_STORAGE, useValue: mediaStorage },
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
          'media:read',
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

  /** Makes `userId` assignable in the branch (read + update:ChatbotRequest). */
  async function makeAssignable(b: Branch, userId: string) {
    const grant = (action: string) =>
      prisma.permission.upsert({
        where: { subject_action: { subject: 'ChatbotRequest', action } },
        update: {},
        create: { subject: 'ChatbotRequest', action },
      });
    const [read, update] = [await grant('read'), await grant('update')];
    const role = await prisma.role.create({
      data: {
        tenantId: b.tenantId,
        name: `Atiende ${randomUUID()}`,
        permissions: {
          create: [{ permissionId: read.id }, { permissionId: update.id }],
        },
      },
    });
    await prisma.tenantMembership.create({
      data: { userId, tenantId: b.tenantId, roleId: role.id },
    });
  }
  const reassign = (b: Branch, id: string, version: number, toUserId: string) =>
    staffPost(
      b,
      `/chatbot-requests/${id}/reassign`,
      { expectedVersion: version, toUserId },
      { role: 'manager', userId: users.ana },
    );

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
      await prisma.chatbotConversation.update({
        where: { id: c.id },
        data: { lastCustomerMessageAt: new Date(Date.now() - 25 * 60 * MIN) },
      });
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
        prisma.conversationMessage.update({
          where: { id: res.body.message.id },
          data: { waMessageId: 'wamid.hack' },
        }),
      ).rejects.toThrow(/immutable/);
      await expect(
        prisma.conversationMessage.update({
          where: { id: res.body.message.id },
          data: { text: 'editado' },
        }),
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
    it('START timeout: STARTING with no ack for 120 s (the default) reverts the claim (NEW, mode BOT, epoch kept) and sends conversation.ended{START_TIMEOUT, farewell false}; a late ack STARTED is 409 STALE_EPOCH; a new claim is epoch 2', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      await claim(b, l.id).expect(200);
      const tickAt = (ms: number) =>
        sweepScheduler().tick(new Date(Date.now() + ms));

      // not due yet
      await tickAt(30_000);
      expect((await sessions(b, l.id))[0].state).toBe('STARTING');

      await tickAt(121_000);
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
      await tickAt(180_000);
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
      await prisma.chatbotLiveSession.updateMany({
        where: { requestId: l.id },
        data: { activeAt: new Date(Date.now() - 180 * MIN) },
      });
      await prisma.chatbotConversation.update({
        where: { id: c.id },
        data: { lastCustomerMessageAt: new Date(Date.now() - 90 * MIN) },
      });
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
        sweepScheduler().tick(new Date(Date.now() + 121_000)),
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

  // ---------------------------------------------- slice 2 (S15 Q2, S16)

  describe('S15 Q2: reassigning a live session', () => {
    it('reassign of an ACTIVE session keeps the epoch, moves the session to the new attendee and enqueues conversation.reassigned{handoffEpoch, staffFirstName}; the old attendee can no longer write, the new one can', async () => {
      const b = await branch();
      await makeAssignable(b, users.luis);
      const l = await liveRequest(b);
      const { version } = await activeSession(b, l);

      const res = await reassign(b, l.id, version, users.luis).expect(200);
      expect(res.body.request).toMatchObject({
        assignee: { id: users.luis },
        version: version + 1,
      });
      const [session] = await sessions(b, l.id);
      expect(session).toMatchObject({
        epoch: 1,
        state: 'ACTIVE',
        staffUserId: users.luis,
      });
      const reassigned = await items(b, l.id, 'conversation.reassigned');
      expect(reassigned).toHaveLength(1);
      expect(reassigned[0].payload).toEqual({
        requestId: l.id,
        handoffEpoch: 1,
        staffFirstName: 'Luis',
      });
      expect(reassigned[0].conversationRef).toBe(l.ref);
      expect(await conversation(b, l.ref)).toMatchObject({
        mode: 'HUMAN',
        handoffEpoch: 1,
      });

      await say(b, l.id, 1, 'ya no soy yo').expect(403);
      const clientMessageId = randomUUID();
      await staffPost(
        b,
        `/chatbot-requests/${l.id}/messages`,
        { clientMessageId, expectedEpoch: 1, text: 'Hola, soy Luis' },
        { userId: users.luis, key: clientMessageId },
      ).expect(200);

      // the outcome table: sent / unknown / stale only
      for (const name of ['DEFERRED_WINDOW_CLOSED', 'DEFERRED_HUMAN_SESSION']) {
        const refused = await outcome(b, reassigned[0].deliveryId, {
          attemptId: randomUUID(),
          outcome: name,
          attemptedAt: AT,
        }).expect(422);
        expect(refused.body.code).toBe('OUTCOME_NOT_ALLOWED');
      }
      await outcome(
        b,
        reassigned[0].deliveryId,
        accepted('wamid.reass'),
      ).expect(200);
    });

    it('reassign of a STARTING session also tells the bot; reassigning to the same person (422) enqueues nothing and keeps the unit 6 notice', async () => {
      const b = await branch();
      await makeAssignable(b, users.luis);
      const l = await liveRequest(b);
      await claim(b, l.id).expect(200);
      await reassign(b, l.id, 2, users.ana).expect(422);
      expect(await items(b, l.id, 'conversation.reassigned')).toHaveLength(0);

      await reassign(b, l.id, 2, users.luis).expect(200);
      const reassigned = await items(b, l.id, 'conversation.reassigned');
      expect(reassigned).toHaveLength(1);
      expect(reassigned[0].payload).toMatchObject({
        handoffEpoch: 1,
        staffFirstName: 'Luis',
      });
      expect((await sessions(b, l.id))[0]).toMatchObject({
        state: 'STARTING',
        staffUserId: users.luis,
      });
      // the staff notice of the unit 6 reassignment is still produced
      const notices = await prisma.outboxEvent.findMany({
        where: { tenantId: b.tenantId, aggregateId: l.id },
      });
      expect(
        notices.filter((n) => (n.payload as any).type === 'REQUEST_REASSIGNED'),
      ).toHaveLength(1);
    });
  });

  describe('S16 1a: the start timeout is a per-tenant setting snapshotted at the claim', () => {
    /** A settings row with the defaults except the start timeout. */
    async function settingsWith(b: Branch, startTimeoutSeconds: number) {
      const d = defaultSettings();
      await prisma.chatbotAttentionSettings.create({
        data: {
          tenantId: b.tenantId,
          timeZone: d.openingHours.timeZone,
          days: d.openingHours.days as never,
          closedDates: [],
          slas: d.slas as never,
          windowWarningMinutes: d.windowWarningMinutes,
          templateCostText: d.templateCostText,
          enabledSubtypes: d.enabledSubtypes,
          receiptCloseMarginMinutes: d.receiptCloseMarginMinutes,
          schedulingEnabled: false,
          slotMinutes: d.scheduling.slotMinutes,
          slotsOffered: d.scheduling.slotsOffered,
          maxScheduledPerSlot: d.scheduling.maxScheduledPerSlot,
          startTimeoutSeconds,
        },
      });
    }
    const tickAt = (ms: number) =>
      sweepScheduler().tick(new Date(Date.now() + ms));

    it('a tenant without settings: startDeadlineAt = startedAt + 120 s; not reverted at 119 s, reverted after 121 s', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      await claim(b, l.id).expect(200);
      const [session] = await sessions(b, l.id);
      expect(session.startDeadlineAt).not.toBeNull();
      expect(
        session.startDeadlineAt!.getTime() - session.startedAt.getTime(),
      ).toBe(120_000);
      await tickAt(119_000);
      expect((await sessions(b, l.id))[0].state).toBe('STARTING');
      await tickAt(121_000);
      expect((await sessions(b, l.id))[0]).toMatchObject({
        state: 'ENDED',
        endReason: 'START_TIMEOUT',
      });
    });

    it('a tenant with startTimeoutSeconds 45 reverts at 46 s, and a later settings change does not move the deadline of a session that already started', async () => {
      const b = await branch();
      await settingsWith(b, 45);
      const l = await liveRequest(b);
      await claim(b, l.id).expect(200);
      const [session] = await sessions(b, l.id);
      expect(
        session.startDeadlineAt!.getTime() - session.startedAt.getTime(),
      ).toBe(45_000);

      // the tenant raises the setting after the claim: the session keeps 45 s
      await prisma.chatbotAttentionSettings.update({
        where: { tenantId: b.tenantId },
        data: { startTimeoutSeconds: 600 },
      });
      await tickAt(44_000);
      expect((await sessions(b, l.id))[0].state).toBe('STARTING');
      await tickAt(46_000);
      expect((await sessions(b, l.id))[0].state).toBe('ENDED');

      // the next claim snapshots the new value
      await claim(b, l.id, 3).expect(200);
      const second = (await sessions(b, l.id))[1];
      expect(
        second.startDeadlineAt!.getTime() - second.startedAt.getTime(),
      ).toBe(600_000);
      await tickAt(300_000);
      expect((await sessions(b, l.id))[1].state).toBe('STARTING');
    });

    it('a session created before the migration (no snapshot) uses startedAt + 120 s', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      await claim(b, l.id).expect(200);
      await prisma.chatbotLiveSession.updateMany({
        where: { requestId: l.id },
        data: { startDeadlineAt: null },
      });
      await tickAt(119_000);
      expect((await sessions(b, l.id))[0].state).toBe('STARTING');
      await tickAt(121_000);
      expect((await sessions(b, l.id))[0].state).toBe('ENDED');
    });
  });

  describe('S16 2: an in-flight BOT message mirrored after the claim', () => {
    const mirrorOut = (b: Branch, ref: string, text: string, ts = new Date()) =>
      asBot(
        b,
        server().post(
          `/chatbot-api/conversations/${encodeURIComponent(ref)}/messages:batch`,
        ),
      ).send({
        messages: [
          {
            waMessageId: `wamid.out.${randomUUID()}`,
            direction: 'OUT',
            type: 'TEXT',
            text,
            providerTimestamp: ts.toISOString(),
            observedAt: ts.toISOString(),
          },
        ],
      });

    it.each(['STARTING', 'ACTIVE'])(
      'a bot OUT message mirrored while the session is %s is accepted (200), stored as author BOT, readable in the session and enqueues nothing',
      async (stateName) => {
        const b = await branch();
        const l = await liveRequest(b);
        if (stateName === 'ACTIVE') await activeSession(b, l);
        else await claim(b, l.id).expect(200);
        const feedBefore = await prisma.chatbotFeedItem.count({
          where: { tenantId: b.tenantId },
        });

        const res = await mirrorOut(b, l.ref, 'Te paso con una persona').expect(
          200,
        );
        expect(res.body.accepted).toHaveLength(1);
        expect(res.body.accepted[0].seq).toBe(3);
        const [stored] = (await msgs(b, l.ref)).filter((m) => m.seq === 3);
        expect(stored).toMatchObject({
          direction: 'OUT',
          author: 'BOT',
          staffUserId: null,
          text: 'Te paso con una persona',
        });
        // mode, epoch and session untouched
        expect(await conversation(b, l.ref)).toMatchObject({
          mode: 'HUMAN',
          handoffEpoch: 1,
        });
        expect((await sessions(b, l.id))[0].state).toBe(stateName);
        expect(
          await prisma.chatbotFeedItem.count({
            where: { tenantId: b.tenantId },
          }),
        ).toBe(feedBefore);

        // the attendee reads it as a bot message from startSeq
        const page = await server()
          .get(`/chatbot-requests/${l.id}/conversation`)
          .set(as(b, 'attendee'))
          .expect(200);
        expect(page.body.items.map((m: any) => m.seq)).toEqual([3]);
        expect(page.body.items[0]).toMatchObject({
          direction: 'OUT',
          author: 'BOT',
          text: 'Te paso con una persona',
        });
        // a replay of the same wamid is a duplicate, not a 4xx
        const body = res.body;
        expect(body.duplicates ?? []).toEqual([]);
      },
    );

    it('the staff composer still works after the bot message (the bot message takes its own seq, the staff message the next)', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      await activeSession(b, l);
      await mirrorOut(b, l.ref, 'Un segundo, te comunico').expect(200);
      const res = await say(b, l.id, 1, 'Hola, soy Ana').expect(200);
      expect(res.body.message.seq).toBe(4);
    });
  });

  describe('S16 3: deferred staff messages are terminal when the session ends', () => {
    const deferral = (name = 'DEFERRED_WINDOW_CLOSED') => ({
      attemptId: randomUUID(),
      outcome: name,
      attemptedAt: AT,
    });
    const pending = (b: Branch, ref: string) =>
      asBot(
        b,
        server().get(
          `/chatbot-api/requests/pending-deliveries?conversationRef=${encodeURIComponent(ref)}`,
        ),
      );
    const status = async (id: string) =>
      (await prisma.conversationMessage.findUniqueOrThrow({ where: { id } }))
        .deliveryStatus;
    const statusEvents = async (b: Branch, requestId: string) =>
      (
        await prisma.$queryRaw<
          Array<{ payload: { messageId: string; deliveryStatus: string } }>
        >`SELECT "payload" FROM "realtime_events"
          WHERE "tenantId" = ${b.tenantId} AND "requestId" = ${requestId}
            AND "type" = 'message.status' ORDER BY "id"`
      ).map((e) => e.payload);

    /** An ACTIVE session with two DEFERRED staff messages and one SENT. */
    async function withDeferred(b: Branch) {
      const l = await liveRequest(b);
      const { version } = await activeSession(b, l);
      const ids: string[] = [];
      for (const text of ['uno', 'dos', 'tres']) {
        ids.push((await say(b, l.id, 1, text).expect(200)).body.message.id);
      }
      const feed = await items(b, l.id, 'conversation.staff_message');
      await outcome(b, feed[0].deliveryId, deferral()).expect(200);
      await outcome(b, feed[1].deliveryId, deferral()).expect(200);
      await outcome(b, feed[2].deliveryId, accepted('wamid.s16.3')).expect(200);
      return { l, version, ids, feed };
    }

    it('while the epoch is ACTIVE the deferred items are served with deferredReason WINDOW_CLOSED, in seq order', async () => {
      const b = await branch();
      const { l, ids } = await withDeferred(b);
      expect(await status(ids[0])).toBe('DEFERRED');
      const res = await pending(b, l.ref).expect(200);
      expect(res.body.items.map((i: any) => i.payload.text)).toEqual([
        'uno',
        'dos',
      ]);
      expect(res.body.items[0].deferredReason).toBe('WINDOW_CLOSED');
    });

    it('finish makes the deferred messages FAILED (terminal, announced live), takes them off pending-deliveries and a later PROVIDER_ACCEPTED is 409; the SENT message is untouched', async () => {
      const b = await branch();
      const { l, version, ids, feed } = await withDeferred(b);
      await finish(b, l.id, version).expect(200);

      expect(await status(ids[0])).toBe('FAILED');
      expect(await status(ids[1])).toBe('FAILED');
      expect(await status(ids[2])).toBe('SENT');
      expect((await pending(b, l.ref).expect(200)).body.items).toEqual([]);
      const failed = (await statusEvents(b, l.id)).filter(
        (e) => e.deliveryStatus === 'FAILED',
      );
      expect(failed.map((e) => e.messageId).sort()).toEqual(
        [ids[0], ids[1]].sort(),
      );
      // the resend after the end is refused: not coming
      const late = await outcome(
        b,
        feed[0].deliveryId,
        accepted('wamid.too.late'),
      ).expect(409);
      expect(late.body.code).toBe('OUTCOME_ALREADY_RECORDED');
      expect(await status(ids[0])).toBe('FAILED');
    });

    it('the idle end fails them too, and a new claim (epoch 2) does not bring them back', async () => {
      const b = await branch();
      const { l, ids } = await withDeferred(b);
      await sweepScheduler().tick(new Date(Date.now() + 125 * MIN));
      expect((await sessions(b, l.id))[0].state).toBe('ENDING');
      expect(await status(ids[0])).toBe('FAILED');
      expect(await status(ids[1])).toBe('FAILED');
      await sessionAck(b, l.ref, { epoch: 1, state: 'ENDED' }).expect(200);
      expect((await pending(b, l.ref).expect(200)).body.items).toEqual([]);

      // the request was resolved by the idle end; a fresh live request of the
      // same chat claims epoch 2 and still sees nothing of epoch 1
      const second = await prisma.chatbotRequest.create({
        data: {
          tenantId: b.tenantId,
          folio: ++b.folio,
          kind: 'CONVERSATION',
          subtype: 'TALK_TO_HUMAN',
          customerKey: l.key,
          conversationRef: l.ref,
          summary: 'Otra vez',
          source: 'chatbot',
          sourceRequestId: randomUUID(),
          lastCustomerMessageAt: new Date(),
          whatsappWindowClosesAt: new Date(Date.now() + 23 * 60 * MIN),
        },
      });
      await claim(b, second.id).expect(200);
      await sessionAck(b, l.ref, { epoch: 2, state: 'STARTED' }).expect(200);
      expect((await pending(b, l.ref).expect(200)).body.items).toEqual([]);
    });

    it('a deferral reported AFTER the session left ACTIVE is terminal at once: message FAILED, item not pending, ack answered 200', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      const { version } = await activeSession(b, l);
      const sent = (await say(b, l.id, 1, 'tarde').expect(200)).body.message.id;
      const feed = await items(b, l.id, 'conversation.staff_message');
      await finish(b, l.id, version).expect(200);
      // QUEUED at the end: stays QUEUED until the bot says something
      expect(await status(sent)).toBe('QUEUED');
      const res = await outcome(b, feed[0].deliveryId, deferral()).expect(200);
      expect(res.body.outcome).toBe('DEFERRED_WINDOW_CLOSED');
      expect(await status(sent)).toBe('FAILED');
      expect((await pending(b, l.ref).expect(200)).body.items).toEqual([]);
      expect(
        (await statusEvents(b, l.id))
          .filter((e) => e.messageId === sent)
          .map((e) => e.deliveryStatus),
      ).toContain('FAILED');
    });

    // Verify F1: an ACK that deferred a message while staff finished can commit
    // AFTER the finish skipped its item (SKIP LOCKED) and read the session as
    // ACTIVE: the epoch is over but the item is still DEFERRED_WINDOW_CLOSED
    // and the message DEFERRED. These seed that post-race state directly.
    describe('F1: a deferral that raced the end is settled at ENDED and by the sweep backstop', () => {
      const leftovers = async (b: Branch, feed: Array<{ cursor: bigint }>) =>
        prisma.chatbotFeedItem.findMany({
          where: {
            tenantId: b.tenantId,
            cursor: { in: feed.map((f) => f.cursor) },
          },
          orderBy: { cursor: 'asc' },
          select: { outcome: true, ackedAt: true },
        });

      /** withDeferred, then the session is moved out of ACTIVE under it. */
      async function raced(
        b: Branch,
        state: 'ENDING' | 'ENDED',
        endedAgoMs = 0,
      ) {
        const seeded = await withDeferred(b);
        const at = new Date(Date.now() - endedAgoMs);
        await prisma.chatbotLiveSession.updateMany({
          where: { tenantId: b.tenantId, requestId: seeded.l.id },
          data:
            state === 'ENDING'
              ? { state, endReason: 'FINISHED', endingAt: at }
              : { state, endReason: 'FINISHED', endingAt: at, endedAt: at },
        });
        if (state === 'ENDED') {
          await prisma.chatbotConversation.updateMany({
            where: { tenantId: b.tenantId, conversationRef: seeded.l.ref },
            data: { mode: 'BOT' },
          });
        }
        // the race left both deferred and pending
        expect(await status(seeded.ids[0])).toBe('DEFERRED');
        expect(await status(seeded.ids[1])).toBe('DEFERRED');
        expect((await leftovers(b, seeded.feed)).slice(0, 2)).toEqual([
          { outcome: 'DEFERRED_WINDOW_CLOSED', ackedAt: null },
          { outcome: 'DEFERRED_WINDOW_CLOSED', ackedAt: null },
        ]);
        return seeded;
      }

      const expectSettled = async (
        b: Branch,
        l: Live,
        ids: string[],
        feed: Array<{ cursor: bigint }>,
      ) => {
        expect(await status(ids[0])).toBe('FAILED');
        expect(await status(ids[1])).toBe('FAILED');
        expect(await status(ids[2])).toBe('SENT');
        const rows = await leftovers(b, feed);
        expect(rows[0].ackedAt).not.toBeNull();
        expect(rows[1].ackedAt).not.toBeNull();
        expect(rows[0].outcome).toBe('STALE');
        expect(rows[1].outcome).toBe('STALE');
        const failed = (await statusEvents(b, l.id)).filter(
          (e) => e.deliveryStatus === 'FAILED',
        );
        expect(failed.map((e) => e.messageId).sort()).toEqual(
          [ids[0], ids[1]].sort(),
        );
      };

      it('the bot ack ENDED of an ENDING epoch settles the leftovers: messages FAILED, items acknowledged, message.status emitted once', async () => {
        const b = await branch();
        const { l, ids, feed } = await raced(b, 'ENDING');
        await sessionAck(b, l.ref, { epoch: 1, state: 'ENDED' }).expect(200);
        expect((await sessions(b, l.id))[0].state).toBe('ENDED');
        await expectSettled(b, l, ids, feed);
        // a replay of the ack adds nothing
        await sessionAck(b, l.ref, { epoch: 1, state: 'ENDED' }).expect(200);
        expect(
          (await statusEvents(b, l.id)).filter(
            (e) => e.deliveryStatus === 'FAILED',
          ),
        ).toHaveLength(2);
      });

      it('the sweep marking an ENDING epoch ENDED (10 min, no ack) settles the leftovers too', async () => {
        const b = await branch();
        const { l, ids, feed } = await raced(b, 'ENDING', 11 * MIN);
        const result = await sweepScheduler().tick(new Date());
        expect(result.ended).toBeGreaterThanOrEqual(1);
        expect((await sessions(b, l.id))[0].state).toBe('ENDED');
        await expectSettled(b, l, ids, feed);
      });

      it('the backstop settles leftovers of a non-ACTIVE epoch without any session transition (ENDING not due yet, and ENDED), and leaves an ACTIVE epoch alone', async () => {
        const b = await branch();
        const ending = await raced(b, 'ENDING', 1 * MIN);
        const ended = await raced(b, 'ENDED', 30 * MIN);
        const live = await withDeferred(b);

        const result = await sweepScheduler().tick(new Date());
        expect(result.settledDeferred).toBeGreaterThanOrEqual(4);

        // not due for ENDED: the session is still ENDING, only the items moved
        expect((await sessions(b, ending.l.id))[0].state).toBe('ENDING');
        await expectSettled(b, ending.l, ending.ids, ending.feed);
        await expectSettled(b, ended.l, ended.ids, ended.feed);
        // the ACTIVE epoch keeps waiting for the customer
        expect(await status(live.ids[0])).toBe('DEFERRED');
        expect(await status(live.ids[1])).toBe('DEFERRED');
        expect(
          (await pending(b, live.l.ref).expect(200)).body.items,
        ).toHaveLength(2);
        // idempotent: nothing more to settle for these
        const again = await sweepScheduler().tick(new Date());
        expect(again.settledDeferred).toBe(0);
      });

      it('ACK DEFERRED_WINDOW_CLOSED racing the finish: whichever order the transactions commit in, the bot ack ENDED leaves the message FAILED and the item acknowledged', async () => {
        const b = await branch();
        for (let round = 0; round < 6; round++) {
          const l = await liveRequest(b);
          const { version } = await activeSession(b, l);
          const sent = (await say(b, l.id, 1, `r${round}`).expect(200)).body
            .message.id;
          const [feedItem] = await items(b, l.id, 'conversation.staff_message');
          const [acked, finished] = await Promise.all([
            outcome(b, feedItem.deliveryId, deferral()),
            finish(b, l.id, version),
          ]);
          expect(acked.status).toBe(200);
          expect(finished.status).toBe(200);
          await sessionAck(b, l.ref, { epoch: 1, state: 'ENDED' }).expect(200);
          expect(await status(sent)).toBe('FAILED');
          const [row] = await leftovers(b, [feedItem]);
          expect(row.ackedAt).not.toBeNull();
          expect((await pending(b, l.ref).expect(200)).body.items).toEqual([]);
        }
      });
    });
  });

  describe('S16 5: the idle clock counts from the customer message providerTimestamp', () => {
    const mirrorInAt = (b: Branch, ref: string, providerTimestamp: Date) =>
      asBot(
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
            text: 'Sigo aquí',
            providerTimestamp: providerTimestamp.toISOString(),
            observedAt: new Date().toISOString(),
          },
        ],
      });

    it('a customer message that ARRIVES now but was written 115 minutes ago starts the idle clock 115 minutes ago: ACTIVE at 119 minutes, ending after 121', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      await activeSession(b, l);
      const c = await conversation(b, l.ref);
      await prisma.chatbotLiveSession.updateMany({
        where: { requestId: l.id },
        data: { activeAt: new Date(Date.now() - 300 * MIN) },
      });
      await prisma.chatbotConversation.update({
        where: { id: c.id },
        data: { lastCustomerMessageAt: new Date(Date.now() - 300 * MIN) },
      });
      const wrote = new Date(Date.now() - 115 * MIN);
      await mirrorInAt(b, l.ref, wrote).expect(200);
      expect((await conversation(b, l.ref)).lastCustomerMessageAt).toEqual(
        wrote,
      );

      await sweepScheduler().tick(new Date(Date.now() + 4 * MIN));
      expect((await sessions(b, l.id))[0].state).toBe('ACTIVE');
      await sweepScheduler().tick(new Date(Date.now() + 6 * MIN));
      expect((await sessions(b, l.id))[0]).toMatchObject({
        state: 'ENDING',
        endReason: 'IDLE_TIMEOUT',
      });
    });

    it('a late-arriving OLD customer message never moves the idle clock backwards', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      await activeSession(b, l);
      const before = (await conversation(b, l.ref)).lastCustomerMessageAt!;
      await mirrorInAt(b, l.ref, new Date(Date.now() - 600 * MIN)).expect(200);
      expect((await conversation(b, l.ref)).lastCustomerMessageAt).toEqual(
        before,
      );
      await sweepScheduler().tick(new Date(Date.now() + 119 * MIN));
      expect((await sessions(b, l.id))[0].state).toBe('ACTIVE');
    });
  });

  describe('S16 7a: bulk GET /chatbot-api/conversations/state?mode=HUMAN', () => {
    const bulk = (b: Branch, query: string) =>
      asBot(b, server().get(`/chatbot-api/conversations/state${query}`));

    it('lists the HUMAN conversations (STARTING and ACTIVE) with the single-state shape plus conversationRef, paged by an opaque cursor, and leaves out BOT and ended ones', async () => {
      const b = await branch();
      const starting = await liveRequest(b);
      const active = await liveRequest(b);
      const ended = await liveRequest(b);
      const idle = await liveRequest(b); // never claimed: stays BOT
      await claim(b, starting.id).expect(200);
      await claim(b, active.id).expect(200);
      await sessionAck(b, active.ref, { epoch: 1, state: 'STARTED' }).expect(
        200,
      );
      await claim(b, ended.id).expect(200);
      await sessionAck(b, ended.ref, { epoch: 1, state: 'STARTED' }).expect(
        200,
      );
      await finish(b, ended.id, await versionOf(ended.id)).expect(200);
      await sessionAck(b, ended.ref, { epoch: 1, state: 'ENDED' }).expect(200);

      const first = await bulk(b, '?mode=HUMAN&limit=1').expect(200);
      expect(first.headers['cache-control']).toBe('no-store');
      expect(first.body.items).toHaveLength(1);
      expect(first.body.nextCursor).toEqual(expect.any(String));
      const second = await bulk(
        b,
        `?mode=HUMAN&limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,
      ).expect(200);
      expect(second.body.items).toHaveLength(1);
      expect(second.body.nextCursor).toBeNull();

      const all = await bulk(b, '?mode=HUMAN').expect(200);
      expect(all.body.nextCursor).toBeNull();
      const byRef = new Map<string, any>(
        all.body.items.map((i: any) => [i.conversationRef, i]),
      );
      expect([...byRef.keys()].sort()).toEqual(
        [starting.ref, active.ref].sort(),
      );
      expect(byRef.get(starting.ref)).toEqual({
        conversationRef: starting.ref,
        mode: 'HUMAN',
        handoffEpoch: 1,
        sessionState: 'STARTING',
        requestId: starting.id,
        assigneeFirstName: 'Ana',
      });
      expect(byRef.get(active.ref)).toMatchObject({
        sessionState: 'ACTIVE',
        requestId: active.id,
      });
      // the pages cover exactly the same set, in a stable order
      expect(
        [...first.body.items, ...second.body.items].map(
          (i: any) => i.conversationRef,
        ),
      ).toEqual(all.body.items.map((i: any) => i.conversationRef));
      expect(byRef.has(idle.ref)).toBe(false);
      expect(byRef.has(ended.ref)).toBe(false);
      // each entry equals the single-conversation state route
      for (const item of all.body.items) {
        const { conversationRef, ...rest } = item;
        expect((await state(b, conversationRef).expect(200)).body).toEqual(
          rest,
        );
      }
    });

    it('is tenant-scoped, needs mode=HUMAN and a sane limit/cursor, and the bot scope requests:read', async () => {
      const b = await branch();
      const other = await branch();
      const l = await liveRequest(other);
      await claim(other, l.id).expect(200);
      expect((await bulk(b, '?mode=HUMAN').expect(200)).body).toEqual({
        items: [],
        nextCursor: null,
      });
      for (const query of [
        '',
        '?mode=BOT',
        '?mode=human',
        '?mode=HUMAN&limit=0',
        '?mode=HUMAN&limit=501',
        '?mode=HUMAN&limit=x',
        '?mode=HUMAN&cursor=%25%25%25',
      ]) {
        const res = await bulk(b, query).expect(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
      }
      // a credential without requests:read is refused
      const token = `svc_${randomUUID()}`;
      const credential = await prisma.serviceCredential.create({
        data: {
          tenantId: b.tenantId,
          name: 'no-read',
          hashedKey: createHash('sha256').update(token).digest('hex'),
          scopes: ['feed:read'],
          rateLimit: 600,
        },
      });
      credentials.push(credential.id);
      await server()
        .get('/chatbot-api/conversations/state?mode=HUMAN')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Branch-Id', b.tenantId)
        .expect(403);
    });

    it('a conversation whose ref is literally "state" is still reachable through the single route', async () => {
      const b = await branch();
      await mirrorIn(b, 'state', 'hola').expect(200);
      expect((await state(b, 'state').expect(200)).body).toMatchObject({
        mode: 'BOT',
        handoffEpoch: 0,
      });
    });
  });

  describe('S16 7b: messages:batch answers {mode, handoffEpoch} of the chat', () => {
    it('is BOT/0 for a new chat, HUMAN/1 during the session (also on a batch that is all duplicates) and BOT/1 after it ended', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      const first = await mirrorIn(b, l.ref, 'otro').expect(200);
      expect(first.body).toMatchObject({ mode: 'BOT', handoffEpoch: 0 });
      expect(first.body.accepted).toHaveLength(1);

      const { version } = await activeSession(b, l);
      const during = await mirrorIn(b, l.ref, 'sigo aquí').expect(200);
      expect(during.body).toMatchObject({ mode: 'HUMAN', handoffEpoch: 1 });
      // a batch that is only duplicates still says it
      const wamid = `wamid.dup.${randomUUID()}`;
      const body = {
        messages: [
          {
            waMessageId: wamid,
            direction: 'IN',
            type: 'TEXT',
            text: 'x',
            providerTimestamp: new Date().toISOString(),
            observedAt: new Date().toISOString(),
          },
        ],
      };
      const send = () =>
        asBot(
          b,
          server().post(
            `/chatbot-api/conversations/${encodeURIComponent(l.ref)}/messages:batch`,
          ),
        ).send(body);
      await send().expect(200);
      const dup = await send().expect(200);
      expect(dup.body).toMatchObject({
        accepted: [],
        duplicates: [wamid],
        mode: 'HUMAN',
        handoffEpoch: 1,
      });

      await finish(b, l.id, version).expect(200);
      await sessionAck(b, l.ref, { epoch: 1, state: 'ENDED' }).expect(200);
      const after = await mirrorIn(b, l.ref, 'gracias').expect(200);
      expect(after.body).toMatchObject({ mode: 'BOT', handoffEpoch: 1 });
    });
  });

  describe('S16 4: statuses:batch FAILED 131047 on a staff message means the window closed', () => {
    const statuses = (b: Branch, list: object[]) =>
      asBot(b, server().post('/chatbot-api/messages/statuses:batch')).send({
        statuses: list,
      });
    const failed131047 = (wamid: string, errorCode = '131047') => ({
      providerMessageId: wamid,
      status: 'FAILED',
      occurredAt: new Date().toISOString(),
      errorCode,
    });
    const pending = (b: Branch, ref: string) =>
      asBot(
        b,
        server().get(
          `/chatbot-api/requests/pending-deliveries?conversationRef=${encodeURIComponent(ref)}`,
        ),
      );
    const messageOf = (id: string) =>
      prisma.conversationMessage.findUniqueOrThrow({ where: { id } });
    const statusEvents = async (b: Branch, requestId: string) =>
      (
        await prisma.$queryRaw<
          Array<{ payload: { messageId: string; deliveryStatus: string } }>
        >`SELECT "payload" FROM "realtime_events"
          WHERE "tenantId" = ${b.tenantId} AND "requestId" = ${requestId}
            AND "type" = 'message.status' ORDER BY "id"`
      ).map((e) => e.payload);

    /** An ACTIVE session with one staff message the bot sent (SENT, wamid). */
    async function sentMessage(b: Branch, wamid: string) {
      const l = await liveRequest(b);
      const { version } = await activeSession(b, l);
      const id = (await say(b, l.id, 1, 'hola').expect(200)).body.message.id;
      const [item] = await items(b, l.id, 'conversation.staff_message');
      await outcome(b, item.deliveryId, accepted(wamid)).expect(200);
      return { l, version, id, item };
    }

    it('SENT -> DEFERRED (not FAILED): the item is pending again with WINDOW_CLOSED, the attendee is told, the chat window is corrected, and a replay is ignored', async () => {
      const b = await branch();
      const wamid = `wamid.s16.${randomUUID()}`;
      const { l, id } = await sentMessage(b, wamid);
      expect((await messageOf(id)).deliveryStatus).toBe('SENT');

      const res = await statuses(b, [failed131047(wamid)]).expect(200);
      expect(res.body).toMatchObject({ applied: 1, ignored: 0, unknown: [] });
      expect(await messageOf(id)).toMatchObject({
        deliveryStatus: 'DEFERRED',
        waMessageId: wamid,
      });
      const list = await pending(b, l.ref).expect(200);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0]).toMatchObject({
        type: 'conversation.staff_message',
        deferredReason: 'WINDOW_CLOSED',
      });
      expect(list.body.items[0].payload.messageId).toBe(id);
      expect((await statusEvents(b, l.id)).at(-1)).toMatchObject({
        messageId: id,
        deliveryStatus: 'DEFERRED',
      });
      // Meta's verdict corrects the backend's window: the attendee cannot
      // write until the customer does
      const closed = await say(b, l.id, 1, 'otra').expect(409);
      expect(closed.body.code).toBe('WINDOW_CLOSED');

      // a replay of the same status changes nothing
      const again = await statuses(b, [failed131047(wamid)]).expect(200);
      expect(again.body).toMatchObject({ applied: 0, ignored: 1 });
      expect((await pending(b, l.ref).expect(200)).body.items).toHaveLength(1);
    });

    it('the DEFERRED_WINDOW_CLOSED outcome path closes the window too: the next staff message is 409 WINDOW_CLOSED', async () => {
      const b = await branch();
      // a staff message the bot has not acknowledged yet (one outcome per item)
      const l = await liveRequest(b);
      await activeSession(b, l);
      const id = (await say(b, l.id, 1, 'hola').expect(200)).body.message.id;
      const [item] = await items(b, l.id, 'conversation.staff_message');
      const res = await outcome(b, item.deliveryId, {
        attemptId: randomUUID(),
        outcome: 'DEFERRED_WINDOW_CLOSED',
        attemptedAt: new Date().toISOString(),
      }).expect(200);
      expect(res.body.outcome).toBe('DEFERRED_WINDOW_CLOSED');
      expect((await messageOf(id)).deliveryStatus).toBe('DEFERRED');
      const closed = await say(b, l.id, 1, 'otra').expect(409);
      expect(closed.body.code).toBe('WINDOW_CLOSED');
    });

    it("a customer message AFTER Meta's verdict reopens the window: the attendee can write again", async () => {
      const b = await branch();
      const wamid = `wamid.s16.${randomUUID()}`;
      const { l } = await sentMessage(b, wamid);
      await statuses(b, [failed131047(wamid)]).expect(200);
      await say(b, l.id, 1, 'cerrada').expect(409);

      await new Promise((r) => setTimeout(r, 25));
      await mirrorIn(b, l.ref, 'ya volví').expect(200);
      await say(b, l.id, 1, 'bienvenido').expect(200);
    });

    it('the resend (new attemptId, new wamid) makes it SENT with the NEW wamid, which later statuses find; the pending list empties', async () => {
      const b = await branch();
      const first = `wamid.s16.${randomUUID()}`;
      const second = `wamid.s16.${randomUUID()}`;
      const { l, id, item } = await sentMessage(b, first);
      await statuses(b, [failed131047(first)]).expect(200);

      await outcome(b, item.deliveryId, accepted(second)).expect(200);
      expect(await messageOf(id)).toMatchObject({
        deliveryStatus: 'SENT',
        waMessageId: second,
      });
      expect((await pending(b, l.ref).expect(200)).body.items).toEqual([]);
      const delivered = await statuses(b, [
        {
          providerMessageId: second,
          status: 'DELIVERED',
          occurredAt: new Date().toISOString(),
        },
      ]).expect(200);
      expect(delivered.body.applied).toBe(1);
      expect((await messageOf(id)).deliveryStatus).toBe('DELIVERED');
      // the dead wamid is just unknown now
      const dead = await statuses(b, [failed131047(first)]).expect(200);
      expect(dead.body.unknown).toEqual([first]);
    });

    it('any other error (or none) is a plain FAILED and leaves the feed item alone; a DELIVERED message is never moved', async () => {
      const b = await branch();
      const wamid = `wamid.s16.${randomUUID()}`;
      const { l, id } = await sentMessage(b, wamid);
      await statuses(b, [failed131047(wamid, '131026')]).expect(200);
      expect((await messageOf(id)).deliveryStatus).toBe('FAILED');
      expect((await pending(b, l.ref).expect(200)).body.items).toEqual([]);

      const other = await branch();
      const w2 = `wamid.s16.${randomUUID()}`;
      const sent2 = await sentMessage(other, w2);
      await statuses(other, [
        {
          providerMessageId: w2,
          status: 'DELIVERED',
          occurredAt: new Date().toISOString(),
        },
      ]).expect(200);
      await statuses(other, [failed131047(w2)]).expect(200);
      expect((await messageOf(sent2.id)).deliveryStatus).toBe('DELIVERED');
    });

    it('131047 on a bot message is a plain FAILED (the rule is for staff messages)', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      await activeSession(b, l);
      const wamid = `wamid.bot.${randomUUID()}`;
      const ts = new Date().toISOString();
      await asBot(
        b,
        server().post(
          `/chatbot-api/conversations/${encodeURIComponent(l.ref)}/messages:batch`,
        ),
      )
        .send({
          messages: [
            {
              waMessageId: wamid,
              direction: 'OUT',
              type: 'TEXT',
              text: 'bot',
              providerTimestamp: ts,
              observedAt: ts,
            },
          ],
        })
        .expect(200);
      await statuses(b, [failed131047(wamid)]).expect(200);
      const stored = await prisma.conversationMessage.findFirstOrThrow({
        where: { waMessageId: wamid },
      });
      expect(stored.deliveryStatus).toBe('FAILED');
    });

    it('after the session left ACTIVE the window verdict is terminal: FAILED, nothing pending', async () => {
      const b = await branch();
      const wamid = `wamid.s16.${randomUUID()}`;
      const { l, version, id } = await sentMessage(b, wamid);
      await finish(b, l.id, version).expect(200);
      await statuses(b, [failed131047(wamid)]).expect(200);
      expect((await messageOf(id)).deliveryStatus).toBe('FAILED');
      expect((await pending(b, l.ref).expect(200)).body.items).toEqual([]);
    });

    // Verify F2: the idle sweep and the finish lock chat → message; the status
    // writers used to take the message first and the chat second (a 40P01
    // cycle with the sweep's IDLE_END). One global order: item → chat →
    // message (docs/chatbot-requests-model.md "Lock order"). Proved by holding
    // the chat row from the test: a writer that needs the chat must still be
    // waiting for it WITHOUT having taken the message row.
    describe('F2: lock order chat → message', () => {
      const holdChatWhile = async (
        chatId: string,
        during: () => Promise<void>,
      ) => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let locked!: () => void;
        const ready = new Promise<void>((resolve) => (locked = resolve));
        const holder = prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw(
              Prisma.sql`SELECT 1 FROM "chatbot_conversations" WHERE "id" = ${chatId} FOR UPDATE`,
            );
            locked();
            await gate;
          },
          { timeout: 30_000 },
        );
        await ready;
        try {
          await during();
        } finally {
          release();
          await holder;
        }
      };
      const waitForLockWait = async () => {
        for (let i = 0; i < 100; i++) {
          const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS "n" FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`;
          if (n > 0) return;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error('no transaction is waiting for a lock');
      };
      const messageIsFree = async (messageId: string) =>
        (
          await prisma.$queryRaw<unknown[]>`
            SELECT 1 FROM "conversation_messages" WHERE "id" = ${messageId}
            FOR UPDATE SKIP LOCKED`
        ).length === 1;

      it('statuses:batch (131047 reopening the window) waits for the chat before it takes the message row', async () => {
        const b = await branch();
        const wamid = `wamid.f2.${randomUUID()}`;
        const { l, id } = await sentMessage(b, wamid);
        const chat = await conversation(b, l.ref);
        let free = false;
        let call!: Promise<{ status: number }>;
        await holdChatWhile(chat.id, async () => {
          call = statuses(b, [failed131047(wamid)]).then((res) => res);
          await waitForLockWait();
          free = await messageIsFree(id);
        });
        expect(free).toBe(true);
        expect((await call).status).toBe(200);
        expect((await messageOf(id)).deliveryStatus).toBe('DEFERRED');
      });

      it('the DEFERRED_WINDOW_CLOSED outcome waits for the chat before it takes the message row', async () => {
        const b = await branch();
        const l = await liveRequest(b);
        await activeSession(b, l);
        const id = (await say(b, l.id, 1, 'hola').expect(200)).body.message.id;
        const [item] = await items(b, l.id, 'conversation.staff_message');
        const chat = await conversation(b, l.ref);
        let free = false;
        let call!: Promise<{ status: number }>;
        await holdChatWhile(chat.id, async () => {
          call = outcome(b, item.deliveryId, {
            attemptId: randomUUID(),
            outcome: 'DEFERRED_WINDOW_CLOSED',
            attemptedAt: AT,
          }).then((res) => res);
          await waitForLockWait();
          free = await messageIsFree(id);
        });
        expect(free).toBe(true);
        expect((await call).status).toBe(200);
        expect((await messageOf(id)).deliveryStatus).toBe('DEFERRED');
      });

      it('statuses:batch and the idle sweep on the same chat in parallel never deadlock (rounds)', async () => {
        const b = await branch();
        for (let round = 0; round < 5; round++) {
          const wamid = `wamid.f2.par.${randomUUID()}`;
          const { l } = await sentMessage(b, wamid);
          const tick = sweepScheduler().tick(new Date(Date.now() + 125 * MIN));
          const [res, swept] = await Promise.all([
            statuses(b, [failed131047(wamid)]),
            tick,
          ]);
          expect(res.status).toBe(200);
          expect(swept.failed).toBe(0);
          expect(l.id).toBeDefined();
        }
      });
    });
  });

  describe('T11c (S15 Q5, S16 9): staff media in a live session', () => {
    const JPEG = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from('staff-photo-bytes'),
    ]);
    const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
    const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(32, 1)]);

    const upload = (
      b: Branch,
      id: string,
      file: Buffer | null,
      opts: {
        idem?: string | null;
        filename?: string;
        role?: string;
        userId?: string;
      } = {},
    ) => {
      let req = server()
        .post(`/chatbot-requests/${id}/media`)
        .set(as(b, opts.role, opts.userId));
      if (opts.idem !== null) {
        req = req.set('Idempotency-Key', opts.idem ?? randomUUID());
      }
      return file
        ? req.attach('file', file, {
            filename: opts.filename ?? 'foto.jpg',
            contentType: 'application/octet-stream',
          })
        : req.field('sha256', 'x');
    };
    const sendMedia = (
      b: Branch,
      id: string,
      body: Record<string, unknown>,
      opts: { role?: string; userId?: string } = {},
    ) => {
      const clientMessageId = (body.clientMessageId as string) ?? randomUUID();
      return staffPost(
        b,
        `/chatbot-requests/${id}/messages`,
        { clientMessageId, expectedEpoch: 1, ...body },
        { key: clientMessageId, ...opts },
      );
    };
    const mediaRow = (id: string) =>
      prisma.conversationMedia.findUniqueOrThrow({ where: { id } });
    const countMessages = async (b: Branch, ref: string) =>
      (await msgs(b, ref)).length;
    const collect = (
      res: any,
      cb: (err: Error | null, body: Buffer) => void,
    ) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    };
    const download = (b: Branch, id: string, token = b.token) =>
      server()
        .get(`/chatbot-api/media/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .set('X-Branch-Id', b.tenantId)
        .buffer(true)
        .parse(collect);
    /** An ACTIVE session and one uploaded JPEG. */
    async function withMedia(b: Branch) {
      const l = await liveRequest(b);
      await activeSession(b, l);
      const up = await upload(b, l.id, JPEG).expect(201);
      return { l, mediaId: up.body.mediaId as string };
    }

    describe('1. POST /chatbot-requests/:id/media', () => {
      it('stores a private, tenant-scoped object owned by the request and the attendee; 201 then 200 on a replay; never returns a key', async () => {
        const b = await branch();
        const l = await liveRequest(b);
        await activeSession(b, l);
        const idem = randomUUID();
        const res = await upload(b, l.id, JPEG, {
          idem,
          filename: '../../Mi  Foto <1>.jpg',
        }).expect(201);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body).toEqual({
          mediaId: expect.any(String),
          mimeType: 'image/jpeg',
          sizeBytes: JPEG.length,
          sha256: createHash('sha256').update(JPEG).digest('hex'),
          filename: 'Mi Foto 1.jpg',
        });
        const stored = await mediaRow(res.body.mediaId);
        expect(stored).toMatchObject({
          tenantId: b.tenantId,
          requestId: l.id,
          uploadedByUserId: users.ana,
          filename: 'Mi Foto 1.jpg',
          mimeType: 'image/jpeg',
        });
        expect(stored.storageKey).toBe(
          `conversation-media/${b.tenantId}/${stored.id}.jpg`,
        );
        expect(
          mediaStorage.objects.get(stored.storageKey as string),
        ).toBeDefined();
        expect(JSON.stringify(res.body)).not.toContain('conversation-media/');

        const again = await upload(b, l.id, JPEG, { idem }).expect(200);
        expect(again.body.mediaId).toBe(res.body.mediaId);
        const clash = await upload(b, l.id, PDF, { idem }).expect(409);
        expect(clash.body.code).toBe('IDEMPOTENCY_CONFLICT');
      });

      it('a PDF gets a generic name when none usable is sent; the type comes from the bytes, not the declared one', async () => {
        const b = await branch();
        const l = await liveRequest(b);
        await activeSession(b, l);
        const res = await upload(b, l.id, PDF, { filename: '   ' }).expect(201);
        expect(res.body).toMatchObject({
          mimeType: 'application/pdf',
          filename: 'documento.pdf',
        });
      });

      it('refuses audio and unknown bytes (415), an empty or missing file and a bad key (400), more than 10 MB (413); nothing is stored', async () => {
        const b = await branch();
        const l = await liveRequest(b);
        await activeSession(b, l);
        const before = await prisma.conversationMedia.count({
          where: { tenantId: b.tenantId },
        });
        const audio = await upload(b, l.id, OGG).expect(415);
        expect(audio.body.code).toBe('MEDIA_TYPE_NOT_ALLOWED');
        await upload(b, l.id, Buffer.from('<html>x</html>')).expect(415);
        await upload(b, l.id, null).expect(400);
        await upload(b, l.id, JPEG, { idem: null }).expect(400);
        await upload(b, l.id, JPEG, { idem: 'not-a-uuid' }).expect(400);
        const big = await upload(
          b,
          l.id,
          Buffer.concat([JPEG, Buffer.alloc(10 * 1024 * 1024, 1)]),
        ).expect(413);
        expect(big.body.code).toBe('MEDIA_TOO_LARGE');
        expect(
          await prisma.conversationMedia.count({
            where: { tenantId: b.tenantId },
          }),
        ).toBe(before);
      });

      it('only the attendee, only while the session is ACTIVE, only for a conversation request of this tenant', async () => {
        const b = await branch();
        const l = await liveRequest(b);
        await claim(b, l.id).expect(200);
        // STARTING: the bot has not confirmed the mute yet
        const starting = await upload(b, l.id, JPEG).expect(409);
        expect(starting.body.code).toBe('SESSION_NOT_ACTIVE');
        await sessionAck(b, l.ref, { epoch: 1, state: 'STARTED' }).expect(200);
        const notMine = await upload(b, l.id, JPEG, {
          role: 'manager',
          userId: users.luis,
        }).expect(403);
        expect(notMine.body.code).toBe('NOT_ASSIGNEE');
        const other = await branch();
        await upload(other, l.id, JPEG).expect(404);
        await upload(b, randomUUID(), JPEG).expect(404);
        await upload(b, l.id, JPEG).expect(201);
        const v = await versionOf(l.id);
        await finish(b, l.id, v).expect(200);
        const ended = await upload(b, l.id, JPEG).expect(409);
        expect(ended.body.code).toBe('SESSION_NOT_ACTIVE');
      });
    });

    describe('2. POST /chatbot-requests/:id/messages with media', () => {
      it('IMAGE with a caption: stored as an OUT STAFF message with the media link, one conversation.staff_message with type/mediaId/mimeType/filename/caption, the bot receives it', async () => {
        const b = await branch();
        const { l, mediaId } = await withMedia(b);
        const clientMessageId = randomUUID();
        const res = await sendMedia(b, l.id, {
          clientMessageId,
          type: 'IMAGE',
          mediaId,
          caption: '  Así quedó tu pedido  ',
        }).expect(200);
        expect(res.body.message).toMatchObject({
          direction: 'OUT',
          author: 'STAFF',
          type: 'IMAGE',
          text: 'Así quedó tu pedido',
          deliveryStatus: 'QUEUED',
          clientMessageId,
          media: { id: mediaId, mimeType: 'image/jpeg', filename: 'foto.jpg' },
        });
        const stored = await prisma.conversationMessage.findUniqueOrThrow({
          where: { id: res.body.message.id },
        });
        expect(stored).toMatchObject({
          direction: 'OUT',
          author: 'STAFF',
          staffUserId: users.ana,
          type: 'IMAGE',
          mediaId,
          text: 'Así quedó tu pedido',
          deliveryStatus: 'QUEUED',
        });
        const feedItems = await items(b, l.id, 'conversation.staff_message');
        expect(feedItems).toHaveLength(1);
        expect(feedItems[0].payload).toEqual({
          requestId: l.id,
          handoffEpoch: 1,
          seq: stored.seq,
          messageId: stored.id,
          type: 'IMAGE',
          mediaId,
          mimeType: 'image/jpeg',
          filename: 'foto.jpg',
          caption: 'Así quedó tu pedido',
        });
        const feed = await asBot(
          b,
          server().get('/chatbot-api/feed?waitSeconds=0'),
        ).expect(200);
        const delivered = feed.body.items.filter(
          (i: any) => i.type === 'conversation.staff_message',
        );
        expect(delivered).toHaveLength(1);
        expect(delivered[0].payload).toMatchObject({
          type: 'IMAGE',
          mediaId,
          caption: 'Así quedó tu pedido',
        });
        const evs = await prisma.$queryRaw<Array<{ payload: any }>>`
          SELECT "payload" FROM "realtime_events"
          WHERE "tenantId" = ${b.tenantId} AND "requestId" = ${l.id}
            AND "type" = 'conversation.message'`;
        expect(evs.map((e) => e.payload.messageId)).toContain(stored.id);
      });

      it('DOCUMENT without caption (caption null); a replay of the same clientMessageId answers the same message, another body is 409', async () => {
        const b = await branch();
        const l = await liveRequest(b);
        await activeSession(b, l);
        const up = await upload(b, l.id, PDF, {
          filename: 'Cotización.pdf',
        }).expect(201);
        const clientMessageId = randomUUID();
        const body = {
          clientMessageId,
          type: 'DOCUMENT',
          mediaId: up.body.mediaId,
        };
        const first = await sendMedia(b, l.id, body).expect(200);
        expect(first.body.message).toMatchObject({
          type: 'DOCUMENT',
          text: '',
          media: { id: up.body.mediaId, mimeType: 'application/pdf' },
        });
        const [item] = await items(b, l.id, 'conversation.staff_message');
        expect(item.payload).toMatchObject({
          type: 'DOCUMENT',
          caption: null,
          mimeType: 'application/pdf',
        });
        const replay = await sendMedia(b, l.id, body).expect(200);
        expect(replay.body.message.id).toBe(first.body.message.id);
        expect(replay.body.message.media).toEqual(first.body.message.media);
        const clash = await sendMedia(b, l.id, {
          ...body,
          caption: 'otro',
        }).expect(409);
        expect(clash.body.code).toBe('IDEMPOTENCY_CONFLICT');
        expect(await items(b, l.id, 'conversation.staff_message')).toHaveLength(
          1,
        );
      });

      it('a mediaId that is unknown, from another tenant, of another request is 404 MEDIA_NOT_FOUND; purged is 422 MEDIA_PURGED; a type that does not fit is 422 MEDIA_TYPE_MISMATCH; nothing is enqueued', async () => {
        const b = await branch();
        const { l, mediaId } = await withMedia(b);
        const foreign = await branch();
        const fl = await liveRequest(foreign);
        await activeSession(foreign, fl);
        const foreignMedia = (await upload(foreign, fl.id, JPEG).expect(201))
          .body.mediaId;
        const other = await liveRequest(b);
        await activeSession(b, other);
        const otherMedia = (await upload(b, other.id, JPEG).expect(201)).body
          .mediaId;
        const purged = (await upload(b, l.id, JPEG).expect(201)).body.mediaId;
        // the retention purge deletes the object and clears the key
        await prisma.conversationMedia.update({
          where: { id: purged },
          data: { storageKey: null, purgedAt: new Date() },
        });
        const before = await countMessages(b, l.ref);
        for (const bad of [randomUUID(), foreignMedia, otherMedia]) {
          const res = await sendMedia(b, l.id, {
            type: 'IMAGE',
            mediaId: bad,
          }).expect(404);
          expect(res.body.code).toBe('MEDIA_NOT_FOUND');
        }
        const gone = await sendMedia(b, l.id, {
          type: 'IMAGE',
          mediaId: purged,
        }).expect(422);
        expect(gone.body.code).toBe('MEDIA_PURGED');
        const mismatch = await sendMedia(b, l.id, {
          type: 'DOCUMENT',
          mediaId,
        }).expect(422);
        expect(mismatch.body.code).toBe('MEDIA_TYPE_MISMATCH');
        expect(await countMessages(b, l.ref)).toBe(before);
        expect(await items(b, l.id, 'conversation.staff_message')).toEqual([]);
      });

      it('same checks as text: stale epoch 409, closed window 409, not the assignee 403, session not active 409; nothing is enqueued', async () => {
        const b = await branch();
        const { l, mediaId } = await withMedia(b);
        const stale = await sendMedia(b, l.id, {
          type: 'IMAGE',
          mediaId,
          expectedEpoch: 7,
        }).expect(409);
        expect(stale.body.code).toBe('STALE_EPOCH');
        const notMine = await sendMedia(
          b,
          l.id,
          { type: 'IMAGE', mediaId },
          { role: 'manager', userId: users.luis },
        ).expect(403);
        expect(notMine.body.code).toBe('NOT_ASSIGNEE');
        const c = await conversation(b, l.ref);
        const old = new Date(Date.now() - 25 * 60 * MIN);
        await prisma.chatbotConversation.update({
          where: { id: c.id },
          data: { lastCustomerMessageAt: old },
        });
        await prisma.chatbotRequest.update({
          where: { id: l.id },
          data: { lastCustomerMessageAt: old },
        });
        const closed = await sendMedia(b, l.id, {
          type: 'IMAGE',
          mediaId,
        }).expect(409);
        expect(closed.body.code).toBe('WINDOW_CLOSED');
        expect(await items(b, l.id, 'conversation.staff_message')).toEqual([]);

        const l2 = await liveRequest(b);
        await claim(b, l2.id).expect(200);
        const starting = await sendMedia(b, l2.id, {
          type: 'IMAGE',
          mediaId,
        }).expect(409);
        expect(starting.body.code).toBe('SESSION_NOT_ACTIVE');
        expect(await items(b, l2.id, 'conversation.staff_message')).toEqual([]);
      });

      it('the body is validated: TEXT unchanged, IMAGE/DOCUMENT need mediaId and take no text, TEXT takes no mediaId, caption is printable and ≤ 1024', async () => {
        const b = await branch();
        const { l, mediaId } = await withMedia(b);
        await sendMedia(b, l.id, { text: 'hola' }).expect(200);
        await sendMedia(b, l.id, { type: 'TEXT', text: 'hola 2' }).expect(200);
        await sendMedia(b, l.id, { type: 'IMAGE' }).expect(400);
        await sendMedia(b, l.id, {
          type: 'IMAGE',
          mediaId,
          text: 'no',
        }).expect(400);
        await sendMedia(b, l.id, { type: 'TEXT', text: 'x', mediaId }).expect(
          400,
        );
        await sendMedia(b, l.id, { text: 'x', caption: 'y' }).expect(400);
        await sendMedia(b, l.id, { type: 'IMAGE', mediaId: 'nope' }).expect(
          400,
        );
        await sendMedia(b, l.id, {
          type: 'IMAGE',
          mediaId,
          caption: 'x'.repeat(1025),
        }).expect(400);
        await sendMedia(b, l.id, { type: 'AUDIO', mediaId }).expect(400);
        await sendMedia(b, l.id, {
          type: 'IMAGE',
          mediaId,
          caption: 'ok',
        }).expect(200);
        expect(await items(b, l.id, 'conversation.staff_message')).toHaveLength(
          3,
        );
      });
    });

    describe('3. GET /chatbot-api/media/:id (bot, scope media:read)', () => {
      it('streams the bytes of a media attached to a staff message with Content-Type, Content-Disposition filename and no-store', async () => {
        const b = await branch();
        const { l, mediaId } = await withMedia(b);
        await sendMedia(b, l.id, { type: 'IMAGE', mediaId }).expect(200);
        const res = await download(b, mediaId).expect(200);
        expect(Buffer.isBuffer(res.body) && res.body.equals(JPEG)).toBe(true);
        expect(res.headers['content-type']).toMatch(/^image\/jpeg/);
        expect(res.headers['content-disposition']).toBe(
          'attachment; filename="foto.jpg"',
        );
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['x-content-type-options']).toBe('nosniff');
      });

      it('404 for an unknown id, another tenant, a purged file, a file no staff message carries (not sent yet, or a customer file); 403 without media:read', async () => {
        const b = await branch();
        const { l, mediaId } = await withMedia(b);
        // uploaded but never sent
        await download(b, mediaId).expect(404);
        await sendMedia(b, l.id, { type: 'IMAGE', mediaId }).expect(200);
        await download(b, mediaId).expect(200);

        await download(b, randomUUID()).expect(404);
        const foreign = await branch();
        await download(foreign, mediaId).expect(404);

        // a customer file (unit 9): attached to an IN message, never downloadable
        const customer = await prisma.conversationMedia.create({
          data: {
            tenantId: b.tenantId,
            storageKey: `conversation-media/${b.tenantId}/c.jpg`,
            mimeType: 'image/jpeg',
            sizeBytes: 3,
            sha256: 'a'.repeat(64),
            idempotencyKey: randomUUID(),
            purgeAfter: new Date(Date.now() + 1e9),
          },
        });
        mediaStorage.objects.set(`conversation-media/${b.tenantId}/c.jpg`, {
          bytes: JPEG,
          mimeType: 'image/jpeg',
        });
        const c = await conversation(b, l.ref);
        await prisma.conversationMessage.create({
          data: {
            tenantId: b.tenantId,
            conversationId: c.id,
            seq: 9000,
            direction: 'IN',
            author: 'CUSTOMER',
            type: 'IMAGE',
            mediaId: customer.id,
            purgeAfter: new Date(Date.now() + 1e9),
          },
        });
        await download(b, customer.id).expect(404);

        // purged after being sent
        await prisma.conversationMedia.update({
          where: { id: mediaId },
          data: { storageKey: null, purgedAt: new Date() },
        });
        await download(b, mediaId).expect(404);

        const token = `svc_${randomUUID()}`;
        const credential = await prisma.serviceCredential.create({
          data: {
            tenantId: b.tenantId,
            name: 'bot-no-media',
            hashedKey: createHash('sha256').update(token).digest('hex'),
            scopes: ['requests:read'],
            rateLimit: 600,
          },
        });
        credentials.push(credential.id);
        await download(b, mediaId, token).expect(403);
      });
    });

    describe('4. staff read', () => {
      it("the attendee's conversation read shows the media message as staff media (type, caption, media descriptor, QUEUED) and the proxy opens it for them", async () => {
        const b = await branch();
        const { l, mediaId } = await withMedia(b);
        const sent = await sendMedia(b, l.id, {
          type: 'IMAGE',
          mediaId,
          caption: 'Mira',
        }).expect(200);
        const read = await server()
          .get(`/chatbot-requests/${l.id}/conversation`)
          .set(as(b))
          .expect(200);
        const mine = read.body.items.find(
          (m: any) => m.id === sent.body.message.id,
        );
        expect(mine).toMatchObject({
          direction: 'OUT',
          author: 'STAFF',
          type: 'IMAGE',
          text: 'Mira',
          deliveryStatus: 'QUEUED',
          staff: { id: users.ana },
          media: { id: mediaId, mimeType: 'image/jpeg', purged: false },
        });
        const file = await server()
          .get(`/chatbot-media/${mediaId}`)
          .set(as(b))
          .buffer(true)
          .parse(collect)
          .expect(200);
        expect(file.headers['content-type']).toMatch(/^image\/jpeg/);
        // another user of the tenant, not the attendee, cannot open it
        await server()
          .get(`/chatbot-media/${mediaId}`)
          .set(as(b, 'attendee', users.luis))
          .expect(403);
      });
    });
  });

  describe('T11d (§4.5, S16 8): the paid template command', () => {
    /** A settings row with the defaults plus the template of the tenant. */
    async function templateSettings(
      b: Branch,
      templateName: string | null,
      templateLanguageCode?: string,
    ) {
      const d = defaultSettings();
      await prisma.chatbotAttentionSettings.create({
        data: {
          tenantId: b.tenantId,
          timeZone: d.openingHours.timeZone,
          days: d.openingHours.days as never,
          closedDates: [],
          slas: d.slas as never,
          windowWarningMinutes: d.windowWarningMinutes,
          templateCostText: d.templateCostText,
          enabledSubtypes: d.enabledSubtypes,
          receiptCloseMarginMinutes: d.receiptCloseMarginMinutes,
          schedulingEnabled: false,
          slotMinutes: d.scheduling.slotMinutes,
          slotsOffered: d.scheduling.slotsOffered,
          maxScheduledPerSlot: d.scheduling.maxScheduledPerSlot,
          templateName,
          ...(templateLanguageCode ? { templateLanguageCode } : {}),
        },
      });
    }
    /** The customer wrote `hoursAgo` hours ago (both window sources). */
    async function customerWroteAgo(b: Branch, l: Live, hoursAgo: number) {
      const at = new Date(Date.now() - hoursAgo * 60 * MIN);
      const c = await conversation(b, l.ref);
      await prisma.chatbotConversation.update({
        where: { id: c.id },
        data: { lastCustomerMessageAt: at, windowClosedAt: null },
      });
      await prisma.chatbotRequest.update({
        where: { id: l.id },
        data: { lastCustomerMessageAt: at },
      });
    }
    const template = (
      b: Branch,
      id: string,
      body: object,
      opts: { role?: string; userId?: string; key?: string } = {},
    ) => staffPost(b, `/chatbot-requests/${id}/template`, body, opts);
    const templateRows = (b: Branch, requestId: string) =>
      prisma.chatbotSessionTemplate.findMany({
        where: { tenantId: b.tenantId, requestId },
      });
    const statuses = (b: Branch, list: object[]) =>
      asBot(b, server().post('/chatbot-api/messages/statuses:batch')).send({
        statuses: list,
      });
    const messageOf = (id: string) =>
      prisma.conversationMessage.findUniqueOrThrow({ where: { id } });

    /**
     * ACTIVE session whose 24 h window has closed. `name`: the tenant's
     * template (default one), `null` = settings without a template name,
     * `false` = no settings row (already created for this branch, or defaults).
     */
    async function closedWindow(
      b: Branch,
      name: string | null | false = 'seguimiento_pedido',
      language?: string,
    ) {
      if (name !== false) await templateSettings(b, name, language);
      const l = await liveRequest(b);
      await activeSession(b, l);
      await customerWroteAgo(b, l, 25);
      return l;
    }

    it('with a closed window the attendee requests the approved template: a TEMPLATE message (QUEUED, STAFF, next seq), one template.requested {requestId, handoffEpoch, seq, messageId, templateName, languageCode}, the once-per-window row and a TEMPLATE_SENT audit event; the same key again is the same answer', async () => {
      const b = await branch();
      const l = await closedWindow(b);
      const key = randomUUID();
      const res = await template(b, l.id, { expectedEpoch: 1 }, { key }).expect(
        200,
      );
      expect(res.body.message).toMatchObject({
        type: 'TEMPLATE',
        author: 'STAFF',
        direction: 'OUT',
        deliveryStatus: 'QUEUED',
        clientMessageId: key,
        templateName: 'seguimiento_pedido',
        staff: { id: users.ana },
      });
      const [item] = await items(b, l.id, 'template.requested');
      expect(item.payload).toEqual({
        requestId: l.id,
        handoffEpoch: 1,
        seq: res.body.message.seq,
        messageId: res.body.message.id,
        templateName: 'seguimiento_pedido',
        languageCode: 'es_MX',
      });
      expect(item.conversationRef).toBe(l.ref);
      const stored = await messageOf(res.body.message.id);
      expect(stored).toMatchObject({
        type: 'TEMPLATE',
        author: 'STAFF',
        direction: 'OUT',
        deliveryStatus: 'QUEUED',
        staffUserId: users.ana,
        seq: res.body.message.seq,
      });
      const all = await msgs(b, l.ref);
      expect(all.at(-1)?.id).toBe(stored.id);
      const rows = await templateRows(b, l.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].messageId).toBe(stored.id);
      expect(rows[0].windowClosedAt.getTime()).toBeLessThan(Date.now());
      expect(
        (await events(l.id)).filter((e) => e.type === 'TEMPLATE_SENT'),
      ).toHaveLength(1);

      const replay = await template(
        b,
        l.id,
        { expectedEpoch: 1 },
        { key },
      ).expect(200);
      expect(replay.body.message.id).toBe(res.body.message.id);
      expect(await items(b, l.id, 'template.requested')).toHaveLength(1);
      expect(await templateRows(b, l.id)).toHaveLength(1);
    });

    it('languageCode follows the tenant setting templateLanguageCode (default es_MX)', async () => {
      const b = await branch();
      const l = await closedWindow(b, 'order_followup', 'en_US');
      await template(b, l.id, { expectedEpoch: 1 }).expect(200);
      const [item] = await items(b, l.id, 'template.requested');
      expect(item.payload).toMatchObject({
        templateName: 'order_followup',
        languageCode: 'en_US',
      });
    });

    it('outcomes follow the ACK matrix: PROVIDER_ACCEPTED → SENT with the wamid; DEFERRED_* are 422 OUTCOME_NOT_ALLOWED and the item stays pending; STALE → FAILED', async () => {
      const b = await branch();
      const l = await closedWindow(b);
      const sent = await template(b, l.id, { expectedEpoch: 1 }).expect(200);
      const [item] = await items(b, l.id, 'template.requested');
      for (const refused of [
        'DEFERRED_WINDOW_CLOSED',
        'DEFERRED_HUMAN_SESSION',
      ]) {
        const no = await outcome(b, item.deliveryId, {
          attemptId: randomUUID(),
          outcome: refused,
          attemptedAt: AT,
        }).expect(422);
        expect(no.body.code).toBe('OUTCOME_NOT_ALLOWED');
      }
      const wamid = `wamid.tpl.${randomUUID()}`;
      await outcome(b, item.deliveryId, accepted(wamid)).expect(200);
      expect(await messageOf(sent.body.message.id)).toMatchObject({
        deliveryStatus: 'SENT',
        waMessageId: wamid,
      });

      const l2 = await closedWindow(b, false);
      const second = await template(b, l2.id, { expectedEpoch: 1 }).expect(200);
      const [item2] = await items(b, l2.id, 'template.requested');
      await outcome(b, item2.deliveryId, {
        attemptId: randomUUID(),
        outcome: 'STALE',
        attemptedAt: AT,
      }).expect(200);
      expect((await messageOf(second.body.message.id)).deliveryStatus).toBe(
        'FAILED',
      );
    });

    it('refusals enqueue nothing: window still open 409 WINDOW_OPEN, no template configured 422 TEMPLATE_NOT_CONFIGURED, not the assignee 403, wrong epoch 409 STALE_EPOCH, STARTING 409 SESSION_NOT_ACTIVE, bad body 400, a conversation without a session 409/422', async () => {
      const b = await branch();
      await templateSettings(b, 'seguimiento_pedido');
      const open = await liveRequest(b);
      await activeSession(b, open);
      const stillOpen = await template(b, open.id, {
        expectedEpoch: 1,
      }).expect(409);
      expect(stillOpen.body.code).toBe('WINDOW_OPEN');

      await customerWroteAgo(b, open, 25);
      const mine = await template(
        b,
        open.id,
        { expectedEpoch: 1 },
        {
          userId: users.luis,
        },
      ).expect(403);
      expect(mine.body.code).toBe('NOT_ASSIGNEE');
      const wrong = await template(b, open.id, { expectedEpoch: 4 }).expect(
        409,
      );
      expect(wrong.body).toMatchObject({
        code: 'STALE_EPOCH',
        currentEpoch: 1,
      });
      await template(b, open.id, {}).expect(400);
      await template(b, open.id, {
        expectedEpoch: 1,
        templateName: 'x',
      }).expect(400);
      expect(await items(b, open.id, 'template.requested')).toHaveLength(0);

      const starting = await liveRequest(b);
      await claim(b, starting.id).expect(200);
      await customerWroteAgo(b, starting, 25);
      const early = await template(b, starting.id, {
        expectedEpoch: 1,
      }).expect(409);
      expect(early.body.code).toBe('SESSION_NOT_ACTIVE');
      expect(await items(b, starting.id, 'template.requested')).toHaveLength(0);

      // a tenant whose settings carry no template name
      const b2 = await branch();
      const l2 = await closedWindow(b2, null);
      const none = await template(b2, l2.id, { expectedEpoch: 1 }).expect(422);
      expect(none.body.code).toBe('TEMPLATE_NOT_CONFIGURED');
      // and a tenant that never saved settings (defaults: no template)
      const b3 = await branch();
      const l3 = await closedWindow(b3, false);
      const def = await template(b3, l3.id, { expectedEpoch: 1 }).expect(422);
      expect(def.body.code).toBe('TEMPLATE_NOT_CONFIGURED');
      expect(await templateRows(b2, l2.id)).toHaveLength(0);
      expect(await templateRows(b3, l3.id)).toHaveLength(0);
      expect(await templateRows(b, open.id)).toHaveLength(0);
    });

    it('once per closed window: while the first template is pending (QUEUED), SENT or UNKNOWN a second one is 409 TEMPLATE_ALREADY_SENT and enqueues nothing', async () => {
      const b = await branch();
      const l = await closedWindow(b);
      await template(b, l.id, { expectedEpoch: 1 }).expect(200);
      const queued = await template(b, l.id, { expectedEpoch: 1 }).expect(409);
      expect(queued.body.code).toBe('TEMPLATE_ALREADY_SENT');
      const [item] = await items(b, l.id, 'template.requested');
      await outcome(b, item.deliveryId, accepted(`wamid.tpl.${randomUUID()}`));
      const sent = await template(b, l.id, { expectedEpoch: 1 }).expect(409);
      expect(sent.body.code).toBe('TEMPLATE_ALREADY_SENT');
      expect(await items(b, l.id, 'template.requested')).toHaveLength(1);
      expect(await templateRows(b, l.id)).toHaveLength(1);

      const l2 = await closedWindow(b, false);
      await template(b, l2.id, { expectedEpoch: 1 }).expect(200);
      const [item2] = await items(b, l2.id, 'template.requested');
      await outcome(b, item2.deliveryId, {
        attemptId: randomUUID(),
        outcome: 'DELIVERY_UNKNOWN',
        attemptedAt: AT,
      }).expect(200);
      const unknown = await template(b, l2.id, { expectedEpoch: 1 }).expect(
        409,
      );
      expect(unknown.body.code).toBe('TEMPLATE_ALREADY_SENT');
    });

    it('F3: the once-per-window key moving (a later 131047 raises windowClosedAt) does not let a second template pass while the first is UNKNOWN', async () => {
      const b = await branch();
      await templateSettings(b, 'seguimiento_pedido');
      const l = await liveRequest(b);
      await activeSession(b, l);
      // a text the bot sent while the window was open: its wamid will carry the
      // later 131047
      const wamid = `wamid.f3.${randomUUID()}`;
      await say(b, l.id, 1, 'hola').expect(200);
      const [text] = await items(b, l.id, 'conversation.staff_message');
      await outcome(b, text.deliveryId, accepted(wamid)).expect(200);
      await customerWroteAgo(b, l, 25);

      const first = await template(b, l.id, { expectedEpoch: 1 }).expect(200);
      const [tpl] = await items(b, l.id, 'template.requested');
      await outcome(b, tpl.deliveryId, {
        attemptId: randomUUID(),
        outcome: 'DELIVERY_UNKNOWN',
        attemptedAt: AT,
      }).expect(200);
      const [row] = await templateRows(b, l.id);

      // Meta's verdict (the 131047 on the earlier text) lands later, with an
      // instant inside the old window: the chat's windowClosedAt moves, and so
      // does the instant the window "closed" (the old key)
      const verdictAt = new Date(Date.now() - 5 * 60 * MIN);
      await statuses(b, [
        {
          providerMessageId: wamid,
          status: 'FAILED',
          occurredAt: verdictAt.toISOString(),
          errorCode: '131047',
        },
      ]).expect(200);
      expect((await conversation(b, l.ref)).windowClosedAt?.getTime()).toBe(
        verdictAt.getTime(),
      );
      expect(verdictAt.getTime()).not.toBe(row.windowClosedAt.getTime());

      const second = await template(b, l.id, { expectedEpoch: 1 }).expect(409);
      expect(second.body.code).toBe('TEMPLATE_ALREADY_SENT');
      expect(await items(b, l.id, 'template.requested')).toHaveLength(1);
      expect(await templateRows(b, l.id)).toHaveLength(1);
      expect((await messageOf(first.body.message.id)).deliveryStatus).toBe(
        'UNKNOWN',
      );
      // the text message offer agrees
      expect(
        (await say(b, l.id, 1, 'otra').expect(409)).body.templateAllowed,
      ).toBe(false);
    });

    it('two parallel clicks: exactly one template is enqueued', async () => {
      const b = await branch();
      const l = await closedWindow(b);
      const results = await Promise.all([
        template(b, l.id, { expectedEpoch: 1 }),
        template(b, l.id, { expectedEpoch: 1 }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await items(b, l.id, 'template.requested')).toHaveLength(1);
      expect(await templateRows(b, l.id)).toHaveLength(1);
    });

    it('a template Meta refused (STALE → FAILED) can be requested again: a new message and item, the same once-per-window row now points at the new message', async () => {
      const b = await branch();
      const l = await closedWindow(b);
      const first = await template(b, l.id, { expectedEpoch: 1 }).expect(200);
      const [item] = await items(b, l.id, 'template.requested');
      await outcome(b, item.deliveryId, {
        attemptId: randomUUID(),
        outcome: 'STALE',
        attemptedAt: AT,
      }).expect(200);
      const [row] = await templateRows(b, l.id);

      const again = await template(b, l.id, { expectedEpoch: 1 }).expect(200);
      expect(again.body.message.id).not.toBe(first.body.message.id);
      expect(again.body.message.seq).toBeGreaterThan(first.body.message.seq);
      const all = await items(b, l.id, 'template.requested');
      expect(all).toHaveLength(2);
      expect(all[1].payload).toMatchObject({
        messageId: again.body.message.id,
      });
      const rows = await templateRows(b, l.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(row.id);
      expect(rows[0].messageId).toBe(again.body.message.id);
      // and the new one is now the pending one
      const third = await template(b, l.id, { expectedEpoch: 1 }).expect(409);
      expect(third.body.code).toBe('TEMPLATE_ALREADY_SENT');
    });

    it('an async failure after the bot accepted it (PROVIDER_ACCEPTED, then a FAILED status) also allows a retry; a DELIVERED one does not', async () => {
      const b = await branch();
      const l = await closedWindow(b);
      const first = await template(b, l.id, { expectedEpoch: 1 }).expect(200);
      const [item] = await items(b, l.id, 'template.requested');
      const wamid = `wamid.tpl.${randomUUID()}`;
      await outcome(b, item.deliveryId, accepted(wamid)).expect(200);
      const refused = await template(b, l.id, { expectedEpoch: 1 }).expect(409);
      expect(refused.body.code).toBe('TEMPLATE_ALREADY_SENT');

      await statuses(b, [
        {
          providerMessageId: wamid,
          status: 'FAILED',
          occurredAt: new Date().toISOString(),
          errorCode: '131026',
        },
      ]).expect(200);
      expect((await messageOf(first.body.message.id)).deliveryStatus).toBe(
        'FAILED',
      );
      const retry = await template(b, l.id, { expectedEpoch: 1 }).expect(200);
      expect(retry.body.message.id).not.toBe(first.body.message.id);
      const [, second] = await items(b, l.id, 'template.requested');
      const wamid2 = `wamid.tpl.${randomUUID()}`;
      await outcome(b, second.deliveryId, accepted(wamid2)).expect(200);
      await statuses(b, [
        {
          providerMessageId: wamid2,
          status: 'DELIVERED',
          occurredAt: new Date().toISOString(),
        },
      ]).expect(200);
      const noMore = await template(b, l.id, { expectedEpoch: 1 }).expect(409);
      expect(noMore.body.code).toBe('TEMPLATE_ALREADY_SENT');
    });

    it('WINDOW_CLOSED on a text message reports templateAllowed: true only when a template can be requested now', async () => {
      const b = await branch();
      const l = await closedWindow(b);
      const closed = await say(b, l.id, 1, 'hola').expect(409);
      expect(closed.body).toMatchObject({
        code: 'WINDOW_CLOSED',
        templateAllowed: true,
      });
      await template(b, l.id, { expectedEpoch: 1 }).expect(200);
      const after = await say(b, l.id, 1, 'hola otra vez').expect(409);
      expect(after.body).toMatchObject({
        code: 'WINDOW_CLOSED',
        templateAllowed: false,
      });
      // a failed template makes it available again
      const [item] = await items(b, l.id, 'template.requested');
      await outcome(b, item.deliveryId, {
        attemptId: randomUUID(),
        outcome: 'STALE',
        attemptedAt: AT,
      }).expect(200);
      const again = await say(b, l.id, 1, 'y otra').expect(409);
      expect(again.body.templateAllowed).toBe(true);

      // no template name configured: false
      const b2 = await branch();
      const l2 = await closedWindow(b2, null);
      const none = await say(b2, l2.id, 1, 'hola').expect(409);
      expect(none.body).toMatchObject({
        code: 'WINDOW_CLOSED',
        templateAllowed: false,
      });
    });

    it('the customer answering the template reopens the window (staff can write); when it closes again a new template is allowed (a new once-per-window row)', async () => {
      const b = await branch();
      const l = await closedWindow(b);
      const first = await template(b, l.id, { expectedEpoch: 1 }).expect(200);
      const [item] = await items(b, l.id, 'template.requested');
      await outcome(b, item.deliveryId, accepted(`wamid.tpl.${randomUUID()}`));
      await mirrorIn(b, l.ref, 'sí, gracias').expect(200);
      await say(b, l.id, 1, 'qué bueno que contestas').expect(200);

      // a day later the window is closed again (the clock is simulated by
      // moving the customer's reply back, so the first template moves back
      // with it: it was sent BEFORE that reply, which is what lets a new one
      // through since F3)
      await customerWroteAgo(b, l, 26);
      // (messages are immutable: the test's admin connection skips the
      // trigger for this one backdating)
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
        await tx.$executeRaw(
          Prisma.sql`UPDATE "conversation_messages"
            SET "receivedAt" = ${new Date(Date.now() - 27 * 60 * MIN)}
            WHERE "id" = ${first.body.message.id as string}`,
        );
      });
      const second = await template(b, l.id, { expectedEpoch: 1 }).expect(200);
      expect(second.body.message.id).not.toBe(first.body.message.id);
      const rows = await templateRows(b, l.id);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.windowClosedAt.getTime())).size).toBe(2);
    });

    it('a COMPLAINT can also request it, and the template is refused for a request that is not a live conversation (a restock one) and after the session ended', async () => {
      const b = await branch();
      const l = await closedWindow(b);
      await prisma.chatbotRequest.update({
        where: { id: l.id },
        data: { subtype: 'COMPLAINT' },
      });
      await template(b, l.id, { expectedEpoch: 1 }).expect(200);

      const done = await closedWindow(b, false);
      const v = await versionOf(done.id);
      await finish(b, done.id, v).expect(200);
      const ended = await template(b, done.id, { expectedEpoch: 1 }).expect(
        409,
      );
      expect(ended.body.code).toBe('SESSION_NOT_ACTIVE');
      expect(await items(b, done.id, 'template.requested')).toHaveLength(0);

      const unknown = await template(b, randomUUID(), {
        expectedEpoch: 1,
      }).expect(404);
      expect(unknown.body.code).toBe('NOT_FOUND');
    });
  });

  describe('T11d notices (§4.6, §5.1): "el cliente escribió" and "sin contestar en 5 / 15 min"', () => {
    const notifyRows = async (b: Branch, requestId: string) =>
      (
        await prisma.outboxEvent.findMany({
          where: {
            tenantId: b.tenantId,
            aggregateId: requestId,
            eventType: 'chatbot_request.notify',
          },
          orderBy: { createdAt: 'asc' },
        })
      ).map((r) => ({
        payload: r.payload as Record<string, unknown>,
        nextAttemptAt: r.nextAttemptAt,
      }));
    const ofType = async (b: Branch, requestId: string, type: string) =>
      (await notifyRows(b, requestId)).filter((r) => r.payload.type === type);
    const tickAt = (ms: number) =>
      sweepScheduler().tick(new Date(Date.now() + ms));

    it('the customer writing in an ACTIVE session tells the attendee once per unanswered burst (a second message before a reply adds nothing; after the attendee replies the next one tells again)', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      await activeSession(b, l);
      expect(await notifyRows(b, l.id)).toHaveLength(0);

      await mirrorIn(b, l.ref, 'hola, ¿hay alguien?').expect(200);
      await tickAt(0);
      const first = await ofType(b, l.id, 'CONVERSATION_CUSTOMER_MESSAGE');
      expect(first).toHaveLength(1);
      expect(first[0].payload).toMatchObject({
        type: 'CONVERSATION_CUSTOMER_MESSAGE',
        requestId: l.id,
        folio: 1,
        subtype: 'TALK_TO_HUMAN',
        recipientUserId: users.ana,
      });
      // never customer data (§6.3)
      expect(JSON.stringify(first[0].payload)).not.toMatch(/hola|5255830|wa:/);
      // not held for business hours: the staff clocks of a live chat never pause
      expect(first[0].nextAttemptAt.getTime()).toBeLessThanOrEqual(
        Date.now() + 1000,
      );

      await tickAt(0);
      await mirrorIn(b, l.ref, 'sigo aquí').expect(200);
      await tickAt(0);
      expect(
        await ofType(b, l.id, 'CONVERSATION_CUSTOMER_MESSAGE'),
      ).toHaveLength(1);

      await say(b, l.id, 1, 'Hola, ya te atiendo').expect(200);
      await mirrorIn(b, l.ref, 'gracias').expect(200);
      await tickAt(0);
      const again = await ofType(b, l.id, 'CONVERSATION_CUSTOMER_MESSAGE');
      expect(again).toHaveLength(2);
      expect(again[0].payload.dedupKey).not.toBe(again[1].payload.dedupKey);
    });

    it('unanswered: nothing before 5 min, one notice to the attendee at 5 min, one to the reassigners at 15 min (level 15), never repeated', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      await activeSession(b, l);
      await mirrorIn(b, l.ref, '¿me contestan?').expect(200);

      await tickAt(4 * MIN + 59_000);
      expect(await ofType(b, l.id, 'CONVERSATION_UNANSWERED')).toHaveLength(0);

      await tickAt(5 * MIN + 1000);
      await tickAt(5 * MIN + 2000);
      const five = await ofType(b, l.id, 'CONVERSATION_UNANSWERED');
      expect(five).toHaveLength(1);
      expect(five[0].payload).toMatchObject({
        level: 5,
        recipientUserId: users.ana,
        requestId: l.id,
        folio: 1,
        subtype: 'TALK_TO_HUMAN',
      });
      expect(five[0].nextAttemptAt.getTime()).toBeLessThanOrEqual(
        Date.now() + 1000,
      );

      await tickAt(14 * MIN);
      expect(await ofType(b, l.id, 'CONVERSATION_UNANSWERED')).toHaveLength(1);
      await tickAt(15 * MIN + 1000);
      await tickAt(15 * MIN + 2000);
      await tickAt(30 * MIN);
      const all = await ofType(b, l.id, 'CONVERSATION_UNANSWERED');
      expect(all).toHaveLength(2);
      expect(all[1].payload).toMatchObject({ level: 15 });
      // the 15-minute notice goes to whoever holds update:ChatbotRequestAssignment
      expect(all[1].payload.recipientUserId).toBeUndefined();
      expect(all[0].payload.dedupKey).not.toBe(all[1].payload.dedupKey);
    });

    it('a sweep that was down for 16 minutes sends only the 15-minute notice', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      await activeSession(b, l);
      await mirrorIn(b, l.ref, 'hola').expect(200);
      await tickAt(16 * MIN);
      const rows = await ofType(b, l.id, 'CONVERSATION_UNANSWERED');
      expect(rows).toHaveLength(1);
      expect(rows[0].payload).toMatchObject({ level: 15 });
    });

    it('an attendee reply stops the clock; a later customer message restarts it from zero', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      await activeSession(b, l);
      await mirrorIn(b, l.ref, 'hola').expect(200);
      await say(b, l.id, 1, 'Aquí estoy').expect(200);
      await tickAt(20 * MIN);
      expect(await ofType(b, l.id, 'CONVERSATION_UNANSWERED')).toHaveLength(0);

      await mirrorIn(b, l.ref, 'otra duda').expect(200);
      await tickAt(4 * MIN);
      expect(await ofType(b, l.id, 'CONVERSATION_UNANSWERED')).toHaveLength(0);
      await tickAt(5 * MIN + 1000);
      expect(await ofType(b, l.id, 'CONVERSATION_UNANSWERED')).toHaveLength(1);
    });

    it('no notice for a session that is not ACTIVE (ENDING / ENDED) or a request nobody holds', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      const { version } = await activeSession(b, l);
      await mirrorIn(b, l.ref, 'hola').expect(200);
      await finish(b, l.id, version).expect(200);
      await tickAt(20 * MIN);
      expect(await ofType(b, l.id, 'CONVERSATION_UNANSWERED')).toHaveLength(0);
      expect(
        await ofType(b, l.id, 'CONVERSATION_CUSTOMER_MESSAGE'),
      ).toHaveLength(0);

      // a chat with no session at all (customer messages of a plain request)
      const plain = await liveRequest(b);
      await mirrorIn(b, plain.ref, 'hola').expect(200);
      await tickAt(20 * MIN);
      expect(await notifyRows(b, plain.id)).toHaveLength(0);
    });
  });

  // Verify F4: the attendee's access to the chat and to the files of the
  // session ends with the session (finish), the hand-over (reassign) and the
  // start-timeout revert; the new attendee reads.
  describe('F4: the former attendee loses the conversation read and the media proxy', () => {
    const JPEG = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from('f4-photo-bytes'),
    ]);
    const collect = (
      res: any,
      cb: (err: Error | null, body: Buffer) => void,
    ) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    };
    const readChat = (b: Branch, id: string, userId: string) =>
      server()
        .get(`/chatbot-requests/${id}/conversation`)
        .set(as(b, 'attendee', userId));
    const openMedia = (b: Branch, mediaId: string, userId: string) =>
      server()
        .get(`/chatbot-media/${mediaId}`)
        .set(as(b, 'attendee', userId))
        .buffer(true)
        .parse(collect);

    /** An ACTIVE session of Ana with one photo sent to the customer. */
    async function withPhoto(b: Branch) {
      const l = await liveRequest(b);
      const { version } = await activeSession(b, l);
      const up = await server()
        .post(`/chatbot-requests/${l.id}/media`)
        .set(as(b))
        .set('Idempotency-Key', randomUUID())
        .attach('file', JPEG, {
          filename: 'foto.jpg',
          contentType: 'application/octet-stream',
        })
        .expect(201);
      const mediaId = up.body.mediaId as string;
      const clientMessageId = randomUUID();
      await staffPost(
        b,
        `/chatbot-requests/${l.id}/messages`,
        {
          clientMessageId,
          expectedEpoch: 1,
          type: 'IMAGE',
          mediaId,
          caption: 'Mira',
        },
        { key: clientMessageId },
      ).expect(200);
      // while attending, Ana reads and opens it
      await readChat(b, l.id, users.ana).expect(200);
      await openMedia(b, mediaId, users.ana).expect(200);
      return { l, version, mediaId };
    }

    it('after finish', async () => {
      const b = await branch();
      const { l, version, mediaId } = await withPhoto(b);
      await finish(b, l.id, version).expect(200);
      await readChat(b, l.id, users.ana).expect(403);
      await openMedia(b, mediaId, users.ana).expect(403);
    });

    it('after reassign: the old attendee gets 403 and the new one can read and open the file', async () => {
      const b = await branch();
      await makeAssignable(b, users.luis);
      const { l, version, mediaId } = await withPhoto(b);
      await reassign(b, l.id, version, users.luis).expect(200);
      await readChat(b, l.id, users.ana).expect(403);
      await openMedia(b, mediaId, users.ana).expect(403);

      const read = await readChat(b, l.id, users.luis).expect(200);
      expect(read.body.items.some((m: any) => m.media?.id === mediaId)).toBe(
        true,
      );
      const file = await openMedia(b, mediaId, users.luis).expect(200);
      expect(Buffer.isBuffer(file.body) && file.body.equals(JPEG)).toBe(true);
    });

    it('after the start-timeout revert (the request is NEW again, nobody holds it)', async () => {
      const b = await branch();
      const l = await liveRequest(b);
      await claim(b, l.id).expect(200);
      await readChat(b, l.id, users.ana).expect(200);
      await sweepScheduler().tick(new Date(Date.now() + 121_000));
      expect((await sessions(b, l.id))[0].state).toBe('ENDED');
      expect((await row(l.id)).status).toBe('NEW');
      await readChat(b, l.id, users.ana).expect(403);
    });
  });

  // SLICE2-END
});
