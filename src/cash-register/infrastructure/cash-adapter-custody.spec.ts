/**
 * cash-register-closing / S10 — direct characterization of the extracted
 * custody module (CREATE_HANDOVER / RECEIVE_HANDOVER / RELEASE_DRAWER).
 *
 * Pins allocation bounds, active-member receiver checks, actor-bound receipt
 * with notes on a shortfall, and the "all custody received" drawer-release
 * gate. Called directly; no facade transaction/idempotency layer is involved.
 */
import {
  createHandover,
  receiveHandover,
  releaseDrawer,
} from './cash-adapter-custody';
import type { TenantClient } from './cash-adapter-client';
import {
  actor,
  makeTenantHarness,
  seedActors,
  type Host,
} from './cash-adapter.test-support';

function seedSubmittedSession(
  host: Host,
  over: { drawerReleasedAt?: Date | null } = {},
): string {
  host.db.sessions.push({
    id: 's-1',
    tenantId: host.tenantId,
    registerId: 'reg-1',
    cashierUserId: 'u1',
    openingCents: 1000,
    status: 'SUBMITTED',
    openedAt: new Date(),
    frozenAt: new Date(),
    submittedAt: new Date(),
    closedAt: null,
    drawerReleasedAt:
      over.drawerReleasedAt === undefined ? null : over.drawerReleasedAt,
    openingHandoverId: null,
    expectedJson: null,
  });
  host.db.counts.push({
    id: 'c-1',
    tenantId: host.tenantId,
    sessionId: 's-1',
    kind: 'DECLARATION',
    revision: 1,
    actorUserId: 'u1',
    linesJson: [{ channelKey: 'CASH', amountCents: 1000 }],
    denominationsJson: null,
    notes: null,
    createdAt: new Date(),
  });
  return 's-1';
}

async function createHandoverTo(
  host: Host,
  tx: TenantClient,
  recipientUserId: string,
): Promise<string> {
  const doc = await createHandover(tx, host.tenantId, actor('u1'), {
    kind: 'CREATE_HANDOVER',
    sessionId: 's-1',
    handoverKind: 'FLOAT',
    recipientUserId,
    declaredCents: 1000,
  });
  return doc.id as string;
}

describe('cash-adapter-custody — direct module contract', () => {
  it('allocates counted cash to another active member', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedActors(host, ['u1', 'u2']);
    seedSubmittedSession(host);

    const doc = await createHandover(tx, host.tenantId, actor('u1'), {
      kind: 'CREATE_HANDOVER',
      sessionId: 's-1',
      handoverKind: 'WITHDRAWAL',
      recipientUserId: 'u2',
      declaredCents: 1000,
    });

    expect(doc.kind).toBe('WITHDRAWAL');
    expect(doc.receiverUserId).toBe('u2');
    expect(doc.receivedCents).toBeNull();
    expect(host.db.handovers).toHaveLength(1);
  });

  it('rejects a withdrawal received by its own sender', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedActors(host, ['u1']);
    seedSubmittedSession(host);

    await expect(
      createHandover(tx, host.tenantId, actor('u1'), {
        kind: 'CREATE_HANDOVER',
        sessionId: 's-1',
        handoverKind: 'WITHDRAWAL',
        recipientUserId: 'u1',
        declaredCents: 1000,
      }),
    ).rejects.toMatchObject({ code: 'CASH_HANDOVER_SELF_WITHDRAWAL' });
    expect(host.db.handovers).toHaveLength(0);
  });

  it('rejects allocating more than the counted cash', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedActors(host, ['u1', 'u2']);
    seedSubmittedSession(host);

    await expect(
      createHandover(tx, host.tenantId, actor('u1'), {
        kind: 'CREATE_HANDOVER',
        sessionId: 's-1',
        handoverKind: 'WITHDRAWAL',
        recipientUserId: 'u2',
        declaredCents: 2000,
      }),
    ).rejects.toMatchObject({ code: 'CASH_HANDOVER_ALLOCATION_EXCEEDED' });
    expect(host.db.handovers).toHaveLength(0);
  });

  it('requires a submitted declaration before a handover', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedActors(host, ['u1', 'u2']);
    host.db.sessions.push({
      id: 's-1',
      tenantId: host.tenantId,
      registerId: 'reg-1',
      cashierUserId: 'u1',
      openingCents: 0,
      status: 'OPEN',
      openedAt: new Date(),
      frozenAt: null,
      submittedAt: null,
      closedAt: null,
      drawerReleasedAt: null,
      openingHandoverId: null,
      expectedJson: null,
    });

    await expect(
      createHandover(tx, host.tenantId, actor('u1'), {
        kind: 'CREATE_HANDOVER',
        sessionId: 's-1',
        handoverKind: 'FLOAT',
        recipientUserId: 'u1',
        declaredCents: 0,
      }),
    ).rejects.toMatchObject({ code: 'CASH_SESSION_NOT_WRITABLE' });
  });

  it('rejects a receiver that is not an active tenant member', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedActors(host, ['u1']);
    host.db.users.push({ id: 'u-nomember', isActive: true });
    seedSubmittedSession(host);

    await expect(
      createHandover(tx, host.tenantId, actor('u1'), {
        kind: 'CREATE_HANDOVER',
        sessionId: 's-1',
        handoverKind: 'WITHDRAWAL',
        recipientUserId: 'u-nomember',
        declaredCents: 1000,
      }),
    ).rejects.toMatchObject({ code: 'CASH_TENANT_MEMBERSHIP_REQUIRED' });
    expect(host.db.handovers).toHaveLength(0);
  });

  it('only the designated recipient may confirm receipt', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedActors(host, ['u1', 'u2']);
    seedSubmittedSession(host);
    const handoverId = await createHandoverTo(host, tx, 'u2');

    await expect(
      receiveHandover(tx, host.tenantId, actor('u3'), {
        kind: 'RECEIVE_HANDOVER',
        id: handoverId,
        receivedCents: 1000,
      }),
    ).rejects.toMatchObject({ code: 'CASH_HANDOVER_RECIPIENT_INVALID' });
    expect(host.db.handovers[0].receivedAt).toBeNull();
  });

  it('requires a note when the received amount differs from the declared one', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedActors(host, ['u1', 'u2']);
    seedSubmittedSession(host);
    const handoverId = await createHandoverTo(host, tx, 'u2');

    await expect(
      receiveHandover(tx, host.tenantId, actor('u2'), {
        kind: 'RECEIVE_HANDOVER',
        id: handoverId,
        receivedCents: 900,
      }),
    ).rejects.toMatchObject({ code: 'CASH_RECEIPT_NOTES_REQUIRED' });
    expect(host.db.handovers[0].receivedAt).toBeNull();

    const doc = await receiveHandover(tx, host.tenantId, actor('u2'), {
      kind: 'RECEIVE_HANDOVER',
      id: handoverId,
      receivedCents: 900,
      notes: 'short by 100',
    });
    expect(doc.receivedCents).toBe(900);
    expect(doc.receiptActorUserId).toBe('u2');
  });

  it('blocks drawer release while a handover is still unreceived', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedActors(host, ['u1', 'u2']);
    seedSubmittedSession(host);
    await createHandoverTo(host, tx, 'u2');

    await expect(
      releaseDrawer(tx, host.tenantId, actor('u1'), 's-1'),
    ).rejects.toMatchObject({ code: 'CASH_CUSTODY_NOT_RECEIVED' });
    expect(host.db.sessions[0].drawerReleasedAt).toBeNull();
  });

  it('releases the drawer once custody is fully received and allocated', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedActors(host, ['u1', 'u2']);
    seedSubmittedSession(host);
    const handoverId = await createHandoverTo(host, tx, 'u2');
    await receiveHandover(tx, host.tenantId, actor('u2'), {
      kind: 'RECEIVE_HANDOVER',
      id: handoverId,
      receivedCents: 1000,
    });

    const doc = await releaseDrawer(tx, host.tenantId, actor('u1'), 's-1');

    expect(typeof doc.drawerReleasedAt).toBe('string');
    expect(host.db.sessions[0].drawerReleasedAt).toBeInstanceOf(Date);
    expect(doc.sessionId).toBe('s-1');
  });

  it('fails closed on an unknown handover', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedActors(host, ['u1']);

    await expect(
      receiveHandover(tx, host.tenantId, actor('u1'), {
        kind: 'RECEIVE_HANDOVER',
        id: 'missing',
        receivedCents: 0,
      }),
    ).rejects.toMatchObject({ code: 'CASH_HANDOVER_NOT_FOUND' });
  });
});
