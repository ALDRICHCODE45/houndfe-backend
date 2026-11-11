/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- supertest response bodies are untyped JSON */
/**
 * human-intervention / unit 5, slice 5c — recovery of the bot after
 * `410 CURSOR_EXPIRED` against REAL PostgreSQL (contract §3.3, §3.9):
 * `GET /chatbot-api/requests?status=open&updatedSince=&cursor=&limit=50`.
 *   - open requests always; with `updatedSince`, also the ones closed at or
 *     after it (the bot drops them);
 *   - keyset pages by `(updatedAt, id)` with no row repeated or skipped, ties
 *     on `updatedAt` included;
 *   - each request carries its latest undelivered feed items;
 *   - `nextCursor` is the tenant's feed position (stable across pages, never
 *     below the retention watermark), so the feed resumes cleanly;
 *   - scope `requests:read`, route class `read`, tenant isolation, validation.
 */
import { createHash, randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClsModule } from 'nestjs-cls';
import request from 'supertest';
import { integrationPrisma } from '../../test/integration/reset-db';
import { SERVICE_CREDENTIAL_REPOSITORY } from '../chatbot-api/domain/service-credential.repository';
import { PrismaServiceCredentialRepository } from '../chatbot-api/infrastructure/prisma-service-credential.repository';
import { BotRateLimitModule } from '../chatbot-api/presentation/guards/bot-rate-limit.module';
import { ServiceAuthGuard } from '../chatbot-api/presentation/guards/service-auth.guard';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { PrismaService } from '../shared/prisma/prisma.service';
import { RealtimeModule } from '../shared/realtime/realtime.module';
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
import { PgFeedWakeup } from './infrastructure/feed-wakeup';
import { PrismaChatbotFeedStore } from './infrastructure/prisma-chatbot-feed.store';
import { PrismaChatbotRecoveryStore } from './infrastructure/prisma-chatbot-recovery.store';
import { BotFeedController } from './presentation/bot-feed.controller';
import { BotRecoveryController } from './presentation/bot-recovery.controller';
import { ChatbotRequestHttpFilter } from './presentation/chatbot-request-http.filter';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

const T0 = Date.parse('2026-11-01T12:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const pad = (cursor: bigint | number) => String(cursor).padStart(12, '0');

describeIfDb('chatbot recovery (PostgreSQL)', () => {
  const prisma = integrationPrisma();
  let app: INestApplication;
  const tenants: string[] = [];
  const credentials: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        DatabaseModule,
        BotRateLimitModule,
        RealtimeModule,
      ],
      controllers: [BotFeedController, BotRecoveryController],
      providers: [
        ServiceAuthGuard,
        ChatbotRequestHttpFilter,
        ChatbotFeedService,
        ChatbotRecoveryService,
        PgFeedWakeup,
        { provide: FEED_WAKEUP, useExisting: PgFeedWakeup },
        { provide: CHATBOT_FEED_STORE, useClass: PrismaChatbotFeedStore },
        {
          provide: CHATBOT_RECOVERY_STORE,
          useClass: PrismaChatbotRecoveryStore,
        },
        { provide: FEED_CLOCK, useValue: Date.now },
        {
          provide: SERVICE_CREDENTIAL_REPOSITORY,
          useClass: PrismaServiceCredentialRepository,
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await prisma.serviceRateBucket.deleteMany({
      where: { credentialId: { in: credentials } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
  });

  // -------------------------------------------------------------- helpers

  async function bot(
    over: { scopes?: string[]; rateLimits?: Record<string, number> } = {},
  ) {
    const id = randomUUID();
    tenants.push(id);
    await prisma.tenant.create({
      data: { id, name: 'Sucursal Recovery', slug: `cr-rec-${id}` },
    });
    const token = `svc_${randomUUID()}`;
    const credential = await prisma.serviceCredential.create({
      data: {
        tenantId: id,
        name: 'bot',
        hashedKey: createHash('sha256').update(token).digest('hex'),
        scopes: over.scopes ?? ['requests:read', 'feed:read', 'feed:ack'],
        rateLimit: 60,
        rateLimits: over.rateLimits,
      },
    });
    credentials.push(credential.id);
    return { tenantId: id, token, folio: 0 };
  }
  type Bot = Awaited<ReturnType<typeof bot>>;

  const auth = (b: Bot, req: request.Test) =>
    req
      .set('Authorization', `Bearer ${b.token}`)
      .set('X-Branch-Id', b.tenantId);
  const recover = (b: Bot, query = '?status=open') =>
    auth(b, request(app.getHttpServer()).get(`/chatbot-api/requests${query}`));
  const feed = (b: Bot, query = '') =>
    auth(b, request(app.getHttpServer()).get(`/chatbot-api/feed${query}`));

  let seq = 0;
  /** An open request; `updatedAt` pinned so ordering is deterministic. */
  function open(
    b: Bot,
    updatedAt: Date,
    over: { id?: string; conversationRef?: string | null } = {},
  ) {
    const n = ++seq;
    return prisma.chatbotRequest.create({
      data: {
        id: over.id,
        tenantId: b.tenantId,
        folio: ++b.folio,
        kind: 'CLARIFICATION',
        subtype: 'UNKNOWN_QUESTION',
        customerKey: `5255000${n}`,
        conversationRef:
          over.conversationRef === undefined
            ? `wa:5255000${n}`
            : over.conversationRef,
        summary: 'Pregunta',
        source: 'chatbot',
        sourceRequestId: randomUUID(),
        createdAt: updatedAt,
        updatedAt,
      },
    });
  }

  /** A closed request: CANCELLED by the customer at `closedAt`. */
  function closed(b: Bot, closedAt: Date, status: 'CANCELLED' | 'RESOLVED') {
    const n = ++seq;
    return prisma.chatbotRequest.create({
      data: {
        tenantId: b.tenantId,
        folio: ++b.folio,
        kind: 'CLARIFICATION',
        subtype: 'UNKNOWN_QUESTION',
        status,
        customerKey: `5255000${n}`,
        conversationRef: `wa:5255000${n}`,
        summary: 'Pregunta',
        source: 'chatbot',
        sourceRequestId: randomUUID(),
        createdAt: at(-10_000),
        updatedAt: closedAt,
        closedAt,
        ...(status === 'RESOLVED'
          ? { resolvedAt: closedAt }
          : { cancelledAt: closedAt, cancelReason: 'CUSTOMER_WITHDREW' }),
      },
    });
  }

  const enqueue = (
    b: Bot,
    requestId: string,
    over: Partial<{
      type: string;
      outcome: string;
      acked: boolean;
      conversationRef: string | null;
    }> = {},
  ) =>
    prisma.chatbotFeedItem.create({
      data: {
        tenantId: b.tenantId,
        requestId,
        type: over.type ?? 'request.answered',
        conversationRef: over.conversationRef ?? null,
        payload: { kind: 'DECISION' },
        ...(over.outcome
          ? {
              outcome: over.outcome,
              attemptId: randomUUID(),
              evidenceHash: 'h'.repeat(64),
              ackedAt: over.acked ? new Date() : null,
            }
          : {}),
      },
    });

  /** Walk every page; returns the answers in order. */
  async function walk(b: Bot, query: string, limit: number) {
    const pages: Array<{
      items: any[];
      nextCursor: string;
      nextPage: string | null;
    }> = [];
    let cursor: string | null = null;
    do {
      const url: string = `${query}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`;
      const response = await recover(b, url).expect(200);
      pages.push(response.body);
      cursor = response.body.nextPage;
    } while (cursor);
    return pages;
  }

  // ------------------------------------------------------------------ set

  describe('which requests', () => {
    it('returns every open request and no closed one without updatedSince', async () => {
      const b = await bot();
      const a = await open(b, at(1));
      const second = await open(b, at(2));
      await closed(b, at(3), 'CANCELLED');
      await closed(b, at(4), 'RESOLVED');

      const response = await recover(b).expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body.items.map((i: any) => i.id)).toEqual([
        a.id,
        second.id,
      ]);
    });

    it('with updatedSince adds the requests closed at or after it, and never the ones closed before', async () => {
      const b = await bot();
      const oldOpen = await open(b, at(-5_000)); // open and untouched for days
      const before = await closed(b, at(9), 'CANCELLED');
      const atInstant = await closed(b, at(10), 'RESOLVED');
      const after = await closed(b, at(11), 'CANCELLED');

      const response = await recover(
        b,
        `?status=open&updatedSince=${at(10).toISOString()}`,
      ).expect(200);
      const ids = response.body.items.map((i: any) => i.id);
      // Open requests are ALL returned, however old: the bot rebuilds its set.
      expect(ids).toContain(oldOpen.id);
      expect(ids).toContain(atInstant.id);
      expect(ids).toContain(after.id);
      expect(ids).not.toContain(before.id);
      const dropped = response.body.items.filter((i: any) =>
        ['RESOLVED', 'CANCELLED'].includes(i.status),
      );
      expect(dropped.map((i: any) => [i.id, i.status])).toEqual([
        [atInstant.id, 'RESOLVED'],
        [after.id, 'CANCELLED'],
      ]);
      expect(dropped[1]).toMatchObject({
        cancelReason: 'CUSTOMER_WITHDREW',
        closedAt: at(11).toISOString(),
      });
    });

    it('is the bot projection: ids, folio, subtype, conversation, window and times only', async () => {
      const b = await bot();
      const r = await open(b, at(1), { conversationRef: 'wa:5215512345678' });
      const response = await recover(b).expect(200);
      expect(response.body.items).toEqual([
        {
          id: r.id,
          folio: 'S-000001',
          kind: 'CLARIFICATION',
          subtype: 'UNKNOWN_QUESTION',
          status: 'NEW',
          conversationRef: 'wa:5215512345678',
          legacyId: null,
          whatsappWindowClosesAt: null,
          cancelReason: null,
          createdAt: at(1).toISOString(),
          updatedAt: at(1).toISOString(),
          closedAt: null,
          pendingDeliveries: [],
        },
      ]);
    });

    it("never returns another tenant's requests, deliveries or feed cursor", async () => {
      const a = await bot();
      const other = await bot();
      const mine = await open(a, at(1));
      const theirs = await open(other, at(1));
      await enqueue(other, theirs.id);
      await enqueue(other, theirs.id);

      const response = await recover(a).expect(200);
      expect(response.body.items.map((i: any) => i.id)).toEqual([mine.id]);
      expect(response.body.items[0].pendingDeliveries).toEqual([]);
      expect(response.body.nextCursor).toBe(pad(0));
      const theirsAnswer = await recover(other).expect(200);
      expect(theirsAnswer.body.items.map((i: any) => i.id)).toEqual([
        theirs.id,
      ]);
      expect(theirsAnswer.body.items[0].pendingDeliveries).toHaveLength(2);
    });
  });

  // ----------------------------------------------------------- pagination

  describe('keyset pagination by (updatedAt, id)', () => {
    it('walks 7 requests in pages of 3 with no repeat and no gap, ties on updatedAt included', async () => {
      const b = await bot();
      const created = [];
      // Three share one updatedAt (the id breaks the tie); four are distinct.
      for (const minute of [5, 1, 5, 3, 5, 2, 4]) {
        created.push(await open(b, at(minute)));
      }
      const expected = [...created]
        .sort(
          (x, y) =>
            x.updatedAt.getTime() - y.updatedAt.getTime() ||
            (x.id < y.id ? -1 : 1),
        )
        .map((r) => r.id);

      const pages = await walk(b, '?status=open', 3);
      expect(pages.map((p) => p.items.length)).toEqual([3, 3, 1]);
      expect(pages.flatMap((p) => p.items.map((i) => i.id))).toEqual(expected);
      expect(pages.map((p) => p.nextPage === null)).toEqual([
        false,
        false,
        true,
      ]);
    });

    it('an exact multiple of the limit ends with a null nextPage, not an empty extra page', async () => {
      const b = await bot();
      for (const minute of [1, 2, 3, 4]) await open(b, at(minute));
      const pages = await walk(b, '?status=open', 2);
      expect(pages.map((p) => p.items.length)).toEqual([2, 2]);
      expect(pages.at(-1)?.nextPage).toBeNull();
    });

    it('a request updated during the walk is neither lost nor duplicated beyond one more sighting', async () => {
      const b = await bot();
      const rows = [];
      for (const minute of [1, 2, 3, 4]) rows.push(await open(b, at(minute)));
      const first = await recover(b, '?status=open&limit=2').expect(200);
      // The first (already seen) request is touched: its updatedAt moves
      // forward, so the walk meets it again at the end, never skips another.
      await prisma.chatbotRequest.update({
        where: { id: rows[0].id },
        data: { updatedAt: at(99) },
      });
      const second = await recover(
        b,
        `?status=open&limit=2&cursor=${first.body.nextPage}`,
      ).expect(200);
      const third = await recover(
        b,
        `?status=open&limit=2&cursor=${second.body.nextPage}`,
      ).expect(200);
      const seen = [first, second, third].flatMap((p) =>
        p.body.items.map((i: any) => i.id),
      );
      expect(new Set(seen)).toEqual(new Set(rows.map((r) => r.id)));
      expect(seen.filter((id) => id === rows[0].id)).toHaveLength(2);
      expect(third.body.nextPage).toBeNull();
    });
  });

  // ------------------------------------------------------- feed position

  describe('nextCursor is the feed position to resume from', () => {
    it("is the tenant's max feed cursor, the same on every page, and 0 for an empty feed", async () => {
      const b = await bot();
      expect((await recover(b).expect(200)).body.nextCursor).toBe(pad(0));
      const r1 = await open(b, at(1));
      for (const minute of [2, 3, 4]) await open(b, at(minute));
      await enqueue(b, r1.id);
      const last = await enqueue(b, r1.id);

      const pages = await walk(b, '?status=open', 2);
      expect(pages.length).toBeGreaterThan(1);
      for (const page of pages) expect(page.nextCursor).toBe(pad(last.cursor));
    });

    it('feed items committed during the walk stay after the position the first page returned', async () => {
      const b = await bot();
      const r = await open(b, at(1));
      for (const minute of [2, 3]) await open(b, at(minute));
      await enqueue(b, r.id);
      const first = await recover(b, '?status=open&limit=2').expect(200);
      const during = await enqueue(b, r.id); // committed mid-walk
      const second = await recover(
        b,
        `?status=open&limit=2&cursor=${first.body.nextPage}`,
      ).expect(200);
      expect(second.body.nextCursor).toBe(first.body.nextCursor);
      const resumed = await feed(
        b,
        `?after=${first.body.nextCursor}&waitSeconds=0`,
      ).expect(200);
      expect(resumed.body.items.map((i: any) => i.deliveryId)).toEqual([
        during.deliveryId,
      ]);
    });

    it('410 CURSOR_EXPIRED → recovery → resume from nextCursor works end to end', async () => {
      const b = await bot();
      const r = await open(b, at(1));
      const stale = await prisma.chatbotFeedItem.create({
        data: {
          tenantId: b.tenantId,
          requestId: r.id,
          type: 'request.cancelled',
          payload: {},
          createdAt: new Date(Date.now() - 31 * 86_400_000),
        },
      });
      const fresh = await enqueue(b, r.id);
      const store = new PrismaChatbotFeedStore(
        null as unknown as TenantPrismaService,
        prisma as unknown as PrismaService,
      );
      expect(await store.purgeExpired(new Date())).toBeGreaterThanOrEqual(1);

      await feed(b, `?after=${stale.cursor - 1n}&waitSeconds=0`).expect(410);
      const recovered = await recover(b).expect(200);
      expect(recovered.body.nextCursor).toBe(pad(fresh.cursor));
      // The bot sees what is still undelivered and re-ACKs by deliveryId.
      expect(
        recovered.body.items[0].pendingDeliveries.map((d: any) => d.deliveryId),
      ).toEqual([fresh.deliveryId]);
      // Resuming from nextCursor is accepted (not 410) and delivers the news.
      const resumed = await feed(
        b,
        `?after=${recovered.body.nextCursor}&waitSeconds=0`,
      ).expect(200);
      expect(resumed.body.items).toEqual([]);
      const news = await enqueue(b, r.id);
      const next = await feed(
        b,
        `?after=${recovered.body.nextCursor}&waitSeconds=0`,
      ).expect(200);
      expect(next.body.items.map((i: any) => i.deliveryId)).toEqual([
        news.deliveryId,
      ]);
    });

    it('is never below the retention watermark, even when every item was purged', async () => {
      const b = await bot();
      const r = await open(b, at(1));
      const gone = await prisma.chatbotFeedItem.create({
        data: {
          tenantId: b.tenantId,
          requestId: r.id,
          type: 'request.cancelled',
          payload: {},
          createdAt: new Date(Date.now() - 31 * 86_400_000),
        },
      });
      const store = new PrismaChatbotFeedStore(
        null as unknown as TenantPrismaService,
        prisma as unknown as PrismaService,
      );
      await store.purgeExpired(new Date());
      expect(
        await prisma.chatbotFeedItem.count({ where: { tenantId: b.tenantId } }),
      ).toBe(0);

      const response = await recover(b).expect(200);
      expect(response.body.nextCursor).toBe(pad(gone.cursor));
      await feed(b, `?after=${response.body.nextCursor}&waitSeconds=0`).expect(
        200,
      );
    });
  });

  // ------------------------------------------------------------ deliveries

  describe('undelivered feed items per request', () => {
    it('carries items with no terminal outcome (never attempted or deferred) and drops acknowledged ones', async () => {
      const b = await bot();
      const r = await open(b, at(1));
      const fresh = await enqueue(b, r.id, { conversationRef: 'wa:1' });
      const windowDeferred = await enqueue(b, r.id, {
        outcome: 'DEFERRED_WINDOW_CLOSED',
      });
      const sessionDeferred = await enqueue(b, r.id, {
        outcome: 'DEFERRED_HUMAN_SESSION',
      });
      await enqueue(b, r.id, { outcome: 'PROVIDER_ACCEPTED', acked: true });
      await enqueue(b, r.id, { outcome: 'STALE', acked: true });

      const [item] = (await recover(b).expect(200)).body.items;
      expect(
        item.pendingDeliveries.map((d: any) => [
          d.deliveryId,
          d.type,
          d.deferredReason,
        ]),
      ).toEqual([
        [fresh.deliveryId, 'request.answered', null],
        [windowDeferred.deliveryId, 'request.answered', 'WINDOW_CLOSED'],
        [sessionDeferred.deliveryId, 'request.answered', 'HUMAN_SESSION'],
      ]);
      expect(item.pendingDeliveries[0]).toMatchObject({
        cursor: pad(fresh.cursor),
        requestId: r.id,
        conversationRef: 'wa:1',
        payload: { kind: 'DECISION' },
        notBefore: null,
        expiresAt: null,
      });
    });

    it('keeps only the latest 5 per request, oldest first, and a closed request still shows its unacknowledged answer', async () => {
      const b = await bot();
      const r = await closed(b, at(10), 'RESOLVED');
      const made = [];
      for (let i = 0; i < 7; i++) made.push(await enqueue(b, r.id));
      const response = await recover(
        b,
        `?status=open&updatedSince=${at(0).toISOString()}`,
      ).expect(200);
      const [item] = response.body.items;
      expect(item.status).toBe('RESOLVED');
      expect(item.pendingDeliveries.map((d: any) => d.deliveryId)).toEqual(
        made.slice(2).map((m) => m.deliveryId),
      );
    });
  });

  // ---------------------------------------------------- scope, class, input

  describe('guard, budget and validation', () => {
    it('needs requests:read: feed:read alone is a 403, and a missing token a 401', async () => {
      const readOnlyFeed = await bot({ scopes: ['feed:read'] });
      const denied = await recover(readOnlyFeed).expect(403);
      expect(denied.body).toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
      await request(app.getHttpServer())
        .get('/chatbot-api/requests?status=open')
        .set('X-Branch-Id', readOnlyFeed.tenantId)
        .expect(401);
    });

    it('spends from the read budget (not write, not feed)', async () => {
      const b = await bot({ rateLimits: { read: 2 } });
      await recover(b).expect(200);
      await recover(b).expect(200);
      const limited = await recover(b).expect(429);
      expect(limited.body).toMatchObject({ code: 'RATE_LIMITED' });
      expect(limited.headers['retry-after']).toEqual(expect.any(String));
      // The feed budget is its own.
      await feed(b, '?waitSeconds=0').expect(200);
    });

    it.each([
      ['no status', ''],
      ['status other than open', '?status=closed'],
      ['an unknown parameter', '?status=open&tenantId=x'],
      ['a non-canonical updatedSince', '?status=open&updatedSince=2026-11-10'],
      ['limit 0', '?status=open&limit=0'],
      ['limit 51', '?status=open&limit=51'],
      ['a tampered cursor', '?status=open&cursor=AAAA'],
      ['a repeated status', '?status=open&status=open'],
    ])('answers 400 VALIDATION_ERROR for %s', async (_label, query) => {
      const b = await bot();
      const response = await recover(b, query).expect(400);
      expect(response.body).toMatchObject({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
      });
    });

    it('a cursor of another tenant cannot reach its rows: the query is always tenant-scoped', async () => {
      const a = await bot();
      const other = await bot();
      const mine = await open(a, at(1));
      const theirs = await open(other, at(1));
      const page = await recover(other, '?status=open&limit=1').expect(200);
      expect(page.body.items[0].id).toBe(theirs.id);
      const cursor = Buffer.from(
        JSON.stringify({ u: at(0).toISOString(), i: theirs.id, f: '0' }),
      ).toString('base64url');
      const response = await recover(a, `?status=open&cursor=${cursor}`).expect(
        200,
      );
      expect(response.body.items.map((i: any) => i.id)).toEqual([mine.id]);
    });
  });
});
