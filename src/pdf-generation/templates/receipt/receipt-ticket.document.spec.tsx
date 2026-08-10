import { readFileSync } from 'node:fs';
import { renderToBuffer } from '@react-pdf/renderer';
import { ReceiptTicketDocument } from './receipt-ticket.document';
import type { ReceiptDocumentProps } from './receipt.types';
import { SHARED_STYLES } from '../shared';

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

  it('renders cashier and seller inline in one compact operator row', () => {
    expect(SOURCE).toContain(
      '<OperatorMeta cashier={sale.cashier} seller={sale.seller} />',
    );
    expect(SHARED_STYLES.modern.ticket.operator).toHaveProperty(
      'row',
      expect.objectContaining({ flexDirection: 'row' }),
    );
  });

  it('uses the compact ticket product rows', () => {
    expect(SOURCE).toContain(
      '<LineItemsTable items={items} variant="ticket" />',
    );
    expect(SHARED_STYLES.modern.ticket.items).toHaveProperty(
      'row',
      expect.objectContaining({ flexDirection: 'row' }),
    );
  });

  it('uses the compact ticket header variant and hides address/phone for the ticket', () => {
    // The ticket (227pt wide) cannot fit the A4 16pt brand block plus a
    // long address/phone line. The ticket document opts into the compact
    // header by passing `variant="ticket"` and omitting address/phone.
    expect(SOURCE).toContain('variant="ticket"');
    expect(SOURCE).not.toContain('address={business.address}');
    expect(SOURCE).not.toContain('phone={business.phone}');
  });

  it('renders through the modern ticket token set with the runtime font family', () => {
    // The redesigned ticket binds to the compact `modern.ticket` tokens
    // (no legacy brand accent bar) and resolves the font family at render
    // time so a font-CDN outage degrades safely.
    expect(SOURCE).toContain('SHARED_STYLES.modern.ticket.page');
    expect(SOURCE).toContain('getModernFontFamily()');
    expect(SOURCE).not.toContain('SHARED_STYLES.receipt');
  });

  it('uses tighter ticket page padding (8pt) than the A4 page', () => {
    // 8pt keeps the receipt snug against the 227pt-wide page without
    // bleeding into the print margin. The A4 page uses the modern.page
    // padding (20pt).
    expect(SHARED_STYLES.modern.ticket.page).toEqual(
      expect.objectContaining({ padding: 8 }),
    );
    expect(SHARED_STYLES.modern.page).toEqual(
      expect.objectContaining({ padding: 20 }),
    );
  });

  it('keeps the ticket total at the largest blue size that fits (15pt)', () => {
    // The ticket cannot host the A4 18pt total value; 15pt bold blue is
    // the maximum that fits the 227pt width.
    expect(SHARED_STYLES.modern.ticket.totals.totalValue).toEqual(
      expect.objectContaining({ fontSize: 15, color: '#2563EB' }),
    );
  });
});
