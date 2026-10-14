/**
 * DOMAIN POLICY: cash-register movements (T1/S6,S8).
 *
 * Sign and source are derived from the movement kind, never from the caller:
 *   - SALE_PAYMENT      positive, source PAYMENT (one per payment id)
 *   - SALE_CHANGE       negative CASH, source SALE (one per sale id)
 *   - REFUND_SETTLEMENT negative, source REFUND (actual settlement only)
 *   - CASH_IN           positive CASH, source MANUAL, reason required
 *   - CASH_OUT          negative CASH, source MANUAL, reason required
 *
 * This blocks arbitrary credit/source injection through manual endpoints and
 * gives `sourceType` + `sourceId` as the replay/idempotency key (the adapter
 * scopes it per tenant; `kind` is derived, never part of the key).
 */
import {
  addCents,
  assertNonNegativeCents,
  assertStorageRangeCents,
} from './cash-money';
import { CASH_RULE_CODES, cashRuleViolation } from './cash-register.errors';
import type {
  CashChannel,
  CashMethod,
  CashMovement,
  CashMovementKind,
  CashSourceType,
} from './cash-register.types';
import { assertNonEmptyText, isNonEmptyText } from './cash-guards';

export type CashMovementSign = 'POSITIVE' | 'NEGATIVE';

export const CASH_MOVEMENT_SIGNS: Readonly<
  Record<CashMovementKind, CashMovementSign>
> = {
  SALE_PAYMENT: 'POSITIVE',
  SALE_CHANGE: 'NEGATIVE',
  REFUND_SETTLEMENT: 'NEGATIVE',
  CASH_IN: 'POSITIVE',
  CASH_OUT: 'NEGATIVE',
};

export const CASH_MOVEMENT_SOURCES: Readonly<
  Record<CashMovementKind, CashSourceType>
> = {
  SALE_PAYMENT: 'PAYMENT',
  SALE_CHANGE: 'SALE',
  REFUND_SETTLEMENT: 'REFUND',
  CASH_IN: 'MANUAL',
  CASH_OUT: 'MANUAL',
};

export function assertValidCashMovement(movement: CashMovement): void {
  assertNonEmptyText(movement.sessionId, 'sessionId');
  assertNonEmptyText(movement.sourceId, 'sourceId');
  assertNonEmptyText(movement.channelKey, 'channelKey');
  assertNonEmptyText(movement.channelLabel, 'channelLabel');
  assertStorageRangeCents(movement.deltaCents, 'deltaCents');
  if (movement.deltaCents === 0) {
    throw cashRuleViolation(
      CASH_RULE_CODES.MOVEMENT_ZERO_DELTA,
      'a cash movement must change the balance',
      { kind: movement.kind, sourceId: movement.sourceId },
    );
  }
  const sign = CASH_MOVEMENT_SIGNS[movement.kind];
  const signViolated =
    sign === 'POSITIVE' ? movement.deltaCents < 0 : movement.deltaCents > 0;
  if (signViolated) {
    throw cashRuleViolation(
      CASH_RULE_CODES.MOVEMENT_SIGN_INVALID,
      `${movement.kind} must be ${sign.toLowerCase()}`,
      { kind: movement.kind, deltaCents: movement.deltaCents },
    );
  }
  const expectedSource = CASH_MOVEMENT_SOURCES[movement.kind];
  if (movement.sourceType !== expectedSource) {
    throw cashRuleViolation(
      CASH_RULE_CODES.MOVEMENT_SOURCE_MISMATCH,
      `${movement.kind} cannot be sourced from ${movement.sourceType}`,
      {
        kind: movement.kind,
        sourceType: movement.sourceType,
        expectedSource,
      },
    );
  }
  if (movement.kind === 'SALE_CHANGE' && movement.method !== 'CASH') {
    throw cashRuleViolation(
      CASH_RULE_CODES.CHANGE_NOT_CASH,
      'customer change is always physical cash',
      { method: movement.method },
    );
  }
  if (expectedSource === 'MANUAL') {
    if (movement.method !== 'CASH') {
      throw cashRuleViolation(
        CASH_RULE_CODES.MANUAL_MOVEMENT_NOT_CASH,
        'manual cash movements must be physical cash',
        { kind: movement.kind, method: movement.method },
      );
    }
    if (!isNonEmptyText(movement.reason)) {
      throw cashRuleViolation(
        CASH_RULE_CODES.MOVEMENT_REASON_REQUIRED,
        'manual cash movements require a reason',
        { kind: movement.kind },
      );
    }
  }
}

/** Movements are bound by session identity, never by an effective timestamp. */
export function assertMovementBelongsToSession(
  movement: CashMovement,
  sessionId: string,
): void {
  assertNonEmptyText(sessionId, 'sessionId');
  if (movement.sessionId !== sessionId) {
    throw cashRuleViolation(
      CASH_RULE_CODES.MOVEMENT_SESSION_MISMATCH,
      'cash movement does not belong to the target session',
      { movementSessionId: movement.sessionId, sessionId },
    );
  }
}

export function assertMovementSourceUnique(input: {
  readonly existing: readonly CashMovement[];
  readonly candidate: CashMovement;
}): void {
  for (const existing of input.existing) {
    if (
      existing.sourceType === input.candidate.sourceType &&
      existing.sourceId === input.candidate.sourceId
    ) {
      throw cashRuleViolation(
        CASH_RULE_CODES.MOVEMENT_DUPLICATE_SOURCE,
        'cash movement source already recorded',
        {
          sourceType: input.candidate.sourceType,
          sourceId: input.candidate.sourceId,
        },
      );
    }
  }
}

export interface PlanChangeMovementInput {
  readonly sessionId: string;
  readonly saleId: string;
  readonly changeDueCents: number;
  readonly channel: CashChannel;
}

/**
 * Plan the single negative CASH change movement for one charge. Returns
 * `null` when there is no change. `sourceId` is the sale id, so replaying the
 * same charge cannot produce two change events.
 */
export function planChangeMovement(
  input: PlanChangeMovementInput,
): CashMovement | null {
  assertNonEmptyText(input.sessionId, 'sessionId');
  assertNonEmptyText(input.saleId, 'saleId');
  assertNonNegativeCents(input.changeDueCents, 'changeDueCents');
  assertStorageRangeCents(input.changeDueCents, 'changeDueCents');
  if (input.changeDueCents === 0) {
    return null;
  }
  if (input.channel.method !== 'CASH') {
    throw cashRuleViolation(
      CASH_RULE_CODES.CHANGE_NOT_CASH,
      'customer change is always physical cash',
      { method: input.channel.method },
    );
  }
  const change: CashMovement = {
    sessionId: input.sessionId,
    deltaCents: -input.changeDueCents,
    method: 'CASH',
    channelKey: input.channel.channelKey,
    channelLabel: input.channel.channelLabel,
    kind: 'SALE_CHANGE',
    sourceType: 'SALE',
    sourceId: input.saleId,
  };
  assertValidCashMovement(change);
  return change;
}

export interface CashChargePaymentInput {
  readonly paymentId: string;
  readonly method: CashMethod;
  readonly amountCents: number;
  readonly channel: CashChannel;
}

export interface PlanChargeMovementsInput {
  readonly sessionId: string;
  readonly saleId: string;
  readonly payments: readonly CashChargePaymentInput[];
  readonly changeDueCents: number;
  readonly cashChannel: CashChannel;
}

/**
 * Plan the tender movements and the single change movement for one charge.
 * Tender uses the payment id as source so each payment records once.
 */
export function planChargeMovements(
  input: PlanChargeMovementsInput,
): readonly CashMovement[] {
  assertNonEmptyText(input.sessionId, 'sessionId');
  assertNonEmptyText(input.saleId, 'saleId');
  const movements: CashMovement[] = [];
  for (const payment of input.payments) {
    assertNonEmptyText(payment.paymentId, 'paymentId');
    assertNonNegativeCents(payment.amountCents, 'amountCents');
    assertStorageRangeCents(payment.amountCents, 'amountCents');
    if (payment.channel.method !== payment.method) {
      throw cashRuleViolation(
        CASH_RULE_CODES.CHANNEL_METHOD_MISMATCH,
        'payment channel does not match the payment method',
        { method: payment.method, channelMethod: payment.channel.method },
      );
    }
    const tender: CashMovement = {
      sessionId: input.sessionId,
      deltaCents: payment.amountCents,
      method: payment.method,
      channelKey: payment.channel.channelKey,
      channelLabel: payment.channel.channelLabel,
      kind: 'SALE_PAYMENT',
      sourceType: 'PAYMENT',
      sourceId: payment.paymentId,
    };
    assertValidCashMovement(tender);
    movements.push(tender);
  }
  const change = planChangeMovement({
    sessionId: input.sessionId,
    saleId: input.saleId,
    changeDueCents: input.changeDueCents,
    channel: input.cashChannel,
  });
  if (change) {
    movements.push(change);
  }
  return movements;
}

export interface ExpectedCashInput {
  readonly openingCents: number;
  readonly movements: readonly CashMovement[];
}

/**
 * Expected cash = opening fund once + every physical CASH delta. Opening is
 * only ever an attribute of the session (there is no OPENING movement kind),
 * so it cannot be counted twice. Non-cash channels never affect the drawer.
 */
export function expectedCashCents(input: ExpectedCashInput): number {
  assertNonNegativeCents(input.openingCents, 'openingCents');
  assertStorageRangeCents(input.openingCents, 'openingCents');
  let cashDelta = 0;
  for (const movement of input.movements) {
    assertValidCashMovement(movement);
    if (movement.method !== 'CASH') {
      continue;
    }
    cashDelta = addCents(cashDelta, movement.deltaCents, 'cashDeltaCents');
  }
  return addCents(input.openingCents, cashDelta, 'expectedCashCents');
}
