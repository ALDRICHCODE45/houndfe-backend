/**
 * cash-register-closing / T5 — fail-closed parser for the closing envelope.
 *
 * The `CASH_APPLICATION` query returns `unknown`-ish JSON (`CashJson`). Before
 * a single peso reaches the PDF we prove EVERY field the frozen snapshot
 * contract requires, using explicit guards instead of `any` casts or
 * `?? 0` fallbacks:
 *
 *   - a missing/invalid amount fails closed (it is NEVER coerced to zero);
 *   - `null` stays `null` (an unverified cut is not a verified `0`);
 *   - ISO timestamp strings are kept verbatim (never re-parsed into `Date`);
 *   - negative differences are preserved as-is;
 *   - the envelope `sessionId`/`folio` must agree with the snapshot, so an
 *     adapter cannot mix one cut's header with another cut's body.
 *
 * On any violation the parser throws `CashClosingSnapshotParseError` with the
 * stable code `CASH_CLOSING_SNAPSHOT_INVALID`; the service maps that to a 500
 * (the cut exists but its frozen payload is corrupt — never render a guess).
 */
import type {
  CashMethod,
  CashHandoverKind,
} from '../../cash-register/domain/cash-register.types';
import type {
  CashClosingSnapshot,
  CashSnapshotChannelLine,
  CashSnapshotHandover,
} from '../../cash-register/domain/cash-snapshot';
import type {
  CashClosingReceipt,
  CashClosingReceiptSnapshot,
} from './cash-closing-receipt.types';

export const CASH_CLOSING_SNAPSHOT_INVALID =
  'CASH_CLOSING_SNAPSHOT_INVALID' as const;

/** Raised when the frozen closing payload cannot be trusted. */
export class CashClosingSnapshotParseError extends Error {
  readonly code = CASH_CLOSING_SNAPSHOT_INVALID;

  constructor(
    readonly field: string,
    message = `Invalid cash closing snapshot at "${field}"`,
  ) {
    super(message);
    this.name = 'CashClosingSnapshotParseError';
  }
}

const CASH_METHODS: readonly CashMethod[] = [
  'CASH',
  'CARD_CREDIT',
  'CARD_DEBIT',
  'TRANSFER',
];

const HANDOVER_KINDS: readonly CashHandoverKind[] = ['WITHDRAWAL', 'FLOAT'];

function fail(field: string): never {
  throw new CashClosingSnapshotParseError(field);
}

function readObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return fail(field);
}

function readNonEmptyString(value: unknown, field: string): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  return fail(field);
}

/** Required domain field that may be `null` but never missing/invalid. */
function readNullableNonEmptyString(
  value: unknown,
  field: string,
): string | null {
  if (value === null) {
    return null;
  }
  return readNonEmptyString(value, field);
}

/** Optional presentation extra: absent/empty → `null`, never a guess. */
function readOptionalText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0 ? value : null;
  }
  return fail(field);
}

function readInteger(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }
  return fail(field);
}

function readNullableInteger(value: unknown, field: string): number | null {
  if (value === null) {
    return null;
  }
  return readInteger(value, field);
}

function readIsoString(value: unknown, field: string): string {
  const text = readNonEmptyString(value, field);
  if (Number.isNaN(Date.parse(text))) {
    return fail(field);
  }
  return text;
}

function readNullableIsoString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  return readIsoString(value, field);
}

function readArray(value: unknown, field: string): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return fail(field);
}

function readCashMethod(value: unknown, field: string): CashMethod {
  if (typeof value === 'string' && CASH_METHODS.includes(value as CashMethod)) {
    return value as CashMethod;
  }
  return fail(field);
}

function readHandoverKind(value: unknown, field: string): CashHandoverKind {
  if (
    typeof value === 'string' &&
    HANDOVER_KINDS.includes(value as CashHandoverKind)
  ) {
    return value as CashHandoverKind;
  }
  return fail(field);
}

function readJsonObject(value: string, field: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return fail(field);
  }
  return readObject(parsed, field);
}

function parseChannel(value: unknown, field: string): CashSnapshotChannelLine {
  const raw = readObject(value, field);
  return {
    channelKey: readNonEmptyString(raw.channelKey, `${field}.channelKey`),
    channelLabel: readNonEmptyString(raw.channelLabel, `${field}.channelLabel`),
    method: readCashMethod(raw.method, `${field}.method`),
    expectedCents: readInteger(raw.expectedCents, `${field}.expectedCents`),
    declaredCents: readInteger(raw.declaredCents, `${field}.declaredCents`),
    verifiedCents: readNullableInteger(
      raw.verifiedCents,
      `${field}.verifiedCents`,
    ),
    differenceCents: readInteger(
      raw.differenceCents,
      `${field}.differenceCents`,
    ),
  };
}

function parseHandover(value: unknown, field: string): CashSnapshotHandover {
  const raw = readObject(value, field);
  return {
    handoverId: readNonEmptyString(raw.handoverId, `${field}.handoverId`),
    kind: readHandoverKind(raw.kind, `${field}.kind`),
    declaredCents: readInteger(raw.declaredCents, `${field}.declaredCents`),
    receivedCents: readNullableInteger(
      raw.receivedCents,
      `${field}.receivedCents`,
    ),
    senderUserId: readNonEmptyString(raw.senderUserId, `${field}.senderUserId`),
    receiverUserId: readNullableNonEmptyString(
      raw.receiverUserId,
      `${field}.receiverUserId`,
    ),
    receiptActorUserId: readNullableNonEmptyString(
      raw.receiptActorUserId,
      `${field}.receiptActorUserId`,
    ),
    declaredAt: readIsoString(raw.declaredAt, `${field}.declaredAt`),
    receivedAt: readNullableIsoString(raw.receivedAt, `${field}.receivedAt`),
  };
}

function parseSnapshot(
  raw: Record<string, unknown>,
): CashClosingReceiptSnapshot {
  const core: CashClosingSnapshot = {
    sessionId: readNonEmptyString(raw.sessionId, 'snapshot.sessionId'),
    tenantId: readNonEmptyString(raw.tenantId, 'snapshot.tenantId'),
    registerId: readNonEmptyString(raw.registerId, 'snapshot.registerId'),
    folio: readNonEmptyString(raw.folio, 'snapshot.folio'),
    cashierUserId: readNonEmptyString(
      raw.cashierUserId,
      'snapshot.cashierUserId',
    ),
    openingCents: readInteger(raw.openingCents, 'snapshot.openingCents'),
    expectedCents: readInteger(raw.expectedCents, 'snapshot.expectedCents'),
    declaredCents: readInteger(raw.declaredCents, 'snapshot.declaredCents'),
    verifiedCents: readNullableInteger(
      raw.verifiedCents,
      'snapshot.verifiedCents',
    ),
    verifierUserId: readNullableNonEmptyString(
      raw.verifierUserId,
      'snapshot.verifierUserId',
    ),
    channels: readArray(raw.channels, 'snapshot.channels').map((channel, i) =>
      parseChannel(channel, `snapshot.channels[${i}]`),
    ),
    handovers: readArray(raw.handovers, 'snapshot.handovers').map(
      (handover, i) => parseHandover(handover, `snapshot.handovers[${i}]`),
    ),
    countedAt: readIsoString(raw.countedAt, 'snapshot.countedAt'),
    verifiedAt: readNullableIsoString(raw.verifiedAt, 'snapshot.verifiedAt'),
    closedAt: readIsoString(raw.closedAt, 'snapshot.closedAt'),
    closedByUserId: readNonEmptyString(
      raw.closedByUserId,
      'snapshot.closedByUserId',
    ),
  };

  // A verified amount without an owning identity is contradictory — fail
  // closed instead of rendering an anonymous verification.
  if (core.verifiedCents !== null && core.verifierUserId === null) {
    return fail('snapshot.verifierUserId');
  }

  return {
    ...core,
    registerName: readOptionalText(raw.registerName, 'snapshot.registerName'),
    cashierName: readOptionalText(raw.cashierName, 'snapshot.cashierName'),
    verifierName: readOptionalText(raw.verifierName, 'snapshot.verifierName'),
    closedByName: readOptionalText(raw.closedByName, 'snapshot.closedByName'),
    declarationNotes: readOptionalText(
      raw.declarationNotes,
      'snapshot.declarationNotes',
    ),
    verificationNotes: readOptionalText(
      raw.verificationNotes,
      'snapshot.verificationNotes',
    ),
    closingNotes: readOptionalText(raw.closingNotes, 'snapshot.closingNotes'),
  };
}

/**
 * Validate the `{ id, sessionId, folio, createdAt, snapshot }` envelope into a
 * trusted `CashClosingReceipt`. `snapshot` may arrive as a JSON object or as a
 * JSON-encoded string; both are validated identically.
 */
export function parseCashClosingReceipt(value: unknown): CashClosingReceipt {
  const root = readObject(value, 'closing');
  const id = readNonEmptyString(root.id, 'id');
  const sessionId = readNonEmptyString(root.sessionId, 'sessionId');
  const folio = readNonEmptyString(root.folio, 'folio');
  const createdAt = readIsoString(root.createdAt, 'createdAt');

  const rawSnapshot = root.snapshot;
  const snapshotObject =
    typeof rawSnapshot === 'string'
      ? readJsonObject(rawSnapshot, 'snapshot')
      : readObject(rawSnapshot, 'snapshot');

  const snapshot = parseSnapshot(snapshotObject);

  if (snapshot.sessionId !== sessionId) {
    return fail('sessionId');
  }
  if (snapshot.folio !== folio) {
    return fail('folio');
  }

  return { id, sessionId, folio, createdAt, snapshot };
}
