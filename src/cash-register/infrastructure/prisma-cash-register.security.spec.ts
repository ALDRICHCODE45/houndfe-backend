/**
 * cash-register-closing / T3 — S3 authorization security corrections.
 *
 * Focused proof for the four independent-verifier blockers fixed in this
 * slice, all through the PUBLIC `ICashApplication`/`ICashLedger` ports:
 *
 *   1. Real CASL subject-INSTANCE authorization on every command AND on an
 *      exact-key replay (revocation wins), while the same lifecycle retry
 *      still replays.
 *   2. Every query kind requires an active user AND tenant membership.
 *   3. Conditional base/audit reads are evaluated PER ROW, with inaccessible
 *      rows excluded BEFORE pagination/count (no `canAbility(string)` bypass).
 *   4. The public ledger record methods independently take the SAME session
 *      row lock and require an active owner on an OPEN session.
 *   5. RELEASE_DRAWER is an outgoing-custody `create:CashHandover` duty.
 *
 * The harness is the shared in-memory fake (`.test-support.ts`); unit mocks
 * cannot prove a PostgreSQL race. The parent's isolated-DB proof is still
 * required for the lock ordering itself.
 */
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import { randomUUID } from 'crypto';
import type {
  AppAbility,
  AppActions,
  AppSubjects,
} from '../../auth/authorization/domain/permission';
import type { CashActor, CashQuery } from '../cash-application.port';
import {
  actor,
  asItems,
  asJson,
  makeApp,
  seedActors,
} from './prisma-cash-register.test-support';
import type { Host } from './prisma-cash-register.test-support';

// ── Conditional ability / seed helpers ─────────────────────────────────

interface ConditionalRule {
  action: AppActions;
  subject: AppSubjects;
  conditions?: Record<string, unknown>;
}

function conditionalActor(
  userId: string,
  rules: readonly ConditionalRule[],
): CashActor {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
  for (const rule of rules) {
    if (rule.conditions) {
      can(rule.action, rule.subject, rule.conditions);
    } else {
      can(rule.action, rule.subject);
    }
  }
  return { userId, ability: build() };
}

function expectedJson(cents: number): Record<string, unknown> {
  return {
    cashExpectedCents: cents,
    frozenAt: new Date().toISOString(),
    channels: [
      {
        channelKey: 'CASH',
        channelLabel: 'Efectivo',
        method: 'CASH',
        expectedCents: cents,
      },
    ],
  };
}

function seedRegister(host: Host, id: string, name?: string): void {
  host.db.registers.push({
    id,
    tenantId: host.tenantId,
    name: name ?? `Caja ${id}`,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

function seedSession(host: Host, overrides: Record<string, unknown>): void {
  host.db.sessions.push({
    id: randomUUID(),
    tenantId: host.tenantId,
    registerId: 'regA',
    cashierUserId: 'u1',
    status: 'OPEN',
    openingCents: 0,
    frozenAt: null,
    submittedAt: null,
    closedAt: null,
    drawerReleasedAt: null,
    openingHandoverId: null,
    expectedJson: null,
    openedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  });
}

function seedDeclaration(host: Host, sessionId: string, cents: number): void {
  host.db.counts.push({
    id: randomUUID(),
    tenantId: host.tenantId,
    sessionId,
    kind: 'DECLARATION',
    revision: 1,
    actorUserId: 'u1',
    linesJson: [{ channelKey: 'CASH', amountCents: cents }],
    denominationsJson: null,
    notes: null,
    createdAt: new Date(),
  });
}

function seedClosing(host: Host, overrides: Record<string, unknown>): string {
  const id = typeof overrides.id === 'string' ? overrides.id : randomUUID();
  host.db.closings.push({
    id,
    tenantId: host.tenantId,
    sessionId: 's1',
    folio: `CC-${randomUUID()}`,
    closedByUserId: 'u1',
    snapshotJson: { sessionId: overrides.sessionId ?? 's1' },
    createdAt: new Date(),
    ...overrides,
  });
  return id;
}

// ── 1. Command + replay instance authorization ──────────────────────────

describe('cash security — command instance authorization (S3,S8)', () => {
  function seedSubmittedSession(
    host: Host,
    id: string,
    registerId: string,
  ): void {
    seedRegister(host, registerId);
    seedSession(host, {
      id,
      registerId,
      cashierUserId: 'u1',
      status: 'SUBMITTED',
      submittedAt: new Date(),
      expectedJson: expectedJson(1000),
    });
    seedDeclaration(host, id, 1000);
  }

  it('denies a conditional VERIFY on registerB while allowing registerA', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1', 'u2']);
    seedSubmittedSession(host, 'sA', 'regA');
    seedSubmittedSession(host, 'sB', 'regB');
    const verifier = conditionalActor('u2', [
      {
        action: 'create',
        subject: 'CashVerification',
        conditions: { registerId: 'regA' },
      },
    ]);

    await expect(
      app.execute(
        verifier,
        {
          kind: 'VERIFY',
          sessionId: 'sB',
          lines: [{ channelKey: 'CASH', amountCents: 1000 }],
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'CASH_PERMISSION_DENIED' });
    expect(
      host.db.counts.filter((count) => count.kind === 'VERIFICATION'),
    ).toHaveLength(0);

    const verified = asJson(
      await app.execute(
        verifier,
        {
          kind: 'VERIFY',
          sessionId: 'sA',
          lines: [{ channelKey: 'CASH', amountCents: 1000 }],
        },
        randomUUID(),
      ),
    );
    expect(asJson(verified.verification).cashCents).toBe(1000);
  });

  it('denies an exact-key replay once the instance permission is revoked', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1', 'u2']);
    seedSubmittedSession(host, 'sA', 'regA');
    const key = randomUUID();
    const command = {
      kind: 'VERIFY' as const,
      sessionId: 'sA',
      lines: [{ channelKey: 'CASH', amountCents: 1000 }],
    };
    await app.execute(
      conditionalActor('u2', [
        {
          action: 'create',
          subject: 'CashVerification',
          conditions: { registerId: 'regA' },
        },
      ]),
      command,
      key,
    );

    const revoked = conditionalActor('u2', [
      {
        action: 'create',
        subject: 'CashVerification',
        conditions: { registerId: 'regB' },
      },
    ]);
    await expect(app.execute(revoked, command, key)).rejects.toMatchObject({
      code: 'CASH_PERMISSION_DENIED',
    });
    expect(
      host.db.counts.filter((count) => count.kind === 'VERIFICATION'),
    ).toHaveLength(1);
  });

  it('still replays the same key while the instance permission remains valid', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1', 'u2']);
    seedSubmittedSession(host, 'sA', 'regA');
    const key = randomUUID();
    const allowed = conditionalActor('u2', [
      {
        action: 'create',
        subject: 'CashVerification',
        conditions: { registerId: 'regA' },
      },
    ]);
    const command = {
      kind: 'VERIFY' as const,
      sessionId: 'sA',
      lines: [{ channelKey: 'CASH', amountCents: 1000 }],
    };
    const first = asJson(await app.execute(allowed, command, key));
    const replay = asJson(await app.execute(allowed, command, key));
    expect(replay).toEqual(first);
    expect(
      host.db.counts.filter((count) => count.kind === 'VERIFICATION'),
    ).toHaveLength(1);
  });
});

// ── 2. Active-member requirement on every query kind ────────────────────

describe('cash security — queries require active membership (S3)', () => {
  const QUERIES: readonly CashQuery[] = [
    { kind: 'REGISTERS' },
    { kind: 'SESSION', id: 'missing' },
    { kind: 'SESSIONS', page: {} },
    { kind: 'CLOSINGS', page: {} },
    { kind: 'CLOSING', id: 'missing' },
  ];

  it('rejects every query kind for an inactive user', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1']);
    host.db.users[0].isActive = false;
    for (const query of QUERIES) {
      await expect(app.query(actor('u1'), query)).rejects.toMatchObject({
        code: 'CASH_ACTOR_INACTIVE',
      });
    }
  });

  it('rejects every query kind without tenant membership', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1']);
    host.db.memberships = [];
    for (const query of QUERIES) {
      await expect(app.query(actor('u1'), query)).rejects.toMatchObject({
        code: 'CASH_TENANT_MEMBERSHIP_REQUIRED',
      });
    }
  });
});

// ── 3. Per-row conditional base/audit read filtering ────────────────────

describe('cash security — per-row conditional reads (S3)', () => {
  function seedTwoRegisters(host: Host): void {
    seedActors(host, ['u1', 'u3']);
    seedRegister(host, 'regA');
    seedRegister(host, 'regB');
    seedSession(host, {
      id: 'sA1',
      registerId: 'regA',
      cashierUserId: 'u1',
      openedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    seedSession(host, {
      id: 'sA2',
      registerId: 'regA',
      cashierUserId: 'u1',
      openedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    seedSession(host, {
      id: 'sB1',
      registerId: 'regB',
      cashierUserId: 'u1',
      openedAt: new Date('2026-01-03T00:00:00.000Z'),
    });
  }

  it('filters the register list by the conditional base read', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1']);
    seedRegister(host, 'regA');
    seedRegister(host, 'regB');
    const viewer = conditionalActor('u1', [
      {
        action: 'read',
        subject: 'CashRegister',
        conditions: { registerId: 'regA' },
      },
    ]);
    const list = asJson(await app.query(viewer, { kind: 'REGISTERS' }));
    expect(asItems(list.items).map((item) => item.id)).toEqual(['regA']);
  });

  it('excludes inaccessible session rows before pagination and total', async () => {
    const { app, host } = makeApp();
    seedTwoRegisters(host);
    const auditor = conditionalActor('u3', [
      { action: 'read', subject: 'CashSession' },
      {
        action: 'read',
        subject: 'CashSessionAudit',
        conditions: { registerId: 'regA' },
      },
    ]);
    const page1 = asJson(
      await app.query(auditor, { kind: 'SESSIONS', page: { limit: 1 } }),
    );
    expect(page1.total).toBe(2);
    expect(asItems(page1.items)).toHaveLength(1);
    const page2 = asJson(
      await app.query(auditor, {
        kind: 'SESSIONS',
        page: { page: 2, limit: 1 },
      }),
    );
    expect(page2.total).toBe(2);
    expect(asItems(page2.items)).toHaveLength(1);
    expect(asItems(page2.items)[0].registerId).toBe('regA');
  });

  it('denies an own session excluded by a conditional base read', async () => {
    const { app, host } = makeApp();
    seedTwoRegisters(host);
    const owner = conditionalActor('u1', [
      {
        action: 'read',
        subject: 'CashSession',
        conditions: { registerId: 'regA' },
      },
    ]);
    await expect(
      app.query(owner, { kind: 'SESSION', id: 'sB1' }),
    ).rejects.toMatchObject({ code: 'CASH_PERMISSION_DENIED' });
    expect(
      asJson(await app.query(owner, { kind: 'SESSION', id: 'sA1' })).session,
    ).toBeDefined();
  });

  it('excludes inaccessible closings before pagination and total', async () => {
    const { app, host } = makeApp();
    seedTwoRegisters(host);
    seedClosing(host, {
      sessionId: 'sA1',
      closedByUserId: 'u2',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    seedClosing(host, {
      sessionId: 'sA2',
      closedByUserId: 'u2',
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    seedClosing(host, {
      sessionId: 'sB1',
      closedByUserId: 'u2',
      createdAt: new Date('2026-01-03T00:00:00.000Z'),
    });
    const auditor = conditionalActor('u3', [
      { action: 'read', subject: 'CashClosing' },
      {
        action: 'read',
        subject: 'CashSessionAudit',
        conditions: { registerId: 'regA' },
      },
    ]);
    const page1 = asJson(
      await app.query(auditor, { kind: 'CLOSINGS', page: { limit: 1 } }),
    );
    expect(page1.total).toBe(2);
    expect(asItems(page1.items)).toHaveLength(1);
  });

  it('denies a closing detail outside the conditional audit instance', async () => {
    const { app, host } = makeApp();
    seedTwoRegisters(host);
    const allowed = seedClosing(host, {
      sessionId: 'sA1',
      closedByUserId: 'u2',
    });
    const denied = seedClosing(host, {
      sessionId: 'sB1',
      closedByUserId: 'u2',
    });
    const auditor = conditionalActor('u3', [
      { action: 'read', subject: 'CashClosing' },
      {
        action: 'read',
        subject: 'CashSessionAudit',
        conditions: { registerId: 'regA' },
      },
    ]);
    await expect(
      app.query(auditor, { kind: 'CLOSING', id: denied }),
    ).rejects.toMatchObject({ code: 'CASH_PERMISSION_DENIED' });
    expect(
      asJson(await app.query(auditor, { kind: 'CLOSING', id: allowed })).id,
    ).toBe(allowed);
  });
});

// ── 4. Ledger record methods lock + require an active owner ─────────────

describe('cash security — ledger record guards (S5,S8)', () => {
  function seedOpenSession(
    host: Host,
    overrides: Record<string, unknown> = {},
  ): void {
    seedRegister(host, 'regA');
    seedSession(host, {
      id: 's1',
      registerId: 'regA',
      cashierUserId: 'u1',
      status: 'OPEN',
      ...overrides,
    });
  }

  it('acquires the session row lock on a direct record with no assertOpenSession', async () => {
    const { app, host, tenantPrisma } = makeApp();
    seedActors(host, ['u1']);
    seedOpenSession(host);
    const client = tenantPrisma.getClient();
    const spy = jest.spyOn(client, '$queryRaw');
    await tenantPrisma.runInTransaction(() =>
      app.recordPayments({
        sessionId: 's1',
        actorId: 'u1',
        saleId: 'sale-1',
        payments: [{ paymentId: 'p1', method: 'cash', amountCents: 100 }],
        changeDueCents: 0,
        occurredAt: new Date(),
      }),
    );
    const sessionLocks = spy.mock.calls.filter(([arg]) => {
      const sql = JSON.stringify(arg);
      return sql.includes('cash_sessions') && sql.includes('FOR UPDATE');
    });
    expect(sessionLocks.length).toBeGreaterThan(0);
    spy.mockRestore();
  });

  it('denies a frozen session with no movement writes', async () => {
    const { app, host, tenantPrisma } = makeApp();
    seedActors(host, ['u1']);
    seedOpenSession(host, {
      status: 'COUNTING',
      frozenAt: new Date(),
    });
    await expect(
      tenantPrisma.runInTransaction(() =>
        app.recordPayments({
          sessionId: 's1',
          actorId: 'u1',
          saleId: 'sale-1',
          payments: [{ paymentId: 'p1', method: 'cash', amountCents: 100 }],
          changeDueCents: 0,
          occurredAt: new Date(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'CASH_SESSION_NOT_WRITABLE' });
    expect(host.db.movements).toHaveLength(0);
  });

  it('denies a non-member owner with no movement writes', async () => {
    const { app, host, tenantPrisma } = makeApp();
    host.db.users.push({
      id: 'ghost',
      name: 'Ghost',
      email: 'ghost@example.test',
      hashedPassword: 'x',
      isActive: true,
    });
    seedRegister(host, 'regA');
    seedSession(host, {
      id: 's1',
      registerId: 'regA',
      cashierUserId: 'ghost',
      status: 'OPEN',
    });
    await expect(
      tenantPrisma.runInTransaction(() =>
        app.recordPayments({
          sessionId: 's1',
          actorId: 'ghost',
          saleId: 'sale-1',
          payments: [{ paymentId: 'p1', method: 'cash', amountCents: 100 }],
          changeDueCents: 0,
          occurredAt: new Date(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'CASH_TENANT_MEMBERSHIP_REQUIRED' });
    expect(host.db.movements).toHaveLength(0);
  });

  it('denies an inactive owner refund with no movement writes', async () => {
    const { app, host, tenantPrisma } = makeApp();
    seedActors(host, ['u1']);
    host.db.users[0].isActive = false;
    seedOpenSession(host);
    await expect(
      tenantPrisma.runInTransaction(() =>
        app.recordRefund({
          sessionId: 's1',
          actorId: 'u1',
          settlementId: 'set-1',
          amountCents: 250,
          method: 'cash',
          occurredAt: new Date(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'CASH_ACTOR_INACTIVE' });
    expect(host.db.movements).toHaveLength(0);
  });
});

// ── 5. RELEASE_DRAWER is a create:CashHandover duty ─────────────────────

describe('cash security — release drawer custody permission (S3)', () => {
  function seedReleasable(host: Host): void {
    seedActors(host, ['owner']);
    seedRegister(host, 'regA');
    seedSession(host, {
      id: 's1',
      registerId: 'regA',
      cashierUserId: 'owner',
      status: 'SUBMITTED',
      submittedAt: new Date(),
    });
    host.db.counts.push({
      id: randomUUID(),
      tenantId: host.tenantId,
      sessionId: 's1',
      kind: 'DECLARATION',
      revision: 1,
      actorUserId: 'owner',
      linesJson: [{ channelKey: 'CASH', amountCents: 1000 }],
      denominationsJson: null,
      notes: null,
      createdAt: new Date(),
    });
    host.db.handovers.push({
      id: 'h1',
      tenantId: host.tenantId,
      sourceSessionId: 's1',
      kind: 'FLOAT',
      recipientUserId: 'owner',
      createdByUserId: 'owner',
      declaredCents: 1000,
      receivedCents: 1000,
      receivedAt: new Date(),
      receivedByUserId: 'owner',
      notes: null,
      receiptNotes: null,
      createdAt: new Date(),
    });
  }

  it('lets a create-only owner release an eligible drawer', async () => {
    const { app, host } = makeApp();
    seedReleasable(host);
    const releaser = conditionalActor('owner', [
      { action: 'create', subject: 'CashHandover' },
    ]);
    const result = asJson(
      await app.execute(
        releaser,
        { kind: 'RELEASE_DRAWER', sessionId: 's1' },
        randomUUID(),
      ),
    );
    expect(typeof result.drawerReleasedAt).toBe('string');
    expect(host.db.sessions[0].drawerReleasedAt).toBeInstanceOf(Date);
  });

  it('denies an update-only actor the release and leaves the drawer open', async () => {
    const { app, host } = makeApp();
    seedReleasable(host);
    const updater = conditionalActor('owner', [
      { action: 'update', subject: 'CashHandover' },
    ]);
    await expect(
      app.execute(
        updater,
        { kind: 'RELEASE_DRAWER', sessionId: 's1' },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'CASH_PERMISSION_DENIED' });
    expect(host.db.sessions[0].drawerReleasedAt).toBeNull();
  });
});
