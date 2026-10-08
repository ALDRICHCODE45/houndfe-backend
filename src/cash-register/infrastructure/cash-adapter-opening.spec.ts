/**
 * cash-register-closing / S10 — direct characterization of the extracted
 * session-opening module.
 *
 * Covers the OPEN_SESSION guards (confirmation, register state, single
 * unreleased session) and the FLOAT-funding path that reuses a received
 * handover. The module is invoked directly, so no facade behavior is
 * presumed.
 */
import type { CashCommand } from '../cash-application.port';
import { openSession } from './cash-adapter-opening';
import {
  actor,
  asJson,
  makeTenantHarness,
  type Host,
} from './cash-adapter.test-support';

type OpenCommand = Extract<CashCommand, { kind: 'OPEN_SESSION' }>;

function seedRegister(
  host: Host,
  over: { id?: string; isActive?: boolean } = {},
): string {
  const id = over.id ?? 'reg-1';
  host.db.registers.push({
    id,
    tenantId: host.tenantId,
    name: `Caja ${id}`,
    isActive: over.isActive ?? true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

function open(
  registerId: string,
  over: Partial<OpenCommand> = {},
): OpenCommand {
  return {
    kind: 'OPEN_SESSION',
    registerId,
    openingCents: 10000,
    openingConfirmed: true,
    ...over,
  };
}

function seedFloatHandover(
  host: Host,
  over: {
    kind?: string;
    declaredCents?: number;
    receivedCents?: number | null;
    receivedAt?: Date | null;
    receivedByUserId?: string | null;
  } = {},
): string {
  const declaredAt = new Date(Date.now() - 60_000);
  host.db.sessions.push({
    id: 's-src',
    tenantId: host.tenantId,
    registerId: 'reg-src',
    cashierUserId: 'u1',
    openingCents: 0,
    status: 'CLOSED',
    openedAt: declaredAt,
    frozenAt: declaredAt,
    submittedAt: declaredAt,
    closedAt: declaredAt,
    drawerReleasedAt: declaredAt,
    openingHandoverId: null,
    expectedJson: null,
  });
  host.db.handovers.push({
    id: 'h-1',
    tenantId: host.tenantId,
    sourceSessionId: 's-src',
    kind: over.kind ?? 'FLOAT',
    recipientUserId: 'u1',
    createdByUserId: 'u1',
    declaredCents: over.declaredCents ?? 5000,
    receivedCents: over.receivedCents === undefined ? 5000 : over.receivedCents,
    receivedAt: over.receivedAt === undefined ? declaredAt : over.receivedAt,
    receivedByUserId:
      over.receivedByUserId === undefined ? 'u1' : over.receivedByUserId,
    notes: null,
    receiptNotes: null,
    createdAt: declaredAt,
  });
  return 'h-1';
}

describe('cash-adapter-opening — direct module contract', () => {
  it('opens a blind session once the drawer is explicitly confirmed', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    const registerId = seedRegister(host);

    const doc = await openSession(
      tx,
      host.tenantId,
      actor('u1'),
      open(registerId, { openingCents: 10000 }),
    );

    const session = asJson(doc.session);
    expect(session.status).toBe('OPEN');
    expect(session.blind).toBe(true);
    expect(session.expectedCashCents).toBeUndefined();
    expect(host.db.sessions).toHaveLength(1);
    expect(host.db.sessions[0].openingCents).toBe(10000);
    expect(host.db.sessions[0].cashierUserId).toBe('u1');
  });

  it('requires an explicit confirmation and writes no session', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    const registerId = seedRegister(host);

    await expect(
      openSession(
        tx,
        host.tenantId,
        actor('u1'),
        open(registerId, { openingConfirmed: false }),
      ),
    ).rejects.toMatchObject({ code: 'CASH_OPENING_NOT_CONFIRMED' });
    expect(host.db.sessions).toHaveLength(0);
  });

  it('fails closed on an unknown register', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();

    await expect(
      openSession(tx, host.tenantId, actor('u1'), open('missing-register')),
    ).rejects.toMatchObject({ code: 'CASH_REGISTER_NOT_FOUND' });
    expect(host.db.sessions).toHaveLength(0);
  });

  it('rejects an inactive register', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    const registerId = seedRegister(host, { isActive: false });

    await expect(
      openSession(tx, host.tenantId, actor('u1'), open(registerId)),
    ).rejects.toMatchObject({ code: 'CASH_REGISTER_INACTIVE' });
    expect(host.db.sessions).toHaveLength(0);
  });

  it('blocks a second unreleased session on the same register', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    const registerId = seedRegister(host);
    await openSession(tx, host.tenantId, actor('u1'), open(registerId));

    await expect(
      openSession(tx, host.tenantId, actor('u1'), open(registerId)),
    ).rejects.toMatchObject({ code: 'CASH_REGISTER_UNRELEASED_SESSION' });
    expect(host.db.sessions).toHaveLength(1);
  });

  it('funds a new session from a received FLOAT handover of equal value', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    const handoverId = seedFloatHandover(host);
    const registerId = seedRegister(host);

    await openSession(
      tx,
      host.tenantId,
      actor('u1'),
      open(registerId, { openingCents: 5000, openingHandoverId: handoverId }),
    );

    const opened = host.db.sessions.find(
      (row) => row.registerId === registerId,
    );
    expect(opened?.openingHandoverId).toBe(handoverId);
  });

  it('rejects a FLOAT whose received amount differs from the opening fund', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    const handoverId = seedFloatHandover(host);
    const registerId = seedRegister(host);

    await expect(
      openSession(
        tx,
        host.tenantId,
        actor('u1'),
        open(registerId, { openingCents: 4000, openingHandoverId: handoverId }),
      ),
    ).rejects.toMatchObject({ code: 'CASH_OPENING_FUNDS_MISMATCH' });
    expect(host.db.sessions).toHaveLength(1);
  });

  it('rejects a FLOAT handover already used to fund another session', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    const handoverId = seedFloatHandover(host);
    const firstRegister = seedRegister(host, { id: 'reg-1' });
    const secondRegister = seedRegister(host, { id: 'reg-2' });
    await openSession(
      tx,
      host.tenantId,
      actor('u1'),
      open(firstRegister, {
        openingCents: 5000,
        openingHandoverId: handoverId,
      }),
    );

    await expect(
      openSession(
        tx,
        host.tenantId,
        actor('u1'),
        open(secondRegister, {
          openingCents: 5000,
          openingHandoverId: handoverId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CASH_OPENING_FLOAT_REUSE' });
  });
});
