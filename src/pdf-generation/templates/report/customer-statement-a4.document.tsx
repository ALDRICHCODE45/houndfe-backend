/**
 * CustomerStatementA4Document — A4 «Estado de cuenta» of a customer
 * (`GET /customers/:customerId/statement/pdf`, sales-history-redesign S11),
 * on the shared A4 kit with the seller report as the reference style.
 *
 * Built-in Helvetica (no font CDN). Natural pagination: each section group is
 * ONE wrapping `<A4Page>` (sales on the first, payments on the second, so a
 * table's fixed header only repeats on its own pages); rows never split, the
 * ledger header repeats on every continuation page, pages 2+ repeat a compact
 * header and the fixed footer prints the real `Página X de Y` through the
 * react-pdf `render` prop (no static page count anywhere).
 *
 * Palette (seller report L5): Saldo warning when > 0 and success when zero;
 * danger only marks overdue due days, the overdue amount and canceled sales.
 */
import { Document, StyleSheet, Text, View } from '@react-pdf/renderer';
import {
  A4KeyValueColumns,
  A4Page,
  A4PageHeader,
  A4Section,
  A4_COLORS,
  A4_FONTS,
  A4_STYLES,
  LedgerTable,
  formatA4Date,
  formatA4DateTime,
  formatA4Money,
  formatA4Time,
  px,
  toneColor,
  type A4Tone,
  type LedgerColumn,
  type LedgerRowData,
} from '../shared/a4-kit';
import type {
  CustomerStatementDto,
  CustomerStatementPaymentDto,
  CustomerStatementSaleDto,
} from '../../../sales/dto/customer-statement.dto';

const BRAND_SUBTITLE = 'Estado de cuenta';
const KICKER = 'Cliente';
const FOLIO_CHARS_PER_LINE = 20;
const MISSING = '—';

const SALE_COLUMNS: readonly LedgerColumn[] = [
  { key: 'folio', label: 'Folio', flex: 1.5 },
  { key: 'date', label: 'Fecha', flex: 1.3 },
  { key: 'total', label: 'Total', flex: 1.1, align: 'right' },
  { key: 'paid', label: 'Pagado', flex: 1.1, align: 'right' },
  { key: 'debt', label: 'Saldo', flex: 1.1, align: 'right' },
  { key: 'dueDate', label: 'Vence', flex: 1.3, align: 'right' },
  { key: 'status', label: 'Estado', flex: 0.9, align: 'right' },
];

const PAYMENT_COLUMNS: readonly LedgerColumn[] = [
  { key: 'date', label: 'Fecha', flex: 1.3 },
  { key: 'sale', label: 'Venta', flex: 1.6 },
  { key: 'method', label: 'Método', flex: 2.2 },
  { key: 'amount', label: 'Importe', flex: 1.4, align: 'right' },
];

/** A local `YYYY-MM-DD` day printed as `10 nov 2026` (no zone shift). */
const formatDay = (day: string): string =>
  formatA4Date(`${day}T00:00:00Z`, 'UTC');

const debtTone = (cents: number): A4Tone => (cents > 0 ? 'warning' : 'success');

export function CustomerStatementA4Document({
  statement,
}: {
  statement: CustomerStatementDto;
}) {
  const name = statement.customer.name;
  const footerLabel = `${BRAND_SUBTITLE} · ${name}`;
  const continuation = {
    kicker: KICKER,
    folio: name,
    brandSubtitle: BRAND_SUBTITLE,
  };
  const totals = statement.periodTotals;
  const saleCountLabel = `${totals.saleCount} ${totals.saleCount === 1 ? 'venta' : 'ventas'}`;

  return (
    <Document
      title={`Estado de cuenta — ${name}`}
      creationDate={new Date(statement.generatedAt)}
      modificationDate={new Date(statement.generatedAt)}
    >
      <A4Page footerLabel={footerLabel} continuation={continuation}>
        <A4PageHeader subtitle={BRAND_SUBTITLE} kicker={KICKER} folio={name} />
        <MetaBar statement={statement} />
        <A4Section title="Cliente">
          <A4KeyValueColumns
            columns={[
              [
                { label: 'Nombre', value: name },
                {
                  label: 'Teléfono',
                  value: statement.customer.phone ?? MISSING,
                },
                { label: 'Correo', value: statement.customer.email ?? MISSING },
              ],
              [
                { label: 'RFC', value: statement.customer.rfc ?? MISSING },
                {
                  label: 'Razón social',
                  value: statement.customer.businessName ?? MISSING,
                },
              ],
            ]}
          />
        </A4Section>
        <DebtSection statement={statement} />
        <A4Section
          title="Ventas del periodo"
          aside="confirmadas, por fecha de confirmación"
          hint={`Vencida: con saldo y fecha de vencimiento anterior a hoy (${formatDay(statement.today)}).`}
        >
          <LedgerTable
            columns={SALE_COLUMNS}
            rows={statement.sales.map(saleRow)}
            emptyText="Sin ventas confirmadas en el periodo."
            total={
              statement.sales.length === 0
                ? undefined
                : {
                    key: 'total',
                    cells: {
                      folio: saleCountLabel,
                      total: formatA4Money(totals.totalCents),
                      paid: formatA4Money(totals.paidCents),
                      debt: {
                        text: formatA4Money(totals.openDebtCents),
                        tone: debtTone(totals.openDebtCents),
                      },
                      dueDate:
                        totals.overdueDebtCents > 0
                          ? {
                              text: formatA4Money(totals.overdueDebtCents),
                              sub: 'vencido',
                              tone: 'danger',
                            }
                          : '',
                    },
                  }
            }
          />
        </A4Section>
        <Text style={styles.hint}>
          Pagado y saldo reflejan el estado actual de cada venta al generar este
          documento.
        </Text>
      </A4Page>
      <A4Page footerLabel={footerLabel} continuation={continuation}>
        <A4Section
          title="Pagos recibidos en el periodo"
          aside="por fecha de pago"
          hint="Solo pagos recibidos. No incluye devoluciones a pagar ni devoluciones entregadas de ventas canceladas."
        >
          <LedgerTable
            columns={PAYMENT_COLUMNS}
            rows={statement.payments.map((payment) =>
              paymentRow(payment, statement.timeZone),
            )}
            emptyText="Sin pagos recibidos en el periodo."
            total={
              statement.payments.length === 0
                ? undefined
                : {
                    key: 'total',
                    cells: {
                      date: 'Total',
                      amount: formatA4Money(statement.paymentsTotalCents),
                    },
                  }
            }
          />
        </A4Section>
        <Text style={styles.hint}>
          Los pagos de ventas canceladas después se listan marcados. En efectivo
          se muestra el importe neto del cambio entregado.
        </Text>
      </A4Page>
    </Document>
  );
}

function saleRow(sale: CustomerStatementSaleDto): LedgerRowData {
  return {
    key: sale.id,
    cells: {
      folio: formatFolio(sale.folio),
      date: formatDay(sale.localDate),
      total: formatA4Money(sale.totalCents),
      paid: formatA4Money(sale.paidCents),
      debt: {
        text: formatA4Money(sale.openDebtCents),
        tone: debtTone(sale.openDebtCents),
        bold: sale.openDebtCents > 0,
      },
      dueDate:
        sale.dueDate === null
          ? MISSING
          : sale.overdue
            ? {
                text: formatDay(sale.dueDate),
                sub: 'Vencida',
                tone: 'danger',
                bold: true,
              }
            : { text: formatDay(sale.dueDate) },
      status: {
        text: sale.paymentStatusLabel,
        bold: sale.paymentStatus !== 'PAID',
      },
    },
  };
}

function paymentRow(
  payment: CustomerStatementPaymentDto,
  timeZone: string,
): LedgerRowData {
  return {
    key: payment.id,
    cells: {
      date: {
        text: formatDay(payment.localDate),
        sub: formatA4Time(payment.paidAt, timeZone),
      },
      sale: payment.saleCanceled
        ? {
            text: formatFolio(payment.saleFolio),
            sub: 'Venta cancelada',
            tone: 'danger',
          }
        : formatFolio(payment.saleFolio),
      method: payment.methodLabel,
      amount:
        payment.changeCents > 0
          ? {
              text: formatA4Money(payment.amountCents),
              sub: `Recibido ${formatA4Money(payment.tenderedCents)} · cambio ${formatA4Money(payment.changeCents)}`,
            }
          : formatA4Money(payment.amountCents),
    },
  };
}

/** Period, generation time and branch strip (artboard `.sub`). */
function MetaBar({ statement }: { statement: CustomerStatementDto }) {
  return (
    <View style={A4_STYLES.metaBar}>
      <Text style={A4_STYLES.metaBarText}>
        {'Del '}
        <Text style={A4_STYLES.metaBarValue}>{formatDay(statement.from)}</Text>
        {' al '}
        <Text style={A4_STYLES.metaBarValue}>{formatDay(statement.to)}</Text>
        {' (fecha final excluida)'}
      </Text>
      <Text style={A4_STYLES.metaBarText}>
        {'Generado '}
        <Text style={A4_STYLES.metaBarValue}>
          {formatA4DateTime(statement.generatedAt, statement.timeZone)}
        </Text>
        {' · '}
        <Text style={A4_STYLES.metaBarValue}>{statement.branchName}</Text>
      </Text>
    </View>
  );
}

/** Current open debt over ALL the customer's confirmed sales. */
function DebtSection({ statement }: { statement: CustomerStatementDto }) {
  const debt = statement.currentDebt;
  const kpis: { label: string; value: string; tone: A4Tone }[] = [
    {
      label: 'Deuda abierta',
      value: formatA4Money(debt.openDebtCents),
      tone: debtTone(debt.openDebtCents),
    },
    {
      label: 'Vencido',
      value: formatA4Money(debt.overdueDebtCents),
      tone: debt.overdueDebtCents > 0 ? 'danger' : 'success',
    },
    { label: 'Ventas con saldo', value: String(debt.saleCount), tone: 'ink' },
    {
      label: 'Ventas vencidas',
      value: String(debt.overdueSaleCount),
      tone: 'ink',
    },
  ];

  return (
    <A4Section
      title="Deuda abierta actual"
      aside="todas las ventas, también anteriores al periodo"
    >
      {debt.openDebtCents === 0 ? (
        <Text style={A4_STYLES.ledgerEmpty}>Sin deuda abierta.</Text>
      ) : (
        <View style={styles.kpis} wrap={false}>
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
      )}
    </A4Section>
  );
}

/** Split a folio into display lines that fit the folio column. */
function formatFolio(folio: string | null): string {
  if (folio === null) return MISSING;
  const chunks = folio.match(new RegExp(`.{1,${FOLIO_CHARS_PER_LINE}}`, 'g'));
  return (chunks ?? [folio]).join('\n');
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
  hint: {
    fontSize: px(10.5),
    lineHeight: 1.4,
    color: A4_COLORS.muted,
    marginTop: px(5),
  },
});
