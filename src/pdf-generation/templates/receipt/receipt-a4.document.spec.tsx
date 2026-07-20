import { renderToBuffer } from '@react-pdf/renderer';
import { ReceiptA4Document } from './receipt-a4.document';
import type { ReceiptDocumentProps } from './receipt.types';

const PDF_MAGIC = Buffer.from('%PDF', 'utf8');

const receipt: ReceiptDocumentProps = {
  business: {
    companyName: 'Houndé',
    address: 'Av. Reforma 123, CDMX',
    phone: '+52 55 1234 5678',
  },
  sale: {
    folio: 'A-0001',
    date: '2026-07-20T15:30:00.000Z',
    cashier: 'Ana García',
    seller: 'Luis Pérez',
  },
  customer: {
    name: 'María López',
  },
  items: [
    {
      productName: 'Collar clásico',
      variantName: 'Mediano / Negro',
      quantity: 2,
      unitPriceCents: 12_500,
      discountTitle: 'Cliente frecuente',
      discountAmountCents: 2_500,
      subtotalCents: 22_500,
    },
  ],
  totals: {
    subtotalCents: 25_000,
    discountCents: 2_500,
    totalCents: 22_500,
    paidCents: 25_000,
    debtCents: 0,
    changeDueCents: 2_500,
  },
  payments: [
    {
      method: 'CASH',
      amountCents: 25_000,
      paidAt: '2026-07-20T15:31:00.000Z',
    },
  ],
};

describe('ReceiptA4Document', () => {
  it('renders a non-empty PDF buffer with PDF magic bytes', async () => {
    const buffer = await renderToBuffer(<ReceiptA4Document {...receipt} />);

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)).toBe(true);
  });
});
