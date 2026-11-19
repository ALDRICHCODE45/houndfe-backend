/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- load-test harness: untyped query events and a printed report */
/**
 * human-intervention / unit 4 — load test of the staff reads against REAL
 * PostgreSQL (contract §10.1 "Cómo se demuestra"; performance row "Bandeja
 * agrupada por cliente": p95 < 200 ms per page of 25 groups, no GROUP BY at
 * read time, `ChatbotCustomerGroup` and its indexes; sized for 5 000 open
 * requests per tenant).
 *
 * OFF by default. Run it through the project's integration harness (it owns
 * the test-DB URL guard):
 *
 *   node scripts/perf/chatbot-inbox-load.cjs        # sets PERF=1 and runs
 *   PERF=1 pnpm test:integration src/chatbot-requests/chatbot-inbox-load.integration.spec.ts
 *
 * Seeds ONE tenant with 5 000 open requests over ~2 000 customers plus 20 000
 * closed ones, and two noise tenants (2 500 open + 10 000 closed each), then
 * measures the service (store + shaping + sealing) in a tenant context:
 * groups pages, a full walk of every page, filtered pages, counts, detail,
 * the customer list, history and the closed-tab groups (the only aggregate).
 * Captures EXPLAIN (ANALYZE, BUFFERS) of the real statements. The report goes
 * to stdout and to PERF_REPORT_PATH (default /tmp/chatbot-inbox-load-report.json).
 * Targets are reported, not asserted, unless PERF_ENFORCE=1.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { writeFileSync } from 'fs';
import { performance } from 'perf_hooks';
import { Prisma, PrismaClient } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import type { PrismaService } from '../shared/prisma/prisma.service';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../shared/tenant/tenant-cls-store.interface';
import { ChatbotRequestReadsService } from './application/chatbot-request-reads.service';
import { CustomerKeySealer } from './domain/customer-key-sealer';
import { PrismaChatbotRequestReadStore } from './infrastructure/prisma-chatbot-request-read.store';

const PERF =
  process.env.PERF === '1' &&
  Boolean(process.env.DATABASE_URL) &&
  process.env.SKIP_DB_INTEGRATION !== '1';
const describePerf = PERF ? describe : describe.skip;

const int = (name: string, fallback: number) =>
  process.env[name] ? Number(process.env[name]) : fallback;

const SIZE = {
  open: int('PERF_OPEN', 5_000),
  customers: int('PERF_CUSTOMERS', 2_000),
  closed: int('PERF_CLOSED', 20_000),
  noiseOpen: int('PERF_NOISE_OPEN', 2_500),
  noiseClosed: int('PERF_NOISE_CLOSED', 10_000),
  /** Customers per tenant: the first `2 × customers` own a phone (the requests' key). */
  tenantCustomers: int('PERF_TENANT_CUSTOMERS', 20_000),
  samples: int('PERF_SAMPLES', 200),
};
const TARGETS = { groupsPageP95Ms: 200 };

const round = (value: number) => Math.round(value * 100) / 100;
function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) =>
    sorted[
      Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
    ];
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min: round(sorted[0]),
    mean: round(sum / sorted.length),
    p50: round(at(50)),
    p95: round(at(95)),
    p99: round(at(99)),
    max: round(sorted[sorted.length - 1]),
  };
}

/** `$n` → a literal, so EXPLAIN plans the statement the app really ran. */
function inline(query: string, rawParams: string): string {
  const params: unknown[] = JSON.parse(rawParams);
  const literal = (value: unknown): string => {
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (value === null) return 'NULL';
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return `'${text.replace(/'/g, "''")}'`;
  };
  return query.replace(/\$(\d+)/g, (_m, n: string) =>
    literal(params[Number(n) - 1]),
  );
}

describePerf('chatbot inbox load test (PostgreSQL, PERF=1)', () => {
  jest.setTimeout(3_600_000);

  const adminPrisma = new PrismaClient();
  const cls = new ClsService<TenantClsStore>(
    new AsyncLocalStorage<TenantClsStore>(),
  );
  const readerPrisma = new PrismaClient({
    log: [{ emit: 'event', level: 'query' }],
  });
  const tenantPrisma = new TenantPrismaService(
    readerPrisma as unknown as PrismaService,
    cls,
  );
  const captured: Array<{ query: string; params: string }> = [];
  (readerPrisma as any).$on('query', (event: any) =>
    captured.push({ query: event.query, params: event.params }),
  );
  const sealer = new CustomerKeySealer('perf-secret-of-some-length');
  const reads = new ChatbotRequestReadsService(
    new PrismaChatbotRequestReadStore(tenantPrisma),
    sealer,
    () => new Date(),
  );
  const ME = 'perf-user-1';
  const reader = { userId: ME, ability: { can: () => false } };
  const phoneReader = {
    userId: ME,
    ability: {
      can: (action: string, subject: string) =>
        action === 'read' && subject === 'CustomerPhone',
    },
  };
  const inTenant = <T>(tenantId: string, work: () => Promise<T>) =>
    cls.runWith({ tenantId, userId: ME, isSuperAdmin: false }, work);

  const tenants: string[] = [];
  const report: Record<string, any> = {};
  const verdicts: Array<{
    target: string;
    limit: string;
    measured: string;
    pass: boolean;
  }> = [];
  let A = '';

  async function seed(tenantId: string, open: number, closed: number) {
    await adminPrisma.$executeRaw(Prisma.sql`
      INSERT INTO "chatbot_requests"
        ("id", "tenantId", "folio", "kind", "subtype", "status", "customerKey",
         "phoneCountryCode", "phone", "assigneeUserId", "assigneeDisplayName", "claimedAt",
         "claimDeadlineAt", "resolveDeadlineAt", "overdueAt",
         "lastCustomerMessageAt", "whatsappWindowClosesAt", "scheduledFor",
         "summary", "source", "sourceRequestId", "createdAt", "updatedAt")
      SELECT gen_random_uuid()::text, ${tenantId}, g,
        (CASE WHEN g % 3 = 0 THEN 'CLARIFICATION' ELSE 'CONVERSATION' END)::"ChatbotRequestKind",
        (CASE g % 3 WHEN 0 THEN 'UNKNOWN_QUESTION' WHEN 1 THEN 'TALK_TO_HUMAN' ELSE 'COMPLAINT' END)::"ChatbotRequestSubtype",
        (CASE WHEN g % 10 < 3 THEN 'IN_PROGRESS' ELSE 'NEW' END)::"ChatbotRequestStatus",
        '52' || '55' || lpad(c::text, 8, '0'), '52', '55' || lpad(c::text, 8, '0'),
        CASE WHEN g % 10 < 3 THEN 'perf-user-' || (g % 4 + 1) END,
        CASE WHEN g % 10 < 3 THEN 'Perf ' || (g % 4 + 1) END,
        CASE WHEN g % 10 < 3 THEN now() - interval '10 minutes' END,
        CASE WHEN g % 10 >= 3 AND g % 7 <> 0 THEN now() + ((g % 500) - 100) * interval '1 minute' END,
        CASE WHEN g % 10 < 3 AND g % 7 <> 0 THEN now() + ((g % 500) - 100) * interval '1 minute' END,
        CASE WHEN g % 10 = 0 THEN now() - interval '5 minutes' END,
        CASE WHEN g % 5 < 2 THEN now() - ((g % 24) * interval '1 hour') END,
        CASE WHEN g % 5 < 2 THEN now() + ((24 - g % 24) * interval '1 hour') END,
        CASE WHEN g % 3 <> 0 AND g % 20 = 0 THEN now() + interval '2 days' END,
        'Pregunta de prueba', 'perf', gen_random_uuid()::text,
        now() - ((${open}::int - g) * interval '3 minutes'), now()
      FROM (SELECT g, ((g * 7919) % ${SIZE.customers}::int) + 1 AS c
            FROM generate_series(1, ${open}::int) AS g) s`);
    await adminPrisma.$executeRaw(Prisma.sql`
      INSERT INTO "chatbot_requests"
        ("id", "tenantId", "folio", "kind", "subtype", "status", "customerKey",
         "phoneCountryCode", "phone", "resolvedByActorId", "resolvedByDisplayName",
         "resolvedAt", "cancelledAt", "cancelReason", "closedAt",
         "summary", "source", "sourceRequestId", "createdAt", "updatedAt")
      SELECT gen_random_uuid()::text, ${tenantId}, ${open}::int + g,
        (CASE WHEN g % 3 = 0 THEN 'CLARIFICATION' ELSE 'CONVERSATION' END)::"ChatbotRequestKind",
        (CASE g % 3 WHEN 0 THEN 'UNKNOWN_QUESTION' WHEN 1 THEN 'TALK_TO_HUMAN' ELSE 'COMPLAINT' END)::"ChatbotRequestSubtype",
        (CASE WHEN g % 2 = 0 THEN 'RESOLVED' ELSE 'CANCELLED' END)::"ChatbotRequestStatus",
        '5255' || lpad(c::text, 8, '0'), '52', '55' || lpad(c::text, 8, '0'),
        CASE WHEN g % 2 = 0 THEN 'perf-user-' || (g % 4 + 1) END,
        CASE WHEN g % 2 = 0 THEN 'Perf ' || (g % 4 + 1) END,
        CASE WHEN g % 2 = 0 THEN closed_at END,
        CASE WHEN g % 2 = 1 THEN closed_at END,
        (CASE WHEN g % 2 = 1 THEN 'CUSTOMER_WITHDREW' END)::"ChatbotRequestCancelReason",
        closed_at, 'Pregunta cerrada', 'perf', gen_random_uuid()::text,
        closed_at - interval '2 hours', closed_at
      FROM (SELECT g, ((g * 104729) % ${SIZE.customers * 2}::int) + 1 AS c,
                   now() - ((${closed}::int - g) * (interval '40 days' / ${closed}::int)) AS closed_at
            FROM generate_series(1, ${closed}::int) AS g) s`);
    // Customers with Spanish names (accents on purpose, for the `q` name
    // search); the first `2 × customers` own the phone the requests use, and
    // the requests are linked to them like the intake does (R1).
    await adminPrisma.$executeRaw(Prisma.sql`
      INSERT INTO "customers"
        ("id", "tenantId", "firstName", "lastName", "phoneCountryCode", "phone",
         "isTrusted", "createdAt", "updatedAt")
      SELECT gen_random_uuid()::text, ${tenantId},
        (ARRAY['María','José','Ángel','Lucía','Martín','Sofía','Andrés','Inés',
               'Raúl','Ximena','Jesús','Mónica','Héctor','Beatriz','Iván','Daniela'])[1 + g % 16],
        (ARRAY['García','Hernández','López','Martínez','González','Pérez','Rodríguez',
               'Sánchez','Ramírez','Cruz','Flores','Gómez','Díaz','Reyes','Muñoz',
               'Núñez'])[1 + (g / 7) % 16]
          || ' ' || (ARRAY['Torres','Vázquez','Jiménez','Ruiz','Mendoza','Aguilar',
               'Castillo','Ortiz'])[1 + (g / 3) % 8],
        CASE WHEN g <= ${SIZE.customers * 2}::int THEN '52' END,
        CASE WHEN g <= ${SIZE.customers * 2}::int THEN '55' || lpad(g::text, 8, '0') END,
        false, now(), now()
      FROM generate_series(1, ${SIZE.tenantCustomers}::int) AS g`);
    await adminPrisma.$executeRaw(Prisma.sql`
      UPDATE "chatbot_requests" r SET "customerId" = c."id"
      FROM "customers" c
      WHERE r."tenantId" = ${tenantId} AND c."tenantId" = ${tenantId}
        AND r."customerKey" = '52' || c."phone"`);
    // Same definition as `refreshCustomerGroup`, in one statement for the seed.
    await adminPrisma.$executeRaw(Prisma.sql`
      INSERT INTO "chatbot_customer_groups"
        ("tenantId", "customerKey", "mostUrgentAt", "openCount", "hasOverdue", "updatedAt")
      SELECT "tenantId", "customerKey",
             min(CASE WHEN "status" = 'NEW' THEN "claimDeadlineAt" ELSE "resolveDeadlineAt" END),
             count(*)::int, coalesce(bool_or("overdueAt" IS NOT NULL), false), now()
      FROM "chatbot_requests"
      WHERE "tenantId" = ${tenantId} AND "status" IN ('NEW', 'IN_PROGRESS')
      GROUP BY "tenantId", "customerKey"`);
  }

  beforeAll(async () => {
    for (const [label, open, closed] of [
      ['main', SIZE.open, SIZE.closed],
      ['noise-1', SIZE.noiseOpen, SIZE.noiseClosed],
      ['noise-2', SIZE.noiseOpen, SIZE.noiseClosed],
    ] as const) {
      const id = randomUUID();
      tenants.push(id);
      await adminPrisma.tenant.create({
        data: { id, name: `Perf ${label}`, slug: `perf-inbox-${id}` },
      });
      await seed(id, open, closed);
    }
    A = tenants[0];
    await adminPrisma.$executeRawUnsafe('ANALYZE "customers"');
    await adminPrisma.$executeRawUnsafe('ANALYZE "chatbot_requests"');
    await adminPrisma.$executeRawUnsafe('ANALYZE "chatbot_customer_groups"');
    await adminPrisma.$executeRawUnsafe('ANALYZE "chatbot_request_events"');
  });

  afterAll(async () => {
    await adminPrisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await adminPrisma.$disconnect();
    await readerPrisma.$disconnect();
  });

  async function time<T>(run: () => Promise<T>) {
    const started = performance.now();
    const value = await inTenant(A, run);
    return { ms: performance.now() - started, value };
  }

  async function sample(n: number, run: (i: number) => Promise<unknown>) {
    for (let i = 0; i < 5; i++) await time(() => run(i)); // warm-up
    const values: number[] = [];
    for (let i = 0; i < n; i++) values.push((await time(() => run(i))).ms);
    return stats(values);
  }

  async function explain(label: string, run: () => Promise<unknown>) {
    captured.length = 0;
    await inTenant(A, async () => {
      await run();
    });
    const statement = [...captured]
      .reverse()
      .find(
        (e) => /^\s*(SELECT|WITH)/i.test(e.query) && /chatbot_/.test(e.query),
      );
    if (!statement) throw new Error(`no statement captured for ${label}`);
    const sql = inline(statement.query, statement.params);
    let plan: string[] = [];
    for (let i = 0; i < 2; i++) {
      const rows = await adminPrisma.$queryRawUnsafe<
        Array<Record<string, string>>
      >(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`);
      plan = rows.map((row) => row['QUERY PLAN']);
    }
    return { sql: sql.replace(/\s+/g, ' '), plan };
  }

  it('measures the inbox reads and captures EXPLAIN (ANALYZE, BUFFERS)', async () => {
    report.sizes = SIZE;
    const read = (over: Record<string, unknown> = {}) =>
      reads.groups(reader, {
        tab: 'open',
        filters: {},
        limit: 25,
        ...over,
      } as never);

    // (a) groups: first page, a full walk of every page, filtered pages.
    report.groupsFirstPage = await sample(SIZE.samples, () => read());
    const walk: number[] = [];
    let cursor: string | undefined;
    let groupsSeen = 0;
    do {
      const { ms, value } = await time(() => read({ cursor }));
      walk.push(ms);
      groupsSeen += value.items.length;
      cursor = value.nextCursor ?? undefined;
    } while (cursor);
    report.groupsWalk = {
      ...stats(walk),
      pages: walk.length,
      groups: groupsSeen,
    };
    report.groupsFiltered = {
      assigneeMe: await sample(100, () =>
        read({ filters: { assignee: { kind: 'me' } } }),
      ),
      overdue: await sample(100, () => read({ filters: { overdue: true } })),
      subtype: await sample(100, () =>
        read({ filters: { subtype: 'TALK_TO_HUMAN' } }),
      ),
      scheduled: await sample(100, () => read({ tab: 'scheduled' })),
    };

    // (a2) q (§3.8): folio, name prefix / contains / two words, phone digits.
    const folios = await adminPrisma.$queryRaw<{ folio: number }[]>(Prisma.sql`
      SELECT "folio" FROM "chatbot_requests"
      WHERE "tenantId" = ${A} AND "status" IN ('NEW', 'IN_PROGRESS')
      ORDER BY "folio" LIMIT 500`);
    const search = (
      q: string,
      who: {
        userId: string;
        ability: { can: (action: string, subject: string) => boolean };
      } = reader,
    ) => reads.groups(who, { tab: 'open', filters: {}, limit: 25, q } as never);
    report.groupsSearch = {
      folio: await sample(100, (i) =>
        search(`S-${String(folios[i % folios.length].folio).padStart(6, '0')}`),
      ),
      namePrefix: await sample(100, () => search('mar')),
      nameContains: await sample(100, () => search('rtín')),
      nameTwoWords: await sample(100, () => search('lucia perez')),
      nameAccentFold: await sample(100, () => search('ANGEL gomez')),
      phoneFull: await sample(100, (i) =>
        search(`55${String((i % 1000) + 1).padStart(8, '0')}`, phoneReader),
      ),
      phoneSuffix: await sample(100, () => search('0042', phoneReader)),
      phoneNoPermission: await sample(100, () => search('5500000042')),
      miss: await sample(100, () => search('zzzzzz')),
    };
    report.groupsSearchHits = {
      folio: (await inTenant(A, () => search('S-000100'))).items.length,
      namePrefix: (await inTenant(A, () => search('mar'))).items.length,
      nameTwoWords: (await inTenant(A, () => search('lucia perez'))).items
        .length,
      phoneFull: (await inTenant(A, () => search('5500000042', phoneReader)))
        .items.length,
      phoneNoPermission: (await inTenant(A, () => search('5500000042'))).items
        .length,
    };

    // (b) counts, detail, customer list.
    report.counts = await sample(SIZE.samples, () => reads.counts(reader));
    const ids = await adminPrisma.$queryRaw<
      { id: string; customerKey: string }[]
    >(Prisma.sql`
        SELECT "id", "customerKey" FROM "chatbot_requests"
        WHERE "tenantId" = ${A} AND "status" IN ('NEW', 'IN_PROGRESS')
        ORDER BY "folio" LIMIT 500`);
    report.detail = await sample(SIZE.samples, (i) =>
      reads.detail(reader, ids[i % ids.length].id),
    );
    report.customerList = await sample(SIZE.samples, (i) =>
      reads.listByCustomer(reader, {
        customerKey: sealer.seal(A, ids[i % ids.length].customerKey),
        tab: 'open',
      }),
    );

    // (c) history (closed > 7 days ago), closed-tab groups (7-day aggregate).
    const hist = (over: Record<string, unknown> = {}) =>
      reads.history(reader, { limit: 25, ...over });
    report.historyFirstPage = await sample(SIZE.samples, () => hist());
    const page1 = await inTenant(A, () => hist());
    let deep = page1;
    for (let i = 0; i < 200 && deep.nextCursor; i++) {
      deep = await inTenant(A, () => hist({ cursor: deep.nextCursor }));
    }
    const deepCursor = deep.nextCursor;
    report.historyDeepPage = await sample(100, () =>
      hist({ cursor: deepCursor ?? undefined }),
    );
    report.historyBySubtype = await sample(100, () =>
      hist({ subtype: 'COMPLAINT' }),
    );
    report.historyByResolver = await sample(100, () =>
      hist({ resolvedBy: 'perf-user-2' }),
    );
    report.closedTabGroups = await sample(50, () => read({ tab: 'resolved' }));

    // (d) EXPLAIN (ANALYZE, BUFFERS) of the real statements.
    const plans: Record<string, { sql: string; plan: string[] }> = {};
    plans['groups: first page'] = await explain('groups', () => read());
    plans['groups: assignee=me'] = await explain('groups-me', () =>
      read({ filters: { assignee: { kind: 'me' } } }),
    );
    const mid = await inTenant(A, () => read({ limit: 25 }));
    const midCursor = (
      await inTenant(A, () => read({ cursor: mid.nextCursor ?? undefined }))
    ).nextCursor;
    plans['groups: second-page cursor'] = await explain('groups-next', () =>
      read({ cursor: mid.nextCursor ?? undefined }),
    );
    plans['groups: later-page cursor'] = await explain('groups-later', () =>
      read({ cursor: midCursor ?? undefined }),
    );
    plans['q: folio'] = await explain('q-folio', () => search('S-000100'));
    plans['q: name prefix'] = await explain('q-name', () => search('mar'));
    plans['q: name two words'] = await explain('q-name2', () =>
      search('lucia perez'),
    );
    plans['q: phone'] = await explain('q-phone', () =>
      search('5500000042', phoneReader),
    );
    plans['counts'] = await explain('counts', () => reads.counts(reader));
    plans['customer list'] = await explain('list', () =>
      reads.listByCustomer(reader, {
        customerKey: sealer.seal(A, ids[0].customerKey),
        tab: 'open',
      }),
    );
    plans['history: first page'] = await explain('history', () => hist());
    plans['history: deep page'] = await explain('history-deep', () =>
      hist({ cursor: deepCursor ?? undefined }),
    );
    plans['history: subtype'] = await explain('history-subtype', () =>
      hist({ subtype: 'COMPLAINT' }),
    );
    plans['closed-tab groups (resolved)'] = await explain('closed', () =>
      read({ tab: 'resolved' }),
    );
    report.explain = plans;

    // (e) verdicts.
    const firstPlan = plans['groups: first page'];
    const planText = firstPlan.plan.join('\n');
    const verdict = (
      target: string,
      limit: string,
      measured: string,
      pass: boolean,
    ) => verdicts.push({ target, limit, measured, pass });
    verdict(
      'groups page p95 (first page)',
      `< ${TARGETS.groupsPageP95Ms} ms`,
      `${report.groupsFirstPage.p95} ms`,
      report.groupsFirstPage.p95 < TARGETS.groupsPageP95Ms,
    );
    verdict(
      'groups page p95 (every page of a full walk)',
      `< ${TARGETS.groupsPageP95Ms} ms`,
      `${report.groupsWalk.p95} ms over ${report.groupsWalk.pages} pages`,
      report.groupsWalk.p95 < TARGETS.groupsPageP95Ms,
    );
    verdict(
      'no GROUP BY / aggregate node in the groups statement',
      'absent',
      /GROUP BY/i.test(firstPlan.sql) ||
        /(HashAggregate|GroupAggregate)/.test(planText)
        ? 'present'
        : 'absent',
      !/GROUP BY/i.test(firstPlan.sql) &&
        !/(HashAggregate|GroupAggregate)/.test(planText),
    );
    verdict(
      'groups read uses (tenantId, mostUrgentAt, customerKey)',
      'index scan',
      /chatbot_customer_groups_tenantId_mostUrgentAt_customerKey_idx/.test(
        planText,
      )
        ? 'yes'
        : 'no',
      /chatbot_customer_groups_tenantId_mostUrgentAt_customerKey_idx/.test(
        planText,
      ),
    );
    verdict(
      'rows read through (tenantId, customerKey, status)',
      'index scan',
      /chatbot_requests_tenantId_customerKey_status_idx/.test(planText)
        ? 'yes'
        : 'no',
      /chatbot_requests_tenantId_customerKey_status_idx/.test(planText),
    );
    verdict(
      'counts p95 / history first page p95 / detail p95',
      '< 200 ms (same bar)',
      `${report.counts.p95} / ${report.historyFirstPage.p95} / ${report.detail.p95} ms`,
      report.counts.p95 < 200 &&
        report.historyFirstPage.p95 < 200 &&
        report.detail.p95 < 200,
    );
    verdict(
      'history uses the partial history index, no Sort node',
      'index scan',
      /chatbot_requests_history_idx/.test(
        plans['history: first page'].plan.join('\n'),
      ) && !/\bSort\b/.test(plans['history: first page'].plan.join('\n'))
        ? 'yes'
        : 'no',
      /chatbot_requests_history_idx/.test(
        plans['history: first page'].plan.join('\n'),
      ) && !/\bSort\b/.test(plans['history: first page'].plan.join('\n')),
    );
    const slowestSearch = Math.max(
      ...Object.values(
        report.groupsSearch as Record<string, { p95: number }>,
      ).map((x) => x.p95),
    );
    verdict(
      'q search p95 (folio, name, phone, miss)',
      `< ${TARGETS.groupsPageP95Ms} ms`,
      `${slowestSearch} ms (slowest mode)`,
      slowestSearch < TARGETS.groupsPageP95Ms,
    );
    verdict(
      'q without read:CustomerPhone finds nothing by phone',
      '0 groups',
      `${report.groupsSearchHits.phoneNoPermission} groups`,
      report.groupsSearchHits.phoneNoPermission === 0 &&
        report.groupsSearchHits.phoneFull > 0,
    );
    report.verdicts = verdicts;

    const path =
      process.env.PERF_REPORT_PATH ?? '/tmp/chatbot-inbox-load-report.json';
    writeFileSync(path, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, explain: undefined }, null, 2));
    console.log(`full report with EXPLAIN plans: ${path}`);
    if (process.env.PERF_ENFORCE === '1') {
      expect(verdicts.filter((v) => !v.pass)).toEqual([]);
    }
  });
});
