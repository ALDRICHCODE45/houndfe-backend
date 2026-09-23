import { isValidElement, type ReactNode } from 'react';
import { Document, Page, renderToBuffer } from '@react-pdf/renderer';
import { TotalsBlock } from './totals-block';

function texts(node: ReactNode): string[] {
  if (Array.isArray(node))
    return node.flatMap((child: ReactNode) => texts(child));
  if (isValidElement<{ children?: ReactNode }>(node))
    return texts(node.props.children);
  if (typeof node === 'string' || typeof node === 'number')
    return [String(node)];
  return [];
}

const base = {
  subtotalCents: 10_000,
  discountCents: 1_000,
  totalCents: 11_500,
  paidCents: 0,
  debtCents: 11_500,
  changeDueCents: 0,
};

describe('TotalsBlock shipping row', () => {
  it.each(['a4', 'ticket'] as const)(
    'renders shipping between discounts and settlement on %s receipts',
    (variant) => {
      const rows = texts(
        TotalsBlock({ ...base, shippingChargeCents: 2_500, variant }),
      );
      expect(rows).toEqual([
        'Subtotal',
        '$100.00',
        'Descuentos',
        '-$10.00',
        'Envío',
        '$25.00',
        'Deuda',
        '$115.00',
        'TOTAL',
        '$115.00',
      ]);
    },
  );

  it.each(['a4', 'ticket'] as const)(
    'renders a real %s PDF with the positive shipping row',
    async (variant) => {
      const buffer = await renderToBuffer(
        <Document>
          <Page size="A4">
            <TotalsBlock
              {...base}
              shippingChargeCents={2_500}
              variant={variant}
            />
          </Page>
        </Document>,
      );
      expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
      expect(buffer.length).toBeGreaterThan(100);
    },
  );

  it('does not print a shipping row for legacy/POS zero-charge receipts', () => {
    expect(
      texts(TotalsBlock({ ...base, totalCents: 9_000, debtCents: 9_000 })),
    ).not.toContain('Envío');
  });
});
