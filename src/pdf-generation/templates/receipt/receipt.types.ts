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

export interface ReceiptDocumentProps {
  business: ReceiptBusiness;
  sale: ReceiptSale;
  customer: ReceiptCustomer;
  items: LineItem[];
  totals: TotalsBlockProps;
  payments: Payment[];
}
