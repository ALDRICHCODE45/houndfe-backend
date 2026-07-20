/**
 * LineItemsTable — middle section of every receipt.
 *
 * Renders the list of purchased line items in a 5-column flexbox
 * table: Producto / Cant / Precio Unit / Descuento / Subtotal.
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
 * items (refunded, voided, fully-discounted edge case). The table
 * renders a single italic placeholder so the section isn't visually
 * missing — keeps the receipt's section count stable across sales.
 *
 * Discount column: when `discountTitle` is null the cell shows a
 * muted dash. We render the discount title (not just the cents)
 * because the spec calls out promotion names as part of the
 * receipt's audit trail (e.g. "Promo 2x1", "Black Friday -20%").
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

const HEADER_LABELS = {
  a4: {
    product: 'PRODUCTO',
    quantity: 'CANT',
    unitPrice: 'PRECIO UNIT',
    discount: 'DESCUENTO',
    subtotal: 'SUBTOTAL',
  },
  ticket: {
    product: 'PROD',
    quantity: 'CANT',
    unitPrice: 'P.UNIT',
    discount: 'DESC',
    subtotal: 'SUBT',
  },
} as const;

export function LineItemsTable({ items, variant = 'a4' }: LineItemsTableProps) {
  const labels = HEADER_LABELS[variant];
  const ticketHeaderStyles =
    variant === 'ticket' ? [SHARED_STYLES.table.ticketHeaderCell] : [];
  const ticketCellContainerStyles =
    variant === 'ticket' ? [SHARED_STYLES.table.ticketCellContainer] : [];
  const ticketCellStyles =
    variant === 'ticket' ? [SHARED_STYLES.table.ticketCell] : [];
  const ticketCellMutedStyles =
    variant === 'ticket' ? [SHARED_STYLES.table.ticketCellMuted] : [];
  const ticketCellNumericStyles =
    variant === 'ticket' ? [SHARED_STYLES.table.ticketCellNumeric] : [];

  if (items.length === 0) {
    return (
      <View>
        <Text style={SHARED_STYLES.receipt.sectionHeader}>PRODUCTOS</Text>
        <View style={SHARED_STYLES.table.wrapper}>
          <View style={SHARED_STYLES.table.row}>
            <Text style={SHARED_STYLES.table.emptyRow}>---</Text>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View>
      <Text style={SHARED_STYLES.receipt.sectionHeader}>PRODUCTOS</Text>
      <View style={SHARED_STYLES.table.wrapper}>
        <View style={SHARED_STYLES.table.headerRow}>
          <Text
            style={[
              SHARED_STYLES.table.headerCell,
              ...ticketHeaderStyles,
              SHARED_STYLES.table.colProduct,
            ]}
          >
            {labels.product}
          </Text>
          <Text
            style={[
              SHARED_STYLES.table.headerCell,
              ...ticketHeaderStyles,
              SHARED_STYLES.table.colQuantity,
            ]}
          >
            {labels.quantity}
          </Text>
          <Text
            style={[
              SHARED_STYLES.table.headerCell,
              ...ticketHeaderStyles,
              SHARED_STYLES.table.colUnitPrice,
            ]}
          >
            {labels.unitPrice}
          </Text>
          <Text
            style={[
              SHARED_STYLES.table.headerCell,
              ...ticketHeaderStyles,
              SHARED_STYLES.table.colDiscount,
            ]}
          >
            {labels.discount}
          </Text>
          <Text
            style={[
              SHARED_STYLES.table.headerCell,
              ...ticketHeaderStyles,
              SHARED_STYLES.table.colSubtotal,
            ]}
          >
            {labels.subtotal}
          </Text>
        </View>

        {items.map((item, index) => (
          <View
            key={`${item.productName}-${index}`}
            style={SHARED_STYLES.table.row}
          >
            <View
              style={[
                SHARED_STYLES.table.cellContainer,
                ...ticketCellContainerStyles,
                SHARED_STYLES.table.colProduct,
              ]}
            >
              <Text style={[SHARED_STYLES.table.cell, ...ticketCellStyles]}>
                {item.productName}
              </Text>
              {item.variantName ? (
                <Text
                  style={[
                    SHARED_STYLES.table.cellMuted,
                    ...ticketCellMutedStyles,
                  ]}
                >
                  {item.variantName}
                </Text>
              ) : null}
            </View>
            <Text
              style={[
                SHARED_STYLES.table.cellNumeric,
                ...ticketCellNumericStyles,
                SHARED_STYLES.table.cellContainer,
                ...ticketCellContainerStyles,
                SHARED_STYLES.table.colQuantity,
              ]}
            >
              {formatQuantity(item.quantity)}
            </Text>
            <Text
              style={[
                SHARED_STYLES.table.cellNumeric,
                ...ticketCellNumericStyles,
                SHARED_STYLES.table.cellContainer,
                ...ticketCellContainerStyles,
                SHARED_STYLES.table.colUnitPrice,
              ]}
            >
              {formatCurrency(item.unitPriceCents)}
            </Text>
            <View
              style={[
                SHARED_STYLES.table.cellContainer,
                ...ticketCellContainerStyles,
                SHARED_STYLES.table.colDiscount,
              ]}
            >
              {item.discountTitle && item.discountAmountCents ? (
                <>
                  <Text
                    style={[
                      SHARED_STYLES.table.cellNumeric,
                      ...ticketCellNumericStyles,
                    ]}
                  >
                    -{formatCurrency(item.discountAmountCents)}
                  </Text>
                  <Text
                    style={[
                      SHARED_STYLES.table.cellMuted,
                      ...ticketCellMutedStyles,
                    ]}
                  >
                    {item.discountTitle}
                  </Text>
                </>
              ) : (
                <Text
                  style={[
                    SHARED_STYLES.table.cellMuted,
                    ...ticketCellMutedStyles,
                  ]}
                >
                  ---
                </Text>
              )}
            </View>
            <Text
              style={[
                SHARED_STYLES.table.cellNumeric,
                ...ticketCellNumericStyles,
                SHARED_STYLES.table.cellContainer,
                ...ticketCellContainerStyles,
                SHARED_STYLES.table.colSubtotal,
              ]}
            >
              {formatCurrency(item.subtotalCents)}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
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
