import type { LineItem, Payment, TotalsBlockProps } from '../shared';

export interface ReceiptBusiness {
  logoUrl?: string;
  companyName: string;
  address?: string;
  phone?: string;
}

export interface ReceiptSale {
  folio: string;
  date: string;
  cashier: string;
  seller: string;
}

export interface ReceiptCustomer {
  name: string | null;
}

/**
 * A receipt line: the shared `LineItem` plus the optional price BEFORE any
 * per-line discount. `unitPriceCents` is already NET for per-unit discounts
 * (PRODUCT_DISCOUNT / manual) and stays FULL for BUY_X_GET_Y, so the thermal
 * ticket needs the base to print `qty × base = gross` next to its promo line.
 * Absent on legacy callers; the ticket then treats `unitPriceCents` as base.
 */
export type ReceiptLineItem = LineItem & {
  /** Unit price before any per-line discount (`prePrice ?? unitPrice`). */
  baseUnitPriceCents?: number | null;
};

export interface ReceiptDocumentProps {
  business: ReceiptBusiness;
  sale: ReceiptSale;
  customer: ReceiptCustomer;
  items: ReceiptLineItem[];
  totals: TotalsBlockProps;
  payments: Payment[];
}
