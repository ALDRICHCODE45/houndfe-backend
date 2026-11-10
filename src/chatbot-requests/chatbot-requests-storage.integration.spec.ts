/**
 * human-intervention / unit 2 — the chatbot_requests CHECKs and the open
 * dedup index reject invalid states on real PostgreSQL (migration applied by
 * the integration globalSetup).
 */
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

type Row = Record<string, string | number | boolean | null>;

describeIfDb('chatbot_requests constraints (PostgreSQL)', () => {
  const prisma = new PrismaClient();
  const tenantId = randomUUID();
  let folio = 0;

  // Table and column names are fixed test constants; the values travel as one
  // bound JSON parameter that PostgreSQL casts to the column types (enums).
  const insert = (table: string, row: Row) => {
    const columns = Object.keys(row)
      .map((c) => `"${c}"`)
      .join(', ');
    return prisma.$executeRawUnsafe(
      `INSERT INTO "${table}" (${columns})
       SELECT ${columns} FROM json_populate_record(NULL::"${table}", $1::json)`,
      JSON.stringify(row),
    );
  };
  const request = (over: Row = {}) =>
    insert('chatbot_requests', {
      id: randomUUID(),
      tenantId,
      folio: ++folio,
      kind: 'CLARIFICATION',
      subtype: 'UNKNOWN_QUESTION',
      customerKey: '525512345678',
      summary: '¿Sirve para cachorros?',
      source: 'chatbot',
      sourceRequestId: randomUUID(),
      updatedAt: '2026-11-10T16:00:00Z',
      ...over,
    });

  beforeAll(async () => {
    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: 'Solicitudes',
        slug: `chatbot-requests-${tenantId}`,
      },
    });
  });

  afterAll(async () => {
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.$disconnect();
  });

  it('accepts a valid open request', async () => {
    await expect(request()).resolves.toBe(1);
  });

  it.each([
    ['chatbot_requests_assignee_state_chk', { status: 'IN_PROGRESS' }],
    ['chatbot_requests_resolved_state_chk', { status: 'RESOLVED' }],
    ['chatbot_requests_closed_at_chk', { closedAt: '2026-11-10T16:00:00Z' }],
    [
      'chatbot_requests_wrapped_link_chk',
      { kind: 'DECISION', subtype: 'RESTOCK' },
    ],
    ['chatbot_requests_kind_subtype_chk', { kind: 'DECISION' }],
    [
      'chatbot_requests_staff_cancel_reason_chk',
      {
        status: 'CANCELLED',
        cancelledAt: '2026-11-10T16:00:00Z',
        closedAt: '2026-11-10T16:00:00Z',
        cancelReason: 'STAFF',
      },
    ],
    [
      'chatbot_requests_sla_sweep_open_chk',
      {
        status: 'CANCELLED',
        cancelledAt: '2026-11-10T16:00:00Z',
        closedAt: '2026-11-10T16:00:00Z',
        cancelReason: 'CUSTOMER_WITHDREW',
        nextSlaCheckAt: '2026-11-10T17:00:00Z',
      },
    ],
    [
      'chatbot_requests_whatsapp_window_chk',
      {
        lastCustomerMessageAt: '2026-11-10T16:00:00Z',
        whatsappWindowClosesAt: '2026-11-10T17:00:00Z',
      },
    ],
    [
      'chatbot_requests_scheduling_chk',
      { scheduledFor: '2026-11-11T15:00:00Z' },
    ],
  ] as const)('rejects a row that violates %s', async (constraint, over) => {
    await expect(request(over)).rejects.toThrow(constraint);
  });

  it('keeps one open request per customer and dedupKey, reusable once closed', async () => {
    const first = randomUUID();
    await request({ id: first, dedupKey: 'UNKNOWN_QUESTION:abc' });
    // Prisma reports the unique key, not the index name.
    await expect(request({ dedupKey: 'UNKNOWN_QUESTION:abc' })).rejects.toThrow(
      /\(\\?"tenantId\\?", \\?"customerKey\\?", \\?"dedupKey\\?"\)=.* already exists/,
    );
    await prisma.$executeRaw`UPDATE "chatbot_requests" SET "status" = 'RESOLVED', "resolvedAt" = now(), "closedAt" = now() WHERE "id" = ${first}`;
    await expect(request({ dedupKey: 'UNKNOWN_QUESTION:abc' })).resolves.toBe(
      1,
    );
  });

  it('rejects an empty customer group and a SYSTEM event with an actor', async () => {
    await expect(
      insert('chatbot_customer_groups', {
        tenantId,
        customerKey: '5255',
        openCount: 0,
        updatedAt: '2026-11-10T16:00:00Z',
      }),
    ).rejects.toThrow('chatbot_customer_groups_open_count_chk');
    const requestId = randomUUID();
    await request({ id: requestId });
    await expect(
      insert('chatbot_request_events', {
        id: randomUUID(),
        tenantId,
        requestId,
        type: 'SLA_MILESTONE',
        actorKind: 'SYSTEM',
        actorId: 'u-1',
        version: 1,
      }),
    ).rejects.toThrow('chatbot_request_events_actor_chk');
  });

  it('keeps the audit append-only and lets the tenant cascade remove it', async () => {
    const otherTenant = randomUUID();
    await prisma.tenant.create({
      data: {
        id: otherTenant,
        name: 'Auditoría',
        slug: `chatbot-audit-${otherTenant}`,
      },
    });
    const requestId = randomUUID();
    const eventId = randomUUID();
    await insert('chatbot_requests', {
      id: requestId,
      tenantId: otherTenant,
      folio: 1,
      kind: 'CLARIFICATION',
      subtype: 'UNKNOWN_QUESTION',
      customerKey: '525512345678',
      summary: 'Auditoría',
      source: 'chatbot',
      sourceRequestId: randomUUID(),
      updatedAt: '2026-11-10T16:00:00Z',
    });
    await insert('chatbot_request_events', {
      id: eventId,
      tenantId: otherTenant,
      requestId,
      type: 'CREATED',
      actorKind: 'SERVICE',
      actorId: 'svc-1',
      version: 1,
    });

    await expect(
      prisma.$executeRaw`UPDATE "chatbot_request_events" SET "version" = 2 WHERE "id" = ${eventId}`,
    ).rejects.toThrow(
      'chatbot_request_events is append-only (UPDATE rejected)',
    );
    await expect(
      prisma.$executeRaw`DELETE FROM "chatbot_request_events" WHERE "id" = ${eventId}`,
    ).rejects.toThrow(
      'chatbot_request_events is append-only (DELETE rejected)',
    );

    await prisma.tenant.delete({ where: { id: otherTenant } });
    const left = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM "chatbot_request_events" WHERE "id" = ${eventId}`;
    expect(Number(left[0].count)).toBe(0);
  });
});
