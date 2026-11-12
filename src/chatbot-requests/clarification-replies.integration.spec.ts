/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- supertest response bodies are untyped JSON */
/**
 * human-intervention / unit 10 — clarification replies end to end through HTTP
 * against REAL PostgreSQL (contract §2.2, §3.3, §3.8, §4.5, §6.2, §12.12):
 *
 *   staff  POST /chatbot-requests/:id/reply → RESOLVED (a NEW request is claimed
 *          by the replier in the same step, S13), REPLIED audit (message
 *          id, never the text), `request.answered` feed item in the same
 *          transaction, realtime `request.resolved`;
 *   bot    feed item → ACK (accepted, deferred for the closed 24 h window,
 *          pending-deliveries and recovery, delivered later when the customer
 *          writes again, never twice);
 *   mirror the bot reports the message it sent with `staffReplyId`, and the
 *          staff read shows it as STAFF.
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
  CHATBOT_REQUEST_RELATION_STORE,
  ChatbotRequestRelationsService,
} from './application/chatbot-request-relations.service';
import {
  CHATBOT_REQUEST_READ_STORE,
  ChatbotRequestReadsService,
  CUSTOMER_KEY_SEALER,
  INBOX_CLOCK,
  SLA_PAUSE_READER,
} from './application/chatbot-request-reads.service';
import { CustomerKeySealer } from './domain/customer-key-sealer';
import { PgFeedWakeup } from './infrastructure/feed-wakeup';
import { PrismaChatbotFeedStore } from './infrastructure/prisma-chatbot-feed.store';
import { PrismaChatbotRecoveryStore } from './infrastructure/prisma-chatbot-recovery.store';
import { PrismaChatbotRequestCommandStore } from './infrastructure/prisma-chatbot-request-command.store';
import { PrismaChatbotRequestReadStore } from './infrastructure/prisma-chatbot-request-read.store';
import { PrismaChatbotRequestRelationStore } from './infrastructure/prisma-chatbot-request-relation.store';
import { PrismaSlaPauseReader } from './infrastructure/prisma-sla-pause.reader';
import { BotFeedController } from './presentation/bot-feed.controller';
import { BotRecoveryController } from './presentation/bot-recovery.controller';
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
const ROLES: Record<string, Grant[]> = {
  manager: [
    ...READ_UPDATE,
    ['update', 'ChatbotRequestAssignment'],
    ['read', 'ChatbotConversation'],
    ['read', 'CustomerPhone'],
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

const TEXT = 'Sí, es apto desde las 8 semanas.';
const TEAM_PREFIX = 'Le comparto la respuesta del equipo:';
const NOW = new Date('2026-11-12T18:00:00.000Z');

describeIfDb('clarification replies (PostgreSQL)', () => {
  const prisma = integrationPrisma();
  let app: INestApplication;
  const tenants: string[] = [];
  const credentials: string[] = [];
  const users = { ana: randomUUID(), luis: randomUUID() };
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
        ChatbotRequestCommandsController,
        ChatbotRequestRelationsController,
        ChatbotRequestReadsController,
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
        {
          provide: CUSTOMER_KEY_SEALER,
          useValue: new CustomerKeySealer('integration-secret-of-some-length'),
        },
        { provide: INBOX_CLOCK, useValue: () => NOW },
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
        data: { id, email: `${id}@reply.test`, hashedPassword: 'x', name },
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
      data: { id, name: 'Sucursal Respuestas', slug: `cr-reply-${id}` },
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

  const as = (b: Branch, role = 'cashier', userId: string = users.ana) => ({
    'x-test-role': role,
    'x-test-tenant': b.tenantId,
    'x-test-user': userId,
  });
  const server = () => request(app.getHttpServer());
  const reply = (
    b: Branch,
    requestId: string,
    body: object,
    opts: { role?: string; userId?: string; key?: string | null } = {},
  ) => {
    const call = server()
      .post(`/chatbot-requests/${requestId}/reply`)
      .set(as(b, opts.role, opts.userId))
      .send(body);
    return opts.key === null
      ? call
      : call.set('Idempotency-Key', opts.key ?? randomUUID());
  };
  const detail = (
    b: Branch,
    id: string,
    role = 'cashier',
    userId: string = users.ana,
  ) =>
    server()
      .get(`/chatbot-requests/${id}`)
      .set(as(b, role, userId));
  const asBot = (b: Branch, req: request.Test) =>
    req
      .set('Authorization', `Bearer ${b.token}`)
      .set('X-Branch-Id', b.tenantId);
  const botGet = (b: Branch, path: string) => asBot(b, server().get(path));
  const ack = (b: Branch, deliveryId: string, body: object) =>
    asBot(
      b,
      server().post(`/chatbot-api/deliveries/${deliveryId}/outcome`),
    ).send(body);

  /** An open clarification held by `holder` (or NEW), like intake leaves it. */
  async function question(
    b: Branch,
    over: Record<string, unknown> = {},
    holder: 'ana' | 'luis' | null = 'ana',
  ) {
    const n = ++seq;
    const claim =
      holder === null
        ? {}
        : {
            status: 'IN_PROGRESS' as const,
            assigneeUserId: users[holder],
            assigneeDisplayName: holder === 'ana' ? 'Ana' : 'Luis',
            claimedAt: new Date('2026-11-12T17:00:00Z'),
          };
    return prisma.chatbotRequest.create({
      data: {
        tenantId: b.tenantId,
        folio: ++b.folio,
        kind: 'CLARIFICATION',
        subtype: 'UNKNOWN_QUESTION',
        customerKey: `5255810${n}`,
        conversationRef: `wa:5255810${n}`,
        summary: '¿Sirve para cachorros?',
        source: 'chatbot',
        sourceRequestId: randomUUID(),
        lastCustomerMessageAt: new Date('2026-11-12T10:00:00Z'),
        whatsappWindowClosesAt: new Date('2026-11-13T10:00:00Z'),
        ...claim,
        ...over,
      },
    });
  }

  const feedItems = (b: Branch, requestId: string) =>
    prisma.chatbotFeedItem.findMany({
      where: { tenantId: b.tenantId, requestId, type: 'request.answered' },
    });
  const events = (requestId: string) =>
    prisma.chatbotRequestEvent.findMany({
      where: { requestId },
      // DELIVERY_OUTCOME events keep the request's version, so version alone
      // does not order them.
      orderBy: [{ version: 'asc' }, { createdAt: 'asc' }],
    });
  const realtime = (b: Branch, requestId: string) =>
    prisma.$queryRaw<
      Array<{ type: string; payload: Record<string, unknown> }>
    >`SELECT "type", "payload" FROM "realtime_events"
      WHERE "tenantId" = ${b.tenantId} AND "requestId" = ${requestId}
      ORDER BY "id"`;

  // ------------------------------------------------------------------ staff

  describe('the reply command', () => {
    it('resolves the clarification, audits the message id (not the text), feeds the bot and announces request.resolved', async () => {
      const b = await branch();
      const q = await question(b);
      const res = await reply(b, q.id, {
        expectedVersion: 1,
        text: TEXT,
      }).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.request).toMatchObject({
        id: q.id,
        status: 'RESOLVED',
        displayStatus: 'RESOLVED',
        version: 2,
        assignee: { id: users.ana },
      });

      const row = await prisma.chatbotRequest.findUniqueOrThrow({
        where: { id: q.id },
      });
      expect(row).toMatchObject({
        status: 'RESOLVED',
        version: 2,
        resolvedByActorId: users.ana,
        nextSlaCheckAt: null,
      });
      expect(row.closedAt).not.toBeNull();
      const resolution = row.resolution as Record<string, string>;
      expect(resolution).toMatchObject({ action: 'REPLY', text: TEXT });
      expect(resolution.replyId).toMatch(/^[0-9a-f-]{36}$/);

      const audit = (await events(q.id)).filter((e) => e.type === 'REPLIED');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorKind: 'USER',
        actorId: users.ana,
        fromStatus: 'IN_PROGRESS',
        toStatus: 'RESOLVED',
        version: 2,
        data: { messageId: resolution.replyId },
      });
      expect(JSON.stringify(audit[0].data)).not.toContain('apto');

      const items = await feedItems(b, q.id);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        conversationRef: q.conversationRef,
        payload: {
          kind: 'CLARIFICATION',
          subtype: 'UNKNOWN_QUESTION',
          action: 'REPLY',
          replyId: resolution.replyId,
          text: TEXT,
          prefix: TEAM_PREFIX,
          staffText: TEXT,
        },
      });

      const stream = await realtime(b, q.id);
      expect(stream.map((e) => e.type)).toContain('request.resolved');
      expect(
        stream.find((e) => e.type === 'request.resolved')?.payload,
      ).toEqual({ version: 2, cause: 'REPLIED' });

      const group = await prisma.chatbotCustomerGroup.findUnique({
        where: {
          tenantId_customerKey: {
            tenantId: b.tenantId,
            customerKey: q.customerKey,
          },
        },
      });
      expect(group?.openCount ?? 0).toBe(0);
    });

    it('shows the reply in the detail, closes the actions and lists the delivery as PENDING', async () => {
      const b = await branch();
      const q = await question(b);
      const before = await detail(b, q.id).expect(200);
      expect(before.body.reply).toBeNull();
      expect(before.body.allowedActions).toContain('REPLY');
      await reply(b, q.id, { expectedVersion: 1, text: TEXT }).expect(200);
      const after = await detail(b, q.id).expect(200);
      expect(after.body.reply).toMatchObject({
        text: TEXT,
        repliedBy: { id: users.ana, displayName: 'ana' },
      });
      expect(after.body.reply.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(after.body.allowedActions).toEqual([]);
      expect(after.body.deliveries).toHaveLength(1);
      expect(after.body.deliveries[0]).toMatchObject({
        type: 'request.answered',
        outcome: 'PENDING',
      });
    });

    it('stores markup as typed text, drops control characters and trims', async () => {
      const b = await branch();
      const q = await question(b);
      await reply(b, q.id, {
        expectedVersion: 1,
        text: '  <b>Sí</b> & <script>x()</script>\u0000\n  ',
      }).expect(200);
      const row = await prisma.chatbotRequest.findUniqueOrThrow({
        where: { id: q.id },
      });
      expect((row.resolution as { text: string }).text).toBe(
        '<b>Sí</b> & <script>x()</script>',
      );
    });
  });

  describe('replying to a NEW clarification claims it (S13, like resolve)', () => {
    it('the replier becomes the assignee and the request is RESOLVED in one step, with one REPLIED event and no CLAIMED', async () => {
      const b = await branch();
      const q = await question(b, {}, null);
      const res = await reply(
        b,
        q.id,
        { expectedVersion: 1, text: TEXT },
        { userId: users.luis },
      ).expect(200);
      expect(res.body.request).toMatchObject({
        status: 'RESOLVED',
        version: 2,
        assignee: { id: users.luis, displayName: 'luis' },
      });
      const row = await prisma.chatbotRequest.findUniqueOrThrow({
        where: { id: q.id },
      });
      expect(row).toMatchObject({
        status: 'RESOLVED',
        assigneeUserId: users.luis,
        resolvedByActorId: users.luis,
      });
      expect(row.claimedAt).not.toBeNull();
      const audit = await events(q.id);
      expect(audit.map((e) => e.type)).toEqual(['REPLIED']);
      expect(audit[0]).toMatchObject({
        actorId: users.luis,
        fromStatus: 'NEW',
        toStatus: 'RESOLVED',
        version: 2,
      });
      expect(await feedItems(b, q.id)).toHaveLength(1);
      const stream = await realtime(b, q.id);
      expect(stream.map((e) => e.type)).toEqual(['request.resolved']);
    });

    it('replays idempotently and refuses a stale version on a NEW request', async () => {
      const b = await branch();
      const q = await question(b, { version: 3 }, null);
      await reply(b, q.id, { expectedVersion: 2, text: TEXT }).expect(409);
      const key = randomUUID();
      const first = await reply(
        b,
        q.id,
        { expectedVersion: 3, text: TEXT },
        { key },
      ).expect(200);
      const again = await reply(
        b,
        q.id,
        { expectedVersion: 3, text: TEXT },
        { key },
      ).expect(200);
      expect(again.body).toEqual(first.body);
      expect(await feedItems(b, q.id)).toHaveLength(1);
    });

    it('two people reply to the same NEW request at once: exactly one wins, the other gets 409 and nothing of theirs is stored', async () => {
      const b = await branch();
      const q = await question(b, {}, null);
      const results = await Promise.all([
        reply(
          b,
          q.id,
          { expectedVersion: 1, text: 'Respuesta de Ana' },
          { userId: users.ana },
        ),
        reply(
          b,
          q.id,
          { expectedVersion: 1, text: 'Respuesta de Luis' },
          { userId: users.luis },
        ),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      const loser = results.find((r) => r.status !== 200);
      expect(loser?.status).toBe(409);
      expect(loser?.body.code).toBe('REQUEST_CLOSED');
      const winner = results.find((r) => r.status === 200);
      const row = await prisma.chatbotRequest.findUniqueOrThrow({
        where: { id: q.id },
      });
      expect(row.assigneeUserId).toBe(winner?.body.request.assignee.id);
      expect(
        (await events(q.id)).filter((e) => e.type === 'REPLIED'),
      ).toHaveLength(1);
      expect(await feedItems(b, q.id)).toHaveLength(1);
    });

    it('a claim and a reply racing on a NEW request leave one holder: the loser gets its exact code, never two answers', async () => {
      // Both orders happen over a few rounds; each is checked exactly.
      for (let round = 0; round < 4; round++) {
        const b = await branch();
        const q = await question(b, {}, null);
        const [claim, answer] = await Promise.all([
          server()
            .post(`/chatbot-requests/${q.id}/claim`)
            .set(as(b, 'cashier', users.luis))
            .set('Idempotency-Key', randomUUID())
            .send({ expectedVersion: 1 }),
          reply(
            b,
            q.id,
            { expectedVersion: 1, text: TEXT },
            { userId: users.ana },
          ),
        ]);
        expect(
          [claim.status, answer.status].filter((x) => x === 200),
        ).toHaveLength(1);
        const row = await prisma.chatbotRequest.findUniqueOrThrow({
          where: { id: q.id },
        });
        const replied = (await events(q.id)).filter(
          (e) => e.type === 'REPLIED',
        );
        if (answer.status === 200) {
          // The reply took and closed it in one step; the claim finds it closed.
          expect(claim.status).toBe(409);
          expect(claim.body.code).toBe('REQUEST_CLOSED');
          expect(row).toMatchObject({
            status: 'RESOLVED',
            assigneeUserId: users.ana,
          });
          expect(replied).toHaveLength(1);
          expect(await feedItems(b, q.id)).toHaveLength(1);
        } else {
          // The claim won: Luis holds it and Ana, not the holder, is refused.
          expect(answer.status).toBe(403);
          expect(answer.body.code).toBe('NOT_ASSIGNEE');
          expect(row).toMatchObject({
            status: 'IN_PROGRESS',
            assigneeUserId: users.luis,
          });
          expect(replied).toHaveLength(0);
          expect(await feedItems(b, q.id)).toHaveLength(0);
        }
      }
    });
  });

  describe('a reply racing a cancel or a merge: one winner, consistent state, nothing from the loser', () => {
    const cancel = (b: Branch, id: string, userId: string) =>
      server()
        .post(`/chatbot-requests/${id}/cancel`)
        .set(as(b, 'cashier', userId))
        .set('Idempotency-Key', randomUUID())
        .send({ expectedVersion: 1, reason: 'OTHER', note: 'ya no aplica' });
    const merge = (b: Branch, id: string, intoId: string, userId: string) =>
      server()
        .post(`/chatbot-requests/${id}/merge`)
        .set(as(b, 'cashier', userId))
        .set('Idempotency-Key', randomUUID())
        .send({
          expectedVersion: 1,
          intoRequestId: intoId,
          intoExpectedVersion: 1,
        });
    const feedOf = (b: Branch, requestId: string, type: string) =>
      prisma.chatbotFeedItem.count({
        where: { tenantId: b.tenantId, requestId, type },
      });

    it.each([
      ['NEW', null],
      ['held by the replier', 'ana'],
    ] as const)('reply vs cancel on a request %s', async (_label, holder) => {
      // Both orders happen over a few rounds; each is checked exactly.
      for (let round = 0; round < 4; round++) {
        const b = await branch();
        const q = await question(b, {}, holder);
        const [answer, cancelled] = await Promise.all([
          reply(
            b,
            q.id,
            { expectedVersion: 1, text: TEXT },
            { userId: users.ana },
          ),
          cancel(b, q.id, users.ana),
        ]);
        expect(
          [answer.status, cancelled.status].filter((x) => x === 200),
        ).toHaveLength(1);
        const row = await prisma.chatbotRequest.findUniqueOrThrow({
          where: { id: q.id },
        });
        const types = (await events(q.id)).map((e) => e.type);
        if (answer.status === 200) {
          expect(cancelled.status).toBe(409);
          expect(cancelled.body.code).toBe('REQUEST_CLOSED');
          expect(row.status).toBe('RESOLVED');
          expect(types.filter((t) => t === 'REPLIED')).toHaveLength(1);
          expect(types).not.toContain('CANCELLED');
          expect(await feedItems(b, q.id)).toHaveLength(1);
          expect(await feedOf(b, q.id, 'request.cancelled')).toBe(0);
        } else {
          expect(answer.status).toBe(409);
          expect(answer.body.code).toBe('REQUEST_CLOSED');
          expect(row.status).toBe('CANCELLED');
          expect(types).not.toContain('REPLIED');
          expect(await feedItems(b, q.id)).toHaveLength(0);
          expect(await feedOf(b, q.id, 'request.cancelled')).toBe(1);
          // Nothing of the reply was stored.
          expect(row.resolution).toBeNull();
        }
      }
    });

    it('reply vs merge of the same request into another: one winner, no request.answered for a merged source, no request.merged for an answered one', async () => {
      for (let round = 0; round < 4; round++) {
        const b = await branch();
        const source = await question(b, {}, 'ana');
        const target = await question(
          b,
          {
            customerKey: source.customerKey,
            conversationRef: source.conversationRef,
          },
          'luis',
        );
        const [answer, merged] = await Promise.all([
          reply(
            b,
            source.id,
            { expectedVersion: 1, text: TEXT },
            { userId: users.ana },
          ),
          merge(b, source.id, target.id, users.ana),
        ]);
        expect(
          [answer.status, merged.status].filter((x) => x === 200),
        ).toHaveLength(1);
        const row = await prisma.chatbotRequest.findUniqueOrThrow({
          where: { id: source.id },
        });
        const targetRow = await prisma.chatbotRequest.findUniqueOrThrow({
          where: { id: target.id },
        });
        const types = (await events(source.id)).map((e) => e.type);
        // The target is never closed or answered by this race.
        expect(targetRow).toMatchObject({ status: 'IN_PROGRESS', version: 1 });
        expect(await feedItems(b, target.id)).toHaveLength(0);
        if (answer.status === 200) {
          expect(merged.status).toBe(409);
          expect(merged.body.code).toBe('REQUEST_CLOSED');
          expect(row.status).toBe('RESOLVED');
          expect(types.filter((t) => t === 'REPLIED')).toHaveLength(1);
          expect(types).not.toContain('MERGED');
          expect(await feedItems(b, source.id)).toHaveLength(1);
          expect(await feedOf(b, source.id, 'request.merged')).toBe(0);
        } else {
          expect(answer.status).toBe(409);
          expect(answer.body.code).toBe('REQUEST_CLOSED');
          expect(row).toMatchObject({
            status: 'CANCELLED',
            cancelReason: 'SUPERSEDED',
          });
          expect(types).not.toContain('REPLIED');
          expect(await feedItems(b, source.id)).toHaveLength(0);
          expect(await feedOf(b, source.id, 'request.merged')).toBe(1);
          expect(row.resolution).toBeNull();
        }
      }
    });
  });

  describe('CAS and idempotency (§12.12)', () => {
    it('replays the same key and body with the stored answer: one item, one REPLIED, one version bump', async () => {
      const b = await branch();
      const q = await question(b);
      const key = randomUUID();
      const first = await reply(
        b,
        q.id,
        { expectedVersion: 1, text: TEXT },
        { key },
      ).expect(200);
      const second = await reply(
        b,
        q.id,
        { expectedVersion: 1, text: TEXT },
        { key },
      ).expect(200);
      expect(second.body).toEqual(first.body);
      expect(await feedItems(b, q.id)).toHaveLength(1);
      expect(
        (await events(q.id)).filter((e) => e.type === 'REPLIED'),
      ).toHaveLength(1);
      const row = await prisma.chatbotRequest.findUniqueOrThrow({
        where: { id: q.id },
      });
      expect(row.version).toBe(2);
    });

    it('409 IDEMPOTENCY_CONFLICT for the same key with another text', async () => {
      const b = await branch();
      const q = await question(b);
      const key = randomUUID();
      await reply(b, q.id, { expectedVersion: 1, text: TEXT }, { key }).expect(
        200,
      );
      const res = await reply(
        b,
        q.id,
        { expectedVersion: 1, text: 'Otra respuesta' },
        { key },
      ).expect(409);
      expect(res.body.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('409 VERSION_CONFLICT with the current row on a stale expectedVersion, and nothing is stored', async () => {
      const b = await branch();
      const q = await question(b, { version: 4 });
      const res = await reply(b, q.id, {
        expectedVersion: 3,
        text: TEXT,
      }).expect(409);
      expect(res.body).toMatchObject({
        code: 'VERSION_CONFLICT',
        current: {
          version: 4,
          status: 'IN_PROGRESS',
          claimedBy: { id: users.ana },
        },
      });
      expect(await feedItems(b, q.id)).toHaveLength(0);
      expect(
        (await events(q.id)).filter((e) => e.type === 'REPLIED'),
      ).toHaveLength(0);
    });

    it('a second reply with another key finds the request closed (once per request)', async () => {
      const b = await branch();
      const q = await question(b);
      await reply(b, q.id, { expectedVersion: 1, text: TEXT }).expect(200);
      const res = await reply(b, q.id, {
        expectedVersion: 2,
        text: 'Otra',
      }).expect(409);
      expect(res.body.code).toBe('REQUEST_CLOSED');
      expect(await feedItems(b, q.id)).toHaveLength(1);
    });

    it('two parallel replies with different keys: exactly one wins, one feed item', async () => {
      const b = await branch();
      const q = await question(b);
      const results = await Promise.all(
        ['A', 'B', 'C'].map((t) =>
          reply(b, q.id, { expectedVersion: 1, text: `Respuesta ${t}` }),
        ),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(
        results.filter((r) => r.status !== 200).map((r) => r.body.code),
      ).toEqual(['REQUEST_CLOSED', 'REQUEST_CLOSED']);
      expect(await feedItems(b, q.id)).toHaveLength(1);
    });

    it('the database allows one clarification answer per request and one reply id per tenant', async () => {
      const b = await branch();
      const q = await question(b);
      await reply(b, q.id, { expectedVersion: 1, text: TEXT }).expect(200);
      await expect(
        prisma.chatbotFeedItem.create({
          data: {
            tenantId: b.tenantId,
            requestId: q.id,
            type: 'request.answered',
            payload: { kind: 'CLARIFICATION' },
          },
        }),
      ).rejects.toThrow();
      const other = await question(b);
      const { replyId } = (
        await prisma.chatbotRequest.findUniqueOrThrow({ where: { id: q.id } })
      ).resolution as { replyId: string };
      await expect(
        prisma.chatbotRequest.update({
          where: { id: other.id },
          data: { resolution: { action: 'REPLY', replyId, text: 'x' } },
        }),
      ).rejects.toThrow();
    });
  });

  describe('who may reply and which requests', () => {
    it('403 NOT_ASSIGNEE for someone else’s request, also for a manager; current names the holder', async () => {
      const b = await branch();
      const q = await question(b, {}, 'luis');
      for (const role of ['cashier', 'manager']) {
        const res = await reply(
          b,
          q.id,
          { expectedVersion: 1, text: TEXT },
          { role },
        ).expect(403);
        expect(res.body).toMatchObject({
          code: 'NOT_ASSIGNEE',
          current: { claimedBy: { id: users.luis } },
        });
      }
      expect(await feedItems(b, q.id)).toHaveLength(0);
    });

    it('403 INSUFFICIENT_PERMISSIONS without update:ChatbotRequest', async () => {
      const b = await branch();
      const q = await question(b);
      const res = await reply(
        b,
        q.id,
        { expectedVersion: 1, text: TEXT },
        { role: 'readOnly' },
      ).expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('422 ACTION_NOT_ALLOWED for a decision and for a conversation', async () => {
      const b = await branch();
      const decision = await question(b, {
        kind: 'DECISION',
        subtype: 'DISCOUNT',
      });
      const talk = await question(b, {
        kind: 'CONVERSATION',
        subtype: 'TALK_TO_HUMAN',
      });
      for (const r of [decision, talk]) {
        const res = await reply(b, r.id, {
          expectedVersion: 1,
          text: TEXT,
        }).expect(422);
        expect(res.body.code).toBe('ACTION_NOT_ALLOWED');
      }
    });

    it('404 for a request of another branch', async () => {
      const a = await branch();
      const other = await branch();
      const q = await question(other);
      await reply(a, q.id, { expectedVersion: 1, text: TEXT }).expect(404);
      expect(await feedItems(other, q.id)).toHaveLength(0);
    });

    it('400 VALIDATION_ERROR: no key, no version, blank, too long, unknown field', async () => {
      const b = await branch();
      const q = await question(b);
      const bad: Array<[object, string | null | undefined]> = [
        [{ expectedVersion: 1, text: TEXT }, null],
        [{ text: TEXT }, undefined],
        [{ expectedVersion: 1, text: '   ' }, undefined],
        [{ expectedVersion: 1, text: 'a'.repeat(1501) }, undefined],
        [
          { expectedVersion: 1, text: TEXT, assigneeUserId: users.luis },
          undefined,
        ],
      ];
      for (const [body, key] of bad) {
        const res = await reply(b, q.id, body, { key }).expect(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
      }
      expect(
        (await prisma.chatbotRequest.findUniqueOrThrow({ where: { id: q.id } }))
          .status,
      ).toBe('IN_PROGRESS');
    });

    it('accepts exactly 1500 characters', async () => {
      const b = await branch();
      const q = await question(b);
      await reply(b, q.id, {
        expectedVersion: 1,
        text: '😀'.repeat(1500),
      }).expect(200);
    });
  });

  describe('allowedActions / deniedActions on rows and detail', () => {
    it('REPLY is allowed for the assignee and on NEW rows, and denied NOT_ASSIGNEE with the command’s code on someone else’s', async () => {
      const b = await branch();
      const mine = await question(b, {}, 'ana');
      const theirs = await question(b, {}, 'luis');
      const free = await question(b, {}, null);
      const mineView = (await detail(b, mine.id)).body;
      expect(mineView.allowedActions).toEqual(['RELEASE', 'REPLY', 'CANCEL']);
      const theirsView = (await detail(b, theirs.id)).body;
      expect(theirsView.allowedActions).not.toContain('REPLY');
      expect(theirsView.deniedActions).toContainEqual({
        action: 'REPLY',
        code: 'NOT_ASSIGNEE',
      });
      // S13: nobody holds a NEW clarification, so anyone who may reply can.
      const freeView = (await detail(b, free.id)).body;
      expect(freeView.allowedActions).toEqual(['CLAIM', 'REPLY', 'CANCEL']);
      expect(freeView.deniedActions.map((d: any) => d.action)).not.toContain(
        'REPLY',
      );
      const readOnly = (await detail(b, mine.id, 'readOnly')).body;
      expect(readOnly.allowedActions).toEqual([]);
      expect(readOnly.deniedActions).toContainEqual({
        action: 'REPLY',
        code: 'INSUFFICIENT_PERMISSIONS',
      });
      // The offer and the command agree: what is denied answers that code.
      await reply(b, theirs.id, { expectedVersion: 1, text: TEXT }).expect(403);
    });
  });

  // -------------------------------------------------------------------- bot

  describe('delivery to the bot', () => {
    async function answered(b: Branch) {
      const q = await question(b);
      await reply(b, q.id, { expectedVersion: 1, text: TEXT }).expect(200);
      const [item] = await feedItems(b, q.id);
      return { q, item };
    }
    const AT = '2026-11-12T18:05:00.000Z';
    const accepted = (n = 1) => ({
      attemptId: randomUUID(),
      outcome: 'PROVIDER_ACCEPTED',
      attemptedAt: AT,
      providerMessageId: `wamid.reply${n}`,
    });
    const deferred = (outcome = 'DEFERRED_WINDOW_CLOSED') => ({
      attemptId: randomUUID(),
      outcome,
      attemptedAt: AT,
    });

    it('the feed delivers request.answered with the structured payload and the chat reference', async () => {
      const b = await branch();
      const { q, item } = await answered(b);
      const res = await botGet(b, '/chatbot-api/feed?waitSeconds=0').expect(
        200,
      );
      const delivered = res.body.items.filter(
        (i: any) => i.type === 'request.answered',
      );
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({
        deliveryId: item.deliveryId,
        requestId: q.id,
        conversationRef: q.conversationRef,
        payload: {
          kind: 'CLARIFICATION',
          action: 'REPLY',
          text: TEXT,
          prefix: TEAM_PREFIX,
          staffText: TEXT,
        },
      });
    });

    it('PROVIDER_ACCEPTED acknowledges it: no longer pending, DELIVERY_OUTCOME audited, a second attempt is 409', async () => {
      const b = await branch();
      const { q, item } = await answered(b);
      const body = accepted();
      const res = await ack(b, item.deliveryId, body).expect(200);
      expect(res.body).toMatchObject({
        deliveryId: item.deliveryId,
        outcome: 'PROVIDER_ACCEPTED',
        attemptId: body.attemptId,
      });
      expect(res.body.ackReceivedAt).not.toBeNull();
      // exact replay is 200; another attempt after a terminal outcome is 409
      await ack(b, item.deliveryId, body).expect(200);
      const late = await ack(b, item.deliveryId, accepted(2)).expect(409);
      expect(late.body.code).toBe('OUTCOME_ALREADY_RECORDED');
      const outcomes = (await events(q.id)).filter(
        (e) => e.type === 'DELIVERY_OUTCOME',
      );
      expect(outcomes).toHaveLength(1);
      const shown = (await detail(b, q.id)).body.deliveries[0];
      expect(shown.outcome).toBe('PROVIDER_ACCEPTED');
    });

    it('window closed: DEFERRED_WINDOW_CLOSED keeps it pending, served by pending-deliveries and recovery, delivered once the customer writes again', async () => {
      const b = await branch();
      const { q, item } = await answered(b);
      const first = deferred();
      const res = await ack(b, item.deliveryId, first).expect(200);
      expect(res.body).toMatchObject({
        outcome: 'DEFERRED_WINDOW_CLOSED',
        ackReceivedAt: null,
      });

      const byChat = await botGet(
        b,
        `/chatbot-api/requests/pending-deliveries?conversationRef=${encodeURIComponent(q.conversationRef as string)}`,
      ).expect(200);
      expect(byChat.body.items).toHaveLength(1);
      expect(byChat.body.items[0]).toMatchObject({
        deliveryId: item.deliveryId,
        type: 'request.answered',
        deferredReason: 'WINDOW_CLOSED',
        payload: { kind: 'CLARIFICATION', text: TEXT },
      });
      const byRequest = await botGet(
        b,
        `/chatbot-api/requests/pending-deliveries?requestId=${q.id}`,
      ).expect(200);
      expect(byRequest.body.items.map((i: any) => i.deliveryId)).toEqual([
        item.deliveryId,
      ]);

      // The recovery route (after a 410) lists the closed request with it.
      const recovered = await botGet(
        b,
        `/chatbot-api/requests?status=open&updatedSince=${encodeURIComponent('2026-01-01T00:00:00.000Z')}`,
      ).expect(200);
      const found = recovered.body.items.find((i: any) => i.id === q.id);
      expect(found.status).toBe('RESOLVED');
      expect(found.pendingDeliveries).toHaveLength(1);
      expect(found.pendingDeliveries[0]).toMatchObject({
        deliveryId: item.deliveryId,
        deferredReason: 'WINDOW_CLOSED',
      });

      // The deferral replays idempotently and is audited, without acking.
      await ack(b, item.deliveryId, first).expect(200);
      // The customer writes again: the bot delivers with a NEW attempt id.
      const sent = accepted(3);
      await ack(b, item.deliveryId, sent).expect(200);
      for (const path of [
        `/chatbot-api/requests/pending-deliveries?conversationRef=${encodeURIComponent(q.conversationRef as string)}`,
        `/chatbot-api/requests/pending-deliveries?requestId=${q.id}`,
      ]) {
        expect((await botGet(b, path).expect(200)).body.items).toEqual([]);
      }
      const after = await botGet(
        b,
        `/chatbot-api/requests?status=open&updatedSince=${encodeURIComponent('2026-01-01T00:00:00.000Z')}`,
      ).expect(200);
      expect(
        after.body.items.find((i: any) => i.id === q.id).pendingDeliveries,
      ).toEqual([]);
      // never twice
      await ack(b, item.deliveryId, accepted(4)).expect(409);
      const audit = (await events(q.id)).filter(
        (e) => e.type === 'DELIVERY_OUTCOME',
      );
      expect(audit.map((e) => (e.data as any).outcome)).toEqual([
        'DEFERRED_WINDOW_CLOSED',
        'PROVIDER_ACCEPTED',
      ]);
    });

    it('DEFERRED_HUMAN_SESSION, DELIVERY_UNKNOWN (needs reconciliation) and STALE are accepted too', async () => {
      const b = await branch();
      const human = await answered(b);
      const humanRes = await ack(
        b,
        human.item.deliveryId,
        deferred('DEFERRED_HUMAN_SESSION'),
      ).expect(200);
      expect(humanRes.body.ackReceivedAt).toBeNull();
      const pending = await botGet(
        b,
        `/chatbot-api/requests/pending-deliveries?requestId=${human.q.id}`,
      ).expect(200);
      expect(pending.body.items[0].deferredReason).toBe('HUMAN_SESSION');

      const unknown = await answered(b);
      await ack(b, unknown.item.deliveryId, {
        attemptId: randomUUID(),
        outcome: 'DELIVERY_UNKNOWN',
        attemptedAt: AT,
      }).expect(200);
      expect((await detail(b, unknown.q.id)).body.deliveries[0]).toMatchObject({
        outcome: 'DELIVERY_UNKNOWN',
        needsReconciliation: true,
      });

      const stale = await answered(b);
      await ack(b, stale.item.deliveryId, {
        attemptId: randomUUID(),
        outcome: 'STALE',
      }).expect(200);
    });
  });

  // ----------------------------------------------------------------- mirror

  describe('the conversation mirror', () => {
    const NOW_ISO = () => new Date().toISOString();
    const out = (over: Record<string, unknown> = {}) => ({
      waMessageId: `wamid.${randomUUID()}`,
      direction: 'OUT',
      type: 'TEXT',
      text: `${TEAM_PREFIX} ${TEXT}`,
      providerTimestamp: NOW_ISO(),
      observedAt: NOW_ISO(),
      ...over,
    });
    const mirror = (b: Branch, ref: string, messages: object[]) =>
      asBot(
        b,
        server().post(
          `/chatbot-api/conversations/${encodeURIComponent(ref)}/messages:batch`,
        ),
      ).send({ messages });
    const replyIdOf = async (id: string) =>
      (
        (await prisma.chatbotRequest.findUniqueOrThrow({ where: { id } }))
          .resolution as { replyId: string }
      ).replyId;
    async function replied(b: Branch, holder: 'ana' | 'luis' = 'ana') {
      const q = await question(b, {}, holder);
      await reply(
        b,
        q.id,
        { expectedVersion: 1, text: TEXT },
        { userId: users[holder] },
      ).expect(200);
      return { q, replyId: await replyIdOf(q.id) };
    }

    it('a message sent with staffReplyId is mirrored as STAFF with the replying user, SENT, id = replyId', async () => {
      const b = await branch();
      const { q, replyId } = await replied(b);
      const message = out({ staffReplyId: replyId });
      const res = await mirror(b, q.conversationRef as string, [
        message,
      ]).expect(200);
      expect(res.body.accepted).toEqual([
        { waMessageId: message.waMessageId, messageId: replyId, seq: 1 },
      ]);
      const stored = await prisma.conversationMessage.findUniqueOrThrow({
        where: { id: replyId },
      });
      expect(stored).toMatchObject({
        author: 'STAFF',
        staffUserId: users.ana,
        clientMessageId: replyId,
        direction: 'OUT',
        deliveryStatus: 'SENT',
        waMessageId: message.waMessageId,
      });

      const read = await server()
        .get(`/chatbot-requests/${q.id}/conversation`)
        .set(as(b, 'manager'))
        .expect(200);
      expect(read.body.items).toHaveLength(1);
      expect(read.body.items[0]).toMatchObject({
        id: replyId,
        author: 'STAFF',
        staff: { id: users.ana },
        clientMessageId: replyId,
        deliveryStatus: 'SENT',
        text: `${TEAM_PREFIX} ${TEXT}`,
      });
      // The audit's message id is this very message.
      const audit = (await events(q.id)).find((e) => e.type === 'REPLIED');
      expect((audit?.data as any).messageId).toBe(read.body.items[0].id);

      // The request is already closed, but its author still hears of it live.
      const stream = await prisma.$queryRaw<
        Array<{ type: string; requestId: string }>
      >`SELECT "type", "requestId" FROM "realtime_events"
        WHERE "tenantId" = ${b.tenantId} AND "type" = 'conversation.message'`;
      expect(stream.map((e) => e.requestId)).toContain(q.id);
    });

    it('a replay is a duplicate and a message without staffReplyId stays the bot’s', async () => {
      const b = await branch();
      const { q, replyId } = await replied(b);
      const message = out({ staffReplyId: replyId });
      await mirror(b, q.conversationRef as string, [message]).expect(200);
      const again = await mirror(b, q.conversationRef as string, [
        message,
      ]).expect(200);
      expect(again.body).toEqual({
        accepted: [],
        duplicates: [message.waMessageId],
      });
      const plain = out();
      await mirror(b, q.conversationRef as string, [plain]).expect(200);
      const rows = await prisma.conversationMessage.findMany({
        where: { tenantId: b.tenantId },
        orderBy: { seq: 'asc' },
      });
      expect(rows.map((r) => r.author)).toEqual(['STAFF', 'BOT']);
      expect(rows[1].staffUserId).toBeNull();
    });

    it('422 REPLY_NOT_FOUND (nothing stored) for an unknown id, another chat’s reply or another branch’s', async () => {
      const b = await branch();
      const other = await branch();
      const mine = await replied(b);
      const chatB = await replied(b);
      const foreign = await replied(other);
      for (const staffReplyId of [
        randomUUID(),
        chatB.replyId, // a reply of ANOTHER chat of the same branch
        foreign.replyId, // a reply of another branch
      ]) {
        const res = await mirror(b, mine.q.conversationRef as string, [
          out({ staffReplyId }),
        ]).expect(422);
        expect(res.body.code).toBe('REPLY_NOT_FOUND');
      }
      expect(
        await prisma.conversationMessage.count({
          where: { tenantId: { in: [b.tenantId, other.tenantId] } },
        }),
      ).toBe(0);
    });

    describe('a clarification without a conversationRef (parent decision)', () => {
      it('its reply is mirrored in the chat the bot sent it to: STAFF, the replying user, id = replyId', async () => {
        const b = await branch();
        const q = await question(b, { conversationRef: null });
        await reply(
          b,
          q.id,
          { expectedVersion: 1, text: TEXT },
          { userId: users.ana },
        ).expect(200);
        const replyId = await replyIdOf(q.id);
        const message = out({ staffReplyId: replyId });
        const res = await mirror(b, 'wa:5255819999', [message]).expect(200);
        expect(res.body.accepted).toEqual([
          { waMessageId: message.waMessageId, messageId: replyId, seq: 1 },
        ]);
        expect(
          await prisma.conversationMessage.findUniqueOrThrow({
            where: { id: replyId },
          }),
        ).toMatchObject({
          author: 'STAFF',
          staffUserId: users.ana,
          clientMessageId: replyId,
          direction: 'OUT',
          deliveryStatus: 'SENT',
        });
        // A plain replay is a duplicate, not an error.
        const again = await mirror(b, 'wa:5255819999', [message]).expect(200);
        expect(again.body.duplicates).toEqual([message.waMessageId]);
      });

      it('the reply id is unique: mirrored once, a second mirror in ANOTHER chat is 409 and stores nothing', async () => {
        const b = await branch();
        const q = await question(b, { conversationRef: null });
        await reply(b, q.id, { expectedVersion: 1, text: TEXT }).expect(200);
        const replyId = await replyIdOf(q.id);
        await mirror(b, 'wa:5255818881', [
          out({ staffReplyId: replyId }),
        ]).expect(200);
        const res = await mirror(b, 'wa:5255818882', [
          out({ staffReplyId: replyId }),
        ]).expect(409);
        expect(res.body.code).toBe('MESSAGE_ID_CONFLICT');
        const rows = await prisma.conversationMessage.findMany({
          where: { tenantId: b.tenantId },
          include: { conversation: true },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].conversation.conversationRef).toBe('wa:5255818881');
      });

      it('a null-ref reply of another branch is still 422 REPLY_NOT_FOUND', async () => {
        const b = await branch();
        const other = await branch();
        const q = await question(other, { conversationRef: null });
        await reply(other, q.id, { expectedVersion: 1, text: TEXT }).expect(
          200,
        );
        const res = await mirror(b, 'wa:5255817771', [
          out({ staffReplyId: await replyIdOf(q.id) }),
        ]).expect(422);
        expect(res.body.code).toBe('REPLY_NOT_FOUND');
      });

      it('one null-ref reply in a batch does not excuse another chat’s reply: the whole batch is 422', async () => {
        const b = await branch();
        const nullRef = await question(b, { conversationRef: null });
        await reply(b, nullRef.id, { expectedVersion: 1, text: TEXT }).expect(
          200,
        );
        const elsewhere = await replied(b);
        const res = await mirror(b, 'wa:5255816661', [
          out({ staffReplyId: await replyIdOf(nullRef.id) }),
          out({ staffReplyId: elsewhere.replyId }),
        ]).expect(422);
        expect(res.body.code).toBe('REPLY_NOT_FOUND');
        expect(
          await prisma.conversationMessage.count({
            where: { tenantId: b.tenantId },
          }),
        ).toBe(0);
      });
    });

    it('an open or non-clarification request id is not a reply id', async () => {
      const b = await branch();
      const open = await question(b);
      const res = await mirror(b, open.conversationRef as string, [
        out({ staffReplyId: open.id }),
      ]).expect(422);
      expect(res.body.code).toBe('REPLY_NOT_FOUND');
    });

    it('the same reply mirrored under another wamid is 409 MESSAGE_ID_CONFLICT, never a second STAFF message', async () => {
      const b = await branch();
      const { q, replyId } = await replied(b);
      await mirror(b, q.conversationRef as string, [
        out({ staffReplyId: replyId }),
      ]).expect(200);
      const res = await mirror(b, q.conversationRef as string, [
        out({ staffReplyId: replyId }),
      ]).expect(409);
      expect(res.body.code).toBe('MESSAGE_ID_CONFLICT');
      expect(
        await prisma.conversationMessage.count({
          where: { tenantId: b.tenantId },
        }),
      ).toBe(1);
    });

    it('the bot still cannot claim STAFF, name a staff user or attribute an incoming message', async () => {
      const b = await branch();
      const { q, replyId } = await replied(b);
      for (const message of [
        out({ staffReplyId: replyId, author: 'STAFF' }),
        out({ staffReplyId: replyId, staffUserId: users.luis }),
        out({ staffReplyId: replyId, direction: 'IN' }),
        out({ author: 'STAFF' }),
      ]) {
        const res = await mirror(b, q.conversationRef as string, [
          message,
        ]).expect(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
      }
    });
  });
});
