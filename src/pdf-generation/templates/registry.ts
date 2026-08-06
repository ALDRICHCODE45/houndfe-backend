import type { ComponentType } from 'react';
import type { FormatKey } from '../pdf-generation.constants';
import { ReceiptA4Document } from './receipt/receipt-a4.document';
import { ReceiptTicketDocument } from './receipt/receipt-ticket.document';
import type { ReceiptDocumentProps } from './receipt/receipt.types';
import { QuotationA4Document } from './quotation/quotation-a4.document';
import type { QuotationDocumentProps } from './quotation/quotation-a4.document';

export type { FormatKey } from '../pdf-generation.constants';

/**
 * Union of every prop shape a registered template accepts.
 *
 * `getTemplate` returns a `ComponentType<DocumentProps>` and the caller
 * is responsible for narrowing on `format` before passing props. This
 * keeps the registry entry types honest (the receipt vs. quotation
 * templates have structurally different prop surfaces) without forcing
 * the registry itself to leak `any`.
 */
export type DocumentProps = ReceiptDocumentProps | QuotationDocumentProps;

/**
 * Template component registry — `format → React component`.
 *
 * Why not `ComponentType<any>`?
 *   - The receipt and quotation templates have structurally distinct
 *     prop shapes (the receipt carries payments + change, the quotation
 *     carries customer email + expiry). Forcing both into a single
 *     union would force the caller to ship a "wide" prop bag with
 *     fields only one branch reads. The discriminated union
 *     `DocumentProps` keeps the type system honest at the cost of one
 *     narrowing step in the service (`format === 'quotation-a4'` →
 *     `QuotationDocumentProps`, else `ReceiptDocumentProps`).
 */
export const TEMPLATE_REGISTRY: Record<
  FormatKey,
  ComponentType<DocumentProps>
> = {
  'receipt-a4': ReceiptA4Document as ComponentType<DocumentProps>,
  'receipt-ticket': ReceiptTicketDocument as ComponentType<DocumentProps>,
  'quotation-a4': QuotationA4Document as ComponentType<DocumentProps>,
};

export function getTemplate(
  format: FormatKey,
): ComponentType<DocumentProps> {
  return TEMPLATE_REGISTRY[format];
}
