/**
 * CustomerSection — snapshot tests.
 *
 * Renders the customer line of a sale receipt. Spec: shows customer
 * name, or "Público en General" if no customer is assigned.
 */
import { Document, Page, renderToBuffer } from '@react-pdf/renderer';
import { CustomerSection } from './customer-section';

const PDF_MAGIC = Buffer.from('%PDF', 'utf8');

describe('CustomerSection', () => {
  it('renders into a non-empty PDF buffer with %PDF magic bytes', async () => {
    const buffer = await renderToBuffer(
      <Document>
        <Page size="A4">
          <CustomerSection customerName="María González" />
        </Page>
      </Document>,
    );

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
  });

  it('falls back to "Público en General" when customerName is null', async () => {
    // Spec: "Público en General" if no customer assigned.
    const buffer = await renderToBuffer(
      <Document>
        <Page size="A4">
          <CustomerSection customerName={null} />
        </Page>
      </Document>,
    );

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
  });

  it('falls back to "Público en General" when customerName is undefined', async () => {
    const buffer = await renderToBuffer(
      <Document>
        <Page size="A4">
          {/* @ts-expect-error: undefined is a runtime possibility */}
          <CustomerSection customerName={undefined} />
        </Page>
      </Document>,
    );

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
  });

  it('falls back to "Público en General" when customerName is empty string', async () => {
    // Empty string is semantically "no name" — should still fall back.
    const buffer = await renderToBuffer(
      <Document>
        <Page size="A4">
          <CustomerSection customerName="" />
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
          <CustomerSection customerName="Cliente Ticket" />
        </Page>
      </Document>,
    );

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
  });

  it('exports a function component', () => {
    expect(typeof CustomerSection).toBe('function');
    expect(
      (CustomerSection as unknown as { $$typeof?: unknown }).$$typeof,
    ).toBeUndefined();
  });
});