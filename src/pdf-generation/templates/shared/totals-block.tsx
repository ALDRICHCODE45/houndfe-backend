/**
 * TotalsBlock — financial summary at the bottom of every receipt (modern).
 *
 * Rows, in this order:
 *   1. Subtotal  — pre-discount sum of line items.
 *   2. Descuentos — total discounts applied (positive cents).
 *   3. Pagado / Deuda / Cambio — payment settlement rows rendered only
 *      when their value is non-zero (a fully-paid cash sale with no
 *      change prints none of them). Kept discrete gray rows so the
 *      credit-sale balance stays visible without stealing focus.
 *   4. TOTAL      — post-discount grand total on a highlighted card:
 *      label + 18pt 800 value in the accent blue #2563EB. This is the
 *      document's focal point.
 *
 * A subtle divider separates the plain rows from the grand-total card.
 * There is NO IVA row — the grand total already includes IVA in this
 * system, so printing one would double-count for the customer.
 *
 * All inputs are cents (numbers). Zero is a valid value for every
 * field. The component renders Subtotal/Descuentos zeros as "$0.00"
 * (never blank) so the section's row count is stable; the settlement
 * rows (Pagado/Deuda/Cambio) are omitted at zero to avoid noise.
 *
 * `paidCents` / `debtCents` / `changeDueCents` are part of the prop
 * contract (the service maps the full `SaleDetailResponseDto` totals and
 * `ReceiptDocumentProps` is typed against this surface).
 *
 * Variants:
 *   - `a4` — full-size rows (10-10.5pt) + grand-total card (padding 16).
 *   - `ticket` — compact rows (8pt) + the total value in 15pt 800 blue,
 *     the largest size that fits the 227pt width. The ticket drops the
 *     card fill (it would eat the narrow width) — the blue value alone
 *     is the focal point.
 */
import { Text, View } from '@react-pdf/renderer';
import { SHARED_STYLES } from './styles';

export interface TotalsBlockProps {
  /** Pre-discount sum of line items, in cents. */
  subtotalCents: number;
  /** Total discounts applied across all lines, in cents (≥ 0). */
  discountCents: number;
  /** Final grand total after discounts, in cents. */
  totalCents: number;
  /** Amount the customer paid across all payment methods, in cents. Rendered only when non-zero. */
  paidCents: number;
  /** Outstanding balance (total - paid) for credit sales, in cents. Rendered only when non-zero. */
  debtCents: number;
  /** Change returned to the customer (paid - total) when overpaid, in cents. Rendered only when non-zero. */
  changeDueCents: number;
  /** Layout variant: A4 (grand-total card) or ticket (compact blue value). */
  variant?: 'a4' | 'ticket';
}

export function TotalsBlock({
  subtotalCents,
  discountCents,
  totalCents,
  paidCents,
  debtCents,
  changeDueCents,
  variant = 'a4',
}: TotalsBlockProps) {
  const isTicket = variant === 'ticket';
  const tokens = isTicket
    ? SHARED_STYLES.modern.ticket.totals
    : SHARED_STYLES.modern.totals;

  return (
    <View style={tokens.block}>
      <View style={tokens.row}>
        <Text style={tokens.label}>Subtotal</Text>
        <Text style={tokens.value}>{formatCurrency(subtotalCents)}</Text>
      </View>
      <View style={tokens.row}>
        <Text style={tokens.label}>Descuentos</Text>
        <Text style={tokens.value}>
          {discountCents > 0
            ? `-${formatCurrency(discountCents)}`
            : formatCurrency(discountCents)}
        </Text>
      </View>

      {/* Settlement rows — only when the value matters (≠ 0). A credit
          sale prints Deuda; a cash overpay prints Cambio; a fully paid
          sale prints nothing between Descuentos and TOTAL. */}
      {paidCents > 0 ? (
        <View style={tokens.row}>
          <Text style={tokens.label}>Pagado</Text>
          <Text style={tokens.value}>{formatCurrency(paidCents)}</Text>
        </View>
      ) : null}
      {debtCents > 0 ? (
        <View style={tokens.row}>
          <Text style={tokens.label}>Deuda</Text>
          <Text style={tokens.value}>{formatCurrency(debtCents)}</Text>
        </View>
      ) : null}
      {changeDueCents > 0 ? (
        <View style={tokens.row}>
          <Text style={tokens.label}>Cambio</Text>
          <Text style={tokens.value}>{formatCurrency(changeDueCents)}</Text>
        </View>
      ) : null}

      <View style={tokens.divider} />

      {isTicket ? (
        <View style={SHARED_STYLES.modern.ticket.totals.totalRow}>
          <Text style={SHARED_STYLES.modern.ticket.totals.totalLabel}>
            TOTAL
          </Text>
          <Text style={SHARED_STYLES.modern.ticket.totals.totalValue}>
            {formatCurrency(totalCents)}
          </Text>
        </View>
      ) : (
        <View style={SHARED_STYLES.modern.totals.totalCard}>
          <Text style={SHARED_STYLES.modern.totals.totalLabel}>TOTAL</Text>
          <Text style={SHARED_STYLES.modern.totals.totalValue}>
            {formatCurrency(totalCents)}
          </Text>
        </View>
      )}
    </View>
  );
}

/**
 * Format cents as a fixed-decimal currency string. See the same
 * helper in `line-items-table.tsx` for the rationale against
 * `Intl.NumberFormat`.
 */
function formatCurrency(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents) / 100;
  return `${sign}$${abs.toFixed(2)}`;
}
