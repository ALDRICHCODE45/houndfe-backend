/**
 * human-intervention / unit 8 — the durable realtime log against REAL
 * PostgreSQL: the deferred trigger on `chatbot_request_events` (request events
 * commit with the change that caused them), the writer used by the
 * notification code, the per-tenant commit-order guarantee, the replay reads
 * and the bounded retention purge (contract §5.3, §10.1 R7).
 */
import { randomUUID } from 'crypto';
import type { ChatbotRequestEventType, Prisma } from '@prisma/client';
import { integrationPrisma } from '../../test/integration/reset-db';
import { emitRealtimeEvents } from '../shared/realtime/realtime-event-writes';
import { PrismaRealtimeEventStore } from './infrastructure/prisma-realtime-event.store';
import { REQUEST_EVENT_TO_REALTIME } from './domain/realtime-events';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

describeIfDb('realtime event log (PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const store = new PrismaRealtimeEventStore(prisma);
  const tenants: string[] = [];
  let tenantId: string;
  let requestId: string;
  let folio = 0;

  const newTenant = async () => {
    const id = randomUUID();
    await prisma.tenant.create({
      data: { id, name: 'Sucursal RT', slug: `rt-${id}` },
    });
    tenants.push(id);
    return id;
  };

  const newRequest = async (tenant: string) => {
    folio += 1;
    const created = await prisma.chatbotRequest.create({
      data: {
        tenantId: tenant,
        folio,
        kind: 'CLARIFICATION',
        subtype: 'UNKNOWN_QUESTION',
        customerKey: `5255${1000000 + folio}`,
        summary: 'Pregunta',
        source: 'chatbot',
        sourceRequestId: randomUUID(),
      },
      select: { id: true },
    });
    return created.id;
  };

  const eventData = (
    tenant: string,
    request: string,
    type: ChatbotRequestEventType,
    data: Record<string, unknown> = {},
    version = 1,
  ): Prisma.ChatbotRequestEventCreateManyInput => ({
    tenantId: tenant,
    requestId: request,
    type,
    actorKind: 'SYSTEM',
    version,
    data: data as Prisma.InputJsonObject,
  });

  const rows = (tenant: string) =>
    prisma.$queryRaw<
      {
        id: bigint;
        userId: string | null;
        type: string;
        requestId: string | null;
        payload: Record<string, unknown>;
      }[]
    >`SELECT id, "userId", type, "requestId", payload FROM realtime_events
      WHERE "tenantId" = ${tenant} ORDER BY id`;

  beforeEach(async () => {
    tenantId = await newTenant();
    requestId = await newRequest(tenantId);
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.$disconnect();
  });

  describe('the deferred trigger on chatbot_request_events', () => {
    it('maps every audit event type the way the domain table says', async () => {
      const all: ChatbotRequestEventType[] = [
        'CREATED',
        'MERGED',
        'CLAIMED',
        'RELEASED',
        'AUTO_RELEASED',
        'REASSIGNED',
        'RESOLVED',
        'REPLIED',
        'TEMPLATE_SENT',
        'FINISHED',
        'CANCELLED',
        'RESCHEDULED',
        'CUSTOMER_LINKED',
        'SLA_MILESTONE',
        'DELIVERY_OUTCOME',
      ];
      const expected: Array<[string, string | null]> = [];
      for (const type of all) {
        const mapped = REQUEST_EVENT_TO_REALTIME(type, { role: 'SOURCE' });
        expected.push([type, mapped]);
      }
      // Every Prisma enum value is classified (a new type must be decided).
      expect(expected.map(([t]) => t).sort()).toEqual([...all].sort());

      const id = await newRequest(tenantId);
      for (const [type, mapped] of expected) {
        await prisma.chatbotRequestEvent.create({
          data: eventData(
            tenantId,
            id,
            type as ChatbotRequestEventType,
            { role: 'SOURCE', milestone: 'HALF' },
            3,
          ),
        });
        const seen = (await rows(tenantId)).filter((r) => r.requestId === id);
        // Each insert is its own committed transaction.
        const last = seen.at(-1);
        if (mapped === null) {
          expect(
            seen.some((r) => (r.payload as { cause?: string }).cause === type),
          ).toBe(false);
        } else {
          expect(last?.type).toBe(mapped);
          expect(last?.userId).toBeNull();
          expect(last?.payload).toMatchObject({ version: 3, cause: type });
        }
      }
    });

    it('maps the second MERGED role and the OVERDUE milestone', async () => {
      const id = await newRequest(tenantId);
      await prisma.chatbotRequestEvent.createMany({
        data: [
          eventData(tenantId, id, 'MERGED', { role: 'TARGET' }),
          eventData(tenantId, id, 'MERGED', { role: 'SOURCE' }),
          eventData(tenantId, id, 'SLA_MILESTONE', {
            milestone: 'OVERDUE',
            clock: 'CLAIM',
            cycle: '1',
          }),
          eventData(tenantId, id, 'SLA_MILESTONE', {
            milestone: 'ESCALATION',
            clock: 'CLAIM',
            cycle: '1',
          }),
        ],
      });
      const mine = (await rows(tenantId)).filter((r) => r.requestId === id);
      expect(mine.map((r) => r.type)).toEqual([
        'request.cancelled',
        'request.overdue',
        'request.updated',
      ]);
    });

    it('does not announce backfilled events', async () => {
      const id = await newRequest(tenantId);
      await prisma.chatbotRequestEvent.create({
        data: eventData(tenantId, id, 'CREATED', { backfilled: true }),
      });
      expect((await rows(tenantId)).filter((r) => r.requestId === id)).toEqual(
        [],
      );
    });

    it('writes at commit, in the same transaction, and nothing on rollback', async () => {
      const id = await newRequest(tenantId);
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.chatbotRequestEvent.create({
            data: eventData(tenantId, id, 'CLAIMED'),
          });
          // Deferred: the log row is only written when the transaction ends.
          const [inside] = await tx.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM realtime_events
            WHERE "tenantId" = ${tenantId} AND "requestId" = ${id}`;
          expect(inside.n).toBe(0);
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect((await rows(tenantId)).filter((r) => r.requestId === id)).toEqual(
        [],
      );

      await prisma.$transaction(async (tx) => {
        await tx.chatbotRequestEvent.create({
          data: eventData(tenantId, id, 'CLAIMED', {}, 2),
        });
      });
      const mine = (await rows(tenantId)).filter((r) => r.requestId === id);
      expect(mine).toHaveLength(1);
      expect(mine[0].type).toBe('request.claimed');
    });

    it('a rolled-back savepoint announces nothing', async () => {
      const id = await newRequest(tenantId);
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SAVEPOINT s1`;
        await tx.chatbotRequestEvent.create({
          data: eventData(tenantId, id, 'CLAIMED'),
        });
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT s1`;
        await tx.chatbotRequestEvent.create({
          data: eventData(tenantId, id, 'RELEASED', {}, 2),
        });
      });
      const mine = (await rows(tenantId)).filter((r) => r.requestId === id);
      expect(mine.map((r) => r.type)).toEqual(['request.released']);
    });
  });

  describe('emitRealtimeEvents (notification producers)', () => {
    it('inserts personal events with the writer, in the caller transaction', async () => {
      const userId = randomUUID();
      await prisma.$transaction(async (tx) => {
        await emitRealtimeEvents(tx, [
          {
            tenantId,
            userId,
            type: 'notification.created',
            payload: { notificationId: 'n1' },
          },
        ]);
      });
      const mine = (await rows(tenantId)).filter((r) => r.userId === userId);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({
        type: 'notification.created',
        payload: { notificationId: 'n1' },
      });
      await expect(
        prisma.$transaction(async (tx) => {
          await emitRealtimeEvents(tx, [
            {
              tenantId,
              userId,
              type: 'notification.read',
              payload: { ids: null, all: true },
            },
          ]);
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(
        (await rows(tenantId)).filter((r) => r.type === 'notification.read'),
      ).toEqual([]);
    });
  });

  describe('order and replay', () => {
    it('a second writer of the same tenant waits for the first to commit, so ids follow commit order', async () => {
      const [a, b] = await Promise.all([
        newRequest(tenantId),
        newRequest(tenantId),
      ]);
      // `SET CONSTRAINTS ALL IMMEDIATE` fires the deferred trigger inside the
      // transaction, which is how a writer is made to hold the lock for a
      // while: in production the trigger runs at commit and the lock is held
      // only for the commit itself, but the lock semantics are the same.
      let releaseA: () => void = () => undefined;
      const holdA = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      let aInserted: () => void = () => undefined;
      const aHasLock = new Promise<void>((resolve) => {
        aInserted = resolve;
      });
      const txA = prisma.$transaction(async (tx) => {
        await tx.chatbotRequestEvent.create({
          data: eventData(tenantId, a, 'CREATED'),
        });
        await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
        aInserted();
        await holdA;
      });
      await aHasLock;
      let bBlockedMs = 0;
      const txB = prisma.$transaction(async (tx) => {
        await tx.chatbotRequestEvent.create({
          data: eventData(tenantId, b, 'CREATED'),
        });
        const started = Date.now();
        await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
        bBlockedMs = Date.now() - started;
      });
      await new Promise((r) => setTimeout(r, 300));
      // B is stuck behind A's lock: nothing of B is visible yet.
      expect((await rows(tenantId)).filter((r) => r.requestId === b)).toEqual(
        [],
      );
      releaseA();
      await Promise.all([txA, txB]);
      expect(bBlockedMs).toBeGreaterThanOrEqual(250);
      const seen = (await rows(tenantId)).filter((r) =>
        [a, b].includes(r.requestId as string),
      );
      expect(seen.map((r) => r.requestId)).toEqual([a, b]);
      expect(seen[0].id < seen[1].id).toBe(true);
    });

    it('many concurrent writers of one tenant lose no event and never repeat an id', async () => {
      const ids = await Promise.all(
        Array.from({ length: 12 }, () => newRequest(tenantId)),
      );
      await Promise.all(
        ids.map((id, i) =>
          prisma.$transaction(async (tx) => {
            await tx.chatbotRequestEvent.create({
              data: eventData(tenantId, id, 'CREATED'),
            });
            await new Promise((r) => setTimeout(r, (i % 3) * 5));
          }),
        ),
      );
      const seen = (await rows(tenantId)).filter((r) =>
        ids.includes(r.requestId as string),
      );
      expect(seen).toHaveLength(12);
      expect(new Set(seen.map((r) => r.id)).size).toBe(12);
      expect(new Set(seen.map((r) => r.requestId)).size).toBe(12);
    });

    it('readAfter returns broadcast plus the caller own events, never another user', async () => {
      const ana = randomUUID();
      const luis = randomUUID();
      const before = await store.tenantHead(tenantId);
      await prisma.chatbotRequestEvent.create({
        data: eventData(tenantId, requestId, 'CLAIMED', {}, 2),
      });
      await prisma.$transaction(async (tx) => {
        await emitRealtimeEvents(tx, [
          {
            tenantId,
            userId: ana,
            type: 'notification.created',
            payload: { notificationId: 'a' },
          },
          {
            tenantId,
            userId: luis,
            type: 'notification.created',
            payload: { notificationId: 'l' },
          },
        ]);
      });
      const forAna = await store.readAfter(tenantId, ana, before, 100);
      expect(forAna.map((e) => e.type)).toEqual([
        'request.claimed',
        'notification.created',
      ]);
      expect(forAna[1].payload).toEqual({ notificationId: 'a' });
      const all = await store.readAfter(tenantId, null, before, 100);
      expect(all).toHaveLength(3);
      // `after` is exclusive and `limit` bounds the page, oldest first.
      const page = await store.readAfter(tenantId, ana, before, 1);
      expect(page).toHaveLength(1);
      const next = await store.readAfter(tenantId, ana, page[0].id, 100);
      expect(next.map((e) => e.type)).toEqual(['notification.created']);
    });

    it('is tenant scoped: another tenant never sees these events', async () => {
      const other = await newTenant();
      await prisma.chatbotRequestEvent.create({
        data: eventData(tenantId, requestId, 'CLAIMED', {}, 2),
      });
      expect(await store.readAfter(other, randomUUID(), 0n, 100)).toEqual([]);
      expect(await store.tenantHead(other)).toBe(0n);
      expect(await store.tenantHead(tenantId)).toBeGreaterThan(0n);
    });
  });

  describe('retention purge', () => {
    // Real clock: rows other tests wrote a moment ago must count as fresh.
    const NOW = new Date();

    const seedOld = async (tenant: string, count: number, hoursAgo: number) => {
      await prisma.$executeRaw`
        INSERT INTO realtime_events ("tenantId", "type", "payload", "createdAt")
        SELECT ${tenant}, 'request.updated', '{}'::jsonb,
               ${new Date(NOW.getTime() - hoursAgo * 3_600_000)}
        FROM generate_series(1, ${count})`;
    };

    it('removes only expired rows, in bounded batches, and raises the watermark', async () => {
      const t1 = await newTenant();
      const t2 = await newTenant();
      await seedOld(t1, 30, 30);
      await seedOld(t2, 10, 30);
      await seedOld(t1, 5, 1);
      const removed = await store.purgeExpired(NOW, 25);
      expect(removed).toBe(25);
      expect(await store.purgeExpired(NOW, 25)).toBe(15);
      expect(await store.purgeExpired(NOW, 25)).toBe(0);
      const left = await rows(t1);
      expect(left).toHaveLength(5);
      const mark = await store.purgedThrough(t1);
      expect(mark).toBeGreaterThan(0n);
      expect(left.every((r) => r.id > mark)).toBe(true);
      expect(await store.purgedThrough(t2)).toBeGreaterThan(0n);
    });

    it('two replicas purging at once delete every row exactly once', async () => {
      const t = await newTenant();
      await seedOld(t, 300, 48);
      const [a, b] = await Promise.all([
        store.purgeExpired(NOW, 100),
        store.purgeExpired(NOW, 100),
      ]);
      expect(a + b).toBe(200);
      expect(await store.purgeExpired(NOW, 100)).toBe(100);
      expect(await rows(t)).toEqual([]);
    });

    it('a tenant that never purged has watermark 0', async () => {
      expect(await store.purgedThrough(await newTenant())).toBe(0n);
    });
  });
});
