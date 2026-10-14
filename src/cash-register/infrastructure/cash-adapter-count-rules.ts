/**
 * cash-register-closing / S10 — count and snapshot rules (S4, S7).
 *
 * Pure helpers over persisted count rows and frozen expected snapshots: the
 * frozen expected snapshot built at START_COUNT, the latest declaration
 * lookup, per-channel discrepancy explanations and the safe (non-rolling-back)
 * post-submission comparison.
 *
 * Blind rule (S4): the first declaration is persisted unchanged BEFORE any
 * expected-dependent comparison. A mismatch is reported in the response so a
 * discrepancy never rolls the submission back.
 */
import type { CashCount } from '@prisma/client';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import {
  CASH_RULE_CODES,
  POOLED_CASH_CHANNEL,
  addCents,
  cashRuleViolation,
  compareCashCounts,
  groupMovementsByChannel,
  subtractCents,
  type CashCountLine,
  type CashMethod,
  type CashMovement as DomainCashMovement,
  type CashSnapshotChannelLine,
} from '../domain';
import type { CashJson } from '../cash-application.port';
import {
  amountByChannel,
  decodeCountLines,
  type FrozenExpectedSnapshot,
} from './cash-json';
import { json } from './cash-adapter-values';

export function buildExpectedSnapshot(
  openingCents: number,
  movements: readonly DomainCashMovement[],
  frozenAt: Date,
): {
  cashExpectedCents: number;
  frozenAt: string;
  channels: ReadonlyArray<{
    channelKey: string;
    channelLabel: string;
    method: CashMethod;
    expectedCents: number;
  }>;
} {
  const grouped = groupMovementsByChannel(movements);
  const channels = grouped.map((group) => ({
    channelKey: group.channelKey,
    channelLabel: group.channelLabel,
    method: group.method,
    expectedCents:
      group.method === 'CASH'
        ? addCents(openingCents, group.totalCents, 'expectedCashCents')
        : group.totalCents,
  }));
  if (!channels.some((channel) => channel.channelKey === 'CASH')) {
    channels.unshift({
      channelKey: POOLED_CASH_CHANNEL.channelKey,
      channelLabel: POOLED_CASH_CHANNEL.channelLabel,
      method: 'CASH',
      expectedCents: openingCents,
    });
  }
  const cash = channels.find((channel) => channel.method === 'CASH');
  return {
    cashExpectedCents: cash ? cash.expectedCents : openingCents,
    frozenAt: frozenAt.toISOString(),
    channels,
  };
}

export function buildClosingChannels(
  expected: FrozenExpectedSnapshot,
  declaredLines: readonly CashCountLine[],
  verifiedLines: readonly CashCountLine[],
): CashSnapshotChannelLine[] {
  const declared = amountByChannel(declaredLines);
  const verified = amountByChannel(verifiedLines);
  return expected.channels.map((channel) => {
    const declaredCents = declared.get(channel.channelKey) ?? 0;
    const verifiedCents = verified.has(channel.channelKey)
      ? (verified.get(channel.channelKey) as number)
      : null;
    return {
      channelKey: channel.channelKey,
      channelLabel: channel.channelLabel,
      method: channel.method,
      expectedCents: channel.expectedCents,
      declaredCents,
      verifiedCents,
      differenceCents: subtractCents(
        declaredCents,
        channel.expectedCents,
        'differenceCents',
      ),
    };
  });
}

export function latestDeclaration(counts: readonly CashCount[]): {
  readonly id: string;
  readonly lines: CashCountLine[];
  readonly revision: number;
} | null {
  const declarations = counts.filter((count) => count.kind === 'DECLARATION');
  if (declarations.length === 0) {
    return null;
  }
  const latest = declarations.reduce((best, candidate) =>
    candidate.revision > best.revision ? candidate : best,
  );
  return {
    id: latest.id,
    lines: decodeCountLines(latest.linesJson),
    revision: latest.revision,
  };
}

export function cashCents(lines: readonly CashCountLine[]): number {
  const cash = lines.find((line) => line.channelKey === 'CASH');
  return cash ? cash.amountCents : 0;
}

/** Only called after submission: every channel needs its own discrepancy check. */
export function assertChannelExplanations(
  expected: FrozenExpectedSnapshot,
  declaredLines: readonly CashCountLine[],
  verifiedLines: readonly CashCountLine[],
  declarationNotes: string | null,
  verificationNotes: string | null,
): void {
  for (const channel of expected.channels) {
    const declared = declaredLines.find(
      (line) => line.channelKey === channel.channelKey,
    );
    const verified = verifiedLines.find(
      (line) => line.channelKey === channel.channelKey,
    );
    if (!declared || !verified) {
      throw cashRuleViolation(
        CASH_RULE_CODES.COUNT_MISSING_CHANNEL,
        'A count must include every frozen channel',
        { channelKey: channel.channelKey },
      );
    }
    compareCashCounts({
      expectedCents: channel.expectedCents,
      declaredCents: declared.amountCents,
      verifiedCents: verified.amountCents,
      declarationNotes,
      verificationNotes,
    });
  }
}

/**
 * Post-submission comparison. The submission is already persisted, so a
 * missing explanation is reported in the response instead of throwing and
 * rolling the declaration back.
 */
export function compareSafely(input: {
  expectedCents: number;
  declaredCents: number;
  verifiedCents: number | null;
  declarationNotes: string | null;
  verificationNotes: string | null;
}): CashJson {
  try {
    const comparison = compareCashCounts({
      expectedCents: input.expectedCents,
      declaredCents: input.declaredCents,
      verifiedCents: input.verifiedCents,
      declarationNotes: input.declarationNotes,
      verificationNotes: input.verificationNotes,
    });
    return json(comparison);
  } catch (error) {
    if (
      error instanceof BusinessRuleViolationError &&
      (error.code === CASH_RULE_CODES.DISCREPANCY_NOTES_REQUIRED ||
        error.code === CASH_RULE_CODES.ARITHMETIC_OVERFLOW)
    ) {
      return {
        expectedCents: input.expectedCents,
        declaredCents: input.declaredCents,
        verifiedCents: input.verifiedCents,
        differenceCents: safeDifference(
          input.declaredCents,
          input.expectedCents,
        ),
        requiresDeclarationNotes: true,
        requiresVerificationNotes: false,
        hasDiscrepancy: true,
        notesRequired: true,
      };
    }
    throw error;
  }
}

function safeDifference(left: number, right: number): number | null {
  try {
    return subtractCents(left, right, 'differenceCents');
  } catch {
    return null;
  }
}
