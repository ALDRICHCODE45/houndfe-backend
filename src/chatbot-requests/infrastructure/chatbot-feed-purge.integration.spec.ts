/**
 * Chatbot feed retention schedule against real PostgreSQL (contract §3.3: 30
 * days; §6.2: requests and audit kept; §10.1 R11; unit 7b):
 *   - the cutoff boundary: an item 1 ms older than 30 days goes, one exactly
 *     30 days old (and one 1 ms younger) stays;
 *   - acknowledged or not, an old item goes; a recent one stays either way;
 *   - the per-tenant watermark rises to the highest purged cursor;
 *   - requests and their audit events are never touched;
 *   - bounded batches: a run removes at most `batchSize` × `maxBatchesPerTick`
 *     and the next tick keeps draining;
 *   - two concurrent runs neither double-delete nor fail (`SKIP LOCKED`).
 */
import { randomUUID } from 'crypto';
import { integrationPrisma } from '../../../test/integration/reset-db';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { ChatbotFeedPurgeScheduler } from './chatbot-feed-purge.scheduler';
import { PrismaChatbotFeedStore } from './prisma-chatbot-feed.store';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

const DAY = 86_400_000;
const NOW = new Date('2026-11-11T12:00:00.000Z');
const CUTOFF = new Date(NOW.getTime() - 30 * DAY);

describeIfDb('chatbot feed purge schedule (PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const store = new PrismaChatbotFeedStore(
    undefined as never,
    prisma as unknown as PrismaService,
  );
  const tenants: string[] = [];
  let folio = 0;

  function scheduler(
    options: { batchSize?: number; maxBatchesPerTick?: number } = {},
  ) {
    return new ChatbotFeedPurgeScheduler(store, {
      clock: () => NOW,
      ...options,
    });
  }

  async function tenantWithRequest() {
    const tenantId = randomUUID();
    tenants.push(tenantId);
    await prisma.tenant.create({
      data: { id: tenantId, name: 'Sucursal Centro', slug: `fp-${tenantId}` },
    });
    const request = await prisma.chatbotRequest.create({
      data: {
        tenantId,
        folio: ++folio,
        kind: 'CLARIFICATION',
        subtype: 'UNKNOWN_QUESTION',
        customerKey: `5255000${folio}`,
        conversationRef: `wa:5215500${folio}`,
        summary: '¿Sirve para cachorros?',
        source: 'chatbot',
        sourceRequestId: randomUUID(),
      },
    });
    await prisma.chatbotRequestEvent.create({
      data: {
        tenantId,
        requestId: request.id,
        type: 'CREATED',
        actorKind: 'SERVICE',
        actorId: 'cred-feed-purge',
        version: 1,
      },
    });
    return { tenantId, requestId: request.id };
  }

  const item = (
    t: { tenantId: string; requestId: string },
    createdAt: Date,
    over: Record<string, unknown> = {},
  ) =>
    prisma.chatbotFeedItem.create({
      data: {
        tenantId: t.tenantId,
        requestId: t.requestId,
        type: 'request.cancelled',
        payload: {},
        createdAt,
        ...over,
      },
    });

  const remaining = (tenantId: string) =>
    prisma.chatbotFeedItem.findMany({
      where: { tenantId },
      orderBy: { cursor: 'asc' },
    });

  beforeEach(async () => {
    // Test database only: the purge is global, so start from an empty table.
    await prisma.chatbotFeedItem.deleteMany({});
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
  });

  it('deletes strictly older than 30 days: just before goes, the cutoff and just after stay', async () => {
    const t = await tenantWithRequest();
    const before = await item(t, new Date(CUTOFF.getTime() - 1));
    const at = await item(t, CUTOFF);
    const after = await item(t, new Date(CUTOFF.getTime() + 1));

    const run = await scheduler().purge();

    expect(run).toEqual({ removed: 1, batches: 1, hasMore: false });
    const left = (await remaining(t.tenantId)).map((r) => r.cursor);
    expect(left).toEqual([at.cursor, after.cursor]);
    expect(left).not.toContain(before.cursor);
  });

  it('removes old items acknowledged or not, and keeps recent ones either way', async () => {
    const t = await tenantWithRequest();
    const old = new Date(NOW.getTime() - 45 * DAY);
    const recent = new Date(NOW.getTime() - 2 * DAY);
    const ack = {
      ackedAt: old,
      outcome: 'PROVIDER_ACCEPTED',
      attemptId: 'a1',
      evidenceHash: 'h',
    };
    await item(t, old);
    await item(t, old, ack);
    const keptPending = await item(t, recent);
    const keptAcked = await item(t, recent, { ...ack, ackedAt: recent });

    await scheduler().purge();

    expect((await remaining(t.tenantId)).map((r) => r.cursor)).toEqual([
      keptPending.cursor,
      keptAcked.cursor,
    ]);
  });

  it('raises each tenant watermark to its highest purged cursor, and only for tenants that lost items', async () => {
    const a = await tenantWithRequest();
    const b = await tenantWithRequest();
    const c = await tenantWithRequest();
    const old = new Date(NOW.getTime() - 40 * DAY);
    await item(a, old);
    const lastA = await item(a, old);
    const lastB = await item(b, old);
    await item(c, new Date(NOW.getTime() - DAY));

    await scheduler().purge();

    const marks = await prisma.chatbotFeedRetention.findMany({
      where: { tenantId: { in: [a.tenantId, b.tenantId, c.tenantId] } },
    });
    const byTenant = new Map(marks.map((m) => [m.tenantId, m]));
    expect(byTenant.get(a.tenantId)?.purgedThroughCursor).toBe(lastA.cursor);
    expect(byTenant.get(b.tenantId)?.purgedThroughCursor).toBe(lastB.cursor);
    expect(byTenant.has(c.tenantId)).toBe(false);
  });

  it('never touches requests or their audit events', async () => {
    const t = await tenantWithRequest();
    await item(t, new Date(NOW.getTime() - 400 * DAY));

    await scheduler().purge();

    expect(await remaining(t.tenantId)).toEqual([]);
    expect(
      await prisma.chatbotRequest.count({ where: { tenantId: t.tenantId } }),
    ).toBe(1);
    expect(
      await prisma.chatbotRequestEvent.count({
        where: { tenantId: t.tenantId },
      }),
    ).toBe(1);
  });

  it('is bounded: one tick removes at most batchSize × maxBatchesPerTick, the next keeps draining', async () => {
    const t = await tenantWithRequest();
    const old = new Date(NOW.getTime() - 60 * DAY);
    await prisma.chatbotFeedItem.createMany({
      data: Array.from({ length: 25 }, () => ({
        tenantId: t.tenantId,
        requestId: t.requestId,
        type: 'request.cancelled',
        payload: {},
        createdAt: old,
      })),
    });
    const s = scheduler({ batchSize: 10, maxBatchesPerTick: 2 });

    // Public tick behavior: a capped run leaves the rest for the next tick.
    await s.poll();
    expect(await remaining(t.tenantId)).toHaveLength(5);
    await s.poll();
    expect(await remaining(t.tenantId)).toHaveLength(0);
  });

  it('a single batch never exceeds the batch size', async () => {
    const t = await tenantWithRequest();
    const old = new Date(NOW.getTime() - 60 * DAY);
    await prisma.chatbotFeedItem.createMany({
      data: Array.from({ length: 25 }, () => ({
        tenantId: t.tenantId,
        requestId: t.requestId,
        type: 'request.cancelled',
        payload: {},
        createdAt: old,
      })),
    });
    const run = await scheduler({
      batchSize: 10,
      maxBatchesPerTick: 1,
    }).purge();
    expect(run).toEqual({ removed: 10, batches: 1, hasMore: true });
    expect(await remaining(t.tenantId)).toHaveLength(15);
  });

  it('two concurrent runs delete every old row exactly once and neither fails', async () => {
    const t = await tenantWithRequest();
    const old = new Date(NOW.getTime() - 60 * DAY);
    await prisma.chatbotFeedItem.createMany({
      data: Array.from({ length: 300 }, () => ({
        tenantId: t.tenantId,
        requestId: t.requestId,
        type: 'request.cancelled',
        payload: {},
        createdAt: old,
      })),
    });
    const fresh = await item(t, new Date(NOW.getTime() - DAY));

    const runs = await Promise.all([
      scheduler({ batchSize: 10 }).purge(),
      scheduler({ batchSize: 10 }).purge(),
      scheduler({ batchSize: 10 }).purge(),
    ]);

    expect(runs.reduce((sum, r) => sum + r.removed, 0)).toBe(300);
    expect((await remaining(t.tenantId)).map((r) => r.cursor)).toEqual([
      fresh.cursor,
    ]);
    const mark = await prisma.chatbotFeedRetention.findUniqueOrThrow({
      where: { tenantId: t.tenantId },
    });
    expect(mark.purgedThroughCursor).toBeLessThan(fresh.cursor);
  });
});
