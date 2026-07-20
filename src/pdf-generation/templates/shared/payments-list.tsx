/**
 * PaymentsList — payment methods section of every receipt.
 *
 * Lists each `Payment` the customer used: method, amount, optional
 * reference number, optional timestamp. One row per payment.
 *
 * `reference` is null for cash and most card-present payments;
 * we still print the method and amount (those are the customer-facing
 * facts) and skip the reference line. Per spec: "payments may have
 * reference === null. The component must not crash or render a
 * placeholder string for missing refs."
 *
 * `paidAt` is optional because the data shape (`SaleDetailPaymentDto`)
 * always provides it, but the prop type is `string | undefined` to
 * keep the shared component framework-agnostic — a template that
 * composes payments from a different source (manual refund entry,
 * etc.) shouldn't have to fake a timestamp.
 *
 * Empty list: a sale in flight can have zero payments yet (e.g. a
 * credit sale being typed up). The component renders an italic
 * placeholder so the section's row count stays predictable.
 *
 * Order: the receipts spec doesn't mandate payment order; we render
 * the array as-given (POS code already orders them chronologically
 * via the timeline). Sorting here would risk out-of-order refunds
 * vs. charges.
 */
import { Text, View } from '@react-pdf/renderer';
import { SHARED_STYLES } from './styles';

/**
 * One payment entry. Mirrors `SaleDetailPaymentDto`
 * (`src/sales/dto/sale-detail-response.dto.ts`) minus the
 * `tenderedCents` / `changeCents` columns that are derived from
 * the totals block and would be redundant on the receipt.
 */
export interface Payment {
  /** Method name (e.g. "CASH", "CARD", "TRANSFER"). Free-form string. */
  method: string;
  /** Amount charged by this payment, in cents (≥ 0). */
  amountCents: number;
  /** Optional auth/reference code from the processor. Null for cash. */
  reference?: string | null;
  /** Optional ISO timestamp of when this payment was captured. */
  paidAt?: string | null;
}

export interface PaymentsListProps {
  payments: Payment[];
}

export function PaymentsList({ payments }: PaymentsListProps) {
  if (payments.length === 0) {
    return (
      <View style={SHARED_STYLES.payments.row}>
        <Text style={SHARED_STYLES.payments.emptyRow}>
          Sin pagos registrados.
        </Text>
      </View>
    );
  }

  return (
    <View>
      {payments.map((payment, index) => (
        <View
          // Same key strategy as LineItemsTable: positional index,
          // safe because the data shape doesn't reorder across
          // renders for the same sale.
          key={`${payment.method}-${index}`}
          style={paymentRowStyles.row}
        >
          <View style={paymentRowStyles.leftColumn}>
            <Text style={SHARED_STYLES.payments.method}>
              {formatMethod(payment.method)}
            </Text>
            {payment.reference ? (
              <Text style={SHARED_STYLES.payments.reference}>
                Ref: {payment.reference}
              </Text>
            ) : null}
            {payment.paidAt ? (
              <Text style={SHARED_STYLES.payments.timestamp}>
                {formatTimestamp(payment.paidAt)}
              </Text>
            ) : null}
          </View>
          <Text style={SHARED_STYLES.payments.amount}>
            {formatCurrency(payment.amountCents)}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * Local layout — slightly different from the shared `payments.row`
 * because each row here is a 2-column flex (method+meta on left,
 * amount on right) rather than a simple label-value pair.
 */
const paymentRowStyles = {
  row: {
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
    alignItems: 'flex-start' as const,
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: SHARED_STYLES.divider.borderBottomColor,
    borderBottomStyle: 'solid' as const,
  },
  leftColumn: {
    flexDirection: 'column' as const,
    flexShrink: 1,
    paddingRight: 8,
  },
};

/**
 * Humanize the method code. POS-side values are short tokens
 * (CASH, CARD, TRANSFER, CHECK, CREDIT) — receipts prefer the
 * Spanish long form for the customer's reading flow.
 */
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

/**
 * Render the payment timestamp in the same Spanish receipt format
 * as the header date, minus the year (the receipt's header already
 * shows the day, so just `HH:mm` is enough context for the audit
 * trail).
 */
function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  try {
    return new Intl.DateTimeFormat('es-MX', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString().slice(11, 16);
  }
}

/**
 * Format cents as a fixed-decimal currency string. Same helper
 * as `LineItemsTable`/`TotalsBlock` — kept local rather than
 * shared because moving it would create a presentational
 * utility module that the rest of the codebase doesn't need.
 */
function formatCurrency(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents) / 100;
  return `${sign}$${abs.toFixed(2)}`;
}