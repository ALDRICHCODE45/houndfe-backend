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

  // Identifiers come from an allowlist (tables) and must be plain column
  // names; values travel as one bound JSON parameter that PostgreSQL casts to
  // the column types (enums, timestamps).
  const TABLES = new Set([
    'chatbot_requests',
    'chatbot_request_events',
    'chatbot_customer_groups',
  ]);
  const insert = (table: string, row: Row) => {
    const names = Object.keys(row);
    if (!TABLES.has(table) || !names.every((c) => /^[A-Za-z]+$/.test(c))) {
      throw new Error(`identifier not allowed: ${table}`);
    }
    const columns = names.map((c) => '"' + c + '"').join(', ');
    const statement =
      'INSERT INTO "' +
      table +
      '" (' +
      columns +
      ') SELECT ' +
      columns +
      ' FROM json_populate_record(NULL::"' +
      table +
      '", $1::json)';
    return prisma.$executeRawUnsafe(statement, JSON.stringify(row));
  };
  const SQL = {
    resolve:
      'UPDATE "chatbot_requests" SET "status" = \'RESOLVED\', "resolvedAt" = now(), "closedAt" = now() WHERE "id" = $1',
    updateEvent:
      'UPDATE "chatbot_request_events" SET "version" = 2 WHERE "id" = $1',
    deleteEvent: 'DELETE FROM "chatbot_request_events" WHERE "id" = $1',
    deleteRequest: 'DELETE FROM "chatbot_requests" WHERE "id" = $1',
    countRows:
      'SELECT (SELECT count(*) FROM "chatbot_requests" WHERE "id" = $1) AS requests, ' +
      '(SELECT count(*) FROM "chatbot_request_events" WHERE "id" = $2) AS events',
  } as const;
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
      { lastCustomerMessageAt: '2026-11-10T16:00:00Z' },
    ],
    [
      'chatbot_requests_assignee_claimed_at_chk',
      {
        status: 'CANCELLED',
        cancelledAt: '2026-11-10T16:00:00Z',
        closedAt: '2026-11-10T16:00:00Z',
        cancelReason: 'CUSTOMER_WITHDREW',
        assigneeUserId: 'u-ana',
        assigneeDisplayName: 'Ana',
      },
    ],
    [
      'chatbot_requests_ambiguous_customer_chk',
      { ambiguousCustomer: true, customerId: 'c-1' },
    ],
    [
      'chatbot_requests_scheduling_chk',
      { scheduledFor: '2026-11-11T15:00:00Z' },
    ],
  ] as const)('rejects a row that violates %s', async (constraint, over) => {
    await expect(request(over)).rejects.toThrow(constraint);
  });

  it('stores any WhatsApp window Meta reports, not only message + 24 h', async () => {
    await expect(
      request({
        lastCustomerMessageAt: '2026-11-10T16:00:00Z',
        whatsappWindowClosesAt: '2026-11-11T12:00:00Z',
      }),
    ).resolves.toBe(1);
  });

  it('keeps one open request per customer and dedupKey, reusable once closed', async () => {
    const first = randomUUID();
    await request({ id: first, dedupKey: 'UNKNOWN_QUESTION:abc' });
    // Prisma reports the unique key, not the index name.
    await expect(request({ dedupKey: 'UNKNOWN_QUESTION:abc' })).rejects.toThrow(
      /\(\\?"tenantId\\?", \\?"customerKey\\?", \\?"dedupKey\\?"\)=.* already exists/,
    );
    await prisma.$executeRawUnsafe(SQL.resolve, first);
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
    await expect(
      insert('chatbot_request_events', {
        id: randomUUID(),
        tenantId,
        requestId,
        type: 'CLAIMED',
        actorKind: 'USER',
        actorId: 'u-1',
        version: 2,
      }),
    ).rejects.toThrow('chatbot_request_events_actor_chk');
  });

  const countRows = async (requestId: string, eventId: string) => {
    const [row] = await prisma.$queryRawUnsafe<
      { requests: bigint; events: bigint }[]
    >(SQL.countRows, requestId, eventId);
    return [Number(row.requests), Number(row.events)];
  };

  it('keeps requests and their audit unless the tenant is deleted', async () => {
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
      prisma.$executeRawUnsafe(SQL.updateEvent, eventId),
    ).rejects.toThrow(
      'chatbot_request_events is append-only (UPDATE rejected)',
    );
    await expect(
      prisma.$executeRawUnsafe(SQL.deleteEvent, eventId),
    ).rejects.toThrow(
      'chatbot_request_events is append-only (DELETE rejected)',
    );

    await expect(
      prisma.$executeRawUnsafe(SQL.deleteRequest, requestId),
    ).rejects.toThrow(
      'chatbot_requests rows are kept forever (DELETE rejected)',
    );
    expect(await countRows(requestId, eventId)).toEqual([1, 1]);

    await prisma.tenant.delete({ where: { id: otherTenant } });
    expect(await countRows(requestId, eventId)).toEqual([0, 0]);
  });
});
