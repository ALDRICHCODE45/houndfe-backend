/**
 * human-intervention / unit 8 — `GET /realtime/stream` end to end: a real HTTP
 * SSE client against a Nest app on a real socket, the REAL guards, hub, log,
 * LISTEN connection, access re-check and row builders, on PostgreSQL (contract
 * §5.3, §12.8; §10.1 R5, R6, R7, R12). Commands are the real staff commands, so
 * the events come from the real deferred trigger.
 */
import { randomUUID } from 'crypto';
import { STREAM_LIMITS } from './domain/realtime-events';
import { SseClient } from './test-support/sse-client';
import {
  CASHIER,
  MANAGER,
  READ_UPDATE,
  createStreamHarness,
  fakeJwt,
  type StreamHarness,
} from './test-support/stream-harness';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

/** A full number: 10+ digits, with or without `+`, not inside an id. */
const LEAK = /(?<![0-9A-Za-z-])\+?\d{10,15}(?![0-9A-Za-z-])/;

describeIfDb('realtime stream (PostgreSQL, real HTTP)', () => {
  let h: StreamHarness;
  const clients: SseClient[] = [];

  beforeAll(async () => {
    h = await createStreamHarness({ accessCacheMs: 0 });
  }, 60_000);

  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
  });

  afterAll(async () => {
    await h.close();
  });

  const connect = async (
    tenantId: string,
    userId: string,
    options: {
      after?: string;
      query?: string;
      headers?: Record<string, string>;
    } = {},
  ) => {
    const client = new SseClient();
    clients.push(client);
    const path = `/realtime/stream${options.query ?? ''}`;
    await client.open(
      h.baseUrl,
      path,
      h.headers(tenantId, userId, {
        ...(options.after ? { 'last-event-id': options.after } : {}),
        ...options.headers,
      }),
    );
    return client;
  };

  /** A tenant with a manager (sees phones), a cashier and one request. */
  async function world() {
    const tenantId = await h.seedTenant();
    const manager = await h.seedUser(tenantId, MANAGER, { name: 'Marta' });
    const cashier = await h.seedUser(tenantId, CASHIER, { name: 'Caro' });
    const request = await h.seedRequest(tenantId);
    return { tenantId, manager, cashier, request };
  }

  const claim = (
    w: { tenantId: string },
    actor: string,
    requestId: string,
    version = 1,
  ) => h.command(w.tenantId, actor, requestId, version, { kind: 'claim' });
  const release = (
    w: { tenantId: string },
    actor: string,
    requestId: string,
    version: number,
  ) => h.command(w.tenantId, actor, requestId, version, { kind: 'release' });

  describe('admission and headers (R6)', () => {
    it('answers 200 text/event-stream with the anti-buffering headers and says ready', async () => {
      const w = await world();
      const client = await connect(w.tenantId, w.manager.userId);
      expect(client.status).toBe(200);
      expect(client.headers['content-type']).toContain('text/event-stream');
      expect(client.headers['cache-control']).toBe('no-store');
      expect(client.headers['x-accel-buffering']).toBe('no');
      expect(client.headers['content-encoding']).toBe('identity');
      expect(client.headers['content-length']).toBeUndefined();
      await client.waitForEvent('ready');
      expect(client.raw.startsWith(`retry: ${STREAM_LIMITS.retryMs}\n\n`)).toBe(
        true,
      );
      expect(client.of('ready')[0].data).toMatchObject({
        heartbeatSeconds: 15,
      });
    });

    it('rejects without a user (401), without read:ChatbotRequest (403), an inactive user (401) and a non-member (403)', async () => {
      const w = await world();
      const noPermission = await h.seedUser(w.tenantId, [
        ['ChatbotRequest', 'update'],
      ]);
      const inactive = await h.seedUser(w.tenantId, READ_UPDATE, {
        isActive: false,
      });
      const otherTenant = await h.seedTenant();
      const status = async (headers: Record<string, string>) => {
        const client = new SseClient();
        clients.push(client);
        await client.open(h.baseUrl, '/realtime/stream', headers);
        return client.status;
      };
      expect(await status({})).toBe(401);
      expect(await status(h.headers(w.tenantId, noPermission.userId))).toBe(
        403,
      );
      expect(await status(h.headers(w.tenantId, inactive.userId))).toBe(401);
      expect(await status(h.headers(otherTenant, w.manager.userId))).toBe(403);
    });

    it('a malformed Last-Event-ID is a 400 before any stream starts', async () => {
      const w = await world();
      const bad = await connect(w.tenantId, w.manager.userId, {
        after: 'not-a-number',
      });
      expect(bad.status).toBe(400);
      const badQuery = await connect(w.tenantId, w.manager.userId, {
        query: '?after=12abc',
      });
      expect(badQuery.status).toBe(400);
    });
  });

  describe('live delivery across a commit', () => {
    it('sends request.claimed with the full row the moment the command commits', async () => {
      const w = await world();
      const client = await connect(w.tenantId, w.manager.userId);
      await client.waitForEvent('ready');
      await claim(w, w.cashier.userId, w.request.id);
      await client.waitForEvent('request.claimed');
      const message = client.of('request.claimed')[0];
      expect(message.id).toMatch(/^\d+$/);
      const data = message.data as {
        request: Record<string, unknown>;
        customer: Record<string, unknown>;
        previousCustomerKey: unknown;
      };
      expect(data.request).toMatchObject({
        id: w.request.id,
        status: 'IN_PROGRESS',
        version: 2,
        assignee: {
          id: w.cashier.userId,
          displayName: expect.any(String) as string,
        },
      });
      expect(data.request.allowedActions).toEqual(expect.any(Array));
      expect(data.request.deniedActions).toEqual(expect.any(Array));
      expect(data.request).toHaveProperty('slaLevel');
      expect(data.previousCustomerKey).toBeNull();
    });

    it('sends nothing for a command that rolled back', async () => {
      const w = await world();
      const client = await connect(w.tenantId, w.manager.userId);
      await client.waitForEvent('ready');
      // A stale version is rejected: one transaction, nothing committed.
      await expect(
        claim(w, w.cashier.userId, w.request.id, 9),
      ).rejects.toThrow();
      await claim(w, w.cashier.userId, w.request.id, 1);
      await client.waitForEvent('request.claimed');
      expect(client.of('request.claimed')).toHaveLength(1);
      expect(client.names).toEqual(['ready', 'request.claimed']);
    });

    it('delivers every kind of request event in commit order', async () => {
      const w = await world();
      const client = await connect(w.tenantId, w.manager.userId);
      await client.waitForEvent('ready');
      await claim(w, w.cashier.userId, w.request.id, 1);
      await release(w, w.cashier.userId, w.request.id, 2);
      await h.command(w.tenantId, w.manager.userId, w.request.id, 3, {
        kind: 'cancel',
        reason: 'DUPLICATE',
      });
      await client.waitFor(
        (m) => m.filter((x) => x.event.startsWith('request.')).length >= 3,
        5_000,
        'three request events',
      );
      expect(client.names).toEqual([
        'ready',
        'request.claimed',
        'request.released',
        'request.cancelled',
      ]);
      const ids = client.messages
        .filter((m) => m.event.startsWith('request.'))
        .map((m) => BigInt(m.id as string));
      expect([...ids].sort((a, b) => Number(a - b))).toEqual(ids);
    });
  });

  describe('replay after reconnect (Last-Event-ID)', () => {
    it('replays what was missed in order, with no duplicates, then goes live', async () => {
      const w = await world();
      const first = await connect(w.tenantId, w.manager.userId);
      await first.waitForEvent('ready');
      await claim(w, w.cashier.userId, w.request.id, 1);
      await first.waitForEvent('request.claimed');
      const lastSeen = first.lastEventId as string;
      first.close();

      // The tab is gone: two commits happen meanwhile.
      await release(w, w.cashier.userId, w.request.id, 2);
      await claim(w, w.manager.userId, w.request.id, 3);

      const second = await connect(w.tenantId, w.manager.userId, {
        after: lastSeen,
      });
      await second.waitForEvent('request.claimed');
      expect(second.names).toEqual(['request.released', 'request.claimed']);
      expect(second.of('request.released')[0].data).toMatchObject({
        request: { version: 4 }, // the current row, not an old snapshot
      });
      const live = await release(w, w.manager.userId, w.request.id, 4);
      expect(live.version).toBe(5);
      await second.waitForEvent('request.released', 2);
      const all = second.messages.map((m) => m.id);
      expect(new Set(all).size).toBe(all.length);
    });

    it('?after= works for clients that cannot set the header', async () => {
      const w = await world();
      await claim(w, w.cashier.userId, w.request.id, 1);
      const client = await connect(w.tenantId, w.manager.userId, {
        query: '?after=0',
      });
      await client.waitForEvent('request.claimed');
      expect(client.names).toEqual(['request.claimed']);
    });

    it('a personal cursor never replays another user notifications', async () => {
      const w = await world();
      await h.prisma.$executeRaw`
        INSERT INTO realtime_events ("tenantId", "userId", "type", "payload")
        VALUES (${w.tenantId}, ${w.cashier.userId}, 'notification.created',
                '{"notificationId":"x"}'::jsonb)`;
      const manager = await connect(w.tenantId, w.manager.userId, {
        query: '?after=0',
      });
      const cashier = await connect(w.tenantId, w.cashier.userId, {
        query: '?after=0',
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(manager.names).toEqual([]);
      expect(cashier.names).toEqual([]); // the notice no longer exists: no frame
    });

    it('answers resync when the cursor is older than the retention', async () => {
      const w = await world();
      await claim(w, w.cashier.userId, w.request.id, 1);
      await release(w, w.cashier.userId, w.request.id, 2);
      // Expire everything this tenant has and let the purge raise its mark.
      await h.prisma.$executeRaw`
        UPDATE realtime_events SET "createdAt" = now() - interval '48 hours'
        WHERE "tenantId" = ${w.tenantId}`;
      const { PrismaRealtimeEventStore } =
        await import('./infrastructure/prisma-realtime-event.store');
      const removed = await new PrismaRealtimeEventStore(h.prisma).purgeExpired(
        new Date(),
        1000,
      );
      expect(removed).toBeGreaterThanOrEqual(2);
      await claim(w, w.manager.userId, w.request.id, 3);
      const client = await connect(w.tenantId, w.manager.userId, {
        after: '1',
      });
      await client.waitForEvent('resync');
      expect(client.of('resync')[0].data).toEqual({ reason: 'CURSOR_EXPIRED' });
      expect(client.ended).toBe(false);
      // The stream stays open and live from the head.
      await release(w, w.manager.userId, w.request.id, 4);
      await client.waitForEvent('request.released');
    });
  });

  describe('per-recipient rows (R12)', () => {
    it('two roles get differently masked rows and actions; neither gets the raw key', async () => {
      const w = await world();
      const customer = await h.prisma.customer.create({
        data: {
          tenantId: w.tenantId,
          firstName: 'Juan',
          lastName: 'Pérez',
          phoneCountryCode: '52',
          phone: '5512345678',
        },
      });
      const request = await h.seedRequest(w.tenantId, {
        customerKey: '525512345678',
        customerId: customer.id,
        phoneCountryCode: '52',
        phone: '5512345678',
      });
      const managerStream = await connect(w.tenantId, w.manager.userId);
      const cashierStream = await connect(w.tenantId, w.cashier.userId);
      await Promise.all([
        managerStream.waitForEvent('ready'),
        cashierStream.waitForEvent('ready'),
      ]);
      await claim(w, w.cashier.userId, request.id, 1);
      await managerStream.waitForEvent('request.claimed');
      await cashierStream.waitForEvent('request.claimed');

      type Frame = {
        request: { customerKey: string; allowedActions: string[] };
        customer: { phone: string; displayName: string };
      };
      const asManager = managerStream.of('request.claimed')[0].data as Frame;
      const asCashier = cashierStream.of('request.claimed')[0].data as Frame;
      expect(asManager.customer.phone).toBe('+525512345678');
      expect(asCashier.customer.phone).toBe('55 **** 5678');
      expect(asManager.customer.displayName).toBe('Juan Pérez');
      // The same opaque token for both roles, bound to the tenant.
      expect(asManager.request.customerKey).toBe(asCashier.request.customerKey);
      expect(h.sealer.open(w.tenantId, asCashier.request.customerKey)).toBe(
        '525512345678',
      );
      // Actions are the recipient's own: the holder may release, a manager may
      // reassign, the cashier may not.
      expect(asManager.request.allowedActions).toContain('REASSIGN');
      expect(asCashier.request.allowedActions).toEqual(
        expect.not.arrayContaining(['REASSIGN']),
      );
      // R12: no full number reaches the role without read:CustomerPhone.
      expect(cashierStream.raw).not.toMatch(LEAK);
      expect(cashierStream.raw).not.toContain('5512345678');
      expect(managerStream.raw).not.toContain('"customerKey":"525512345678"');
    });

    it('R12 walk: every request event type, for the role without the phone permission', async () => {
      const w = await world();
      const customer = await h.prisma.customer.create({
        data: {
          tenantId: w.tenantId,
          firstName: 'Ana',
          phoneCountryCode: '52',
          phone: '5599887766',
        },
      });
      const request = await h.seedRequest(w.tenantId, {
        customerKey: '525599887766',
        customerId: customer.id,
        phoneCountryCode: '52',
        phone: '5599887766',
      });
      const cashierStream = await connect(w.tenantId, w.cashier.userId);
      await cashierStream.waitForEvent('ready');
      await claim(w, w.cashier.userId, request.id, 1);
      await h.command(w.tenantId, w.manager.userId, request.id, 2, {
        kind: 'reassign',
        toUserId: w.manager.userId,
      });
      await release(w, w.manager.userId, request.id, 3);
      await h.prisma.$executeRaw`
        INSERT INTO chatbot_request_events
          ("id","tenantId","requestId","type","actorKind","version","data")
        VALUES (gen_random_uuid()::text, ${w.tenantId}, ${request.id},
                'SLA_MILESTONE','SYSTEM', 4, '{"milestone":"OVERDUE","clock":"RESOLVE","cycle":"1"}'::jsonb)`;
      await h.command(w.tenantId, w.cashier.userId, request.id, 4, {
        kind: 'cancel',
        reason: 'DUPLICATE',
      });
      await cashierStream.waitFor(
        (m) => m.filter((x) => x.event.startsWith('request.')).length >= 5,
        5_000,
        'five request events',
      );
      expect(cashierStream.names).toEqual([
        'ready',
        'request.claimed',
        'request.reassigned',
        'request.released',
        'request.overdue',
        'request.cancelled',
      ]);
      expect(cashierStream.raw).not.toMatch(LEAK);
      expect(cashierStream.raw).not.toContain('5599887766');
    });

    it('a request of another tenant never reaches the stream (isolation)', async () => {
      const a = await world();
      const b = await world();
      const streamA = await connect(a.tenantId, a.manager.userId);
      const streamB = await connect(b.tenantId, b.manager.userId);
      await Promise.all([
        streamA.waitForEvent('ready'),
        streamB.waitForEvent('ready'),
      ]);
      await claim(b, b.cashier.userId, b.request.id, 1);
      await streamB.waitForEvent('request.claimed');
      await claim(a, a.cashier.userId, a.request.id, 1);
      await streamA.waitForEvent('request.claimed');
      await new Promise((r) => setTimeout(r, 200));
      expect(streamA.of('request.claimed')).toHaveLength(1);
      expect(streamB.of('request.claimed')).toHaveLength(1);
      expect(JSON.stringify(streamA.messages)).not.toContain(b.request.id);
      expect(JSON.stringify(streamB.messages)).not.toContain(a.request.id);
      // A tenant-B event id never appears as a cursor of tenant A.
      expect(streamA.lastEventId).not.toBe(streamB.lastEventId);
    });

    it('a cursor of tenant A used on tenant B never replays tenant A events', async () => {
      const a = await world();
      const b = await world();
      await claim(a, a.cashier.userId, a.request.id, 1);
      const streamB = await connect(b.tenantId, b.manager.userId, {
        query: '?after=0',
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(streamB.names).toEqual([]);
    });
  });

  describe('notifications (only to their person)', () => {
    it('notification.created and notification.read reach only the owner, with unreadCount', async () => {
      const w = await world();
      const ana = await connect(w.tenantId, w.manager.userId);
      const luis = await connect(w.tenantId, w.cashier.userId);
      await Promise.all([
        ana.waitForEvent('ready'),
        luis.waitForEvent('ready'),
      ]);
      const notice = await h.prisma.notification.create({
        data: {
          tenantId: w.tenantId,
          userId: w.manager.userId,
          type: 'REQUEST_CREATED',
          requestId: w.request.id,
          payload: { folio: 7, subtype: 'UNKNOWN_QUESTION' },
          dedupKey: randomUUID(),
        },
      });
      await h.prisma.$transaction(async (tx) => {
        await h.adapter.publishCreated(tx, {
          tenantId: w.tenantId,
          userId: w.manager.userId,
          notificationId: notice.id,
          type: 'REQUEST_CREATED',
          requestId: w.request.id,
        });
      });
      await ana.waitForEvent('notification.created');
      expect(ana.of('notification.created')[0].data).toMatchObject({
        notification: {
          id: notice.id,
          type: 'REQUEST_CREATED',
          requestId: w.request.id,
          readAt: null,
          // S10: the same structured fields as the list item
          folio: 'S-000007',
          subtype: 'UNKNOWN_QUESTION',
          cause: null,
          reason: null,
          requestOpen: true,
        },
        unreadCount: 1,
      });
      await h.cls.runWith(
        { tenantId: w.tenantId, userId: w.manager.userId, isSuperAdmin: false },
        () => h.notifications.markRead(w.manager.userId, notice.id),
      );
      await ana.waitForEvent('notification.read');
      expect(ana.of('notification.read')[0].data).toEqual({
        ids: [notice.id],
        all: false,
        unreadCount: 0,
      });
      await new Promise((r) => setTimeout(r, 200));
      expect(luis.names).toEqual(['ready']);
    });
  });

  describe('access revoked while connected (R5)', () => {
    it('a removed membership closes the stream with access-revoked on the next delivery', async () => {
      const w = await world();
      const keeper = await connect(w.tenantId, w.manager.userId);
      const victim = await connect(w.tenantId, w.cashier.userId);
      await Promise.all([
        keeper.waitForEvent('ready'),
        victim.waitForEvent('ready'),
      ]);
      await h.prisma.tenantMembership.deleteMany({
        where: { userId: w.cashier.userId, tenantId: w.tenantId },
      });
      await claim(w, w.manager.userId, w.request.id, 1);
      await victim.waitForEvent('access-revoked');
      expect(victim.of('access-revoked')[0].data).toEqual({
        reason: 'MEMBERSHIP_REMOVED',
      });
      await victim.whenEnded();
      expect(victim.names).toEqual(['ready', 'access-revoked']);
      // The others are unaffected.
      await keeper.waitForEvent('request.claimed');
      expect(keeper.ended).toBe(false);
    });

    it('a deactivated user is closed with USER_INACTIVE', async () => {
      const w = await world();
      const victim = await connect(w.tenantId, w.cashier.userId);
      await victim.waitForEvent('ready');
      await h.prisma.user.update({
        where: { id: w.cashier.userId },
        data: { isActive: false },
      });
      await claim(w, w.manager.userId, w.request.id, 1);
      await victim.waitForEvent('access-revoked');
      expect(victim.of('access-revoked')[0].data).toEqual({
        reason: 'USER_INACTIVE',
      });
      await victim.whenEnded();
    });

    it('losing read:ChatbotRequest closes with PERMISSION_REVOKED', async () => {
      const w = await world();
      const victim = await connect(w.tenantId, w.cashier.userId);
      await victim.waitForEvent('ready');
      const read = await h.prisma.permission.findFirstOrThrow({
        where: { subject: 'ChatbotRequest', action: 'read' },
      });
      const role = await h.prisma.tenantMembership.findFirstOrThrow({
        where: { userId: w.cashier.userId, tenantId: w.tenantId },
      });
      await h.prisma.rolePermission.deleteMany({
        where: { roleId: role.roleId, permissionId: read.id },
      });
      await claim(w, w.manager.userId, w.request.id, 1);
      await victim.waitForEvent('access-revoked');
      expect(victim.of('access-revoked')[0].data).toEqual({
        reason: 'PERMISSION_REVOKED',
      });
      expect(victim.names).not.toContain('request.claimed');
    });

    it('a revoked read:CustomerPhone masks the very next event', async () => {
      const w = await world();
      const customer = await h.prisma.customer.create({
        data: {
          tenantId: w.tenantId,
          firstName: 'Luz',
          phoneCountryCode: '52',
          phone: '5544332211',
        },
      });
      const request = await h.seedRequest(w.tenantId, {
        customerKey: '525544332211',
        customerId: customer.id,
        phoneCountryCode: '52',
        phone: '5544332211',
      });
      const stream = await connect(w.tenantId, w.manager.userId);
      await stream.waitForEvent('ready');
      await claim(w, w.cashier.userId, request.id, 1);
      await stream.waitForEvent('request.claimed');
      expect(JSON.stringify(stream.of('request.claimed')[0].data)).toContain(
        '+525544332211',
      );
      const phone = await h.prisma.permission.findFirstOrThrow({
        where: { subject: 'CustomerPhone', action: 'read' },
      });
      const membership = await h.prisma.tenantMembership.findFirstOrThrow({
        where: { userId: w.manager.userId, tenantId: w.tenantId },
      });
      await h.prisma.rolePermission.deleteMany({
        where: { roleId: membership.roleId, permissionId: phone.id },
      });
      await release(w, w.cashier.userId, request.id, 2);
      await stream.waitForEvent('request.released');
      const masked = JSON.stringify(stream.of('request.released')[0].data);
      expect(masked).toContain('55 **** 2211');
      expect(masked).not.toContain('5544332211');
    });
  });

  describe('token expiry, limits and cleanup', () => {
    it('sends auth-expired at the token exp and ends the response', async () => {
      const w = await world();
      const client = await connect(w.tenantId, w.manager.userId, {
        headers: { authorization: fakeJwt(Math.ceil(Date.now() / 1000) + 2) },
      });
      await client.waitForEvent('ready');
      await client.waitForEvent('auth-expired', 1, 6_000);
      await client.whenEnded();
    });

    it('the sixth stream of one user replaces the oldest with connection-replaced', async () => {
      const w = await world();
      const open: SseClient[] = [];
      for (let i = 0; i < STREAM_LIMITS.maxStreamsPerUser; i += 1) {
        const client = await connect(w.tenantId, w.manager.userId);
        await client.waitForEvent('ready');
        open.push(client);
      }
      const sixth = await connect(w.tenantId, w.manager.userId);
      await sixth.waitForEvent('ready');
      await open[0].waitForEvent('connection-replaced');
      await open[0].whenEnded();
      expect(open[0].names).toEqual(['ready', 'connection-replaced']);
      for (const kept of [...open.slice(1), sixth]) {
        expect(kept.ended).toBe(false);
      }
    });

    it('frees the slot when the client disconnects (no leak)', async () => {
      const w = await world();
      const before = h.hub.openStreams;
      const client = await connect(w.tenantId, w.manager.userId);
      await client.waitForEvent('ready');
      expect(h.hub.openStreams).toBe(before + 1);
      client.close();
      await new Promise<void>((resolve, reject) => {
        const started = Date.now();
        const poll = () => {
          if (h.hub.openStreams === before) return resolve();
          if (Date.now() - started > 3_000) return reject(new Error('leaked'));
          setTimeout(poll, 25);
        };
        poll();
      });
    });
  });
});
