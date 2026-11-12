/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- supertest response bodies are untyped JSON */
/**
 * human-intervention / unit 9 — the conversation mirror against REAL
 * PostgreSQL, through HTTP (contract §3.6, §3.9, §6.2, §6.3, §10.1 R12):
 *   - the bot posts customer and bot messages: scopes, validation, size cap,
 *     idempotency by waMessageId, `seq` in arrival order with no gaps, even
 *     under concurrent batches, per-tenant isolation;
 *   - delivery statuses move forward only and are deduplicated;
 *   - the database trigger rejects UPDATE and DELETE except the allowed
 *     deliveryStatus move and the due retention delete;
 *   - realtime `conversation.message` / `message.status` are written to the
 *     unit 8 log in the same transaction (a rollback leaves none);
 *   - the staff read: paging, permissions, tenant isolation, R12.
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
import { ChatbotRequestHttpFilter } from '../chatbot-requests/presentation/chatbot-request-http.filter';
import { InsufficientPermissionsError } from '../shared/domain/domain-error';
import { createAppValidationPipe } from '../shared/listing/app-validation.pipe';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import {
  ConversationMirrorService,
  CONVERSATION_MIRROR_STORE,
} from './application/conversation-mirror.service';
import {
  ConversationReadsService,
  CONVERSATION_READ_STORE,
} from './application/conversation-reads.service';
import {
  DELIVERY_STATUSES,
  canAdvanceDeliveryStatus,
} from './domain/delivery-status';
import { PrismaConversationMirrorStore } from './infrastructure/prisma-conversation-mirror.store';
import { PrismaConversationReadStore } from './infrastructure/prisma-conversation-read.store';
import { BotConversationController } from './presentation/bot-conversation.controller';
import { ConversationReadsController } from './presentation/conversation-reads.controller';

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
    ['read', 'ChatbotConversation'],
    ['read', 'CustomerPhone'],
  ],
  cashier: [...READ_UPDATE, ['read', 'ChatbotConversation']],
  updateOnly: READ_UPDATE,
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

const PHONE_REF = 'wa:5215512345678';
const LEAK = /(?<![0-9A-Za-z-])\+?\d{10,15}(?![0-9A-Za-z-])|wa:/;

describeIfDb('conversation mirror (PostgreSQL)', () => {
  const prisma = integrationPrisma();
  let app: INestApplication;
  let cls: ClsService;
  const tenants: string[] = [];
  const credentials: string[] = [];
  const users = { ana: randomUUID() };
  let counter = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        DatabaseModule,
        BotRateLimitModule,
      ],
      controllers: [BotConversationController, ConversationReadsController],
      providers: [
        ServiceAuthGuard,
        ChatbotRequestHttpFilter,
        ConversationMirrorService,
        ConversationReadsService,
        {
          provide: CONVERSATION_MIRROR_STORE,
          useClass: PrismaConversationMirrorStore,
        },
        {
          provide: CONVERSATION_READ_STORE,
          useClass: PrismaConversationReadStore,
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
    cls = moduleRef.get<ClsService>(ClsService);
    for (const [name, id] of Object.entries(users)) {
      await prisma.user.create({
        data: { id, email: `${id}@mirror.test`, hashedPassword: 'x', name },
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

  async function bot(scopes = ['conversation:write']) {
    const id = randomUUID();
    tenants.push(id);
    await prisma.tenant.create({
      data: { id, name: 'Sucursal Espejo', slug: `cv-mirror-${id}` },
    });
    const token = `svc_${randomUUID()}`;
    const credential = await prisma.serviceCredential.create({
      data: {
        tenantId: id,
        name: 'bot',
        hashedKey: createHash('sha256').update(token).digest('hex'),
        scopes,
        rateLimit: 60,
      },
    });
    credentials.push(credential.id);
    return { tenantId: id, token };
  }
  type Bot = Awaited<ReturnType<typeof bot>>;

  const url = (ref: string, action: 'messages' | 'statuses' = 'messages') =>
    action === 'messages'
      ? `/chatbot-api/conversations/${encodeURIComponent(ref)}/messages:batch`
      : '/chatbot-api/messages/statuses:batch';
  const asBot = (b: Bot, req: request.Test) =>
    req
      .set('Authorization', `Bearer ${b.token}`)
      .set('X-Branch-Id', b.tenantId);
  const post = (b: Bot, ref: string, body: unknown) =>
    asBot(b, request(app.getHttpServer()).post(url(ref))).send(body as object);
  const postStatuses = (b: Bot, body: unknown) =>
    asBot(b, request(app.getHttpServer()).post(url('', 'statuses'))).send(
      body as object,
    );

  const NOW = () => new Date().toISOString();
  const msg = (over: Record<string, unknown> = {}) => ({
    waMessageId: `wamid.${randomUUID()}`,
    direction: 'IN',
    type: 'TEXT',
    text: 'Hola, ¿tienen croquetas?',
    providerTimestamp: NOW(),
    observedAt: NOW(),
    ...over,
  });
  const outMsg = (over: Record<string, unknown> = {}) =>
    msg({ direction: 'OUT', text: 'Claro que sí', ...over });

  const as = (role: string, tenantId: string, userId = users.ana) => ({
    'x-test-role': role,
    'x-test-tenant': tenantId,
    'x-test-user': userId,
  });
  const staffGet = (path: string, role: string, tenantId: string) =>
    request(app.getHttpServer()).get(path).set(as(role, tenantId));

  const rows = (tenantId: string, ref = PHONE_REF) =>
    prisma.$queryRaw<
      Array<{
        id: string;
        seq: number;
        waMessageId: string | null;
        author: string;
        direction: string;
        type: string;
        text: string | null;
        deliveryStatus: string | null;
        purgeAfter: Date;
        receivedAt: Date;
      }>
    >`SELECT m."id", m."seq", m."waMessageId", m."author"::text, m."direction"::text,
             m."type"::text, m."text", m."deliveryStatus"::text, m."purgeAfter", m."receivedAt"
      FROM "conversation_messages" m
      JOIN "chatbot_conversations" c ON c."id" = m."conversationId"
      WHERE m."tenantId" = ${tenantId} AND c."conversationRef" = ${ref}
      ORDER BY m."seq"`;

  const events = (tenantId: string) =>
    prisma.$queryRaw<
      Array<{
        type: string;
        requestId: string | null;
        userId: string | null;
        payload: Record<string, unknown>;
      }>
    >`SELECT "type", "requestId", "userId", "payload" FROM "realtime_events"
      WHERE "tenantId" = ${tenantId} AND "type" IN ('conversation.message', 'message.status')
      ORDER BY "id"`;

  async function openRequest(
    tenantId: string,
    over: Record<string, unknown> = {},
  ) {
    const row = await prisma.chatbotRequest.create({
      data: {
        tenantId,
        folio: ++counter,
        kind: 'CLARIFICATION',
        subtype: 'UNKNOWN_QUESTION',
        customerKey: '525512345678',
        conversationRef: PHONE_REF,
        summary: 'Pregunta',
        source: 'chatbot',
        sourceRequestId: randomUUID(),
        ...over,
      } as never,
    });
    return row.id;
  }

  // ---------------------------------------------------------- bot ingest

  describe('POST /chatbot-api/conversations/:ref/messages:batch', () => {
    it('stores customer and bot messages with seq in arrival order', async () => {
      const b = await bot();
      const first = msg({ text: 'uno' });
      const second = outMsg({ text: 'dos' });
      const third = msg({ text: 'tres' });
      const res = await post(b, PHONE_REF, {
        messages: [first, second, third],
      }).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.duplicates).toEqual([]);
      expect(res.body.accepted.map((a: any) => [a.waMessageId, a.seq])).toEqual(
        [
          [first.waMessageId, 1],
          [second.waMessageId, 2],
          [third.waMessageId, 3],
        ],
      );
      const stored = await rows(b.tenantId);
      expect(stored.map((r) => [r.seq, r.author, r.direction, r.text])).toEqual(
        [
          [1, 'CUSTOMER', 'IN', 'uno'],
          [2, 'BOT', 'OUT', 'dos'],
          [3, 'CUSTOMER', 'IN', 'tres'],
        ],
      );
      // A bot message was already sent when it is mirrored; the customer's has no status.
      expect(stored.map((r) => r.deliveryStatus)).toEqual([null, 'SENT', null]);
    });

    it('retains for 12 months from receipt', async () => {
      const b = await bot();
      await post(b, PHONE_REF, { messages: [msg()] }).expect(200);
      const [row] = await rows(b.tenantId);
      const months =
        (row.purgeAfter.getUTCFullYear() - row.receivedAt.getUTCFullYear()) *
          12 +
        row.purgeAfter.getUTCMonth() -
        row.receivedAt.getUTCMonth();
      expect(months).toBe(12);
    });

    it('is idempotent by waMessageId: a replay changes nothing and burns no seq', async () => {
      const b = await bot();
      const a = msg();
      const c = msg();
      await post(b, PHONE_REF, { messages: [a, c] }).expect(200);
      const replay = await post(b, PHONE_REF, { messages: [a, c] }).expect(200);
      expect(replay.body.accepted).toEqual([]);
      expect(replay.body.duplicates).toEqual([a.waMessageId, c.waMessageId]);
      // Overlap: the duplicate is reported, the new one continues the sequence.
      const fresh = msg();
      const overlap = await post(b, PHONE_REF, {
        messages: [a, fresh],
      }).expect(200);
      expect(overlap.body.duplicates).toEqual([a.waMessageId]);
      expect(overlap.body.accepted).toEqual([
        expect.objectContaining({ waMessageId: fresh.waMessageId, seq: 3 }),
      ]);
      expect((await rows(b.tenantId)).map((r) => r.seq)).toEqual([1, 2, 3]);
    });

    it('keeps the stored message when a replay carries other words (messages are immutable)', async () => {
      const b = await bot();
      const a = msg({ text: 'original' });
      await post(b, PHONE_REF, { messages: [a] }).expect(200);
      await post(b, PHONE_REF, {
        messages: [{ ...a, text: 'rewritten' }],
      }).expect(200);
      expect((await rows(b.tenantId))[0].text).toBe('original');
    });

    it('assigns a gapless, unique seq under concurrent batches', async () => {
      const b = await bot();
      const batches = Array.from({ length: 8 }, () => ({
        messages: [msg(), msg(), msg()],
      }));
      const responses = await Promise.all(
        batches.map((body) => post(b, PHONE_REF, body)),
      );
      responses.forEach((r) => expect(r.status).toBe(200));
      const seqs = (await rows(b.tenantId)).map((r) => r.seq);
      expect(seqs).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
      // Within each batch the seqs are consecutive and in array order.
      for (const r of responses) {
        const mine = r.body.accepted.map((a: any) => a.seq);
        expect(mine[1]).toBe(mine[0] + 1);
        expect(mine[2]).toBe(mine[1] + 1);
      }
    });

    it('two concurrent posts of the SAME messages store each once', async () => {
      const b = await bot();
      const same = { messages: [msg(), msg()] };
      const [x, y] = await Promise.all([
        post(b, PHONE_REF, same),
        post(b, PHONE_REF, same),
      ]);
      expect([x.status, y.status]).toEqual([200, 200]);
      expect(await rows(b.tenantId)).toHaveLength(2);
      expect(x.body.accepted.length + y.body.accepted.length).toBe(2);
    });

    it('is per tenant: the same ref and the same wamid in two tenants are independent', async () => {
      const a = await bot();
      const b = await bot();
      const shared = msg({ waMessageId: 'wamid.shared' });
      await post(a, PHONE_REF, { messages: [shared] }).expect(200);
      const other = await post(b, PHONE_REF, { messages: [shared] }).expect(
        200,
      );
      expect(other.body.accepted[0].seq).toBe(1);
      expect(await rows(a.tenantId)).toHaveLength(1);
      expect(await rows(b.tenantId)).toHaveLength(1);
    });

    it('409 MESSAGE_ID_CONFLICT when a wamid already belongs to another conversation; nothing is stored', async () => {
      const b = await bot();
      const taken = msg();
      await post(b, 'wa:5215500000001', { messages: [taken] }).expect(200);
      const fresh = msg();
      const res = await post(b, 'wa:5215500000002', {
        messages: [fresh, taken],
      }).expect(409);
      expect(res.body.code).toBe('MESSAGE_ID_CONFLICT');
      expect(await rows(b.tenantId, 'wa:5215500000002')).toEqual([]);
    });

    it('updates lastCustomerMessageAt from the customer messages only', async () => {
      const b = await bot();
      const customerAt = '2026-11-12T10:00:00.000Z';
      await post(b, PHONE_REF, {
        messages: [
          msg({ providerTimestamp: customerAt }),
          outMsg({ providerTimestamp: '2026-11-12T10:05:00.000Z' }),
        ],
      }).expect(200);
      const [c] = await prisma.chatbotConversation.findMany({
        where: { tenantId: b.tenantId },
      });
      expect(c.lastCustomerMessageAt?.toISOString()).toBe(customerAt);
      expect(c.customerKey).toBe('525512345678');
      // An older customer message never moves it back.
      await post(b, PHONE_REF, {
        messages: [msg({ providerTimestamp: '2026-11-12T09:00:00.000Z' })],
      }).expect(200);
      const [after] = await prisma.chatbotConversation.findMany({
        where: { tenantId: b.tenantId },
      });
      expect(after.lastCustomerMessageAt?.toISOString()).toBe(customerAt);
    });

    it('stores text verbatim minus control characters and keeps markup as text', async () => {
      const b = await bot();
      await post(b, PHONE_REF, {
        messages: [msg({ text: '<img src=x onerror=1> hola\u0000‮' })],
      }).expect(200);
      expect((await rows(b.tenantId))[0].text).toBe(
        '<img src=x onerror=1> hola',
      );
    });

    it('takes the tenant from the credential, never from the body', async () => {
      const a = await bot();
      const b = await bot();
      await post(a, PHONE_REF, {
        messages: [msg({ tenantId: b.tenantId })],
      }).expect(400);
      await post(a, PHONE_REF, { messages: [msg()] }).expect(200);
      expect(await rows(b.tenantId)).toEqual([]);
    });

    it.each([
      ['an unknown key', { messages: [msg({ seq: 9 })] }],
      ['a STAFF author', { messages: [outMsg({ author: 'STAFF' })] }],
      [
        'a text over 4096 characters',
        { messages: [msg({ text: 'a'.repeat(4097) })] },
      ],
      ['an empty batch', { messages: [] }],
      [
        'a repeated id in the batch',
        (() => {
          const same = msg();
          return { messages: [same, same] };
        })(),
      ],
    ])(
      '400 VALIDATION_ERROR on %s, nothing stored, input not echoed',
      async (_n, body) => {
        const b = await bot();
        const res = await post(b, PHONE_REF, body).expect(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
        expect(JSON.stringify(res.body)).not.toContain('aaaa');
        expect(await rows(b.tenantId)).toEqual([]);
      },
    );

    it('400 on a malformed conversation reference', async () => {
      const b = await bot();
      await post(b, 'wa:55 12', { messages: [msg()] }).expect(400);
    });

    it('413 BATCH_TOO_LARGE over 50 messages; exactly 50 is fine', async () => {
      const b = await bot();
      const many = (n: number) => ({
        messages: Array.from({ length: n }, () => msg({ text: 'x' })),
      });
      const tooMany = await post(b, PHONE_REF, many(51)).expect(413);
      expect(tooMany.body.code).toBe('BATCH_TOO_LARGE');
      expect(await rows(b.tenantId)).toEqual([]);
      await post(b, PHONE_REF, many(50)).expect(200);
      expect(await rows(b.tenantId)).toHaveLength(50);
    });

    it('refuses a missing or mismatched media reference', async () => {
      const b = await bot();
      const unknown = await post(b, PHONE_REF, {
        messages: [
          msg({ type: 'IMAGE', mediaId: randomUUID(), text: undefined }),
        ],
      }).expect(422);
      expect(unknown.body.code).toBe('MEDIA_NOT_FOUND');

      const pdf = await prisma.conversationMedia.create({
        data: {
          tenantId: b.tenantId,
          storageKey: `conversation-media/${b.tenantId}/x.pdf`,
          mimeType: 'application/pdf',
          sizeBytes: 10,
          sha256: 'a'.repeat(64),
          idempotencyKey: randomUUID(),
          purgeAfter: new Date(Date.now() + 86_400_000),
        },
      });
      const mismatch = await post(b, PHONE_REF, {
        messages: [msg({ type: 'AUDIO', mediaId: pdf.id, text: undefined })],
      }).expect(422);
      expect(mismatch.body.code).toBe('MEDIA_TYPE_MISMATCH');
      await post(b, PHONE_REF, {
        messages: [msg({ type: 'DOCUMENT', mediaId: pdf.id, text: undefined })],
      }).expect(200);
      expect(await rows(b.tenantId)).toHaveLength(1);
    });

    it("a media file of another tenant is 'not found'", async () => {
      const a = await bot();
      const b = await bot();
      const foreign = await prisma.conversationMedia.create({
        data: {
          tenantId: b.tenantId,
          storageKey: `conversation-media/${b.tenantId}/x.pdf`,
          mimeType: 'application/pdf',
          sizeBytes: 10,
          sha256: 'a'.repeat(64),
          idempotencyKey: randomUUID(),
          purgeAfter: new Date(Date.now() + 86_400_000),
        },
      });
      const res = await post(a, PHONE_REF, {
        messages: [
          msg({ type: 'DOCUMENT', mediaId: foreign.id, text: undefined }),
        ],
      }).expect(422);
      expect(res.body.code).toBe('MEDIA_NOT_FOUND');
    });

    it('stores an UNSUPPORTED message with the fixed text and no file', async () => {
      const b = await bot();
      await post(b, PHONE_REF, {
        messages: [
          msg({ type: 'UNSUPPORTED', kind: 'VIDEO', text: undefined }),
        ],
      }).expect(200);
      const [row] = await rows(b.tenantId);
      expect([row.type, row.text]).toEqual(['UNSUPPORTED', 'Video recibido']);
    });

    it('401 without a credential, 403 INSUFFICIENT_SCOPE without conversation:write', async () => {
      const b = await bot(['media:write']);
      await request(app.getHttpServer())
        .post(url(PHONE_REF))
        .send({ messages: [msg()] })
        .expect(401);
      const res = await post(b, PHONE_REF, { messages: [msg()] }).expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_SCOPE');
      expect(await rows(b.tenantId)).toEqual([]);
    });

    it('403 when X-Branch-Id is another branch', async () => {
      const a = await bot();
      const b = await bot();
      await request(app.getHttpServer())
        .post(url(PHONE_REF))
        .set('Authorization', `Bearer ${a.token}`)
        .set('X-Branch-Id', b.tenantId)
        .send({ messages: [msg()] })
        .expect(403);
    });
  });

  // ------------------------------------------------------------- statuses

  describe('POST /chatbot-api/messages/statuses:batch', () => {
    const status = (providerMessageId: string, s: string) => ({
      providerMessageId,
      status: s,
      occurredAt: NOW(),
    });

    async function sent(b: Bot) {
      const out = outMsg();
      const incoming = msg();
      await post(b, PHONE_REF, { messages: [incoming, out] }).expect(200);
      return { out, incoming };
    }

    it('moves a message forward, out of order and repeated, and reports the rest', async () => {
      const b = await bot();
      const { out } = await sent(b);
      const res = await postStatuses(b, {
        statuses: [
          status(out.waMessageId, 'READ'),
          status(out.waMessageId, 'DELIVERED'),
          status('wamid.never-mirrored', 'DELIVERED'),
        ],
      }).expect(200);
      expect(res.body).toEqual({
        applied: 1,
        ignored: 1,
        unknown: ['wamid.never-mirrored'],
      });
      expect((await rows(b.tenantId))[1].deliveryStatus).toBe('READ');
      // Replay and older statuses change nothing.
      const again = await postStatuses(b, {
        statuses: [
          status(out.waMessageId, 'READ'),
          status(out.waMessageId, 'SENT'),
        ],
      }).expect(200);
      expect(again.body).toEqual({ applied: 0, ignored: 2, unknown: [] });
    });

    it('FAILED only before delivery; a customer message never gets a status', async () => {
      const b = await bot();
      const { out, incoming } = await sent(b);
      const res = await postStatuses(b, {
        statuses: [status(incoming.waMessageId, 'DELIVERED')],
      }).expect(200);
      expect(res.body.applied).toBe(0);
      await postStatuses(b, {
        statuses: [status(out.waMessageId, 'DELIVERED')],
      }).expect(200);
      const failed = await postStatuses(b, {
        statuses: [status(out.waMessageId, 'FAILED')],
      }).expect(200);
      expect(failed.body.applied).toBe(0);
      expect((await rows(b.tenantId))[1].deliveryStatus).toBe('DELIVERED');
    });

    it('is tenant scoped: another tenant cannot move my message', async () => {
      const a = await bot();
      const b = await bot();
      const { out } = await sent(a);
      const res = await postStatuses(b, {
        statuses: [status(out.waMessageId, 'READ')],
      }).expect(200);
      expect(res.body).toEqual({
        applied: 0,
        ignored: 0,
        unknown: [out.waMessageId],
      });
      expect((await rows(a.tenantId))[1].deliveryStatus).toBe('SENT');
    });

    it('400 on a backend-owned status; 413 over the cap; scope enforced', async () => {
      const b = await bot();
      const { out } = await sent(b);
      await postStatuses(b, {
        statuses: [status(out.waMessageId, 'QUEUED')],
      }).expect(400);
      const many = Array.from({ length: 101 }, (_, i) =>
        status(`wamid.${i}`, 'READ'),
      );
      const big = await postStatuses(b, { statuses: many }).expect(413);
      expect(big.body.code).toBe('BATCH_TOO_LARGE');
      const noScope = await bot(['media:write']);
      await postStatuses(noScope, {
        statuses: [status('wamid.x', 'READ')],
      }).expect(403);
    });
  });

  // -------------------------------------------------------- immutability

  describe('database immutability (§6.2)', () => {
    async function oneMessage() {
      const b = await bot();
      await post(b, PHONE_REF, { messages: [outMsg(), msg()] }).expect(200);
      return { b, stored: await rows(b.tenantId) };
    }
    const rejected = (promise: Promise<unknown>) =>
      expect(promise).rejects.toThrow(/immutable|cannot be deleted/);

    it('rejects UPDATE of any content column', async () => {
      const { stored } = await oneMessage();
      const id = stored[0].id;
      await rejected(
        prisma.$executeRaw`UPDATE "conversation_messages" SET "text" = 'edited' WHERE "id" = ${id}`,
      );
      await rejected(
        prisma.$executeRaw`UPDATE "conversation_messages" SET "seq" = 99 WHERE "id" = ${id}`,
      );
      await rejected(
        prisma.$executeRaw`UPDATE "conversation_messages" SET "purgeAfter" = now() - interval '1 day' WHERE "id" = ${id}`,
      );
      await rejected(
        prisma.$executeRaw`UPDATE "conversation_messages" SET "deliveryStatus" = 'DELIVERED', "text" = 'x' WHERE "id" = ${id}`,
      );
    });

    it('allows deliveryStatus to move forward only', async () => {
      const { stored } = await oneMessage();
      const id = stored[0].id; // OUT, SENT
      await prisma.$executeRaw`UPDATE "conversation_messages" SET "deliveryStatus" = 'DELIVERED' WHERE "id" = ${id}`;
      await rejected(
        prisma.$executeRaw`UPDATE "conversation_messages" SET "deliveryStatus" = 'SENT' WHERE "id" = ${id}`,
      );
      await rejected(
        prisma.$executeRaw`UPDATE "conversation_messages" SET "deliveryStatus" = 'FAILED' WHERE "id" = ${id}`,
      );
      await prisma.$executeRaw`UPDATE "conversation_messages" SET "deliveryStatus" = 'READ' WHERE "id" = ${id}`;
      // A customer message has no status to move.
      await rejected(
        prisma.$executeRaw`UPDATE "conversation_messages" SET "deliveryStatus" = 'READ' WHERE "id" = ${stored[1].id}`,
      );
    });

    it('the SQL transition rule is the domain rule, for every pair', async () => {
      const states = [null, ...DELIVERY_STATUSES];
      for (const from of states) {
        for (const to of DELIVERY_STATUSES) {
          const [row] = await prisma.$queryRaw<Array<{ ok: boolean }>>`
            SELECT "conversation_delivery_can_advance"(${from}, ${to}) AS ok`;
          expect({ from, to, ok: row.ok }).toEqual({
            from,
            to,
            ok: canAdvanceDeliveryStatus(from, to),
          });
        }
      }
    });

    it('rejects DELETE unless the retention marker is set AND the row is due', async () => {
      const { stored } = await oneMessage();
      const id = stored[0].id;
      await rejected(
        prisma.$executeRaw`DELETE FROM "conversation_messages" WHERE "id" = ${id}`,
      );
      // Not due: even the retention marker cannot delete it.
      await rejected(
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('houndfe.conversation_retention', 'on', true)`;
          await tx.$executeRaw`DELETE FROM "conversation_messages" WHERE "id" = ${id}`;
        }),
      );
      expect(await prisma.conversationMessage.count({ where: { id } })).toBe(1);
    });

    it('allows the retention delete of a due row and nothing else', async () => {
      const b = await bot();
      const conversation = await prisma.chatbotConversation.create({
        data: { tenantId: b.tenantId, conversationRef: PHONE_REF },
      });
      const base = {
        tenantId: b.tenantId,
        conversationId: conversation.id,
        direction: 'IN' as const,
        author: 'CUSTOMER' as const,
        type: 'TEXT' as const,
        text: 'viejo',
      };
      const due = await prisma.conversationMessage.create({
        data: {
          ...base,
          seq: 1,
          receivedAt: new Date(Date.now() - 400 * 86_400_000),
          purgeAfter: new Date(Date.now() - 86_400_000),
        },
      });
      const fresh = await prisma.conversationMessage.create({
        data: {
          ...base,
          seq: 2,
          purgeAfter: new Date(Date.now() + 86_400_000),
        },
      });
      // Without the marker a due row is still protected.
      await rejected(
        prisma.$executeRaw`DELETE FROM "conversation_messages" WHERE "id" = ${due.id}`,
      );
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('houndfe.conversation_retention', 'on', true)`;
        await tx.$executeRaw`DELETE FROM "conversation_messages" WHERE "id" = ${due.id}`;
      });
      expect(
        await prisma.conversationMessage.count({ where: { id: due.id } }),
      ).toBe(0);
      // The marker is transaction-local: it did not leak to the connection.
      await rejected(
        prisma.$executeRaw`DELETE FROM "conversation_messages" WHERE "id" = ${fresh.id}`,
      );
    });

    it('a conversation with messages cannot be deleted directly; a tenant delete cascades', async () => {
      const { b } = await oneMessage();
      await rejected(
        prisma.$executeRaw`DELETE FROM "chatbot_conversations" WHERE "tenantId" = ${b.tenantId}`,
      );
      await prisma.tenant.delete({ where: { id: b.tenantId } });
      expect(
        await prisma.conversationMessage.count({
          where: { tenantId: b.tenantId },
        }),
      ).toBe(0);
    });
  });

  // ------------------------------------------------------------ realtime

  describe('realtime log (unit 8)', () => {
    it('writes conversation.message for each open request of the chat, in the same transaction', async () => {
      const b = await bot();
      const open1 = await openRequest(b.tenantId);
      const open2 = await openRequest(b.tenantId, {
        status: 'IN_PROGRESS',
        assigneeUserId: users.ana,
        assigneeDisplayName: 'Ana',
        claimedAt: new Date(),
      });
      await openRequest(b.tenantId, {
        status: 'RESOLVED',
        resolvedAt: new Date(),
        closedAt: new Date(),
      });
      await openRequest(b.tenantId, { conversationRef: 'wa:5215599999999' });
      const first = msg();
      const second = outMsg();
      await post(b, PHONE_REF, { messages: [first, second] }).expect(200);
      const logged = await events(b.tenantId);
      expect(logged).toHaveLength(4);
      expect(new Set(logged.map((e) => e.requestId))).toEqual(
        new Set([open1, open2]),
      );
      expect(logged.every((e) => e.userId === null)).toBe(true);
      expect(logged.every((e) => e.type === 'conversation.message')).toBe(true);
      const stored = await rows(b.tenantId);
      // The log holds ids and numbers only, never the words.
      expect(logged.map((e) => e.payload.seq)).toEqual([1, 1, 2, 2]);
      expect(logged[0].payload.messageId).toBe(stored[0].id);
      expect(JSON.stringify(logged)).not.toMatch(/Hola|Claro|5512345678|wa:/);
    });

    it('writes nothing when no request is open for the chat', async () => {
      const b = await bot();
      await post(b, PHONE_REF, { messages: [msg()] }).expect(200);
      expect(await events(b.tenantId)).toEqual([]);
    });

    it('writes nothing for a duplicate replay or a rolled-back batch', async () => {
      const b = await bot();
      await openRequest(b.tenantId);
      const a = msg();
      await post(b, PHONE_REF, { messages: [a] }).expect(200);
      await post(b, PHONE_REF, { messages: [a] }).expect(200);
      expect(await events(b.tenantId)).toHaveLength(1);
      // A batch that fails after its inserts (wamid owned by another chat).
      const taken = msg();
      await post(b, 'wa:5215500000009', { messages: [taken] }).expect(200);
      await post(b, PHONE_REF, { messages: [msg(), taken] }).expect(409);
      expect(await events(b.tenantId)).toHaveLength(1);
    });

    it('writes message.status for each open request when a status applies', async () => {
      const b = await bot();
      const requestId = await openRequest(b.tenantId);
      const out = outMsg();
      await post(b, PHONE_REF, { messages: [out] }).expect(200);
      await postStatuses(b, {
        statuses: [
          {
            providerMessageId: out.waMessageId,
            status: 'DELIVERED',
            occurredAt: NOW(),
          },
        ],
      }).expect(200);
      await postStatuses(b, {
        statuses: [
          {
            providerMessageId: out.waMessageId,
            status: 'DELIVERED',
            occurredAt: NOW(),
          },
        ],
      }).expect(200);
      const logged = (await events(b.tenantId)).filter(
        (e) => e.type === 'message.status',
      );
      expect(logged).toHaveLength(1);
      expect(logged[0].requestId).toBe(requestId);
      expect(logged[0].payload).toMatchObject({ seq: 1 });
    });
  });

  // ---------------------------------------------------------- staff read

  describe('GET /chatbot-requests/:id/conversation', () => {
    async function seeded(n = 5) {
      const b = await bot();
      const requestId = await openRequest(b.tenantId);
      const batch = Array.from({ length: n }, (_, i) =>
        i % 2 === 0
          ? msg({ text: `cliente ${i + 1}` })
          : outMsg({ text: `bot ${i + 1}` }),
      );
      await post(b, PHONE_REF, { messages: batch }).expect(200);
      return { b, requestId };
    }
    const path = (id: string, query = '') =>
      `/chatbot-requests/${id}/conversation${query}`;

    it('returns the latest page in seq order, in the contract shape', async () => {
      const { b, requestId } = await seeded(3);
      const res = await staffGet(path(requestId), 'manager', b.tenantId).expect(
        200,
      );
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.hasMoreBefore).toBe(false);
      expect(res.body.items.map((m: any) => m.seq)).toEqual([1, 2, 3]);
      expect(res.body.items[0]).toEqual({
        id: expect.any(String),
        seq: 1,
        direction: 'IN',
        author: 'CUSTOMER',
        staff: null,
        type: 'TEXT',
        text: 'cliente 1',
        media: null,
        deliveryStatus: null,
        clientMessageId: null,
        providerTimestamp: expect.any(String),
        createdAt: expect.any(String),
      });
      expect(res.body.items[1]).toMatchObject({
        author: 'BOT',
        direction: 'OUT',
        deliveryStatus: 'SENT',
      });
    });

    it('pages backwards with before, forwards with after, and caps the limit', async () => {
      const { b, requestId } = await seeded(7);
      const latest = await staffGet(
        path(requestId, '?limit=3'),
        'manager',
        b.tenantId,
      ).expect(200);
      expect(latest.body.items.map((m: any) => m.seq)).toEqual([5, 6, 7]);
      expect(latest.body.hasMoreBefore).toBe(true);
      const older = await staffGet(
        path(requestId, '?before=5&limit=3'),
        'manager',
        b.tenantId,
      ).expect(200);
      expect(older.body.items.map((m: any) => m.seq)).toEqual([2, 3, 4]);
      expect(older.body.hasMoreBefore).toBe(true);
      const oldest = await staffGet(
        path(requestId, '?before=2&limit=3'),
        'manager',
        b.tenantId,
      ).expect(200);
      expect(oldest.body.items.map((m: any) => m.seq)).toEqual([1]);
      expect(oldest.body.hasMoreBefore).toBe(false);
      const polled = await staffGet(
        path(requestId, '?after=5'),
        'manager',
        b.tenantId,
      ).expect(200);
      expect(polled.body.items.map((m: any) => m.seq)).toEqual([6, 7]);
      expect(polled.body.hasMoreBefore).toBe(true);
      const none = await staffGet(
        path(requestId, '?after=7'),
        'manager',
        b.tenantId,
      ).expect(200);
      expect(none.body.items).toEqual([]);
    });

    it.each([
      '?before=0',
      '?before=x',
      '?after=-1',
      '?limit=0',
      '?limit=101',
      '?before=3&after=1',
    ])('400 on %s', async (query) => {
      const { b, requestId } = await seeded(2);
      const res = await staffGet(
        path(requestId, query),
        'manager',
        b.tenantId,
      ).expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('needs read:ChatbotConversation; an assignee without it sees only their session (none until unit 11)', async () => {
      const { b, requestId } = await seeded(3);
      await staffGet(path(requestId), 'readOnly', b.tenantId).expect(403);
      // Not the assignee: 403.
      await staffGet(path(requestId), 'updateOnly', b.tenantId).expect(403);
      await prisma.chatbotRequest.update({
        where: { id: requestId },
        data: {
          status: 'IN_PROGRESS',
          assigneeUserId: users.ana,
          assigneeDisplayName: 'Ana',
          claimedAt: new Date(),
        },
      });
      const session = await staffGet(
        path(requestId),
        'updateOnly',
        b.tenantId,
      ).expect(200);
      expect(session.body).toEqual({ items: [], hasMoreBefore: false });
      const full = await staffGet(
        path(requestId),
        'cashier',
        b.tenantId,
      ).expect(200);
      expect(full.body.items).toHaveLength(3);
    });

    it('is tenant isolated: a request id of another tenant is 404, like an unknown id', async () => {
      const { requestId } = await seeded(2);
      const other = await bot();
      const foreign = await staffGet(
        path(requestId),
        'manager',
        other.tenantId,
      ).expect(404);
      const unknown = await staffGet(
        path(randomUUID()),
        'manager',
        other.tenantId,
      ).expect(404);
      expect(foreign.body).toEqual(unknown.body);
      await staffGet(path('not-a-uuid'), 'manager', other.tenantId).expect(400);
    });

    it("never shows another tenant's messages for the same conversation reference", async () => {
      const a = await seeded(2);
      const b = await bot();
      const bRequest = await openRequest(b.tenantId);
      await post(b, PHONE_REF, {
        messages: [msg({ text: 'solo de B' })],
      }).expect(200);
      const res = await staffGet(
        path(a.requestId),
        'manager',
        a.b.tenantId,
      ).expect(200);
      expect(JSON.stringify(res.body)).not.toContain('solo de B');
      const mine = await staffGet(path(bRequest), 'manager', b.tenantId).expect(
        200,
      );
      expect(mine.body.items.map((m: any) => m.text)).toEqual(['solo de B']);
    });

    it('a request with no conversationRef, or no mirrored chat yet, has an empty conversation', async () => {
      const b = await bot();
      const noRef = await openRequest(b.tenantId, { conversationRef: null });
      const noChat = await openRequest(b.tenantId, {
        conversationRef: 'wa:5215588888888',
      });
      for (const id of [noRef, noChat]) {
        const res = await staffGet(path(id), 'manager', b.tenantId).expect(200);
        expect(res.body).toEqual({ items: [], hasMoreBefore: false });
      }
    });

    it('R12: no conversation reference, customer key or phone number in the response, for any role', async () => {
      const { b, requestId } = await seeded(3);
      for (const role of ['manager', 'cashier']) {
        const res = await staffGet(path(requestId), role, b.tenantId).expect(
          200,
        );
        const text = JSON.stringify(res.body);
        expect(text).not.toMatch(LEAK);
        expect(text).not.toContain('525512345678');
      }
    });

    it('shows a media message with its descriptor and no storage key', async () => {
      const b = await bot();
      const requestId = await openRequest(b.tenantId);
      const media = await prisma.conversationMedia.create({
        data: {
          tenantId: b.tenantId,
          storageKey: `conversation-media/${b.tenantId}/secret-key.jpg`,
          mimeType: 'image/jpeg',
          sizeBytes: 1234,
          sha256: 'b'.repeat(64),
          idempotencyKey: randomUUID(),
          purgeAfter: new Date(Date.now() + 86_400_000),
        },
      });
      await post(b, PHONE_REF, {
        messages: [msg({ type: 'IMAGE', mediaId: media.id, text: 'mi foto' })],
      }).expect(200);
      const res = await staffGet(path(requestId), 'manager', b.tenantId).expect(
        200,
      );
      expect(res.body.items[0]).toMatchObject({
        type: 'IMAGE',
        text: 'mi foto',
        media: {
          id: media.id,
          mimeType: 'image/jpeg',
          sizeBytes: 1234,
          durationSec: null,
          hasThumb: false,
          purged: false,
        },
      });
      expect(JSON.stringify(res.body)).not.toMatch(
        /secret-key|conversation-media/,
      );
      // Once the retention purges the file the descriptor says so.
      await prisma.conversationMedia.update({
        where: { id: media.id },
        data: { purgedAt: new Date(), storageKey: null },
      });
      const after = await staffGet(
        path(requestId),
        'manager',
        b.tenantId,
      ).expect(200);
      expect(after.body.items[0].media.purged).toBe(true);
    });

    it('serves a page of 50 messages well inside the §10.1 budget (p95 < 100 ms)', async () => {
      const { b, requestId } = await seeded(2);
      const bulk = Array.from({ length: 50 }, () => msg());
      await post(b, PHONE_REF, { messages: bulk }).expect(200);
      const samples: number[] = [];
      for (let i = 0; i < 20; i++) {
        const start = process.hrtime.bigint();
        await staffGet(
          path(requestId, '?limit=50'),
          'manager',
          b.tenantId,
        ).expect(200);
        samples.push(Number(process.hrtime.bigint() - start) / 1e6);
      }
      samples.sort((x, y) => x - y);
      expect(samples[Math.floor(samples.length * 0.95)]).toBeLessThan(100);
    });
  });

  it('keeps cls typed (the harness reads the tenant from the stub)', () => {
    expect(cls).toBeDefined();
  });
});
