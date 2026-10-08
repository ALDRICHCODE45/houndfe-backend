/** Transaction-bound bridge: sales owns payment writes; cash owns custody. */
export const CASH_LEDGER = Symbol('CASH_LEDGER');

export type CashPaymentMethod =
  | 'cash'
  | 'card_credit'
  | 'card_debit'
  | 'transfer';

export interface CashLedgerPayment {
  paymentId: string;
  method: CashPaymentMethod;
  amountCents: number;
  metadataJson?: unknown;
}

/** Every method requires the caller's existing TenantPrismaService transaction. */
export interface ICashLedger {
  /** Locks the session before sales/refund locks and checks tenant, owner and OPEN. */
  assertOpenSession(sessionId: string, actorId: string): Promise<void>;

  recordPayments(input: {
    sessionId: string;
    actorId: string;
    saleId: string;
    payments: readonly CashLedgerPayment[];
    changeDueCents: number;
    occurredAt: Date;
  }): Promise<void>;

  recordRefund(input: {
    sessionId: string;
    actorId: string;
    settlementId: string;
    amountCents: number;
    method: CashPaymentMethod;
    occurredAt: Date;
  }): Promise<void>;
}
