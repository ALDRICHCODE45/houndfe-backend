/**
 * LineItemsTable — middle section of every receipt (modern design).
 *
 * Renders the list of purchased line items as clean, line-less rows:
 *   - Left: product name (bold) with the variant below it in gray.
 *   - Right: `qty × unit` in gray and the bold line total.
 *
 * There are NO column headers and NO table grid lines — rows are
 * separated by vertical rhythm only, mirroring the approved quotation
 * pilot's `ItemsList`. Per-line discounts are folded into the line
 * subtotal (the total block reports the aggregate discount), so the
 * discount columns of the legacy grid are gone.
 *
 * Data model: the prop shape is a *narrowed* subset of
 * `SaleDetailItemDto` (see `src/sales/dto/sale-detail-response.dto.ts`)
 * — same numeric types, same nullable `discountTitle` /
 * `discountAmountCents` semantics. We define the interface here
 * (not by importing the DTO) so the shared component stays a
 * pure presentational unit: it doesn't depend on the sales module,
 * and tests can pass synthetic fixtures without booting the DTO
 * pipeline.
 *
 * Empty list: per spec, a sale can legitimately have zero line
 * items (refunded, voided, fully-discounted edge case). The block
 * renders a single italic placeholder so the section isn't visually
 * missing — keeps the receipt's section count stable across sales.
 *
 * Variants:
 *   - `a4` — full-size tokens (name 11pt, variant 9pt, total 11pt 700).
 *   - `ticket` — compact twin for the 80mm thermal format. Product
 *     names are truncated (~40 chars + ellipsis) so a long name cannot
 *     push the line total off the 211pt content width.
 */
import { Text, View } from '@react-pdf/renderer';
import { SHARED_STYLES } from './styles';

/**
 * One line in the receipt. Mirrors `SaleDetailItemDto` but trimmed
 * to the columns the receipt actually prints. Variant and image
 * fields are omitted because the receipt header is the brand
 * surface; variant context appears in productName when relevant.
 */
export interface LineItem {
  productName: string;
  variantName?: string | null;
  quantity: number;
  unitPriceCents: number;
  /** Title of the discount that applied (e.g. "Promo 2x1"). Null when no discount. */
  discountTitle?: string | null;
  /** Discount amount in cents. Null when no discount. */
  discountAmountCents?: number | null;
  /** Pre-tax line subtotal in cents (quantity * unitPrice - discount). */
  subtotalCents: number;
}

export type LineItemsTableVariant = 'a4' | 'ticket';

export interface LineItemsTableProps {
  items: LineItem[];
  variant?: LineItemsTableVariant;
}

// Max product-name length on the ticket before we ellipsize. The ticket
// content width is ~211pt; at 8pt Inter a 40-char name ≈ 175pt, leaving
// room for the right-aligned `2 × $125.00` total column.
const TICKET_NAME_MAX_CHARS = 40;

export function LineItemsTable({ items, variant = 'a4' }: LineItemsTableProps) {
  const isTicket = variant === 'ticket';
  const tokens = isTicket
    ? SHARED_STYLES.modern.ticket.items
    : SHARED_STYLES.modern.items;
  const eyebrow = isTicket
    ? SHARED_STYLES.modern.ticket.eyebrow
    : SHARED_STYLES.modern.eyebrow;

  if (items.length === 0) {
    return (
      <View style={tokens.block}>
        <Text style={eyebrow}>Productos</Text>
        <Text style={tokens.empty}>---</Text>
      </View>
    );
  }

  return (
    <View style={tokens.block}>
      <Text style={eyebrow}>Productos</Text>
      {items.map((item, index) => (
        <View key={`${item.productName}-${index}`} style={tokens.row}>
          <View style={lineRowStyles.leftColumn}>
            <Text style={tokens.productName}>
              {isTicket
                ? truncateProductName(item.productName)
                : item.productName}
            </Text>
            {item.variantName ? (
              <Text style={tokens.productVariant}>
                {isTicket
                  ? truncateProductName(item.variantName)
                  : item.variantName}
              </Text>
            ) : null}
          </View>
          <View style={lineRowStyles.rightColumn}>
            <Text style={tokens.qtyLine}>
              {formatQuantity(item.quantity)} ×{' '}
              {formatCurrency(item.unitPriceCents)}
            </Text>
            <Text style={tokens.lineTotal}>
              {formatCurrency(item.subtotalCents)}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * Local column layout for each line — left (name/variant) flexes and
 * shrinks, right (qty/unit + total) stays anchored to the row edge.
 */
const lineRowStyles = {
  leftColumn: {
    flexDirection: 'column' as const,
    flexGrow: 1,
    flexShrink: 1,
    paddingRight: 8,
  },
  rightColumn: {
    flexDirection: 'column' as const,
    alignItems: 'flex-end' as const,
    flexShrink: 0,
  },
};

/**
 * Truncate long names on the narrow ticket with a trailing ellipsis.
 * react-pdf 4.x has no text-overflow ellipsis, so we clip at the
 * character level. Only the ticket variant truncates; A4 lets names
 * wrap naturally.
 */
function truncateProductName(value: string): string {
  if (value.length <= TICKET_NAME_MAX_CHARS) {
    return value;
  }
  return `${value.slice(0, TICKET_NAME_MAX_CHARS - 1)}…`;
}

/**
 * Render an integer quantity as a trimmed string. Real data has
 * decimals only for fractional units (kg, meters), but receipts
 * print whole numbers for clarity — POS receipts rarely need
 * fractional display.
 */
function formatQuantity(qty: number): string {
  if (Number.isInteger(qty)) {
    return qty.toString();
  }
  // Trim trailing zeros for fractional quantities (e.g. 1.50 -> "1.5").
  return qty.toFixed(2).replace(/\.?0+$/, '');
}

/**
 * Format cents as a fixed-decimal currency string with the peso
 * sign as a prefix. We avoid Intl.NumberFormat here because:
 *   - It's slower (per-call ICU lookup)
 *   - It varies across Node ICU builds, so the same cents can
 *     produce slightly different glyphs (e.g. non-breaking space
 *     vs. narrow no-break space) — receipts are legal docs and
 *     need bit-stable output.
 *
 * Negative discounts prepend their own "-" via the call site, so
 * this helper returns the absolute amount.
 */
function formatCurrency(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents) / 100;
  return `${sign}$${abs.toFixed(2)}`;
}
