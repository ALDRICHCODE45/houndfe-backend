/**
 * DOMAIN POLICY: cash-register immutable closing snapshot (T1/S7).
 *
 * A closed cut is a self-contained plain object: amounts, per-channel
 * differences, custody handovers, actors, timestamps and folio are all deep
 * copied (and frozen) at build time. A later payment, catalog rename,
 * backdated refund or sale cancellation cannot rewrite it because nothing in
 * the snapshot points back at mutable rows.
 *
 * Timestamps are serialized to ISO strings so `Object.freeze` fully protects
 * them — a frozen `Date` is still mutable through `setTime`. Verifier
 * identity and each handover's declaration/receipt timestamps plus the
 * authenticated receipt actor are captured here for the closing receipt.
 */
import { assertStorageRangeCents } from './cash-money';
import { CASH_RULE_CODES, cashRuleViolation } from './cash-register.errors';
import type {
  CashHandoverKind,
  CashMethod,
  CashSession,
} from './cash-register.types';
import {
  assertNonEmptyText,
  assertValidDate,
  isNonEmptyText,
} from './cash-guards';

export interface CashSnapshotChannelLine {
  readonly channelKey: string;
  readonly channelLabel: string;
  readonly method: CashMethod;
  readonly expectedCents: number;
  readonly declaredCents: number;
  readonly verifiedCents: number | null;
  readonly differenceCents: number;
}

/** Handover input carries real `Date`s; the snapshot stores ISO strings. */
export interface CashSnapshotHandoverInput {
  readonly handoverId: string;
  readonly kind: CashHandoverKind;
  readonly declaredCents: number;
  readonly receivedCents: number | null;
  readonly senderUserId: string;
  readonly receiverUserId: string | null;
  readonly receiptActorUserId: string | null;
  readonly declaredAt: Date;
  readonly receivedAt: Date | null;
}

export interface CashSnapshotHandover {
  readonly handoverId: string;
  readonly kind: CashHandoverKind;
  readonly declaredCents: number;
  readonly receivedCents: number | null;
  readonly senderUserId: string;
  readonly receiverUserId: string | null;
  readonly receiptActorUserId: string | null;
  readonly declaredAt: string;
  readonly receivedAt: string | null;
}

export interface CashClosingSnapshot {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly registerId: string;
  readonly folio: string;
  readonly cashierUserId: string;
  readonly openingCents: number;
  readonly expectedCents: number;
  readonly declaredCents: number;
  readonly verifiedCents: number | null;
  readonly verifierUserId: string | null;
  readonly channels: readonly CashSnapshotChannelLine[];
  readonly handovers: readonly CashSnapshotHandover[];
  readonly countedAt: string;
  readonly verifiedAt: string | null;
  readonly closedAt: string;
  readonly closedByUserId: string;
}

export interface CashClosingSnapshotInput {
  readonly session: CashSession;
  readonly folio: string;
  readonly expectedCents: number;
  readonly declaredCents: number;
  readonly verifiedCents: number | null;
  readonly verifierUserId: string | null;
  readonly channels: readonly CashSnapshotChannelLine[];
  readonly handovers: readonly CashSnapshotHandoverInput[];
  readonly countedAt: Date;
  readonly verifiedAt: Date | null;
  readonly closedAt: Date;
  readonly closedByUserId: string;
}

function copyChannelLine(
  line: CashSnapshotChannelLine,
): CashSnapshotChannelLine {
  assertStorageRangeCents(line.expectedCents, 'channel.expectedCents');
  assertStorageRangeCents(line.declaredCents, 'channel.declaredCents');
  if (line.verifiedCents !== null) {
    assertStorageRangeCents(line.verifiedCents, 'channel.verifiedCents');
  }
  assertStorageRangeCents(line.differenceCents, 'channel.differenceCents');
  return {
    channelKey: line.channelKey,
    channelLabel: line.channelLabel,
    method: line.method,
    expectedCents: line.expectedCents,
    declaredCents: line.declaredCents,
    verifiedCents: line.verifiedCents,
    differenceCents: line.differenceCents,
  };
}

function toSnapshotHandover(
  handover: CashSnapshotHandoverInput,
): CashSnapshotHandover {
  assertNonEmptyText(handover.handoverId, 'handoverId');
  assertNonEmptyText(handover.senderUserId, 'handover.senderUserId');
  assertStorageRangeCents(handover.declaredCents, 'handover.declaredCents');
  if (handover.receivedCents !== null) {
    assertStorageRangeCents(handover.receivedCents, 'handover.receivedCents');
  }
  assertValidDate(handover.declaredAt, 'handover.declaredAt');
  assertOptionalSnapshotDate(handover.receivedAt, 'handover.receivedAt');
  return {
    handoverId: handover.handoverId,
    kind: handover.kind,
    declaredCents: handover.declaredCents,
    receivedCents: handover.receivedCents,
    senderUserId: handover.senderUserId,
    receiverUserId: handover.receiverUserId,
    receiptActorUserId: handover.receiptActorUserId,
    declaredAt: handover.declaredAt.toISOString(),
    receivedAt: handover.receivedAt ? handover.receivedAt.toISOString() : null,
  };
}

function assertOptionalSnapshotDate(value: Date | null, field: string): void {
  if (value !== null) {
    assertValidDate(value, field);
  }
}

function copySnapshotHandover(
  handover: CashSnapshotHandover,
): CashSnapshotHandover {
  return { ...handover };
}

function freezeSnapshot(snapshot: CashClosingSnapshot): CashClosingSnapshot {
  for (const channel of snapshot.channels) {
    Object.freeze(channel);
  }
  for (const handover of snapshot.handovers) {
    Object.freeze(handover);
  }
  Object.freeze(snapshot.channels);
  Object.freeze(snapshot.handovers);
  return Object.freeze(snapshot);
}

export function createCashClosingSnapshot(
  input: CashClosingSnapshotInput,
): CashClosingSnapshot {
  if (input.session.status !== 'CLOSED') {
    throw cashRuleViolation(
      CASH_RULE_CODES.SNAPSHOT_SESSION_NOT_CLOSED,
      'a closing snapshot requires a CLOSED session',
      { sessionId: input.session.id, status: input.session.status },
    );
  }
  if (!isNonEmptyText(input.folio)) {
    throw cashRuleViolation(
      CASH_RULE_CODES.FOLIO_REQUIRED,
      'a closing snapshot requires a folio',
      { sessionId: input.session.id },
    );
  }
  assertNonEmptyText(input.closedByUserId, 'closedByUserId');
  if (input.verifierUserId !== null) {
    assertNonEmptyText(input.verifierUserId, 'verifierUserId');
  }
  if (input.verifiedCents !== null && input.verifierUserId === null) {
    throw cashRuleViolation(
      CASH_RULE_CODES.IDENTITY_REQUIRED,
      'a verified snapshot requires the verifier identity',
      { sessionId: input.session.id },
    );
  }
  assertStorageRangeCents(input.expectedCents, 'expectedCents');
  assertStorageRangeCents(input.declaredCents, 'declaredCents');
  if (input.verifiedCents !== null) {
    assertStorageRangeCents(input.verifiedCents, 'verifiedCents');
  }
  assertValidDate(input.countedAt, 'countedAt');
  assertOptionalSnapshotDate(input.verifiedAt, 'verifiedAt');
  assertValidDate(input.closedAt, 'closedAt');
  const snapshot: CashClosingSnapshot = {
    sessionId: input.session.id,
    tenantId: input.session.tenantId,
    registerId: input.session.registerId,
    folio: input.folio.trim(),
    cashierUserId: input.session.cashierUserId,
    openingCents: input.session.openingCents,
    expectedCents: input.expectedCents,
    declaredCents: input.declaredCents,
    verifiedCents: input.verifiedCents,
    verifierUserId: input.verifierUserId,
    channels: input.channels.map(copyChannelLine),
    handovers: input.handovers.map(toSnapshotHandover),
    countedAt: input.countedAt.toISOString(),
    verifiedAt: input.verifiedAt ? input.verifiedAt.toISOString() : null,
    closedAt: input.closedAt.toISOString(),
    closedByUserId: input.closedByUserId,
  };
  return freezeSnapshot(snapshot);
}

/** Deep copy an existing (already frozen) closing snapshot. */
export function cloneCashClosingSnapshot(
  snapshot: CashClosingSnapshot,
): CashClosingSnapshot {
  const clone: CashClosingSnapshot = {
    ...snapshot,
    channels: snapshot.channels.map(copyChannelLine),
    handovers: snapshot.handovers.map(copySnapshotHandover),
  };
  return freezeSnapshot(clone);
}
