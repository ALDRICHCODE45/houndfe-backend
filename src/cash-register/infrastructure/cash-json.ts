/**
 * cash-register-closing / T3 — validated JSON decoders for persisted cash
 * snapshots (S4, S5, S7).
 *
 * The adapter persists `expectedJson`, `linesJson`, `denominationsJson` and
 * `snapshotJson` through Prisma `Json` columns. Reading them back must not
 * trust the column shape: every decoder narrows `Prisma.JsonValue` with type
 * guards (no `as any`) and fails closed on a malformed row instead of leaking
 * a half-decoded snapshot.
 */
import type { Prisma } from '@prisma/client';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import type {
  CashCountLine,
  CashDenominationLine,
  CashMethod,
} from '../domain';
import { CASH_METHOD_LABELS } from '../domain';
import type { CashJson } from '../cash-application.port';

function decodeFailure(field: string): BusinessRuleViolationError {
  return new BusinessRuleViolationError(
    `Persisted cash snapshot field "${field}" is malformed`,
    'CASH_SNAPSHOT_MALFORMED',
    { field },
  );
}

function isJsonObject(value: unknown): value is Record<string, CashJson> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(
  value: Prisma.JsonValue | null,
  field: string,
): Record<string, CashJson> {
  if (!isJsonObject(value)) {
    throw decodeFailure(field);
  }
  return value;
}

function requireString(value: CashJson | undefined, field: string): string {
  if (typeof value !== 'string') {
    throw decodeFailure(field);
  }
  return value;
}

function requireInt(value: CashJson | undefined, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw decodeFailure(field);
  }
  return value;
}

function isCashMethod(value: CashJson | undefined): value is CashMethod {
  return (
    value === 'CASH' ||
    value === 'CARD_CREDIT' ||
    value === 'CARD_DEBIT' ||
    value === 'TRANSFER'
  );
}

function requireCashMethod(
  value: CashJson | undefined,
  field: string,
): CashMethod {
  if (!isCashMethod(value)) {
    throw decodeFailure(field);
  }
  return value;
}

export interface FrozenExpectedChannel {
  readonly channelKey: string;
  readonly channelLabel: string;
  readonly method: CashMethod;
  readonly expectedCents: number;
}

export interface FrozenExpectedSnapshot {
  readonly cashExpectedCents: number;
  readonly frozenAt: string;
  readonly channels: readonly FrozenExpectedChannel[];
}

/** Decode the frozen expected snapshot written at START_COUNT. */
export function decodeExpectedSnapshot(
  value: Prisma.JsonValue | null,
): FrozenExpectedSnapshot | null {
  if (value === null) {
    return null;
  }
  const root = requireObject(value, 'expectedJson');
  const channelsValue = root.channels;
  if (!Array.isArray(channelsValue)) {
    throw decodeFailure('expectedJson.channels');
  }
  const channels = channelsValue.map((entry, index) => {
    const channel = requireObject(entry, `expectedJson.channels[${index}]`);
    return {
      channelKey: requireString(channel.channelKey, 'channelKey'),
      channelLabel: requireString(channel.channelLabel, 'channelLabel'),
      method: requireCashMethod(channel.method, 'method'),
      expectedCents: requireInt(channel.expectedCents, 'expectedCents'),
    };
  });
  return {
    cashExpectedCents: requireInt(
      root.cashExpectedCents,
      'expectedJson.cashExpectedCents',
    ),
    frozenAt: requireString(root.frozenAt, 'expectedJson.frozenAt'),
    channels,
  };
}

/** Decode a persisted count's exact lines. */
export function decodeCountLines(value: Prisma.JsonValue): CashCountLine[] {
  if (!Array.isArray(value)) {
    throw decodeFailure('linesJson');
  }
  return value.map((entry, index) => {
    const line = requireObject(entry, `linesJson[${index}]`);
    return {
      channelKey: requireString(line.channelKey, 'channelKey'),
      amountCents: requireInt(line.amountCents, 'amountCents'),
    };
  });
}

/** Decode optional persisted denomination lines. */
export function decodeDenominations(
  value: Prisma.JsonValue | null,
): CashDenominationLine[] | null {
  if (value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw decodeFailure('denominationsJson');
  }
  return value.map((entry, index) => {
    const line = requireObject(entry, `denominationsJson[${index}]`);
    return {
      denominationCents: requireInt(
        line.denominationCents,
        'denominationCents',
      ),
      quantity: requireInt(line.quantity, 'quantity'),
    };
  });
}

/** Fold count lines into `channelKey -> amountCents` (missing stays missing). */
export function amountByChannel(
  lines: readonly CashCountLine[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of lines) {
    map.set(line.channelKey, line.amountCents);
  }
  return map;
}

export function cashLineCents(lines: readonly CashCountLine[]): number {
  const cash = lines.find((line) => line.channelKey === 'CASH');
  return cash ? cash.amountCents : 0;
}

/**
 * Decode an already-frozen closing snapshot for the receipt adapter. The
 * writer owns the shape; the reader only guarantees a JSON object so a
 * malformed row never surfaces as a partial document.
 */
export function decodeClosingSnapshot(
  value: Prisma.JsonValue,
): Record<string, CashJson> {
  return requireObject(value, 'snapshotJson');
}

export const CASH_METHOD_BY_LABEL: Readonly<Record<string, CashMethod>> =
  Object.fromEntries(
    (
      Object.entries(CASH_METHOD_LABELS) as ReadonlyArray<[CashMethod, string]>
    ).map(([method, label]) => [label, method]),
  );
