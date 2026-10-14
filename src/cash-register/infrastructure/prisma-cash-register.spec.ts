/**
 * cash-register-closing / T3 — transactional adapter behavior (S1–S8).
 *
 * Business-level proof through the PUBLIC ports only:
 *   - `ICashApplication.execute` / `.query`
 *   - `ICashLedger.assertOpenSession` / `.recordPayments` / `.recordRefund`
 *
 * The in-memory fake `TenantPrismaService` (rollback-aware transaction state
 * and real CASL abilities) now lives in `prisma-cash-register.test-support.ts`
 * and is shared with the S3 security spec. There is no PostgreSQL roundtrip
 * here; mock/unit tests do not prove PG races. The parent's T6 isolated-DB
 * proof is still required for that.
 */
import { randomUUID } from 'crypto';
import type { PrismaCashRegisterApplication } from './prisma-cash-register';
import {
  actor,
  asItems,
  asJson,
  makeApp,
  seedActors,
} from './prisma-cash-register.test-support';
import type { Host } from './prisma-cash-register.test-support';

// ── Tests ───────────────────────────────────────────────────────────────

describe('PrismaCashRegisterApplication — register + session lifecycle (S1,S3,S8)', () => {
  it('creates a register and rejects a duplicate name without a partial write', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1']);

    const created = await app.execute(
      actor('u1'),
      { kind: 'CREATE_REGISTER', name: '  Caja Norte  ' },
      randomUUID(),
    );
    expect(asJson(created).name).toBe('Caja Norte');

    await expect(
      app.execute(
        actor('u1'),
        { kind: 'CREATE_REGISTER', name: 'Caja Norte' },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'CASH_REGISTER_NAME_CONFLICT' });
    expect(host.db.registers).toHaveLength(1);
  });

  it('opens a session only with an explicit confirmation and hides expected values', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1']);
    const register = asJson(
      await app.execute(
        actor('u1'),
        { kind: 'CREATE_REGISTER', name: 'Caja 1' },
        randomUUID(),
      ),
    );
    const registerId = register.id as string;

    await expect(
      app.execute(
        actor('u1'),
        {
          kind: 'OPEN_SESSION',
          registerId,
          openingCents: 10000,
          openingConfirmed: false,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'CASH_OPENING_NOT_CONFIRMED' });
    expect(host.db.sessions).toHaveLength(0);

    const opened = asJson(
      await app.execute(
        actor('u1'),
        {
          kind: 'OPEN_SESSION',
          registerId,
          openingCents: 10000,
          openingConfirmed: true,
        },
        randomUUID(),
      ),
    );
    const session = asJson(opened.session);
    expect(session.blind).toBe(true);
    expect(session.expectedCashCents).toBeUndefined();
  });

  it('fails closed on an unknown/cross-tenant register before returning details', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1']);
    await expect(
      app.execute(
        actor('u1'),
        {
          kind: 'OPEN_SESSION',
          registerId: 'missing-register',
          openingCents: 0,
          openingConfirmed: true,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'CASH_REGISTER_NOT_FOUND' });
  });

  it('blocks a second unreleased session on the same register', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1']);
    const registerId = asJson(
      await app.execute(
        actor('u1'),
        { kind: 'CREATE_REGISTER', name: 'Caja 2' },
        randomUUID(),
      ),
    ).id as string;
    await app.execute(
      actor('u1'),
      {
        kind: 'OPEN_SESSION',
        registerId,
        openingCents: 0,
        openingConfirmed: true,
      },
      randomUUID(),
    );
    await expect(
      app.execute(
        actor('u1'),
        {
          kind: 'OPEN_SESSION',
          registerId,
          openingCents: 0,
          openingConfirmed: true,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'CASH_REGISTER_UNRELEASED_SESSION' });
    expect(host.db.sessions).toHaveLength(1);
  });
});

describe('PrismaCashRegisterApplication — idempotency (S8)', () => {
  it('replays an exact request without a second state change', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1']);
    const key = randomUUID();
    const first = await app.execute(
      actor('u1'),
      { kind: 'CREATE_REGISTER', name: 'Caja Replay' },
      key,
    );
    const second = await app.execute(
      actor('u1'),
      { kind: 'CREATE_REGISTER', name: 'Caja Replay' },
      key,
    );
    expect(second).toEqual(first);
    expect(host.db.registers).toHaveLength(1);
    expect(host.db.commands).toHaveLength(1);
  });

  it('conflicts when the same key carries a different payload', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1']);
    const key = randomUUID();
    await app.execute(
      actor('u1'),
      { kind: 'CREATE_REGISTER', name: 'Caja A' },
      key,
    );
    await expect(
      app.execute(
        actor('u1'),
        { kind: 'CREATE_REGISTER', name: 'Caja B' },
        key,
      ),
    ).rejects.toMatchObject({ code: 'CASH_IDEMPOTENCY_CONFLICT' });
    expect(host.db.registers).toHaveLength(1);
  });

  it('rejects a blank or oversized key', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1']);
    await expect(
      app.execute(
        actor('u1'),
        { kind: 'CREATE_REGISTER', name: 'Caja C' },
        '   ',
      ),
    ).rejects.toMatchObject({ code: 'CASH_IDEMPOTENCY_KEY_REQUIRED' });
    await expect(
      app.execute(
        actor('u1'),
        { kind: 'CREATE_REGISTER', name: 'Caja C' },
        'k'.repeat(201),
      ),
    ).rejects.toMatchObject({ code: 'CASH_IDEMPOTENCY_KEY_TOO_LONG' });
  });

  it('leaves no command record or session when a command fails', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1']);
    await expect(
      app.execute(
        actor('u1'),
        {
          kind: 'OPEN_SESSION',
          registerId: 'x',
          openingCents: 0,
          openingConfirmed: true,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'CASH_REGISTER_NOT_FOUND' });
    expect(host.db.commands).toHaveLength(0);
    expect(host.db.sessions).toHaveLength(0);
  });
});

describe('PrismaCashRegisterApplication — manual movements (S6)', () => {
  async function openSession(
    app: PrismaCashRegisterApplication,
    host: Host,
    userId = 'u1',
  ): Promise<string> {
    seedActors(host, [userId]);
    const registerId = asJson(
      await app.execute(
        actor(userId),
        { kind: 'CREATE_REGISTER', name: `Caja ${randomUUID()}` },
        randomUUID(),
      ),
    ).id as string;
    const opened = asJson(
      await app.execute(
        actor(userId),
        {
          kind: 'OPEN_SESSION',
          registerId,
          openingCents: 1000,
          openingConfirmed: true,
        },
        randomUUID(),
      ),
    );
    return asJson(opened.session).id as string;
  }

  it('records a CASH_IN with a server-generated source and a reason', async () => {
    const { app, host } = makeApp();
    const sessionId = await openSession(app, host);
    const result = asJson(
      await app.execute(
        actor('u1'),
        { kind: 'CASH_IN', sessionId, amountCents: 500, reason: 'change' },
        randomUUID(),
      ),
    );
    expect(result.kind).toBe('CASH_IN');
    expect(result.deltaCents).toBe(500);
    expect(host.db.movements[0].sourceType).toBe('MANUAL');
    expect(typeof host.db.movements[0].sourceId).toBe('string');
  });

  it('requires a reason and rejects a zero movement', async () => {
    const { app, host } = makeApp();
    const sessionId = await openSession(app, host);
    await expect(
      app.execute(
        actor('u1'),
        { kind: 'CASH_OUT', sessionId, amountCents: 100, reason: '   ' },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'CASH_IDENTITY_REQUIRED' });
    expect(host.db.movements).toHaveLength(0);
    await expect(
      app.execute(
        actor('u1'),
        { kind: 'CASH_OUT', sessionId, amountCents: 0, reason: 'noop' },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'CASH_MOVEMENT_ZERO_DELTA' });
    expect(host.db.movements).toHaveLength(0);
  });

  it('rejects a manual movement on a session the actor does not own', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u2']);
    const sessionId = await openSession(app, host);
    await expect(
      app.execute(
        actor('u2'),
        { kind: 'CASH_IN', sessionId, amountCents: 100, reason: 'x' },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'CASH_SESSION_NOT_OWNED' });
    expect(host.db.movements).toHaveLength(0);
  });
});

describe('PrismaCashRegisterApplication — blind declaration (S4)', () => {
  async function openWithCash(
    app: PrismaCashRegisterApplication,
    host: Host,
    openingCents = 1000,
  ): Promise<string> {
    seedActors(host, ['u1', 'u2', 'u3']);
    const registerId = asJson(
      await app.execute(
        actor('u1'),
        { kind: 'CREATE_REGISTER', name: `Caja ${randomUUID()}` },
        randomUUID(),
      ),
    ).id as string;
    const opened = asJson(
      await app.execute(
        actor('u1'),
        {
          kind: 'OPEN_SESSION',
          registerId,
          openingCents,
          openingConfirmed: true,
        },
        randomUUID(),
      ),
    );
    return asJson(opened.session).id as string;
  }

  it('persists the first discrepant declaration before any notes and stays SUBMITTED', async () => {
    const { app, host } = makeApp();
    const sessionId = await openWithCash(app, host);
    await app.execute(
      actor('u1'),
      { kind: 'START_COUNT', sessionId },
      randomUUID(),
    );

    const declared = asJson(
      await app.execute(
        actor('u1'),
        {
          kind: 'DECLARE',
          sessionId,
          lines: [{ channelKey: 'CASH', amountCents: 900 }],
        },
        randomUUID(),
      ),
    );
    expect(declared.status).toBe('SUBMITTED');
    expect(asJson(declared.comparison).requiresDeclarationNotes).toBe(true);
    expect(host.db.counts).toHaveLength(1);
    expect(host.db.sessions[0].status).toBe('SUBMITTED');
  });

  it('appends an immutable notes revision preserving the first declaration', async () => {
    const { app, host } = makeApp();
    const sessionId = await openWithCash(app, host);
    await app.execute(
      actor('u1'),
      { kind: 'START_COUNT', sessionId },
      randomUUID(),
    );
    await app.execute(
      actor('u1'),
      {
        kind: 'DECLARE',
        sessionId,
        lines: [{ channelKey: 'CASH', amountCents: 900 }],
      },
      randomUUID(),
    );
    await app.execute(
      actor('u1'),
      { kind: 'ANNOTATE_DECLARATION', sessionId, notes: 'faltó vuelto' },
      randomUUID(),
    );
    const declarations = host.db.counts.filter((c) => c.kind === 'DECLARATION');
    expect(declarations).toHaveLength(2);
    expect(declarations[0].revision).toBe(1);
    expect(declarations[0].amount0 ?? declarations[0].linesJson).toBeDefined();
    expect(declarations[1].revision).toBe(2);
    expect(declarations[1].notes).toBe('faltó vuelto');
    expect(declarations[1].linesJson).toEqual(declarations[0].linesJson);
  });

  it('hides expected values from the declarant even with audit visibility', async () => {
    const { app, host } = makeApp();
    const sessionId = await openWithCash(app, host, 1000);
    const before = asJson(
      await app.query(actor('u1'), { kind: 'SESSION', id: sessionId }),
    );
    expect(asJson(before.session).expectedCashCents).toBeUndefined();

    await app.execute(
      actor('u1'),
      { kind: 'START_COUNT', sessionId },
      randomUUID(),
    );
    await app.execute(
      actor('u1'),
      {
        kind: 'DECLARE',
        sessionId,
        lines: [{ channelKey: 'CASH', amountCents: 1000 }],
      },
      randomUUID(),
    );
    const after = asJson(
      await app.query(actor('u1'), { kind: 'SESSION', id: sessionId }),
    );
    expect(asJson(after.session).expectedCashCents).toBe(1000);
  });

  it('rejects a count that omits the required cash channel', async () => {
    const { app, host } = makeApp();
    const sessionId = await openWithCash(app, host);
    await app.execute(
      actor('u1'),
      { kind: 'START_COUNT', sessionId },
      randomUUID(),
    );
    await expect(
      app.execute(
        actor('u1'),
        { kind: 'DECLARE', sessionId, lines: [] },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'CASH_COUNT_EMPTY' });
    expect(host.db.counts).toHaveLength(0);
  });
});

describe('PrismaCashRegisterApplication — verification and closing (S2,S5,S7)', () => {
  interface Lifecycle {
    app: PrismaCashRegisterApplication;
    host: Host;
    sessionId: string;
  }

  async function runToVerified(): Promise<Lifecycle> {
    const { app, host } = makeApp();
    seedActors(host, ['u1', 'u2']);
    const registerId = asJson(
      await app.execute(
        actor('u1'),
        { kind: 'CREATE_REGISTER', name: `Caja ${randomUUID()}` },
        randomUUID(),
      ),
    ).id as string;
    const opened = asJson(
      await app.execute(
        actor('u1'),
        {
          kind: 'OPEN_SESSION',
          registerId,
          openingCents: 1000,
          openingConfirmed: true,
        },
        randomUUID(),
      ),
    );
    const sessionId = asJson(opened.session).id as string;
    await app.execute(
      actor('u1'),
      { kind: 'START_COUNT', sessionId },
      randomUUID(),
    );
    await app.execute(
      actor('u1'),
      {
        kind: 'DECLARE',
        sessionId,
        lines: [{ channelKey: 'CASH', amountCents: 1000 }],
      },
      randomUUID(),
    );
    await app.execute(
      actor('u2'),
      {
        kind: 'VERIFY',
        sessionId,
        lines: [{ channelKey: 'CASH', amountCents: 1000 }],
      },
      randomUUID(),
    );
    return { app, host, sessionId };
  }

  it('denies self verification and disallows a second verification', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1', 'u2']);
    const registerId = asJson(
      await app.execute(
        actor('u1'),
        { kind: 'CREATE_REGISTER', name: `Caja ${randomUUID()}` },
        randomUUID(),
      ),
    ).id as string;
    const sessionId = asJson(
      asJson(
        await app.execute(
          actor('u1'),
          {
            kind: 'OPEN_SESSION',
            registerId,
            openingCents: 1000,
            openingConfirmed: true,
          },
          randomUUID(),
        ),
      ).session,
    ).id as string;
    await app.execute(
      actor('u1'),
      { kind: 'START_COUNT', sessionId },
      randomUUID(),
    );
    await app.execute(
      actor('u1'),
      {
        kind: 'DECLARE',
        sessionId,
        lines: [{ channelKey: 'CASH', amountCents: 1000 }],
      },
      randomUUID(),
    );
    await expect(
      app.execute(
        actor('u1'),
        {
          kind: 'VERIFY',
          sessionId,
          lines: [{ channelKey: 'CASH', amountCents: 1000 }],
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'CASH_SELF_VERIFICATION_FORBIDDEN' });
    await app.execute(
      actor('u2'),
      {
        kind: 'VERIFY',
        sessionId,
        lines: [{ channelKey: 'CASH', amountCents: 1000 }],
      },
      randomUUID(),
    );
    await expect(
      app.execute(
        actor('u2'),
        {
          kind: 'VERIFY',
          sessionId,
          lines: [{ channelKey: 'CASH', amountCents: 1000 }],
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'CASH_ALREADY_VERIFIED' });
  });

  it('closes with an immutable per-channel snapshot and a stable same-key replay', async () => {
    const { app, host, sessionId } = await runToVerified();
    await app.execute(
      actor('u1'),
      {
        kind: 'CREATE_HANDOVER',
        sessionId,
        handoverKind: 'FLOAT',
        recipientUserId: 'u1',
        declaredCents: 1000,
      },
      randomUUID(),
    );
    const handoverId = host.db.handovers[0].id as string;
    await app.execute(
      actor('u1'),
      { kind: 'RECEIVE_HANDOVER', id: handoverId, receivedCents: 1000 },
      randomUUID(),
    );
    await app.execute(
      actor('u1'),
      { kind: 'RELEASE_DRAWER', sessionId },
      randomUUID(),
    );

    const closeKey = randomUUID();
    const closed = asJson(
      await app.execute(actor('u2'), { kind: 'CLOSE', sessionId }, closeKey),
    );
    expect(closed.folio).toMatch(/^CC-/);
    const snapshot = asJson(closed.snapshot);
    expect(snapshot.sessionId).toBe(sessionId);
    expect(snapshot.folio).toBe(closed.folio);
    const channels = asItems(snapshot.channels);
    expect(channels.some((c) => c.channelKey === 'CASH')).toBe(true);
    expect(asJson(snapshot.handovers)).toBeDefined();

    const replay = await app.execute(
      actor('u2'),
      { kind: 'CLOSE', sessionId },
      closeKey,
    );
    expect(asJson(replay).folio).toBe(closed.folio);
    expect(host.db.closings).toHaveLength(1);
    expect(host.db.sessions[0].status).toBe('CLOSED');
  });

  it('blocks closing before the drawer is released or without verification', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1', 'u2']);
    const registerId = asJson(
      await app.execute(
        actor('u1'),
        { kind: 'CREATE_REGISTER', name: `Caja ${randomUUID()}` },
        randomUUID(),
      ),
    ).id as string;
    const sessionId = asJson(
      asJson(
        await app.execute(
          actor('u1'),
          {
            kind: 'OPEN_SESSION',
            registerId,
            openingCents: 0,
            openingConfirmed: true,
          },
          randomUUID(),
        ),
      ).session,
    ).id as string;
    await app.execute(
      actor('u1'),
      { kind: 'START_COUNT', sessionId },
      randomUUID(),
    );
    await app.execute(
      actor('u1'),
      {
        kind: 'DECLARE',
        sessionId,
        lines: [{ channelKey: 'CASH', amountCents: 0 }],
      },
      randomUUID(),
    );
    await expect(
      app.execute(actor('u2'), { kind: 'CLOSE', sessionId }, randomUUID()),
    ).rejects.toMatchObject({ code: 'CASH_DRAWER_NOT_RELEASED' });
    await app.execute(
      actor('u1'),
      { kind: 'RELEASE_DRAWER', sessionId },
      randomUUID(),
    );
    await expect(
      app.execute(actor('u2'), { kind: 'CLOSE', sessionId }, randomUUID()),
    ).rejects.toMatchObject({ code: 'CASH_VERIFICATION_REQUIRED' });
  });
});

describe('PrismaCashRegisterApplication — custody (S2,S5)', () => {
  async function toSubmitted(): Promise<Lifecycle2> {
    const { app, host } = makeApp();
    seedActors(host, ['u1', 'u2', 'u3']);
    const registerId = asJson(
      await app.execute(
        actor('u1'),
        { kind: 'CREATE_REGISTER', name: `Caja ${randomUUID()}` },
        randomUUID(),
      ),
    ).id as string;
    const sessionId = asJson(
      asJson(
        await app.execute(
          actor('u1'),
          {
            kind: 'OPEN_SESSION',
            registerId,
            openingCents: 1000,
            openingConfirmed: true,
          },
          randomUUID(),
        ),
      ).session,
    ).id as string;
    await app.execute(
      actor('u1'),
      { kind: 'START_COUNT', sessionId },
      randomUUID(),
    );
    await app.execute(
      actor('u1'),
      {
        kind: 'DECLARE',
        sessionId,
        lines: [{ channelKey: 'CASH', amountCents: 1000 }],
      },
      randomUUID(),
    );
    return { app, host, sessionId };
  }

  it('rejects a self withdrawal and accepts an explicit self float', async () => {
    const { app, host, sessionId } = await toSubmitted();
    await expect(
      app.execute(
        actor('u1'),
        {
          kind: 'CREATE_HANDOVER',
          sessionId,
          handoverKind: 'WITHDRAWAL',
          recipientUserId: 'u1',
          declaredCents: 100,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'CASH_HANDOVER_SELF_WITHDRAWAL' });
    await app.execute(
      actor('u1'),
      {
        kind: 'CREATE_HANDOVER',
        sessionId,
        handoverKind: 'FLOAT',
        recipientUserId: 'u1',
        declaredCents: 1000,
      },
      randomUUID(),
    );
    expect(host.db.handovers).toHaveLength(1);
  });

  it('cannot allocate more than the counted cash', async () => {
    const { app, host, sessionId } = await toSubmitted();
    await expect(
      app.execute(
        actor('u1'),
        {
          kind: 'CREATE_HANDOVER',
          sessionId,
          handoverKind: 'WITHDRAWAL',
          recipientUserId: 'u2',
          declaredCents: 1500,
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'CASH_HANDOVER_ALLOCATION_EXCEEDED' });
    expect(host.db.handovers).toHaveLength(0);
  });

  it('requires the receipt actor to be the designated recipient and a note on difference', async () => {
    const { app, host, sessionId } = await toSubmitted();
    await app.execute(
      actor('u1'),
      {
        kind: 'CREATE_HANDOVER',
        sessionId,
        handoverKind: 'WITHDRAWAL',
        recipientUserId: 'u2',
        declaredCents: 1000,
      },
      randomUUID(),
    );
    const handoverId = host.db.handovers[0].id as string;
    await expect(
      app.execute(
        actor('u3'),
        { kind: 'RECEIVE_HANDOVER', id: handoverId, receivedCents: 1000 },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'CASH_HANDOVER_RECIPIENT_INVALID' });
    expect(host.db.handovers[0].createdAt).toBeInstanceOf(Date);
    expect(host.db.handovers[0].receivedAt).toBeNull();
    await expect(
      app.execute(
        actor('u2'),
        { kind: 'RECEIVE_HANDOVER', id: handoverId, receivedCents: 900 },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'CASH_RECEIPT_NOTES_REQUIRED' });
    const received = asJson(
      await app.execute(
        actor('u2'),
        {
          kind: 'RECEIVE_HANDOVER',
          id: handoverId,
          receivedCents: 900,
          notes: 'faltante',
        },
        randomUUID(),
      ),
    );
    expect(received.receivedCents).toBe(900);
    expect(received.declaredCents).toBe(1000);
  });
});

interface Lifecycle2 {
  app: PrismaCashRegisterApplication;
  host: Host;
  sessionId: string;
}

describe('PrismaCashRegisterApplication — ledger (S6,S8)', () => {
  async function openLedgerSession(): Promise<{
    app: PrismaCashRegisterApplication;
    host: Host;
    tenantPrisma: ReturnType<typeof makeApp>['tenantPrisma'];
    sessionId: string;
  }> {
    const { app, host, tenantPrisma } = makeApp();
    seedActors(host, ['u1']);
    const registerId = asJson(
      await app.execute(
        actor('u1'),
        { kind: 'CREATE_REGISTER', name: `Caja ${randomUUID()}` },
        randomUUID(),
      ),
    ).id as string;
    const sessionId = asJson(
      asJson(
        await app.execute(
          actor('u1'),
          {
            kind: 'OPEN_SESSION',
            registerId,
            openingCents: 0,
            openingConfirmed: true,
          },
          randomUUID(),
        ),
      ).session,
    ).id as string;
    return { app, host, tenantPrisma, sessionId };
  }

  it('requires an ambient transaction', async () => {
    const { app, sessionId } = await openLedgerSession();
    await expect(app.assertOpenSession(sessionId, 'u1')).rejects.toMatchObject({
      code: 'CASH_LEDGER_OUTSIDE_TRANSACTION',
    });
  });

  it('records tender 50000 / change 15000 as a 35000 net with one change', async () => {
    const { app, host, tenantPrisma, sessionId } = await openLedgerSession();
    await tenantPrisma.runInTransaction(async () => {
      await app.assertOpenSession(sessionId, 'u1');
      await app.recordPayments({
        sessionId,
        actorId: 'u1',
        saleId: 'sale-1',
        payments: [{ paymentId: 'p1', method: 'cash', amountCents: 50000 }],
        changeDueCents: 15000,
        occurredAt: new Date(),
      });
    });
    const deltas = host.db.movements.map((m) => m.deltaCents as number);
    expect(deltas.reduce((a, b) => a + b, 0)).toBe(35000);
    expect(
      host.db.movements.filter((m) => m.kind === 'SALE_CHANGE'),
    ).toHaveLength(1);
  });

  it('maps a non-cash catalog snapshot and skips zero-value tender rows', async () => {
    const { app, host, tenantPrisma, sessionId } = await openLedgerSession();
    await tenantPrisma.runInTransaction(async () => {
      await app.recordPayments({
        sessionId,
        actorId: 'u1',
        saleId: 'sale-2',
        payments: [
          { paymentId: 'p1', method: 'cash', amountCents: 100 },
          {
            paymentId: 'p2',
            method: 'card_credit',
            amountCents: 200,
            metadataJson: {
              catalog: { paymentMethodId: 'pm-1', name: 'Visa' },
            },
          },
          { paymentId: 'p3', method: 'transfer', amountCents: 0 },
        ],
        changeDueCents: 0,
        occurredAt: new Date(),
      });
    });
    const card = host.db.movements.find((m) => m.sourceId === 'p2');
    expect(card?.channelKey).toBe('PM:pm-1');
    expect(card?.channelLabel).toBe('Visa');
    expect(host.db.movements.some((m) => m.sourceId === 'p3')).toBe(false);
  });

  it('accepts an empty payment batch with zero change as a validated no-op', async () => {
    const { app, host, tenantPrisma, sessionId } = await openLedgerSession();
    await tenantPrisma.runInTransaction(async () => {
      await app.recordPayments({
        sessionId,
        actorId: 'u1',
        saleId: 'sale-credit',
        payments: [],
        changeDueCents: 0,
        occurredAt: new Date(),
      });
    });
    expect(host.db.movements).toHaveLength(0);
  });

  it('records an actual refund bound to the session and fails a duplicate settlement', async () => {
    const { app, host, tenantPrisma, sessionId } = await openLedgerSession();
    const occurredAt = new Date('2020-01-01T00:00:00.000Z');
    await tenantPrisma.runInTransaction(async () => {
      await app.recordRefund({
        sessionId,
        actorId: 'u1',
        settlementId: 's-1',
        amountCents: 250,
        method: 'cash',
        occurredAt,
      });
    });
    expect(host.db.movements[0].sourceType).toBe('REFUND');
    expect(host.db.movements[0].deltaCents).toBe(-250);
    expect(host.db.movements[0].occurredAt).toEqual(occurredAt);

    await expect(
      tenantPrisma.runInTransaction(() =>
        app.recordRefund({
          sessionId,
          actorId: 'u1',
          settlementId: 's-1',
          amountCents: 250,
          method: 'cash',
          occurredAt,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CASH_MOVEMENT_DUPLICATE_SOURCE' });
    expect(host.db.movements).toHaveLength(1);
  });

  it('fails closed when the ledger actor does not own the session', async () => {
    const { app, host, tenantPrisma, sessionId } = await openLedgerSession();
    seedActors(host, ['u9']);
    await expect(
      tenantPrisma.runInTransaction(() =>
        app.assertOpenSession(sessionId, 'u9'),
      ),
    ).rejects.toMatchObject({ code: 'CASH_SESSION_NOT_OWNED' });
  });
});

describe('PrismaCashRegisterApplication — queries (S4,S7)', () => {
  it('validates pagination and date boundaries', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1']);
    await expect(
      app.query(actor('u1'), { kind: 'SESSIONS', page: { limit: 101 } }),
    ).rejects.toMatchObject({ code: 'CASH_QUERY_INVALID_PAGE' });
    await expect(
      app.query(actor('u1'), {
        kind: 'SESSIONS',
        page: {
          from: '2026-01-02T00:00:00.000Z',
          to: '2026-01-01T00:00:00.000Z',
        },
      }),
    ).rejects.toMatchObject({ code: 'CASH_QUERY_RANGE_INVALID' });
    await expect(
      app.query(actor('u1'), {
        kind: 'SESSIONS',
        page: { from: '2026-01-01' },
      }),
    ).rejects.toMatchObject({ code: 'CASH_QUERY_DATE_INVALID' });
  });

  it('scopes session history to the owner unless the audit subject is held', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1', 'u2']);
    const registerId = asJson(
      await app.execute(
        actor('u1'),
        { kind: 'CREATE_REGISTER', name: `Caja ${randomUUID()}` },
        randomUUID(),
      ),
    ).id as string;
    await app.execute(
      actor('u1'),
      {
        kind: 'OPEN_SESSION',
        registerId,
        openingCents: 0,
        openingConfirmed: true,
      },
      randomUUID(),
    );
    const ownerView = asJson(
      await app.query(actor('u1'), { kind: 'SESSIONS', page: {} }),
    );
    expect(asItems(ownerView.items)).toHaveLength(1);
    const auditView = asJson(
      await app.query(
        actor('u2', [
          ['read', 'CashSession'],
          ['read', 'CashSessionAudit'],
        ]),
        { kind: 'SESSIONS', page: {} },
      ),
    );
    expect(asItems(auditView.items)).toHaveLength(1);
    const foreignView = asJson(
      await app.query(actor('u2', [['read', 'CashSession']]), {
        kind: 'SESSIONS',
        page: {},
      }),
    );
    expect(asItems(foreignView.items)).toHaveLength(0);
  });

  it('returns the frozen closing snapshot under the documented envelope', async () => {
    const { app, host } = makeApp();
    seedActors(host, ['u1', 'u2']);
    const registerId = asJson(
      await app.execute(
        actor('u1'),
        { kind: 'CREATE_REGISTER', name: `Caja ${randomUUID()}` },
        randomUUID(),
      ),
    ).id as string;
    const sessionId = asJson(
      asJson(
        await app.execute(
          actor('u1'),
          {
            kind: 'OPEN_SESSION',
            registerId,
            openingCents: 0,
            openingConfirmed: true,
          },
          randomUUID(),
        ),
      ).session,
    ).id as string;
    await app.execute(
      actor('u1'),
      { kind: 'START_COUNT', sessionId },
      randomUUID(),
    );
    await app.execute(
      actor('u1'),
      {
        kind: 'DECLARE',
        sessionId,
        lines: [{ channelKey: 'CASH', amountCents: 0 }],
      },
      randomUUID(),
    );
    await app.execute(
      actor('u2'),
      {
        kind: 'VERIFY',
        sessionId,
        lines: [{ channelKey: 'CASH', amountCents: 0 }],
      },
      randomUUID(),
    );
    await app.execute(
      actor('u1'),
      { kind: 'RELEASE_DRAWER', sessionId },
      randomUUID(),
    );
    const closed = asJson(
      await app.execute(
        actor('u2'),
        { kind: 'CLOSE', sessionId },
        randomUUID(),
      ),
    );
    const detail = asJson(
      await app.query(actor('u1'), {
        kind: 'CLOSING',
        id: closed.id as string,
      }),
    );
    expect(detail.id).toBe(closed.id);
    expect(detail.sessionId).toBe(sessionId);
    expect(detail.folio).toBe(closed.folio);
    expect(typeof detail.createdAt).toBe('string');
    const history = asJson(
      await app.query(actor('u1'), { kind: 'CLOSINGS', page: {} }),
    );
    expect(history.page).toBe(1);
    expect(history.limit).toBe(20);
    expect(history.total).toBe(1);
    expect(asItems(history.items)).toHaveLength(1);
  });
});
