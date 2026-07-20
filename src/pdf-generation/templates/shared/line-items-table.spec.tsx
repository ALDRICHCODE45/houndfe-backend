/**
 * LineItemsTable — snapshot tests.
 *
 * Renders the items section of a sale receipt via @react-pdf/renderer's
 * `renderToBuffer`. We verify the component composes into a valid PDF
 * (non-empty + `%PDF` magic bytes) and accepts the full prop surface
 * including the no-discount and has-discount edge cases.
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
          <LineItemsTable items={FIXTURE_ITEMS} />
        </Page>
      </Document>,
    );

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
  });

  it('handles line items with null discountTitle (no discount column value)', async () => {
    // The discount column needs to render "-"/empty for items without a
    // discount. We feed an item with discountTitle=null and verify the
    // PDF still renders cleanly.
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

  it('uses abbreviated column labels for the ticket variant', () => {
    const ticketProps = {
      items: FIXTURE_ITEMS,
      variant: 'ticket' as const,
    };
    const tree = JSON.stringify(LineItemsTable(ticketProps));

    expect(tree).toContain('"PROD"');
    expect(tree).toContain('"CANT"');
    expect(tree).toContain('"P.UNIT"');
    expect(tree).toContain('"DESC"');
    expect(tree).toContain('"SUBT"');
    expect(tree).not.toContain('"PRECIO UNIT"');
    expect(SHARED_STYLES.table).toHaveProperty(
      'ticketHeaderCell',
      expect.objectContaining({ fontSize: 6.5, letterSpacing: 0 }),
    );
  });

  it('keeps full column labels for the A4 variant', () => {
    const a4Props = {
      items: FIXTURE_ITEMS,
      variant: 'a4' as const,
    };
    const tree = JSON.stringify(LineItemsTable(a4Props));

    expect(tree).toContain('"PRODUCTO"');
    expect(tree).toContain('"CANT"');
    expect(tree).toContain('"PRECIO UNIT"');
    expect(tree).toContain('"DESCUENTO"');
    expect(tree).toContain('"SUBTOTAL"');
  });

  it('applies a surface fill to the header row and removes cell borders', () => {
    // Color-driven redesign (vs. the prior border-grid look):
    // - Header row uses a surface-gray fill for separation (no borders).
    // - No right border on any header cell (0 occurrences of headerCellBorder).
    // - No right border on any data cell (0 occurrences of cellBorder).
    expect(
      (SOURCE.match(/SHARED_STYLES\.table\.headerCellBorder/g) ?? []).length,
    ).toBe(0);
    expect(
      (SOURCE.match(/SHARED_STYLES\.table\.cellBorder/g) ?? []).length,
    ).toBe(0);
    expect(SHARED_STYLES.table.headerRow).toEqual(
      expect.objectContaining({ backgroundColor: '#fbfafc' }),
    );
  });

  it('exposes the shared brand accent bar token used by document layouts', () => {
    // The line-items-table doesn't render the accent bar itself —
    // the receipt documents do — but the table reuses the same
    // styles module so the token must exist on `SHARED_STYLES`.
    expect(SHARED_STYLES.receipt).toHaveProperty(
      'brandAccentBar',
      expect.objectContaining({
        height: 3,
        backgroundColor: '#f6bb13',
      }),
    );
  });

  it('section header has a brand-color underline (border-bottom)', () => {
    // Section headers (PRODUCTOS / TOTALES / PAGOS) sit above a 2pt
    // solid yellow underline that carries the brand color through the
    // middle of the receipt instead of relying on borders.
    expect(SHARED_STYLES.receipt.sectionHeader).toEqual(
      expect.objectContaining({
        borderBottomWidth: 2,
        borderBottomColor: '#f6bb13',
      }),
    );
  });

  it('exports a function component', () => {
    expect(typeof LineItemsTable).toBe('function');
    expect(
      (LineItemsTable as unknown as { $$typeof?: unknown }).$$typeof,
    ).toBeUndefined();
  });
});
