/**
 * human-intervention / unit 7c — the SLA sweep against REAL PostgreSQL
 * (contract §5.4, §5.1, §10.1 R11): milestones once per request, the notices in
 * the notifications outbox, `request.overdue_notice` exactly once, the stale
 * policy reconcile, bounded batches, two concurrent sweeps, closed rows
 * skipped, and a purge of old notifications that never causes a re-notify.
 * The clock is injected; the schedule is Mon-Sat 09:00-19:00 America/Mexico_City
 * (the defaults, UTC-6 in November).
 */
import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { integrationPrisma } from '../../test/integration/reset-db';
import type { PrismaService } from '../shared/prisma/prisma.service';
import * as writer from '../notifications/infrastructure/chatbot-request-notice.writer';
import { defaultSettings } from '../chatbot-settings/domain/chatbot-attention-settings';
import { ChatbotSlaSweepScheduler } from './infrastructure/chatbot-sla-sweep.scheduler';
import { ChatbotSlaSweepStore } from './infrastructure/chatbot-sla-sweep.store';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

type Row = Partial<Prisma.ChatbotRequestUncheckedCreateInput>;
const at = (v: string) => new Date(v);

describeIfDb('SLA sweep (PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const tenants: string[] = [];
  let tenantId: string;
  let folio = 0;
  let now = at('2026-11-10T10:00:00-06:00');

  const store = (batchSize?: number) =>
    new ChatbotSlaSweepStore(prisma as unknown as PrismaService, {
      clock: () => now,
      batchSize,
    });
  const sweeper = (batchSize?: number) =>
    new ChatbotSlaSweepScheduler(store(batchSize));

  const insertRequest = async (over: Row = {}) => {
    folio += 1;
    const created = await prisma.chatbotRequest.create({
      data: {
        tenantId,
        folio,
        kind: 'CLARIFICATION',
        subtype: 'UNKNOWN_QUESTION',
        customerKey: `5255${String(1000000 + folio)}`,
        summary: 'Pregunta',
        source: 'chatbot',
        sourceRequestId: randomUUID(),
        createdAt: '2026-11-10T16:00:00Z', // 10:00 Mexico City
        slaPolicyVersion: 0,
        // 50 % of the 30 claim minutes
        nextSlaCheckAt: '2026-11-10T16:15:00Z',
        ...over,
      },
      select: { id: true },
    });
    return created.id;
  };

  const seedSettings = (version: number, closedDates: string[] = []) =>
    prisma.chatbotAttentionSettings.create({
      data: {
        tenantId,
        version,
        timeZone: 'America/Mexico_City',
        days: defaultSettings().openingHours
          .days as unknown as Prisma.InputJsonArray,
        closedDates,
        slas: defaultSettings().slas as unknown as Prisma.InputJsonArray,
        windowWarningMinutes: 120,
        templateCostText: 'x',
        enabledSubtypes: [],
        receiptCloseMarginMinutes: 60,
        schedulingEnabled: false,
        slotMinutes: 30,
        slotsOffered: 3,
        maxScheduledPerSlot: 3,
      },
    });

  const events = (requestId?: string) =>
    prisma.chatbotRequestEvent.findMany({
      where: {
        tenantId,
        type: 'SLA_MILESTONE',
        ...(requestId ? { requestId } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
  const notices = () =>
    prisma.outboxEvent.findMany({
      where: { tenantId, eventType: 'chatbot_request.notify' },
    });
  const feed = (requestId?: string) =>
    prisma.chatbotFeedItem.findMany({
      where: {
        tenantId,
        type: 'request.overdue_notice',
        ...(requestId ? { requestId } : {}),
      },
    });
  const request = (id: string) =>
    prisma.chatbotRequest.findFirstOrThrow({ where: { tenantId, id } });

  beforeAll(async () => {
    tenantId = randomUUID();
    tenants.push(tenantId);
    await prisma.tenant.create({
      data: { id: tenantId, name: 'Sucursal SLA', slug: `sla-${tenantId}` },
    });
  });

  beforeEach(async () => {
    now = at('2026-11-10T10:00:00-06:00');
    // Test database, own tenant: start each case from no requests.
    await prisma.outboxEvent.deleteMany({ where: { tenantId } });
    await prisma.notification.deleteMany({ where: { tenantId } });
    await prisma.chatbotFeedItem.deleteMany({ where: { tenantId } });
    await prisma.chatbotRequest.updateMany({
      where: { tenantId },
      data: { nextSlaCheckAt: null },
    });
    await prisma.$executeRaw`ALTER TABLE "chatbot_requests" DISABLE TRIGGER "chatbot_requests_keep_forever"`;
    await prisma.$executeRaw`ALTER TABLE "chatbot_request_events" DISABLE TRIGGER "chatbot_request_events_append_only"`;
    try {
      await prisma.chatbotRequestEvent.deleteMany({ where: { tenantId } });
      await prisma.chatbotCustomerGroup.deleteMany({ where: { tenantId } });
      await prisma.chatbotRequest.deleteMany({ where: { tenantId } });
      await prisma.chatbotAttentionSettings.deleteMany({ where: { tenantId } });
    } finally {
      await prisma.$executeRaw`ALTER TABLE "chatbot_requests" ENABLE TRIGGER "chatbot_requests_keep_forever"`;
      await prisma.$executeRaw`ALTER TABLE "chatbot_request_events" ENABLE TRIGGER "chatbot_request_events_append_only"`;
    }
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
  });

  it('does nothing before the first milestone', async () => {
    const id = await insertRequest();
    now = at('2026-11-10T10:10:00-06:00');
    const summary = await sweeper().tick();
    expect(summary.rows).toBe(0);
    expect(await events(id)).toHaveLength(0);
  });

  it('50 %: one event, one claim-reminder notice, next check at 80 %', async () => {
    const id = await insertRequest();
    now = at('2026-11-10T10:15:00-06:00');
    await sweeper().tick();

    const recorded = await events(id);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].actorKind).toBe('SYSTEM');
    expect(recorded[0].data).toMatchObject({
      milestone: 'HALF',
      clock: 'CLAIM',
      notice: 'REQUEST_CLAIM_REMINDER',
    });
    const out = await notices();
    expect(out).toHaveLength(1);
    expect(out[0].payload).toMatchObject({
      type: 'REQUEST_CLAIM_REMINDER',
      requestId: id,
    });
    expect((await request(id)).nextSlaCheckAt?.toISOString()).toBe(
      '2026-11-10T16:24:00.000Z',
    );
    expect(await feed(id)).toHaveLength(0);

    // Re-running at the same instant (a replica, a retry) changes nothing.
    await sweeper().tick();
    expect(await events(id)).toHaveLength(1);
    expect(await notices()).toHaveLength(1);
  });

  it('each milestone once across a whole window, ending with overdue, overdueAt and ONE feed item', async () => {
    const id = await insertRequest();
    for (const t of [
      '2026-11-10T10:15:00-06:00',
      '2026-11-10T10:24:00-06:00',
      '2026-11-10T10:30:00-06:00',
      '2026-11-10T10:30:30-06:00',
      '2026-11-10T11:30:00-06:00',
    ]) {
      now = at(t);
      await sweeper().tick();
    }
    expect(
      (await events(id)).map(
        (e) => (e.data as { milestone: string }).milestone,
      ),
    ).toEqual(['HALF', 'ESCALATION', 'OVERDUE']);
    expect(
      (await notices()).map((n) => (n.payload as { type: string }).type).sort(),
    ).toEqual([
      'REQUEST_CLAIM_REMINDER',
      'REQUEST_ESCALATION',
      'REQUEST_OVERDUE',
    ]);
    const done = await request(id);
    expect(done.overdueAt?.toISOString()).toBe('2026-11-10T16:30:00.000Z');
    expect(done.nextSlaCheckAt).toBeNull();
    expect(done.version).toBe(1); // the sweep is not a staff command
    const items = await feed(id);
    expect(items).toHaveLength(1);
    expect(items[0].payload).toMatchObject({
      requestId: id,
      clock: 'CLAIM',
      subtype: 'UNKNOWN_QUESTION',
      assigned: false,
      overdueAt: '2026-11-10T16:30:00.000Z',
    });
    const group = await prisma.chatbotCustomerGroup.findFirst({
      where: { tenantId, customerKey: done.customerKey },
    });
    expect(group?.hasOverdue).toBe(true);
  });

  it('after downtime records every milestone but sends only the overdue notice', async () => {
    const id = await insertRequest();
    now = at('2026-11-10T12:00:00-06:00');
    await sweeper().tick();
    expect(await events(id)).toHaveLength(3);
    const out = await notices();
    expect(out).toHaveLength(1);
    expect(out[0].payload).toMatchObject({ type: 'REQUEST_OVERDUE' });
    expect(await feed(id)).toHaveLength(1);
  });

  it('a claimed request: 80 % and overdue name the assignee, no 50 % notice', async () => {
    const userId = randomUUID();
    await prisma.user.create({
      data: {
        id: userId,
        email: `sla-${userId}@t.test`,
        hashedPassword: 'x',
        name: 'Ana',
      },
    });
    try {
      const id = await insertRequest({
        status: 'IN_PROGRESS',
        assigneeUserId: userId,
        assigneeDisplayName: 'Ana',
        claimedAt: '2026-11-10T16:05:00Z',
        // 50 % of the 120 resolve minutes
        nextSlaCheckAt: '2026-11-10T17:00:00Z',
      });
      now = at('2026-11-10T11:00:00-06:00');
      await sweeper().tick();
      expect(await notices()).toHaveLength(0);
      expect(await events(id)).toHaveLength(1);

      now = at('2026-11-10T11:36:00-06:00');
      await sweeper().tick();
      const out = await notices();
      expect(out).toHaveLength(1);
      expect(out[0].payload).toMatchObject({
        type: 'REQUEST_ESCALATION',
        recipientUserId: userId,
      });
    } finally {
      await prisma.user.delete({ where: { id: userId } });
    }
  });

  it('skips closed requests (never selected, even on a stale version)', async () => {
    const id = await insertRequest({
      status: 'RESOLVED',
      nextSlaCheckAt: null,
      resolvedAt: '2026-11-10T16:05:00Z',
      closedAt: '2026-11-10T16:05:00Z',
      resolvedByActorId: 'u',
      resolvedByDisplayName: 'Ana',
      assigneeUserId: 'u',
      assigneeDisplayName: 'Ana',
      claimedAt: '2026-11-10T16:01:00Z',
      slaPolicyVersion: 0,
    });
    await seedSettings(5);
    now = at('2026-11-11T12:00:00-06:00');
    const summary = await sweeper().tick();
    expect(summary.rows).toBe(0);
    expect(await events(id)).toHaveLength(0);
  });

  it('is bounded: a batch never exceeds its size and a tick drains the rest', async () => {
    for (let i = 0; i < 25; i++) await insertRequest();
    now = at('2026-11-10T10:15:00-06:00');
    const first = await store(10).runBatch('due');
    expect(first.rows).toBe(10);
    expect(await events()).toHaveLength(10);
    const summary = await sweeper(10).tick();
    expect(summary.rows).toBe(15);
    expect(await events()).toHaveLength(25);
  });

  it('two concurrent sweeps never double-notify or double-feed', async () => {
    for (let i = 0; i < 250; i++) await insertRequest();
    now = at('2026-11-10T12:00:00-06:00'); // all three milestones are due
    const results = await Promise.all([
      sweeper().tick(),
      sweeper().tick(),
      sweeper().tick(),
    ]);
    expect(results.reduce((n, r) => n + r.rows, 0)).toBe(250);
    expect(await events()).toHaveLength(750);
    expect(await notices()).toHaveLength(250);
    expect(await feed()).toHaveLength(250);
    const dupes = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM (
        SELECT "requestId", "data" ->> 'milestone'
        FROM "chatbot_request_events"
        WHERE "tenantId" = ${tenantId} AND "type" = 'SLA_MILESTONE'
        GROUP BY 1, 2 HAVING count(*) > 1) d`;
    expect(Number(dupes[0].n)).toBe(0);
  });

  it('a purge of old notifications does not cause a re-notify', async () => {
    const userId = randomUUID();
    await prisma.user.create({
      data: {
        id: userId,
        email: `sla-${userId}@t.test`,
        hashedPassword: 'x',
        name: 'Ana',
      },
    });
    try {
      const id = await insertRequest();
      now = at('2026-11-10T10:15:00-06:00');
      await sweeper().tick();
      expect(await notices()).toHaveLength(1);
      // The notification the consumer would have created, 91 days old, then purged.
      await prisma.notification.create({
        data: {
          tenantId,
          userId,
          type: 'REQUEST_CLAIM_REMINDER',
          requestId: id,
          dedupKey: `sla:${id}:CLAIM:HALF:1`,
          createdAt: new Date(now.getTime() - 91 * 86_400_000),
        },
      });
      await prisma.notification.deleteMany({ where: { tenantId } });
      // A crash window / stale pointer: the row is due again for the same milestone.
      await prisma.chatbotRequest.update({
        where: { id },
        data: { nextSlaCheckAt: at('2026-11-10T10:15:00-06:00') },
      });
      await prisma.outboxEvent.deleteMany({ where: { tenantId } });
      await sweeper().tick();
      expect(await events(id)).toHaveLength(1);
      expect(await notices()).toHaveLength(0);
    } finally {
      await prisma.user.delete({ where: { id: userId } });
    }
  });

  it('reconciles a row on a stale policy version and then watches it with the new deadlines', async () => {
    const settings = [await seedSettings(3)];
    const id = await insertRequest({
      slaPolicyVersion: settings[0].version - 1,
      claimDeadlineAt: '2026-11-10T16:30:00Z',
      resolveDeadlineAt: '2026-11-10T18:00:00Z',
      nextSlaCheckAt: null, // a FAILED recompute left no check
    });
    now = at('2026-11-10T10:05:00-06:00');
    const summary = await sweeper().tick();
    expect(summary.recomputed).toBe(1);
    const row = await request(id);
    expect(row.slaPolicyVersion).toBe(settings[0].version);
    expect(row.nextSlaCheckAt).not.toBeNull();
    // A second pass finds nothing stale.
    expect((await sweeper().tick()).recomputed).toBe(0);
  });

  it('a row that fails is rolled back alone: the rest of the batch is processed and it is pushed out', async () => {
    const bad = await insertRequest();
    const good = await insertRequest();
    now = at('2026-11-10T10:15:00-06:00');
    const real = writer.enqueueNotice;
    jest
      .spyOn(writer, 'enqueueNotice')
      .mockImplementation((tx, tenant, notice) =>
        notice.requestId === bad
          ? Promise.reject(new Error('boom'))
          : real(tx, tenant, notice),
      );
    const summary = await sweeper().tick();
    expect(summary.failed).toBe(1);
    expect(await events(bad)).toHaveLength(0); // rolled back to its savepoint
    expect(await events(good)).toHaveLength(1);
    expect((await request(bad)).nextSlaCheckAt?.getTime()).toBeGreaterThan(
      now.getTime(),
    );
  });

  describe('customer feed item of the first overdue: only if it expired less than 24 h ago (L69)', () => {
    // claim deadline 10:30 -06:00; HALF and ESCALATION already recorded below
    const lateSweep = async (sinceDeadlineMs: number) => {
      const id = await insertRequest({
        nextSlaCheckAt: at('2026-11-10T10:24:00-06:00'),
      });
      now = new Date(
        at('2026-11-10T10:30:00-06:00').getTime() + sinceDeadlineMs,
      );
      await sweeper().tick();
      return id;
    };
    const overdueEvent = async (id: string) =>
      (await events(id)).find(
        (e) => (e.data as { milestone: string }).milestone === 'OVERDUE',
      );

    it('under 24 h: the bot is fed once and the event says SENT', async () => {
      const id = await lateSweep(24 * 3_600_000 - 1000);
      expect(await feed(id)).toHaveLength(1);
      expect((await overdueEvent(id))?.data).toMatchObject({
        customerNotice: 'SENT',
      });
    });

    it('24 h or more: no feed item, but overdueAt, the event and the staff notice remain', async () => {
      const id = await lateSweep(24 * 3_600_000);
      expect(await feed(id)).toHaveLength(0);
      const row = await request(id);
      expect(row.overdueAt?.toISOString()).toBe('2026-11-10T16:30:00.000Z');
      expect((await overdueEvent(id))?.data).toMatchObject({
        customerNotice: 'SKIPPED_STALE',
      });
      const out = await notices();
      expect(out).toHaveLength(1);
      expect(out[0].payload).toMatchObject({ type: 'REQUEST_OVERDUE' });
      // a later sweep does not feed the bot either
      await sweeper().tick();
      expect(await feed(id)).toHaveLength(0);
    });
  });

  describe('staff notices wait for the next opening (L69)', () => {
    const notBeforeOf = async () =>
      (await notices()).map((n) => n.nextAttemptAt.toISOString());
    const claimable = () =>
      prisma.outboxEvent.count({
        where: {
          tenantId,
          status: 'PENDING',
          eventType: 'chatbot_request.notify',
          nextAttemptAt: { lte: new Date() },
        },
      });

    it('inside business hours the notice is claimable at once', async () => {
      await insertRequest();
      now = at('2026-11-10T10:15:00-06:00');
      await sweeper().tick();
      expect(await notices()).toHaveLength(1);
      expect(await claimable()).toBe(1);
    });

    // Far-future dates, so "claimable" (DB clock) stays false whenever it runs:
    // Saturday 2030-01-05 is a Saturday; the Monday is 2030-01-07 (UTC-6, no DST).
    it('deadline exactly at the Saturday close: milestone now, notice on Monday 09:00', async () => {
      // created Saturday 18:30, claim 30 min → deadline 19:00 = the close
      const id = await insertRequest({
        createdAt: at('2030-01-05T18:30:00-06:00'),
        nextSlaCheckAt: at('2030-01-05T18:45:00-06:00'),
      });
      now = at('2030-01-05T19:00:05-06:00');
      await sweeper().tick();
      expect(await events(id)).toHaveLength(3); // recorded at once
      expect(await notBeforeOf()).toEqual(['2030-01-07T15:00:00.000Z']);
      expect(await claimable()).toBe(0);
      // the customer is not held back: the feed item is immediate
      expect(await feed(id)).toHaveLength(1);
      // a re-run (another replica) neither duplicates nor moves the release
      await sweeper().tick();
      expect(await notices()).toHaveLength(1);
      expect(await notBeforeOf()).toEqual(['2030-01-07T15:00:00.000Z']);
    });

    it('a closed date in between pushes the release to the next business day', async () => {
      await seedSettings(1, ['2030-01-07']);
      await insertRequest({
        createdAt: at('2030-01-05T18:30:00-06:00'),
        nextSlaCheckAt: at('2030-01-05T18:45:00-06:00'),
        slaPolicyVersion: 1,
      });
      now = at('2030-01-05T19:00:05-06:00');
      await sweeper().tick();
      expect(await notBeforeOf()).toEqual(['2030-01-08T15:00:00.000Z']);
    });

    it('downtime catch-up overnight: released at the next opening, not at 3 am', async () => {
      await insertRequest({
        createdAt: at('2030-01-01T10:00:00-06:00'),
        nextSlaCheckAt: at('2030-01-01T10:15:00-06:00'),
      });
      now = at('2030-01-02T03:00:00-06:00'); // Wednesday night, all milestones due
      await sweeper().tick();
      expect(await notBeforeOf()).toEqual(['2030-01-02T15:00:00.000Z']);
      expect(await claimable()).toBe(0);
    });
  });

  describe('performance with 5 000 open requests (§10.1: < 50 ms per tick)', () => {
    it('an idle tick (nothing due, nothing stale) is served by the sweep index and is fast', async () => {
      await prisma.chatbotRequest.createMany({
        data: Array.from({ length: 5000 }, (_, i) => ({
          tenantId,
          folio: 100001 + i,
          kind: 'CLARIFICATION' as const,
          subtype: 'UNKNOWN_QUESTION' as const,
          customerKey: `5255${2000001 + i}`,
          summary: 'p',
          source: 'chatbot',
          sourceRequestId: randomUUID(),
          createdAt: at('2026-11-10T10:00:00-06:00'),
          slaPolicyVersion: 0,
          nextSlaCheckAt: new Date(
            at('2026-12-24T10:00:00-06:00').getTime() + i * 1000,
          ),
        })),
      });
      now = at('2026-11-10T10:15:00-06:00');
      const runner = sweeper();
      await runner.tick(); // warm the plan and the connection
      const samples: number[] = [];
      for (let i = 0; i < 5; i++) {
        const started = process.hrtime.bigint();
        const summary = await runner.tick();
        samples.push(Number(process.hrtime.bigint() - started) / 1e6);
        expect(summary.rows).toBe(0);
      }
      const median = [...samples].sort((a, b) => a - b)[2];

      console.log(
        `[perf] sla sweep idle tick, 5000 open: median ${median.toFixed(1)} ms (${samples.map((n) => n.toFixed(1)).join(', ')})`,
      );
      expect(median).toBeLessThan(50);

      const plan = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Record<string, string>[]>`
          EXPLAIN SELECT r."id" FROM "chatbot_requests" r
          WHERE r."status" IN ('NEW', 'IN_PROGRESS')
            AND r."nextSlaCheckAt" <= '2026-11-10T16:15:00'::timestamp
          ORDER BY r."nextSlaCheckAt", r."id" LIMIT 100
          FOR UPDATE OF r SKIP LOCKED`;
        return rows.map((r) => r['QUERY PLAN']).join('\n');
      });
      expect(plan).toContain('chatbot_requests_sla_sweep_idx');
    });
  });
});
