/**
 * Deterministic pagination, render/structural and user-facing output tests.
 */
import { readFileSync } from 'node:fs';
import { Children, isValidElement, type ReactNode } from 'react';
import {
  Document,
  Image,
  Page,
  Text,
  View,
  renderToBuffer,
} from '@react-pdf/renderer';
import {
  SELLER_REPORT_FIRST_PAGE_BUDGET,
  SELLER_REPORT_PAGE_BUDGET,
  SellerSalesReportA4Document,
  paginateSellerReportCanceled,
  paginateSellerReportConfirmed,
} from './seller-sales-report-a4.document';
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

/** react-pdf host components: recurse their children instead of invoking. */
const HOST_COMPONENTS = new Set<unknown>([Document, Page, Text, View, Image]);

/** Flatten a rendered react-pdf element tree into its visible text. */
function flattenText(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(flattenText).join('');
  if (!isValidElement<{ children?: ReactNode }>(node)) {
    return typeof node === 'string' ? `${node} ` : '';
  }
  if (typeof node.type === 'function' && !HOST_COMPONENTS.has(node.type)) {
    const Component = node.type as (props: unknown) => ReactNode;
    return flattenText(Component(node.props));
  }
  return flattenText(node.props.children);
}

function renderText(report: SellerSalesReportResponseDto): string {
  return flattenText(SellerSalesReportA4Document({ report }));
}

describe('seller report pagination', () => {
  it('keeps an empty confirmed section on a single empty page', () => {
    expect(paginateSellerReportConfirmed([])).toEqual([[]]);
  });

  it('keeps an empty canceled section on a single empty page', () => {
    expect(paginateSellerReportCanceled([])).toEqual([[]]);
  });

  it('never drops, duplicates or reorders confirmed rows across pages', () => {
    const rows = Array.from({ length: 1000 }, (_, index) =>
      confirmedRow(index),
    );
    const pages = paginateSellerReportConfirmed(rows);

    expect(pages.flat()).toEqual(rows);
    expect(pages[0].length).toBeLessThanOrEqual(
      SELLER_REPORT_FIRST_PAGE_BUDGET,
    );
    for (const page of pages.slice(1)) {
      expect(page.length).toBeLessThanOrEqual(SELLER_REPORT_PAGE_BUDGET);
    }
  });

  it('never drops, duplicates or reorders canceled rows across pages', () => {
    const rows = Array.from({ length: 1000 }, (_, index) => canceledRow(index));
    const pages = paginateSellerReportCanceled(rows);

    expect(pages.flat()).toEqual(rows);
    for (const page of pages) {
      expect(page.length).toBeLessThanOrEqual(SELLER_REPORT_PAGE_BUDGET);
    }
  });

  it('spreads long folios across more pages than short folios', () => {
    const short = Array.from({ length: 200 }, (_, index) =>
      confirmedRow(index, `A-${index}`),
    );
    const long = Array.from({ length: 200 }, (_, index) =>
      confirmedRow(index, 'FOLIO-EXTENSO-'.repeat(8)),
    );

    expect(paginateSellerReportConfirmed(long).length).toBeGreaterThan(
      paginateSellerReportConfirmed(short).length,
    );
  });
});

describe('SellerSalesReportA4Document', () => {
  it('renders a non-empty PDF buffer with PDF magic bytes', async () => {
    const buffer = await renderToBuffer(
      <SellerSalesReportA4Document report={makeReport()} />,
    );

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)).toBe(true);
  });

  it('uses the shared modern tokens with the built-in Helvetica family', () => {
    expect(SOURCE).toContain('SHARED_STYLES.modern');
    expect(SOURCE).toContain("fontFamily: 'Helvetica'");
    expect(SOURCE).not.toContain('getModernFontFamily');
    expect(SOURCE).not.toContain('registerModernFont');
  });

  it('resolves the packaged logo from a runtime dirname path, never a remote URL', () => {
    expect(SOURCE).toContain('resolve(');
    expect(SOURCE).toContain('__dirname');
    expect(SOURCE).toContain('houndfe-logo-report.png');
    expect(SOURCE).not.toContain('https://');
    expect(SOURCE).not.toContain('LOGO_URL');
  });

  it('renders exactly one Page per computed confirmed + canceled chunk', () => {
    const report = makeReport(
      Array.from({ length: 40 }, (_, index) => confirmedRow(index)),
      [canceledRow(1)],
    );
    const element = SellerSalesReportA4Document({ report }) as unknown as {
      props: { children: ReactNode };
    };
    const pages = Children.toArray(element.props.children).filter(
      (child) => isValidElement(child) && child.type === Page,
    );

    expect(pages).toHaveLength(
      paginateSellerReportConfirmed(report.confirmed.rows).length +
        paginateSellerReportCanceled(report.canceled.rows).length,
    );
  });

  it('renders Spanish labels, translated statuses and no technical markers', () => {
    const rows = (['PAID', 'PARTIAL', 'CREDIT'] as const).map((status, i) =>
      confirmedRow(i + 1, `A-${i + 1}`, status),
    );
    const text = renderText(makeReport(rows, [canceledRow(1)]));

    expect(text).toContain('Resumen · ventas confirmadas');
    expect(text).toContain('Ventas confirmadas · por fecha de confirmación');
    expect(text).toContain(
      'Ventas canceladas · por fecha de cancelación (informativas)',
    );
    expect(text).toMatch(/Pagada.*Parcial.*A crédito/s);
    expect(text).not.toMatch(
      /CURRENT_SELLER|CURRENT|confirmedAt|canceledAt|\[from, to\)/,
    );
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
    expect(text).toContain('Generado 01 MAR 2026, 06:00');
  });
});
