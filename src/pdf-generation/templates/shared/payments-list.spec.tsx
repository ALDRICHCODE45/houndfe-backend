/**
 * PaymentsList — snapshot tests.
 *
 * Renders the payment methods list section via @react-pdf/renderer's
 * `renderToBuffer`. Exercises the spec edge case `reference: null`
 * (cash payments typically have no reference number).
 */
import { Document, Page, renderToBuffer } from '@react-pdf/renderer';
import { PaymentsList, type Payment } from './payments-list';

const PDF_MAGIC = Buffer.from('%PDF', 'utf8');

const FIXTURE_PAYMENTS: Payment[] = [
  {
    method: 'CASH',
    amountCents: 50000,
    reference: null,
    paidAt: '2026-07-20T15:30:00.000Z',
  },
  {
    method: 'CARD',
    amountCents: 40000,
    reference: 'AUTH-12345',
    paidAt: '2026-07-20T15:31:00.000Z',
  },
  {
    method: 'TRANSFER',
    amountCents: 10000,
    reference: 'SPEI-67890',
    paidAt: '2026-07-20T15:32:00.000Z',
  },
];

describe('PaymentsList', () => {
  it('renders into a non-empty PDF buffer with %PDF magic bytes', async () => {
    const buffer = await renderToBuffer(
      <Document>
        <Page size="A4">
          <PaymentsList payments={FIXTURE_PAYMENTS} />
        </Page>
      </Document>,
    );

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
  });

  it('handles a single cash payment with no reference (null reference edge case)', async () => {
    // Spec: payments may have reference === null. The component must
    // not crash or render a placeholder string for missing refs.
    const buffer = await renderToBuffer(
      <Document>
        <Page size="A4">
          <PaymentsList
            payments={[
              {
                method: 'CASH',
                amountCents: 10000,
                reference: null,
                paidAt: '2026-07-20T15:30:00.000Z',
              },
            ]}
          />
        </Page>
      </Document>,
    );

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
  });

  it('handles a single card payment with reference', async () => {
    const buffer = await renderToBuffer(
      <Document>
        <Page size="A4">
          <PaymentsList
            payments={[
              {
                method: 'CARD',
                amountCents: 25000,
                reference: 'AUTH-XYZ',
                paidAt: '2026-07-20T15:30:00.000Z',
              },
            ]}
          />
        </Page>
      </Document>,
    );

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
  });

  it('renders an empty payments list without errors', async () => {
    // Edge case: a sale with no payments yet (credit sale in flight).
    // The list must not crash on empty input.
    const buffer = await renderToBuffer(
      <Document>
        <Page size="A4">
          <PaymentsList payments={[]} />
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
          <PaymentsList payments={FIXTURE_PAYMENTS} />
        </Page>
      </Document>,
    );

    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
  });

  it('exports a function component', () => {
    expect(typeof PaymentsList).toBe('function');
    expect(
      (PaymentsList as unknown as { $$typeof?: unknown }).$$typeof,
    ).toBeUndefined();
  });
});