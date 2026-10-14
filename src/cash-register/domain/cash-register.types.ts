/**
 * DOMAIN TYPES: cash-register — closed vocabulary shared by T3/T4 (T1).
 *
 * Pure data contracts only: no Prisma, no NestJS and no repository import.
 * Uppercase method values mirror the DB-oriented `SalePaymentMethod` subset
 * (CASH | CARD_CREDIT | CARD_DEBIT | TRANSFER). The transaction-bound
 * `ICashLedger` port uses lower-case values; its adapter maps them here.
 */

/** Lifecycle of one cash session. Physical drawer release is NOT a status. */
export type CashSessionStatus = 'OPEN' | 'COUNTING' | 'SUBMITTED' | 'CLOSED';

export const CASH_SESSION_STATUSES: readonly CashSessionStatus[] = [
  'OPEN',
  'COUNTING',
  'SUBMITTED',
  'CLOSED',
];

/** Every ledger event kind that can move session money. */
export type CashMovementKind =
  | 'SALE_PAYMENT'
  | 'SALE_CHANGE'
  | 'REFUND_SETTLEMENT'
  | 'CASH_IN'
  | 'CASH_OUT';

/** Base tender method. Catalog branding is a channel concern, not a method. */
export type CashMethod = 'CASH' | 'CARD_CREDIT' | 'CARD_DEBIT' | 'TRANSFER';

/** Declaration vs independent verification (S2). */
export type CashCountKind = 'DECLARATION' | 'VERIFICATION';

/** FLOAT is retained as next opening funds; WITHDRAWAL leaves the drawer. */
export type CashHandoverKind = 'WITHDRAWAL' | 'FLOAT';

/**
 * Origin of a movement. `sourceType` + `sourceId` is the uniqueness key that
 * makes replay/duplicates fail closed (S8):
 *   - PAYMENT  -> the underlying payment id (one movement per payment)
 *   - SALE     -> the sale id for change (exactly one change per sale)
 *   - REFUND   -> the actual refund settlement id
 *   - MANUAL   -> a caller-generated movement id (requires a reason)
 */
export type CashSourceType = 'PAYMENT' | 'SALE' | 'REFUND' | 'MANUAL';

/** Physical cash is pooled under one channel; non-cash keeps catalog detail. */
export interface CashChannel {
  readonly channelKey: string;
  readonly channelLabel: string;
  readonly method: CashMethod;
}

export interface CashSession {
  readonly id: string;
  readonly tenantId: string;
  readonly registerId: string;
  readonly cashierUserId: string;
  readonly status: CashSessionStatus;
  readonly openingCents: number;
  readonly frozenAt: Date | null;
  readonly drawerReleasedAt: Date | null;
}

export interface CashMovement {
  readonly sessionId: string;
  readonly deltaCents: number;
  readonly method: CashMethod;
  readonly channelKey: string;
  readonly channelLabel: string;
  readonly kind: CashMovementKind;
  readonly sourceType: CashSourceType;
  readonly sourceId: string;
  /** Required for MANUAL movements; ignored otherwise. */
  readonly reason?: string | null;
}

export interface CashCountLine {
  readonly channelKey: string;
  readonly amountCents: number;
}

export interface CashDenominationLine {
  readonly denominationCents: number;
  readonly quantity: number;
}

export interface CashCount {
  readonly sessionId: string;
  readonly kind: CashCountKind;
  readonly revision: number;
  readonly lines: readonly CashCountLine[];
  readonly denominations?: readonly CashDenominationLine[] | null;
  readonly notes?: string | null;
}

export interface CashHandover {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: CashHandoverKind;
  readonly declaredCents: number;
  readonly receivedCents: number | null;
  readonly senderUserId: string;
  readonly receiverUserId: string | null;
  /** Authenticated actor who confirmed receipt; must match the receiver. */
  readonly receiptActorUserId: string | null;
  readonly declaredAt: Date;
  readonly receivedAt: Date | null;
}
