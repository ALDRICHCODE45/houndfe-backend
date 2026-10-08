/**
 * cash-register-closing / G2 (S2, S4) — recipient custody discovery.
 *
 * A recipient must be able to find the handovers owed to them and the FLOAT
 * they have already received WITHOUT a broad session-audit grant. This spec
 * drives the PUBLIC `ICashApplication.query` facade (the same path the HTTP
 * controller uses) and pins:
 *
 *   - `read:CashHandover` is required; audit visibility is not a substitute
 *     and a missing grant denies instead of returning an empty page;
 *   - tenant + AUTHENTICATED recipient scope only — a caller-supplied
 *     recipient/tenant is impossible and other recipients' rows never leak;
 *   - conditional CASL grants are evaluated PER ROW before totals/pagination;
 *   - pending handovers and received eligible FLOAT are separate paginated
 *     collections;
 *   - a received FLOAT is eligible only while no tenant session already
 *     consumes it as its opening fund, and it stays discoverable even when its
 *     source drawer is still unreleased (same-register-only release rule —
 *     discovery is not a reservation);
 *   - only narrow custody identity/amounts/timestamps plus the source
 *     register/release state for FLOAT — never source-session expected totals
 *     or movements.
 *
 * Unit mocks over the shared in-memory fake do not prove PostgreSQL behavior.
 */
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import { randomUUID } from 'crypto';
import type {
  AppAbility,
  AppActions,
  AppSubjects,
} from '../../auth/authorization/domain/permission';
import type { CashActor } from '../cash-application.port';
import type { PrismaCashRegisterApplication } from './prisma-cash-register';
import {
  actor,
  asItems,
  asJson,
  makeApp,
  seedActors,
  type Host,
} from './prisma-cash-register.test-support';

const READ_CUSTODY = [['read', 'CashHandover']] as const;
const AUDIT_ONLY = [
  ['read', 'CashSessionAudit'],
  ['read', 'CashSession'],
] as const;

// ── Fixtures ────────────────────────────────────────────────────────────

const PAGE = { page: 1, limit: 25 };

/** A per-row conditional grant, mirroring how a role-composed rule is built. */
function conditionalActor(
  userId: string,
  action: AppActions,
  subject: AppSubjects,
  conditions: Record<string, unknown>,
): CashActor {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
  can(action, subject, conditions);
  return { userId, ability: build() };
}

/** A broad read with a per-row deny; CASL forbid rules take precedence. */
function denyPerRow(
  userId: string,
  conditions: Record<string, unknown>,
): CashActor {
  const { can, cannot, build } = new AbilityBuilder<AppAbility>(
    createMongoAbility,
  );
  can('read', 'CashHandover');
  cannot('read', 'CashHandover', conditions);
  return { userId, ability: build() };
}

function seedSession(host: Host, over: Record<string, unknown> = {}): string {
  const id = (over.id as string | undefined) ?? randomUUID();
  host.db.sessions.push({
    id,
    tenantId: host.tenantId,
    registerId: 'reg-src',
    cashierUserId: 'u1',
    openingCents: 1000,
    status: 'SUBMITTED',
    openedAt: new Date('2026-01-01T00:00:00Z'),
    frozenAt: new Date('2026-01-01T01:00:00Z'),
    submittedAt: new Date('2026-01-01T02:00:00Z'),
    closedAt: null,
    drawerReleasedAt: null,
    openingHandoverId: null,
    expectedJson: null,
    ...over,
  });
  return id;
}

function seedHandover(host: Host, over: Record<string, unknown> = {}): string {
  const id = (over.id as string | undefined) ?? randomUUID();
  const tenantId = (over.tenantId as string | undefined) ?? host.tenantId;
  const sourceSessionId =
    (over.sourceSessionId as string | undefined) ?? 's-src';
  // Keep the fixture FK-consistent: every handover has a real source session.
  if (!host.db.sessions.some((session) => session.id === sourceSessionId)) {
    seedSession(host, { id: sourceSessionId, tenantId });
  }
  host.db.handovers.push({
    id,
    tenantId,
    sourceSessionId,
    kind: 'FLOAT',
    recipientUserId: 'u2',
    createdByUserId: 'u1',
    declaredCents: 1000,
    receivedCents: null,
    receivedAt: null,
    receivedByUserId: null,
    notes: null,
    receiptNotes: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  });
  return id;
}

function custody(
  app: PrismaCashRegisterApplication,
  user: CashActor,
  page: { page: number; limit: number } = PAGE,
): Promise<Record<string, unknown>> {
  return app.query(user, { kind: 'CUSTODY', page }).then(asJson);
}

const pendingItems = (
  doc: Record<string, unknown>,
): Record<string, unknown>[] => asItems(asJson(doc.pendingHandovers).items);

const floatItems = (doc: Record<string, unknown>): Record<string, unknown>[] =>
  asItems(asJson(doc.eligibleFloat).items);

// ── Permission / scope denial ───────────────────────────────────────────

describe('cash custody discovery — authorization (S2, S4)', () => {
  it('denies discovery without read:CashHandover instead of a silent empty page', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1', 'u2']);
    seedHandover(host, { recipientUserId: 'u2' });

    await expect(custody(app, actor('u2', []))).rejects.toMatchObject({
      code: 'CASH_PERMISSION_DENIED',
    });
  });

  it('does not let read:CashSessionAudit substitute for the handover read', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1', 'u2']);
    seedHandover(host, { recipientUserId: 'u2' });

    await expect(custody(app, actor('u2', AUDIT_ONLY))).rejects.toMatchObject({
      code: 'CASH_PERMISSION_DENIED',
    });
  });

  it('lets a conditional per-row deny win over the broader read grant', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1', 'u2']);
    seedHandover(host, { id: 'h-withdrawal', kind: 'WITHDRAWAL' });
    seedHandover(host, { id: 'h-float', kind: 'FLOAT' });

    const doc = await custody(
      app,
      denyPerRow('u2', { handoverKind: 'WITHDRAWAL' }),
    );

    expect(pendingItems(doc).map((item) => item.id)).toEqual(['h-float']);
    expect(asJson(doc.pendingHandovers).total).toBe(1);
  });

  it('denies an inactive or non-member actor before reading any custody row', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u2']);
    host.db.users.push({ id: 'u-inactive', isActive: false });
    host.db.users.push({ id: 'u-nomember', isActive: true });
    seedHandover(host, { recipientUserId: 'u2' });

    await expect(
      custody(app, actor('u-inactive', READ_CUSTODY)),
    ).rejects.toMatchObject({ code: 'CASH_ACTOR_INACTIVE' });
    await expect(
      custody(app, actor('u-nomember', READ_CUSTODY)),
    ).rejects.toMatchObject({ code: 'CASH_TENANT_MEMBERSHIP_REQUIRED' });
  });

  it('scopes to the authenticated recipient and tenant only', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1', 'u2', 'u3']);
    seedHandover(host, { id: 'h-own', recipientUserId: 'u2' });
    seedHandover(host, { id: 'h-other', recipientUserId: 'u3' });
    seedHandover(host, { id: 'h-foreign', tenantId: 'tenant-b' });
    seedHandover(host, {
      id: 'h-own-float',
      recipientUserId: 'u2',
      kind: 'FLOAT',
      receivedCents: 1000,
      receivedAt: new Date('2026-01-02T00:00:00Z'),
      receivedByUserId: 'u2',
    });

    const doc = await custody(app, actor('u2', READ_CUSTODY));

    expect(pendingItems(doc).map((item) => item.id)).toEqual(['h-own']);
    expect(floatItems(doc).map((item) => item.id)).toEqual(['h-own-float']);
    expect(asJson(doc.pendingHandovers).total).toBe(1);
    expect(asJson(doc.eligibleFloat).total).toBe(1);
  });

  it('evaluates a conditional grant per row before totals and pagination', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1', 'u2']);
    seedHandover(host, { id: 'h-withdrawal', kind: 'WITHDRAWAL' });
    seedHandover(host, { id: 'h-float-pending', kind: 'FLOAT' });
    seedHandover(host, {
      id: 'h-float-received',
      kind: 'FLOAT',
      receivedCents: 1000,
      receivedAt: new Date('2026-01-02T00:00:00Z'),
      receivedByUserId: 'u2',
    });
    seedHandover(host, {
      id: 'h-withdrawal-received',
      kind: 'WITHDRAWAL',
      receivedCents: 1000,
      receivedAt: new Date('2026-01-02T00:00:00Z'),
      receivedByUserId: 'u2',
    });

    const floatOnly = conditionalActor('u2', 'read', 'CashHandover', {
      handoverKind: 'FLOAT',
    });
    const doc = await custody(app, floatOnly);

    expect(pendingItems(doc).map((item) => item.id)).toEqual([
      'h-float-pending',
    ]);
    expect(floatItems(doc).map((item) => item.id)).toEqual([
      'h-float-received',
    ]);
    expect(asJson(doc.pendingHandovers).total).toBe(1);
    expect(asJson(doc.eligibleFloat).total).toBe(1);
  });
});

// ── Pagination after scope ──────────────────────────────────────────────

describe('cash custody discovery — pagination after scope (S2)', () => {
  it('applies recipient scope and per-row visibility before the total and slice', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1', 'u2', 'u3']);
    seedHandover(host, {
      id: 'h-1',
      recipientUserId: 'u2',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    seedHandover(host, {
      id: 'h-2',
      recipientUserId: 'u2',
      createdAt: new Date('2026-01-02T00:00:00Z'),
    });
    seedHandover(host, {
      id: 'h-3',
      recipientUserId: 'u2',
      createdAt: new Date('2026-01-03T00:00:00Z'),
    });
    seedHandover(host, {
      id: 'h-other',
      recipientUserId: 'u3',
      createdAt: new Date('2026-01-00T00:00:00Z'),
    });

    const first = await custody(app, actor('u2', READ_CUSTODY), {
      page: 1,
      limit: 2,
    });
    expect(asJson(first.pendingHandovers).total).toBe(3);
    expect(pendingItems(first).map((item) => item.id)).toEqual(['h-1', 'h-2']);

    const second = await custody(app, actor('u2', READ_CUSTODY), {
      page: 2,
      limit: 2,
    });
    expect(asJson(second.pendingHandovers).total).toBe(3);
    expect(pendingItems(second).map((item) => item.id)).toEqual(['h-3']);
  });
});

// ── Pending vs received FLOAT eligibility ───────────────────────────────

describe('cash custody discovery — eligible FLOAT (S2)', () => {
  it('splits pending handovers from a received FLOAT', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1', 'u2']);
    seedHandover(host, { id: 'h-pending', kind: 'FLOAT' });
    seedHandover(host, {
      id: 'h-received',
      kind: 'FLOAT',
      receivedCents: 1000,
      receivedAt: new Date('2026-01-02T00:00:00Z'),
      receivedByUserId: 'u2',
    });

    const doc = await custody(app, actor('u2', READ_CUSTODY));

    expect(pendingItems(doc).map((item) => item.id)).toEqual(['h-pending']);
    expect(floatItems(doc).map((item) => item.id)).toEqual(['h-received']);
  });

  it('returns an eligible received FLOAT with narrow fields and source release state', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1', 'u2']);
    seedSession(host, {
      id: 's-src',
      registerId: 'reg-src',
      drawerReleasedAt: null,
    });
    const receivedAt = new Date('2026-01-02T00:00:00Z');
    seedHandover(host, {
      id: 'h-received',
      kind: 'FLOAT',
      recipientUserId: 'u2',
      createdByUserId: 'u1',
      declaredCents: 5000,
      receivedCents: 5000,
      receivedAt,
      receivedByUserId: 'u2',
      notes: 'fondo',
    });

    const doc = await custody(app, actor('u2', READ_CUSTODY));

    const items = floatItems(doc);
    expect(asJson(doc.eligibleFloat).total).toBe(1);
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0]).sort()).toEqual([
      'declaredAt',
      'declaredCents',
      'id',
      'kind',
      'receivedAt',
      'receivedCents',
      'receiverUserId',
      'senderUserId',
      'sessionId',
      'sourceDrawerReleasedAt',
      'sourceRegisterId',
    ]);
    expect(items[0]).toMatchObject({
      id: 'h-received',
      sessionId: 's-src',
      kind: 'FLOAT',
      declaredCents: 5000,
      receivedCents: 5000,
      senderUserId: 'u1',
      receiverUserId: 'u2',
      sourceRegisterId: 'reg-src',
      sourceDrawerReleasedAt: null,
    });
    expect(items[0].receivedAt).toBe(receivedAt.toISOString());
  });

  it('excludes a received FLOAT already consumed by any tenant session', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1', 'u2']);
    seedHandover(host, {
      id: 'h-consumed',
      kind: 'FLOAT',
      receivedCents: 1000,
      receivedAt: new Date('2026-01-02T00:00:00Z'),
      receivedByUserId: 'u2',
    });
    seedSession(host, {
      id: 's-next',
      openingHandoverId: 'h-consumed',
    });

    const doc = await custody(app, actor('u2', READ_CUSTODY));

    expect(floatItems(doc)).toEqual([]);
    expect(asJson(doc.eligibleFloat).total).toBe(0);
  });

  it('excludes a received FLOAT whose receipt amount is missing', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1', 'u2']);
    seedHandover(host, {
      id: 'h-missing-amount',
      kind: 'FLOAT',
      receivedCents: null,
      receivedAt: new Date('2026-01-02T00:00:00Z'),
      receivedByUserId: 'u2',
    });

    const doc = await custody(app, actor('u2', READ_CUSTODY));

    expect(floatItems(doc)).toEqual([]);
    expect(asJson(doc.eligibleFloat).total).toBe(0);
  });

  it('excludes a received FLOAT with an invalid received amount', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1', 'u2']);
    seedHandover(host, {
      id: 'h-invalid-amount',
      kind: 'FLOAT',
      receivedCents: -1,
      receivedAt: new Date('2026-01-02T00:00:00Z'),
      receivedByUserId: 'u2',
    });

    const doc = await custody(app, actor('u2', READ_CUSTODY));

    expect(floatItems(doc)).toEqual([]);
    expect(asJson(doc.eligibleFloat).total).toBe(0);
  });

  it('excludes a receipt that predates its declaration', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1', 'u2']);
    seedHandover(host, {
      id: 'h-before-declaration',
      kind: 'FLOAT',
      receivedCents: 1000,
      createdAt: new Date('2026-01-05T00:00:00Z'),
      receivedAt: new Date('2026-01-02T00:00:00Z'),
      receivedByUserId: 'u2',
    });

    const doc = await custody(app, actor('u2', READ_CUSTODY));

    expect(floatItems(doc)).toEqual([]);
    expect(asJson(doc.eligibleFloat).total).toBe(0);
  });

  it('keeps a valid received FLOAT whose amount differs from the declared one', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1', 'u2']);
    seedHandover(host, {
      id: 'h-differs',
      kind: 'FLOAT',
      declaredCents: 1000,
      receivedCents: 900,
      receivedAt: new Date('2026-01-02T00:00:00Z'),
      receivedByUserId: 'u2',
    });

    const doc = await custody(app, actor('u2', READ_CUSTODY));

    // The shared receipt policy requires an explicit amount, not amount
    // equality; the received amount is the authoritative opening fund.
    expect(floatItems(doc).map((item) => item.id)).toEqual(['h-differs']);
    expect(floatItems(doc)[0]).toMatchObject({
      declaredCents: 1000,
      receivedCents: 900,
    });
  });

  it('keeps a received FLOAT discoverable while its source drawer is unreleased', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1', 'u2']);
    // Same-register-only release rule: the source drawer is still open, so the
    // FLOAT cannot fund an opening on that register yet. Discovery must NOT
    // globally hide it — it reports the release state and leaves the decisive
    // OPEN check authoritative.
    seedSession(host, {
      id: 's-src-unreleased',
      registerId: 'reg-1',
      drawerReleasedAt: null,
    });
    seedHandover(host, {
      id: 'h-unreleased',
      sourceSessionId: 's-src-unreleased',
      kind: 'FLOAT',
      receivedCents: 1000,
      receivedAt: new Date('2026-01-02T00:00:00Z'),
      receivedByUserId: 'u2',
    });

    const doc = await custody(app, actor('u2', READ_CUSTODY));

    expect(floatItems(doc).map((item) => item.id)).toEqual(['h-unreleased']);
    expect(floatItems(doc)[0]).toMatchObject({
      sourceRegisterId: 'reg-1',
      sourceDrawerReleasedAt: null,
    });
  });

  it('never leaks source-session expected totals or movements', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1', 'u2']);
    seedSession(host, {
      id: 's-secret',
      expectedJson: {
        cashExpectedCents: 987654,
        frozenAt: new Date().toISOString(),
        channels: [
          {
            channelKey: 'CASH',
            channelLabel: 'Efectivo',
            method: 'CASH',
            expectedCents: 987654,
          },
        ],
      },
    });
    host.db.movements.push({
      id: 'm-secret',
      tenantId: host.tenantId,
      sessionId: 's-secret',
      kind: 'SALE_PAYMENT',
      deltaCents: 123456,
      method: 'CASH',
      channelKey: 'CASH',
      channelLabel: 'Efectivo',
      sourceType: 'PAYMENT',
      sourceId: 'sale-secret',
      actorUserId: 'u1',
      reason: null,
      occurredAt: new Date(),
      createdAt: new Date(),
    });
    seedHandover(host, {
      id: 'h-received',
      sourceSessionId: 's-secret',
      kind: 'FLOAT',
      receivedCents: 1000,
      receivedAt: new Date('2026-01-02T00:00:00Z'),
      receivedByUserId: 'u2',
    });

    const serialized = JSON.stringify(
      await custody(app, actor('u2', READ_CUSTODY)),
    );

    expect(serialized).not.toContain('expectedCents');
    expect(serialized).not.toContain('cashExpectedCents');
    expect(serialized).not.toContain('channelSnapshot');
    expect(serialized).not.toContain('differenceCents');
    expect(serialized).not.toContain('sale-secret');
  });
});

// ── Preserved existing behavior ─────────────────────────────────────────

describe('cash custody discovery — preserved receive flow and query dispatch (S4)', () => {
  it('reflects the authoritative receive flow and keeps other query kinds working', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1', 'u2']);
    const registerId = asJson(
      await app.execute(
        actor('u1'),
        { kind: 'CREATE_REGISTER', name: `Caja ${randomUUID()}` },
        randomUUID(),
      ),
    ).id as string;
    const sessionId = asJson(
      asJson(
        await app.execute(
          actor('u1'),
          {
            kind: 'OPEN_SESSION',
            registerId,
            openingCents: 1000,
            openingConfirmed: true,
          },
          randomUUID(),
        ),
      ).session,
    ).id as string;
    await app.execute(
      actor('u1'),
      { kind: 'START_COUNT', sessionId },
      randomUUID(),
    );
    await app.execute(
      actor('u1'),
      {
        kind: 'DECLARE',
        sessionId,
        lines: [{ channelKey: 'CASH', amountCents: 1000 }],
      },
      randomUUID(),
    );
    await app.execute(
      actor('u1'),
      {
        kind: 'CREATE_HANDOVER',
        sessionId,
        handoverKind: 'FLOAT',
        recipientUserId: 'u2',
        declaredCents: 1000,
      },
      randomUUID(),
    );
    const handoverId = host.db.handovers[0].id as string;

    const beforeReceipt = await custody(app, actor('u2', READ_CUSTODY));
    expect(pendingItems(beforeReceipt).map((item) => item.id)).toEqual([
      handoverId,
    ]);
    expect(floatItems(beforeReceipt)).toEqual([]);

    const received = asJson(
      await app.execute(
        actor('u2'),
        { kind: 'RECEIVE_HANDOVER', id: handoverId, receivedCents: 1000 },
        randomUUID(),
      ),
    );
    expect(received.receiptActorUserId).toBe('u2');

    const afterReceipt = await custody(app, actor('u2', READ_CUSTODY));
    expect(pendingItems(afterReceipt)).toEqual([]);
    expect(floatItems(afterReceipt).map((item) => item.id)).toEqual([
      handoverId,
    ]);

    // A different query kind still dispatches through the same facade.
    const registers = asJson(
      await app.query(actor('u1'), { kind: 'REGISTERS' }),
    );
    expect(asItems(registers.items)).toHaveLength(1);
  });
});
