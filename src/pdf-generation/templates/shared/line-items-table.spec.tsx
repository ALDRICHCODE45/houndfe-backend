/**
 * LineItemsTable — snapshot tests.
 *
 * Renders the items section of a sale receipt via @react-pdf/renderer's
 * `renderToBuffer`. We verify the component composes into a valid PDF
 * (non-empty + `%PDF` magic bytes) and accepts the full prop surface
 * including the no-discount and has-discount edge cases.
 *
 * Structural assertions cover the modern line-less contract: one row per
 * item (name + variant + `qty × unit` + line total) with no column
 * headers and no grid lines, plus the ticket variant's name truncation.
 */
import { readFileSync } from 'node:fs';
import { Document, Page, renderToBuffer } from '@react-pdf/renderer';
import { LineItemsTable, type LineItem } from './line-items-table';
import { SHARED_STYLES } from './styles';

const PDF_MAGIC = Buffer.from('%PDF', 'utf8');
const SOURCE = readFileSync(`${__dirname}/line-items-table.tsx`, 'utf8');

const FIXTURE_ITEMS: LineItem[] = [
  {
    productName: 'Camiseta HoundFe',
    variantName: 'Talla M / Negro',
    quantity: 2,
    unitPriceCents: 25000,
    discountTitle: 'Promo 2x1',
    discountAmountCents: 5000,
    subtotalCents: 45000,
  },
  {
    productName: 'Taza cerámica',
    variantName: null,
    quantity: 1,
    unitPriceCents: 12000,
    discountTitle: null,
    discountAmountCents: null,
    subtotalCents: 12000,
  },
  {
    productName: 'Sticker pack',
    variantName: 'Edición limitada',
    quantity: 3,
    unitPriceCents: 5000,
    discountTitle: null,
    discountAmountCents: null,
    subtotalCents: 15000,
  },
];

describe('LineItemsTable', () => {
  it('renders into a non-empty PDF buffer with %PDF magic bytes', async () => {
    const buffer = await renderToBuffer(
      <Document>
        <Page size="A4">
          <LineItemsTable items={FIXTURE_ITEMS} />
        </Page>
      </Document>,
    );

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
  });

  it('renders a single item without errors', async () => {
    const buffer = await renderToBuffer(
      <Document>
        <Page size="A4">
          <LineItemsTable
            items={[
              {
                productName: 'Solo',
                variantName: null,
                quantity: 1,
                unitPriceCents: 100,
                discountTitle: null,
                discountAmountCents: null,
                subtotalCents: 100,
              },
            ]}
          />
        </Page>
      </Document>,
    );

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
  });

  it('renders an empty items array without errors', async () => {
    // Spec doesn't mandate what an empty items list looks like, but the
    // component must not crash — empty list is a valid sale state
    // (refunded / fully-discounted sale with no billable lines).
    const buffer = await renderToBuffer(
      <Document>
        <Page size="A4">
          <LineItemsTable items={[]} />
        </Page>
      </Document>,
    );

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
  });

  it('renders inside a narrow ticket page (227pt) without errors', async () => {
    // ReceiptHeader + LineItemsTable + TotalsBlock + PaymentsList all
    // must work in both A4 and ticket formats. We verify the narrow
    // page doesn't crash the table layout engine.
    const buffer = await renderToBuffer(
      <Document>
        <Page size={{ width: 227, height: 600 }}>
          <LineItemsTable items={FIXTURE_ITEMS} variant="ticket" />
        </Page>
      </Document>,
    );

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
  });

  it('handles line items with null discountTitle (no discount column value)', async () => {
    // Per-line discounts are folded into the subtotal in the modern
    // design; a null discountTitle must still render cleanly.
    const items: LineItem[] = [
      {
        productName: 'Sin descuento',
        variantName: null,
        quantity: 1,
        unitPriceCents: 9999,
        discountTitle: null,
        discountAmountCents: null,
        subtotalCents: 9999,
      },
    ];

    const buffer = await renderToBuffer(
      <Document>
        <Page size="A4">
          <LineItemsTable items={items} />
        </Page>
      </Document>,
    );

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
  });

  it('renders line-less rows with no column headers for the A4 variant', () => {
    // The modern design drops the 5-column grid (PRODUCTO / CANT /
    // PRECIO UNIT / DESCUENTO / SUBTOTAL) in favor of one clean row per
    // item: name left, `qty × unit` + line total right.
    const a4Tree = JSON.stringify(
      LineItemsTable({
        items: FIXTURE_ITEMS,
        variant: 'a4' as const,
      }),
    );

    expect(a4Tree).toContain('Camiseta HoundFe');
    expect(a4Tree).toContain('Talla M / Negro');
    // `qty × unit` renders as JSX segments ("2", " ×", " ", "$250.00").
    expect(a4Tree).toContain('" ×"');
    expect(a4Tree).toContain('"$250.00"');
    expect(a4Tree).toContain('"$450.00"');
    // No column header labels anywhere in the tree.
    expect(a4Tree).not.toContain('PRECIO UNIT');
    expect(a4Tree).not.toContain('SUBTOTAL');
    expect(a4Tree).not.toContain('PRODUCTO');
  });

  it('truncates long product names on the ticket variant with an ellipsis', () => {
    // The 227pt ticket cannot wrap a very long name without pushing the
    // line total off the edge — names over ~40 chars get clipped with an
    // ellipsis (react-pdf 4.x has no text-overflow ellipsis).
    const longName =
      'Arnés de seguridad con reflectores y hebillas ajustables premium';
    const ticketTree = JSON.stringify(
      LineItemsTable({
        items: [
          {
            productName: longName,
            variantName: null,
            quantity: 1,
            unitPriceCents: 12900,
            subtotalCents: 12900,
          },
        ],
        variant: 'ticket' as const,
      }),
    );

    expect(longName.length).toBeGreaterThan(40);
    expect(ticketTree).toContain('…');
    // The TEXT child must be the truncated prefix + ellipsis (the full
    // name only survives inside the React `key`, never as rendered text).
    expect(ticketTree).toContain('Arnés de seguridad con reflectores y he…');
  });

  it('renders the items list through the modern token set (no legacy grid tokens)', () => {
    // Source-level guarantee: the modern list uses `SHARED_STYLES.modern.items`
    // and never touches the removed legacy `table` grid bag.
    expect(SOURCE).toContain('SHARED_STYLES.modern.items');
    expect(SOURCE).toContain('SHARED_STYLES.modern.ticket.items');
    expect((SOURCE.match(/SHARED_STYLES\.table\./g) ?? []).length).toBe(0);
    expect((SOURCE.match(/SHARED_STYLES\.receipt\./g) ?? []).length).toBe(0);
    expect(SHARED_STYLES.modern.items).toHaveProperty(
      'row',
      expect.objectContaining({ marginBottom: 12 }),
    );
    expect(SHARED_STYLES.modern.items).toHaveProperty(
      'lineTotal',
      expect.objectContaining({ fontSize: 11, fontWeight: 700 }),
    );
  });

  it('keeps the ticket item tokens compact for the 227pt width', () => {
    expect(SHARED_STYLES.modern.ticket.items).toHaveProperty(
      'productName',
      expect.objectContaining({ fontSize: 8 }),
    );
    expect(SHARED_STYLES.modern.ticket.items).toHaveProperty(
      'productVariant',
      expect.objectContaining({ fontSize: 6.5 }),
    );
  });

  it('exports a function component', () => {
    expect(typeof LineItemsTable).toBe('function');
    expect(
      (LineItemsTable as unknown as { $$typeof?: unknown }).$$typeof,
    ).toBeUndefined();
  });
});
