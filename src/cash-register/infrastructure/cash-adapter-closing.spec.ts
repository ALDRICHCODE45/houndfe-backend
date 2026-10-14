/**
 * cash-register-closing / S10 — direct characterization of the extracted
 * closing module.
 *
 * Builds a fully-prepared SUBMITTED session (declaration + verification +
 * received/allocated custody) from raw rows, then pins the close gate order
 * and the immutable per-channel snapshot. Called directly; the facade
 * transaction and idempotency layer are out of scope here.
 */
import { close } from './cash-adapter-closing';
import {
  actor,
  asItems,
  asJson,
  makeTenantHarness,
  type Host,
} from './cash-adapter.test-support';

interface SeedOptions {
  status?: string;
  drawerReleasedAt?: Date | null;
  declaration?: boolean;
  verification?: boolean;
  handoverReceived?: boolean;
  allocatedCents?: number;
}

function seedReady(host: Host, over: SeedOptions = {}): void {
  const at = new Date('2026-01-01T10:00:00Z');
  host.db.registers.push({
    id: 'reg-1',
    tenantId: host.tenantId,
    name: 'Caja 1',
    isActive: true,
    createdAt: at,
    updatedAt: at,
  });
  host.db.users.push(
    {
      id: 'u1',
      name: 'Ana',
      email: 'ana@example.test',
      hashedPassword: 'x',
      isActive: true,
    },
    {
      id: 'u2',
      name: 'Beto',
      email: 'beto@example.test',
      hashedPassword: 'x',
      isActive: true,
    },
  );
  host.db.sessions.push({
    id: 's-1',
    tenantId: host.tenantId,
    registerId: 'reg-1',
    cashierUserId: 'u1',
    openingCents: 1000,
    status: over.status ?? 'SUBMITTED',
    openedAt: at,
    frozenAt: at,
    submittedAt: at,
    closedAt: null,
    drawerReleasedAt:
      over.drawerReleasedAt === undefined ? at : over.drawerReleasedAt,
    openingHandoverId: null,
    expectedJson: {
      cashExpectedCents: 1000,
      frozenAt: at.toISOString(),
      channels: [
        {
          channelKey: 'CASH',
          channelLabel: 'Efectivo',
          method: 'CASH',
          expectedCents: 1000,
        },
      ],
    },
  });
  if (over.declaration !== false) {
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
      createdAt: at,
    });
  }
  if (over.verification !== false) {
    host.db.counts.push({
      id: 'c-2',
      tenantId: host.tenantId,
      sessionId: 's-1',
      kind: 'VERIFICATION',
      revision: 1,
      actorUserId: 'u2',
      linesJson: [{ channelKey: 'CASH', amountCents: 1000 }],
      denominationsJson: null,
      notes: null,
      createdAt: at,
    });
  }
  const received = over.handoverReceived !== false;
  host.db.handovers.push({
    id: 'h-1',
    tenantId: host.tenantId,
    sourceSessionId: 's-1',
    kind: 'FLOAT',
    recipientUserId: 'u1',
    createdByUserId: 'u1',
    declaredCents: over.allocatedCents ?? 1000,
    receivedCents: received ? 1000 : null,
    receivedAt: received ? at : null,
    receivedByUserId: received ? 'u1' : null,
    notes: null,
    receiptNotes: null,
    createdAt: at,
  });
}

describe('cash-adapter-closing — direct module contract', () => {
  it('closes into an immutable per-channel snapshot and marks the session CLOSED', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedReady(host);

    const doc = await close(tx, host.tenantId, actor('u2'), {
      kind: 'CLOSE',
      sessionId: 's-1',
    });

    expect(doc.folio).toMatch(/^CC-/);
    const snapshot = asJson(doc.snapshot);
    expect(snapshot.sessionId).toBe('s-1');
    expect(snapshot.folio).toBe(doc.folio);
    expect(snapshot.cashierName).toBe('Ana');
    expect(asItems(snapshot.channels)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channelKey: 'CASH',
          expectedCents: 1000,
          declaredCents: 1000,
          verifiedCents: 1000,
        }),
      ]),
    );
    expect(host.db.closings).toHaveLength(1);
    expect(host.db.sessions[0].status).toBe('CLOSED');
    expect(host.db.sessions[0].closedAt).toBeInstanceOf(Date);
  });

  it('requires a submitted declaration', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedReady(host, { status: 'OPEN' });

    await expect(
      close(tx, host.tenantId, actor('u2'), {
        kind: 'CLOSE',
        sessionId: 's-1',
      }),
    ).rejects.toMatchObject({ code: 'CASH_SESSION_NOT_WRITABLE' });
    expect(host.db.closings).toHaveLength(0);
  });

  it('forbids the cashier closing their own session', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedReady(host);

    await expect(
      close(tx, host.tenantId, actor('u1'), {
        kind: 'CLOSE',
        sessionId: 's-1',
      }),
    ).rejects.toMatchObject({ code: 'CASH_SELF_CLOSING_FORBIDDEN' });
  });

  it('rejects closing before the drawer is released', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedReady(host, { drawerReleasedAt: null });

    await expect(
      close(tx, host.tenantId, actor('u2'), {
        kind: 'CLOSE',
        sessionId: 's-1',
      }),
    ).rejects.toMatchObject({ code: 'CASH_DRAWER_NOT_RELEASED' });
  });

  it('requires an independent verification', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedReady(host, { verification: false });

    await expect(
      close(tx, host.tenantId, actor('u2'), {
        kind: 'CLOSE',
        sessionId: 's-1',
      }),
    ).rejects.toMatchObject({ code: 'CASH_VERIFICATION_REQUIRED' });
    expect(host.db.closings).toHaveLength(0);
  });

  it('requires an original declaration to close', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedReady(host, { declaration: false });

    await expect(
      close(tx, host.tenantId, actor('u2'), {
        kind: 'CLOSE',
        sessionId: 's-1',
      }),
    ).rejects.toMatchObject({ code: 'CASH_DECLARATION_NOT_FOUND' });
  });

  it('rejects closing while a handover is still unreceived', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedReady(host, { handoverReceived: false });

    await expect(
      close(tx, host.tenantId, actor('u2'), {
        kind: 'CLOSE',
        sessionId: 's-1',
      }),
    ).rejects.toMatchObject({ code: 'CASH_CUSTODY_NOT_RECEIVED' });
  });

  it('rejects closing when the declared cash is not fully allocated', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    seedReady(host, { allocatedCents: 500 });

    await expect(
      close(tx, host.tenantId, actor('u2'), {
        kind: 'CLOSE',
        sessionId: 's-1',
      }),
    ).rejects.toMatchObject({ code: 'CASH_HANDOVER_ALLOCATION_MISMATCH' });
    expect(host.db.closings).toHaveLength(0);
  });
});
