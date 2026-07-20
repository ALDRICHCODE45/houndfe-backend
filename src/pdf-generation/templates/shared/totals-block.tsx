/**
 * TotalsBlock — financial summary at the bottom of every receipt.
 *
 * Six rows, in this order:
 *   1. Subtotal  — pre-discount sum of line items.
 *   2. Descuentos — total discounts applied (positive cents).
 *   3. Total      — post-discount grand total. Bold, brand-yellow
 *                    so the eye lands on it after scanning the
 *                    receipt top-down.
 *   4. Pagado     — amount the customer paid across all payments.
 *   5. Deuda      — outstanding balance for credit sales.
 *   6. Cambio     — change due back to the customer (cash overpay).
 *
 * All inputs are cents (numbers). Zero is a valid value for every
 * field — a fully-paid, no-change sale has 0 in every row except
 * `paidCents` and `totalCents`. The component renders zeros as
 * "$0.00" (never blank) so the section's row count is stable.
 *
 * Style hierarchy: the block uses three type weights —
 *   - `label` / `value` for the supporting rows.
 *   - `labelBold` / `valueBold` for `Total` (one step heavier).
 *   - `grandTotalLabel` / `grandTotalValue` for the grand total
 *     when the optional `totalCents` prop is rendered larger
 *     (here `Total` doubles as the grand total; we keep that
 *     single bold row to stay aligned with the spec).
 *
 * Renders inside any width: A4 (≈555pt) lays out label left,
 * value right with comfortable breathing room; ticket (≈207pt)
 * collapses the same way without overflow.
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
  /** Amount the customer paid across all payment methods, in cents. */
  paidCents: number;
  /** Outstanding balance (total - paid) for credit sales, in cents. */
  debtCents: number;
  /** Change returned to the customer (paid - total) when overpaid, in cents. */
  changeDueCents: number;
}

export function TotalsBlock({
  subtotalCents,
  discountCents,
  totalCents,
  paidCents,
  debtCents,
  changeDueCents,
}: TotalsBlockProps) {
  return (
    <View>
      <TotalRow label="Subtotal" valueCents={subtotalCents} />
      <TotalRow
        label="Descuentos"
        valueCents={discountCents}
        // Negative because discounts reduce the total — the
        // label always says "Descuentos" (positive noun) but
        // the value is prefixed with "-" for visual parity
        // with the rest of the receipt's accounting math.
        signed
      />
      <TotalRow
        label="Total"
        valueCents={totalCents}
        emphasis="grand"
      />
      <TotalRow label="Pagado" valueCents={paidCents} />
      <TotalRow label="Deuda" valueCents={debtCents} />
      <TotalRow label="Cambio" valueCents={changeDueCents} />
    </View>
  );
}

interface TotalRowProps {
  label: string;
  /** Cents value. Always rendered as "$X.XX"; sign handled per-row. */
  valueCents: number;
  /** When true, prefix the value with "-" (used for discounts). */
  signed?: boolean;
  /** "bold" uses the larger body-bold style for `Total`; "grand" uses
   *  the brand-yellow grand-total style. */
  emphasis?: 'bold' | 'grand';
}

/**
 * Single label-value row of the totals block. Internal — kept
 * next to `TotalsBlock` rather than exported because no other
 * template needs to render the same row shape.
 */
function TotalRow({ label, valueCents, signed, emphasis }: TotalRowProps) {
  const labelStyle =
    emphasis === 'grand'
      ? SHARED_STYLES.totals.grandTotalLabel
      : emphasis === 'bold'
        ? SHARED_STYLES.totals.labelBold
        : SHARED_STYLES.totals.label;

  const valueStyle =
    emphasis === 'grand'
      ? SHARED_STYLES.totals.grandTotalValue
      : emphasis === 'bold'
        ? SHARED_STYLES.totals.valueBold
        : SHARED_STYLES.totals.value;

  // The `signed` prop renders "-$X.XX" for discounts (positive
  // cents → displayed as a negative). The other rows render the
  // raw value, including negative values if the caller passes
  // them (e.g. a refund line item).
  const display =
    signed && valueCents > 0
      ? `-${formatCurrency(valueCents)}`
      : formatCurrency(valueCents);

  return (
    <View style={SHARED_STYLES.totals.row}>
      <Text style={labelStyle}>{label}</Text>
      <Text style={valueStyle}>{display}</Text>
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