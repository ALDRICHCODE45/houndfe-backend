/**
 * TotalsBlock — snapshot tests.
 *
 * Renders the totals summary section (subtotal, discount, total, paid,
 * debt, change) via @react-pdf/renderer's `renderToBuffer`. The block
 * is purely numeric — no external data shape beyond `*Cents` numbers.
 */
import { Document, Page, renderToBuffer } from '@react-pdf/renderer';
import { TotalsBlock } from './totals-block';

const PDF_MAGIC = Buffer.from('%PDF', 'utf8');

describe('TotalsBlock', () => {
  it('renders into a non-empty PDF buffer with %PDF magic bytes', async () => {
    const buffer = await renderToBuffer(
      <Document>
        <Page size="A4">
          <TotalsBlock
            subtotalCents={100000}
            discountCents={10000}
            totalCents={90000}
            paidCents={100000}
            debtCents={0}
            changeDueCents={10000}
          />
        </Page>
      </Document>,
    );

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
  });

  it('renders a fully-paid sale (no debt, no change) without errors', async () => {
    const buffer = await renderToBuffer(
      <Document>
        <Page size="A4">
          <TotalsBlock
            subtotalCents={50000}
            discountCents={0}
            totalCents={50000}
            paidCents={50000}
            debtCents={0}
            changeDueCents={0}
          />
        </Page>
      </Document>,
    );

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
  });

  it('renders a credit sale (partial payment, debt remaining) without errors', async () => {
    const buffer = await renderToBuffer(
      <Document>
        <Page size="A4">
          <TotalsBlock
            subtotalCents={120000}
            discountCents={20000}
            totalCents={100000}
            paidCents={40000}
            debtCents={60000}
            changeDueCents={0}
          />
        </Page>
      </Document>,
    );

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
  });

  it('renders inside a narrow ticket page without errors', async () => {
    const buffer = await renderToBuffer(
      <Document>
        <Page size={{ width: 227, height: 600 }}>
          <TotalsBlock
            subtotalCents={50000}
            discountCents={0}
            totalCents={50000}
            paidCents={50000}
            debtCents={0}
            changeDueCents={0}
          />
        </Page>
      </Document>,
    );

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
  });

  it('handles zero values across all fields (empty sale edge case)', async () => {
    const buffer = await renderToBuffer(
      <Document>
        <Page size="A4">
          <TotalsBlock
            subtotalCents={0}
            discountCents={0}
            totalCents={0}
            paidCents={0}
            debtCents={0}
            changeDueCents={0}
          />
        </Page>
      </Document>,
    );

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
  });

  it('exports a function component', () => {
    expect(typeof TotalsBlock).toBe('function');
    expect(
      (TotalsBlock as unknown as { $$typeof?: unknown }).$$typeof,
    ).toBeUndefined();
  });
});