/**
 * customer-collection / T3 (S5) — `GET /collections/:id` read model → the
 * «Comprobante de cobro» props. Pure and side-effect free.
 */
import type { CollectionReceiptDto } from '../../../sales/dto/customer-collection.dto';
import { formatTicketMethod } from '../receipt/ticket-kit';
import type { CollectionReceiptProps } from './collection-receipt.types';

/** Printed when the customer was deleted after the collection. */
export const DELETED_CUSTOMER_LABEL = 'Cliente eliminado';

/**
 * Base method labels. Cash and transfer read as on the sale receipts
 * (`formatTicketMethod`); the two card categories get their Spanish name
 * (the sale receipts only know the legacy `CARD` code).
 */
const CARD_LABELS: Readonly<Record<string, string>> = {
  card_credit: 'Tarjeta de crédito',
  card_debit: 'Tarjeta de débito',
};

export function formatCollectionMethod(method: string): string {
  return CARD_LABELS[method.toLowerCase()] ?? formatTicketMethod(method);
}

/** `COB-` + the first 8 hex chars of the id, upper case. */
export function formatCollectionFolio(collectionId: string): string {
  return `COB-${collectionId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

const blankToNull = (value: string | null | undefined): string | null =>
  value?.trim() ? value.trim() : null;

export function buildCollectionReceiptProps(
  receipt: CollectionReceiptDto,
  brandName: string,
): CollectionReceiptProps {
  const { collection } = receipt;
  return {
    brandName,
    branchName: receipt.branchName,
    folio: formatCollectionFolio(collection.collectionId),
    date: collection.createdAt,
    cashier: blankToNull(receipt.cashierName) ?? '—',
    customerName:
      blankToNull(collection.customer?.name) ?? DELETED_CUSTOMER_LABEL,
    sales: collection.sales.map((sale) => ({
      folio: blankToNull(sale.folio) ?? '—',
      appliedCents: sale.appliedCents,
      debtAfterCents: sale.debtCents,
      canceled: sale.saleStatus === 'CANCELED',
    })),
    tenders: collection.payments.map((tender) => ({
      label:
        blankToNull(tender.catalog?.name) ??
        formatCollectionMethod(tender.method),
      subtitle: blankToNull(tender.catalog?.subtitle),
      amountCents: tender.amountCents,
    })),
    tenderedCents: collection.tenderedCents,
    appliedCents: collection.appliedCents,
    changeDueCents: collection.changeDueCents,
    remainingCustomerDebtCents: collection.remainingCustomerDebtCents,
  };
}
