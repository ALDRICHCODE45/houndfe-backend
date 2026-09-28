/**
 * SellerSalesReportA4Document — branded A4 PDF for the seller sales report
 * (`GET /analytics/sales/sellers/:sellerUserId/report/pdf`).
 *
 * Shared `SHARED_STYLES.modern` tokens, built-in Helvetica (deterministic,
 * no font CDN/registration) and the packaged local wordmark from `__dirname`.
 * Up to 1000 rows are chunked into explicit Pages with repeated headers and a
 * `Página X de Y` footer; rows are never split or truncated.
 */
import {
  Document,
  Image,
  Page,
  StyleSheet,
  Text,
  View,
} from '@react-pdf/renderer';
import { resolve } from 'node:path';
import { PAPER_SIZES } from '../../pdf-generation.constants';
import { SHARED_STYLES } from '../shared/styles';
import type {
  SellerSalesReportCanceledRowDto,
  SellerSalesReportConfirmedRowDto,
  SellerSalesReportResponseDto,
} from '../../../analytics/dto/seller-sales-report-response.dto';

const REPORT_TIME_ZONE = 'America/Mexico_City';

const STATUS_LABELS: Record<string, string> = {
  PAID: 'Pagada',
  PARTIAL: 'Parcial',
  CREDIT: 'A crédito',
};

/** Packaged local wordmark — `nest-cli.json` copies it to the same `dist` path. */
export const SELLER_REPORT_LOGO_PATH = resolve(
  __dirname,
  '..',
  '..',
  'assets',
  'houndfe-logo-report.png',
);

const FOLIO_CHARS_PER_LINE = 20;
// Below react-pdf's ~25-row capacity so a logical Page never splits.
export const SELLER_REPORT_FIRST_PAGE_BUDGET = 11;
export const SELLER_REPORT_PAGE_BUDGET = 20;

function rowLineCost(folio: string | null): number {
  const characters = (folio ?? '—').length;
  return Math.max(1, Math.ceil(characters / FOLIO_CHARS_PER_LINE));
}

function paginateSellerReportRows<T extends { folio: string | null }>(
  rows: readonly T[],
  firstPageBudget: number,
  pageBudget: number,
): T[][] {
  if (rows.length === 0) {
    return [[]];
  }

  const pages: T[][] = [];
  let current: T[] = [];
  let budget = firstPageBudget;
  let used = 0;

  for (const row of rows) {
    const cost = rowLineCost(row.folio);
    if (current.length > 0 && used + cost > budget) {
      pages.push(current);
      current = [];
      used = 0;
      budget = pageBudget;
    }
    current.push(row);
    used += cost;
  }

  pages.push(current);
  return pages;
}

export function paginateSellerReportConfirmed<
  T extends { folio: string | null },
>(rows: readonly T[]): T[][] {
  return paginateSellerReportRows(
    rows,
    SELLER_REPORT_FIRST_PAGE_BUDGET,
    SELLER_REPORT_PAGE_BUDGET,
  );
}

export function paginateSellerReportCanceled<
  T extends { folio: string | null },
>(rows: readonly T[]): T[][] {
  return paginateSellerReportRows(
    rows,
    SELLER_REPORT_PAGE_BUDGET,
    SELLER_REPORT_PAGE_BUDGET,
  );
}

export function SellerSalesReportA4Document({
  report,
}: {
  report: SellerSalesReportResponseDto;
}) {
  const pagePlans = [
    ...paginateSellerReportConfirmed(report.confirmed.rows).map((rows) => ({
      section: 'confirmed' as const,
      rows,
    })),
    ...paginateSellerReportCanceled(report.canceled.rows).map((rows) => ({
      section: 'canceled' as const,
      rows,
    })),
  ];
  const totalPages = pagePlans.length;

  return (
    <Document
      title={`Reporte de ventas — ${report.seller.name}`}
      creationDate={new Date(report.generatedAt)}
      modificationDate={new Date(report.generatedAt)}
    >
      {pagePlans.map((plan, index) => (
        <Page
          key={`${plan.section}-${index}`}
          size={{ width: PAPER_SIZES.A4.width, height: PAPER_SIZES.A4.height }}
          style={[SHARED_STYLES.modern.page, styles.page]}
        >
          <BrandHeader report={report} />

          {plan.section === 'confirmed' && index === 0 ? (
            <>
              <SummaryCard report={report} />
              <Notices />
            </>
          ) : null}

          {plan.section === 'confirmed' ? (
            <ConfirmedTable rows={plan.rows} />
          ) : (
            <CanceledTable rows={plan.rows} />
          )}

          <Text style={styles.footer}>
            {`Página ${index + 1} de ${totalPages}`}
          </Text>
        </Page>
      ))}
    </Document>
  );
}

function BrandHeader({ report }: { report: SellerSalesReportResponseDto }) {
  return (
    <View style={styles.headerRow}>
      <View style={styles.brandRow}>
        <Image src={SELLER_REPORT_LOGO_PATH} style={styles.logo} />
        <View>
          <Text style={SHARED_STYLES.modern.header.companyName}>HoundFe</Text>
          <Text style={SHARED_STYLES.modern.header.companySub}>
            Reporte de ventas
          </Text>
        </View>
      </View>

      <View
        style={[SHARED_STYLES.modern.cardCompact, { alignItems: 'flex-end' }]}
      >
        <Text style={SHARED_STYLES.modern.header.metaTitle}>VENDEDOR</Text>
        <Text style={styles.metaSeller}>{report.seller.name}</Text>
        <Text style={SHARED_STYLES.modern.header.metaDate}>
          {`Del ${formatDateOnly(report.from)} al ${formatDateOnly(report.to)} (fecha final excluida)`}
        </Text>
        <Text style={SHARED_STYLES.modern.header.metaDate}>
          {`Generado ${formatInstant(report.generatedAt)} (CDMX)`}
        </Text>
      </View>
    </View>
  );
}

function SummaryCard({ report }: { report: SellerSalesReportResponseDto }) {
  const summary = report.confirmed.summary;
  return (
    <View style={[SHARED_STYLES.modern.card, { marginBottom: 12 }]}>
      <Text style={[SHARED_STYLES.modern.eyebrow, { textTransform: 'none' }]}>
        Resumen · ventas confirmadas
      </Text>
      <View style={styles.metricsRow}>
        {[
          ['Ventas', String(summary.saleCount)],
          ['Cobrado', formatCurrency(summary.collectedCents)],
          ['Saldo pendiente', formatCurrency(summary.outstandingDebtCents)],
          ['Ticket promedio', formatCurrency(summary.averageTicketCents)],
        ].map(([label, value]) => (
          <Metric key={label} label={label} value={value} />
        ))}
      </View>
      <View style={[SHARED_STYLES.modern.totals.totalCard, { marginTop: 2 }]}>
        <Text style={SHARED_STYLES.modern.totals.totalLabel}>VENTAS NETAS</Text>
        <Text style={SHARED_STYLES.modern.totals.totalValue}>
          {formatCurrency(summary.netSalesCents)}
        </Text>
      </View>
    </View>
  );
}

function Notices() {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={styles.notice}>
        Este reporte se atribuye al vendedor asignado actualmente a cada venta.
        Si una venta cambió de vendedor, se muestra bajo el vendedor actual; el
        historial de reasignaciones no se reconstruye.
      </Text>
      <Text style={styles.notice}>
        Los importes de pagado y saldo reflejan el estado actual de cada venta,
        no flujos por fecha de pago.
      </Text>
      <Text style={styles.notice}>
        Las ventas canceladas se incluyen solo como referencia y no se suman a
        los totales de ventas confirmadas.
      </Text>
    </View>
  );
}

function ConfirmedTable({
  rows,
}: {
  rows: SellerSalesReportConfirmedRowDto[];
}) {
  const { row, cell, colFolio, colDate, colMoney } = styles;
  const status = styles.colStatus;
  return (
    <View>
      <Text style={styles.sectionTitle}>
        Ventas confirmadas · por fecha de confirmación
      </Text>
      <View style={styles.tableHeader}>
        <Text style={[styles.headerCell, colFolio]}>FOLIO</Text>
        <Text style={[styles.headerCell, colDate]}>CONFIRMADA</Text>
        <Text style={[styles.headerCell, colMoney]}>TOTAL</Text>
        <Text style={[styles.headerCell, colMoney]}>PAGADO</Text>
        <Text style={[styles.headerCell, colMoney]}>SALDO</Text>
        <Text style={[styles.headerCell, status]}>ESTADO</Text>
      </View>
      {rows.length === 0 ? (
        <Text style={styles.empty}>Sin ventas confirmadas en el periodo.</Text>
      ) : (
        rows.map((r) => (
          <View key={r.id} style={row} wrap={false}>
            <Text style={[cell, colFolio]}>{formatFolio(r.folio)}</Text>
            <Text style={[cell, colDate]}>{formatInstant(r.confirmedAt)}</Text>
            <Text style={[cell, colMoney]}>{formatCurrency(r.totalCents)}</Text>
            <Text style={[cell, colMoney]}>{formatCurrency(r.paidCents)}</Text>
            <Text style={[cell, colMoney]}>{formatCurrency(r.debtCents)}</Text>
            <Text style={[cell, status]}>{STATUS_LABELS[r.paymentStatus]}</Text>
          </View>
        ))
      )}
    </View>
  );
}

function CanceledTable({ rows }: { rows: SellerSalesReportCanceledRowDto[] }) {
  const { row, cell, colFolio, colDate, colMoney } = styles;
  return (
    <View>
      <Text style={styles.sectionTitle}>
        Ventas canceladas · por fecha de cancelación (informativas)
      </Text>
      <View style={styles.tableHeader}>
        <Text style={[styles.headerCell, colFolio]}>FOLIO</Text>
        <Text style={[styles.headerCell, colDate]}>CONFIRMADA</Text>
        <Text style={[styles.headerCell, colDate]}>CANCELADA</Text>
        <Text style={[styles.headerCell, colMoney]}>TOTAL</Text>
      </View>
      {rows.length === 0 ? (
        <Text style={styles.empty}>Sin ventas canceladas en el periodo.</Text>
      ) : (
        rows.map((r) => (
          <View key={r.id} style={row} wrap={false}>
            <Text style={[cell, colFolio]}>{formatFolio(r.folio)}</Text>
            <Text style={[cell, colDate]}>
              {r.confirmedAt ? formatInstant(r.confirmedAt) : '—'}
            </Text>
            <Text style={[cell, colDate]}>{formatInstant(r.canceledAt)}</Text>
            <Text style={[cell, colMoney]}>{formatCurrency(r.totalCents)}</Text>
          </View>
        ))
      )}
    </View>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <Text style={SHARED_STYLES.modern.eyebrow}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

const palette = SHARED_STYLES.modern.palette;

const styles = StyleSheet.create({
  page: {
    // Built-in family only — deterministic offline render (no font CDN).
    fontFamily: 'Helvetica',
    paddingBottom: 40,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  logo: {
    width: 108,
    height: 40,
    marginRight: 10,
    objectFit: 'contain',
  },
  metaSeller: {
    fontSize: 11,
    fontWeight: 700,
    color: palette.ink,
    marginTop: 3,
    maxWidth: 300,
  },
  metricsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
    marginBottom: 10,
  },
  metricValue: {
    fontSize: 12,
    fontWeight: 700,
    color: palette.ink,
    marginTop: 2,
  },
  notice: {
    fontSize: 7.5,
    color: palette.gray,
    lineHeight: 1.4,
    marginBottom: 2,
  },
  sectionTitle: {
    fontSize: 9,
    fontWeight: 700,
    color: palette.ink,
    marginBottom: 6,
  },
  tableHeader: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
    borderBottomStyle: 'solid',
    paddingBottom: 4,
    marginBottom: 2,
  },
  headerCell: {
    fontSize: 7.5,
    fontWeight: 700,
    color: palette.gray,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderBottomWidth: 1,
    borderBottomColor: palette.surface,
    borderBottomStyle: 'solid',
    paddingVertical: 4,
  },
  cell: {
    fontSize: 7.5,
    color: palette.inkSoft,
  },
  colFolio: {
    flex: 2,
    paddingRight: 6,
  },
  colDate: {
    flex: 2,
    paddingRight: 6,
  },
  colMoney: {
    flex: 1.2,
    textAlign: 'right',
    paddingRight: 6,
  },
  colStatus: {
    flex: 1.1,
    textAlign: 'right',
  },
  empty: {
    fontSize: 9,
    color: palette.gray,
    fontStyle: 'italic',
    marginTop: 6,
  },
  footer: {
    position: 'absolute',
    bottom: 20,
    left: 20,
    right: 20,
    textAlign: 'center',
    fontSize: 8,
    color: palette.grayLight,
  },
});

/** Split a folio into display lines that fit the folio column. */
function formatFolio(folio: string | null): string {
  if (folio === null) return '—';
  const chunks = folio.match(new RegExp(`.{1,${FOLIO_CHARS_PER_LINE}}`, 'g'));
  return (chunks ?? [folio]).join('\n');
}

function formatCurrency(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const [whole, decimals] = (Math.abs(cents) / 100).toFixed(2).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${grouped}.${decimals}`;
}

function formatInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  try {
    return new Intl.DateTimeFormat('es-MX', {
      timeZone: REPORT_TIME_ZONE,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .format(date)
      .replace(/\./g, '')
      .toUpperCase();
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

function formatDateOnly(date: string): string {
  return new Intl.DateTimeFormat('es-MX', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}
