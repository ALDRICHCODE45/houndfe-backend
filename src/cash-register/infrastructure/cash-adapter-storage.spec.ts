/**
 * cash-register-closing / S10 — characterization of storage primitives
 * (`cash-adapter-storage`): row locks, active-membership checks, session
 * ownership, ambient-transaction enforcement and tenant-scoped loads.
 *
 * Uses the shared in-memory transaction fixture — no database roundtrip.
 */
import type { CashCount, CashMovement, CashSession } from '@prisma/client';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import { CASH_APPLICATION_CODES } from '../application/cash-application.errors';
import { CASH_RULE_CODES } from '../domain';
import {
  assertActiveMember,
  assertSessionOwner,
  latestCount,
  loadSessionMovements,
  lockHandoverRow,
  lockRegisterRow,
  lockSessionRow,
  requireAmbientTransaction,
  requireSessionForLedger,
  requireSessionLocked,
  userName,
} from './cash-adapter-storage';
import {
  makeTenantHarness,
  seedActors,
  type Host,
} from './cash-adapter.test-support';

function harness() {
  const { host, tenantPrisma } = makeTenantHarness();
  return { host, tx: tenantPrisma.getClient() };
}

function seedUser(host: Host, id: string, isActive = true): void {
  host.db.users.push({
    id,
    name: `Name ${id}`,
    email: `${id}@example.test`,
    hashedPassword: 'x',
    isActive,
  });
}

function seedMembership(host: Host, userId: string): void {
  host.db.memberships.push({
    id: `m-${userId}`,
    userId,
    tenantId: host.tenantId,
    roleId: 'role-1',
  });
}

function sessionRow(overrides: Partial<CashSession> = {}): CashSession {
  return {
    id: 'session-1',
    tenantId: 'tenant-a',
    registerId: 'register-1',
    cashierUserId: 'u1',
    openingCents: 10000,
    status: 'OPEN',
    openedAt: new Date('2025-01-01T10:00:00.000Z'),
    frozenAt: null,
    submittedAt: null,
    closedAt: null,
    drawerReleasedAt: null,
    openingHandoverId: null,
    expectedJson: null,
    ...overrides,
  };
}

function movementRow(overrides: Partial<CashMovement> = {}): CashMovement {
  return {
    id: 'movement-1',
    tenantId: 'tenant-a',
    sessionId: 'session-1',
    kind: 'SALE_PAYMENT',
    deltaCents: 1000,
    method: 'CASH',
    channelKey: 'CASH',
    channelLabel: 'Efectivo',
    sourceType: 'PAYMENT',
    sourceId: 'payment-1',
    actorUserId: 'u1',
    reason: null,
    occurredAt: new Date('2025-01-01T11:00:00.000Z'),
    createdAt: new Date('2025-01-01T11:00:00.000Z'),
    ...overrides,
  };
}

function countRow(overrides: Partial<CashCount> = {}): CashCount {
  return {
    id: 'count-1',
    tenantId: 'tenant-a',
    sessionId: 'session-1',
    kind: 'DECLARATION',
    revision: 1,
    actorUserId: 'u1',
    linesJson: [],
    denominationsJson: null,
    notes: null,
    createdAt: new Date('2025-01-01T12:00:00.000Z'),
    ...overrides,
  };
}

function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(BusinessRuleViolationError);
  expect((caught as BusinessRuleViolationError).code).toBe(code);
}

describe('cash-adapter-storage — row locks', () => {
  it('Given a tenant row, when locking, then it is found while missing and cross-tenant rows fail closed', async () => {
    const { host, tx } = harness();
    host.db.registers.push({ id: 'register-1', tenantId: host.tenantId });
    await expect(
      lockRegisterRow(tx, host.tenantId, 'register-1'),
    ).resolves.toBe(true);
    await expect(lockRegisterRow(tx, host.tenantId, 'missing')).resolves.toBe(
      false,
    );
    await expect(lockRegisterRow(tx, 'tenant-b', 'register-1')).resolves.toBe(
      false,
    );
  });

  it('Given session and handover rows, when locking, then each table resolves independently', async () => {
    const { host, tx } = harness();
    host.db.sessions.push({ id: 'session-1', tenantId: host.tenantId });
    host.db.handovers.push({ id: 'handover-1', tenantId: host.tenantId });
    await expect(lockSessionRow(tx, host.tenantId, 'session-1')).resolves.toBe(
      true,
    );
    await expect(lockSessionRow(tx, host.tenantId, 'handover-1')).resolves.toBe(
      false,
    );
    await expect(
      lockHandoverRow(tx, host.tenantId, 'handover-1'),
    ).resolves.toBe(true);
  });
});

describe('cash-adapter-storage — requireSessionLocked', () => {
  it('Given a locked session row, when requiring it, then the row is returned', async () => {
    const { host, tx } = harness();
    host.db.sessions.push(sessionRow());
    await expect(
      requireSessionLocked(tx, host.tenantId, 'session-1'),
    ).resolves.toMatchObject({ id: 'session-1' });
  });

  it('Given no locked session row, when requiring it, then it fails closed', async () => {
    const { host, tx } = harness();
    await expect(
      requireSessionLocked(tx, host.tenantId, 'missing'),
    ).rejects.toMatchObject({
      code: CASH_APPLICATION_CODES.SESSION_NOT_FOUND,
    });
  });
});

describe('cash-adapter-storage — requireSessionForLedger', () => {
  it('Given an active owner with an OPEN session, when requiring for ledger, then it is returned', async () => {
    const { host, tx } = harness();
    seedActors(host, ['u1']);
    host.db.sessions.push(sessionRow());
    await expect(
      requireSessionForLedger(tx, host.tenantId, 'session-1', 'u1'),
    ).resolves.toMatchObject({ id: 'session-1' });
  });

  it('Given a non-owner, when requiring for ledger, then ownership fails closed', async () => {
    const { host, tx } = harness();
    seedActors(host, ['u1']);
    host.db.sessions.push(sessionRow({ cashierUserId: 'u2' }));
    await expect(
      requireSessionForLedger(tx, host.tenantId, 'session-1', 'u1'),
    ).rejects.toMatchObject({
      code: CASH_APPLICATION_CODES.SESSION_NOT_OWNED,
    });
  });

  it('Given a frozen session, when requiring for ledger, then writes are blocked', async () => {
    const { host, tx } = harness();
    seedActors(host, ['u1']);
    host.db.sessions.push(
      sessionRow({
        status: 'COUNTING',
        frozenAt: new Date('2025-01-01T11:00:00.000Z'),
      }),
    );
    await expect(
      requireSessionForLedger(tx, host.tenantId, 'session-1', 'u1'),
    ).rejects.toMatchObject({
      code: CASH_RULE_CODES.SESSION_NOT_WRITABLE,
    });
  });

  it('Given an inactive user, when requiring for ledger, then the actor is rejected', async () => {
    const { host, tx } = harness();
    seedUser(host, 'u1', false);
    seedMembership(host, 'u1');
    host.db.sessions.push(sessionRow());
    await expect(
      requireSessionForLedger(tx, host.tenantId, 'session-1', 'u1'),
    ).rejects.toMatchObject({
      code: CASH_APPLICATION_CODES.ACTOR_INACTIVE,
    });
  });

  it('Given a user without tenant membership, when requiring for ledger, then membership is required', async () => {
    const { host, tx } = harness();
    seedUser(host, 'u1');
    host.db.sessions.push(sessionRow());
    await expect(
      requireSessionForLedger(tx, host.tenantId, 'session-1', 'u1'),
    ).rejects.toMatchObject({
      code: CASH_APPLICATION_CODES.TENANT_MEMBERSHIP_REQUIRED,
    });
  });
});

describe('cash-adapter-storage — ambient transaction and membership', () => {
  it('Given no ambient transaction, when requiring one, then ledger writes are rejected', () => {
    expectCode(
      () => requireAmbientTransaction(false, 'recordPayments'),
      CASH_APPLICATION_CODES.LEDGER_OUTSIDE_TRANSACTION,
    );
    expect(() =>
      requireAmbientTransaction(true, 'recordPayments'),
    ).not.toThrow();
  });

  it('Given an active member, when asserting, then the user is returned', async () => {
    const { host, tx } = harness();
    seedUser(host, 'u1');
    seedMembership(host, 'u1');
    await expect(
      assertActiveMember(tx, host.tenantId, 'u1'),
    ).resolves.toMatchObject({ id: 'u1' });
  });

  it('Given an inactive user, when asserting membership, then it fails closed', async () => {
    const { host, tx } = harness();
    seedUser(host, 'u1', false);
    seedMembership(host, 'u1');
    await expect(
      assertActiveMember(tx, host.tenantId, 'u1'),
    ).rejects.toMatchObject({ code: CASH_APPLICATION_CODES.ACTOR_INACTIVE });
  });

  it('Given a user without membership, when asserting membership, then it fails closed', async () => {
    const { host, tx } = harness();
    seedUser(host, 'u1');
    await expect(
      assertActiveMember(tx, host.tenantId, 'u1'),
    ).rejects.toMatchObject({
      code: CASH_APPLICATION_CODES.TENANT_MEMBERSHIP_REQUIRED,
    });
  });

  it('Given a known user, when resolving the name, then the name or null is returned', async () => {
    const { host, tx } = harness();
    seedUser(host, 'u1');
    await expect(userName(tx, 'u1')).resolves.toBe('Name u1');
    await expect(userName(tx, 'missing')).resolves.toBeNull();
  });
});

describe('cash-adapter-storage — session owner and tenant-scoped loads', () => {
  it('Given the session owner, when asserting ownership, then it passes and another actor is rejected', () => {
    expect(() => assertSessionOwner(sessionRow(), 'u1')).not.toThrow();
    expectCode(
      () => assertSessionOwner(sessionRow(), 'u2'),
      CASH_APPLICATION_CODES.SESSION_NOT_OWNED,
    );
  });

  it('Given session movements, when loading, then they are ordered by occurrence and mapped', async () => {
    const { host, tx } = harness();
    host.db.movements.push(
      movementRow({
        id: 'movement-2',
        sourceId: 'payment-2',
        occurredAt: new Date('2025-01-01T12:00:00.000Z'),
      }),
      movementRow({
        id: 'movement-1',
        sourceId: 'payment-1',
        occurredAt: new Date('2025-01-01T11:00:00.000Z'),
      }),
    );
    const movements = await loadSessionMovements(
      tx,
      host.tenantId,
      'session-1',
    );
    expect(movements.map((entry) => entry.sourceId)).toEqual([
      'payment-1',
      'payment-2',
    ]);
    expect(movements[0]).toMatchObject({
      method: 'CASH',
      kind: 'SALE_PAYMENT',
      deltaCents: 1000,
    });
  });

  it('Given count revisions, when loading the latest, then the highest revision for the kind wins', async () => {
    const { host, tx } = harness();
    host.db.counts.push(
      countRow({ id: 'c1', revision: 1 }),
      countRow({ id: 'c2', revision: 2 }),
      countRow({ id: 'v9', kind: 'VERIFICATION', revision: 9 }),
    );
    await expect(
      latestCount(tx, host.tenantId, 'session-1', 'DECLARATION'),
    ).resolves.toMatchObject({ id: 'c2', revision: 2 });
    await expect(
      latestCount(tx, host.tenantId, 'session-1', 'VERIFICATION'),
    ).resolves.toMatchObject({ id: 'v9' });
    await expect(
      latestCount(tx, host.tenantId, 'missing', 'DECLARATION'),
    ).resolves.toBeNull();
  });
});
