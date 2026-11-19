/**
 * SellerSalesReportA4Document — A4 PDF for the seller sales report
 * (`GET /analytics/sales/sellers/:sellerUserId/report/pdf`), on the shared A4
 * kit («libro mayor» artboard, pdf-a4-redesign T5).
 *
 * Built-in Helvetica (deterministic, no font CDN). Natural pagination: each
 * section is ONE wrapping `<A4Page>`; rows are never split, the ledger header
 * repeats on every continuation page, pages 2+ repeat a compact header and the
 * footer is fixed with the real `Página X de Y` (react-pdf `render` prop).
 *
 * Palette (L5): Saldo in warning when > 0 and success when zero, ink for
 * everything else; danger only marks the cancellation date of a canceled sale.
 * The seller is always printed by name.
 */
import { Document, StyleSheet, Text, View } from '@react-pdf/renderer';
import { resolve } from 'node:path';
import {
  A4Page,
  A4PageHeader,
  A4Section,
  A4_COLORS,
  A4_FONTS,
  A4_STYLES,
  LedgerTable,
  formatA4Date,
  formatA4DateTime,
  px,
  toneColor,
  type A4Tone,
  type LedgerColumn,
  type LedgerRowData,
} from '../shared/a4-kit';
import type {
  SellerSalesReportCanceledRowDto,
  SellerSalesReportConfirmedRowDto,
  SellerSalesReportResponseDto,
} from '../../../analytics/dto/seller-sales-report-response.dto';

/**
 * Packaged local wordmark — `nest-cli.json` copies `pdf-generation/assets/**`
 * to the same `dist` path, so this resolves in `src` (tests) and in `dist`.
 */
export const SELLER_REPORT_LOGO_PATH = resolve(
  __dirname,
  '..',
  '..',
  'assets',
  'houndfe-logo-report.png',
);
/** The wordmark is 512×191 px: 36 px tall → ≈96.5 px wide (pt via `px`). */
export const SELLER_REPORT_LOGO_WIDTH = px(36 * (512 / 191));
const BRAND_SUBTITLE = 'Reporte de ventas';
const KICKER = 'Vendedor';
const FOLIO_CHARS_PER_LINE = 20;

const STATUS_LABELS: Record<string, string> = {
  PAID: 'Pagada',
  PARTIAL: 'Parcial',
  CREDIT: 'A crédito',
};

const CONFIRMED_COLUMNS: readonly LedgerColumn[] = [
  { key: 'folio', label: 'Folio', flex: 1.7 },
  { key: 'confirmedAt', label: 'Confirmada', flex: 1.8 },
  { key: 'total', label: 'Total', flex: 1.1, align: 'right' },
  { key: 'paid', label: 'Pagado', flex: 1.1, align: 'right' },
  { key: 'debt', label: 'Saldo', flex: 1.1, align: 'right' },
  { key: 'status', label: 'Estado', flex: 1, align: 'right' },
];

const CANCELED_COLUMNS: readonly LedgerColumn[] = [
  { key: 'folio', label: 'Folio', flex: 1.7 },
  { key: 'confirmedAt', label: 'Confirmada', flex: 1.8 },
  { key: 'canceledAt', label: 'Cancelada', flex: 1.8 },
  { key: 'total', label: 'Total', flex: 1.1, align: 'right' },
];

/** Saldo colour rule: warning while owed, success when settled. */
export function debtTone(debtCents: number): A4Tone {
  return debtCents > 0 ? 'warning' : 'success';
}

export function SellerSalesReportA4Document({
  report,
}: {
  report: SellerSalesReportResponseDto;
}) {
  const footerLabel = `${BRAND_SUBTITLE} · ${report.seller.name}`;
  const continuation = {
    kicker: KICKER,
    folio: report.seller.name,
    brandSubtitle: BRAND_SUBTITLE,
  };

  return (
    <Document
      title={`Reporte de ventas — ${report.seller.name}`}
      creationDate={new Date(report.generatedAt)}
      modificationDate={new Date(report.generatedAt)}
    >
      <A4Page
        footerLabel={footerLabel}
        continuation={continuation}
        logoUrl={SELLER_REPORT_LOGO_PATH}
        logoWidth={SELLER_REPORT_LOGO_WIDTH}
      >
        <A4PageHeader
          logoUrl={SELLER_REPORT_LOGO_PATH}
          logoWidth={SELLER_REPORT_LOGO_WIDTH}
          subtitle={BRAND_SUBTITLE}
          kicker={KICKER}
          folio={report.seller.name}
        />
        <PeriodBar report={report} />
        <SummarySection report={report} />
        <A4Section title="Ventas confirmadas" aside="por fecha de confirmación">
          <LedgerTable
            columns={CONFIRMED_COLUMNS}
            rows={report.confirmed.rows.map(confirmedRow)}
            emptyText="Sin ventas confirmadas en el periodo."
          />
        </A4Section>
      </A4Page>
      <A4Page
        footerLabel={footerLabel}
        continuation={continuation}
        logoUrl={SELLER_REPORT_LOGO_PATH}
        logoWidth={SELLER_REPORT_LOGO_WIDTH}
      >
        <A4Section
          title="Ventas canceladas"
          aside="por fecha de cancelación (informativas)"
        >
          <LedgerTable
            columns={CANCELED_COLUMNS}
            rows={report.canceled.rows.map(canceledRow)}
            emptyText="Sin ventas canceladas en el periodo."
          />
        </A4Section>
      </A4Page>
    </Document>
  );
}

function confirmedRow(r: SellerSalesReportConfirmedRowDto): LedgerRowData {
  return {
    key: r.id,
    cells: {
      folio: formatFolio(r.folio),
      confirmedAt: formatA4DateTime(r.confirmedAt),
      total: formatCurrency(r.totalCents),
      paid: formatCurrency(r.paidCents),
      debt: {
        text: formatCurrency(r.debtCents),
        tone: debtTone(r.debtCents),
        bold: r.debtCents > 0,
      },
      status: {
        text: STATUS_LABELS[r.paymentStatus],
        bold: r.paymentStatus !== 'PAID',
      },
    },
  };
}

function canceledRow(r: SellerSalesReportCanceledRowDto): LedgerRowData {
  return {
    key: r.id,
    cells: {
      folio: formatFolio(r.folio),
      confirmedAt: r.confirmedAt ? formatA4DateTime(r.confirmedAt) : '—',
      canceledAt: { text: formatA4DateTime(r.canceledAt), tone: 'danger' },
      total: formatCurrency(r.totalCents),
    },
  };
}

/** Period + generation strip (artboard `.sub`), values in bold ink. */
function PeriodBar({ report }: { report: SellerSalesReportResponseDto }) {
  return (
    <View style={A4_STYLES.metaBar}>
      <Text style={A4_STYLES.metaBarText}>
        {'Del '}
        <Text style={A4_STYLES.metaBarValue}>
          {formatA4Date(`${report.from}T00:00:00Z`, 'UTC')}
        </Text>
        {' al '}
        <Text style={A4_STYLES.metaBarValue}>
          {formatA4Date(`${report.to}T00:00:00Z`, 'UTC')}
        </Text>
        {' (fecha final excluida)'}
      </Text>
      <Text style={A4_STYLES.metaBarText}>
        {'Generado '}
        <Text style={A4_STYLES.metaBarValue}>
          {formatA4DateTime(report.generatedAt)}
        </Text>
        {' (CDMX)'}
      </Text>
    </View>
  );
}

function SummarySection({ report }: { report: SellerSalesReportResponseDto }) {
  const summary = report.confirmed.summary;
  const kpis: { label: string; value: string; tone: A4Tone }[] = [
    { label: 'Ventas', value: String(summary.saleCount), tone: 'ink' },
    {
      label: 'Cobrado',
      value: formatCurrency(summary.collectedCents),
      tone: 'ink',
    },
    {
      label: 'Saldo pendiente',
      value: formatCurrency(summary.outstandingDebtCents),
      tone: debtTone(summary.outstandingDebtCents),
    },
    {
      label: 'Ticket promedio',
      value: formatCurrency(summary.averageTicketCents),
      tone: 'ink',
    },
  ];

  return (
    <A4Section title="Resumen · ventas confirmadas">
      <View style={styles.kpis}>
        {kpis.map((kpi, index) => (
          <View
            key={kpi.label}
            style={index === kpis.length - 1 ? styles.kpiLast : styles.kpi}
          >
            <Text style={styles.kpiLabel}>{kpi.label}</Text>
            <Text style={[styles.kpiValue, { color: toneColor(kpi.tone) }]}>
              {kpi.value}
            </Text>
          </View>
        ))}
      </View>
      <View style={styles.grand} wrap={false}>
        <Text style={A4_STYLES.totalsGrandLabel}>Ventas netas</Text>
        <Text style={A4_STYLES.totalsGrandValue}>
          {formatCurrency(summary.netSalesCents)}
        </Text>
      </View>
      <Text style={styles.hint}>
        Este reporte se atribuye al vendedor asignado actualmente a cada venta.
        Si una venta cambió de vendedor, se muestra bajo el vendedor actual; el
        historial de reasignaciones no se reconstruye.
      </Text>
      <Text style={styles.hint}>
        Los importes de pagado y saldo reflejan el estado actual de cada venta,
        no flujos por fecha de pago.
      </Text>
      <Text style={styles.hint}>
        Las ventas canceladas se incluyen solo como referencia y no se suman a
        los totales de ventas confirmadas.
      </Text>
    </A4Section>
  );
}

const styles = StyleSheet.create({
  kpis: {
    flexDirection: 'row',
    borderBottomWidth: px(1),
    borderBottomColor: A4_COLORS.border,
    borderBottomStyle: 'solid',
  },
  kpi: {
    flex: 1,
    paddingTop: px(8),
    paddingBottom: px(9),
    paddingLeft: px(14),
    borderRightWidth: px(1),
    borderRightColor: A4_COLORS.border,
    borderRightStyle: 'solid',
  },
  kpiLast: {
    flex: 1,
    paddingTop: px(8),
    paddingBottom: px(9),
    paddingLeft: px(14),
  },
  kpiLabel: {
    fontFamily: A4_FONTS.bold,
    fontSize: px(10),
    letterSpacing: px(10) * 0.06,
    textTransform: 'uppercase',
    color: A4_COLORS.muted,
  },
  kpiValue: {
    fontFamily: A4_FONTS.bold,
    fontSize: px(16),
    marginTop: px(2),
  },
  /** Full-width «Ventas netas» strip (artboard `.grand`, no top rule). */
  grand: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingVertical: px(9),
    borderBottomWidth: px(2),
    borderBottomColor: A4_COLORS.accent,
    borderBottomStyle: 'solid',
  },
  hint: {
    fontSize: px(10.5),
    lineHeight: 1.4,
    color: A4_COLORS.muted,
    marginTop: px(5),
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
