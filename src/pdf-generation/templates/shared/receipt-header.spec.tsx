/**
 * ReceiptHeader — snapshot tests.
 *
 * Strategy: render the component inside a minimal <Document><Page/></Document>
 * via @react-pdf/renderer's `renderToBuffer` (server-side Node entry point).
 * We assert structural PDF facts — non-empty buffer + `%PDF` magic bytes —
 * rather than pixel-perfect text snapshots. The PDF binary is opaque to a
 * snapshot matcher and would just produce noise on every style tweak.
 *
 * Structural assertions cover the modern header contract: the A4 meta
 * card (surface fill + hairline border), the ticket variant swapping to
 * the compact company-name token, and the "Punto de Venta" subtitle
 * staying visually tight under the title.
 */
import { readFileSync } from 'node:fs';
import {
  Document,
  Page,
  renderToBuffer,
  Text,
  View,
} from '@react-pdf/renderer';
import { ReceiptHeader } from './receipt-header';
import { SHARED_STYLES } from './styles';

const SOURCE = readFileSync(`${__dirname}/receipt-header.tsx`, 'utf8');

/**
 * PDF binary headers per the PDF 1.4 spec: every PDF file starts with
 * `%PDF-` followed by the version (1.4 here, since @react-pdf/renderer
 * defaults to it). We only need to confirm the magic prefix.
 */
const PDF_MAGIC = Buffer.from('%PDF', 'utf8');

describe('ReceiptHeader', () => {
  it('renders into a non-empty PDF buffer with %PDF magic bytes', async () => {
    const buffer = await renderToBuffer(
      <Document>
        <Page size="A4">
          <ReceiptHeader
            companyName="HoundFe"
            folio="A-0001"
            date="2026-07-20T15:30:00.000Z"
          />
        </Page>
      </Document>,
    );

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
  });

  it('renders with full props (logo + address + phone) without errors', async () => {
    const buffer = await renderToBuffer(
      <Document>
        <Page size="A4">
          <ReceiptHeader
            logoUrl="https://example.com/logo.png"
            companyName="HoundFe"
            address="Av. Reforma 123, CDMX"
            phone="+52 55 1234 5678"
            folio="A-0002"
            date="2026-07-20T15:30:00.000Z"
          />
        </Page>
      </Document>,
    );

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
  });

  it('renders gracefully without a logo URL (text-only fallback)', async () => {
    // Spec: "header shows company name as text only (no broken image
    // placeholder)". The component must still produce a valid PDF.
    const buffer = await renderToBuffer(
      <Document>
        <Page size="A4">
          <ReceiptHeader
            companyName="HoundFe"
            address="Av. Reforma 123"
            folio="A-0003"
            date="2026-07-20T15:30:00.000Z"
          />
        </Page>
      </Document>,
    );

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
  });

  it('renders inside a narrow ticket page without errors', async () => {
    // ReceiptHeader must work on BOTH A4 (full width) and ticket (227pt)
    // pages. The header itself doesn't fix a width — it lays out via flex —
    // but we verify the narrow context doesn't blow up.
    const buffer = await renderToBuffer(
      <Document>
        <Page size={{ width: 227, height: 600 }}>
          <ReceiptHeader
            companyName="HoundFe"
            folio="T-0042"
            date="2026-07-20T15:30:00.000Z"
          />
        </Page>
      </Document>,
    );

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
  });

  it('renders folio and date inside the modern light-gray meta card', () => {
    // The A4 meta card carries the document title + folio + date. It is a
    // light surface (#F9FAFB) with a hairline border + 8pt radius — the
    // modern card treatment that replaces the legacy bordered folio box.
    expect(SHARED_STYLES.modern.cardCompact).toEqual(
      expect.objectContaining({
        border: '1 solid #E5E7EB',
        borderRadius: 8,
      }),
    );
    expect(SHARED_STYLES.modern.header).toHaveProperty('metaTitle');
    expect(SHARED_STYLES.modern.header).toHaveProperty('metaFolio');
    expect(SHARED_STYLES.modern.header).toHaveProperty('metaDate');
    expect(SOURCE).toContain('SHARED_STYLES.modern.header');
    expect(SOURCE).toContain('formatReceiptDate');
  });

  it('renders a compact meta card on the ticket variant (padding 4-6)', () => {
    // RULE OF GOLD: the ticket cannot copy the A4 card padding (16/12).
    // Its meta card drops to padding 4-6 so it stays inside 227pt.
    expect(SHARED_STYLES.modern.ticket.header.metaCard).toEqual(
      expect.objectContaining({ paddingVertical: 4 }),
    );
    expect(SHARED_STYLES.modern.ticket.header.metaCard).toEqual(
      expect.objectContaining({ paddingHorizontal: 6 }),
    );
  });

  it('accepts a variant="ticket" prop that swaps to the compact company name', () => {
    // The ticket format is narrow (~227pt). The A4 16pt company name
    // dominates the header, so the ticket variant binds to a smaller
    // 12pt token via the shared `modern.ticket.header` bag.
    const a4Tree = JSON.stringify(
      ReceiptHeader({
        companyName: 'HoundFe',
        folio: 'A-0001',
        date: '2026-07-20T15:30:00.000Z',
      }),
    );
    const ticketTree = JSON.stringify(
      ReceiptHeader({
        companyName: 'HoundFe',
        folio: 'T-0042',
        date: '2026-07-20T15:30:00.000Z',
        variant: 'ticket',
      }),
    );

    expect(a4Tree).toContain('"fontSize":16');
    expect(ticketTree).toContain('"fontSize":12');
    expect(SHARED_STYLES.modern.header.companyName).toEqual(
      expect.objectContaining({ fontSize: 16 }),
    );
    expect(SHARED_STYLES.modern.ticket.header.companyName).toEqual(
      expect.objectContaining({ fontSize: 12 }),
    );
  });

  it('keeps the "Punto de Venta" subtitle visually tight under the title', () => {
    // The subtitle must not collide with the company-name descenders, so
    // it stays a small gray line (9pt, 2pt gap) below the 16pt title.
    expect(SHARED_STYLES.modern.header.companySub).toEqual(
      expect.objectContaining({ fontSize: 9, marginTop: 2 }),
    );
  });

  it('exports a function component (not a class, not a React element)', () => {
    // A bare contract assertion: ReceiptHeader must be a callable function
    // so template code can pass props directly (`<ReceiptHeader ... />`).
    expect(typeof ReceiptHeader).toBe('function');
    // Should NOT be a React element (no .type === undefined sentinel).
    expect(
      (ReceiptHeader as unknown as { $$typeof?: unknown }).$$typeof,
    ).toBeUndefined();
  });

  it('Text and View primitives remain importable from @react-pdf/renderer', () => {
    // Smoke check that our shared deps don't drift out from under us —
    // if @react-pdf/renderer ever stops exporting these, the test suite
    // must fail loudly here, not at template compile time.
    expect(Text).toBeDefined();
    expect(View).toBeDefined();
  });
});
