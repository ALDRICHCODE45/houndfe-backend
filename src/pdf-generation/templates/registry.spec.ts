import { ReceiptA4Document } from './receipt/receipt-a4.document';
import { ReceiptTicketDocument } from './receipt/receipt-ticket.document';
import { getTemplate, TEMPLATE_REGISTRY } from './registry';

describe('TEMPLATE_REGISTRY', () => {
  it('registers both supported receipt formats', () => {
    expect(Object.keys(TEMPLATE_REGISTRY).sort()).toEqual([
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
});
