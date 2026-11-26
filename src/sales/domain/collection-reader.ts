/**
 * customer-collection / T3 (S5) — read port of one «Cobrar todo» for
 * `GET /collections/:id` and its «Comprobante de cobro» (contract v1 §1, §7).
 *
 * The adapter answers raw facts; `CollectionReadService` shapes them.
 */
export const COLLECTION_READER = Symbol('COLLECTION_READER');

export interface CollectionPaymentRecord {
  id: string;
  saleId: string;
  /** DB enum (`CASH`, `CARD_CREDIT`, `CARD_DEBIT`, `TRANSFER`). */
  method: string;
  amountCents: number;
  /** `metadataJson.catalog.paymentMethodId`, null without catalog snapshot. */
  catalogPaymentMethodId: string | null;
}

export interface CollectionSaleRecord {
  saleId: string;
  folio: string | null;
  /** CURRENT status. */
  status: string;
  confirmedAt: Date | null;
  dueDate: Date | null;
  totalCents: number;
  /**
   * Σ of the sale's payments up to and including this collection: rows of
   * the collection plus rows created strictly before the collection
   * transaction (`createdAt` <, microsecond precision, compared in SQL).
   */
  paidThroughCents: number;
}

export interface CollectionRecord {
  id: string;
  createdAt: Date;
  /** Null once the customer was deleted (FK SET NULL). */
  customer: { id: string; name: string } | null;
  branchName: string;
  cashierName: string | null;
  tenderedCents: number;
  appliedCents: number;
  changeDueCents: number;
  tendersJson: unknown;
  payments: CollectionPaymentRecord[];
  sales: CollectionSaleRecord[];
  /**
   * The customer's whole open debt right after the collection (same cut as
   * `paidThroughCents`, over the sales CONFIRMED at that moment); null when
   * the customer is gone.
   */
  customerDebtAfterCents: number | null;
}

export interface ICollectionReader {
  /** Tenant-scoped; null for an unknown or foreign collection. */
  findCollection(collectionId: string): Promise<CollectionRecord | null>;
}
