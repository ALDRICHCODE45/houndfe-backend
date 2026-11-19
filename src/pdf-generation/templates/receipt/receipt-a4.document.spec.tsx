import { readFileSync } from 'node:fs';
import {
  Document,
  Page,
  renderToBuffer,
  Text,
  View,
} from '@react-pdf/renderer';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { A4_COLORS } from '../shared/a4-kit';
import { ReceiptA4Document } from './receipt-a4.document';
import type { ReceiptDocumentProps } from './receipt.types';

const SOURCE = readFileSync(`${__dirname}/receipt-a4.document.tsx`, 'utf8');

const PDF_MAGIC = Buffer.from('%PDF', 'utf8');

const receipt: ReceiptDocumentProps = {
  business: {
    companyName: 'HoundFe',
    address: 'Av. Reforma 123, CDMX',
    phone: '+52 55 1234 5678',
  },
  sale: {
    folio: 'A-0001',
    date: '2026-07-20T15:30:00.000Z',
    cashier: 'Ana García',
    seller: 'Luis Pérez',
  },
  customer: {
    name: 'María López',
  },
  items: [
    {
      productName: 'Collar clásico',
      variantName: 'Mediano / Negro',
      quantity: 2,
      unitPriceCents: 12_500,
      discountTitle: 'Cliente frecuente',
      discountAmountCents: 2_500,
      subtotalCents: 22_500,
    },
  ],
  totals: {
    subtotalCents: 25_000,
    discountCents: 2_500,
    totalCents: 22_500,
    paidCents: 25_000,
    debtCents: 0,
    changeDueCents: 2_500,
  },
  payments: [
    {
      method: 'CASH',
      amountCents: 25_000,
      paidAt: '2026-07-20T15:31:00.000Z',
    },
  ],
};

// ── Element-tree helpers (kit components are expanded, host ones recursed) ──

/** react-pdf host components: recurse their children instead of invoking. */
const HOST_COMPONENTS = new Set<unknown>([Document, Page, Text, View]);

type AnyElement = ReactElement<Record<string, unknown>>;

function flattenText(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(flattenText).join('');
  if (!isValidElement<{ children?: ReactNode }>(node)) {
    return typeof node === 'string' || typeof node === 'number'
      ? `${node} `
      : '';
  }
  if (typeof node.type === 'function' && !HOST_COMPONENTS.has(node.type)) {
    const Component = node.type as (props: unknown) => ReactNode;
    return flattenText(Component(node.props));
  }
  return flattenText(node.props.children);
}

function collectElements(
  node: ReactNode,
  out: AnyElement[] = [],
): AnyElement[] {
  if (Array.isArray(node)) {
    node.forEach((child) => collectElements(child as ReactNode, out));
    return out;
  }
  if (!isValidElement<Record<string, unknown>>(node)) {
    return out;
  }
  out.push(node);
  if (typeof node.type === 'function' && !HOST_COMPONENTS.has(node.type)) {
    const Component = node.type as (props: unknown) => ReactNode;
    collectElements(Component(node.props), out);
  } else {
    collectElements(node.props.children as ReactNode, out);
  }
  return out;
}

function flatStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...(style as unknown[]).map(flatStyle)) as Record<
      string,
      unknown
    >;
  }
  return typeof style === 'object' && style !== null
    ? (style as Record<string, unknown>)
    : {};
}

function tree(props: ReceiptDocumentProps = receipt): AnyElement[] {
  return collectElements(ReceiptA4Document(props));
}

function textOf(props: ReceiptDocumentProps = receipt): string {
  return flattenText(ReceiptA4Document(props)).replace(/\s+/g, ' ');
}

/** Merged style of the first Text whose flattened content equals `content`. */
function textStyleOf(
  content: string,
  props: ReceiptDocumentProps = receipt,
): Record<string, unknown> {
  const match = tree(props).find(
    (element) =>
      element.type === Text &&
      flattenText(element.props.children as ReactNode).trim() === content,
  );
  if (match === undefined) {
    throw new Error(`no Text with content "${content}"`);
  }
  return flatStyle(match.props.style);
}

function withTotals(
  totals: Partial<ReceiptDocumentProps['totals']>,
): ReceiptDocumentProps {
  return { ...receipt, totals: { ...receipt.totals, ...totals } };
}

describe('ReceiptA4Document', () => {
  it('renders a non-empty PDF buffer with PDF magic bytes', async () => {
    const buffer = await renderToBuffer(<ReceiptA4Document {...receipt} />);

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)).toBe(true);
  });

  it('renders the receipt with a credit balance and a logo-less header', async () => {
    const buffer = await renderToBuffer(
      <ReceiptA4Document
        {...withTotals({ paidCents: 10_000, debtCents: 12_500 })}
      />,
    );

    expect(buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)).toBe(true);
  });

  describe('structure', () => {
    it('is one wrapping A4 page titled with the folio', () => {
      const document = ReceiptA4Document(receipt) as ReactElement<{
        title: string;
      }>;
      const pages = tree().filter((element) => element.type === Page);

      expect(document.props.title).toBe('Recibo A-0001');
      expect(pages).toHaveLength(1);
      expect((pages[0].props as { wrap?: boolean }).wrap).toBe(true);
    });

    it('composes the shared A4 kit and no legacy modern/ticket blocks', () => {
      expect(SOURCE).toContain("from '../shared/a4-kit'");
      expect(SOURCE).toContain('<A4Page');
      expect(SOURCE).toContain('<A4TotalsBlock');
      expect(SOURCE).toContain('<LedgerTable');
      expect(SOURCE).not.toContain('SHARED_STYLES');
      expect(SOURCE).not.toContain('getModernFontFamily');
      expect(SOURCE).not.toContain('<LineItemsTable');
      expect(SOURCE).not.toContain('<TotalsBlock');
    });
  });

  describe('fields', () => {
    it('prints the header, meta bar and section titles', () => {
      const text = textOf();

      expect(text).toContain('HoundFe');
      expect(text).toContain('Punto de Venta');
      expect(text).toContain('Recibo');
      expect(text).toContain('Folio #A-0001');
      expect(text).toContain('Fecha');
      expect(text).toContain('2026');
      expect(text).toContain('Cajero');
      expect(text).toContain('Ana García');
      expect(text).toContain('Vendedor');
      expect(text).toContain('Luis Pérez');
      expect(text).toContain('Cliente');
      expect(text).toContain('María López');
      expect(text).toContain('Productos');
      expect(text).toContain('Pagos');
    });

    it('falls back to «Público en General» for a missing or blank customer', () => {
      expect(textOf({ ...receipt, customer: { name: null } })).toContain(
        'Público en General',
      );
      expect(textOf({ ...receipt, customer: { name: '   ' } })).toContain(
        'Público en General',
      );
    });

    it('prints the company name from the business and the logo only when set', () => {
      const named = {
        ...receipt,
        business: { ...receipt.business, companyName: 'Mascotas Felices' },
      };
      expect(textOf(named)).toContain('Mascotas Felices');
      expect(tree(receipt).some((element) => element.type === 'IMAGE')).toBe(
        false,
      );
    });

    it('prints line items with variant, qty × unit (grouped) and line total', () => {
      const text = textOf({
        ...receipt,
        items: [
          ...receipt.items,
          {
            productName: 'Croquetas 18 kg',
            variantName: null,
            quantity: 2.5,
            unitPriceCents: 114_900,
            subtotalCents: 287_250,
          },
        ],
      });

      expect(text).toContain('Descripción');
      expect(text).toContain('Cantidad × precio');
      expect(text).toContain('Importe');
      expect(text).toContain('Collar clásico');
      expect(text).toContain('Mediano / Negro');
      expect(text).toContain('2 × $125.00');
      expect(text).toContain('$225.00');
      expect(text).toContain('Croquetas 18 kg');
      expect(text).toContain('2.5 × $1,149.00');
      expect(text).toContain('$2,872.50');
    });

    it('prints a placeholder for a sale with no items', () => {
      expect(textOf({ ...receipt, items: [] })).toContain('---');
    });

    it('prints payments by method name, reference/subtitle, time and amount', () => {
      const text = textOf({
        ...receipt,
        payments: [
          {
            method: 'CARD',
            amountCents: 100_000,
            reference: '084731',
            paidAt: '2026-07-20T15:31:00.000Z',
          },
          {
            method: 'CARD',
            amountCents: 5_000,
            paymentMethodName: 'Terminal BBVA',
            paymentMethodSubtitle: 'Débito ···· 4821',
            reference: 'IGNORED',
          },
        ],
      });

      expect(text).toContain('Tarjeta');
      expect(text).toContain('Ref: 084731');
      expect(text).toContain('$1,000.00');
      expect(text).toContain('Terminal BBVA');
      expect(text).toContain('Débito ···· 4821');
      expect(text).not.toContain('IGNORED');
      expect(text).toContain('$50.00');
    });

    it('prints «Sin pagos registrados.» when there are no payments', () => {
      expect(textOf({ ...receipt, payments: [] })).toContain(
        'Sin pagos registrados.',
      );
    });

    it('prints the closing note', () => {
      const text = textOf();

      expect(text).toContain('Gracias por su compra.');
      expect(text).toContain(
        'Este comprobante no constituye una factura fiscal.',
      );
    });

    it('never prints a raw UUID', () => {
      expect(textOf()).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
    });
  });

  describe('totals', () => {
    it('prints Subtotal, Descuentos, Pagado, Cambio and the grand Total', () => {
      const text = textOf();

      expect(text).toContain('Subtotal $250.00');
      expect(text).toContain('Descuentos -$25.00');
      expect(text).toContain('Pagado $250.00');
      expect(text).toContain('Cambio $25.00');
      expect(text).toContain('Total $225.00');
      expect(text).not.toContain('Deuda');
      expect(text).not.toContain('Envío');
    });

    it('prints Envío only when a shipping charge applies', () => {
      expect(textOf(withTotals({ shippingChargeCents: 6_000 }))).toContain(
        'Envío $60.00',
      );
      expect(textOf(withTotals({ shippingChargeCents: 0 }))).not.toContain(
        'Envío',
      );
    });

    it('prints a zero discount without a minus sign', () => {
      expect(textOf(withTotals({ discountCents: 0 }))).toContain(
        'Descuentos $0.00',
      );
    });

    it('omits Pagado and Cambio when they are zero', () => {
      const text = textOf(withTotals({ paidCents: 0, changeDueCents: 0 }));

      expect(text).not.toContain('Pagado');
      expect(text).not.toContain('Cambio');
    });
  });

  describe('palette (L5)', () => {
    const credit = withTotals({
      paidCents: 10_000,
      debtCents: 12_500,
      changeDueCents: 0,
    });

    it('prints a pending debt in the warning colour', () => {
      expect(textOf(credit)).toContain('Deuda $125.00');
      expect(textStyleOf('$125.00', credit).color).toBe(A4_COLORS.warning);
      expect(A4_COLORS.warning).toBe('#805511');
    });

    it('prints the discount in ink, never red', () => {
      const style = textStyleOf('-$25.00');

      expect(style.color).toBe(A4_COLORS.ink);
      expect(A4_COLORS.ink).not.toBe(A4_COLORS.danger);
    });

    it('never uses danger or success on a fully paid receipt (no debt row)', () => {
      const colors = tree()
        .filter((element) => element.type === Text)
        .map((element) => flatStyle(element.props.style).color);

      expect(colors).not.toContain(A4_COLORS.danger);
      expect(colors).not.toContain(A4_COLORS.warning);
      expect(colors).not.toContain(A4_COLORS.success);
    });

    it('has no canceled state, so the template never references danger', () => {
      expect(SOURCE).not.toContain('A4_COLORS.danger');
      expect(SOURCE).not.toContain("tone: 'danger'");
      expect(SOURCE).not.toContain('#b42318');
    });
  });

  describe('footer', () => {
    it('is fixed, labelled with the folio and numbered by a render prop', () => {
      const footer = tree().find(
        (element) =>
          element.type === View &&
          element.props.fixed === true &&
          flattenText(element.props.children as ReactNode).includes(
            'Recibo A-0001',
          ),
      );
      const pageText = tree().find(
        (element) =>
          element.type === Text && typeof element.props.render === 'function',
      );
      const render = pageText?.props.render as (info: {
        pageNumber: number;
        totalPages: number;
      }) => string;

      expect(footer).toBeDefined();
      expect(flattenText(footer?.props.children as ReactNode)).toContain(
        'HoundFe',
      );
      expect(render({ pageNumber: 2, totalPages: 3 })).toBe('Página 2 de 3');
      expect(SOURCE).not.toMatch(/Página \d/);
    });

    it('repeats a continuation header on pages 2+ only', () => {
      const header = tree().find(
        (element) =>
          element.type === View &&
          element.props.fixed === true &&
          typeof element.props.render === 'function',
      );
      const render = header?.props.render as (info: {
        pageNumber: number;
      }) => ReactNode;

      expect(render({ pageNumber: 1 })).toBeNull();
      const continued = flattenText(render({ pageNumber: 2 }));
      expect(continued).toContain('Recibo');
      expect(continued).toContain('Folio #A-0001');
    });
  });
});
