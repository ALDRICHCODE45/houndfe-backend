import { readFileSync } from 'node:fs';
import { renderToBuffer } from '@react-pdf/renderer';
import { ReceiptTicketDocument } from './receipt-ticket.document';
import type { ReceiptDocumentProps } from './receipt.types';

const SOURCE = readFileSync(`${__dirname}/receipt-ticket.document.tsx`, 'utf8');

const PDF_MAGIC = Buffer.from('%PDF', 'utf8');

const receipt: ReceiptDocumentProps = {
  business: {
    companyName: 'HoundFe',
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

  it('renders cashier and seller inline in one row', () => {
    expect(SOURCE).toMatch(/saleMeta:\s*\{\s*flexDirection: 'row'/);
    expect(SOURCE).toContain(
      '<MetaField label="CAJERO" value={sale.cashier} />',
    );
    expect(SOURCE).toContain(
      '<MetaField label="VENDEDOR" value={sale.seller} />',
    );
  });

  it('uses abbreviated product headers', () => {
    expect(SOURCE).toContain(
      '<LineItemsTable items={items} variant="ticket" />',
    );
  });

  it('uses a smaller company title and hides address/phone for the ticket', () => {
    // The ticket (227pt wide) cannot fit the default 18pt HoundFe
    // title plus the long address/phone block — the descenders of the
    // title collide with the FARMACIA subtitle, and address/phone
    // dominate the header. The ticket document opts into a compact
    // header by passing `titleSize="small"` and omitting address/phone.
    expect(SOURCE).toContain('titleSize="small"');
    expect(SOURCE).not.toContain('address={business.address}');
    expect(SOURCE).not.toContain('phone={business.phone}');
  });

  it('renders the brand accent bar above the receipt content', () => {
    expect(SOURCE).toContain('SHARED_STYLES.receipt.brandAccentBar');
  });

  it('uses tighter ticket page padding (8pt) than the A4 page', () => {
    // 8pt horizontal / 8pt vertical keeps the receipt snug against
    // the 227pt-wide page without bleeding into the print margin.
    expect(SOURCE).toMatch(/paddingHorizontal:\s*8/);
    expect(SOURCE).toMatch(/paddingVertical:\s*8/);
  });
});
