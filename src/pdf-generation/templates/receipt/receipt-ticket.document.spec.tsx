import { renderToBuffer } from '@react-pdf/renderer';
import { ReceiptTicketDocument } from './receipt-ticket.document';
import type { ReceiptDocumentProps } from './receipt.types';

const PDF_MAGIC = Buffer.from('%PDF', 'utf8');

const receipt: ReceiptDocumentProps = {
  business: {
    companyName: 'Houndé',
  },
  sale: {
    folio: 'T-0042',
    date: '2026-07-20T15:30:00.000Z',
    cashier: 'Ana García',
    seller: 'Luis Pérez',
  },
  customer: {
    name: null,
  },
  items: [
    {
      productName: 'Correa de paseo',
      quantity: 1,
      unitPriceCents: 18_000,
      subtotalCents: 18_000,
    },
  ],
  totals: {
    subtotalCents: 18_000,
    discountCents: 0,
    totalCents: 18_000,
    paidCents: 18_000,
    debtCents: 0,
    changeDueCents: 0,
  },
  payments: [
    {
      method: 'CARD',
      amountCents: 18_000,
      reference: 'AUTH-1234',
      paidAt: '2026-07-20T15:31:00.000Z',
    },
  ],
};

describe('ReceiptTicketDocument', () => {
  it('renders a non-empty PDF buffer with PDF magic bytes', async () => {
    const buffer = await renderToBuffer(<ReceiptTicketDocument {...receipt} />);

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)).toBe(true);
  });
});
