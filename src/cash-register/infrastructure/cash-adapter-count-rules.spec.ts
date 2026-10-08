/**
 * cash-register-closing / S10 — characterization of count/snapshot rules
 * (`cash-adapter-count-rules`).
 *
 * Pins the frozen expected snapshot, the latest declaration lookup, the
 * per-channel closing projection and the safe (non-rolling-back) comparison.
 */
import type { CashCount } from '@prisma/client';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import {
  CASH_METHOD_LABELS,
  CASH_RULE_CODES,
  CENTS_STORAGE_MAX,
  CENTS_STORAGE_MIN,
  POOLED_CASH_CHANNEL,
  type CashCountLine,
  type CashMovement,
} from '../domain';
import type { FrozenExpectedSnapshot } from './cash-json';
import {
  assertChannelExplanations,
  buildClosingChannels,
  buildExpectedSnapshot,
  cashCents,
  compareSafely,
  latestDeclaration,
} from './cash-adapter-count-rules';

const FROZEN_AT = new Date('2025-01-01T00:00:00.000Z');

function movement(overrides: Partial<CashMovement> = {}): CashMovement {
  return {
    sessionId: 'session-1',
    deltaCents: 5000,
    method: 'CASH',
    channelKey: 'CASH',
    channelLabel: CASH_METHOD_LABELS.CASH,
    kind: 'SALE_PAYMENT',
    sourceType: 'PAYMENT',
    sourceId: 'payment-1',
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
    linesJson: [{ channelKey: 'CASH', amountCents: 10 }],
    denominationsJson: null,
    notes: null,
    createdAt: FROZEN_AT,
    ...overrides,
  };
}

function expectedSnapshot(): FrozenExpectedSnapshot {
  return {
    cashExpectedCents: 15000,
    frozenAt: FROZEN_AT.toISOString(),
    channels: [
      {
        channelKey: 'CASH',
        channelLabel: CASH_METHOD_LABELS.CASH,
        method: 'CASH',
        expectedCents: 15000,
      },
      {
        channelKey: 'METHOD:CARD_CREDIT',
        channelLabel: CASH_METHOD_LABELS.CARD_CREDIT,
        method: 'CARD_CREDIT',
        expectedCents: 2000,
      },
    ],
  };
}

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

describe('cash-adapter-count-rules — buildExpectedSnapshot', () => {
  it('Given cash and card movements, when freezing, then CASH carries the opening fund and leads', () => {
    const snapshot = buildExpectedSnapshot(
      10000,
      [
        movement({ deltaCents: 5000 }),
        movement({
          method: 'CARD_CREDIT',
          channelKey: 'METHOD:CARD_CREDIT',
          channelLabel: CASH_METHOD_LABELS.CARD_CREDIT,
          deltaCents: 2000,
          sourceId: 'payment-2',
        }),
      ],
      FROZEN_AT,
    );
    expect(snapshot.cashExpectedCents).toBe(15000);
    expect(snapshot.channels.map((channel) => channel.channelKey)).toEqual([
      'CASH',
      'METHOD:CARD_CREDIT',
    ]);
    expect(snapshot.channels[1].expectedCents).toBe(2000);
    expect(snapshot.frozenAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('Given no cash movement, when freezing, then a pooled CASH channel holds the opening fund', () => {
    const snapshot = buildExpectedSnapshot(
      700,
      [
        movement({
          method: 'CARD_CREDIT',
          channelKey: 'METHOD:CARD_CREDIT',
          channelLabel: CASH_METHOD_LABELS.CARD_CREDIT,
          deltaCents: 200,
        }),
      ],
      FROZEN_AT,
    );
    expect(snapshot.channels[0]).toEqual({
      channelKey: POOLED_CASH_CHANNEL.channelKey,
      channelLabel: POOLED_CASH_CHANNEL.channelLabel,
      method: 'CASH',
      expectedCents: 700,
    });
    expect(snapshot.cashExpectedCents).toBe(700);
  });
});

describe('cash-adapter-count-rules — buildClosingChannels', () => {
  it('Given declared and verified lines, when projecting, then per-channel differences are exact', () => {
    const lines = buildClosingChannels(
      expectedSnapshot(),
      [
        { channelKey: 'CASH', amountCents: 14900 },
        { channelKey: 'METHOD:CARD_CREDIT', amountCents: 2000 },
      ],
      [{ channelKey: 'CASH', amountCents: 14950 }],
    );
    expect(lines[0]).toEqual({
      channelKey: 'CASH',
      channelLabel: CASH_METHOD_LABELS.CASH,
      method: 'CASH',
      expectedCents: 15000,
      declaredCents: 14900,
      verifiedCents: 14950,
      differenceCents: -100,
    });
    expect(lines[1].verifiedCents).toBeNull();
    expect(lines[1].differenceCents).toBe(0);
  });
});

describe('cash-adapter-count-rules — latestDeclaration', () => {
  it('Given declaration revisions, when looking up, then the highest declaration revision wins', () => {
    const latest = latestDeclaration([
      countRow({
        id: 'c1',
        linesJson: [{ channelKey: 'CASH', amountCents: 10 }],
      }),
      countRow({
        id: 'c2',
        revision: 2,
        linesJson: [{ channelKey: 'CASH', amountCents: 20 }],
      }),
      countRow({
        id: 'c3',
        kind: 'VERIFICATION',
        revision: 3,
        linesJson: [{ channelKey: 'CASH', amountCents: 30 }],
      }),
    ]);
    expect(latest).toEqual({
      id: 'c2',
      revision: 2,
      lines: [{ channelKey: 'CASH', amountCents: 20 }],
    });
  });

  it('Given no declarations, when looking up, then null is returned', () => {
    expect(latestDeclaration([])).toBeNull();
    expect(latestDeclaration([countRow({ kind: 'VERIFICATION' })])).toBeNull();
  });

  it('Given count lines, when reading cash, then only the CASH channel counts', () => {
    const cardOnly: CashCountLine[] = [
      { channelKey: 'METHOD:CARD_CREDIT', amountCents: 500 },
    ];
    expect(cashCents(cardOnly)).toBe(0);
    expect(cashCents([{ channelKey: 'CASH', amountCents: 123 }])).toBe(123);
  });
});

describe('cash-adapter-count-rules — assertChannelExplanations', () => {
  it('Given every frozen channel declared and verified, when explaining, then it passes', () => {
    expect(() =>
      assertChannelExplanations(
        expectedSnapshot(),
        [
          { channelKey: 'CASH', amountCents: 14900 },
          { channelKey: 'METHOD:CARD_CREDIT', amountCents: 2000 },
        ],
        [
          { channelKey: 'CASH', amountCents: 14900 },
          { channelKey: 'METHOD:CARD_CREDIT', amountCents: 2000 },
        ],
        'short by 100',
        null,
      ),
    ).not.toThrow();
  });

  it('Given a missing channel, when explaining, then it is rejected', () => {
    expectCode(
      () =>
        assertChannelExplanations(
          expectedSnapshot(),
          [
            { channelKey: 'CASH', amountCents: 15000 },
            { channelKey: 'METHOD:CARD_CREDIT', amountCents: 2000 },
          ],
          [{ channelKey: 'CASH', amountCents: 15000 }],
          null,
          null,
        ),
      CASH_RULE_CODES.COUNT_MISSING_CHANNEL,
    );
  });

  it('Given a declared difference without notes, when explaining, then it is rejected', () => {
    expectCode(
      () =>
        assertChannelExplanations(
          expectedSnapshot(),
          [
            { channelKey: 'CASH', amountCents: 14900 },
            { channelKey: 'METHOD:CARD_CREDIT', amountCents: 2000 },
          ],
          [
            { channelKey: 'CASH', amountCents: 14900 },
            { channelKey: 'METHOD:CARD_CREDIT', amountCents: 2000 },
          ],
          null,
          null,
        ),
      CASH_RULE_CODES.DISCREPANCY_NOTES_REQUIRED,
    );
  });
});

describe('cash-adapter-count-rules — compareSafely', () => {
  it('Given matching amounts, when comparing safely, then no discrepancy is reported', () => {
    const result = compareSafely({
      expectedCents: 100,
      declaredCents: 100,
      verifiedCents: 100,
      declarationNotes: null,
      verificationNotes: null,
    }) as Record<string, unknown>;
    expect(result.hasDiscrepancy).toBe(false);
    expect(result.requiresDeclarationNotes).toBe(false);
    expect(result.declarationDifferenceCents).toBe(0);
  });

  it('Given a declared difference without notes, when comparing safely, then it is reported instead of thrown', () => {
    const result = compareSafely({
      expectedCents: 100,
      declaredCents: 90,
      verifiedCents: null,
      declarationNotes: null,
      verificationNotes: null,
    }) as Record<string, unknown>;
    expect(result.hasDiscrepancy).toBe(true);
    expect(result.requiresDeclarationNotes).toBe(true);
    expect(result.requiresVerificationNotes).toBe(false);
    expect(result.notesRequired).toBe(true);
    expect(result.differenceCents).toBe(-10);
  });

  it('Given an amount outside the storage window, when comparing safely, then the difference is nulled', () => {
    const result = compareSafely({
      expectedCents: CENTS_STORAGE_MAX,
      declaredCents: CENTS_STORAGE_MIN,
      verifiedCents: null,
      declarationNotes: null,
      verificationNotes: null,
    }) as Record<string, unknown>;
    expect(result.hasDiscrepancy).toBe(true);
    expect(result.requiresDeclarationNotes).toBe(true);
    expect(result.differenceCents).toBeNull();
  });

  it('Given a non-integer amount, when comparing safely, then the malformed input still throws', () => {
    expectCode(
      () =>
        compareSafely({
          expectedCents: 100,
          declaredCents: 1.5,
          verifiedCents: null,
          declarationNotes: 'x',
          verificationNotes: null,
        }),
      CASH_RULE_CODES.CENTS_NOT_INTEGER,
    );
  });
});
