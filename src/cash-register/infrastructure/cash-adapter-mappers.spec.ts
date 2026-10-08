/**
 * cash-register-closing / S10 — characterization of the row → document/domain
 * mappers (`cash-adapter-mappers`) and the validated JSON decoders
 * (`cash-json`) they call.
 *
 * Foundation spec: imports the pure domain vocabulary, the earlier `cash-json`
 * leaf and the mappers. No facade, no command/query handlers.
 */
import type {
  CashClosing,
  CashCount,
  CashHandover,
  CashMovement,
  CashRegister,
  CashSession,
} from '@prisma/client';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import { CASH_METHOD_LABELS } from '../domain';
import {
  CASH_METHOD_BY_LABEL,
  amountByChannel,
  cashLineCents,
  decodeClosingSnapshot,
  decodeCountLines,
  decodeDenominations,
  decodeExpectedSnapshot,
} from './cash-json';
import {
  closingDocument,
  countDocument,
  handoverDocument,
  movementDocument,
  registerDocument,
  toDomainMovement,
  toDomainSession,
} from './cash-adapter-mappers';

const MALFORMED = 'CASH_SNAPSHOT_MALFORMED';

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

const registerRow: CashRegister = {
  id: 'register-1',
  tenantId: 'tenant-a',
  name: 'Register A',
  isActive: true,
  createdAt: new Date('2025-01-01T10:00:00.000Z'),
  updatedAt: new Date('2025-01-02T10:00:00.000Z'),
};

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
    linesJson: [{ channelKey: 'CASH', amountCents: 9900 }],
    denominationsJson: null,
    notes: null,
    createdAt: new Date('2025-01-01T12:00:00.000Z'),
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
    receivedCents: 5000,
    notes: 'sent',
    receiptNotes: 'received',
    receivedAt: new Date('2025-01-01T13:00:00.000Z'),
    receivedByUserId: 'u2',
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
    snapshotJson: { total: 1 },
    createdAt: new Date('2025-01-01T14:00:00.000Z'),
    ...overrides,
  };
}

describe('cash-adapter-mappers — row to document', () => {
  it('Given a register row, when mapping, then only the public document fields survive', () => {
    expect(registerDocument(registerRow)).toEqual({
      id: 'register-1',
      name: 'Register A',
      isActive: true,
      createdAt: '2025-01-01T10:00:00.000Z',
    });
  });

  it('Given a closing row, when mapping, then the snapshot is embedded untouched', () => {
    const snapshot = { cashExpectedCents: 100 };
    expect(closingDocument(closingRow(), snapshot)).toEqual({
      id: 'closing-1',
      sessionId: 'session-1',
      folio: 'CC-1',
      createdAt: '2025-01-01T14:00:00.000Z',
      snapshot,
    });
  });

  it('Given a handover row, when mapping, then sender/receiver/receipt actors are explicit', () => {
    expect(handoverDocument(handoverRow())).toEqual({
      id: 'handover-1',
      sessionId: 'session-1',
      kind: 'WITHDRAWAL',
      declaredCents: 5000,
      receivedCents: 5000,
      senderUserId: 'u1',
      receiverUserId: 'u2',
      receiptActorUserId: 'u2',
      declaredAt: '2025-01-01T12:30:00.000Z',
      receivedAt: '2025-01-01T13:00:00.000Z',
      notes: 'sent',
      receiptNotes: 'received',
    });
  });

  it('Given a movement row, when mapping, then the method is normalized and time is ISO', () => {
    const doc = movementDocument(movementRow()) as Record<string, unknown>;
    expect(doc).toEqual({
      id: 'movement-1',
      kind: 'SALE_PAYMENT',
      deltaCents: 1000,
      method: 'CASH',
      channelKey: 'CASH',
      channelLabel: 'Efectivo',
      sourceType: 'PAYMENT',
      sourceId: 'payment-1',
      actorUserId: 'u1',
      reason: null,
      occurredAt: '2025-01-01T11:00:00.000Z',
    });
  });

  it('Given a count row, when mapping, then lines and denominations are decoded', () => {
    const doc = countDocument(
      countRow({
        denominationsJson: [{ denominationCents: 100, quantity: 3 }],
      }),
    ) as Record<string, unknown>;
    expect(doc.id).toBe('count-1');
    expect(doc.lines).toEqual([{ channelKey: 'CASH', amountCents: 9900 }]);
    expect(doc.denominations).toEqual([
      { denominationCents: 100, quantity: 3 },
    ]);
    expect(doc.createdAt).toBe('2025-01-01T12:00:00.000Z');
  });

  it('Given a malformed count row, when mapping, then it fails closed', () => {
    expectCode(
      () => countDocument(countRow({ linesJson: { bad: true } })),
      MALFORMED,
    );
  });
});

describe('cash-adapter-mappers — row to domain', () => {
  it('Given a session row, when mapping, then only the domain attributes are projected', () => {
    expect(
      toDomainSession(
        sessionRow({ frozenAt: new Date('2025-01-01T11:00:00.000Z') }),
      ),
    ).toEqual({
      id: 'session-1',
      tenantId: 'tenant-a',
      registerId: 'register-1',
      cashierUserId: 'u1',
      status: 'OPEN',
      openingCents: 10000,
      frozenAt: new Date('2025-01-01T11:00:00.000Z'),
      drawerReleasedAt: null,
    });
  });

  it('Given a non-cash movement row, when mapping, then the uppercase method is preserved', () => {
    expect(
      toDomainMovement(
        movementRow({
          method: 'CARD_CREDIT',
          channelKey: 'METHOD:CARD_CREDIT',
          channelLabel: CASH_METHOD_LABELS.CARD_CREDIT,
        }),
      ),
    ).toEqual({
      sessionId: 'session-1',
      deltaCents: 1000,
      method: 'CARD_CREDIT',
      channelKey: 'METHOD:CARD_CREDIT',
      channelLabel: CASH_METHOD_LABELS.CARD_CREDIT,
      kind: 'SALE_PAYMENT',
      sourceType: 'PAYMENT',
      sourceId: 'payment-1',
      reason: null,
    });
  });
});

describe('cash-json — validated decoders (direct characterization)', () => {
  const expectedSnapshot = {
    cashExpectedCents: 10000,
    frozenAt: '2025-01-01T10:00:00.000Z',
    channels: [
      {
        channelKey: 'CASH',
        channelLabel: CASH_METHOD_LABELS.CASH,
        method: 'CASH',
        expectedCents: 10000,
      },
    ],
  };

  it('Given a null frozen snapshot, when decoding, then null is returned', () => {
    expect(decodeExpectedSnapshot(null)).toBeNull();
  });

  it('Given a well-formed frozen snapshot, when decoding, then it round-trips', () => {
    expect(decodeExpectedSnapshot(expectedSnapshot)).toEqual(expectedSnapshot);
  });

  it('Given a malformed frozen snapshot, when decoding, then it fails closed', () => {
    expectCode(() => decodeExpectedSnapshot({ channels: 'nope' }), MALFORMED);
    expectCode(
      () =>
        decodeExpectedSnapshot({
          cashExpectedCents: 1,
          frozenAt: 'x',
          channels: [
            {
              channelKey: 'CASH',
              channelLabel: 'x',
              method: 'CREDIT',
              expectedCents: 1,
            },
          ],
        }),
      MALFORMED,
    );
  });

  it('Given count lines, when decoding, then only text channel and integer cents pass', () => {
    expect(
      decodeCountLines([{ channelKey: 'CASH', amountCents: 100 }]),
    ).toEqual([{ channelKey: 'CASH', amountCents: 100 }]);
    expectCode(() => decodeCountLines({}), MALFORMED);
    expectCode(() => decodeCountLines([{ channelKey: 'CASH' }]), MALFORMED);
  });

  it('Given denominations, when decoding, then null stays null and integers are required', () => {
    expect(decodeDenominations(null)).toBeNull();
    expect(
      decodeDenominations([{ denominationCents: 100, quantity: 2 }]),
    ).toEqual([{ denominationCents: 100, quantity: 2 }]);
    expectCode(
      () => decodeDenominations([{ denominationCents: 100, quantity: 1.5 }]),
      MALFORMED,
    );
    expectCode(() => decodeDenominations('nope'), MALFORMED);
  });

  it('Given a closing snapshot, when decoding, then a JSON object is required', () => {
    expect(decodeClosingSnapshot({ total: 1 })).toEqual({ total: 1 });
    expectCode(() => decodeClosingSnapshot([]), MALFORMED);
  });

  it('Given count lines, when folding, then channel amounts are keyed and cash is isolated', () => {
    const map = amountByChannel([
      { channelKey: 'CASH', amountCents: 1 },
      { channelKey: 'METHOD:CARD_CREDIT', amountCents: 2 },
    ]);
    expect(map.get('CASH')).toBe(1);
    expect(map.get('METHOD:CARD_CREDIT')).toBe(2);
    expect(map.get('MISSING')).toBeUndefined();
    expect(
      cashLineCents([{ channelKey: 'METHOD:CARD_CREDIT', amountCents: 5 }]),
    ).toBe(0);
    expect(cashLineCents([{ channelKey: 'CASH', amountCents: 7 }])).toBe(7);
  });

  it('Given the persisted method labels, when inverted, then labels map back to methods', () => {
    expect(CASH_METHOD_BY_LABEL[CASH_METHOD_LABELS.CASH]).toBe('CASH');
    expect(CASH_METHOD_BY_LABEL[CASH_METHOD_LABELS.CARD_CREDIT]).toBe(
      'CARD_CREDIT',
    );
    expect(CASH_METHOD_BY_LABEL[CASH_METHOD_LABELS.TRANSFER]).toBe('TRANSFER');
  });
});
