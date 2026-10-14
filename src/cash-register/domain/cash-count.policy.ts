/**
 * DOMAIN POLICY: cash-register counts (T1/S2,S4,S6).
 *
 * A count is an independent revisioned statement over a fixed set of
 * channels. Validation enforces exact unique coverage: a channel without a
 * line is MISSING, while an explicit `0` line is a real counted zero.
 * Denominations are optional but, when supplied, must reconcile with the
 * physical CASH line.
 *
 * `compareCashCounts` keeps expected, declared and verified as independent
 * values and requires a written explanation for each discrepancy a stage
 * introduces.
 */
import {
  addCents,
  assertNonNegativeCents,
  assertStorageRangeCents,
  CENTS_STORAGE_MAX,
  multiplyCents,
  subtractCents,
} from './cash-money';
import { compareChannelKeys, POOLED_CASH_CHANNEL } from './cash-channel';
import { CASH_RULE_CODES, cashRuleViolation } from './cash-register.errors';
import type {
  CashCountLine,
  CashDenominationLine,
  CashMovement,
} from './cash-register.types';
import { isNonEmptyText } from './cash-guards';

export type CashChannelCountState =
  | 'MISSING'
  | 'COUNTED_ZERO'
  | 'COUNTED_NONZERO';

/**
 * A count must cover CASH (physical drawer) plus every non-cash channel the
 * session posted. Missing vs zero is a caller-visible distinction.
 */
export function requiredCountChannelKeys(
  movements: readonly CashMovement[],
): readonly string[] {
  const nonCashKeys = new Set<string>();
  for (const movement of movements) {
    if (movement.method === 'CASH') {
      continue;
    }
    nonCashKeys.add(movement.channelKey);
  }
  return [
    POOLED_CASH_CHANNEL.channelKey,
    ...[...nonCashKeys].sort((a, b) => a.localeCompare(b)),
  ];
}

export function classifyChannelCount(
  lines: readonly CashCountLine[],
  channelKey: string,
): CashChannelCountState {
  const line = lines.find((candidate) => candidate.channelKey === channelKey);
  if (!line) {
    return 'MISSING';
  }
  return line.amountCents === 0 ? 'COUNTED_ZERO' : 'COUNTED_NONZERO';
}

export interface CashCountValidationInput {
  readonly lines: readonly CashCountLine[];
  readonly requiredChannelKeys: readonly string[];
  readonly denominations?: readonly CashDenominationLine[] | null;
}

export interface ValidatedCashCount {
  readonly lines: readonly CashCountLine[];
  readonly amountByChannel: ReadonlyMap<string, number>;
  readonly cashCents: number;
  readonly totalCents: number;
}

function assertValidDenominations(
  denominations: readonly CashDenominationLine[],
  cashCents: number,
): void {
  let total = 0;
  for (const denomination of denominations) {
    if (
      !Number.isInteger(denomination.denominationCents) ||
      denomination.denominationCents <= 0 ||
      denomination.denominationCents > CENTS_STORAGE_MAX
    ) {
      throw cashRuleViolation(
        CASH_RULE_CODES.DENOMINATION_INVALID,
        'denomination must be a positive integer number of cents',
        { denominationCents: denomination.denominationCents },
      );
    }
    if (
      !Number.isInteger(denomination.quantity) ||
      denomination.quantity < 0 ||
      denomination.quantity > CENTS_STORAGE_MAX
    ) {
      throw cashRuleViolation(
        CASH_RULE_CODES.DENOMINATION_INVALID,
        'denomination quantity must be a non-negative integer',
        { quantity: denomination.quantity },
      );
    }
    total = addCents(
      total,
      multiplyCents(
        denomination.denominationCents,
        denomination.quantity,
        'denominationCents',
      ),
      'denominationTotalCents',
    );
  }
  if (total !== cashCents) {
    throw cashRuleViolation(
      CASH_RULE_CODES.DENOMINATION_SUM_MISMATCH,
      'denominations must sum to the counted physical cash',
      { denominationTotalCents: total, cashCents },
    );
  }
}

export function validateCashCount(
  input: CashCountValidationInput,
): ValidatedCashCount {
  if (input.lines.length === 0) {
    throw cashRuleViolation(
      CASH_RULE_CODES.COUNT_EMPTY,
      'an empty count is not a zero count',
      { requiredChannelKeys: input.requiredChannelKeys },
    );
  }
  const required = new Set(input.requiredChannelKeys);
  const seen = new Set<string>();
  const amountByChannel = new Map<string, number>();
  const normalized: CashCountLine[] = [];
  for (const line of input.lines) {
    const channelKey = line.channelKey.trim();
    if (channelKey.length === 0 || !required.has(channelKey)) {
      throw cashRuleViolation(
        CASH_RULE_CODES.COUNT_UNKNOWN_CHANNEL,
        'count line references an unknown channel',
        { channelKey: line.channelKey },
      );
    }
    if (seen.has(channelKey)) {
      throw cashRuleViolation(
        CASH_RULE_CODES.COUNT_DUPLICATE_CHANNEL,
        'count must reference each channel exactly once',
        { channelKey },
      );
    }
    assertNonNegativeCents(line.amountCents, `lines.${channelKey}`);
    assertStorageRangeCents(line.amountCents, `lines.${channelKey}`);
    seen.add(channelKey);
    amountByChannel.set(channelKey, line.amountCents);
    normalized.push({ channelKey, amountCents: line.amountCents });
  }
  for (const requiredKey of input.requiredChannelKeys) {
    if (!seen.has(requiredKey)) {
      throw cashRuleViolation(
        CASH_RULE_CODES.COUNT_MISSING_CHANNEL,
        'count is missing a required channel (missing is not zero)',
        { channelKey: requiredKey },
      );
    }
  }
  const cashCents = amountByChannel.get(POOLED_CASH_CHANNEL.channelKey) ?? 0;
  const denominations = input.denominations ?? null;
  const hasDenominations = denominations !== null && denominations.length > 0;
  if (hasDenominations) {
    if (!amountByChannel.has(POOLED_CASH_CHANNEL.channelKey)) {
      throw cashRuleViolation(
        CASH_RULE_CODES.DENOMINATION_CASH_LINE_REQUIRED,
        'denominations require a counted cash line',
        {},
      );
    }
    assertValidDenominations(denominations, cashCents);
  }
  const sorted = normalized.sort((a, b) =>
    compareChannelKeys(a.channelKey, b.channelKey),
  );
  let totalCents = 0;
  for (const line of sorted) {
    totalCents = addCents(totalCents, line.amountCents, 'totalCents');
  }
  return {
    lines: sorted,
    amountByChannel,
    cashCents,
    totalCents,
  };
}

export interface CashComparisonInput {
  readonly expectedCents: number;
  readonly declaredCents: number;
  readonly verifiedCents: number | null;
  readonly declarationNotes?: string | null;
  readonly verificationNotes?: string | null;
}

export interface CashComparison {
  readonly expectedCents: number;
  readonly declaredCents: number;
  readonly verifiedCents: number | null;
  readonly declarationDifferenceCents: number;
  readonly verificationDifferenceCents: number | null;
  readonly verifiedVsExpectedDifferenceCents: number | null;
  readonly requiresDeclarationNotes: boolean;
  readonly requiresVerificationNotes: boolean;
  readonly hasDiscrepancy: boolean;
}

/**
 * Compare the three independent amounts. POST-SUBMISSION ONLY: the caller
 * MUST persist the first blind declaration unchanged and only invoke this
 * after it is submitted, otherwise the thrown mismatch/notes requirement
 * becomes a discrepancy oracle. On a discrepancy the caller appends an
 * immutable new count revision with identical amounts plus the explanation
 * before verification/closing. Original amounts are always returned
 * untouched. A declaration difference needs a declaration note; a
 * verification difference from the declaration needs a verification note.
 */
export function compareCashCounts(input: CashComparisonInput): CashComparison {
  assertStorageRangeCents(input.expectedCents, 'expectedCents');
  assertStorageRangeCents(input.declaredCents, 'declaredCents');
  if (input.verifiedCents !== null) {
    assertStorageRangeCents(input.verifiedCents, 'verifiedCents');
  }
  const declarationDifferenceCents = subtractCents(
    input.declaredCents,
    input.expectedCents,
    'declarationDifferenceCents',
  );
  const requiresDeclarationNotes = declarationDifferenceCents !== 0;
  if (requiresDeclarationNotes && !isNonEmptyText(input.declarationNotes)) {
    throw cashRuleViolation(
      CASH_RULE_CODES.DISCREPANCY_NOTES_REQUIRED,
      'a declared cash difference requires an explanation',
      // No numeric difference in the payload: a thrown error must never be a
      // blind-count oracle if the comparator is misused pre-submission.
      { stage: 'DECLARATION' },
    );
  }
  let verificationDifferenceCents: number | null = null;
  let verifiedVsExpectedDifferenceCents: number | null = null;
  let requiresVerificationNotes = false;
  if (input.verifiedCents !== null) {
    verificationDifferenceCents = subtractCents(
      input.verifiedCents,
      input.declaredCents,
      'verificationDifferenceCents',
    );
    verifiedVsExpectedDifferenceCents = subtractCents(
      input.verifiedCents,
      input.expectedCents,
      'verifiedVsExpectedDifferenceCents',
    );
    requiresVerificationNotes = verificationDifferenceCents !== 0;
    if (requiresVerificationNotes && !isNonEmptyText(input.verificationNotes)) {
      throw cashRuleViolation(
        CASH_RULE_CODES.DISCREPANCY_NOTES_REQUIRED,
        'a verified cash difference requires an explanation',
        { stage: 'VERIFICATION' },
      );
    }
  }
  return {
    expectedCents: input.expectedCents,
    declaredCents: input.declaredCents,
    verifiedCents: input.verifiedCents,
    declarationDifferenceCents,
    verificationDifferenceCents,
    verifiedVsExpectedDifferenceCents,
    requiresDeclarationNotes,
    requiresVerificationNotes,
    hasDiscrepancy: requiresDeclarationNotes || requiresVerificationNotes,
  };
}
