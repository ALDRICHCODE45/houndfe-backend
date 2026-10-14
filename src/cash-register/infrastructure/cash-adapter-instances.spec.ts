/**
 * cash-register-closing / S10 — characterization of CASL instance/replay
 * authorization (`cash-adapter-instances`).
 *
 * Permissions are rechecked against authoritative persisted rows (or the
 * server-owned prospective context); body-supplied actor fields are never
 * trusted. The shared transaction fixture supplies actors and fake rows.
 */
import type {
  CashClosing,
  CashHandover,
  CashRegister,
  CashSession,
} from '@prisma/client';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import { CASH_COMMAND_ABILITY } from '../application/cash-authorization';
import { CASH_APPLICATION_CODES } from '../application/cash-application.errors';
import type { CashCommand } from '../cash-application.port';
import {
  assertCommandAbility,
  closingInstance,
  handoverInstance,
  isClosingVisible,
  isSessionVisible,
  registerInstance,
  recheckReplayAbility,
  sessionInstance,
} from './cash-adapter-instances';
import {
  actor,
  makeTenantHarness,
  seedActors,
} from './cash-adapter.test-support';

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

function registerRow(overrides: Partial<CashRegister> = {}): CashRegister {
  return {
    id: 'register-1',
    tenantId: 'tenant-a',
    name: 'Register A',
    isActive: true,
    createdAt: new Date('2025-01-01T10:00:00.000Z'),
    updatedAt: new Date('2025-01-01T10:00:00.000Z'),
    ...overrides,
  };
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

function handoverRow(overrides: Partial<CashHandover> = {}): CashHandover {
  return {
    id: 'handover-1',
    tenantId: 'tenant-a',
    sourceSessionId: 'session-1',
    kind: 'WITHDRAWAL',
    recipientUserId: 'u2',
    createdByUserId: 'u1',
    declaredCents: 5000,
    receivedCents: null,
    notes: null,
    receiptNotes: null,
    receivedAt: null,
    receivedByUserId: null,
    createdAt: new Date('2025-01-01T12:30:00.000Z'),
    ...overrides,
  };
}

function closingRow(overrides: Partial<CashClosing> = {}): CashClosing {
  return {
    id: 'closing-1',
    tenantId: 'tenant-a',
    sessionId: 'session-1',
    folio: 'CC-1',
    closedByUserId: 'u2',
    snapshotJson: {},
    createdAt: new Date('2025-01-01T14:00:00.000Z'),
    ...overrides,
  };
}

describe('cash-adapter-instances — instance builders', () => {
  it('Given a register row, when tagging, then tenant and owner context are exposed', () => {
    expect(registerInstance(registerRow())).toEqual({
      tenantId: 'tenant-a',
      registerId: 'register-1',
      id: 'register-1',
      name: 'Register A',
      isActive: true,
    });
  });

  it('Given a session row, when tagging, then the cashier is aliased as owner', () => {
    expect(sessionInstance(sessionRow())).toEqual({
      tenantId: 'tenant-a',
      sessionId: 'session-1',
      id: 'session-1',
      registerId: 'register-1',
      cashierUserId: 'u1',
      ownerUserId: 'u1',
      status: 'OPEN',
    });
  });

  it('Given a handover row, when tagging, then sender and recipient are explicit', () => {
    expect(handoverInstance(handoverRow())).toEqual({
      tenantId: 'tenant-a',
      handoverId: 'handover-1',
      id: 'handover-1',
      sessionId: 'session-1',
      senderUserId: 'u1',
      recipientUserId: 'u2',
      handoverKind: 'WITHDRAWAL',
    });
  });

  it('Given a closing row, when tagging, then the owning session is merged when present', () => {
    expect(closingInstance(closingRow(), sessionRow())).toEqual({
      tenantId: 'tenant-a',
      closingId: 'closing-1',
      id: 'closing-1',
      sessionId: 'session-1',
      registerId: 'register-1',
      cashierUserId: 'u1',
      closedByUserId: 'u2',
    });
    expect(closingInstance(closingRow(), null)).toMatchObject({
      registerId: null,
      cashierUserId: null,
    });
  });
});

describe('cash-adapter-instances — command ability recheck', () => {
  it('Given the coarse capability, when rechecking a command, then it passes', () => {
    expect(() =>
      assertCommandAbility(actor('u1'), 'CREATE_REGISTER', {
        tenantId: 'tenant-a',
      }),
    ).not.toThrow();
  });

  it('Given a missing coarse capability, when rechecking a command, then it fails closed', () => {
    expectCode(
      () =>
        assertCommandAbility(
          actor('u1', [['read', 'CashRegister']]),
          'CREATE_REGISTER',
          {
            tenantId: 'tenant-a',
          },
        ),
      CASH_APPLICATION_CODES.PERMISSION_DENIED,
    );
  });

  it('Given the command vocabulary, when inspected, then it matches the guard subjects', () => {
    expect(CASH_COMMAND_ABILITY.CREATE_REGISTER).toEqual({
      action: 'create',
      subject: 'CashRegister',
    });
    expect(CASH_COMMAND_ABILITY.RECEIVE_HANDOVER).toEqual({
      action: 'update',
      subject: 'CashHandover',
    });
    expect(CASH_COMMAND_ABILITY.RELEASE_DRAWER).toEqual({
      action: 'create',
      subject: 'CashHandover',
    });
  });
});

describe('cash-adapter-instances — per-row visibility', () => {
  it('Given the owning cashier with base read, when checking a session, then the row is visible', () => {
    expect(
      isSessionVisible(actor('u1', [['read', 'CashSession']]), sessionRow()),
    ).toBe(true);
  });

  it('Given a non-owner without audit, when checking a session, then the row is hidden', () => {
    expect(
      isSessionVisible(actor('u2', [['read', 'CashSession']]), sessionRow()),
    ).toBe(false);
  });

  it('Given a non-owner with audit, when checking a session, then the row is visible', () => {
    expect(
      isSessionVisible(
        actor('u2', [['read', 'CashSessionAudit']]),
        sessionRow(),
      ),
    ).toBe(true);
  });

  it('Given the closer with base read, when checking a closing, then the row is visible', () => {
    expect(
      isClosingVisible(
        actor('u2', [['read', 'CashClosing']]),
        closingRow(),
        sessionRow(),
      ),
    ).toBe(true);
  });

  it('Given the session cashier with base read, when checking a closing, then the row is visible', () => {
    expect(
      isClosingVisible(
        actor('u1', [['read', 'CashClosing']]),
        closingRow(),
        sessionRow(),
      ),
    ).toBe(true);
  });

  it('Given an unrelated actor with base read only, when checking a closing, then the row is hidden', () => {
    expect(
      isClosingVisible(
        actor('u3', [['read', 'CashClosing']]),
        closingRow(),
        sessionRow(),
      ),
    ).toBe(false);
  });

  it('Given an unrelated actor with audit, when checking a closing, then the row is visible', () => {
    expect(
      isClosingVisible(
        actor('u3', [['read', 'CashSessionAudit']]),
        closingRow(),
        sessionRow(),
      ),
    ).toBe(true);
  });
});

describe('cash-adapter-instances — recheckReplayAbility', () => {
  it('Given a stored CREATE_REGISTER command, when replaying, then the prospective owner passes', async () => {
    const { tenantPrisma } = makeTenantHarness();
    await expect(
      recheckReplayAbility(
        tenantPrisma.getClient(),
        'tenant-a',
        actor('u1'),
        { kind: 'CREATE_REGISTER', name: 'Register A' },
        {},
      ),
    ).resolves.toBeUndefined();
  });

  it('Given a stored OPEN_SESSION command, when the session row exists, then replay passes', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    seedActors(host, ['u1']);
    host.db.sessions.push(sessionRow());
    const command: CashCommand = {
      kind: 'OPEN_SESSION',
      registerId: 'register-1',
      openingCents: 0,
      openingConfirmed: true,
    };
    await expect(
      recheckReplayAbility(
        tenantPrisma.getClient(),
        host.tenantId,
        actor('u1'),
        command,
        { session: { id: 'session-1' } },
      ),
    ).resolves.toBeUndefined();
  });

  it('Given a stored OPEN_SESSION command, when the session row is missing, then it fails closed', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const command: CashCommand = {
      kind: 'OPEN_SESSION',
      registerId: 'register-1',
      openingCents: 0,
      openingConfirmed: true,
    };
    await expect(
      recheckReplayAbility(
        tenantPrisma.getClient(),
        host.tenantId,
        actor('u1'),
        command,
        { session: { id: 'session-1' } },
      ),
    ).rejects.toMatchObject({
      code: CASH_APPLICATION_CODES.SESSION_NOT_FOUND,
    });
  });

  it('Given a stored UPDATE_REGISTER command, when the row is missing then present, then replay fails closed then passes', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const command: CashCommand = { kind: 'UPDATE_REGISTER', id: 'register-1' };
    await expect(
      recheckReplayAbility(
        tenantPrisma.getClient(),
        host.tenantId,
        actor('u1'),
        command,
        {},
      ),
    ).rejects.toMatchObject({
      code: CASH_APPLICATION_CODES.REGISTER_NOT_FOUND,
    });
    host.db.registers.push(registerRow());
    await expect(
      recheckReplayAbility(
        tenantPrisma.getClient(),
        host.tenantId,
        actor('u1'),
        command,
        {},
      ),
    ).resolves.toBeUndefined();
  });

  it('Given a stored RECEIVE_HANDOVER command, when the handover is missing then present, then replay fails closed then passes', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const command: CashCommand = {
      kind: 'RECEIVE_HANDOVER',
      id: 'handover-1',
      receivedCents: 5000,
    };
    await expect(
      recheckReplayAbility(
        tenantPrisma.getClient(),
        host.tenantId,
        actor('u1'),
        command,
        {},
      ),
    ).rejects.toMatchObject({
      code: CASH_APPLICATION_CODES.HANDOVER_NOT_FOUND,
    });
    host.db.handovers.push(handoverRow());
    await expect(
      recheckReplayAbility(
        tenantPrisma.getClient(),
        host.tenantId,
        actor('u1'),
        command,
        {},
      ),
    ).resolves.toBeUndefined();
  });

  it('Given a stored session command, when the row is missing then present, then replay fails closed then passes', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const command: CashCommand = {
      kind: 'CASH_IN',
      sessionId: 'session-1',
      amountCents: 100,
      reason: 'top-up',
    };
    await expect(
      recheckReplayAbility(
        tenantPrisma.getClient(),
        host.tenantId,
        actor('u1'),
        command,
        {},
      ),
    ).rejects.toMatchObject({
      code: CASH_APPLICATION_CODES.SESSION_NOT_FOUND,
    });
    host.db.sessions.push(sessionRow());
    await expect(
      recheckReplayAbility(
        tenantPrisma.getClient(),
        host.tenantId,
        actor('u1'),
        command,
        {},
      ),
    ).resolves.toBeUndefined();
  });

  it('Given a stored session command, when the permission was revoked, then replay fails closed', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    host.db.sessions.push(sessionRow());
    const command: CashCommand = {
      kind: 'CASH_IN',
      sessionId: 'session-1',
      amountCents: 100,
      reason: 'top-up',
    };
    await expect(
      recheckReplayAbility(
        tenantPrisma.getClient(),
        host.tenantId,
        actor('u1', [['read', 'CashSession']]),
        command,
        {},
      ),
    ).rejects.toMatchObject({
      code: CASH_APPLICATION_CODES.PERMISSION_DENIED,
    });
  });
});
