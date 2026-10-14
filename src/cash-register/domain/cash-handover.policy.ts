/**
 * DOMAIN POLICY: cash-register handovers and custody conservation
 * (T1/S2,S5).
 *
 * A handover moves counted cash to another person (WITHDRAWAL) or retains it
 * as the next session's opening fund (FLOAT). Two invariants keep custody
 * honest:
 *   1. Every declared cent must be allocated exactly once before the drawer
 *      can be released.
 *   2. Funds can only be reused from a FLOAT that the receiver actually
 *      confirmed; a sender's assertion alone never releases money.
 *
 * The next opening fund comes from the received handover, never from the
 * previous session's expected/difference, so an older discrepancy cannot
 * rewrite a new session's opening.
 */
import {
  addCents,
  assertNonNegativeCents,
  assertStorageRangeCents,
} from './cash-money';
import { CASH_RULE_CODES, cashRuleViolation } from './cash-register.errors';
import type {
  CashHandover,
  CashHandoverKind,
  CashSession,
} from './cash-register.types';
import { assertNonEmptyText, assertValidDate } from './cash-guards';
import { isFrozen } from './cash-session.policy';

export interface CashHandoverAllocation {
  readonly handoverId: string;
  readonly allocatedCents: number;
}

export function assertCashFullyAllocated(input: {
  readonly declaredCents: number;
  readonly allocations: readonly CashHandoverAllocation[];
}): void {
  assertNonNegativeCents(input.declaredCents, 'declaredCents');
  assertStorageRangeCents(input.declaredCents, 'declaredCents');
  const seen = new Set<string>();
  let allocated = 0;
  for (const allocation of input.allocations) {
    assertNonEmptyText(allocation.handoverId, 'handoverId');
    if (seen.has(allocation.handoverId)) {
      throw cashRuleViolation(
        CASH_RULE_CODES.HANDOVER_DUPLICATE_ALLOCATION,
        'declared cash can only be allocated once per handover',
        { handoverId: allocation.handoverId },
      );
    }
    seen.add(allocation.handoverId);
    assertNonNegativeCents(allocation.allocatedCents, 'allocatedCents');
    assertStorageRangeCents(allocation.allocatedCents, 'allocatedCents');
    allocated = addCents(
      allocated,
      allocation.allocatedCents,
      'allocatedCents',
    );
  }
  if (allocated !== input.declaredCents) {
    throw cashRuleViolation(
      CASH_RULE_CODES.HANDOVER_ALLOCATION_MISMATCH,
      'all declared cash must be allocated before the drawer is released',
      { declaredCents: input.declaredCents, allocatedCents: allocated },
    );
  }
}

export interface CashHandoverReceiptInput {
  readonly kind: CashHandoverKind;
  readonly declaredCents: number;
  readonly receivedCents: number | null;
  readonly senderUserId: string;
  readonly receiverUserId: string | null;
  /** Authenticated actor confirming receipt; must equal the receiver. */
  readonly receiptActorUserId: string | null;
  readonly declaredAt: Date;
  readonly receivedAt: Date | null;
}

/**
 * Kind-aware receipt rule (S2/S5):
 *   - Funds are reusable only after an explicit receipt (amount + timestamp).
 *   - The authenticated receipt actor must be the designated receiver.
 *   - A same-person FLOAT is allowed (a cashier retaining their own float)
 *     because the receipt is still explicit and actor-bound.
 *   - A same-person WITHDRAWAL is denied (self-withdrawal is never custody).
 */
export function assertHandoverReceipt(input: CashHandoverReceiptInput): void {
  assertNonNegativeCents(input.declaredCents, 'declaredCents');
  assertStorageRangeCents(input.declaredCents, 'declaredCents');
  assertNonEmptyText(input.senderUserId, 'senderUserId');
  assertValidDate(input.declaredAt, 'declaredAt');
  if (input.receivedCents === null || input.receivedAt === null) {
    throw cashRuleViolation(
      CASH_RULE_CODES.HANDOVER_NOT_RECEIVED,
      'handover funds are not reusable until the receiver confirms receipt',
      { declaredCents: input.declaredCents, kind: input.kind },
    );
  }
  assertNonNegativeCents(input.receivedCents, 'receivedCents');
  assertStorageRangeCents(input.receivedCents, 'receivedCents');
  assertValidDate(input.receivedAt, 'receivedAt');
  const receiver = input.receiverUserId;
  if (receiver === null || receiver.trim().length === 0) {
    throw cashRuleViolation(
      CASH_RULE_CODES.HANDOVER_RECEIVER_REQUIRED,
      'a receipt requires a designated receiver',
      { senderUserId: input.senderUserId, kind: input.kind },
    );
  }
  const receiptActor = input.receiptActorUserId;
  if (receiptActor === null || receiptActor.trim().length === 0) {
    throw cashRuleViolation(
      CASH_RULE_CODES.HANDOVER_RECEIPT_ACTOR_REQUIRED,
      'a receipt requires the authenticated receiving actor',
      { receiverUserId: receiver, kind: input.kind },
    );
  }
  if (receiptActor !== receiver) {
    throw cashRuleViolation(
      CASH_RULE_CODES.HANDOVER_RECEIPT_ACTOR_MISMATCH,
      'the authenticated receipt actor must be the designated receiver',
      { receiverUserId: receiver, receiptActorUserId: receiptActor },
    );
  }
  if (input.kind === 'WITHDRAWAL' && receiver === input.senderUserId) {
    throw cashRuleViolation(
      CASH_RULE_CODES.HANDOVER_SELF_WITHDRAWAL,
      'a withdrawal cannot be received by its own sender',
      { senderUserId: input.senderUserId },
    );
  }
  if (input.receivedAt.getTime() < input.declaredAt.getTime()) {
    throw cashRuleViolation(
      CASH_RULE_CODES.HANDOVER_RECEIPT_BEFORE_DECLARATION,
      'handover receipt cannot predate its declaration',
      {
        declaredAt: input.declaredAt.toISOString(),
        receivedAt: input.receivedAt.toISOString(),
      },
    );
  }
}

/**
 * Resolve the opening fund a new session may reuse. Requires a FLOAT with a
 * confirmed receipt and returns the RECEIVED amount — never the previous
 * session's expectation or difference.
 */
export function resolveOpeningFundCents(handover: CashHandover): number {
  if (handover.kind !== 'FLOAT') {
    throw cashRuleViolation(
      CASH_RULE_CODES.HANDOVER_NOT_FLOAT,
      'only a retained FLOAT handover can fund the next session',
      { handoverKind: handover.kind },
    );
  }
  assertHandoverReceipt({
    kind: handover.kind,
    declaredCents: handover.declaredCents,
    receivedCents: handover.receivedCents,
    senderUserId: handover.senderUserId,
    receiverUserId: handover.receiverUserId,
    receiptActorUserId: handover.receiptActorUserId,
    declaredAt: handover.declaredAt,
    receivedAt: handover.receivedAt,
  });
  const received = handover.receivedCents;
  if (received === null) {
    throw cashRuleViolation(
      CASH_RULE_CODES.HANDOVER_NOT_RECEIVED,
      'handover funds are not reusable until the receiver confirms receipt',
      { handoverId: handover.id },
    );
  }
  return received;
}

export interface DrawerReleaseInput {
  readonly session: CashSession;
  /** Counted cash from the submitted declaration; null until one exists. */
  readonly declaredCountCents: number | null;
  readonly allocations: readonly CashHandoverAllocation[];
}

/**
 * A shared drawer is released only by an explicit, fully allocated handover
 * after a declaration exists — changing OPEN to COUNTING is never enough.
 */
export function assertDrawerReleaseAllowed(input: DrawerReleaseInput): void {
  if (!isFrozen(input.session) || input.declaredCountCents === null) {
    throw cashRuleViolation(
      CASH_RULE_CODES.DRAWER_RELEASE_BLOCKED,
      'drawer release requires a frozen session with a cash declaration',
      {
        sessionId: input.session.id,
        status: input.session.status,
        hasDeclaration: input.declaredCountCents !== null,
      },
    );
  }
  assertCashFullyAllocated({
    declaredCents: input.declaredCountCents,
    allocations: input.allocations,
  });
}
