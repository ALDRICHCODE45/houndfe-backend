/**
 * CollectionReceiptA4Document — A4 «Comprobante de cobro» of one «Cobrar
 * todo» (customer-collection T3 / S5; contract v1 §7, owner Q5).
 *
 * On the shared A4 kit, styled like the redesigned sale receipt («libro
 * mayor»): header «Comprobante de cobro» / «Folio #COB-…», meta bar Fecha ·
 * Sucursal · Cajero, Cliente, Ventas (ledger: folio, estado, abonado, resta
 * tras el cobro; «Cancelada» in danger when cancelled since — a void), totals
 * (Recibido, Cambio, Deuda del cliente; grand «Total abonado»), Pagos,
 * closing note. One wrapping page: natural pagination, repeated ledger
 * header and compact page header on pages 2+, «Página X de Y» footer.
 *
 * Built-in Helvetica only (kit tokens): no remote font or image.
 */
import { Document, StyleSheet, Text, View } from '@react-pdf/renderer';
import {
  A4_COLORS,
  A4_FONTS,
  A4MetaBar,
  A4Page,
  A4PageHeader,
  A4Section,
  A4TotalsBlock,
  LedgerTable,
  formatA4DateTime,
  formatA4Money,
  px,
  type A4TotalsLine,
  type LedgerColumn,
  type LedgerRowData,
} from '../shared/a4-kit';
import type {
  CollectionReceiptProps,
  CollectionReceiptSaleLine,
  CollectionReceiptTender,
} from './collection-receipt.types';

const BRAND_SUBTITLE = 'Punto de Venta';
const KICKER = 'Comprobante de cobro';

export function CollectionReceiptA4Document(props: CollectionReceiptProps) {
  const { brandName, folio } = props;
  return (
    <Document title={`${KICKER} ${folio}`}>
      <A4Page
        footerLabel={`${KICKER} ${folio}`}
        brandName={brandName}
        continuation={{
          kicker: KICKER,
          folio: `Folio #${folio}`,
          brandSubtitle: BRAND_SUBTITLE,
        }}
      >
        <A4PageHeader
          brandName={brandName}
          subtitle={BRAND_SUBTITLE}
          kicker={KICKER}
          folio={`Folio #${folio}`}
        />
        <A4MetaBar
          items={[
            { label: 'Fecha', value: formatA4DateTime(props.date) },
            { label: 'Sucursal', value: props.branchName },
            { label: 'Cajero', value: props.cashier },
          ]}
        />
        <A4Section title="Cliente">
          <View style={styles.customerRow} wrap={false}>
            <Text style={styles.customerName}>{props.customerName}</Text>
          </View>
        </A4Section>
        <SalesSection sales={props.sales} appliedCents={props.appliedCents} />
        <A4TotalsBlock
          lines={buildTotalsLines(props)}
          total={{
            label: 'Total abonado',
            value: formatA4Money(props.appliedCents),
          }}
        />
        <TendersSection tenders={props.tenders} />
        <View style={styles.closing} wrap={false}>
          <Text style={styles.closingStrong}>Gracias por su pago.</Text>
          <Text style={styles.closingText}>
            Este comprobante no constituye una factura fiscal.
          </Text>
        </View>
      </A4Page>
    </Document>
  );
}

// ── Ventas ───────────────────────────────────────────────────────────

const SALE_COLUMNS: readonly LedgerColumn[] = [
  { key: 'folio', label: 'Venta', flex: 2.4 },
  { key: 'status', label: 'Estado', flex: 1.4 },
  { key: 'applied', label: 'Abonado', flex: 1.4, align: 'right' },
  { key: 'debt', label: 'Resta tras el cobro', flex: 1.8, align: 'right' },
];

function saleStatus(sale: CollectionReceiptSaleLine) {
  if (sale.canceled) return { text: 'Cancelada', tone: 'danger' as const };
  return sale.debtAfterCents === 0 ? 'Pagada' : 'Parcial';
}

function SalesSection({
  sales,
  appliedCents,
}: {
  sales: readonly CollectionReceiptSaleLine[];
  appliedCents: number;
}) {
  const rows: LedgerRowData[] = sales.map((sale, index) => ({
    key: `${sale.folio}-${index}`,
    cells: {
      folio: sale.folio,
      status: saleStatus(sale),
      applied: { text: formatA4Money(sale.appliedCents), bold: true },
      debt: formatA4Money(sale.debtAfterCents),
    },
  }));
  return (
    <A4Section title="Ventas" aside={`${sales.length} abonadas`}>
      <LedgerTable
        columns={SALE_COLUMNS}
        rows={rows}
        emptyText="---"
        total={{
          key: 'total',
          cells: {
            folio: 'Total abonado',
            applied: formatA4Money(appliedCents),
          },
        }}
      />
    </A4Section>
  );
}

// ── Totals ───────────────────────────────────────────────────────────

function buildTotalsLines(props: CollectionReceiptProps): A4TotalsLine[] {
  const lines: A4TotalsLine[] = [
    { label: 'Recibido', value: formatA4Money(props.tenderedCents) },
  ];
  if (props.changeDueCents > 0) {
    lines.push({ label: 'Cambio', value: formatA4Money(props.changeDueCents) });
  }
  const debt = props.remainingCustomerDebtCents;
  lines.push(
    debt === null
      ? { label: 'Deuda del cliente', value: 'No disponible', tone: 'muted' }
      : {
          label: 'Deuda del cliente',
          value: formatA4Money(debt),
          tone: debt > 0 ? 'warning' : 'success',
        },
  );
  return lines;
}

// ── Pagos ────────────────────────────────────────────────────────────

function TendersSection({
  tenders,
}: {
  tenders: readonly CollectionReceiptTender[];
}) {
  return (
    <A4Section title="Pagos">
      {tenders.map((tender, index) => (
        <View
          key={`${tender.label}-${index}`}
          style={styles.paymentRow}
          wrap={false}
        >
          <View style={styles.paymentLeft}>
            <Text style={styles.paymentMethod}>{tender.label}</Text>
            {tender.subtitle ? (
              <Text style={styles.paymentSmall}>{tender.subtitle}</Text>
            ) : null}
          </View>
          <Text style={styles.paymentAmount}>
            {formatA4Money(tender.amountCents)}
          </Text>
        </View>
      ))}
    </A4Section>
  );
}

// ── Local styles (same as the sale receipt A4) ───────────────────────

const HAIRLINE = px(1);

const styles = StyleSheet.create({
  customerRow: {
    paddingVertical: px(6),
    borderBottomWidth: HAIRLINE,
    borderBottomColor: A4_COLORS.border,
    borderBottomStyle: 'solid',
  },
  customerName: {
    fontFamily: A4_FONTS.bold,
    fontSize: px(14),
    color: A4_COLORS.ink,
  },
  paymentRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: px(7),
    borderBottomWidth: HAIRLINE,
    borderBottomColor: A4_COLORS.border,
    borderBottomStyle: 'solid',
  },
  paymentLeft: { flexGrow: 1, flexShrink: 1, paddingRight: px(8) },
  paymentMethod: {
    fontFamily: A4_FONTS.bold,
    fontSize: px(12.5),
    color: A4_COLORS.ink,
  },
  paymentSmall: { fontSize: px(10), color: A4_COLORS.muted },
  paymentAmount: {
    fontFamily: A4_FONTS.bold,
    fontSize: px(12.5),
    color: A4_COLORS.ink,
    textAlign: 'right',
  },
  closing: { marginTop: px(28), alignItems: 'center' },
  closingStrong: {
    fontFamily: A4_FONTS.bold,
    fontSize: px(12.5),
    color: A4_COLORS.ink,
    marginBottom: px(2),
  },
  closingText: { fontSize: px(11), color: A4_COLORS.muted },
});
