/**
 * customers-listing T2 (S5, contract §7, §12.3) — read port of the customer
 * payments feed. The adapter answers raw facts of ONE page of events, already
 * in feed order; `CustomerPaymentsService` shapes them.
 */
export const CUSTOMER_PAYMENTS_READER = Symbol('CUSTOMER_PAYMENTS_READER');

export interface CustomerPaymentsCashierRecord {
  id: string;
  name: string;
}

/** A «Cobrar todo» of the customer (`eventId` = collection id). */
export interface CustomerCollectionEventRecord {
  kind: 'collection';
  collectionId: string;
  createdAt: Date;
  tenderedCents: number;
  appliedCents: number;
  changeDueCents: number;
  tendersJson: unknown;
  cashier: CustomerPaymentsCashierRecord | null;
  /** The customer's sales with rows in this collection (any order). */
  sales: Array<{
    saleId: string;
    folio: string | null;
    /** CURRENT status. */
    status: string;
    confirmedAt: Date | null;
    dueDate: Date | null;
    /** Σ of this collection's rows on the sale. */
    appliedCents: number;
  }>;
}

/** A standalone `sale_payments` row (`eventId` = payment id). */
export interface CustomerPaymentEventRecord {
  kind: 'payment';
  paymentId: string;
  createdAt: Date;
  /** DB enum (`CASH`, `CARD_CREDIT`, `CARD_DEBIT`, `TRANSFER`). */
  method: string;
  metadataJson: unknown;
  reference: string | null;
  amountCents: number;
  cashier: CustomerPaymentsCashierRecord | null;
  sale: {
    id: string;
    folio: string | null;
    /** CURRENT status. */
    status: string;
    totalCents: number;
    changeDueCents: number;
  };
  /**
   * EVERY payment row of the sale (collection rows included), in payment
   * order (`createdAt asc, id asc`), for the statement change rule.
   */
  saleRows: Array<{ id: string; method: string; amountCents: number }>;
}

export type CustomerPaymentsEventRecord =
  | CustomerCollectionEventRecord
  | CustomerPaymentEventRecord;

export interface CustomerPaymentsPageRecord {
  /** Events of the customer (not rows). */
  total: number;
  /** The page, ordered `occurredAt desc, eventId desc`. */
  events: CustomerPaymentsEventRecord[];
}

export interface ICustomerPaymentsReader {
  /** Tenant-scoped; null for an unknown or foreign-tenant customer. */
  read(
    customerId: string,
    window: { offset: number; limit: number },
  ): Promise<CustomerPaymentsPageRecord | null>;
}
