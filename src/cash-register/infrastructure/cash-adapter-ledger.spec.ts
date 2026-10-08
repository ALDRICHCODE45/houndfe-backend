/**
 * cash-register-closing / S10 — direct characterization of the extracted
 * transaction-bound ledger module.
 *
 * Pins owner/OPEN/membership rechecks on the ledger path, deterministic
 * tender + change planning, fail-closed source uniqueness, refund settlement
 * movements, and the storage-level ambient-transaction guard the facade
 * applies before dispatching here. Called directly; the sales-side wrapping
 * transaction is not exercised.
 */
import {
  assertOpenSession,
  recordPayments,
  recordRefund,
} from './cash-adapter-ledger';
import { requireAmbientTransaction } from './cash-adapter-storage';
import {
  makeTenantHarness,
  seedActors,
  type Host,
} from './cash-adapter.test-support';

function seedSession(host: Host, over: Record<string, unknown> = {}): string {
  host.db.sessions.push({
    id: 's-1',
    tenantId: host.tenantId,
    registerId: 'reg-1',
    cashierUserId: 'u1',
    openingCents: 1000,
    status: 'OPEN',
    openedAt: new Date(),
    frozenAt: null,
    submittedAt: null,
    closedAt: null,
    drawerReleasedAt: null,
    openingHandoverId: null,
    expectedJson: null,
    ...over,
  });
  return 's-1';
}

function errorCode(run: () => void): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('cash-adapter-ledger — direct module contract', () => {
  it('accepts an active owner of an OPEN session', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedActors(host, ['u1']);
    seedSession(host);

    await expect(
      assertOpenSession(tx, host.tenantId, 's-1', 'u1'),
    ).resolves.toBeUndefined();
  });

  it('rejects an OPEN-session check for a non-owner', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedActors(host, ['u1', 'u2']);
    seedSession(host);

    await expect(
      assertOpenSession(tx, host.tenantId, 's-1', 'u2'),
    ).rejects.toMatchObject({ code: 'CASH_SESSION_NOT_OWNED' });
  });

  it('rejects an inactive owner', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedActors(host, ['u1']);
    seedSession(host);
    host.db.users[0].isActive = false;

    await expect(
      assertOpenSession(tx, host.tenantId, 's-1', 'u1'),
    ).rejects.toMatchObject({ code: 'CASH_ACTOR_INACTIVE' });
  });

  it('records a CASH tender and the sale change deterministically', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedActors(host, ['u1']);
    seedSession(host);

    await recordPayments(tx, host.tenantId, {
      sessionId: 's-1',
      actorId: 'u1',
      saleId: 'sale-1',
      payments: [{ paymentId: 'p-1', method: 'cash', amountCents: 1000 }],
      changeDueCents: 300,
      occurredAt: new Date(),
    });

    expect(host.db.movements).toHaveLength(2);
    expect(host.db.movements[0].kind).toBe('SALE_PAYMENT');
    expect(host.db.movements[0].deltaCents).toBe(1000);
    expect(host.db.movements[0].sourceType).toBe('PAYMENT');
    expect(host.db.movements[1].kind).toBe('SALE_CHANGE');
    expect(host.db.movements[1].deltaCents).toBe(-300);
    expect(host.db.movements[1].sourceType).toBe('SALE');
  });

  it('treats an empty tender with zero change as a no-op', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedActors(host, ['u1']);
    seedSession(host);

    await recordPayments(tx, host.tenantId, {
      sessionId: 's-1',
      actorId: 'u1',
      saleId: 'sale-1',
      payments: [],
      changeDueCents: 0,
      occurredAt: new Date(),
    });

    expect(host.db.movements).toHaveLength(0);
  });

  it('fails closed when the same payment source is recorded twice', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedActors(host, ['u1']);
    seedSession(host);
    const input = {
      sessionId: 's-1',
      actorId: 'u1',
      saleId: 'sale-1',
      payments: [
        { paymentId: 'p-1', method: 'cash' as const, amountCents: 1000 },
      ],
      changeDueCents: 0,
      occurredAt: new Date(),
    };
    await recordPayments(tx, host.tenantId, input);

    await expect(
      recordPayments(tx, host.tenantId, input),
    ).rejects.toMatchObject({ code: 'CASH_MOVEMENT_DUPLICATE_SOURCE' });
    expect(host.db.movements).toHaveLength(1);
  });

  it('records a refund as a negative settlement movement', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedActors(host, ['u1']);
    seedSession(host);

    await recordRefund(tx, host.tenantId, {
      sessionId: 's-1',
      actorId: 'u1',
      settlementId: 'r-1',
      amountCents: 500,
      method: 'cash',
      occurredAt: new Date(),
    });

    expect(host.db.movements).toHaveLength(1);
    expect(host.db.movements[0].kind).toBe('REFUND_SETTLEMENT');
    expect(host.db.movements[0].deltaCents).toBe(-500);
    expect(host.db.movements[0].sourceType).toBe('REFUND');
  });

  it('rejects a non-positive refund and an already-settled one', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedActors(host, ['u1']);
    seedSession(host);

    await expect(
      recordRefund(tx, host.tenantId, {
        sessionId: 's-1',
        actorId: 'u1',
        settlementId: 'r-0',
        amountCents: 0,
        method: 'cash',
        occurredAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'CASH_MOVEMENT_ZERO_DELTA' });
    expect(host.db.movements).toHaveLength(0);

    const refund = {
      sessionId: 's-1',
      actorId: 'u1',
      settlementId: 'r-1',
      amountCents: 500,
      method: 'cash' as const,
      occurredAt: new Date(),
    };
    await recordRefund(tx, host.tenantId, refund);
    await expect(recordRefund(tx, host.tenantId, refund)).rejects.toMatchObject(
      { code: 'CASH_MOVEMENT_DUPLICATE_SOURCE' },
    );
    expect(host.db.movements).toHaveLength(1);
  });

  it('requires the caller to already be inside an ambient transaction', () => {
    expect(
      errorCode(() => requireAmbientTransaction(false, 'recordPayments')),
    ).toBe('CASH_LEDGER_OUTSIDE_TRANSACTION');
    expect(
      errorCode(() => requireAmbientTransaction(true, 'recordPayments')),
    ).toBeUndefined();
  });
});
