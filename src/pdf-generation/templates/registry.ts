import type { ComponentType } from 'react';
import type { FormatKey } from '../pdf-generation.constants';
import { ReceiptA4Document } from './receipt/receipt-a4.document';
import { ReceiptTicketDocument } from './receipt/receipt-ticket.document';
import type { ReceiptDocumentProps } from './receipt/receipt.types';

export type { FormatKey } from '../pdf-generation.constants';

export const TEMPLATE_REGISTRY: Record<FormatKey, ComponentType<ReceiptDocumentProps>> = {
  'receipt-a4': ReceiptA4Document,
  'receipt-ticket': ReceiptTicketDocument,
};

export function getTemplate(format: FormatKey): ComponentType<ReceiptDocumentProps> {
  return TEMPLATE_REGISTRY[format];
}
