/**
 * Seller sales report A4 on the shared kit (pdf-a4-redesign T5, S2): fields,
 * notices, fixed footer render prop, repeated ledger header and the palette
 * rules (L5) asserted through the element tree. Yoga is mocked under Jest, so
 * page FIT is measured outside Jest; these tests pin structure.
 */
import { readFileSync } from 'node:fs';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import {
  Document,
  Page,
  Text,
  View,
  renderToBuffer,
} from '@react-pdf/renderer';
import {
  SellerSalesReportA4Document,
  debtTone,
} from './seller-sales-report-a4.document';
import { A4_COLORS } from '../shared/a4-kit';
import type {
  SellerSalesReportCanceledRowDto,
  SellerSalesReportConfirmedRowDto,
  SellerSalesReportResponseDto,
} from '../../../analytics/dto/seller-sales-report-response.dto';

const SOURCE = readFileSync(
  `${__dirname}/seller-sales-report-a4.document.tsx`,
  'utf8',
);
const PDF_MAGIC = Buffer.from('%PDF', 'utf8');
const SELLER_ID = '11111111-1111-4111-8111-111111111111';
const BASE_INSTANT = Date.UTC(2026, 0, 1, 18, 30);

function confirmedRow(
  index: number,
  folio?: string | null,
  paymentStatus: SellerSalesReportConfirmedRowDto['paymentStatus'] = 'PARTIAL',
): SellerSalesReportConfirmedRowDto {
  return {
    id: `sale-${String(index).padStart(5, '0')}`,
    folio: folio === undefined ? `A-${String(index).padStart(5, '0')}` : folio,
    confirmedAt: new Date(BASE_INSTANT + index * 60_000).toISOString(),
    totalCents: 10_000 + index,
    paidCents: 4_000,
    debtCents: 6_000 + index,
    paymentStatus,
  };
}

function canceledRow(index: number): SellerSalesReportCanceledRowDto {
  return {
    id: `canceled-${String(index).padStart(5, '0')}`,
    folio: `C-${String(index).padStart(5, '0')}`,
    confirmedAt: new Date(BASE_INSTANT + index * 60_000).toISOString(),
    canceledAt: new Date(BASE_INSTANT + (index + 10) * 60_000).toISOString(),
    totalCents: 5_000 + index,
  };
}

function makeReport(
  confirmedRows: SellerSalesReportConfirmedRowDto[] = [confirmedRow(1)],
  canceledRows: SellerSalesReportCanceledRowDto[] = [],
): SellerSalesReportResponseDto {
  return {
    seller: { id: SELLER_ID, name: 'Vendedor Uno' },
    tenantId: 'tenant-1',
    timeZone: 'America/Mexico_City',
    from: '2026-01-01',
    to: '2026-02-01',
    generatedAt: '2026-03-01T12:00:00.000Z',
    attribution: 'CURRENT_SELLER',
    balances: 'CURRENT',
    rowLimit: 1000,
    rowCount: confirmedRows.length + canceledRows.length,
    confirmed: {
      dateBasis: 'confirmedAt',
      summary: {
        saleCount: confirmedRows.length,
        netSalesCents: 1_000_000,
        collectedCents: 400_000,
        outstandingDebtCents: 600_000,
        averageTicketCents: 10_000,
      },
      rows: confirmedRows,
    },
    canceled: {
      dateBasis: 'canceledAt',
      saleCount: canceledRows.length,
      rows: canceledRows,
    },
  };
}

type AnyElement = ReactElement<Record<string, unknown>>;
const HOST = new Set<unknown>([Document, Page, Text, View]);

/** Expand function components; collect every element in document order. */
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

/** Visible text (strings are joined with a space; callers normalise). */
function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (!isValidElement<{ children?: ReactNode }>(node)) {
    return typeof node === 'string' ? `${node} ` : '';
  }
  if (typeof node.type === 'function' && !HOST.has(node.type)) {
    return textOf((node.type as (props: unknown) => ReactNode)(node.props));
  }
  return textOf(node.props.children);
}

function renderText(report: SellerSalesReportResponseDto): string {
  return textOf(SellerSalesReportA4Document({ report })).replace(/\s+/g, ' ');
}

function flatStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...(style as unknown[]).map(flatStyle)) as Record<
      string,
      unknown
    >;
  }
  return (style as Record<string, unknown>) ?? {};
}

function elementsOf(report: SellerSalesReportResponseDto): AnyElement[] {
  return walk(SellerSalesReportA4Document({ report }));
}

/** Colours of the leaf Text elements whose own string content is `value`. */
function colorOf(report: SellerSalesReportResponseDto, value: string) {
  return elementsOf(report)
    .filter((el) => el.type === Text && el.props.children === value)
    .map((el) => flatStyle(el.props.style).color);
}

describe('SellerSalesReportA4Document', () => {
  it('renders a non-empty PDF buffer with PDF magic bytes', async () => {
    const buffer = await renderToBuffer(
      <SellerSalesReportA4Document report={makeReport()} />,
    );

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)).toBe(true);
  });

  it('renders a 1000-row report as a real PDF (natural pagination)', async () => {
    const rows = Array.from({ length: 1000 }, (_, index) =>
      confirmedRow(index),
    );
    const buffer = await renderToBuffer(
      <SellerSalesReportA4Document report={makeReport(rows)} />,
    );

    expect(buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)).toBe(true);
  }, 120_000);

  it('composes the shared A4 kit with no remote assets or legacy styles', () => {
    expect(SOURCE).toContain("from '../shared/a4-kit'");
    expect(SOURCE).toContain('A4Page');
    expect(SOURCE).toContain('LedgerTable');
    expect(SOURCE).not.toContain('SHARED_STYLES');
    expect(SOURCE).not.toContain('registerModernFont');
    expect(SOURCE).not.toContain('https://');
  });

  it('uses natural pagination: one wrapping A4 page per section, any row count', () => {
    const pages = (rowCount: number) =>
      elementsOf(
        makeReport(Array.from({ length: rowCount }, (_, i) => confirmedRow(i))),
      ).filter((el) => el.type === Page);

    for (const rendered of [pages(1), pages(300)]) {
      // Confirmed + canceled sections; react-pdf decides the physical breaks.
      expect(rendered).toHaveLength(2);
      for (const page of rendered) {
        expect(page.props.wrap).toBe(true);
        expect(page.props.size).toEqual({ width: 595, height: 842 });
      }
    }
  });

  it('repeats the ledger header (fixed) and keeps every row unbreakable', () => {
    const report = makeReport(
      Array.from({ length: 5 }, (_, i) => confirmedRow(i + 1)),
      [canceledRow(1)],
    );
    const elements = elementsOf(report);
    const rows = elements.filter(
      (el) =>
        el.type === View &&
        el.props.wrap === false &&
        !el.props.minPresenceAhead,
    );
    const fixed = elements.filter(
      (el) => el.type === View && el.props.fixed === true && !el.props.render,
    );

    // 5 confirmed + 1 canceled rows, plus the «Ventas netas» strip.
    expect(rows.length).toBeGreaterThanOrEqual(6);
    // per section page: gold mark + footer + ledger header
    expect(fixed).toHaveLength(6);
  });

  it('has a fixed footer with real page numbers and the seller name', () => {
    const report = makeReport();
    const numbered = elementsOf(report).filter(
      (el) => el.type === Text && typeof el.props.render === 'function',
    );

    expect(numbered).toHaveLength(2);
    for (const el of numbered) {
      const render = el.props.render as (info: {
        pageNumber: number;
        totalPages: number;
      }) => string;
      expect(render({ pageNumber: 2, totalPages: 7 })).toBe('Página 2 de 7');
    }
    const text = renderText(report);
    expect(text).toContain('HoundFe · Reporte de ventas · Vendedor Uno');
    expect(text).not.toMatch(/Página \d+ de \d+/);
  });

  it('repeats a compact header (hidden on page 1) naming the seller', () => {
    const header = elementsOf(makeReport()).find(
      (el) =>
        el.type === View &&
        el.props.fixed === true &&
        typeof el.props.render === 'function',
    );
    const render = header?.props.render as (info: {
      pageNumber: number;
    }) => ReactNode;

    expect(render({ pageNumber: 1 })).toBeNull();
    expect(textOf(render({ pageNumber: 2 }))).toContain('Vendedor Uno');
  });

  it('prints every field, column and notice the report had before', () => {
    const rows = (['PAID', 'PARTIAL', 'CREDIT'] as const).map((status, i) =>
      confirmedRow(i + 1, `A-${i + 1}`, status),
    );
    const text = renderText(makeReport(rows, [canceledRow(1)]));

    for (const expected of [
      'Resumen · ventas confirmadas',
      'Ventas',
      'Cobrado',
      'Saldo pendiente',
      'Ticket promedio',
      'Ventas netas',
      '$10,000.00',
      'Ventas confirmadas',
      'por fecha de confirmación',
      'Ventas canceladas',
      'por fecha de cancelación (informativas)',
      'Folio',
      'Confirmada',
      'Cancelada',
      'Total',
      'Pagado',
      'Saldo',
      'Estado',
      'A-1',
      'C-00001',
      'Este reporte se atribuye al vendedor asignado actualmente a cada venta. Si una venta cambió de vendedor, se muestra bajo el vendedor actual; el historial de reasignaciones no se reconstruye.',
      'Los importes de pagado y saldo reflejan el estado actual de cada venta, no flujos por fecha de pago.',
      'Las ventas canceladas se incluyen solo como referencia y no se suman a los totales de ventas confirmadas.',
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).toMatch(/Pagada.*Parcial.*A crédito/s);
    expect(text).not.toMatch(
      /CURRENT_SELLER|CURRENT|confirmedAt|canceledAt|\[from, to\)/,
    );
  });

  it('prints the seller by name and never a raw UUID', () => {
    const text = renderText(makeReport());

    expect(text).toContain('Vendedor Uno');
    expect(text).not.toContain(SELLER_ID);
    expect(text).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });

  it('shows the folio placeholder and the empty-section notices', () => {
    const withoutFolio = renderText(makeReport([confirmedRow(1, null)]));
    const empty = renderText(makeReport([], []));

    expect(withoutFolio).toContain('—');
    expect(empty).toContain('Sin ventas confirmadas en el periodo.');
    expect(empty).toContain('Sin ventas canceladas en el periodo.');
  });

  it('groups money with es-MX separators and two decimals', () => {
    const row = confirmedRow(1, 'A-1');
    row.totalCents = 2_147_483_647;
    row.paidCents = 1_000_000_000;
    row.debtCents = 1_147_483_647;
    const text = renderText(makeReport([row]));

    expect(text).toContain('$21,474,836.47');
    expect(text).toContain('$10,000,000.00');
  });

  it('shows a date-only period with excluded final date and generation time', () => {
    const text = renderText(makeReport([confirmedRow(1)]));

    expect(text).toContain(
      'Del 1 de enero de 2026 al 1 de febrero de 2026 (fecha final excluida)',
    );
    expect(text).toContain('Generado 01 MAR 2026, 06:00 (CDMX)');
  });
});

describe('seller report palette (L5)', () => {
  it('maps the Saldo tone: warning when > 0, success when zero', () => {
    expect(debtTone(1)).toBe('warning');
    expect(debtTone(560_000)).toBe('warning');
    expect(debtTone(0)).toBe('success');
    expect(A4_COLORS.warning).toBe('#805511');
    expect(A4_COLORS.success).toBe('#236044');
  });

  it('colours Saldo cells warning when owed and success when settled', () => {
    const owed = confirmedRow(1, 'A-1', 'PARTIAL');
    owed.debtCents = 56_000;
    const settled = confirmedRow(2, 'A-2', 'PAID');
    settled.debtCents = 0;
    const report = makeReport([owed, settled]);

    expect(colorOf(report, '$560.00')).toEqual([A4_COLORS.warning]);
    expect(colorOf(report, '$0.00')).toEqual([A4_COLORS.success]);
  });

  it('keeps Total / Pagado in ink and never red on confirmed sales', () => {
    const report = makeReport([confirmedRow(1, 'A-1', 'PARTIAL')]);
    const colours = elementsOf(report)
      .filter((el) => el.type === Text)
      .map((el) => flatStyle(el.props.style).color);

    expect(colorOf(report, '$100.01')).toEqual([A4_COLORS.ink]);
    expect(colorOf(report, '$40.00')).toEqual([A4_COLORS.ink]);
    expect(colours).not.toContain(A4_COLORS.danger);
  });

  it('uses red only for the cancellation date of canceled sales', () => {
    const report = makeReport([confirmedRow(1)], [canceledRow(1)]);
    const red = elementsOf(report).filter(
      (el) =>
        el.type === Text &&
        flatStyle(el.props.style).color === A4_COLORS.danger,
    );

    expect(red).toHaveLength(1);
    expect(textOf(red[0].props.children as ReactNode).trim()).toMatch(
      /^\d{2} \w{3} 2026, \d{2}:\d{2}$/,
    );
  });

  it('colours the Saldo pendiente KPI by the same rule', () => {
    const settled = makeReport();
    settled.confirmed.summary.outstandingDebtCents = 0;

    expect(colorOf(makeReport(), '$6,000.00')).toEqual([A4_COLORS.warning]);
    expect(colorOf(settled, '$0.00')).toContain(A4_COLORS.success);
  });
});
