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
import { ReceiptTicketDocument } from './receipt-ticket.document';
import type { ReceiptDocumentProps } from './receipt.types';
import { TICKET_COLORS, TICKET_SIZES, TICKET_STYLES } from './ticket-kit';

const SOURCE = readFileSync(`${__dirname}/receipt-ticket.document.tsx`, 'utf8');

const PDF_MAGIC = Buffer.from('%PDF', 'utf8');

const LONG_NAME =
  'Croquetas Premium Adulto Raza Grande Pollo y Arroz con Vegetales Bolsa de 18 kg Edición Especial';

const receipt: ReceiptDocumentProps = {
  business: {
    companyName: 'HoundFe',
    address: 'Av. Reforma 123, CDMX',
    phone: '+52 55 1234 5678',
  },
  sale: {
    folio: 'T-0042',
    date: '2026-01-15T18:05:00.000Z',
    cashier: 'Ana García',
    seller: 'Luis Pérez',
  },
  customer: {
    name: null,
  },
  items: [
    {
      productName: 'Croquetas Adulto Raza Grande 18 kg',
      variantName: 'Pollo y arroz',
      quantity: 1,
      unitPriceCents: 114_900,
      subtotalCents: 114_900,
    },
  ],
  totals: {
    subtotalCents: 114_900,
    discountCents: 0,
    totalCents: 114_900,
    paidCents: 120_000,
    debtCents: 0,
    changeDueCents: 5_100,
  },
  payments: [
    {
      method: 'CASH',
      amountCents: 120_000,
      reference: null,
      paidAt: '2026-01-15T18:05:00.000Z',
    },
  ],
};

// ── Element-tree helpers (kit components are expanded, host ones recursed) ──

const HOST_COMPONENTS = new Set<unknown>([Document, Page, Text, View, Image]);

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
  return collectElements(ReceiptTicketDocument(props));
}

/** Whitespace-normalized printed text, with one space between text nodes. */
function textOf(props: ReceiptDocumentProps = receipt): string {
  return flattenText(ReceiptTicketDocument(props)).replace(/\s+/g, ' ');
}

function withTotals(
  totals: Partial<ReceiptDocumentProps['totals']>,
): ReceiptDocumentProps {
  return { ...receipt, totals: { ...receipt.totals, ...totals } };
}

describe('ReceiptTicketDocument', () => {
  it('renders a non-empty PDF buffer with PDF magic bytes', async () => {
    const buffer = await renderToBuffer(<ReceiptTicketDocument {...receipt} />);

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)).toBe(true);
  });

  it('renders a long sale with wrapped names, promos, debt and payments', async () => {
    const buffer = await renderToBuffer(
      <ReceiptTicketDocument
        {...receipt}
        customer={{ name: 'Rosa Elena Cárdenas Juárez' }}
        items={Array.from({ length: 12 }, (_, index) => ({
          productName: index % 3 === 0 ? LONG_NAME : `Producto ${index}`,
          variantName: 'Talla M · Rojo',
          quantity: 2,
          unitPriceCents: 11_950,
          discountTitle: index === 3 ? 'Promo 2×1' : null,
          discountAmountCents: index === 3 ? 11_950 : null,
          subtotalCents: 23_900,
        }))}
        totals={{ ...receipt.totals, paidCents: 4_000, debtCents: 101_460 }}
      />,
    );

    expect(buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)).toBe(true);
  });

  describe('structure', () => {
    it('is one non-wrapping page, 227 pt wide, with NO fixed height', () => {
      const document = ReceiptTicketDocument(receipt) as ReactElement<{
        title: string;
      }>;
      const pages = tree().filter((element) => element.type === Page);
      const props = pages[0].props as {
        wrap?: boolean;
        size: { width: number; height?: number };
      };

      expect(document.props.title).toBe('Ticket T-0042');
      expect(pages).toHaveLength(1);
      expect(props.wrap).toBe(false);
      // Width only: react-pdf derives the height from the laid-out content,
      // so wrapped names / promos / debt box can never be clipped.
      expect(props.size).toEqual({ width: 227 });
      expect(SOURCE).not.toContain('getTicketHeight');
    });

    it('composes the ticket kit and no legacy shared blocks', () => {
      expect(SOURCE).toContain("from './ticket-kit'");
      expect(SOURCE).not.toContain('SHARED_STYLES');
      expect(SOURCE).not.toContain('getModernFontFamily');
      expect(SOURCE).not.toContain('<LineItemsTable');
      expect(SOURCE).not.toContain('<TotalsBlock');
      expect(SOURCE).not.toContain('<ReceiptHeader');
      expect(SOURCE).not.toContain('<PaymentsList');
      expect(SOURCE).not.toContain('<CustomerSection');
    });

    it('draws a text wordmark, never an image logo', () => {
      expect(tree().some((element) => element.type === Image)).toBe(false);
      const wordmarks = tree().filter(
        (element) =>
          element.type === Text &&
          flatStyle(element.props.style).fontSize === TICKET_SIZES.wordmark,
      );
      expect(wordmarks).toHaveLength(1);
      expect(flattenText(wordmarks[0].props.children as ReactNode).trim()).toBe(
        'HoundFe',
      );
    });
  });

  describe('fields', () => {
    it('prints brand, title, folio, date and operators', () => {
      const text = textOf();

      expect(text).toContain('HoundFe');
      expect(text).toContain('RECIBO');
      expect(text).toContain('FOLIO #T-0042');
      expect(text).toContain('FECHA');
      expect(text).toContain('15 ene 2026, 12:05');
      expect(text).toContain('CAJERO');
      expect(text).toContain('Ana García');
      expect(text).toContain('VENDEDOR');
      expect(text).toContain('Luis Pérez');
    });

    it('uses the business name the props carry, defaulting to HoundFe', () => {
      expect(
        textOf({ ...receipt, business: { companyName: 'Patitas Felices' } }),
      ).toContain('Patitas Felices');
      expect(
        textOf({ ...receipt, business: { companyName: '   ' } }),
      ).toContain('HoundFe');
    });

    it('does not print address or phone (as before)', () => {
      const text = textOf();

      expect(text).not.toContain('Reforma');
      expect(text).not.toContain('+52 55');
    });

    it('prints the customer name or the public placeholder', () => {
      expect(textOf()).toContain('CLIENTE Público en General');
      expect(textOf({ ...receipt, customer: { name: '  ' } })).toContain(
        'Público en General',
      );
      expect(
        textOf({ ...receipt, customer: { name: 'Rosa Elena Cárdenas' } }),
      ).toContain('CLIENTE Rosa Elena Cárdenas');
    });

    it('prints each product: name, variant · qty × price and the line amount', () => {
      const text = textOf();

      expect(text).toContain('PRODUCTO');
      expect(text).toContain('IMPORTE');
      expect(text).toContain('Croquetas Adulto Raza Grande 18 kg');
      expect(text).toContain('Pollo y arroz · 1 × $1,149.00');
      expect(text).toContain('$1,149.00');
    });

    it('prints fractional quantities trimmed and variant-less lines without a dot', () => {
      const text = textOf({
        ...receipt,
        items: [
          {
            productName: 'Croquetas a granel',
            quantity: 2.5,
            unitPriceCents: 6_200,
            subtotalCents: 15_500,
          },
        ],
      });

      expect(text).toContain('2.5 × $62.00');
      expect(text).not.toContain('· 2.5');
    });

    it('prints the empty-items placeholder', () => {
      expect(textOf({ ...receipt, items: [] })).toContain('---');
    });

    it('prints totals in the A4 order with the TOTAL last', () => {
      const text = textOf(
        withTotals({
          subtotalCents: 510_700,
          discountCents: 15_240,
          shippingChargeCents: 6_000,
          totalCents: 501_460,
          paidCents: 400_000,
          debtCents: 0,
          changeDueCents: 32_300,
        }),
      );
      const order = [
        'Subtotal $5,107.00',
        'Descuentos -$152.40',
        'Envío $60.00',
        'Pagado $4,000.00',
        'Cambio $323.00',
        'TOTAL $5,014.60',
      ].map((label) => text.indexOf(label));

      expect(order.every((index) => index >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it('prints $0.00 for zero discounts and omits Envío / Pagado / Cambio at zero', () => {
      const text = textOf(
        withTotals({ paidCents: 0, changeDueCents: 0, debtCents: 0 }),
      );

      expect(text).toContain('Descuentos $0.00');
      expect(text).not.toContain('Envío');
      expect(text).not.toContain('Pagado');
      expect(text).not.toContain('Cambio');
      expect(text).not.toContain('Deuda');
    });

    it('prints each payment: method, time, subtitle / reference and amount', () => {
      const text = textOf({
        ...receipt,
        payments: [
          {
            method: 'CASH',
            amountCents: 200_000,
            paidAt: '2026-01-15T18:05:00.000Z',
          },
          {
            method: 'CARD',
            amountCents: 100_000,
            reference: '084731',
            paidAt: '2026-01-15T18:06:00.000Z',
            paymentMethodName: 'Terminal BBVA',
            paymentMethodSubtitle: 'Débito ···· 4821',
          },
          { method: 'TRANSFER', amountCents: 50_000, reference: 'SPEI-1' },
        ],
      });

      expect(text).toContain('PAGOS');
      expect(text).toContain('MONTO');
      expect(text).toContain('Efectivo 12:05');
      expect(text).toContain('$2,000.00');
      expect(text).toContain('Terminal BBVA 12:06');
      expect(text).not.toContain('Tarjeta');
      expect(text).toContain('Débito ···· 4821 · Ref: 084731');
      expect(text).toContain('Transferencia');
      expect(text).toContain('Ref: SPEI-1');
    });

    it('prints the empty-payments placeholder and the closing notes', () => {
      const text = textOf({ ...receipt, payments: [] });

      expect(text).toContain('Sin pagos registrados.');
      expect(text).toContain('Gracias por su compra.');
      expect(text).toContain(
        'Este comprobante no constituye una factura fiscal.',
      );
    });
  });

  describe('product names wrap (no truncation)', () => {
    it('prints a 90+ character name in full, with no ellipsis', () => {
      const text = textOf({
        ...receipt,
        items: [
          {
            productName: LONG_NAME,
            variantName: 'Bolsa de 18 kg · Edición especial de temporada',
            quantity: 1,
            unitPriceCents: 114_900,
            subtotalCents: 114_900,
          },
        ],
      });

      expect(LONG_NAME.length).toBeGreaterThan(90);
      expect(text).toContain(LONG_NAME);
      expect(text).toContain('Bolsa de 18 kg · Edición especial de temporada');
      expect(text).not.toContain('…');
    });

    it('lets product-name Text wrap: no numberOfLines / maxLines / fixed height', () => {
      const names = tree().filter(
        (element) =>
          element.type === Text &&
          flattenText(element.props.children as ReactNode).trim() ===
            'Croquetas Adulto Raza Grande 18 kg',
      );

      expect(names).toHaveLength(1);
      expect(names[0].props).not.toHaveProperty('numberOfLines');
      expect(names[0].props).not.toHaveProperty('maxLines');
      expect(flatStyle(names[0].props.style)).not.toHaveProperty('height');
      expect(flatStyle(names[0].props.style)).not.toHaveProperty('maxHeight');
      expect(SOURCE).not.toMatch(/truncate|slice\(/i);
    });
  });

  describe('per-line promotions (arithmetic reconciliation)', () => {
    // Realistic mixed sale. Cents:
    //   plain   1 × 1,149.00                                  = 1,149.00 gross
    //   BXGY    2 × 119.50 (unit stays full, R = 119.50)       =   239.00 gross
    //   per-unit 3 × 329.00 base → 296.10 net (10 %, 32.90/u)  =   987.00 gross
    //   Σ gross = 2,375.00 · line discounts 119.50 + 98.70 · order promo 50.00
    //   Descuentos = 268.20 · Envío 60.00 · TOTAL = 2,166.80
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

    const cents = (printed: string): number =>
      Math.round(Number(printed.replace(/[^0-9.-]/g, '')) * 100);
    const printedBy = (style: unknown, props: ReceiptDocumentProps) =>
      tree(props)
        .filter((element) => element.props.style === style)
        .map((element) =>
          flattenText(element.props.children as ReactNode).trim(),
        );

    it('prints no discount: qty × unit = amount, no promo row', () => {
      const text = textOf({ ...receipt, items: [plain] });

      expect(text).toContain('Pollo y arroz · 1 × $1,149.00 $1,149.00');
      expect(text).not.toMatch(/-\$/);
    });

    it('BUY_X_GET_Y: prints qty × full unit = gross amount, then the reward as the promo line', () => {
      const text = textOf({ ...receipt, items: [bxgy] });

      expect(text).toContain('Paquete de 12 piezas · 2 × $119.50 $239.00');
      expect(text).toContain('Promo 2×1 -$119.50');
      expect(text).not.toContain('2 × $119.50 $119.50');
    });

    it('per-unit discount: prints qty × BASE price = gross amount, then the line total discount', () => {
      const text = textOf({ ...receipt, items: [perUnit] });

      expect(text).toContain('Caja de 3 pipetas · 3 × $329.00 $987.00');
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
      });

      expect(zero).toContain('2 × $119.50 $239.00');
      expect(zero).not.toContain('Promo');
      expect(zero).not.toMatch(/-\$/);
    });

    it('reconciles: Σ item amounts = Subtotal and Subtotal − Descuentos + Envío = TOTAL', () => {
      const amounts = printedBy(TICKET_STYLES.itemAmount, mixed).map(cents);
      const promos = printedBy(TICKET_STYLES.itemDiscountAmount, mixed).map(
        cents,
      );
      const text = textOf(mixed);

      expect(amounts).toEqual([114_900, 23_900, 98_700]);
      expect(promos).toEqual([-11_950, -9_870]);
      expect(amounts.reduce((sum, value) => sum + value, 0)).toBe(
        mixed.totals.subtotalCents,
      );
      expect(text).toContain('Subtotal $2,375.00');
      expect(text).toContain('Descuentos -$268.20');
      expect(text).toContain('Envío $60.00');
      expect(text).toContain('TOTAL $2,166.80');
      expect(
        mixed.totals.subtotalCents -
          mixed.totals.discountCents +
          (mixed.totals.shippingChargeCents ?? 0),
      ).toBe(mixed.totals.totalCents);
    });

    it('prints an order-level promotion only in Descuentos, never under a line', () => {
      // Line discounts 21,820 + order promo 5,000 = Descuentos 26,820.
      const promoRows = printedBy(TICKET_STYLES.itemDiscountAmount, mixed).map(
        cents,
      );
      const lineDiscounts = -promoRows.reduce((sum, value) => sum + value, 0);

      expect(lineDiscounts).toBe(21_820);
      expect(mixed.totals.discountCents - lineDiscounts).toBe(5_000);
      expect(textOf({ ...receipt, items: [plain] })).not.toMatch(/-\$/);
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
  });

  describe('debt box', () => {
    it('is drawn (bordered, no fill) only when the debt is greater than zero', () => {
      const withDebt = withTotals({ paidCents: 400_000, debtCents: 101_460 });
      const text = textOf(withDebt);

      expect(text).toContain('Deuda $1,014.60');
      expect(text).toContain('Saldo pendiente de pago');

      const box = tree(withDebt).find((element) => {
        const style = flatStyle(element.props.style);
        return element.type === View && style.borderWidth !== undefined;
      });
      expect(box).toBeDefined();
      expect(flatStyle(box?.props.style)).toEqual(
        expect.objectContaining({
          borderWidth: 1.5,
          borderColor: TICKET_COLORS.ink,
        }),
      );
      expect(flatStyle(box?.props.style)).not.toHaveProperty('backgroundColor');
    });

    it('is absent when there is no debt', () => {
      const noDebt = tree().filter(
        (element) =>
          element.type === View &&
          flatStyle(element.props.style).borderWidth !== undefined,
      );

      expect(noDebt).toHaveLength(0);
      expect(textOf()).not.toContain('Saldo pendiente');
    });
  });

  describe('1-bit palette and type scale', () => {
    const ALLOWED = new Set<string>([TICKET_COLORS.ink, TICKET_COLORS.paper]);
    const COLOR_KEYS = [
      'color',
      'backgroundColor',
      'borderColor',
      'borderTopColor',
      'borderBottomColor',
      'borderLeftColor',
      'borderRightColor',
    ];
    const richProps: ReceiptDocumentProps = {
      ...receipt,
      customer: { name: 'Rosa Elena' },
      items: [
        {
          productName: LONG_NAME,
          variantName: 'M',
          quantity: 2,
          unitPriceCents: 11_950,
          discountTitle: 'Promo 2×1',
          discountAmountCents: 11_950,
          subtotalCents: 11_950,
        },
      ],
      totals: {
        subtotalCents: 23_900,
        discountCents: 11_950,
        shippingChargeCents: 6_000,
        totalCents: 17_950,
        paidCents: 4_000,
        debtCents: 13_950,
        changeDueCents: 100,
      },
    };

    it('uses only #000 on #fff (no grays, no fills) in every style', () => {
      const used = new Set<string>();
      for (const element of tree(richProps)) {
        const style = flatStyle(element.props.style);
        for (const key of COLOR_KEYS) {
          if (typeof style[key] === 'string') used.add(style[key]);
        }
      }

      expect(used.size).toBeGreaterThan(0);
      for (const color of used) {
        expect(ALLOWED.has(color)).toBe(true);
      }
    });

    it('never goes below the 8.25 pt (11 px) artboard minimum', () => {
      for (const element of tree(richProps)) {
        const { fontSize } = flatStyle(element.props.style);
        if (typeof fontSize === 'number') {
          expect(fontSize).toBeGreaterThanOrEqual(TICKET_SIZES.base);
        }
      }
    });

    it('uses only the built-in Helvetica pair (no font registration)', () => {
      const families = new Set<string>();
      for (const element of tree(richProps)) {
        const { fontFamily } = flatStyle(element.props.style);
        if (typeof fontFamily === 'string') families.add(fontFamily);
      }

      expect([...families].sort()).toEqual(['Helvetica', 'Helvetica-Bold']);
      expect(SOURCE).not.toContain('Font.register');
    });
  });
});
