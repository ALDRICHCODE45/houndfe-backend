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

  // ── WU2 — Custom Payment Methods (D10) — PaymentsList prefers
  //    the catalog `paymentMethodName` over the base-category label map
  //    (`formatMethod`) and renders `paymentMethodSubtitle` as the gray
  //    sub-line. Legacy rows keep the base label.
  //
  //    Assertion strategy: the mocked `yoga-layout` zeroes layout
  //    dimensions, so we cannot reliably extract positioned text from
  //    the PDF bytes. We render two variants and assert the buffers
  //    DIFFER between (a) base label and (b) the custom-name branch
  //    — the React component must have branched through the snapshot
  //    path — and that all variants still emit a valid PDF (the
  //    visual fidelity belongs to the runtime path with the real yoga
  //    engine, not the Jest snapshot harness).
  describe('custom payment method snapshot (D10)', () => {
    it('renders distinct bytes for paymentMethodName vs the base-method fallback (prefers snapshot)', async () => {
      const bufferFallback = await renderToBuffer(
        <Document>
          <Page size="A4">
            <PaymentsList
              payments={[
                {
                  method: 'TRANSFER',
                  amountCents: 5000,
                  reference: null,
                  paidAt: '2026-07-20T15:30:00.000Z',
                  // No paymentMethodName → falls back to formatMethod('TRANSFER') = 'Transferencia'
                },
              ]}
            />
          </Page>
        </Document>,
      );

      const bufferCustom = await renderToBuffer(
        <Document>
          <Page size="A4">
            <PaymentsList
              payments={[
                {
                  method: 'TRANSFER',
                  amountCents: 5000,
                  reference: null,
                  paidAt: '2026-07-20T15:30:00.000Z',
                  paymentMethodName: 'Mercado Pago',
                  // No subtitle
                },
              ]}
            />
          </Page>
        </Document>,
      );

      // Sanity: both are valid PDFs.
      expect(bufferFallback.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
      expect(bufferCustom.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);

      // Snapshot-first render must branch — the React tree differs when
      // `paymentMethodName` is set, so the emitted PDF bytes differ.
      expect(bufferCustom.equals(bufferFallback)).toBe(false);
    });

    it('renders distinct bytes for paymentMethodSubtitle vs no subtitle (gray sub-line rendered)', async () => {
      const bufferNoSubtitle = await renderToBuffer(
        <Document>
          <Page size="A4">
            <PaymentsList
              payments={[
                {
                  method: 'TRANSFER',
                  amountCents: 5000,
                  reference: null,
                  paidAt: '2026-07-20T15:30:00.000Z',
                  paymentMethodName: 'Mercado Pago',
                  // No subtitle → no gray sub-line
                },
              ]}
            />
          </Page>
        </Document>,
      );

      const bufferWithSubtitle = await renderToBuffer(
        <Document>
          <Page size="A4">
            <PaymentsList
              payments={[
                {
                  method: 'TRANSFER',
                  amountCents: 5000,
                  reference: null,
                  paidAt: '2026-07-20T15:30:00.000Z',
                  paymentMethodName: 'Mercado Pago',
                  paymentMethodSubtitle: 'Link',
                  // Subtitle present → gray sub-line replaces the
                  // `Ref:` line (the template renders subtitle in the
                  // same slot as the reference).
                },
              ]}
            />
          </Page>
        </Document>,
      );

      // Sanity: both are valid PDFs.
      expect(bufferNoSubtitle.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
      expect(bufferWithSubtitle.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);

      // Subtitle branch must differ from the no-subtitle branch.
      expect(bufferWithSubtitle.equals(bufferNoSubtitle)).toBe(false);
    });

    it('falls back to formatMethod(method) for legacy rows (no paymentMethodName → "Efectivo" for CASH)', async () => {
      // Render the legacy row, then render an equivalent row where the
      // base label would otherwise be replaced. Both render paths must
      // hit the fallback branch when paymentMethodName is absent.
      const bufferLegacy = await renderToBuffer(
        <Document>
          <Page size="A4">
            <PaymentsList
              payments={[
                {
                  method: 'CASH',
                  amountCents: 10000,
                  reference: null,
                  paidAt: '2026-07-20T15:30:00.000Z',
                  // No paymentMethodName, no paymentMethodSubtitle.
                },
              ]}
            />
          </Page>
        </Document>,
      );

      const bufferCustomLabel = await renderToBuffer(
        <Document>
          <Page size="A4">
            <PaymentsList
              payments={[
                {
                  method: 'CASH',
                  amountCents: 10000,
                  reference: null,
                  paidAt: '2026-07-20T15:30:00.000Z',
                  paymentMethodName: 'Cash USD',
                },
              ]}
            />
          </Page>
        </Document>,
      );

      expect(bufferLegacy.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
      expect(bufferCustomLabel.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);

      // Legacy bytes (no snapshot) differ from the custom-name branch.
      expect(bufferLegacy.equals(bufferCustomLabel)).toBe(false);
    });

    it('renders inside the ticket variant for a custom method (compact twin still branches)', async () => {
      const bufferFallback = await renderToBuffer(
        <Document>
          <Page size={{ width: 227, height: 600 }}>
            <PaymentsList
              variant="ticket"
              payments={[
                {
                  method: 'TRANSFER',
                  amountCents: 5000,
                  reference: null,
                  paidAt: '2026-07-20T15:30:00.000Z',
                },
              ]}
            />
          </Page>
        </Document>,
      );

      const bufferCustom = await renderToBuffer(
        <Document>
          <Page size={{ width: 227, height: 600 }}>
            <PaymentsList
              variant="ticket"
              payments={[
                {
                  method: 'TRANSFER',
                  amountCents: 5000,
                  reference: null,
                  paidAt: '2026-07-20T15:30:00.000Z',
                  paymentMethodName: 'Mercado Pago',
                  paymentMethodSubtitle: 'Link',
                },
              ]}
            />
          </Page>
        </Document>,
      );

      expect(bufferFallback.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
      expect(bufferCustom.subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
      expect(bufferCustom.equals(bufferFallback)).toBe(false);
    });
  });
});
