/**
 * ReceiptHeader — snapshot tests.
 *
 * Strategy: render the component inside a minimal <Document><Page/></Document>
 * via @react-pdf/renderer's `renderToBuffer` (server-side Node entry point).
 * We assert structural PDF facts — non-empty buffer + `%PDF` magic bytes —
 * rather than pixel-perfect text snapshots. The PDF binary is opaque to a
 * snapshot matcher and would just produce noise on every style tweak.
 *
 * The "renders header content" assertions are kept intentionally shallow
 * (no `expect(...).toMatchSnapshot()`) because the goal of WU2 is to prove
 * each shared block composes into a valid PDF — NOT to lock down visual
 * layout. WU3 (template composition) will own the visual contract.
 */
import { Document, Page, renderToBuffer, Text, View } from '@react-pdf/renderer';
import { ReceiptHeader } from './receipt-header';

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
            address="Sucursal Centro"
            phone="555-0100"
            folio="T-0042"
            date="2026-07-20T15:30:00.000Z"
          />
        </Page>
      </Document>,
    );

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
  });

  it('exports a function component (not a class, not a React element)', () => {
    // A bare contract assertion: ReceiptHeader must be a callable function
    // so template code can pass props directly (`<ReceiptHeader ... />`).
    expect(typeof ReceiptHeader).toBe('function');
    // Should NOT be a React element (no .type === undefined sentinel).
    expect((ReceiptHeader as unknown as { $$typeof?: unknown }).$$typeof).toBeUndefined();
  });

  it('Text and View primitives remain importable from @react-pdf/renderer', () => {
    // Smoke check that our shared deps don't drift out from under us —
    // if @react-pdf/renderer ever stops exporting these, the test suite
    // must fail loudly here, not at template compile time.
    expect(Text).toBeDefined();
    expect(View).toBeDefined();
  });
});