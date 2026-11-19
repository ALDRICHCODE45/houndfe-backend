/**
 * human-intervention / unit 8 — what the realtime trigger adds to the write
 * paths that already existed (contract §10.1: "performance targets proven").
 *
 * Every request event insert fires the deferred constraint trigger
 * `chatbot_request_events_realtime` at commit: one per-tenant advisory lock, one
 * `realtime_events` insert and one `pg_notify` per announced event. This spec
 * measures the extra latency of representative writes WITH the trigger against
 * the SAME writes with the trigger disabled on the test database.
 *
 * OFF by default. Run it through the integration harness (it owns the test-DB
 * URL guard; nothing reads an env file, dev and production are unreachable):
 *
 *   PERF=1 pnpm test:integration src/realtime/realtime-trigger-cost.integration.spec.ts
 *
 * Method: modes alternate (ABAB…, `PERF_ROUNDS` rounds) so a drifting machine
 * hits both equally. The trigger is switched with `ALTER TABLE … DISABLE/ENABLE
 * TRIGGER` and COMMITTED (a transaction-scoped switch would hold an exclusive
 * lock and block the very writers being measured, which use other
 * connections); a `finally` and `afterAll` always restore it, and the spec
 * fails at the start if the trigger is not enabled. One real `LISTEN`
 * connection is open (as on a replica) with a no-op handler, so `NOTIFY` has a
 * listener but the hub does no work that would compete with the writers.
 *
 * Writes: `claim`, `claim`+`resolve` (a wrapped RESTOCK decision whose human
 * decision is already resolved, with the resolver port stubbed: its own cost
 * is not the trigger's), an SLA sweep
 * batch of 100 rows (100 `SLA_MILESTONE` events in ONE transaction), and 20
 * claims at once (across 20 tenants, and inside one tenant, where the
 * per-tenant commit lock serializes the tail of each transaction).
 * Knobs: PERF_ROUNDS (5), PERF_OPS (30 per round and mode). The report goes to
 * stdout and PERF_REPORT_PATH (default /tmp/realtime-trigger-cost-report.json).
 */
import { randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import { performance } from 'perf_hooks';
import type { PrismaService } from '../shared/prisma/prisma.service';
import { PgNotificationListener } from '../shared/realtime/pg-notification-listener';
import { REALTIME_CHANNEL } from '../shared/realtime/realtime-event-writes';
import { ChatbotSlaSweepStore } from '../chatbot-requests/infrastructure/chatbot-sla-sweep.store';
import {
  CASHIER,
  MANAGER,
  createStreamHarness,
  type StreamHarness,
} from './test-support/stream-harness';

const describeIfPerf =
  process.env.PERF === '1' &&
  process.env.SKIP_DB_INTEGRATION !== '1' &&
  process.env.DATABASE_URL
    ? describe
    : describe.skip;

const num = (name: string, fallback: number) =>
  Number(process.env[name] ?? fallback);
const ROUNDS = num('PERF_ROUNDS', 5);
const OPS = num('PERF_OPS', 30);
const REPORT_PATH =
  process.env.PERF_REPORT_PATH ?? '/tmp/realtime-trigger-cost-report.json';
const TRIGGER = 'chatbot_request_events_realtime';

type Mode = 'trigger' | 'baseline';
const MODES: Mode[] = ['baseline', 'trigger'];

const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const stats = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return {
    n: sorted.length,
    mean,
    p50: pct(sorted, 50),
    p95: pct(sorted, 95),
    max: sorted[sorted.length - 1],
  };
};
const fmt = (n: number) => n.toFixed(2);

type Samples = Record<Mode, number[]>;
const newSamples = (): Samples => ({ baseline: [], trigger: [] });
const report: Record<string, unknown> = {
  when: new Date().toISOString(),
  knobs: { ROUNDS, OPS },
  results: {} as Record<string, unknown>,
};
const record = (name: string, unit: string, samples: Samples) => {
  const base = stats(samples.baseline);
  const trig = stats(samples.trigger);
  const entry = {
    unit,
    baseline: base,
    trigger: trig,
    extra: {
      mean: trig.mean - base.mean,
      p50: trig.p50 - base.p50,
      p95: trig.p95 - base.p95,
    },
  };
  (report.results as Record<string, unknown>)[name] = entry;
  console.log(
    `[perf] ${name} (${unit}): baseline mean ${fmt(base.mean)} p50 ${fmt(base.p50)} p95 ${fmt(base.p95)} | trigger mean ${fmt(trig.mean)} p50 ${fmt(trig.p50)} p95 ${fmt(trig.p95)} | extra mean ${fmt(entry.extra.mean)} p50 ${fmt(entry.extra.p50)} p95 ${fmt(entry.extra.p95)} (n=${base.n}/${trig.n})`,
  );
};

describeIfPerf('realtime trigger cost on existing writes (PostgreSQL)', () => {
  let h: StreamHarness;
  let actorTenant: string;
  let actor: string;
  const spread: Array<{ tenantId: string; userId: string }> = [];
  let sweepTenant: string;
  let sweepFolio = 0;

  const setMode = async (mode: Mode) => {
    if (mode === 'trigger') {
      await h.prisma
        .$executeRaw`ALTER TABLE "chatbot_request_events" ENABLE TRIGGER "chatbot_request_events_realtime"`;
    } else {
      await h.prisma
        .$executeRaw`ALTER TABLE "chatbot_request_events" DISABLE TRIGGER "chatbot_request_events_realtime"`;
    }
  };
  const triggerState = async () => {
    const [row] = await h.prisma.$queryRaw<{ state: string }[]>`
      SELECT tgenabled::text AS state FROM pg_trigger
      WHERE tgname = ${TRIGGER} AND tgrelid = 'chatbot_request_events'::regclass`;
    return row?.state;
  };

  const timed = async (work: () => Promise<unknown>): Promise<number> => {
    const started = performance.now();
    await work();
    return performance.now() - started;
  };

  const claim = (tenantId: string, userId: string, requestId: string) =>
    h.command(tenantId, userId, requestId, 1, { kind: 'claim' });

  const resolve = (
    tenantId: string,
    userId: string,
    requestId: string,
    expectedVersion: number,
  ) =>
    h.cls.runWith({ tenantId, userId, isSuperAdmin: false }, () =>
      h.commands.execute({
        requestId,
        actorUserId: userId,
        actorCanReassign: true,
        actorCanResolveSubtype: () => true,
        idempotencyKey: randomUUID(),
        expectedVersion,
        command: {
          kind: 'resolve',
          action: { type: 'PROVIDE_RESTOCK_ESTIMATE', restockDays: 3 },
        },
      }),
    );

  /** A wrapped RESTOCK decision (its `humanDecision` row; the resolver is stubbed). */
  const seedDecision = async (tenantId: string) => {
    const decision = await h.prisma.humanDecision.create({
      data: {
        tenantId,
        source: 'chatbot',
        sourceRequestId: randomUUID(),
        canonicalRequestHash: 'hash',
        submittedCredentialId: 'cred',
        branchId: tenantId,
        productId: randomUUID(),
        productName: 'Croquetas',
        // The stubbed resolver writes nothing, so the answer the resolve
        // enqueues (R9) finds the decision already resolved.
        status: 'RESOLVED',
        version: 2,
        resolutionAction: 'PROVIDE_RESTOCK_ESTIMATE',
        resolutionRequestId: randomUUID(),
        restockDays: 3,
        resolvedAt: new Date(),
        resolvedByActorId: randomUUID(),
        resolvedByDisplayName: 'Persona',
      },
    });
    return h.seedRequest(tenantId, {
      kind: 'DECISION',
      subtype: 'RESTOCK',
      humanDecisionId: decision.id,
    });
  };

  beforeAll(async () => {
    h = await createStreamHarness();
    if ((await triggerState()) !== 'O') {
      throw new Error(
        `trigger ${TRIGGER} is not enabled before the run (state ${String(await triggerState())}); fix the test DB first`,
      );
    }
    // The replica's single LISTEN connection, with nothing to do on a NOTIFY.
    const listener = h.app.get(PgNotificationListener);
    listener.subscribe(REALTIME_CHANNEL, () => undefined);
    await listener.start();

    actorTenant = await h.seedTenant();
    actor = (await h.seedUser(actorTenant, MANAGER)).userId;
    for (let i = 0; i < 20; i += 1) {
      const tenantId = await h.seedTenant();
      spread.push({
        tenantId,
        userId: (await h.seedUser(tenantId, CASHIER)).userId,
      });
    }
    sweepTenant = await h.seedTenant();
  }, 180_000);

  afterAll(async () => {
    try {
      await h.prisma
        .$executeRaw`ALTER TABLE "chatbot_request_events" ENABLE TRIGGER "chatbot_request_events_realtime"`;
    } finally {
      await h.close();
      writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
      console.log(`[perf] report written to ${REPORT_PATH}`);
    }
  }, 120_000);

  it('claim, claim + resolve, sweep batch of 100, 20 concurrent claims', async () => {
    const claimMs = newSamples();
    const resolveMs = newSamples();
    const sweepMs = newSamples();
    const spreadWall = newSamples();
    const spreadEach = newSamples();
    const sameWall = newSamples();
    const sameEach = newSamples();
    const eventsWritten = { baseline: 0, trigger: 0 };

    const countEvents = async () => {
      const [row] = await h.prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM realtime_events`;
      return row.n;
    };

    try {
      for (let round = 0; round < ROUNDS; round += 1) {
        for (const mode of round % 2 === 0 ? MODES : [...MODES].reverse()) {
          await setMode(mode);
          const before = await countEvents();

          // 1 + 2: sequential claim, then resolve, on fresh requests.
          const ids: string[] = [];
          for (let i = 0; i < OPS; i += 1) {
            ids.push((await seedDecision(actorTenant)).id);
          }
          const versions: number[] = [];
          for (const id of ids) {
            let version = 0;
            claimMs[mode].push(
              await timed(async () => {
                version = (await claim(actorTenant, actor, id)).version;
              }),
            );
            versions.push(version);
          }
          for (const [i, id] of ids.entries()) {
            resolveMs[mode].push(
              await timed(() => resolve(actorTenant, actor, id, versions[i])),
            );
          }

          // 3: one sweep batch of 100 due rows (100 milestone events, 1 tx).
          const now = new Date('2026-11-10T16:15:00Z');
          await h.prisma.chatbotRequest.createMany({
            data: Array.from({ length: 100 }, () => {
              sweepFolio += 1;
              return {
                tenantId: sweepTenant,
                folio: 900_000 + sweepFolio,
                kind: 'CLARIFICATION' as const,
                subtype: 'UNKNOWN_QUESTION' as const,
                customerKey: `5255${String(2_000_000 + sweepFolio)}`,
                summary: 'Pregunta',
                source: 'chatbot',
                sourceRequestId: randomUUID(),
                createdAt: new Date('2026-11-10T16:00:00Z'),
                slaPolicyVersion: 0,
                nextSlaCheckAt: new Date('2026-11-10T16:15:00Z'),
              };
            }),
          });
          const sweep = new ChatbotSlaSweepStore(
            h.root as unknown as PrismaService,
            { clock: () => now, batchSize: 100 },
          );
          let swept = 0;
          sweepMs[mode].push(
            await timed(async () => {
              swept = (await sweep.runBatch('due')).milestones;
            }),
          );
          if (swept !== 100) {
            throw new Error(
              `sweep batch recorded ${swept} milestones, not 100`,
            );
          }

          // 4a: 20 claims at once, one per tenant.
          const perTenant = await Promise.all(
            spread.map(async (s) => ({
              ...s,
              id: (await seedDecision(s.tenantId)).id,
            })),
          );
          let started = performance.now();
          const each = await Promise.all(
            perTenant.map((s) =>
              timed(() => claim(s.tenantId, s.userId, s.id)),
            ),
          );
          spreadWall[mode].push(performance.now() - started);
          spreadEach[mode].push(...each);

          // 4b: 20 claims at once inside ONE tenant.
          const sameTenant = await Promise.all(
            Array.from({ length: 20 }, () => seedDecision(actorTenant)),
          );
          started = performance.now();
          const eachSame = await Promise.all(
            sameTenant.map((r) => timed(() => claim(actorTenant, actor, r.id))),
          );
          sameWall[mode].push(performance.now() - started);
          sameEach[mode].push(...eachSame);

          eventsWritten[mode] += (await countEvents()) - before;
        }
      }
    } finally {
      await setMode('trigger');
    }
    expect(await triggerState()).toBe('O');

    record('claim (sequential)', 'ms per command', claimMs);
    record('resolve (sequential, after claim)', 'ms per command', resolveMs);
    record('SLA sweep batch of 100 milestones', 'ms per batch', sweepMs);
    record(
      '20 concurrent claims, 20 tenants: wall time',
      'ms per burst',
      spreadWall,
    );
    record(
      '20 concurrent claims, 20 tenants: each claim',
      'ms per command',
      spreadEach,
    );
    record(
      '20 concurrent claims, one tenant: wall time',
      'ms per burst',
      sameWall,
    );
    record(
      '20 concurrent claims, one tenant: each claim',
      'ms per command',
      sameEach,
    );
    report.realtimeEventsWritten = eventsWritten;
    console.log(
      `[perf] realtime_events rows written: baseline ${eventsWritten.baseline}, trigger ${eventsWritten.trigger}`,
    );
    // The comparison is only meaningful if the trigger really fired (and only then).
    expect(eventsWritten.baseline).toBe(0);
    expect(eventsWritten.trigger).toBeGreaterThan(0);
  }, 600_000);
});
