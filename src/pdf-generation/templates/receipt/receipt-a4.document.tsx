/**
 * ReceiptA4Document — A4 PDF template for the `receipt-a4` format key.
 *
 * pdf-a4-redesign T3 (S2): the sale receipt on the shared A4 kit («libro
 * mayor» artboard, "Recibo de venta A4"). Ledger / minimal: no cards, no
 * fills — structure comes from rules and strict column alignment.
 *
 *   - ONE wrapping `<Page>` (`A4Page`): natural pagination, fixed footer
 *     «Página X de Y» from react-pdf's `render` prop, compact header
 *     repeated on pages 2+.
 *   - Header: brand (the packaged wordmark from the kit; `business.logoUrl`
 *     is the ticket/email logo and is NOT fetched here) + «Recibo» / «Folio #…». Meta bar: Fecha ·
 *     Cajero · Vendedor.
 *   - Cliente («Público en General» fallback), Productos (ledger table with
 *     variant sub-line; a per-line promotion prints as a promo row under the
 *     item with the line at GROSS so Σ lines = Subtotal), totals block,
 *     Pagos, closing note.
 *
 * Palette (L5): discounts print «-$X» in ink (never red); «Deuda» is warning
 * when > 0 and success when zero; danger is reserved for voids/errors and
 * this template has no canceled state, so it never appears here.
 *
 * The grand total already includes IVA in this system, so there is no IVA
 * row (mirrors the quotation contract).
 *
 * Built-in Helvetica only (kit tokens): no remote font registration.
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
  formatA4Time,
  px,
  type A4TotalsLine,
  type LedgerColumn,
  type LedgerRowData,
} from '../shared/a4-kit';
import { PUBLIC_CUSTOMER_PLACEHOLDER } from '../shared';
import type { Payment, TotalsBlockProps } from '../shared';
import type { ReceiptDocumentProps, ReceiptLineItem } from './receipt.types';

const BRAND_SUBTITLE = 'Punto de Venta';

export function ReceiptA4Document({
  business,
  sale,
  customer,
  items,
  totals,
  payments,
}: ReceiptDocumentProps) {
  return (
    <Document title={`Recibo ${sale.folio}`}>
      <A4Page
        footerLabel={`Recibo ${sale.folio}`}
        brandName={business.companyName}
        continuation={{
          kicker: 'Recibo',
          folio: `Folio #${sale.folio}`,
          brandSubtitle: BRAND_SUBTITLE,
        }}
      >
        <A4PageHeader
          brandName={business.companyName}
          subtitle={BRAND_SUBTITLE}
          kicker="Recibo"
          folio={`Folio #${sale.folio}`}
        />
        <A4MetaBar
          items={[
            { label: 'Fecha', value: formatA4DateTime(sale.date) },
            { label: 'Cajero', value: sale.cashier },
            { label: 'Vendedor', value: sale.seller },
          ]}
        />
        <CustomerSection customerName={customer.name} />
        <ItemsSection items={items} />
        <A4TotalsBlock
          lines={buildTotalsLines(totals)}
          total={{ label: 'Total', value: formatA4Money(totals.totalCents) }}
        />
        <PaymentsSection payments={payments} />
        <View style={styles.closing} wrap={false}>
          <Text style={styles.closingStrong}>Gracias por su compra.</Text>
          <Text style={styles.closingText}>
            Este comprobante no constituye una factura fiscal.
          </Text>
        </View>
      </A4Page>
    </Document>
  );
}

// ── Cliente ──────────────────────────────────────────────────────────

function CustomerSection({
  customerName,
}: {
  customerName: string | null | undefined;
}) {
  const display =
    customerName && customerName.trim().length > 0
      ? customerName
      : PUBLIC_CUSTOMER_PLACEHOLDER;
  return (
    <A4Section title="Cliente">
      <View style={styles.customerRow} wrap={false}>
        <Text style={styles.customerName}>{display}</Text>
      </View>
    </A4Section>
  );
}

// ── Productos ────────────────────────────────────────────────────────

const ITEM_COLUMNS: readonly LedgerColumn[] = [
  { key: 'description', label: 'Descripción', flex: 3.4 },
  { key: 'qty', label: 'Cantidad × precio', flex: 1.6, align: 'right' },
  { key: 'amount', label: 'Importe', flex: 1.3, align: 'right' },
];

/**
 * ARITHMETIC. The visible amounts must add up to the sale «Subtotal» (gross):
 *   - no discount: `qty × unit = amount` (amount = NET line subtotal);
 *   - with a discount: the row prints `qty × BASE unit = gross amount` and a
 *     promo row prints the line's TOTAL discount = gross − net subtotal. That
 *     covers per-unit discounts (unitPrice already net, base = pre-price) and
 *     BUY_X_GET_Y (unitPrice full, reward in discountAmountCents) with one
 *     rule. An order-level promotion is not per line: it only reaches
 *     «Descuentos».
 */
function ItemsSection({ items }: { items: readonly ReceiptLineItem[] }) {
  const rows: LedgerRowData[] = items.map((item, index) => {
    const baseCents = item.baseUnitPriceCents ?? item.unitPriceCents;
    const grossCents = Math.round(baseCents * item.quantity);
    const lineDiscountCents = item.discountAmountCents
      ? Math.max(0, grossCents - item.subtotalCents)
      : 0;
    const hasDiscount = lineDiscountCents > 0;
    return {
      key: `${item.productName}-${index}`,
      cells: {
        description: item.variantName
          ? { text: item.productName, sub: item.variantName }
          : item.productName,
        qty: `${formatQuantity(item.quantity)} × ${formatA4Money(
          hasDiscount ? baseCents : item.unitPriceCents,
        )}`,
        amount: {
          text: formatA4Money(hasDiscount ? grossCents : item.subtotalCents),
          bold: true,
        },
      },
      ...(hasDiscount
        ? {
            promo: {
              label: item.discountTitle?.trim() || 'Descuento',
              amount: formatA4Money(-lineDiscountCents),
            },
          }
        : {}),
    };
  });
  return (
    <A4Section title="Productos">
      <LedgerTable columns={ITEM_COLUMNS} rows={rows} emptyText="---" />
    </A4Section>
  );
}

// ── Totals ───────────────────────────────────────────────────────────

/**
 * Settlement rows only when the value matters (same rules as before): a
 * credit sale prints Deuda, a cash overpay prints Cambio, Envío only when
 * charged. Descuentos always prints («-$X» in ink when > 0).
 */
function buildTotalsLines(totals: TotalsBlockProps): A4TotalsLine[] {
  const lines: A4TotalsLine[] = [
    { label: 'Subtotal', value: formatA4Money(totals.subtotalCents) },
    {
      label: 'Descuentos',
      value:
        totals.discountCents > 0
          ? `-${formatA4Money(totals.discountCents)}`
          : formatA4Money(totals.discountCents),
      tone: 'ink',
    },
  ];
  if (totals.shippingChargeCents && totals.shippingChargeCents > 0) {
    lines.push({
      label: 'Envío',
      value: formatA4Money(totals.shippingChargeCents),
    });
  }
  if (totals.paidCents > 0) {
    lines.push({ label: 'Pagado', value: formatA4Money(totals.paidCents) });
  }
  if (totals.debtCents > 0) {
    lines.push({
      label: 'Deuda',
      value: formatA4Money(totals.debtCents),
      tone: 'warning',
    });
  }
  if (totals.changeDueCents > 0) {
    lines.push({
      label: 'Cambio',
      value: formatA4Money(totals.changeDueCents),
    });
  }
  return lines;
}

// ── Pagos ────────────────────────────────────────────────────────────

function PaymentsSection({ payments }: { payments: readonly Payment[] }) {
  return (
    <A4Section title="Pagos">
      {payments.length === 0 ? (
        <Text style={styles.paymentsEmpty}>Sin pagos registrados.</Text>
      ) : (
        payments.map((payment, index) => (
          <View
            key={`${payment.method}-${index}`}
            style={styles.paymentRow}
            wrap={false}
          >
            <View style={styles.paymentLeft}>
              <Text style={styles.paymentMethod}>
                {payment.paymentMethodName
                  ? payment.paymentMethodName
                  : formatMethod(payment.method)}
              </Text>
              {payment.paymentMethodSubtitle ? (
                <Text style={styles.paymentSmall}>
                  {payment.paymentMethodSubtitle}
                </Text>
              ) : payment.reference ? (
                <Text style={styles.paymentSmall}>
                  Ref: {payment.reference}
                </Text>
              ) : null}
              {payment.paidAt ? (
                <Text style={styles.paymentSmall}>
                  {formatA4Time(payment.paidAt)}
                </Text>
              ) : null}
            </View>
            <Text style={styles.paymentAmount}>
              {formatA4Money(payment.amountCents)}
            </Text>
          </View>
        ))
      )}
    </A4Section>
  );
}

// ── Formatting ───────────────────────────────────────────────────────

function formatQuantity(qty: number): string {
  if (Number.isInteger(qty)) {
    return qty.toString();
  }
  // Trim trailing zeros for fractional quantities (e.g. 1.50 -> "1.5").
  return qty.toFixed(2).replace(/\.?0+$/, '');
}

/** Humanize the POS method code; unknown codes print as-is. */
function formatMethod(method: string): string {
  const map: Record<string, string> = {
    CASH: 'Efectivo',
    CARD: 'Tarjeta',
    TRANSFER: 'Transferencia',
    CHECK: 'Cheque',
    CREDIT: 'Crédito',
  };
  return map[method.toUpperCase()] ?? method;
}

// ── Local styles (artboard .r / .pay / .closing) ─────────────────────

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
  paymentsEmpty: {
    fontSize: px(11.5),
    color: A4_COLORS.muted,
    paddingVertical: px(6),
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
