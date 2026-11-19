/**
 * A4 kit — pdf-a4-redesign T2 (S2). Pins the tokens from the approved palette
 * (L5), the ledger rules (rows `wrap={false}`, no fills), the totals block and
 * the fixed footer with real page numbers. Yoga is mocked under Jest, so page
 * FIT is measured outside Jest (see the task log); these tests pin structure.
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
import { SHARED_STYLES } from '../styles';
import {
  A4Footer,
  A4KeyValueColumns,
  A4MetaBar,
  A4Page,
  A4PageHeader,
  A4Section,
  A4TotalsBlock,
  A4_COLORS,
  A4_FONTS,
  A4_STYLES,
  LedgerTable,
  formatA4Date,
  formatA4DateTime,
  formatA4Time,
  px,
  toneColor,
  type LedgerColumn,
} from './index';

type AnyElement = ReactElement<Record<string, unknown>>;
const HOST = new Set<unknown>([Document, Page, Text, View]);

function walk(node: ReactNode, out: AnyElement[] = []): AnyElement[] {
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child as ReactNode, out));
    return out;
  }
  if (!isValidElement<Record<string, unknown>>(node)) {
    return out;
  }
  out.push(node);
  if (typeof node.type === 'function' && !HOST.has(node.type)) {
    walk((node.type as (props: unknown) => ReactNode)(node.props), out);
  } else {
    walk(node.props.children as ReactNode, out);
  }
  return out;
}

function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join('');
  if (!isValidElement<{ children?: ReactNode }>(node)) {
    return typeof node === 'string' ? `${node} ` : '';
  }
  if (typeof node.type === 'function' && !HOST.has(node.type)) {
    return text((node.type as (props: unknown) => ReactNode)(node.props));
  }
  return text(node.props.children);
}

const COLUMNS: readonly LedgerColumn[] = [
  { key: 'name', label: 'Nombre', flex: 2 },
  { key: 'amount', label: 'Importe', flex: 1, align: 'right' },
];

describe('A4 kit tokens (palette L5)', () => {
  it('uses the frontend palette', () => {
    expect(A4_COLORS).toMatchObject({
      accent: '#173968',
      ink: '#24313d',
      muted: '#576574',
      border: '#dce2e8',
      strong: '#8593a3',
      warning: '#805511',
      success: '#236044',
      danger: '#b42318',
      gold: '#f6bb13',
    });
  });

  it('maps artboard px to pt (×0.75) and weight 600 to Helvetica-Bold', () => {
    expect(px(52)).toBe(39);
    expect(px(12.5)).toBe(9.38);
    expect(A4_FONTS).toEqual({
      regular: 'Helvetica',
      bold: 'Helvetica-Bold',
    });
  });

  it('resolves a tone to its palette colour', () => {
    expect(toneColor('warning')).toBe('#805511');
    expect(toneColor('accent')).toBe('#173968');
  });

  it('is additive: the legacy SHARED_STYLES palette is untouched', () => {
    expect(SHARED_STYLES.modern.palette.accent).toBe('#2563EB');
    expect(SHARED_STYLES.modern.palette.ink).toBe('#111827');
  });

  it('draws no fills and no radius anywhere in the kit styles', () => {
    const serialized = JSON.stringify(A4_STYLES);
    expect(serialized).not.toContain('backgroundColor":"#ffffff');
    expect(serialized).not.toContain('borderRadius');
    const fills = Object.values(A4_STYLES)
      .map((style) => (style as Record<string, unknown>).backgroundColor)
      .filter((value) => value !== undefined);
    // The gold brand mark is the ONLY filled shape.
    expect(fills).toEqual([A4_COLORS.gold]);
  });
});

describe('A4 page style (react-pdf 4.5 gotcha)', () => {
  it('has no page-level lineHeight, which makes react-pdf drop the fixed footer', () => {
    expect(A4_STYLES.page).not.toHaveProperty('lineHeight');
  });
});

describe('A4Section', () => {
  it('keeps its heading with the content that follows (minPresenceAhead, unbreakable)', () => {
    const elements = walk(
      A4Section({
        title: 'Sección',
        aside: 'nota',
        children: <Text>cuerpo</Text>,
      }),
    );
    const heading = elements.find(
      (element) => element.type === View && element.props.minPresenceAhead,
    );

    expect(heading?.props.wrap).toBe(false);
    expect(text(A4Section({ title: 'Sección', aside: 'nota' }))).toContain(
      'nota',
    );
  });
});

describe('A4Footer', () => {
  it('is fixed and prints real page numbers via the render prop', () => {
    const elements = walk(A4Footer({ label: 'Corte de caja CC-1' }));

    expect(elements[0].props.fixed).toBe(true);
    const numbered = elements.find(
      (element) =>
        element.type === Text && typeof element.props.render === 'function',
    );
    const render = numbered?.props.render as (info: {
      pageNumber: number;
      totalPages: number;
    }) => string;
    expect(render({ pageNumber: 1, totalPages: 2 })).toBe('Página 1 de 2');
    expect(render({ pageNumber: 5, totalPages: 5 })).toBe('Página 5 de 5');
    expect(text(A4Footer({ label: 'Corte de caja CC-1' }))).toContain(
      'Corte de caja CC-1',
    );
  });
});

describe('A4PageHeader logo and business name', () => {
  const header = { subtitle: 'Doc', kicker: 'Recibo', folio: 'F-1' };

  it('draws the «Logo» placeholder and «HoundFe» when nothing is given', () => {
    const elements = walk(A4PageHeader(header));

    expect(text(A4PageHeader(header))).toContain('Logo');
    expect(text(A4PageHeader(header))).toContain('HoundFe');
    expect(elements.some((element) => element.type === Image)).toBe(false);
  });

  it('draws the image (url or packaged path) instead of the placeholder', () => {
    const element = A4PageHeader({
      ...header,
      brandName: 'Mascotas Felices',
      logoUrl: '/srv/assets/logo.png',
      logoWidth: 72,
    });
    const images = walk(element).filter((el) => el.type === Image);

    expect(images).toHaveLength(1);
    expect(images[0].props.src).toBe('/srv/assets/logo.png');
    expect(images[0].props.style).toEqual([A4_STYLES.logoImage, { width: 72 }]);
    expect(text(element)).toContain('Mascotas Felices');
    expect(text(element)).not.toContain('Logo');
    expect(text(element)).not.toContain('HoundFe');
  });

  it('falls back to «HoundFe» for a blank business name', () => {
    expect(text(A4PageHeader({ ...header, brandName: '   ' }))).toContain(
      'HoundFe',
    );
  });

  it('uses the same business name in the footer and the continuation header', () => {
    const named = text(A4Footer({ label: 'x', brandName: 'Mascotas Felices' }));
    expect(named).toContain('Mascotas Felices');
    expect(named).not.toContain('HoundFe');
    expect(text(A4Footer({ label: 'x' }))).toContain('HoundFe');

    const elements = walk(
      A4Page({
        footerLabel: 'x',
        brandName: 'Mascotas Felices',
        logoUrl: '/srv/assets/logo.png',
        continuation: { kicker: 'Detalle', folio: 'F-1', brandSubtitle: 'Doc' },
        children: null,
      }),
    );
    const fixedRender = elements.find(
      (element) =>
        element.type === View &&
        element.props.fixed === true &&
        typeof element.props.render === 'function',
    );
    const render = fixedRender?.props.render as (info: {
      pageNumber: number;
    }) => ReactNode;
    const continued = render({ pageNumber: 2 });

    expect(text(continued)).toContain('Mascotas Felices');
    expect(text(continued)).not.toContain('HoundFe');
    expect(
      walk(continued).filter((element) => element.type === Image),
    ).toHaveLength(1);
    const footer = elements.find(
      (element) =>
        element.type === View &&
        element.props.fixed === true &&
        typeof element.props.render !== 'function' &&
        text(element.props.children as ReactNode).includes('x'),
    );
    expect(text(footer?.props.children as ReactNode)).toContain(
      'Mascotas Felices',
    );
  });
});

describe('A4 date format (artboard 01-libro-mayor)', () => {
  it('prints lowercase month, 24 h time and the CDMX zone by default', () => {
    // 2026-01-15T18:05Z → 12:05 America/Mexico_City.
    expect(formatA4DateTime('2026-01-15T18:05:00.000Z')).toBe(
      '15 ene 2026, 12:05',
    );
    expect(formatA4Date('2026-01-15T18:05:00.000Z')).toBe('15 ene 2026');
    expect(formatA4Time('2026-01-15T18:05:00.000Z')).toBe('12:05');
  });

  it('honours an explicit zone and never prints 24:00 or a dotted month', () => {
    expect(formatA4Date('2026-12-31T00:00:00.000Z', 'UTC')).toBe('31 dic 2026');
    expect(formatA4DateTime('2026-09-05T06:00:00.000Z', 'UTC')).toBe(
      '05 sep 2026, 06:00',
    );
    expect(formatA4DateTime('2026-09-05T06:00:00.000Z', 'UTC')).not.toMatch(
      /[A-Z.]/,
    );
    expect(formatA4Time('2026-01-15T06:00:00.000Z', 'UTC')).toBe('06:00');
  });

  it('returns unparseable input untouched', () => {
    expect(formatA4DateTime('not-a-date')).toBe('not-a-date');
    expect(formatA4Date('not-a-date')).toBe('not-a-date');
    expect(formatA4Time('not-a-date')).toBe('not-a-date');
  });
});

describe('A4Page', () => {
  it('is ONE wrapping A4 page with a fixed footer and a fixed gold mark', () => {
    const elements = walk(
      A4Page({
        footerLabel: 'x',
        children: <Text>cuerpo</Text>,
      }),
    );
    const page = elements.find((element) => element.type === Page);

    expect(page?.props.wrap).toBe(true);
    expect(page?.props.size).toEqual({ width: 595, height: 842 });
    const fixedViews = elements.filter(
      (element) => element.type === View && element.props.fixed === true,
    );
    // gold mark + footer
    expect(fixedViews).toHaveLength(2);
  });

  it('adds a continuation header that is hidden on page 1 only', () => {
    const elements = walk(
      A4Page({
        footerLabel: 'x',
        continuation: { kicker: 'Detalle', folio: 'F-1', brandSubtitle: 'Doc' },
        children: null,
      }),
    );
    const header = elements.find(
      (element) =>
        element.type === View &&
        element.props.fixed === true &&
        typeof element.props.render === 'function',
    );
    const render = header?.props.render as (info: {
      pageNumber: number;
    }) => ReactNode;

    expect(render({ pageNumber: 1 })).toBeNull();
    expect(text(render({ pageNumber: 2 }))).toContain('F-1');
  });
});

describe('LedgerTable', () => {
  const rows = [
    { key: 'a', cells: { name: 'Uno', amount: '$1.00' } },
    {
      key: 'b',
      cells: {
        name: 'Dos',
        amount: { text: '$2.00', tone: 'warning' as const },
      },
    },
  ];

  it('keeps every body row unbreakable (wrap={false})', () => {
    const elements = walk(LedgerTable({ columns: COLUMNS, rows }));
    const bodyRows = elements.filter(
      (element) => element.type === View && element.props.wrap === false,
    );

    expect(bodyRows).toHaveLength(rows.length);
  });

  it('repeats the header row on continuation pages (fixed) and can opt out', () => {
    const fixedOf = (repeatHeader?: boolean) =>
      walk(LedgerTable({ columns: COLUMNS, rows, repeatHeader })).some(
        (element) => element.type === View && element.props.fixed === true,
      );

    expect(fixedOf()).toBe(true);
    expect(fixedOf(false)).toBe(false);
  });

  it('has muted bold header text with a bottom rule and no fill', () => {
    expect(A4_STYLES.ledgerHeaderText).toMatchObject({
      color: A4_COLORS.muted,
      fontFamily: A4_FONTS.bold,
    });
    expect(A4_STYLES.ledgerHeaderRow).toMatchObject({
      borderBottomColor: A4_COLORS.strong,
    });
    expect(A4_STYLES.ledgerHeaderRow).not.toHaveProperty('backgroundColor');
    expect(A4_STYLES.ledgerRow).toMatchObject({
      borderBottomColor: A4_COLORS.border,
    });
  });

  it('right-aligns amount columns and tints a toned cell', () => {
    const elements = walk(LedgerTable({ columns: COLUMNS, rows }));
    const toned = elements.find(
      (element) =>
        element.type === Text &&
        text(element.props.children as ReactNode).trim() === '$2.00',
    );
    const style = Object.assign(
      {},
      ...((toned?.props.style as Array<Record<string, unknown>>) ?? []),
    ) as Record<string, unknown>;

    expect(style.textAlign).toBe('right');
    expect(style.color).toBe(A4_COLORS.warning);
  });

  it('renders the empty text instead of rows, and a total row in accent', () => {
    const empty = text(
      LedgerTable({ columns: COLUMNS, rows: [], emptyText: 'Sin filas.' }),
    );
    expect(empty).toContain('Sin filas.');

    const withTotal = walk(
      LedgerTable({
        columns: COLUMNS,
        rows,
        total: { key: 't', cells: { name: 'Total', amount: '$3.00' } },
      }),
    );
    const label = withTotal.find(
      (element) =>
        element.type === Text &&
        text(element.props.children as ReactNode).trim() === 'Total',
    );
    const style = Object.assign(
      {},
      ...((label?.props.style as Array<Record<string, unknown>>) ?? []),
    ) as Record<string, unknown>;
    expect(style.color).toBe(A4_COLORS.accent);
    expect(A4_STYLES.ledgerTotalRow).toMatchObject({
      borderTopColor: A4_COLORS.accent,
      borderBottomColor: A4_COLORS.accent,
    });
  });
});

describe('A4TotalsBlock', () => {
  it('prints the «Total» row with accent rules above and below', () => {
    const rendered = text(
      A4TotalsBlock({
        lines: [{ label: 'Subtotal', value: '$10.00' }],
        total: { value: '$10.00' },
      }),
    );

    expect(rendered).toContain('Subtotal');
    expect(rendered).toContain('Total');
    expect(A4_STYLES.totalsGrand).toMatchObject({
      borderTopColor: A4_COLORS.accent,
      borderBottomColor: A4_COLORS.accent,
    });
    expect(A4_STYLES.totalsGrandValue).toMatchObject({
      color: A4_COLORS.accent,
    });
  });
});

describe('A4 kit smoke render', () => {
  it('renders header, meta bar, section, key/value, ledger and totals to a PDF', async () => {
    const buffer = await renderToBuffer(
      <Document>
        <A4Page footerLabel="Prueba F-1">
          <A4PageHeader subtitle="Doc" kicker="Prueba" folio="F-1" />
          <A4MetaBar items={[{ label: 'Fecha', value: 'hoy' }]} />
          <A4Section title="Sección" hint="ayuda">
            <A4KeyValueColumns
              columns={[
                [{ label: 'A', value: '1' }],
                [{ label: 'B', value: '2', tone: 'success' }],
              ]}
            />
            <LedgerTable
              columns={COLUMNS}
              rows={[{ key: 'a', cells: { name: 'Uno', amount: '$1.00' } }]}
            />
          </A4Section>
          <A4TotalsBlock total={{ value: '$1.00' }} />
        </A4Page>
      </Document>,
    );

    expect(buffer.subarray(0, 4).equals(Buffer.from('%PDF'))).toBe(true);
  });
});
