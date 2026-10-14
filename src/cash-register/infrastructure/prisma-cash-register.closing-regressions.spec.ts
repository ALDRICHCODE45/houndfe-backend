import { randomUUID } from 'crypto';
import type { CashCommand } from '../cash-application.port';
import { parseCashClosingReceipt } from '../../pdf-generation/cash-closing/cash-closing-receipt.parser';
import {
  actor,
  asJson,
  makeApp,
  seedActors,
} from './prisma-cash-register.test-support';

const lines = (card = 100) => [
  { channelKey: 'CASH', amountCents: 0 },
  { channelKey: 'METHOD:CARD_CREDIT', amountCents: card },
];

async function fixture() {
  const { app, host, tenantPrisma } = makeApp();
  seedActors(host, ['u1', 'u2']);
  const execute = (user: string, command: CashCommand) =>
    app.execute(actor(user), command, randomUUID());
  const register = asJson(
    await execute('u1', { kind: 'CREATE_REGISTER', name: randomUUID() }),
  );
  const opened = asJson(
    await execute('u1', {
      kind: 'OPEN_SESSION',
      registerId: register.id as string,
      openingCents: 0,
      openingConfirmed: true,
    }),
  );
  const sessionId = asJson(opened.session).id as string;
  await tenantPrisma.runInTransaction(() =>
    app.recordPayments({
      sessionId,
      actorId: 'u1',
      saleId: 'sale-1',
      payments: [
        { paymentId: 'payment-1', method: 'card_credit', amountCents: 100 },
      ],
      changeDueCents: 0,
      occurredAt: new Date(),
    }),
  );
  return { app, host, execute, sessionId };
}

afterEach(() => jest.useRealTimers());

describe('cash closing regression boundaries', () => {
  it('omits all movement metadata before declaration, even for an owner with audit ability', async () => {
    const { app, execute, sessionId } = await fixture();
    for (const frozen of [false, true]) {
      if (frozen) await execute('u1', { kind: 'START_COUNT', sessionId });
      const view = asJson(
        await app.query(actor('u1'), { kind: 'SESSION', id: sessionId }),
      );
      expect(asJson(view.session).blind).toBe(true);
      expect(view.movements).toEqual([]);
      expect(view.channelSnapshot).toBeNull();
    }
  });

  it('passes closing notes from the real adapter envelope to the frozen receipt parser', async () => {
    const { execute, sessionId } = await fixture();
    await execute('u1', { kind: 'START_COUNT', sessionId });
    await execute('u1', { kind: 'DECLARE', sessionId, lines: lines() });
    await execute('u2', { kind: 'VERIFY', sessionId, lines: lines() });
    await execute('u1', { kind: 'RELEASE_DRAWER', sessionId });
    const closed = await execute('u2', {
      kind: 'CLOSE',
      sessionId,
      notes: 'Reconciled with terminal report',
    });
    expect(parseCashClosingReceipt(closed).snapshot.closingNotes).toBe(
      'Reconciled with terminal report',
    );
  });

  it('preserves the original declaration instant after an annotation', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-07T10:00:00Z'));
    const { execute, sessionId } = await fixture();
    await execute('u1', { kind: 'START_COUNT', sessionId });
    await execute('u1', { kind: 'DECLARE', sessionId, lines: lines() });
    jest.setSystemTime(new Date('2026-10-07T10:15:00Z'));
    await execute('u1', {
      kind: 'ANNOTATE_DECLARATION',
      sessionId,
      notes: 'Terminal report attached',
    });
    await execute('u2', { kind: 'VERIFY', sessionId, lines: lines() });
    await execute('u1', { kind: 'RELEASE_DRAWER', sessionId });
    const closed = asJson(await execute('u2', { kind: 'CLOSE', sessionId }));
    expect(asJson(closed.snapshot).countedAt).toBe('2026-10-07T10:00:00.000Z');
    expect(asJson(closed.snapshot).declarationNotes).toBe(
      'Terminal report attached',
    );
  });

  it('persists a blind noncash mismatch but requires declaration and verification explanations afterwards', async () => {
    const { app, host, execute, sessionId } = await fixture();
    await execute('u1', { kind: 'START_COUNT', sessionId });
    await execute('u1', { kind: 'DECLARE', sessionId, lines: lines(90) });
    const declared = asJson(
      await app.query(actor('u1'), { kind: 'SESSION', id: sessionId }),
    );
    expect(asJson(declared.session).status).toBe('SUBMITTED');
    const before = host.db.commands.length;
    await expect(
      execute('u2', { kind: 'VERIFY', sessionId, lines: lines(90) }),
    ).rejects.toMatchObject({ code: 'CASH_DISCREPANCY_NOTES_REQUIRED' });
    expect(host.db.commands).toHaveLength(before);
    expect(
      host.db.counts.filter((row) => row.kind === 'VERIFICATION'),
    ).toHaveLength(0);
    await execute('u1', {
      kind: 'ANNOTATE_DECLARATION',
      sessionId,
      notes: 'Terminal reconciliation discrepancy',
    });
    await expect(
      execute('u2', { kind: 'VERIFY', sessionId, lines: lines(80) }),
    ).rejects.toMatchObject({ code: 'CASH_DISCREPANCY_NOTES_REQUIRED' });
    await execute('u2', {
      kind: 'VERIFY',
      sessionId,
      lines: lines(80),
      notes: 'Independent terminal count',
    });
    await execute('u1', { kind: 'RELEASE_DRAWER', sessionId });
    const closed = asJson(await execute('u2', { kind: 'CLOSE', sessionId }));
    expect(asJson(closed.snapshot).channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channelKey: 'METHOD:CARD_CREDIT',
          expectedCents: 100,
          declaredCents: 90,
          verifiedCents: 80,
        }),
      ]),
    );
  });

  it('rejects closing persisted noncash verification discrepancies without notes', async () => {
    const { host, execute, sessionId } = await fixture();
    await execute('u1', { kind: 'START_COUNT', sessionId });
    await execute('u1', { kind: 'DECLARE', sessionId, lines: lines() });
    await execute('u2', {
      kind: 'VERIFY',
      sessionId,
      lines: lines(90),
      notes: 'Terminal difference',
    });
    // Seed the previously accepted persisted state; no public command edits a verification.
    const verification = host.db.counts.find(
      (row) => row.kind === 'VERIFICATION',
    );
    if (!verification) throw new Error('missing verification fixture');
    verification.notes = null;
    await execute('u1', { kind: 'RELEASE_DRAWER', sessionId });
    const before = host.db.commands.length;
    await expect(
      execute('u2', { kind: 'CLOSE', sessionId }),
    ).rejects.toMatchObject({ code: 'CASH_DISCREPANCY_NOTES_REQUIRED' });
    expect(host.db.closings).toHaveLength(0);
    expect(host.db.commands).toHaveLength(before);
    expect(host.db.sessions[0].status).toBe('SUBMITTED');
  });
});
