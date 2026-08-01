import { ReceiptA4Document } from './receipt/receipt-a4.document';
import { ReceiptTicketDocument } from './receipt/receipt-ticket.document';
import { QuotationA4Document } from './quotation/quotation-a4.document';
import { getTemplate, TEMPLATE_REGISTRY } from './registry';

describe('TEMPLATE_REGISTRY', () => {
  it('registers both supported receipt formats and the quotation-a4 format (WU4)', () => {
    expect(Object.keys(TEMPLATE_REGISTRY).sort()).toEqual([
      'quotation-a4',
      'receipt-a4',
      'receipt-ticket',
    ]);
  });

  it('resolves the A4 receipt component', () => {
    expect(getTemplate('receipt-a4')).toBe(ReceiptA4Document);
  });

  it('resolves the ticket receipt component', () => {
    expect(getTemplate('receipt-ticket')).toBe(ReceiptTicketDocument);
  });

  it('resolves the quotation-a4 component (WU4)', () => {
    expect(getTemplate('quotation-a4')).toBe(QuotationA4Document);
  });
});
