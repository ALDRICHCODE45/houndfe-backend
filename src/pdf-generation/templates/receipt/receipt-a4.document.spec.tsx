import { readFileSync } from 'node:fs';
import {
  Document,
  Image,
  Page,
  renderToBuffer,
  Text,
  View,
} from '@react-pdf/renderer';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import {
  A4_COLORS,
  A4_LOGO_PATH,
  LedgerTable,
  type LedgerRowData,
} from '../shared/a4-kit';
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

    it('prints the company name from the business', () => {
      const named = {
        ...receipt,
        business: { ...receipt.business, companyName: 'Mascotas Felices' },
      };
      expect(textOf(named)).toContain('Mascotas Felices');
    });

    it('draws the packaged wordmark, ignoring the ticket/email business.logoUrl (no network)', () => {
      const withLogo = {
        ...receipt,
        business: { ...receipt.business, logoUrl: 'https://cdn.test/logo.png' },
      };
      for (const props of [receipt, withLogo]) {
        const images = tree(props).filter((element) => element.type === Image);

        expect(images).toHaveLength(1);
        expect(images[0].props.src).toBe(A4_LOGO_PATH);
        expect(textOf(props)).not.toMatch(/\bLogo\b/);
      }
      // The header is the kit's: no local copy of the header styles.
      expect(SOURCE).toContain('<A4PageHeader');
      expect(SOURCE).not.toContain('function ReceiptHeader');
    });

    it('prints dates in the one A4 format (lowercase month, 24 h, CDMX)', () => {
      const text = textOf();

      // 2026-07-20T15:30Z → 09:30 in America/Mexico_City.
      expect(text).toContain('20 jul 2026, 09:30');
      expect(text).toContain('09:31');
      expect(text).not.toMatch(/JUL/);
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

  describe('per-line promotions (arithmetic reconciliation)', () => {
    // Same fixtures as the thermal ticket spec. Cents:
    //   plain   1 × 1,149.00                                  = 1,149.00 gross
    //   BXGY    2 × 119.50 (unit stays full, R = 119.50)       =   239.00 gross
    //   per-unit 3 × 329.00 base → 296.10 net (10 %, 32.90/u)  =   987.00 gross
    //   Σ gross = 2,375.00 · line discounts 119.50 + 98.70 · order promo 50.00
    //   Descuentos = 268.20 · Envío 60.00 · Total = 2,166.80
    const plain = {
      productName: 'Croquetas Adulto Raza Grande 18 kg',
      variantName: 'Pollo y arroz',
      quantity: 1,
      unitPriceCents: 114_900,
      baseUnitPriceCents: 114_900,
      subtotalCents: 114_900,
    };
    const bxgy = {
      productName: 'Snacks Dentales para Perro',
      variantName: 'Paquete de 12 piezas',
      quantity: 2,
      unitPriceCents: 11_950,
      baseUnitPriceCents: 11_950,
      discountTitle: 'Promo 2×1',
      discountAmountCents: 11_950,
      subtotalCents: 11_950,
    };
    const perUnit = {
      productName: 'Pipeta Antipulgas para Perro',
      variantName: 'Caja de 3 pipetas',
      quantity: 3,
      unitPriceCents: 29_610,
      baseUnitPriceCents: 32_900,
      discountTitle: 'Cliente frecuente 10%',
      discountAmountCents: 3_290,
      subtotalCents: 88_830,
    };
    const mixed: ReceiptDocumentProps = {
      ...receipt,
      items: [plain, bxgy, perUnit],
      totals: {
        subtotalCents: 237_500,
        discountCents: 26_820,
        shippingChargeCents: 6_000,
        totalCents: 216_680,
        paidCents: 216_680,
        debtCents: 0,
        changeDueCents: 0,
      },
    };

    // The shared `receipt` totals carry a 25.00 order discount: zero it when a
    // test asserts that NO «-$» is printed anywhere.
    const noOrderDiscount = { ...receipt.totals, discountCents: 0 };
    const cents = (printed: string): number =>
      Math.round(Number(printed.replace(/[^0-9.-]/g, '')) * 100);
    const printedRows = (props: ReceiptDocumentProps) => {
      const table = tree(props).find((element) => element.type === LedgerTable);
      return (table?.props.rows ?? []) as LedgerRowData[];
    };
    const amountOf = (row: LedgerRowData): string => {
      const cell = row.cells.amount;
      return typeof cell === 'string' ? cell : cell.text;
    };
    const promoOf = (row: LedgerRowData) =>
      (row as { promo?: { label: string; amount: string } }).promo;

    it('prints no discount: qty × unit = amount, no promo row', () => {
      const text = textOf({
        ...receipt,
        items: [plain],
        totals: noOrderDiscount,
      });

      expect(text).toContain('1 × $1,149.00 $1,149.00');
      expect(text).not.toMatch(/-\$/);
    });

    it('BUY_X_GET_Y: prints qty × full unit = gross amount, then the reward as the promo row', () => {
      const text = textOf({ ...receipt, items: [bxgy] });

      expect(text).toContain('2 × $119.50 $239.00');
      expect(text).toContain('Promo 2×1 -$119.50');
      expect(text).not.toContain('2 × $119.50 $119.50');
    });

    it('per-unit discount: prints qty × BASE price = gross amount, then the line total discount', () => {
      const text = textOf({ ...receipt, items: [perUnit] });

      expect(text).toContain('3 × $329.00 $987.00');
      expect(text).toContain('Cliente frecuente 10% -$98.70');
      expect(text).not.toContain('$296.10');
      expect(text).not.toContain('$888.30');
    });

    it('falls back to «Descuento» when the promo title is missing', () => {
      const text = textOf({
        ...receipt,
        items: [{ ...bxgy, discountTitle: null }],
      });

      expect(text).toContain('Descuento -$119.50');
    });

    it('prints no promo row when the discount amount is zero (net equals gross)', () => {
      const zero = textOf({
        ...receipt,
        items: [{ ...bxgy, discountAmountCents: 0, subtotalCents: 23_900 }],
        totals: noOrderDiscount,
      });

      expect(zero).toContain('2 × $119.50 $239.00');
      expect(zero).not.toContain('Promo');
      expect(zero).not.toMatch(/-\$/);
    });

    it('reconciles: Σ item amounts = Subtotal and Subtotal − Descuentos + Envío = Total', () => {
      const rows = printedRows(mixed);
      const amounts = rows.map((row) => cents(amountOf(row)));
      const promos = rows.flatMap((row) => {
        const promo = promoOf(row);
        return promo ? [cents(promo.amount)] : [];
      });
      const text = textOf(mixed);

      expect(amounts).toEqual([114_900, 23_900, 98_700]);
      expect(promos).toEqual([-11_950, -9_870]);
      expect(amounts.reduce((sum, value) => sum + value, 0)).toBe(
        mixed.totals.subtotalCents,
      );
      expect(text).toContain('Subtotal $2,375.00');
      expect(text).toContain('Descuentos -$268.20');
      expect(text).toContain('Envío $60.00');
      expect(text).toContain('Total $2,166.80');
      expect(
        mixed.totals.subtotalCents -
          mixed.totals.discountCents +
          (mixed.totals.shippingChargeCents ?? 0),
      ).toBe(mixed.totals.totalCents);
    });

    it('prints an order-level promotion only in Descuentos, never under a line', () => {
      // Line discounts 21,820 + order promo 5,000 = Descuentos 26,820.
      const lineDiscounts = -printedRows(mixed)
        .flatMap((row) => {
          const promo = promoOf(row);
          return promo ? [cents(promo.amount)] : [];
        })
        .reduce((sum, value) => sum + value, 0);

      expect(lineDiscounts).toBe(21_820);
      expect(mixed.totals.discountCents - lineDiscounts).toBe(5_000);
      expect(
        textOf({ ...receipt, items: [plain], totals: noOrderDiscount }),
      ).not.toMatch(/-\$/);
      expect(
        textOf({
          ...receipt,
          items: [plain],
          totals: { ...receipt.totals, discountCents: 5_000 },
        }),
      ).toContain('Descuentos -$50.00');
    });

    it('without baseUnitPriceCents the unit price is the base (BXGY still reconciles)', () => {
      const { baseUnitPriceCents: _omitted, ...legacy } = bxgy;
      void _omitted;
      const text = textOf({ ...receipt, items: [legacy] });

      expect(text).toContain('2 × $119.50 $239.00');
      expect(text).toContain('Promo 2×1 -$119.50');
    });

    it('prints the promo row in ink (never red) with a muted label', () => {
      const props = { ...receipt, items: [bxgy] };
      const amount = textStyleOf('-$119.50', props);
      const label = textStyleOf('Promo 2×1', props);

      expect(amount.color).toBe(A4_COLORS.ink);
      expect(label.color).toBe(A4_COLORS.muted);
      expect(amount.color).not.toBe(A4_COLORS.danger);
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
      expect(SOURCE).not.toContain("'HoundFe'");
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

    it('uses the business name in the footer and the continuation header', () => {
      const named = {
        ...receipt,
        business: { ...receipt.business, companyName: 'Mascotas Felices' },
      };
      const footer = tree(named).find(
        (element) =>
          element.type === View &&
          element.props.fixed === true &&
          flattenText(element.props.children as ReactNode).includes(
            'Recibo A-0001',
          ),
      );
      const header = tree(named).find(
        (element) =>
          element.type === View &&
          element.props.fixed === true &&
          typeof element.props.render === 'function',
      );
      const render = header?.props.render as (info: {
        pageNumber: number;
      }) => ReactNode;
      const footerText = flattenText(footer?.props.children as ReactNode);

      expect(footerText).toContain('Mascotas Felices');
      expect(footerText).not.toContain('HoundFe');
      expect(flattenText(render({ pageNumber: 2 }))).toContain(
        'Mascotas Felices',
      );
    });
  });
});
