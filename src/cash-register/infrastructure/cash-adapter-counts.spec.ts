/**
 * cash-register-closing / S10 — direct characterization of the extracted
 * count module (START_COUNT / DECLARE / ANNOTATE_DECLARATION / VERIFY).
 *
 * Pins the freeze transition, the first blind declaration persisted before
 * any expected-dependent comparison, immutable annotation revisions, and the
 * independent-verifier rule. Called directly; no facade or idempotency layer
 * is involved.
 */
import { randomUUID } from 'crypto';
import {
  annotateDeclaration,
  declare,
  startCount,
  verify,
} from './cash-adapter-counts';
import type { CountCommand } from './cash-adapter-values';
import {
  actor,
  asJson,
  makeTenantHarness,
  type Host,
} from './cash-adapter.test-support';

const lines = (cash: number) => [{ channelKey: 'CASH', amountCents: cash }];

const declareCmd = (sessionId: string, cash: number): CountCommand => ({
  kind: 'DECLARE',
  sessionId,
  lines: lines(cash),
});

const verifyCmd = (sessionId: string, cash: number): CountCommand => ({
  kind: 'VERIFY',
  sessionId,
  lines: lines(cash),
});

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

function seedCashMovement(
  host: Host,
  sessionId: string,
  deltaCents: number,
): void {
  host.db.movements.push({
    id: randomUUID(),
    tenantId: host.tenantId,
    sessionId,
    kind: deltaCents >= 0 ? 'CASH_IN' : 'CASH_OUT',
    deltaCents,
    method: 'CASH',
    channelKey: 'CASH',
    channelLabel: 'Efectivo',
    sourceType: 'MANUAL',
    sourceId: randomUUID(),
    actorUserId: 'u1',
    reason: 'seed',
    occurredAt: new Date(),
    createdAt: new Date(),
  });
}

describe('cash-adapter-counts — direct module contract', () => {
  it('freezes the session and persists the expected cash snapshot', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    const sessionId = seedSession(host);
    seedCashMovement(host, sessionId, 500);

    const doc = await startCount(tx, host.tenantId, actor('u1'), sessionId);

    expect(asJson(doc.session).status).toBe('COUNTING');
    expect(asJson(doc.session).blind).toBe(true);
    expect(asJson(doc.session).expectedCashCents).toBeUndefined();
    expect(host.db.sessions[0].status).toBe('COUNTING');
    expect(host.db.sessions[0].frozenAt).toBeInstanceOf(Date);
    expect(asJson(host.db.sessions[0].expectedJson).cashExpectedCents).toBe(
      1500,
    );
  });

  it('rejects a second freeze on a session that is already counting', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    const sessionId = seedSession(host);
    await startCount(tx, host.tenantId, actor('u1'), sessionId);

    await expect(
      startCount(tx, host.tenantId, actor('u1'), sessionId),
    ).rejects.toMatchObject({ code: 'CASH_SESSION_NOT_WRITABLE' });
  });

  it('persists the first discrepant declaration unchanged and stays SUBMITTED', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    const sessionId = seedSession(host);
    await startCount(tx, host.tenantId, actor('u1'), sessionId);

    const doc = await declare(
      tx,
      host.tenantId,
      actor('u1'),
      declareCmd(sessionId, 900),
    );

    expect(doc.status).toBe('SUBMITTED');
    expect(asJson(doc.comparison).requiresDeclarationNotes).toBe(true);
    expect(host.db.counts).toHaveLength(1);
    expect(host.db.sessions[0].status).toBe('SUBMITTED');
  });

  it('requires a frozen counting session before a declaration', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    const sessionId = seedSession(host);

    await expect(
      declare(tx, host.tenantId, actor('u1'), declareCmd(sessionId, 900)),
    ).rejects.toMatchObject({ code: 'CASH_SESSION_NOT_WRITABLE' });
    expect(host.db.counts).toHaveLength(0);
  });

  it('rejects a second declaration when one already exists', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    const sessionId = seedSession(host);
    await startCount(tx, host.tenantId, actor('u1'), sessionId);
    host.db.counts.push({
      id: 'c-existing',
      tenantId: host.tenantId,
      sessionId,
      kind: 'DECLARATION',
      revision: 1,
      actorUserId: 'u1',
      linesJson: lines(1000),
      denominationsJson: null,
      notes: null,
      createdAt: new Date(),
    });

    await expect(
      declare(tx, host.tenantId, actor('u1'), declareCmd(sessionId, 1000)),
    ).rejects.toMatchObject({
      code: 'CASH_DECLARATION_ALREADY_SUBMITTED',
    });
    expect(host.db.counts).toHaveLength(1);
  });

  it('appends an immutable notes revision preserving the original amounts', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    const sessionId = seedSession(host);
    await startCount(tx, host.tenantId, actor('u1'), sessionId);
    await declare(tx, host.tenantId, actor('u1'), declareCmd(sessionId, 900));

    const doc = await annotateDeclaration(tx, host.tenantId, actor('u1'), {
      kind: 'ANNOTATE_DECLARATION',
      sessionId,
      notes: 'faltó vuelto',
    });

    expect(doc.revision).toBe(2);
    const declarations = host.db.counts.filter(
      (row) => row.kind === 'DECLARATION',
    );
    expect(declarations).toHaveLength(2);
    expect(declarations[0].revision).toBe(1);
    expect(declarations[1].linesJson).toEqual(declarations[0].linesJson);
    expect(declarations[1].notes).toBe('faltó vuelto');
  });

  it('blocks annotation once an independent verification exists', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    const sessionId = seedSession(host);
    await startCount(tx, host.tenantId, actor('u1'), sessionId);
    await declare(tx, host.tenantId, actor('u1'), declareCmd(sessionId, 1000));
    await verify(tx, host.tenantId, actor('u2'), verifyCmd(sessionId, 1000));

    await expect(
      annotateDeclaration(tx, host.tenantId, actor('u1'), {
        kind: 'ANNOTATE_DECLARATION',
        sessionId,
        notes: 'late note',
      }),
    ).rejects.toMatchObject({ code: 'CASH_ANNOTATION_BLOCKED' });
  });

  it('forbids self verification and records a single independent one', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    const sessionId = seedSession(host);
    await startCount(tx, host.tenantId, actor('u1'), sessionId);
    await declare(tx, host.tenantId, actor('u1'), declareCmd(sessionId, 1000));

    await expect(
      verify(tx, host.tenantId, actor('u1'), verifyCmd(sessionId, 1000)),
    ).rejects.toMatchObject({ code: 'CASH_SELF_VERIFICATION_FORBIDDEN' });

    const doc = await verify(
      tx,
      host.tenantId,
      actor('u2'),
      verifyCmd(sessionId, 1000),
    );
    expect(asJson(doc.verification).revision).toBe(1);
    expect(
      host.db.counts.filter((row) => row.kind === 'VERIFICATION'),
    ).toHaveLength(1);

    await expect(
      verify(tx, host.tenantId, actor('u2'), verifyCmd(sessionId, 1000)),
    ).rejects.toMatchObject({ code: 'CASH_ALREADY_VERIFIED' });
  });
});
