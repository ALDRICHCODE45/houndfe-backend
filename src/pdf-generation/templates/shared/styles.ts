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
  // Brand-tinted surface: a soft yellow wash (~10% perceived opacity)
  // used as the background of the grand-total row. Kept as a literal
  // here rather than derived so the value is stable across renders.
  brandSurface: '#fef9e6',
  surface: '#fbfafc',
  // Lighter divider for table rows — visually subtle so the eye reads
  // the receipt by color blocks instead of a hard grid.
  rowDivider: '#f5f3f7',
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
    // Brand accent bar — a 3pt solid yellow strip rendered at the
    // very top of every receipt page. This is the primary brand-color
    // element of the redesign; it replaces the gray border grid as
    // the receipt's primary visual marker.
    brandAccentBar: {
      height: 3,
      backgroundColor: COLORS.brand,
      marginBottom: 8,
    },
    sectionHeader: {
      fontFamily: FONTS.bodyBold,
      fontSize: 9,
      color: COLORS.inkSoft,
      letterSpacing: 0.8,
      textTransform: 'uppercase' as const,
      marginTop: 10,
      marginBottom: 4,
      // Yellow underline carries the brand color through the middle of
      // the receipt (PRODUCTOS / TOTALES / PAGOS) without relying on
      // vertical/horizontal borders for visual structure.
      borderBottomWidth: 2,
      borderBottomColor: COLORS.brand,
      borderBottomStyle: 'solid' as const,
      paddingBottom: 4,
    },
    footer: {
      fontFamily: FONTS.bodyBold,
      fontSize: 9,
      color: COLORS.inkSoft,
      textAlign: 'center' as const,
      marginTop: 12,
      // Thin yellow hairline above the "Gracias" line — mirrors the
      // top accent bar at the bottom of the receipt so the brand
      // color brackets the whole page.
      borderTopWidth: 1,
      borderTopColor: COLORS.brand,
      borderTopStyle: 'solid' as const,
      paddingTop: 8,
    },
    subtitle: {
      fontFamily: FONTS.body,
      fontSize: 8,
      color: COLORS.textMuted,
      // Tight tracking: 1 made "FARMACIA" spread wide enough to
      // collide with the descenders of the HoundFe title above on
      // the narrow ticket format. 0.4 keeps the word legible while
      // staying visually tight under the title.
      letterSpacing: 0.4,
      textTransform: 'uppercase' as const,
    },
    folioBox: {
      minWidth: 95,
      borderWidth: 1,
      borderColor: COLORS.border,
      borderStyle: 'solid' as const,
      paddingHorizontal: 6,
      paddingVertical: 5,
    },
    folioRow: {
      flexDirection: 'row' as const,
      justifyContent: 'space-between' as const,
      alignItems: 'baseline' as const,
      marginBottom: 4,
    },
    folioBlock: {
      textAlign: 'right' as const,
      fontFamily: FONTS.body,
      fontSize: 8,
      color: COLORS.textMuted,
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
    // Smaller company-name variant for narrow formats (e.g. 80mm
    // ticket). The default 18pt HoundFe word dominates the header
    // and visually collides with the FARMACIA subtitle below; 14pt
    // gives the subtitle room to breathe on a 227pt page.
    companyNameSmall: {
      fontFamily: FONTS.bodyBold,
      fontSize: 14,
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
    // Wrapper keeps its outer boundary but in a barely-there row
    // divider color — visual structure is carried by the section
    // header underline + header-row fill, not by a hard border grid.
    wrapper: {
      borderWidth: 1,
      borderColor: COLORS.rowDivider,
      borderStyle: 'solid' as const,
    },
    headerRow: {
      flexDirection: 'row',
      // Surface-gray fill separates the header from data rows by
      // color rather than by a thick top+bottom border grid.
      backgroundColor: COLORS.surface,
      borderBottomWidth: 1,
      borderBottomColor: COLORS.rowDivider,
      borderBottomStyle: 'solid',
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
      paddingHorizontal: 3,
      paddingVertical: 4,
      fontFamily: FONTS.bodyBold,
      fontSize: 8,
      color: COLORS.textMuted,
      letterSpacing: 0.4,
      textTransform: 'uppercase',
    },
    ticketHeaderCell: {
      paddingHorizontal: 1,
      paddingVertical: 3,
      fontSize: 6.5,
      letterSpacing: 0,
    },
    row: {
      flexDirection: 'row',
      borderBottomWidth: 1,
      borderBottomColor: COLORS.rowDivider,
      borderBottomStyle: 'solid',
    },
    cellContainer: {
      paddingHorizontal: 3,
      paddingVertical: 4,
    },
    ticketCellContainer: {
      paddingHorizontal: 1,
      paddingVertical: 3,
    },
    cell: {
      fontFamily: FONTS.body,
      fontSize: 10,
      color: COLORS.ink,
    },
    ticketCell: {
      fontSize: 7,
    },
    cellMuted: {
      fontFamily: FONTS.body,
      fontSize: 9,
      color: COLORS.textMuted,
    },
    ticketCellMuted: {
      fontSize: 6.5,
    },
    cellNumeric: {
      fontFamily: FONTS.body,
      fontSize: 10,
      color: COLORS.ink,
      textAlign: 'right',
    },
    ticketCellNumeric: {
      fontSize: 7,
    },
    // Column proportions: product | qty | unit | discount | subtotal.
    // `flexGrow` sums to 14 across the row.
    colProduct: { flexBasis: 0, flexGrow: 6, flexShrink: 1 },
    colQuantity: {
      flexBasis: 0,
      flexGrow: 1,
      flexShrink: 1,
      textAlign: 'right' as const,
    },
    colUnitPrice: {
      flexBasis: 0,
      flexGrow: 2,
      flexShrink: 1,
      textAlign: 'right' as const,
    },
    colDiscount: {
      flexBasis: 0,
      flexGrow: 2,
      flexShrink: 1,
      textAlign: 'right' as const,
    },
    colSubtotal: {
      flexBasis: 0,
      flexGrow: 3,
      flexShrink: 1,
      textAlign: 'right' as const,
    },
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
    // Wrapper around the grand-total (Total) row: a soft yellow tint
    // so the eye lands on it after scanning top-down. The label/value
    // text inside stays bold + brand color — this fill is the block's
    // primary brand-color element.
    grandTotalRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      backgroundColor: COLORS.brandSurface,
      paddingHorizontal: 6,
      paddingVertical: 5,
      marginTop: 2,
      marginBottom: 2,
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
