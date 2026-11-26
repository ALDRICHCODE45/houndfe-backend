/**
 * customer-collection / T3 (S5) — props of the «Comprobante de cobro»
 * documents (ticket and A4). Every value is already resolved for printing
 * except money (cents) and the date (ISO, printed in the business zone).
 */
export interface CollectionReceiptSaleLine {
  folio: string;
  appliedCents: number;
  /** The sale's debt right after the collection. */
  debtAfterCents: number;
  /** Cancelled after the collection (contract §8). */
  canceled: boolean;
}

export interface CollectionReceiptTender {
  /** Catalog name when present, else the base method label. */
  label: string;
  subtitle: string | null;
  /** Tendered amount (cash includes the change). */
  amountCents: number;
}

export interface CollectionReceiptProps {
  brandName: string;
  branchName: string;
  /** Short printed folio `COB-XXXXXXXX` (the collection has no folio). */
  folio: string;
  /** Collection instant (ISO). */
  date: string;
  cashier: string;
  customerName: string;
  sales: CollectionReceiptSaleLine[];
  tenders: CollectionReceiptTender[];
  tenderedCents: number;
  appliedCents: number;
  changeDueCents: number;
  /** Customer's open debt right after the collection; null = unknown. */
  remainingCustomerDebtCents: number | null;
}
