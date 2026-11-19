/**
 * QuotationA4Document — template unit tests (T046 / WU4, pdf-a4-redesign T4).
 *
 * The template composes the shared A4 kit («libro mayor»). Yoga is mocked
 * under Jest, so page FIT is measured outside Jest; these tests pin the
 * element tree: every printed field, the fixed footer render prop
 * («Página X de Y»), the totals lines, and the L5 colour rules (single
 * accent, discounts in ink, never red).
 *
 * Also verified through the real renderer: a non-empty PDF buffer with the
 * PDF magic bytes, offline logo decoding, and no payment surface.
 */
import {
  Document,
  Image,
  Page,
  Text,
  View,
  renderToBuffer,
} from '@react-pdf/renderer';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { A4_COLORS, A4TotalsBlock, LedgerTable } from '../shared/a4-kit';
import {
  QuotationA4Document,
  formatQuotationFolio,
  type QuotationDocumentProps,
} from './quotation-a4.document';

const PDF_MAGIC = Buffer.from('%PDF', 'utf8');

const baseProps: QuotationDocumentProps = {
  business: {
    companyName: 'HoundFe',
    // Embedded 8×8 PNG keeps real image decoding independent of the network.
    logoUrl:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGMwSJiAFTEMLQkACmxIAasRElQAAAAASUVORK5CYII=',
    address: 'Av. Reforma 123, CDMX',
    phone: '+52 55 1234 5678',
  },
  quotation: {
    id: '00000000-0000-4000-8000-000000000001',
    date: '2026-07-20T15:30:00.000Z',
    expiresAt: null,
  },
  customer: {
    name: 'María López',
    email: 'maria@example.com',
  },
  seller: {
    name: 'Ana Vendedora',
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
    includedIvaCents: null,
  },
};

// ── Element-tree helpers (Yoga is mocked; we read the tree, not pixels) ──

type AnyElement = ReactElement<Record<string, unknown>>;
const HOST = new Set<unknown>([Document, Page, Text, View]);

function isComposite(type: unknown): type is (props: unknown) => ReactNode {
  return typeof type === 'function' && !HOST.has(type);
}

/** Depth-first walk that expands our own / kit function components. */
function walk(node: ReactNode, out: AnyElement[] = []): AnyElement[] {
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child as ReactNode, out));
    return out;
  }
  if (!isValidElement<Record<string, unknown>>(node)) {
    return out;
  }
  out.push(node);
  if (isComposite(node.type)) {
    walk(node.type(node.props), out);
  } else {
    walk(node.props.children as ReactNode, out);
  }
  return out;
}

function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (!isValidElement<{ children?: ReactNode }>(node)) return '';
  if (isComposite(node.type)) return textOf(node.type(node.props));
  return textOf(node.props.children);
}

function treeOf(props: QuotationDocumentProps = baseProps): AnyElement[] {
  return walk(QuotationA4Document(props));
}

/** Every static text node of the document, in order. */
function texts(props: QuotationDocumentProps = baseProps): string[] {
  return treeOf(props)
    .filter((el) => el.type === Text && !('render' in el.props))
    .map((el) => textOf(el.props.children as ReactNode))
    .filter((value) => value !== '');
}

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign(
      {},
      ...(style.map(flattenStyle) as object[]),
    ) as Record<string, unknown>;
  }
  return typeof style === 'object' && style !== null
    ? (style as Record<string, unknown>)
    : {};
}

function colorsOf(tree: AnyElement[]): string[] {
  return tree.flatMap((el) => {
    const style = flattenStyle(el.props.style);
    return Object.entries(style)
      .filter(([key]) => /color$/i.test(key))
      .map(([, value]) => String(value));
  });
}

function totalsLines(includedIvaCents: number | null) {
  const props: QuotationDocumentProps = {
    ...baseProps,
    totals: { ...baseProps.totals, includedIvaCents },
  };
  const block = treeOf(props).find((el) => el.type === A4TotalsBlock);
  if (!block) throw new Error('Expected an A4TotalsBlock');
  return block.props as {
    lines: { label: string; value: string; tone?: string }[];
    total: { label?: string; value: string };
  };
}

// ── WU3 — T3.1: IVA incluido aggregate row ──────────────────────────────

describe('QuotationA4Document — IVA incluido row (WU3 / T3.1)', () => {
  it('renders exactly one positive IVA line before the Total', () => {
    const { lines, total } = totalsLines(1600);

    expect(lines.map((l) => `${l.label}${l.value}`)).toEqual([
      'Subtotal$250.00',
      'Descuentos-$25.00',
      'IVA incluido$16.00',
    ]);
    expect(total).toEqual({ value: '$225.00' });
    expect(
      lines.map((l) => l.label).filter((l) => l === 'IVA incluido'),
    ).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toMatch(
      /IVA_16|IVA_0|STANDARD|ZERO_RATED/,
    );
  });

  it('renders exactly one known-zero IVA line', () => {
    expect(totalsLines(0).lines.map((l) => `${l.label}${l.value}`)).toEqual([
      'Subtotal$250.00',
      'Descuentos-$25.00',
      'IVA incluido$0.00',
    ]);
  });

  it('omits the IVA line when the aggregate is unavailable', () => {
    expect(totalsLines(null).lines.map((l) => `${l.label}${l.value}`)).toEqual([
      'Subtotal$250.00',
      'Descuentos-$25.00',
    ]);
  });
});

// ── pdf-a4-redesign T4: fields on the shared A4 kit ─────────────────────

describe('QuotationA4Document — printed fields (kit composition)', () => {
  it('prints the header kicker, folio, brand subtitle and meta bar', () => {
    const printed = texts().join('|');

    expect(printed).toContain('Cotización');
    expect(printed).toContain(`Folio #${baseProps.quotation.id}`);
    expect(printed).toContain('Punto de Venta');
    expect(printed).toContain('Fecha 20 jul 2026');
    expect(printed).toContain('Vendedor Ana Vendedora');
  });

  it('omits the Vendedor item when the seller is null', () => {
    expect(texts({ ...baseProps, seller: null }).join('|')).not.toContain(
      'Vendedor',
    );
  });

  it('prints the customer name and email under «Cliente»', () => {
    const printed = texts();

    expect(printed).toContain('Cliente');
    expect(printed).toContain('María López');
    expect(printed).toContain('maria@example.com');
  });

  it('falls back to «Público en General» and drops a missing email', () => {
    const printed = texts({
      ...baseProps,
      customer: { name: null, email: null },
    });

    expect(printed).toContain('Público en General');
    expect(printed.join('|')).not.toContain('@');
  });

  it('passes the line items to the ledger with name, variant, qty × unit and amount', () => {
    const table = treeOf().find((el) => el.type === LedgerTable);
    const { rows, columns, emptyText } = table?.props as {
      rows: { cells: Record<string, unknown> }[];
      columns: { key: string; label: string }[];
      emptyText: string;
    };

    expect(columns.map((c) => c.label)).toEqual([
      'Descripción',
      'Cantidad × precio',
      'Importe',
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].cells).toEqual({
      description: {
        text: 'Collar clásico',
        bold: true,
        sub: 'Mediano / Negro',
      },
      qty: '2 × $125.00',
      amount: { text: '$225.00', bold: true },
    });
    expect(emptyText).toBe('---');
    // The rendered ledger carries the same strings.
    expect(texts().join('|')).toContain('Mediano / Negro');
  });

  it('keeps zero-item quotations renderable with the «---» placeholder', () => {
    const printed = texts({ ...baseProps, items: [] });
    expect(printed).toContain('---');
  });

  it('prints the no-expiry closing line when expiresAt is null', () => {
    const printed = texts();

    expect(printed).toContain('Sin fecha de expiración');
    expect(printed).toContain('Gracias por confiar en HoundFe');
    expect(printed).toContain(
      'Este comprobante no constituye una factura fiscal.',
    );
    expect(printed.join('|')).not.toContain('Válido hasta');
  });

  it('prints the expiry in the meta bar and the closing line when set', () => {
    const printed = texts({
      ...baseProps,
      quotation: {
        ...baseProps.quotation,
        expiresAt: '2026-12-31T00:00:00.000Z',
      },
    });

    expect(printed).toContain('Válido hasta 31 dic 2026');
    expect(printed).toContain('Válido hasta: 31 dic 2026');
    expect(printed).not.toContain('Sin fecha de expiración');
  });
});

describe('QuotationA4Document — real pagination footer', () => {
  it('uses the kit page with the fixed «Cotización <folio>» footer label', () => {
    const footer = treeOf().find(
      (el) =>
        el.type === View &&
        el.props.fixed === true &&
        typeof el.props.render !== 'function' &&
        textOf(el.props.children as ReactNode).includes('HoundFe'),
    );

    expect(footer).toBeDefined();
    expect(textOf(footer?.props.children as ReactNode)).toContain(
      `HoundFe · Cotización ${baseProps.quotation.id}`,
    );
  });

  it('renders «Página X de Y» through the render prop, not static text', () => {
    const pageText = treeOf().find(
      (el) => el.type === Text && typeof el.props.render === 'function',
    );
    const render = pageText?.props.render as (ctx: {
      pageNumber: number;
      totalPages: number;
    }) => string;

    expect(render({ pageNumber: 2, totalPages: 3 })).toBe('Página 2 de 3');
    expect(texts().join('|')).not.toMatch(/Página \d+ de \d+/);
  });

  it('repeats a continuation header on pages 2+ only', () => {
    const fixedRender = treeOf().find(
      (el) =>
        el.type === View &&
        el.props.fixed === true &&
        typeof el.props.render === 'function',
    );
    const render = fixedRender?.props.render as (ctx: {
      pageNumber: number;
    }) => ReactNode;

    expect(render({ pageNumber: 1 })).toBeNull();
    const continuation = textOf(render({ pageNumber: 2 }));
    expect(continuation).toContain(`Folio #${baseProps.quotation.id}`);
    expect(continuation).toContain('Cotización');
  });

  it('wraps naturally on one A4 page', () => {
    const page = treeOf().find((el) => el.type === Page);

    expect(page?.props.wrap).toBe(true);
  });
});

describe('QuotationA4Document — palette rules (L5)', () => {
  it('colours «Total» with the single accent and never uses red/warning/success', () => {
    const tree = treeOf();
    const colors = colorsOf(tree);

    // «Total» label and amount render in the accent.
    const totalTexts = tree.filter(
      (el) =>
        el.type === Text &&
        (textOf(el.props.children as ReactNode) === 'Total' ||
          textOf(el.props.children as ReactNode) === '$225.00') &&
        flattenStyle(el.props.style).color === A4_COLORS.accent,
    );
    expect(totalTexts).toHaveLength(2);

    expect(colors).not.toContain(A4_COLORS.danger);
    expect(colors).not.toContain(A4_COLORS.warning);
    expect(colors).not.toContain(A4_COLORS.success);
    expect(colors.join(' ')).not.toMatch(/#f00\b|#ff0000|red/i);
  });

  it('prints discounts as «-$X» in ink, never red', () => {
    const { lines } = totalsLines(null);
    const discount = lines.find((l) => l.label === 'Descuentos');

    expect(discount?.value).toBe('-$25.00');
    expect(discount?.tone ?? 'ink').toBe('ink');

    const discountText = treeOf().find(
      (el) =>
        el.type === Text &&
        textOf(el.props.children as ReactNode) === '-$25.00',
    );
    expect(flattenStyle(discountText?.props.style).color).toBe(A4_COLORS.ink);
  });

  it('shows a zero discount as a plain $0.00 (no sign)', () => {
    const printed = texts({
      ...baseProps,
      totals: { ...baseProps.totals, discountCents: 0 },
    });
    expect(printed).toContain('$0.00');
    expect(printed).not.toContain('-$0.00');
  });
});

describe('QuotationA4Document (WU4 / T046)', () => {
  it('renders the logo offline without fetching remote assets', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Network disabled in PDF unit tests'));
    try {
      const buffer = await renderToBuffer(
        <QuotationA4Document {...baseProps} />,
      );
      expect(buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('keeps printing the business logo and falls back to the kit header without one', () => {
    const imageCount = (props: QuotationDocumentProps) =>
      treeOf(props).filter((el) => typeof el.props.src === 'string').length;

    expect(imageCount(baseProps)).toBe(1);
    expect(
      imageCount({
        ...baseProps,
        business: { companyName: 'HoundFe' },
      }),
    ).toBe(0);
    expect(
      texts({ ...baseProps, business: { companyName: 'HoundFe' } }),
    ).toContain('Logo');
    // The logo comes from the kit header (no local header copy).
    const images = treeOf().filter((el) => el.type === Image);
    expect(images).toHaveLength(1);
    expect(images[0].props.src).toBe(baseProps.business.logoUrl);
  });

  it('prints the business name in the header, continuation header and footer', () => {
    const named: QuotationDocumentProps = {
      ...baseProps,
      business: { companyName: 'Mascotas Felices' },
    };
    const footer = treeOf(named).find(
      (el) =>
        el.type === View &&
        el.props.fixed === true &&
        typeof el.props.render !== 'function' &&
        textOf(el.props.children as ReactNode).includes('Cotización'),
    );
    const fixedRender = treeOf(named).find(
      (el) =>
        el.type === View &&
        el.props.fixed === true &&
        typeof el.props.render === 'function',
    );
    const render = fixedRender?.props.render as (ctx: {
      pageNumber: number;
    }) => ReactNode;

    expect(texts(named)).toContain('Mascotas Felices');
    expect(textOf(footer?.props.children as ReactNode)).toBe(
      `Mascotas Felices · Cotización ${baseProps.quotation.id}`,
    );
    expect(textOf(render({ pageNumber: 2 }))).toContain('Mascotas Felices');
    expect(textOf(render({ pageNumber: 2 }))).not.toContain('HoundFe');
  });

  describe('folio', () => {
    it('shortens a quotation UUID to COT- + the first 8 hex chars', () => {
      expect(formatQuotationFolio('3f9a1c2b-1111-4222-8333-444455556666')).toBe(
        'COT-3f9a1c2b',
      );
    });

    it('prints the folio verbatim in the document the caller passes', () => {
      const props: QuotationDocumentProps = {
        ...baseProps,
        quotation: { ...baseProps.quotation, id: 'COT-3f9a1c2b' },
      };

      expect(texts(props)).toContain('Folio #COT-3f9a1c2b');
    });
  });

  it('renders a non-empty PDF buffer with PDF magic bytes', async () => {
    const buffer = await renderToBuffer(<QuotationA4Document {...baseProps} />);

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)).toBe(true);
  });

  it('renders without seller, customer, logo and expiry', async () => {
    const buffer = await renderToBuffer(
      <QuotationA4Document
        {...baseProps}
        seller={null}
        customer={{ name: null, email: null }}
        business={{ companyName: 'HoundFe' }}
      />,
    );
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('exposes a QuotationDocumentProps type with no payment fields', () => {
    // Type-level guarantee — the view-model the registry expects
    // does NOT carry payment surface (paidCents, debtCents,
    // changeDueCents, payments). If a future change widens the type,
    // the spec scenario "PDF does NOT include payment/cambio section"
    // breaks at compile time.
    const typeAssertion: QuotationDocumentProps = baseProps;
    expect(typeAssertion.totals).not.toHaveProperty('paidCents');
    expect(typeAssertion.totals).not.toHaveProperty('debtCents');
    expect(typeAssertion.totals).not.toHaveProperty('changeDueCents');
    expect(typeAssertion).not.toHaveProperty('payments');
  });

  it('prints no payment lines ("Pagado", "Cambio", payment methods)', () => {
    // Spec scenario "quotation-a4 footer has no payment lines" — checked on
    // what the tree actually prints (static text + the footer render prop).
    const printed = texts().join('|');

    expect(printed).not.toMatch(/Pagado|Cambio|Deuda|Efectivo|Tarjeta/);
    expect(printed).not.toMatch(/payment/i);
  });
});
