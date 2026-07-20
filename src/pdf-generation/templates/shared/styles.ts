/**
 * Shared StyleSheet for the PDF receipt templates.
 *
 * Centralised here so every block (header, items, totals, payments,
 * customer) renders with the same typography, spacing, and color
 * palette. Templates compose these shared styles into larger Page
 * layouts without redefining colors or font sizes — a single token
 * change here updates every rendered section.
 *
 * Tokens are sourced from the HoundFe brand manual (same family as
 * `src/notifications/email/templates/low-stock.email.tsx`), so PDF
 * output visually pairs with the email surface on the same product.
 *
 * Layout contract:
 *   - `receipt` is the named block-style bag used by every shared
 *     component via `styles.receipt.<token>`.
 *   - `table` is the column-flex style bag for `LineItemsTable`.
 *   - `totals` is the label/value flex style bag for `TotalsBlock`.
 *   - `payments` is the row-flex style bag for `PaymentsList`.
 *   - `meta` is the small-label style bag for `ReceiptHeader` (folio,
 *     date, branch info).
 *
 * All sizes are PDF points (1pt = 1/72 inch). Column widths below
 * are tuned for A4 minus 40pt page padding (≈555pt content width);
 * on the 227pt-wide ticket format the line-items table fits within
 * 207pt content width via proportional flex shrink.
 */

const COLORS = {
  // Brand HoundFe palette (mirrors low-stock.email.tsx tokens).
  ink: '#2c2434',
  inkSoft: '#493f54',
  textBody: '#443d4e',
  textMuted: '#938c9e',
  brand: '#f6bb13',
  surface: '#fbfafc',
  border: '#eceaf0',
  divider: '#eceaf0',
  white: '#ffffff',
} as const;

const FONTS = {
  body: 'Helvetica',
  bodyBold: 'Helvetica-Bold',
} as const;

export const SHARED_STYLES = {
  // ─── Receipt shell ─────────────────────────────────────────────
  receipt: {
    pagePadding: 20,
    sectionGap: 12,
    blockGap: 6,
    color: COLORS.ink,
    fontFamily: FONTS.body,
    fontSize: 10,
    lineHeight: 1.4,
    outerBorder: {
      borderWidth: 1,
      borderColor: COLORS.border,
      borderStyle: 'solid' as const,
    },
    sectionHeader: {
      fontFamily: FONTS.bodyBold,
      fontSize: 9,
      color: COLORS.inkSoft,
      letterSpacing: 0.8,
      textTransform: 'uppercase' as const,
      marginTop: 10,
      marginBottom: 4,
    },
    footer: {
      fontFamily: FONTS.bodyBold,
      fontSize: 9,
      color: COLORS.inkSoft,
      textAlign: 'center' as const,
      marginTop: 12,
    },
    subtitle: {
      fontFamily: FONTS.body,
      fontSize: 8,
      color: COLORS.textMuted,
      letterSpacing: 1,
      textTransform: 'uppercase' as const,
    },
    folioRow: {
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
      marginBottom: 4,
    },
    folioBlock: {
      textAlign: 'right' as const,
      fontFamily: FONTS.body,
      fontSize: 8,
    },
    folioValue: {
      fontFamily: FONTS.bodyBold,
      fontSize: 9,
      color: COLORS.ink,
    },
  },

  // ─── Meta labels (folio, date, branch) ──────────────────────────
  meta: {
    label: {
      fontFamily: FONTS.bodyBold,
      fontSize: 8,
      color: COLORS.textMuted,
      letterSpacing: 0.5,
      textTransform: 'uppercase',
      marginBottom: 2,
    },
    value: {
      fontFamily: FONTS.body,
      fontSize: 10,
      color: COLORS.ink,
    },
    companyName: {
      fontFamily: FONTS.bodyBold,
      fontSize: 18,
      color: COLORS.ink,
      marginBottom: 2,
    },
    brandLine: {
      fontFamily: FONTS.body,
      fontSize: 8,
      color: COLORS.inkSoft,
    },
    folio: {
      fontFamily: FONTS.bodyBold,
      fontSize: 12,
      color: COLORS.ink,
    },
  },

  // ─── Section dividers ───────────────────────────────────────────
  divider: {
    borderBottomWidth: 1,
    borderBottomColor: COLORS.divider,
    borderBottomStyle: 'solid',
    marginVertical: 8,
  },

  // ─── Line-items table ───────────────────────────────────────────
  table: {
    headerRow: {
      flexDirection: 'row',
      borderTopWidth: 1,
      borderTopColor: COLORS.border,
      borderTopStyle: 'solid',
      borderBottomWidth: 1,
      borderBottomColor: COLORS.border,
      borderBottomStyle: 'solid',
      paddingBottom: 4,
      marginBottom: 4,
    },
    headerCellBorder: {
      borderRightWidth: 1,
      borderRightColor: COLORS.border,
      borderRightStyle: 'solid' as const,
    },
    cellBorder: {
      borderRightWidth: 1,
      borderRightColor: COLORS.divider,
      borderRightStyle: 'solid' as const,
    },
    headerCell: {
      fontFamily: FONTS.bodyBold,
      fontSize: 8,
      color: COLORS.textMuted,
      letterSpacing: 0.4,
      textTransform: 'uppercase',
    },
    row: {
      flexDirection: 'row',
      paddingVertical: 4,
      borderBottomWidth: 1,
      borderBottomColor: COLORS.divider,
      borderBottomStyle: 'solid',
    },
    cell: {
      fontFamily: FONTS.body,
      fontSize: 10,
      color: COLORS.ink,
    },
    cellMuted: {
      fontFamily: FONTS.body,
      fontSize: 9,
      color: COLORS.textMuted,
    },
    cellNumeric: {
      fontFamily: FONTS.body,
      fontSize: 10,
      color: COLORS.ink,
      textAlign: 'right',
    },
    // Column proportions: product | qty | unit | discount | subtotal.
    // `flexGrow` sums to 14 across the row.
    colProduct: { flexGrow: 6 },
    colQuantity: { flexGrow: 1, textAlign: 'right' as const },
    colUnitPrice: { flexGrow: 2, textAlign: 'right' as const },
    colDiscount: { flexGrow: 2, textAlign: 'right' as const },
    colSubtotal: { flexGrow: 3, textAlign: 'right' as const },
    emptyRow: {
      paddingVertical: 8,
      fontFamily: FONTS.bodyBold,
      fontSize: 9,
      color: COLORS.textMuted,
      textAlign: 'center' as const,
    },
  },

  // ─── Totals block ───────────────────────────────────────────────
  totals: {
    row: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingVertical: 3,
    },
    label: {
      fontFamily: FONTS.body,
      fontSize: 10,
      color: COLORS.textBody,
    },
    value: {
      fontFamily: FONTS.body,
      fontSize: 10,
      color: COLORS.ink,
      textAlign: 'right',
    },
    labelBold: {
      fontFamily: FONTS.bodyBold,
      fontSize: 11,
      color: COLORS.ink,
    },
    valueBold: {
      fontFamily: FONTS.bodyBold,
      fontSize: 11,
      color: COLORS.ink,
      textAlign: 'right',
    },
    grandTotalLabel: {
      fontFamily: FONTS.bodyBold,
      fontSize: 13,
      color: COLORS.ink,
    },
    grandTotalValue: {
      fontFamily: FONTS.bodyBold,
      fontSize: 13,
      color: COLORS.brand,
      textAlign: 'right',
    },
  },

  // ─── Payments list ──────────────────────────────────────────────
  payments: {
    row: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingVertical: 3,
    },
    method: {
      fontFamily: FONTS.bodyBold,
      fontSize: 9,
      color: COLORS.ink,
    },
    amount: {
      fontFamily: FONTS.body,
      fontSize: 10,
      color: COLORS.ink,
      textAlign: 'right',
    },
    reference: {
      fontFamily: FONTS.body,
      fontSize: 8,
      color: COLORS.textMuted,
    },
    timestamp: {
      fontFamily: FONTS.body,
      fontSize: 8,
      color: COLORS.textMuted,
    },
    emptyRow: {
      fontFamily: FONTS.body,
      fontSize: 9,
      color: COLORS.textMuted,
      fontStyle: 'italic',
      paddingVertical: 4,
    },
  },

  // ─── Customer section ───────────────────────────────────────────
  customer: {
    row: {
      flexDirection: 'row',
      alignItems: 'baseline',
      paddingVertical: 2,
    },
    label: {
      fontFamily: FONTS.bodyBold,
      fontSize: 8,
      color: COLORS.textMuted,
      letterSpacing: 0.4,
      textTransform: 'uppercase',
      marginRight: 6,
    },
    value: {
      fontFamily: FONTS.body,
      fontSize: 11,
      color: COLORS.ink,
    },
  },
} as const;
