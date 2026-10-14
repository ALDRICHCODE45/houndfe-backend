/**
 * DOMAIN UNIT SPEC: cash-register closing policies (T1 / S2,S4,S5,S6,S7,S8).
 *
 * Pure-function coverage for the cash-register domain vocabulary:
 * money bounds, channel grouping, session lifecycle/freeze, blind count
 * projection, count validation, expected/declared/verified comparison,
 * movement policies, handover conservation and immutable closing snapshot.
 *
 * Every test exercises the PUBLIC exports of `./index` only — no Prisma,
 * no NestJS, no repository/controller. One test per requested rule.
 */
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import {
  CASH_RULE_CODES,
  CENTS_STORAGE_MAX,
  CENTS_STORAGE_MIN,
  POOLED_CASH_CHANNEL,
  addCents,
  assertCanFreezeSession,
  assertCashFullyAllocated,
  assertDrawerReleaseAllowed,
  assertHandoverReceipt,
  assertIndependentCloser,
  assertIndependentVerifier,
  assertIntegerCents,
  assertMovementBelongsToSession,
  assertMovementSourceUnique,
  assertNonNegativeCents,
  assertOperationalWriteAllowed,
  assertSessionTenant,
  assertStorageRangeCents,
  assertValidCashMovement,
  assertValidStatusTransition,
  classifyChannelCount,
  cloneCashClosingSnapshot,
  compareCashCounts,
  createCashClosingSnapshot,
  expectedCashCents,
  groupMovementsByChannel,
  isFirstDeclarationRevision,
  isFrozen,
  planChangeMovement,
  planChargeMovements,
  projectCashSession,
  requiredCountChannelKeys,
  resolveCashChannel,
  resolveOpeningFundCents,
  sumCents,
  validateCashCount,
  type CashChannel,
  type CashClosingSnapshot,
  type CashCountLine,
  type CashHandover,
  type CashHandoverKind,
  type CashMethod,
  type CashMovement,
  type CashSession,
} from './index';

/** Mutable mirror of the snapshot inputs so the test can prove deep copies. */
interface MutableChannelLine {
  channelKey: string;
  channelLabel: string;
  method: CashMethod;
  expectedCents: number;
  declaredCents: number;
  verifiedCents: number | null;
  differenceCents: number;
}

interface MutableHandover {
  handoverId: string;
  kind: CashHandoverKind;
  declaredCents: number;
  receivedCents: number | null;
  senderUserId: string;
  receiverUserId: string | null;
  receiptActorUserId: string | null;
  declaredAt: Date;
  receivedAt: Date | null;
}

// ── Fixtures ────────────────────────────────────────────────────────

function openSession(overrides: Partial<CashSession> = {}): CashSession {
  return {
    id: 'session-1',
    tenantId: 'tenant-1',
    registerId: 'register-1',
    cashierUserId: 'cashier-1',
    status: 'OPEN',
    openingCents: 10000,
    frozenAt: null,
    drawerReleasedAt: null,
    ...overrides,
  };
}

function movement(overrides: Partial<CashMovement> = {}): CashMovement {
  return {
    sessionId: 'session-1',
    deltaCents: 50000,
    method: 'CASH',
    channelKey: 'CASH',
    channelLabel: 'Efectivo',
    kind: 'SALE_PAYMENT',
    sourceType: 'PAYMENT',
    sourceId: 'payment-1',
    ...overrides,
  };
}

function expectRuleCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(BusinessRuleViolationError);
  expect((caught as BusinessRuleViolationError).code).toBe(code);
}

const cashChannel: CashChannel = { ...POOLED_CASH_CHANNEL };

// ── S6 — integer cents + storage bounds ─────────────────────────────

describe('cash-register money bounds (S6/S8)', () => {
  it('Given a non-integer cents value, when asserting integer cents, then it is rejected', () => {
    expectRuleCode(
      () => assertIntegerCents(150.5, 'deltaCents'),
      CASH_RULE_CODES.CENTS_NOT_INTEGER,
    );
    expectRuleCode(
      () => assertIntegerCents(Number.NaN, 'deltaCents'),
      CASH_RULE_CODES.CENTS_NOT_INTEGER,
    );
    expect(() => assertIntegerCents(150, 'deltaCents')).not.toThrow();
  });

  it('Given a negative count, when asserting non-negative cents, then it is rejected', () => {
    expectRuleCode(
      () => assertNonNegativeCents(-1, 'amountCents'),
      CASH_RULE_CODES.CENTS_NEGATIVE,
    );
    expect(() => assertNonNegativeCents(0, 'amountCents')).not.toThrow();
  });

  it('Given a value beyond the Int storage range, when asserting storage range, then it is rejected', () => {
    expectRuleCode(
      () => assertStorageRangeCents(CENTS_STORAGE_MAX + 1, 'amountCents'),
      CASH_RULE_CODES.CENTS_OUT_OF_RANGE,
    );
    expectRuleCode(
      () => assertStorageRangeCents(CENTS_STORAGE_MIN - 1, 'amountCents'),
      CASH_RULE_CODES.CENTS_OUT_OF_RANGE,
    );
    expect(() => assertStorageRangeCents(CENTS_STORAGE_MAX, 'a')).not.toThrow();
    expect(() => assertStorageRangeCents(CENTS_STORAGE_MIN, 'a')).not.toThrow();
  });

  it('Given two in-range amounts whose sum leaves storage range, when adding, then it is rejected as unsafe arithmetic', () => {
    expect(addCents(1000, 2500, 'total')).toBe(3500);
    expectRuleCode(
      () => addCents(CENTS_STORAGE_MAX, 1, 'total'),
      CASH_RULE_CODES.ARITHMETIC_OVERFLOW,
    );
  });

  it('Given a list of amounts, when summing, then it adds exactly and rejects overflow', () => {
    expect(sumCents([1000, -400, 150], 'total')).toBe(750);
    expectRuleCode(
      () => sumCents([CENTS_STORAGE_MAX, CENTS_STORAGE_MAX], 'total'),
      CASH_RULE_CODES.ARITHMETIC_OVERFLOW,
    );
  });
});

// ── S7 — channel identity + deterministic grouping ──────────────────

describe('cash-register channels (S7)', () => {
  it('Given a cash method with a catalog identity, when resolving the channel, then physical cash stays pooled', () => {
    const channel = resolveCashChannel({
      method: 'CASH',
      catalog: { paymentMethodId: 'pm-cash', name: 'Caja fuerte' },
    });
    expect(channel).toEqual(POOLED_CASH_CHANNEL);
    expect(channel.channelKey).toBe('CASH');
  });

  it('Given a non-cash catalog payment method, when resolving the channel, then key and label snapshot the catalog identity', () => {
    const channel = resolveCashChannel({
      method: 'TRANSFER',
      catalog: { paymentMethodId: 'pm-mp', name: 'Mercado Pago' },
    });
    expect(channel).toEqual({
      channelKey: 'PM:pm-mp',
      channelLabel: 'Mercado Pago',
      method: 'TRANSFER',
    });
  });

  it('Given a non-cash method without a catalog identity, when resolving the channel, then it falls back to the base method channel', () => {
    const channel = resolveCashChannel({ method: 'CARD_DEBIT' });
    expect(channel.channelKey).toBe('METHOD:CARD_DEBIT');
    expect(channel.channelLabel).toBe('Tarjeta de débito');
    expect(channel.method).toBe('CARD_DEBIT');
  });

  it('Given movements across cash and non-cash channels, when grouping, then cash is pooled and non-cash channels stay separate in deterministic order', () => {
    const totals = groupMovementsByChannel([
      movement({
        sourceId: 'p2',
        method: 'CARD_DEBIT',
        channelKey: 'METHOD:CARD_DEBIT',
        channelLabel: 'Tarjeta de débito',
        deltaCents: -2000,
        kind: 'REFUND_SETTLEMENT',
        sourceType: 'REFUND',
      }),
      movement({ sourceId: 'p1' }),
      movement({ sourceId: 'p3' }),
      movement({
        method: 'TRANSFER',
        channelKey: 'PM:pm-mp',
        channelLabel: 'Mercado Pago',
        deltaCents: 9000,
        sourceId: 'p4',
      }),
    ]);
    expect(totals.map((t) => t.channelKey)).toEqual([
      'CASH',
      'METHOD:CARD_DEBIT',
      'PM:pm-mp',
    ]);
    expect(totals[0]).toMatchObject({
      channelKey: 'CASH',
      channelLabel: 'Efectivo',
      method: 'CASH',
      totalCents: 100000,
      movementCount: 2,
    });
    expect(totals[1]).toMatchObject({ totalCents: -2000, movementCount: 1 });
    expect(totals[2]).toMatchObject({ totalCents: 9000, movementCount: 1 });
  });

  it('Given two movements sharing a channel key but not its label, when grouping, then the label conflict is rejected', () => {
    expectRuleCode(
      () =>
        groupMovementsByChannel([
          movement({ deltaCents: 100 }),
          movement({ sourceId: 'p9', deltaCents: 200, channelLabel: 'Otra' }),
        ]),
      CASH_RULE_CODES.CHANNEL_LABEL_CONFLICT,
    );
  });
});

// ── S5/S8 — lifecycle, freeze, independence, tenant ─────────────────

describe('cash-register session lifecycle (S2/S5/S8)', () => {
  it('Given the closing chain, when transitioning forward, then each step is allowed and skip/reverse is rejected', () => {
    expect(() => assertValidStatusTransition('OPEN', 'COUNTING')).not.toThrow();
    expect(() =>
      assertValidStatusTransition('COUNTING', 'SUBMITTED'),
    ).not.toThrow();
    expect(() =>
      assertValidStatusTransition('SUBMITTED', 'CLOSED'),
    ).not.toThrow();
    expectRuleCode(
      () => assertValidStatusTransition('OPEN', 'CLOSED'),
      CASH_RULE_CODES.INVALID_STATUS_TRANSITION,
    );
    expectRuleCode(
      () => assertValidStatusTransition('COUNTING', 'OPEN'),
      CASH_RULE_CODES.INVALID_STATUS_TRANSITION,
    );
    expectRuleCode(
      () => assertValidStatusTransition('CLOSED', 'COUNTING'),
      CASH_RULE_CODES.INVALID_STATUS_TRANSITION,
    );
  });

  it('Given a frozen or non-OPEN session, when checking operational writes, then writes are rejected after freeze', () => {
    expect(() => assertOperationalWriteAllowed(openSession())).not.toThrow();
    expectRuleCode(
      () =>
        assertOperationalWriteAllowed(openSession({ frozenAt: new Date() })),
      CASH_RULE_CODES.SESSION_NOT_WRITABLE,
    );
    expectRuleCode(
      () => assertOperationalWriteAllowed(openSession({ status: 'COUNTING' })),
      CASH_RULE_CODES.SESSION_NOT_WRITABLE,
    );
    expectRuleCode(
      () => assertOperationalWriteAllowed(openSession({ status: 'CLOSED' })),
      CASH_RULE_CODES.SESSION_NOT_WRITABLE,
    );
  });

  it('Given an open session, when freezing to count, then freeze is allowed once and rejected afterwards', () => {
    expect(() => assertCanFreezeSession(openSession())).not.toThrow();
    expectRuleCode(
      () => assertCanFreezeSession(openSession({ status: 'COUNTING' })),
      CASH_RULE_CODES.SESSION_NOT_WRITABLE,
    );
  });

  it('Given an open session, when reading the frozen flag, then it reflects status or frozenAt', () => {
    expect(isFrozen(openSession())).toBe(false);
    expect(isFrozen(openSession({ frozenAt: new Date() }))).toBe(true);
    expect(isFrozen(openSession({ status: 'SUBMITTED' }))).toBe(true);
  });

  it('Given the same person as cashier, when verifying, then self-verification is denied and a different verifier is allowed', () => {
    expectRuleCode(
      () =>
        assertIndependentVerifier({
          cashierUserId: 'cashier-1',
          verifierUserId: 'cashier-1',
        }),
      CASH_RULE_CODES.SELF_VERIFICATION_FORBIDDEN,
    );
    expect(() =>
      assertIndependentVerifier({
        cashierUserId: 'cashier-1',
        verifierUserId: 'manager-1',
      }),
    ).not.toThrow();
  });

  it('Given the same person as cashier, when closing, then self-closing is denied and a different closer is allowed', () => {
    expectRuleCode(
      () =>
        assertIndependentCloser({
          cashierUserId: 'cashier-1',
          closerUserId: 'cashier-1',
        }),
      CASH_RULE_CODES.SELF_CLOSING_FORBIDDEN,
    );
    expect(() =>
      assertIndependentCloser({
        cashierUserId: 'cashier-1',
        closerUserId: 'manager-1',
      }),
    ).not.toThrow();
  });

  it('Given a session of another tenant, when asserting tenant, then cross-tenant access fails closed', () => {
    expect(() =>
      assertSessionTenant({ session: openSession(), tenantId: 'tenant-1' }),
    ).not.toThrow();
    expectRuleCode(
      () =>
        assertSessionTenant({ session: openSession(), tenantId: 'tenant-2' }),
      CASH_RULE_CODES.TENANT_MISMATCH,
    );
  });

  it('Given revision numbers, when asking whether the count is a first blind declaration, then only revision 1 qualifies', () => {
    expect(isFirstDeclarationRevision(1)).toBe(true);
    expect(isFirstDeclarationRevision(2)).toBe(false);
  });
});

// ── S4 — blind projection ───────────────────────────────────────────

describe('cash-register blind projection (S4)', () => {
  it('Given the declarant has not submitted yet, when projecting with audit visibility, then expected and difference are removed', () => {
    const view = projectCashSession({
      session: openSession(),
      viewerUserId: 'cashier-1',
      expectedCashCents: 60000,
      declaredCents: 55000,
      hasAuditVisibility: true,
      declarationSubmitted: false,
    });
    expect(view.blind).toBe(true);
    expect('expectedCashCents' in view).toBe(false);
    expect('differenceCents' in view).toBe(false);
  });

  it('Given the declarant already submitted, when projecting, then expected and difference are revealed', () => {
    const view = projectCashSession({
      session: openSession(),
      viewerUserId: 'cashier-1',
      expectedCashCents: 60000,
      declaredCents: 55000,
      hasAuditVisibility: false,
      declarationSubmitted: true,
    });
    expect(view.blind).toBe(false);
    expect(view.expectedCashCents).toBe(60000);
    expect(view.differenceCents).toBe(-5000);
  });

  it('Given a non-declarant viewer, when projecting, then expected is gated by audit visibility while blind stays false', () => {
    const withoutAudit = projectCashSession({
      session: openSession(),
      viewerUserId: 'other-1',
      expectedCashCents: 60000,
      declaredCents: null,
      hasAuditVisibility: false,
      declarationSubmitted: false,
    });
    expect(withoutAudit.blind).toBe(false);
    expect('expectedCashCents' in withoutAudit).toBe(false);

    const withAudit = projectCashSession({
      session: openSession(),
      viewerUserId: 'other-1',
      expectedCashCents: 60000,
      declaredCents: null,
      hasAuditVisibility: true,
      declarationSubmitted: false,
    });
    expect(withAudit.expectedCashCents).toBe(60000);
  });
});

// ── S4/S6 — counts, coverage, missing vs zero, denominations ─────────

describe('cash-register count validation (S4/S6)', () => {
  const required = ['CASH', 'PM:pm-mp'];

  it('Given an empty count, when validating, then it is rejected as empty rather than treated as zero', () => {
    expectRuleCode(
      () => validateCashCount({ requiredChannelKeys: required, lines: [] }),
      CASH_RULE_CODES.COUNT_EMPTY,
    );
  });

  it('Given a repeated channel line, when validating, then unique channel coverage is enforced', () => {
    const lines: CashCountLine[] = [
      { channelKey: 'CASH', amountCents: 100 },
      { channelKey: 'CASH', amountCents: 200 },
      { channelKey: 'PM:pm-mp', amountCents: 0 },
    ];
    expectRuleCode(
      () =>
        validateCashCount({
          requiredChannelKeys: required,
          lines,
        }),
      CASH_RULE_CODES.COUNT_DUPLICATE_CHANNEL,
    );
  });

  it('Given an unexpected channel, when validating, then exact channel coverage is enforced', () => {
    const lines: CashCountLine[] = [
      { channelKey: 'CASH', amountCents: 100 },
      { channelKey: 'PM:pm-mp', amountCents: 0 },
      { channelKey: 'PM:other', amountCents: 50 },
    ];
    expectRuleCode(
      () => validateCashCount({ requiredChannelKeys: required, lines }),
      CASH_RULE_CODES.COUNT_UNKNOWN_CHANNEL,
    );
  });

  it('Given a required channel without a line, when validating, then it is reported missing rather than zero', () => {
    const lines: CashCountLine[] = [{ channelKey: 'CASH', amountCents: 100 }];
    expectRuleCode(
      () => validateCashCount({ requiredChannelKeys: required, lines }),
      CASH_RULE_CODES.COUNT_MISSING_CHANNEL,
    );
  });

  it('Given a full coverage count with an explicit zero, when validating, then zero is a real count distinct from missing', () => {
    const lines: CashCountLine[] = [
      { channelKey: 'PM:pm-mp', amountCents: 0 },
      { channelKey: 'CASH', amountCents: 10000 },
    ];
    const validated = validateCashCount({
      requiredChannelKeys: required,
      lines,
    });
    expect(validated.lines.map((l) => l.channelKey)).toEqual([
      'CASH',
      'PM:pm-mp',
    ]);
    expect(validated.cashCents).toBe(10000);
    expect(validated.totalCents).toBe(10000);
    expect(validated.amountByChannel.get('PM:pm-mp')).toBe(0);
  });

  it('Given a channel with no line, when classifying, then missing is distinguished from a counted zero', () => {
    const lines: CashCountLine[] = [
      { channelKey: 'CASH', amountCents: 0 },
      { channelKey: 'PM:pm-mp', amountCents: 500 },
    ];
    expect(classifyChannelCount(lines, 'CASH')).toBe('COUNTED_ZERO');
    expect(classifyChannelCount(lines, 'PM:pm-mp')).toBe('COUNTED_NONZERO');
    expect(classifyChannelCount(lines, 'PM:absent')).toBe('MISSING');
  });

  it('Given movements, when collecting required count channels, then CASH is always first and non-cash keys are unique and sorted', () => {
    const keys = requiredCountChannelKeys([
      movement({ sourceId: 'p1' }),
      movement({
        method: 'TRANSFER',
        channelKey: 'PM:z',
        channelLabel: 'Zeta',
        sourceId: 'p2',
      }),
      movement({
        method: 'TRANSFER',
        channelKey: 'PM:a',
        channelLabel: 'Alfa',
        sourceId: 'p3',
      }),
      movement({
        method: 'TRANSFER',
        channelKey: 'PM:z',
        channelLabel: 'Zeta',
        sourceId: 'p4',
      }),
    ]);
    expect(keys).toEqual(['CASH', 'PM:a', 'PM:z']);
  });

  it('Given invalid line amounts, when validating, then non-integer, negative or out-of-range counts are rejected', () => {
    expectRuleCode(
      () =>
        validateCashCount({
          requiredChannelKeys: required,
          lines: [
            { channelKey: 'CASH', amountCents: 1.5 },
            { channelKey: 'PM:pm-mp', amountCents: 0 },
          ],
        }),
      CASH_RULE_CODES.CENTS_NOT_INTEGER,
    );
    expectRuleCode(
      () =>
        validateCashCount({
          requiredChannelKeys: required,
          lines: [
            { channelKey: 'CASH', amountCents: -1 },
            { channelKey: 'PM:pm-mp', amountCents: 0 },
          ],
        }),
      CASH_RULE_CODES.CENTS_NEGATIVE,
    );
    expectRuleCode(
      () =>
        validateCashCount({
          requiredChannelKeys: required,
          lines: [
            { channelKey: 'CASH', amountCents: CENTS_STORAGE_MAX + 1 },
            { channelKey: 'PM:pm-mp', amountCents: 0 },
          ],
        }),
      CASH_RULE_CODES.CENTS_OUT_OF_RANGE,
    );
  });

  it('Given denominations whose total differs from the cash line, when validating, then the mismatch is rejected', () => {
    expectRuleCode(
      () =>
        validateCashCount({
          requiredChannelKeys: required,
          lines: [
            { channelKey: 'CASH', amountCents: 10000 },
            { channelKey: 'PM:pm-mp', amountCents: 0 },
          ],
          denominations: [
            { denominationCents: 5000, quantity: 1 },
            { denominationCents: 1000, quantity: 4 },
          ],
        }),
      CASH_RULE_CODES.DENOMINATION_SUM_MISMATCH,
    );
  });

  it('Given invalid denominations, when validating, then positive integer denomination and non-negative integer quantity are enforced', () => {
    const cashLines: CashCountLine[] = [
      { channelKey: 'CASH', amountCents: 10000 },
      { channelKey: 'PM:pm-mp', amountCents: 0 },
    ];
    expectRuleCode(
      () =>
        validateCashCount({
          requiredChannelKeys: required,
          lines: cashLines,
          denominations: [{ denominationCents: 0, quantity: 10 }],
        }),
      CASH_RULE_CODES.DENOMINATION_INVALID,
    );
    expectRuleCode(
      () =>
        validateCashCount({
          requiredChannelKeys: required,
          lines: cashLines,
          denominations: [{ denominationCents: 5000, quantity: -1 }],
        }),
      CASH_RULE_CODES.DENOMINATION_INVALID,
    );
  });

  it('Given denominations that sum to the cash line, when validating, then the count is accepted', () => {
    const validated = validateCashCount({
      requiredChannelKeys: required,
      lines: [
        { channelKey: 'CASH', amountCents: 10000 },
        { channelKey: 'PM:pm-mp', amountCents: 0 },
      ],
      denominations: [
        { denominationCents: 5000, quantity: 1 },
        { denominationCents: 1000, quantity: 5 },
      ],
    });
    expect(validated.cashCents).toBe(10000);
  });

  it('Given denominations supplied without a cash line, when validating, then a cash line is required', () => {
    expectRuleCode(
      () =>
        validateCashCount({
          requiredChannelKeys: ['PM:pm-mp'],
          lines: [{ channelKey: 'PM:pm-mp', amountCents: 0 }],
          denominations: [{ denominationCents: 1000, quantity: 1 }],
        }),
      CASH_RULE_CODES.DENOMINATION_CASH_LINE_REQUIRED,
    );
  });
});

// ── S2 — independent expected/declared/verified comparison ──────────

describe('cash-register expected/declared/verified comparison (S2)', () => {
  it('Given expected equals declared equals verified, when comparing, then no discrepancy or notes are required', () => {
    const comparison = compareCashCounts({
      expectedCents: 10000,
      declaredCents: 10000,
      verifiedCents: 10000,
    });
    expect(comparison.declarationDifferenceCents).toBe(0);
    expect(comparison.verificationDifferenceCents).toBe(0);
    expect(comparison.hasDiscrepancy).toBe(false);
    expect(comparison.requiresDeclarationNotes).toBe(false);
    expect(comparison.requiresVerificationNotes).toBe(false);
  });

  it('Given a declared difference without notes, when comparing, then an explanation is required', () => {
    expectRuleCode(
      () =>
        compareCashCounts({
          expectedCents: 10000,
          declaredCents: 9000,
          verifiedCents: null,
        }),
      CASH_RULE_CODES.DISCREPANCY_NOTES_REQUIRED,
    );
  });

  it('Given a verified difference without notes, when comparing, then an explanation is required', () => {
    expectRuleCode(
      () =>
        compareCashCounts({
          expectedCents: 10000,
          declaredCents: 10000,
          verifiedCents: 9500,
        }),
      CASH_RULE_CODES.DISCREPANCY_NOTES_REQUIRED,
    );
  });

  it('Given preserved differences with explanations, when comparing, then independent differences are returned', () => {
    const comparison = compareCashCounts({
      expectedCents: 10000,
      declaredCents: 9000,
      verifiedCents: 9200,
      declarationNotes: 'Faltan 100',
      verificationNotes: 'Recuento del encargado',
    });
    expect(comparison.declarationDifferenceCents).toBe(-1000);
    expect(comparison.verificationDifferenceCents).toBe(200);
    expect(comparison.verifiedVsExpectedDifferenceCents).toBe(-800);
    expect(comparison.requiresDeclarationNotes).toBe(true);
    expect(comparison.requiresVerificationNotes).toBe(true);
    expect(comparison.hasDiscrepancy).toBe(true);
  });

  it('Given a verification matching the declaration but differing from expected, when comparing, then only the declaration explanation is required', () => {
    const comparison = compareCashCounts({
      expectedCents: 10000,
      declaredCents: 9000,
      verifiedCents: 9000,
      declarationNotes: 'Faltan 100',
    });
    expect(comparison.requiresDeclarationNotes).toBe(true);
    expect(comparison.requiresVerificationNotes).toBe(false);
    expect(comparison.verifiedVsExpectedDifferenceCents).toBe(-1000);
  });

  it('Given a blank notes string, when comparing a discrepancy, then it is not accepted as an explanation', () => {
    expectRuleCode(
      () =>
        compareCashCounts({
          expectedCents: 10000,
          declaredCents: 9000,
          verifiedCents: null,
          declarationNotes: '   ',
        }),
      CASH_RULE_CODES.DISCREPANCY_NOTES_REQUIRED,
    );
  });
});

// ── S6/S8 — movement policies ───────────────────────────────────────

describe('cash-register movements (S6/S8)', () => {
  it('Given a valid payment movement, when validating, then it is accepted', () => {
    expect(() => assertValidCashMovement(movement())).not.toThrow();
  });

  it('Given a zero delta, when validating, then the meaningless movement is rejected', () => {
    expectRuleCode(
      () => assertValidCashMovement(movement({ deltaCents: 0 })),
      CASH_RULE_CODES.MOVEMENT_ZERO_DELTA,
    );
  });

  it('Given a delta whose sign contradicts the kind, when validating, then it is rejected', () => {
    expectRuleCode(
      () =>
        assertValidCashMovement(
          movement({
            kind: 'SALE_CHANGE',
            deltaCents: 5000,
            sourceType: 'SALE',
            sourceId: 'sale-1',
          }),
        ),
      CASH_RULE_CODES.MOVEMENT_SIGN_INVALID,
    );
    expectRuleCode(
      () => assertValidCashMovement(movement({ deltaCents: -5000 })),
      CASH_RULE_CODES.MOVEMENT_SIGN_INVALID,
    );
  });

  it('Given a movement whose source contradicts its kind, when validating, then source injection is rejected', () => {
    expectRuleCode(
      () =>
        assertValidCashMovement(
          movement({
            kind: 'CASH_IN',
            deltaCents: 1000,
            sourceType: 'SALE',
            sourceId: 'sale-1',
            reason: 'fondo',
          }),
        ),
      CASH_RULE_CODES.MOVEMENT_SOURCE_MISMATCH,
    );
  });

  it('Given a manual movement without a reason, when validating, then a reason is required', () => {
    expectRuleCode(
      () =>
        assertValidCashMovement(
          movement({
            kind: 'CASH_OUT',
            deltaCents: -1000,
            sourceType: 'MANUAL',
            sourceId: 'mov-1',
          }),
        ),
      CASH_RULE_CODES.MOVEMENT_REASON_REQUIRED,
    );
    expect(() =>
      assertValidCashMovement(
        movement({
          kind: 'CASH_OUT',
          deltaCents: -1000,
          sourceType: 'MANUAL',
          sourceId: 'mov-1',
          reason: 'Retiro a bóveda',
        }),
      ),
    ).not.toThrow();
  });

  it('Given a change movement on a non-cash channel, when validating, then it is rejected', () => {
    expectRuleCode(
      () =>
        assertValidCashMovement(
          movement({
            kind: 'SALE_CHANGE',
            deltaCents: -15000,
            method: 'TRANSFER',
            channelKey: 'METHOD:TRANSFER',
            channelLabel: 'Transferencia',
            sourceType: 'SALE',
            sourceId: 'sale-1',
          }),
        ),
      CASH_RULE_CODES.CHANGE_NOT_CASH,
    );
  });

  it('Given a movement for another session, when asserting session binding, then it is rejected', () => {
    expect(() =>
      assertMovementBelongsToSession(movement(), 'session-1'),
    ).not.toThrow();
    expectRuleCode(
      () => assertMovementBelongsToSession(movement(), 'session-2'),
      CASH_RULE_CODES.MOVEMENT_SESSION_MISMATCH,
    );
  });

  it('Given an already recorded source, when adding it again, then duplicate money is rejected while a distinct source is allowed', () => {
    const existing = [movement()];
    expectRuleCode(
      () =>
        assertMovementSourceUnique({
          existing,
          candidate: movement({ deltaCents: 999 }),
        }),
      CASH_RULE_CODES.MOVEMENT_DUPLICATE_SOURCE,
    );
    expect(() =>
      assertMovementSourceUnique({
        existing,
        candidate: movement({ sourceId: 'payment-2' }),
      }),
    ).not.toThrow();
  });

  it('Given a zero change due, when planning the change movement, then no change event is produced', () => {
    expect(
      planChangeMovement({
        sessionId: 'session-1',
        saleId: 'sale-1',
        changeDueCents: 0,
        channel: cashChannel,
      }),
    ).toBeNull();
  });

  it('Given a charge with cash tender and change, when planning, then change is one negative cash movement bound to the sale', () => {
    const change = planChangeMovement({
      sessionId: 'session-1',
      saleId: 'sale-1',
      changeDueCents: 15000,
      channel: cashChannel,
    });
    expect(change).not.toBeNull();
    expect(change).toMatchObject({
      sessionId: 'session-1',
      kind: 'SALE_CHANGE',
      method: 'CASH',
      deltaCents: -15000,
      sourceType: 'SALE',
      sourceId: 'sale-1',
    });
  });

  it('Given a negative or non-cash change, when planning, then invalid change is rejected', () => {
    expectRuleCode(
      () =>
        planChangeMovement({
          sessionId: 'session-1',
          saleId: 'sale-1',
          changeDueCents: -1,
          channel: cashChannel,
        }),
      CASH_RULE_CODES.CENTS_NEGATIVE,
    );
    expectRuleCode(
      () =>
        planChangeMovement({
          sessionId: 'session-1',
          saleId: 'sale-1',
          changeDueCents: 1000,
          channel: {
            channelKey: 'METHOD:TRANSFER',
            channelLabel: 'Transferencia',
            method: 'TRANSFER',
          },
        }),
      CASH_RULE_CODES.CHANGE_NOT_CASH,
    );
  });

  it('Given a tender of 50000 with 15000 change, when planning charge movements, then net cash movement is 35000', () => {
    const movements = planChargeMovements({
      sessionId: 'session-1',
      saleId: 'sale-1',
      cashChannel,
      payments: [
        {
          paymentId: 'payment-1',
          method: 'CASH',
          amountCents: 50000,
          channel: cashChannel,
        },
      ],
      changeDueCents: 15000,
    });
    expect(movements).toHaveLength(2);
    expect(movements.map((m) => m.kind)).toEqual([
      'SALE_PAYMENT',
      'SALE_CHANGE',
    ]);
    const netCash = movements.reduce((total, m) => total + m.deltaCents, 0);
    expect(netCash).toBe(35000);
  });

  it('Given an opening fund and cash movements, when computing expected cash, then opening is counted exactly once and non-cash is excluded', () => {
    const expected = expectedCashCents({
      openingCents: 10000,
      movements: [
        movement({ deltaCents: 50000, sourceId: 'p1' }),
        movement({
          deltaCents: -15000,
          kind: 'SALE_CHANGE',
          sourceType: 'SALE',
          sourceId: 'sale-1',
        }),
        movement({
          method: 'TRANSFER',
          channelKey: 'PM:pm-mp',
          channelLabel: 'Mercado Pago',
          deltaCents: 99999,
          sourceId: 'p2',
        }),
      ],
    });
    expect(expected).toBe(45000);
  });

  it('Given a negative opening fund, when computing expected cash, then it is rejected', () => {
    expectRuleCode(
      () => expectedCashCents({ openingCents: -1, movements: [] }),
      CASH_RULE_CODES.CENTS_NEGATIVE,
    );
  });
});

// ── S2/S5 — handover conservation and reuse ─────────────────────────

describe('cash-register handovers (S2/S5)', () => {
  it('Given declared cash not exactly allocated, when checking allocation, then under/over and duplicate allocations are rejected', () => {
    expect(() =>
      assertCashFullyAllocated({
        declaredCents: 10000,
        allocations: [
          { handoverId: 'h1', allocatedCents: 6000 },
          { handoverId: 'h2', allocatedCents: 4000 },
        ],
      }),
    ).not.toThrow();
    expectRuleCode(
      () =>
        assertCashFullyAllocated({
          declaredCents: 10000,
          allocations: [{ handoverId: 'h1', allocatedCents: 9000 }],
        }),
      CASH_RULE_CODES.HANDOVER_ALLOCATION_MISMATCH,
    );
    expectRuleCode(
      () =>
        assertCashFullyAllocated({
          declaredCents: 10000,
          allocations: [
            { handoverId: 'h1', allocatedCents: 10000 },
            { handoverId: 'h1', allocatedCents: 0 },
          ],
        }),
      CASH_RULE_CODES.HANDOVER_DUPLICATE_ALLOCATION,
    );
  });

  it('Given a same-cashier float with an explicit receipt by the designated receiver, when asserting receipt, then it is allowed', () => {
    expect(() =>
      assertHandoverReceipt({
        kind: 'FLOAT',
        declaredCents: 10000,
        receivedCents: 10000,
        senderUserId: 'cashier-1',
        receiverUserId: 'cashier-1',
        receiptActorUserId: 'cashier-1',
        declaredAt: new Date('2026-10-07T10:00:00.000Z'),
        receivedAt: new Date('2026-10-07T10:05:00.000Z'),
      }),
    ).not.toThrow();
  });

  it('Given a handover without a confirmed receipt, when asserting receipt, then reuse is rejected regardless of kind', () => {
    expectRuleCode(
      () =>
        assertHandoverReceipt({
          kind: 'WITHDRAWAL',
          declaredCents: 10000,
          receivedCents: null,
          senderUserId: 'cashier-1',
          receiverUserId: 'manager-1',
          receiptActorUserId: null,
          declaredAt: new Date('2026-10-07T10:00:00.000Z'),
          receivedAt: null,
        }),
      CASH_RULE_CODES.HANDOVER_NOT_RECEIVED,
    );
  });

  it('Given a receipt without a designated receiver or without an authenticated actor, when asserting receipt, then it is rejected', () => {
    const base = {
      kind: 'WITHDRAWAL' as const,
      declaredCents: 10000,
      receivedCents: 10000,
      senderUserId: 'cashier-1',
      declaredAt: new Date('2026-10-07T10:00:00.000Z'),
      receivedAt: new Date('2026-10-07T10:05:00.000Z'),
    };
    expectRuleCode(
      () =>
        assertHandoverReceipt({
          ...base,
          receiverUserId: null,
          receiptActorUserId: 'manager-1',
        }),
      CASH_RULE_CODES.HANDOVER_RECEIVER_REQUIRED,
    );
    expectRuleCode(
      () =>
        assertHandoverReceipt({
          ...base,
          receiverUserId: 'manager-1',
          receiptActorUserId: null,
        }),
      CASH_RULE_CODES.HANDOVER_RECEIPT_ACTOR_REQUIRED,
    );
  });

  it('Given an authenticated receipt actor who is not the designated receiver, when asserting receipt, then it is rejected', () => {
    expectRuleCode(
      () =>
        assertHandoverReceipt({
          kind: 'FLOAT',
          declaredCents: 10000,
          receivedCents: 10000,
          senderUserId: 'cashier-1',
          receiverUserId: 'cashier-2',
          receiptActorUserId: 'manager-1',
          declaredAt: new Date('2026-10-07T10:00:00.000Z'),
          receivedAt: new Date('2026-10-07T10:05:00.000Z'),
        }),
      CASH_RULE_CODES.HANDOVER_RECEIPT_ACTOR_MISMATCH,
    );
  });

  it('Given a withdrawal where sender and receiver are the same person, when asserting receipt, then self-withdrawal is rejected', () => {
    expectRuleCode(
      () =>
        assertHandoverReceipt({
          kind: 'WITHDRAWAL',
          declaredCents: 10000,
          receivedCents: 10000,
          senderUserId: 'cashier-1',
          receiverUserId: 'cashier-1',
          receiptActorUserId: 'cashier-1',
          declaredAt: new Date('2026-10-07T10:00:00.000Z'),
          receivedAt: new Date('2026-10-07T10:05:00.000Z'),
        }),
      CASH_RULE_CODES.HANDOVER_SELF_WITHDRAWAL,
    );
  });

  it('Given a receipt before the declaration or an invalid date, when asserting receipt, then it fails safely', () => {
    expectRuleCode(
      () =>
        assertHandoverReceipt({
          kind: 'WITHDRAWAL',
          declaredCents: 10000,
          receivedCents: 10000,
          senderUserId: 'cashier-1',
          receiverUserId: 'manager-1',
          receiptActorUserId: 'manager-1',
          declaredAt: new Date('2026-10-07T10:00:00.000Z'),
          receivedAt: new Date('2026-10-07T09:59:00.000Z'),
        }),
      CASH_RULE_CODES.HANDOVER_RECEIPT_BEFORE_DECLARATION,
    );
    expectRuleCode(
      () =>
        assertHandoverReceipt({
          kind: 'WITHDRAWAL',
          declaredCents: 10000,
          receivedCents: 10000,
          senderUserId: 'cashier-1',
          receiverUserId: 'manager-1',
          receiptActorUserId: 'manager-1',
          declaredAt: new Date('not-a-date'),
          receivedAt: new Date('2026-10-07T10:05:00.000Z'),
        }),
      CASH_RULE_CODES.DATE_INVALID,
    );
  });

  it('Given a received float handover, when resolving the next opening fund, then the received amount is used', () => {
    const handover: CashHandover = {
      id: 'h1',
      sessionId: 'session-1',
      kind: 'FLOAT',
      declaredCents: 10000,
      receivedCents: 10000,
      senderUserId: 'cashier-1',
      receiverUserId: 'cashier-2',
      receiptActorUserId: 'cashier-2',
      declaredAt: new Date('2026-10-07T10:00:00.000Z'),
      receivedAt: new Date('2026-10-07T10:05:00.000Z'),
    };
    expect(resolveOpeningFundCents(handover)).toBe(10000);
  });

  it('Given a same-cashier float with an explicit receipt, when resolving the next opening fund, then it is reusable', () => {
    const handover: CashHandover = {
      id: 'h1',
      sessionId: 'session-1',
      kind: 'FLOAT',
      declaredCents: 12345,
      receivedCents: 12345,
      senderUserId: 'cashier-1',
      receiverUserId: 'cashier-1',
      receiptActorUserId: 'cashier-1',
      declaredAt: new Date('2026-10-07T10:00:00.000Z'),
      receivedAt: new Date('2026-10-07T10:05:00.000Z'),
    };
    expect(resolveOpeningFundCents(handover)).toBe(12345);
  });

  it('Given no received handover or a withdrawal, when resolving the next opening fund, then reuse is rejected', () => {
    const base: CashHandover = {
      id: 'h1',
      sessionId: 'session-1',
      kind: 'FLOAT',
      declaredCents: 10000,
      receivedCents: null,
      senderUserId: 'cashier-1',
      receiverUserId: null,
      receiptActorUserId: null,
      declaredAt: new Date('2026-10-07T10:00:00.000Z'),
      receivedAt: null,
    };
    expectRuleCode(
      () => resolveOpeningFundCents(base),
      CASH_RULE_CODES.HANDOVER_NOT_RECEIVED,
    );
    expectRuleCode(
      () =>
        resolveOpeningFundCents({
          ...base,
          kind: 'WITHDRAWAL',
          receivedCents: 10000,
          receiverUserId: 'manager-1',
          receiptActorUserId: 'manager-1',
          receivedAt: new Date('2026-10-07T10:05:00.000Z'),
        }),
      CASH_RULE_CODES.HANDOVER_NOT_FLOAT,
    );
  });

  it('Given an older session discrepancy, when a new session opens from a received float, then its opening is not rewritten by the discrepancy', () => {
    const priorSessionExpectedCents = 10000;
    const priorSessionDeclaredCents = 9000;
    const float: CashHandover = {
      id: 'h1',
      sessionId: 'session-old',
      kind: 'FLOAT',
      declaredCents: 8000,
      receivedCents: 8000,
      senderUserId: 'cashier-1',
      receiverUserId: 'cashier-2',
      receiptActorUserId: 'cashier-2',
      declaredAt: new Date('2026-10-07T10:00:00.000Z'),
      receivedAt: new Date('2026-10-07T10:05:00.000Z'),
    };
    const openingFundCents = resolveOpeningFundCents(float);
    expect(openingFundCents).toBe(8000);
    expect(openingFundCents).not.toBe(priorSessionExpectedCents);
    expect(openingFundCents).not.toBe(priorSessionDeclaredCents);
  });

  it('Given a frozen session with a declaration and full allocation, when releasing the drawer, then all declared cash must be allocated first', () => {
    const session = openSession({
      status: 'SUBMITTED',
      frozenAt: new Date('2026-10-07T10:00:00.000Z'),
    });
    expect(() =>
      assertDrawerReleaseAllowed({
        session,
        declaredCountCents: 10000,
        allocations: [
          { handoverId: 'h1', allocatedCents: 6000 },
          { handoverId: 'h2', allocatedCents: 4000 },
        ],
      }),
    ).not.toThrow();
    expectRuleCode(
      () =>
        assertDrawerReleaseAllowed({
          session,
          declaredCountCents: 10000,
          allocations: [{ handoverId: 'h1', allocatedCents: 9000 }],
        }),
      CASH_RULE_CODES.HANDOVER_ALLOCATION_MISMATCH,
    );
  });

  it('Given a shared drawer merely moved to COUNTING, when releasing, then release is blocked until a declaration and allocation exist', () => {
    const session = openSession({
      status: 'COUNTING',
      frozenAt: new Date('2026-10-07T10:00:00.000Z'),
    });
    expectRuleCode(
      () =>
        assertDrawerReleaseAllowed({
          session,
          declaredCountCents: null,
          allocations: [],
        }),
      CASH_RULE_CODES.DRAWER_RELEASE_BLOCKED,
    );
    expectRuleCode(
      () =>
        assertDrawerReleaseAllowed({
          session: openSession({ status: 'OPEN' }),
          declaredCountCents: 10000,
          allocations: [{ handoverId: 'h1', allocatedCents: 10000 }],
        }),
      CASH_RULE_CODES.DRAWER_RELEASE_BLOCKED,
    );
  });
});

// ── S7/S8 — immutable closing snapshot ──────────────────────────────

describe('cash-register closing snapshot (S7/S8)', () => {
  const closedSession = openSession({
    status: 'CLOSED',
    frozenAt: new Date('2026-10-07T10:00:00.000Z'),
    drawerReleasedAt: new Date('2026-10-07T10:06:00.000Z'),
  });

  function snapshotInput(): {
    session: CashSession;
    folio: string;
    expectedCents: number;
    declaredCents: number;
    verifiedCents: number | null;
    channels: MutableChannelLine[];
    handovers: MutableHandover[];
    countedAt: Date;
    verifiedAt: Date | null;
    closedAt: Date;
    closedByUserId: string;
    verifierUserId: string | null;
  } {
    return {
      session: closedSession,
      folio: 'CORTE-0001',
      expectedCents: 60000,
      declaredCents: 55000,
      verifiedCents: 55000,
      channels: [
        {
          channelKey: 'CASH',
          channelLabel: 'Efectivo',
          method: 'CASH',
          expectedCents: 60000,
          declaredCents: 55000,
          verifiedCents: 55000,
          differenceCents: -5000,
        },
        {
          channelKey: 'PM:pm-mp',
          channelLabel: 'Mercado Pago',
          method: 'TRANSFER',
          expectedCents: 0,
          declaredCents: 0,
          verifiedCents: 0,
          differenceCents: 0,
        },
      ],
      handovers: [
        {
          handoverId: 'h1',
          kind: 'FLOAT',
          declaredCents: 55000,
          receivedCents: 55000,
          senderUserId: 'cashier-1',
          receiverUserId: 'cashier-2',
          receiptActorUserId: 'cashier-2',
          declaredAt: new Date('2026-10-07T10:02:00.000Z'),
          receivedAt: new Date('2026-10-07T10:03:00.000Z'),
        },
      ],
      countedAt: new Date('2026-10-07T10:01:00.000Z'),
      verifiedAt: new Date('2026-10-07T10:04:00.000Z'),
      closedAt: new Date('2026-10-07T10:05:00.000Z'),
      closedByUserId: 'manager-1',
      verifierUserId: 'manager-2',
    };
  }

  it('Given live inputs, when building the closing snapshot, then later mutations do not rewrite the frozen cut', () => {
    const input = snapshotInput();
    const snapshot: CashClosingSnapshot = createCashClosingSnapshot(input);

    input.channels[0].declaredCents = 99999;
    input.channels[0].channelLabel = 'Renombrado';
    input.channels.push({ ...input.channels[0] });
    input.handovers[0].receivedCents = 1;
    input.handovers[0].receiptActorUserId = 'impostor';
    input.countedAt.setFullYear(1999);
    input.expectedCents = 123456;
    input.verifierUserId = 'impostor';

    expect(snapshot.channels).toHaveLength(2);
    expect(snapshot.channels[0].declaredCents).toBe(55000);
    expect(snapshot.channels[0].channelLabel).toBe('Efectivo');
    expect(snapshot.handovers[0].receivedCents).toBe(55000);
    expect(snapshot.handovers[0].receiptActorUserId).toBe('cashier-2');
    expect(snapshot.verifierUserId).toBe('manager-2');
    expect(snapshot.countedAt).toBe('2026-10-07T10:01:00.000Z');
    expect(snapshot.expectedCents).toBe(60000);
  });

  it('Given date inputs, when building the snapshot, then timestamps are immutable ISO strings with verifier and handover receipt metadata', () => {
    const snapshot = createCashClosingSnapshot(snapshotInput());
    expect(typeof snapshot.countedAt).toBe('string');
    expect(snapshot.countedAt).toBe('2026-10-07T10:01:00.000Z');
    expect(typeof snapshot.verifiedAt).toBe('string');
    expect(snapshot.verifiedAt).toBe('2026-10-07T10:04:00.000Z');
    expect(typeof snapshot.closedAt).toBe('string');
    expect(snapshot.closedAt).toBe('2026-10-07T10:05:00.000Z');
    expect(snapshot.verifierUserId).toBe('manager-2');
    expect(snapshot.handovers[0]).toMatchObject({
      receiptActorUserId: 'cashier-2',
      declaredAt: '2026-10-07T10:02:00.000Z',
      receivedAt: '2026-10-07T10:03:00.000Z',
    });
  });

  it('Given an invalid date or a blank closer identity, when building the snapshot, then it fails safely', () => {
    expectRuleCode(
      () =>
        createCashClosingSnapshot({
          ...snapshotInput(),
          countedAt: new Date('not-a-date'),
        }),
      CASH_RULE_CODES.DATE_INVALID,
    );
    expectRuleCode(
      () =>
        createCashClosingSnapshot({
          ...snapshotInput(),
          closedByUserId: '  ',
        }),
      CASH_RULE_CODES.IDENTITY_REQUIRED,
    );
  });

  it('Given a non-closed session, when building the closing snapshot, then the snapshot is rejected', () => {
    expectRuleCode(
      () =>
        createCashClosingSnapshot({
          ...snapshotInput(),
          session: openSession({ status: 'SUBMITTED' }),
        }),
      CASH_RULE_CODES.SNAPSHOT_SESSION_NOT_CLOSED,
    );
  });

  it('Given a closing snapshot, when cloning, then the clone is value-equal but reference-distinct at every level', () => {
    const snapshot = createCashClosingSnapshot(snapshotInput());
    const clone = cloneCashClosingSnapshot(snapshot);
    expect(clone).toEqual(snapshot);
    expect(clone).not.toBe(snapshot);
    expect(clone.channels).not.toBe(snapshot.channels);
    expect(clone.channels[0]).not.toBe(snapshot.channels[0]);
    expect(clone.handovers[0]).not.toBe(snapshot.handovers[0]);
    expect(typeof snapshot.countedAt).toBe('string');
    expect(clone.countedAt).toBe(snapshot.countedAt);
  });

  it('Given a catalog label resolved at operation time, when the catalog is renamed later, then the snapshot keeps the original label', () => {
    const resolved = resolveCashChannel({
      method: 'TRANSFER',
      catalog: { paymentMethodId: 'pm-mp', name: 'Mercado Pago' },
    });
    const input = snapshotInput();
    input.channels[1] = {
      ...input.channels[1],
      channelKey: resolved.channelKey,
      channelLabel: resolved.channelLabel,
      method: resolved.method,
    };
    const snapshot = createCashClosingSnapshot(input);
    const renamed = { paymentMethodId: 'pm-mp', name: 'Mercado Pago 2.0' };
    expect(renamed.name).toBe('Mercado Pago 2.0');
    expect(snapshot.channels[1].channelLabel).toBe('Mercado Pago');
  });

  it('Given a closed session, when attempting an operational write, then the frozen cut rejects it', () => {
    expectRuleCode(
      () => assertOperationalWriteAllowed(closedSession),
      CASH_RULE_CODES.SESSION_NOT_WRITABLE,
    );
  });
});

// ── Triangulation: extra negative/alternate cases ───────────────────

describe('cash-register triangulation (S6/S8)', () => {
  it('Given denominations whose product leaves the cents range, when validating, then unsafe arithmetic is rejected', () => {
    expectRuleCode(
      () =>
        validateCashCount({
          requiredChannelKeys: ['CASH'],
          lines: [{ channelKey: 'CASH', amountCents: 10000 }],
          denominations: [
            { denominationCents: CENTS_STORAGE_MAX, quantity: 2 },
          ],
        }),
      CASH_RULE_CODES.ARITHMETIC_OVERFLOW,
    );
  });

  it('Given a non-integer denomination quantity, when validating, then it is rejected', () => {
    expectRuleCode(
      () =>
        validateCashCount({
          requiredChannelKeys: ['CASH'],
          lines: [{ channelKey: 'CASH', amountCents: 1000 }],
          denominations: [{ denominationCents: 1000, quantity: 1.5 }],
        }),
      CASH_RULE_CODES.DENOMINATION_INVALID,
    );
  });

  it('Given a replayed charge, when the planned movement sources are checked, then duplicate money is rejected', () => {
    const chargeInput = {
      sessionId: 'session-1',
      saleId: 'sale-1',
      cashChannel,
      payments: [
        {
          paymentId: 'payment-1',
          method: 'CASH' as const,
          amountCents: 50000,
          channel: cashChannel,
        },
      ],
      changeDueCents: 15000,
    };
    const first = planChargeMovements(chargeInput);
    const replay = planChargeMovements(chargeInput);
    expect(first.map((m) => m.sourceId)).toEqual(['payment-1', 'sale-1']);
    expectRuleCode(
      () =>
        assertMovementSourceUnique({ existing: first, candidate: replay[0] }),
      CASH_RULE_CODES.MOVEMENT_DUPLICATE_SOURCE,
    );
    expectRuleCode(
      () =>
        assertMovementSourceUnique({ existing: first, candidate: replay[1] }),
      CASH_RULE_CODES.MOVEMENT_DUPLICATE_SOURCE,
    );
  });

  it('Given a session with only an opening fund, when computing expected cash, then opening is counted exactly once', () => {
    expect(expectedCashCents({ openingCents: 12345, movements: [] })).toBe(
      12345,
    );
  });

  it('Given a movement delta beyond the storage range, when validating, then it is rejected', () => {
    expectRuleCode(
      () =>
        assertValidCashMovement(
          movement({ deltaCents: CENTS_STORAGE_MAX + 1 }),
        ),
      CASH_RULE_CODES.CENTS_OUT_OF_RANGE,
    );
  });
});

// ── Verifier regression batch (findings 1-5) ─────────────────────────

describe('cash-register verifier regressions (S2/S5/S6/S7/S8)', () => {
  it('Given a manual movement using a non-cash method, when validating, then manual kinds are restricted to physical cash', () => {
    expectRuleCode(
      () =>
        assertValidCashMovement(
          movement({
            kind: 'CASH_IN',
            deltaCents: 1000,
            sourceType: 'MANUAL',
            sourceId: 'mov-1',
            reason: 'fondo',
            method: 'TRANSFER',
            channelKey: 'METHOD:TRANSFER',
            channelLabel: 'Transferencia',
          }),
        ),
      CASH_RULE_CODES.MANUAL_MOVEMENT_NOT_CASH,
    );
  });

  it('Given a source already recorded under one kind, when re-applying it under another kind, then source identity alone rejects it', () => {
    const existing = [
      movement({
        kind: 'CASH_IN',
        deltaCents: 1000,
        method: 'CASH',
        sourceType: 'MANUAL',
        sourceId: 'mov-1',
        reason: 'fondo',
      }),
    ];
    expectRuleCode(
      () =>
        assertMovementSourceUnique({
          existing,
          candidate: movement({
            kind: 'CASH_OUT',
            deltaCents: -1000,
            method: 'CASH',
            sourceType: 'MANUAL',
            sourceId: 'mov-1',
            reason: 'retiro',
          }),
        }),
      CASH_RULE_CODES.MOVEMENT_DUPLICATE_SOURCE,
    );
  });

  it('Given blank movement or target-session identities, when validating, then identity is enforced', () => {
    expectRuleCode(
      () => assertValidCashMovement(movement({ sessionId: '  ' })),
      CASH_RULE_CODES.IDENTITY_REQUIRED,
    );
    expectRuleCode(
      () => assertValidCashMovement(movement({ sourceId: '' })),
      CASH_RULE_CODES.IDENTITY_REQUIRED,
    );
    expectRuleCode(
      () => assertMovementBelongsToSession(movement(), ''),
      CASH_RULE_CODES.IDENTITY_REQUIRED,
    );
  });

  it('Given a blank viewer identity, when projecting a session, then it is rejected', () => {
    expectRuleCode(
      () =>
        projectCashSession({
          session: openSession(),
          viewerUserId: '   ',
          expectedCashCents: 1000,
          declaredCents: null,
          hasAuditVisibility: false,
          declarationSubmitted: false,
        }),
      CASH_RULE_CODES.IDENTITY_REQUIRED,
    );
  });

  it('Given a blank handover allocation identity, when checking allocation, then it is rejected', () => {
    expectRuleCode(
      () =>
        assertCashFullyAllocated({
          declaredCents: 100,
          allocations: [{ handoverId: '  ', allocatedCents: 100 }],
        }),
      CASH_RULE_CODES.IDENTITY_REQUIRED,
    );
  });

  it('Given a blank session identity, when planning a change movement, then it is rejected', () => {
    expectRuleCode(
      () =>
        planChangeMovement({
          sessionId: '',
          saleId: 'sale-1',
          changeDueCents: 100,
          channel: cashChannel,
        }),
      CASH_RULE_CODES.IDENTITY_REQUIRED,
    );
  });
});
