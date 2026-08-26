/**
 * PaymentsList — payment methods section of every receipt (modern).
 *
 * Lists each `Payment` the customer used: method, amount, optional
 * reference number, optional timestamp. One clean row per payment:
 *   - Left: method (bold) with the reference + timestamp below it in gray.
 *   - Right: the amount (bold).
 * No divider lines — rows are separated by vertical rhythm only.
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
 *
 * Variants:
 *   - `a4` — full-size tokens (method 10.5pt 600, amount 11pt 700).
 *   - `ticket` — compact twin (method 8pt, amount 8.5pt) for the
 *     80mm thermal width.
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
  // Custom Payment Methods (custom-payment-methods / WU2 — D10):
  // optional branded identity from the persisted
  // `SalePayment.metadataJson.catalog` snapshot. When present, the
  // template prefers this over the base-category label map
  // (`formatMethod`). Legacy rows carry null and the fallback label
  // renders.
  paymentMethodName?: string | null;
  paymentMethodSubtitle?: string | null;
}

export interface PaymentsListProps {
  payments: Payment[];
  /** Layout variant: A4 (full-size) or ticket (compact). */
  variant?: 'a4' | 'ticket';
}

export function PaymentsList({ payments, variant = 'a4' }: PaymentsListProps) {
  const isTicket = variant === 'ticket';
  const tokens = isTicket
    ? SHARED_STYLES.modern.ticket.payments
    : SHARED_STYLES.modern.payments;
  const eyebrow = isTicket
    ? SHARED_STYLES.modern.ticket.eyebrow
    : SHARED_STYLES.modern.eyebrow;

  if (payments.length === 0) {
    return (
      <View style={tokens.block}>
        <Text style={eyebrow}>Pagos</Text>
        <Text style={tokens.empty}>Sin pagos registrados.</Text>
      </View>
    );
  }

  return (
    <View style={tokens.block}>
      <Text style={eyebrow}>Pagos</Text>
      {payments.map((payment, index) => (
        <View
          // Same key strategy as LineItemsTable: positional index,
          // safe because the data shape doesn't reorder across
          // renders for the same sale.
          key={`${payment.method}-${index}`}
          style={tokens.row}
        >
          <View style={paymentRowStyles.leftColumn}>
            <Text style={tokens.method}>
              {payment.paymentMethodName
                ? payment.paymentMethodName
                : formatMethod(payment.method)}
            </Text>
            {payment.paymentMethodSubtitle ? (
              <Text style={tokens.reference}>
                {payment.paymentMethodSubtitle}
              </Text>
            ) : payment.reference ? (
              <Text style={tokens.reference}>Ref: {payment.reference}</Text>
            ) : null}
            {payment.paidAt ? (
              <Text style={tokens.timestamp}>
                {formatTimestamp(payment.paidAt)}
              </Text>
            ) : null}
          </View>
          <Text style={tokens.amount}>
            {formatCurrency(payment.amountCents)}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * Local layout — 2-column flex (method+meta on left, amount on right).
 * The left column shrinks so a long method name never pushes the
 * amount off the row on the narrow ticket.
 */
const paymentRowStyles = {
  leftColumn: {
    flexDirection: 'column' as const,
    flexGrow: 1,
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
