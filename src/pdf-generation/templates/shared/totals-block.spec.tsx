/**
 * TotalsBlock — snapshot tests.
 *
 * Renders the totals summary section (subtotal, discount, total, paid,
 * debt, change) via @react-pdf/renderer's `renderToBuffer`. The block
 * is purely numeric — no external data shape beyond `*Cents` numbers.
 */
import { Document, Page, renderToBuffer } from '@react-pdf/renderer';
import { TotalsBlock } from './totals-block';
import { SHARED_STYLES } from './styles';

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

  it('grand total renders on a highlighted card with the blue 18pt value', () => {
    // The modern grand-total card is the document's focal point: a light
    // surface (#F9FAFB) with a hairline border, and the value in 18pt 800
    // accent blue #2563EB (replacing the legacy yellow tint + 13pt value).
    expect(SHARED_STYLES.modern.totals).toHaveProperty(
      'totalCard',
      expect.objectContaining({ backgroundColor: '#F9FAFB' }),
    );
    expect(SHARED_STYLES.modern.totals.totalValue).toEqual(
      expect.objectContaining({
        fontSize: 18,
        fontWeight: 800,
        color: '#2563EB',
      }),
    );
  });

  it('keeps the ticket total compact but still blue and bold', () => {
    // The 227pt ticket cannot host the 18pt value; 15pt is the largest
    // size that fits without the A4 card fill.
    expect(SHARED_STYLES.modern.ticket.totals.totalValue).toEqual(
      expect.objectContaining({
        fontSize: 15,
        fontWeight: 800,
        color: '#2563EB',
      }),
    );
  });
});
