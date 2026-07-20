/**
 * LineItemsTable — snapshot tests.
 *
 * Renders the items section of a sale receipt via @react-pdf/renderer's
 * `renderToBuffer`. We verify the component composes into a valid PDF
 * (non-empty + `%PDF` magic bytes) and accepts the full prop surface
 * including the no-discount and has-discount edge cases.
 */
import { Document, Page, renderToBuffer } from '@react-pdf/renderer';
import { LineItemsTable, type LineItem } from './line-items-table';

const PDF_MAGIC = Buffer.from('%PDF', 'utf8');

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

  it('exports a function component', () => {
    expect(typeof LineItemsTable).toBe('function');
    expect(
      (LineItemsTable as unknown as { $$typeof?: unknown }).$$typeof,
    ).toBeUndefined();
  });
});