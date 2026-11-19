/**
 * human-intervention / unit 8 — load test of the realtime stream against REAL
 * PostgreSQL (contract §10.1 "Cómo se demuestra" and the performance row
 * "Reparto SSE": < 1 s p95 from the commit to the browser, 200 connections per
 * replica, one `LISTEN` per replica, open connections hold no database
 * connection and read in batches when a notice arrives, indexes
 * `(tenantId, id)` and `(userId, id)`).
 *
 * OFF by default: it opens hundreds of sockets and seeds ~160 000 rows. Run it
 * through the project's integration harness (which owns the test-DB URL guard):
 *
 *   PERF=1 pnpm test:integration src/realtime/realtime-stream-load.integration.spec.ts
 *
 * Measures: (a) commit → client latency, one event at a time to N real HTTP
 * streams (every client in THIS process, so the numbers include the cost of
 * parsing every frame N times: pessimistic); (b) a burst of parallel commits;
 * (c) the idle cost of N open streams (queries, connections, CPU, heap);
 * (d) the replay and hub read at size with EXPLAIN (ANALYZE, BUFFERS) of the
 * real statements; (e) one retention-purge batch. The report goes to stdout and
 * to PERF_REPORT_PATH (default /tmp/realtime-sse-load-report.json). Targets are
 * reported, not asserted, unless PERF_ENFORCE=1.
 *
 * Knobs: PERF_STREAMS (200), PERF_EVENTS (100), PERF_BURST (20),
 * PERF_IDLE_MS (16000), PERF_REPLAY_ROWS (50000), PERF_NOISE_ROWS (100000).
 */
import { randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import { performance } from 'perf_hooks';
import { Prisma } from '@prisma/client';
import {
  PrismaRealtimeEventStore,
  readAfterSql,
  tenantHeadSql,
} from './infrastructure/prisma-realtime-event.store';
import { SseClient } from './test-support/sse-client';
import {
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
const STREAMS = num('PERF_STREAMS', 200);
const EVENTS = num('PERF_EVENTS', 100);
const BURST = num('PERF_BURST', 20);
const IDLE_MS = num('PERF_IDLE_MS', 16_000);
const REPLAY_ROWS = num('PERF_REPLAY_ROWS', 50_000);
const NOISE_ROWS = num('PERF_NOISE_ROWS', 100_000);
const ENFORCE = process.env.PERF_ENFORCE === '1';
const REPORT_PATH =
  process.env.PERF_REPORT_PATH ?? '/tmp/realtime-sse-load-report.json';

const report: Record<string, unknown> = {
  when: new Date().toISOString(),
  knobs: { STREAMS, EVENTS, BURST, IDLE_MS, REPLAY_ROWS, NOISE_ROWS },
  targets: [] as unknown[],
};
const target = (
  name: string,
  limit: string,
  measured: string,
  pass: boolean,
) => {
  (report.targets as unknown[]).push({ name, limit, measured, pass });
  console.log(
    `[perf] ${pass ? 'PASS' : 'MISS'} ${name}: ${measured} (limit ${limit})`,
  );
  if (ENFORCE) expect(pass).toBe(true);
};

const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const stats = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: pct(sorted, 50),
    p95: pct(sorted, 95),
    p99: pct(sorted, 99),
    max: sorted[sorted.length - 1],
  };
};
const fmt = (n: number) => n.toFixed(2);

/** `$n` placeholders to literals, so EXPLAIN plans what the app really ran. */
function literal(query: Prisma.Sql): string {
  return query.text.replace(/\$(\d+)/g, (_, index: string) => {
    const value = query.values[Number(index) - 1];
    if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
    if (value === null) return 'NULL';
    return typeof value === 'number' || typeof value === 'bigint'
      ? value.toString()
      : JSON.stringify(value);
  });
}

describeIfPerf('realtime stream load (PostgreSQL, real HTTP)', () => {
  let h: StreamHarness;
  const clients: SseClient[] = [];

  beforeAll(async () => {
    // The production access window: one check per user per second.
    h = await createStreamHarness({ accessCacheMs: 1000 });
  }, 120_000);

  afterAll(async () => {
    for (const client of clients) client.close();
    await h.close();
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(`[perf] report written to ${REPORT_PATH}`);
  }, 120_000);

  it(`(a, b, c) ${STREAMS} concurrent streams: latency, burst and idle cost`, async () => {
    const tenantId = await h.seedTenant();
    const permissions = await Promise.all(
      MANAGER.map(([subject, action]) =>
        h.prisma.permission.upsert({
          where: { subject_action: { subject, action } },
          update: {},
          create: { subject, action },
        }),
      ),
    );
    const role = await h.prisma.role.create({
      data: {
        tenantId,
        name: `perf-${randomUUID()}`,
        permissions: {
          create: permissions.map((p) => ({ permissionId: p.id })),
        },
      },
    });
    const userIds = Array.from({ length: STREAMS }, () => randomUUID());
    await h.prisma.user.createMany({
      data: userIds.map((id, i) => ({
        id,
        email: `${id}@perf.test`,
        hashedPassword: 'x',
        name: `Perf ${i}`,
      })),
    });
    await h.prisma.tenantMembership.createMany({
      data: userIds.map((userId) => ({ userId, tenantId, roleId: role.id })),
    });
    const actor = userIds[0];
    const requests: Array<{ id: string; customerKey: string }> = [];
    for (let i = 0; i < Math.max(BURST, 10); i += 1) {
      requests.push(await h.seedRequest(tenantId));
    }
    const versions = new Map(requests.map((r) => [r.id, 1]));

    // ------------------------------------------------ open N real streams
    const connectionsBefore = await activeConnections(h);
    const heapBefore = process.memoryUsage().heapUsed;
    const readSpy = jest.spyOn(PrismaRealtimeEventStore.prototype, 'readAfter');
    const openStarted = performance.now();
    // The first streams may open the replica's LISTEN connection and warm the
    // pool; what must not happen is a connection per additional stream.
    const warm = Math.min(20, STREAMS);
    let connectionsWarm = connectionsBefore;
    for (let i = 0; i < STREAMS; i += 1) {
      const client = new SseClient();
      clients.push(client);
      await client.open(
        h.baseUrl,
        '/realtime/stream',
        h.headers(tenantId, userIds[i]),
      );
      if (i + 1 === warm) {
        await Promise.all(
          clients.map((c) => c.waitForEvent('ready', 1, 30_000)),
        );
        connectionsWarm = await activeConnections(h);
      }
    }
    await Promise.all(clients.map((c) => c.waitForEvent('ready', 1, 30_000)));
    const openMs = performance.now() - openStarted;
    const connectionsOpen = await activeConnections(h);
    const heapPerStream =
      (process.memoryUsage().heapUsed - heapBefore) / STREAMS;
    console.log(
      `[perf] ${STREAMS} streams open in ${fmt(openMs)} ms, db connections ${connectionsBefore} -> ${connectionsWarm} (first ${warm} streams) -> ${connectionsOpen} (all)`,
    );
    expect(h.hub.openStreams).toBe(STREAMS);

    // --------------------------------------------- (a) commit -> client
    const claimed = new Set<string>();
    const nextCommand = (i: number) => {
      const request = requests[i % requests.length];
      const version = versions.get(request.id) as number;
      const isClaim = !claimed.has(request.id);
      if (isClaim) claimed.add(request.id);
      else claimed.delete(request.id);
      versions.set(request.id, version + 1);
      return { request, version, isClaim };
    };
    const latencies: number[] = [];
    const perEvent: number[] = [];
    for (let i = 0; i < EVENTS; i += 1) {
      const { request, version, isClaim } = nextCommand(i);
      const t0 = Date.now();
      await h.command(tenantId, actor, request.id, version, {
        kind: isClaim ? 'claim' : 'release',
      });
      const committed = Date.now() - t0;
      const want = i + 1;
      await Promise.all(
        clients.map((c) =>
          c.waitFor(
            (m) =>
              m.filter((x) => x.event.startsWith('request.')).length >= want,
            15_000,
            `event ${want}`,
          ),
        ),
      );
      let last = 0;
      for (const client of clients) {
        const frames = client.messages.filter((x) =>
          x.event.startsWith('request.'),
        );
        const latency = frames[i].receivedAt - t0;
        latencies.push(latency);
        last = Math.max(last, latency);
      }
      perEvent.push(last);
      if (i === 0)
        console.log(`[perf] first command committed in ${committed} ms`);
    }
    const a = stats(latencies);
    report.latency = { ...a, slowestPerEvent: stats(perEvent) };
    target(
      `commit -> client latency, ${STREAMS} streams (command start to frame parsed, includes the command itself)`,
      'p95 < 1000 ms',
      `p95 ${fmt(a.p95)} ms (p50 ${fmt(a.p50)}, p99 ${fmt(a.p99)}, max ${fmt(a.max)}, n=${a.n})`,
      a.p95 < 1000,
    );

    // ------------------------------------------------------ (b) burst
    const base = clients[0].messages.filter((x) =>
      x.event.startsWith('request.'),
    ).length;
    const burstStart = Date.now();
    await Promise.all(
      requests.slice(0, BURST).map((request) => {
        const version = versions.get(request.id) as number;
        const isClaim = !claimed.has(request.id);
        if (isClaim) claimed.add(request.id);
        else claimed.delete(request.id);
        versions.set(request.id, version + 1);
        return h.command(tenantId, actor, request.id, version, {
          kind: isClaim ? 'claim' : 'release',
        });
      }),
    );
    const burstCommitted = Date.now() - burstStart;
    await Promise.all(
      clients.map((c) =>
        c.waitFor(
          (m) =>
            m.filter((x) => x.event.startsWith('request.')).length >=
            base + Math.min(BURST, requests.length),
          30_000,
          'burst',
        ),
      ),
    );
    const burstMs = Date.now() - burstStart;
    const ids = clients.map((c) =>
      c.messages
        .filter((x) => x.event.startsWith('request.'))
        .map((x) => x.id)
        .join(','),
    );
    expect(new Set(ids).size).toBe(1); // every client saw the same events in the same order
    // When each client had its last frame of the burst, from the first commit.
    const completion = clients.map(
      (c) =>
        c.messages.filter((x) => x.event.startsWith('request.'))[
          base + Math.min(BURST, requests.length) - 1
        ].receivedAt - burstStart,
    );
    const firstFrame = clients.map(
      (c) =>
        c.messages.filter((x) => x.event.startsWith('request.'))[base]
          .receivedAt - burstStart,
    );
    report.burst = {
      commands: BURST,
      commitMs: burstCommitted,
      deliveredMs: burstMs,
      firstFrameFromFirstCommit: stats(firstFrame),
      lastFrameFromFirstCommit: stats(completion),
    };
    console.log(
      `[perf] burst: committed ${burstCommitted} ms; first frame p50 ${fmt(stats(firstFrame).p50)} ms; last frame p50 ${fmt(stats(completion).p50)} ms, max ${fmt(stats(completion).max)} ms`,
    );
    target(
      `burst of ${BURST} parallel commits delivered to ${STREAMS} streams`,
      'all delivered < 1000 ms after the last commit',
      `committed in ${burstCommitted} ms, all delivered after ${burstMs} ms`,
      burstMs - burstCommitted < 1000,
    );

    // ------------------------------------------------------- (c) idle
    readSpy.mockClear();
    const xactBefore = await transactions(h);
    const cpuBefore = process.cpuUsage();
    await new Promise((r) => setTimeout(r, IDLE_MS));
    const cpu = process.cpuUsage(cpuBefore);
    const xactAfter = await transactions(h);
    const idleReads = readSpy.mock.calls.length;
    const cpuMsPerSecond = (cpu.user + cpu.system) / 1000 / (IDLE_MS / 1000);
    // `heartbeat` frames are the only traffic: every stream got at least one.
    const beats = clients.map((c) => c.of('heartbeat').length);
    report.idle = {
      ms: IDLE_MS,
      hubReads: idleReads,
      dbTransactionsDuringIdle: xactAfter - xactBefore,
      cpuMsPerSecond,
      dbConnections: {
        before: connectionsBefore,
        afterFirstStreams: connectionsWarm,
        open: connectionsOpen,
      },
      heapBytesPerStream: heapPerStream,
      minHeartbeats: Math.min(...beats),
    };
    target(
      'idle streams cause no database reads',
      '0 hub reads while idle',
      `${idleReads} hub reads in ${IDLE_MS} ms with ${STREAMS} streams`,
      idleReads === 0,
    );
    target(
      'open streams hold no database connection (one LISTEN per replica)',
      `no new connection for the streams after the first ${warm}`,
      `${connectionsBefore} -> ${connectionsWarm} (first ${warm}) -> ${connectionsOpen} (${STREAMS}): +${connectionsOpen - connectionsWarm} for ${STREAMS - warm} more streams`,
      connectionsOpen - connectionsWarm <= 1,
    );
    target(
      'idle cost: CPU of the whole process with the streams open',
      '< 50 CPU ms per second (5 % of a core)',
      `${fmt(cpuMsPerSecond)} ms/s (includes ${STREAMS} heartbeats and the test client)`,
      cpuMsPerSecond < 50,
    );
    target(
      'every stream received heartbeats while idle',
      '>= 1 per 15 s',
      `min ${Math.min(...beats)} heartbeats in ${IDLE_MS} ms`,
      IDLE_MS < 15_000 || Math.min(...beats) >= 1,
    );
    console.log(
      `[perf] idle: ${fmt(cpuMsPerSecond)} cpu ms/s, ${idleReads} hub reads, heap ${(heapPerStream / 1024).toFixed(1)} KiB/stream, db transactions during idle ${xactAfter - xactBefore} (whole database, informational)`,
    );
    readSpy.mockRestore();
  }, 300_000);

  it('(d, e) replay, hub read and purge at size, with EXPLAIN (ANALYZE, BUFFERS)', async () => {
    const tenantId = await h.seedTenant();
    const noiseTenant = await h.seedTenant();
    const users = Array.from({ length: 100 }, () => randomUUID());
    const personal = Math.floor(REPLAY_ROWS / 5);
    // The measured tenant: mostly broadcast request events, a fifth personal
    // notices over 100 users. Noise: a big neighbour, interleaved by id.
    for (let slice = 0; slice < 10; slice += 1) {
      await h.prisma.$executeRaw`
        INSERT INTO realtime_events ("tenantId", "userId", "type", "requestId", "payload")
        SELECT ${tenantId}, NULL, 'request.updated', 'r-' || g, '{"version":2}'::jsonb
        FROM generate_series(1, ${Math.floor((REPLAY_ROWS - personal) / 10)}) g`;
      await h.prisma.$executeRaw`
        INSERT INTO realtime_events ("tenantId", "userId", "type", "payload")
        SELECT ${tenantId}, (${users}::text[])[1 + (g % 100)], 'notification.created', '{"notificationId":"n"}'::jsonb
        FROM generate_series(1, ${Math.floor(personal / 10)}) g`;
      await h.prisma.$executeRaw`
        INSERT INTO realtime_events ("tenantId", "userId", "type", "requestId", "payload")
        SELECT ${noiseTenant}, NULL, 'request.updated', 'x-' || g, '{"version":2}'::jsonb
        FROM generate_series(1, ${Math.floor(NOISE_ROWS / 10)}) g`;
    }
    await h.prisma.$executeRawUnsafe('ANALYZE realtime_events');
    const store = new PrismaRealtimeEventStore(h.prisma);
    const head = await store.tenantHead(tenantId);
    const user = users[7];

    const timeIt = async (label: string, fn: () => Promise<unknown>) => {
      await fn(); // warm
      const samples: number[] = [];
      for (let i = 0; i < 30; i += 1) {
        const t0 = performance.now();
        await fn();
        samples.push(performance.now() - t0);
      }
      const s = stats(samples);
      console.log(
        `[perf] ${label}: p50 ${fmt(s.p50)} ms, p95 ${fmt(s.p95)} ms, p99 ${fmt(s.p99)} ms`,
      );
      return s;
    };

    const shapes: Array<[string, bigint, string | null, number]> = [
      [
        'replay, reconnect after a short gap (200 events behind)',
        head - 200n,
        user,
        200,
      ],
      [
        'replay, after a long gap (5 000 events behind), first page',
        head - 5000n,
        user,
        200,
      ],
      ['replay, from the start of the retained log, first page', 0n, user, 200],
      ['hub read, tenant-wide, 50 new events', head - 50n, null, 500],
      ['hub read, nothing new (the common idle NOTIFY)', head, null, 500],
    ];
    const explains: Record<string, string> = {};
    const timings: Record<string, ReturnType<typeof stats>> = {};
    for (const [label, after, who, limit] of shapes) {
      timings[label] = await timeIt(label, () =>
        store.readAfter(tenantId, who, after, limit),
      );
      const plan = await h.prisma.$queryRawUnsafe<
        Array<{ 'QUERY PLAN': string }>
      >(
        `EXPLAIN (ANALYZE, BUFFERS) ${literal(readAfterSql(tenantId, who, after, limit))}`,
      );
      explains[label] = plan.map((row) => row['QUERY PLAN']).join('\n');
      const seq = /Seq Scan on realtime_events/.test(explains[label]);
      target(
        `index serves: ${label}`,
        'no Seq Scan on realtime_events',
        seq ? 'SEQ SCAN' : 'index scans only',
        !seq,
      );
    }
    timings['tenantHead'] = await timeIt('tenant head (max id)', () =>
      store.tenantHead(tenantId),
    );
    const headPlan = await h.prisma.$queryRawUnsafe<
      Array<{ 'QUERY PLAN': string }>
    >(`EXPLAIN (ANALYZE, BUFFERS) ${literal(tenantHeadSql(tenantId))}`);
    explains['tenant head'] = headPlan.map((r) => r['QUERY PLAN']).join('\n');

    const replay = timings[shapes[0][0]];
    target(
      'replay after a short gap at size',
      'p95 < 100 ms',
      `p95 ${fmt(replay.p95)} ms with ${REPLAY_ROWS} events in the tenant and ${NOISE_ROWS} in a neighbour`,
      replay.p95 < 100,
    );

    // ------------------------------------------- (e) one purge batch
    await h.prisma.$executeRaw`
      INSERT INTO realtime_events ("tenantId", "userId", "type", "payload", "createdAt")
      SELECT ${noiseTenant}, NULL, 'request.updated', '{}'::jsonb, now() - interval '30 hours'
      FROM generate_series(1, 3000)`;
    const purgeSamples: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const t0 = performance.now();
      const removed = await store.purgeExpired(new Date(), 1000);
      purgeSamples.push(performance.now() - t0);
      expect(removed).toBe(1000);
    }
    const purge = stats(purgeSamples);
    report.purge = { batch: 1000, ...purge };
    target(
      'retention purge, one batch of 1 000',
      'bounded, no long lock (< 500 ms)',
      `max ${fmt(purge.max)} ms (batches: ${purgeSamples.map(fmt).join(', ')})`,
      purge.max < 500,
    );

    report.queries = { timings, explains };
    for (const [label, plan] of Object.entries(explains)) {
      console.log(`\n[perf] EXPLAIN (ANALYZE, BUFFERS) ${label}\n${plan}`);
    }
  }, 300_000);
});

async function activeConnections(h: StreamHarness): Promise<number> {
  const [row] = await h.prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid()`;
  return row.n;
}

async function transactions(h: StreamHarness): Promise<number> {
  const [row] = await h.prisma.$queryRaw<Array<{ n: number }>>`
    SELECT (xact_commit + xact_rollback)::int AS n FROM pg_stat_database
    WHERE datname = current_database()`;
  return row.n;
}
