/**
 * cash-register-closing / S10 — direct characterization of the extracted
 * manual movement module.
 *
 * Manual CASH_IN/CASH_OUT require an OPEN, owned session and a reason; the
 * signed delta and source are derived server-side. Calls the module directly
 * and asserts both the returned document and the persisted row.
 */
import type { CashCommand } from '../cash-application.port';
import { manualMovement } from './cash-adapter-movements';
import {
  actor,
  asJson,
  makeTenantHarness,
  type Host,
} from './cash-adapter.test-support';

type MovementCommand = Extract<CashCommand, { kind: 'CASH_IN' | 'CASH_OUT' }>;

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

function movement(
  sessionId: string,
  over: Partial<MovementCommand> = {},
): MovementCommand {
  return {
    kind: 'CASH_IN',
    sessionId,
    amountCents: 500,
    reason: 'change',
    ...over,
  };
}

describe('cash-adapter-movements — direct module contract', () => {
  it('records a CASH_IN with a reason and a server-generated source', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    const sessionId = seedSession(host);

    const doc = await manualMovement(
      tx,
      host.tenantId,
      actor('u1'),
      movement(sessionId),
    );

    expect(doc.kind).toBe('CASH_IN');
    expect(doc.deltaCents).toBe(500);
    expect(host.db.movements).toHaveLength(1);
    expect(host.db.movements[0].sourceType).toBe('MANUAL');
    expect(host.db.movements[0].actorUserId).toBe('u1');
    expect(typeof host.db.movements[0].sourceId).toBe('string');
    expect(host.db.movements[0].reason).toBe('change');
  });

  it('records a CASH_OUT as a negative delta', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    const sessionId = seedSession(host);

    const doc = await manualMovement(
      tx,
      host.tenantId,
      actor('u1'),
      movement(sessionId, { kind: 'CASH_OUT', amountCents: 300 }),
    );

    expect(doc.kind).toBe('CASH_OUT');
    expect(doc.deltaCents).toBe(-300);
    expect(host.db.movements[0].deltaCents).toBe(-300);
  });

  it('requires a non-empty reason and writes nothing', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    const sessionId = seedSession(host);

    await expect(
      manualMovement(
        tx,
        host.tenantId,
        actor('u1'),
        movement(sessionId, { reason: '   ' }),
      ),
    ).rejects.toMatchObject({ code: 'CASH_IDENTITY_REQUIRED' });
    expect(host.db.movements).toHaveLength(0);
  });

  it('rejects a zero-amount movement', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    const sessionId = seedSession(host);

    await expect(
      manualMovement(
        tx,
        host.tenantId,
        actor('u1'),
        movement(sessionId, { amountCents: 0 }),
      ),
    ).rejects.toMatchObject({ code: 'CASH_MOVEMENT_ZERO_DELTA' });
    expect(host.db.movements).toHaveLength(0);
  });

  it('rejects a movement on a session the actor does not own', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    const sessionId = seedSession(host);

    await expect(
      manualMovement(tx, host.tenantId, actor('u2'), movement(sessionId)),
    ).rejects.toMatchObject({ code: 'CASH_SESSION_NOT_OWNED' });
    expect(host.db.movements).toHaveLength(0);
  });

  it('rejects an operational movement once the session is frozen', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    const sessionId = seedSession(host, {
      status: 'COUNTING',
      frozenAt: new Date(),
    });

    await expect(
      manualMovement(tx, host.tenantId, actor('u1'), movement(sessionId)),
    ).rejects.toMatchObject({ code: 'CASH_SESSION_NOT_WRITABLE' });
    expect(host.db.movements).toHaveLength(0);
  });

  it('fails closed on an unknown session', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();

    await expect(
      manualMovement(tx, host.tenantId, actor('u1'), movement('missing')),
    ).rejects.toMatchObject({ code: 'CASH_SESSION_NOT_FOUND' });
  });

  it('returns a movement document carrying the ISO occurrence time', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    const sessionId = seedSession(host);

    const doc = asJson(
      await manualMovement(tx, host.tenantId, actor('u1'), movement(sessionId)),
    );

    expect(doc.sessionId).toBe(sessionId);
    expect(typeof doc.occurredAt).toBe('string');
  });
});
