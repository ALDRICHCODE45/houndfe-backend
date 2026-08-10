/**
 * Shared StyleSheet for the PDF templates.
 *
 * Centralised here so every block (header, customer, items, totals,
 * payments, operator meta) renders with the same typography, spacing,
 * and color palette. Templates compose these shared styles into larger
 * Page layouts without redefining colors or font sizes — a single token
 * change here updates every rendered section.
 *
 * All sizes are PDF points (1pt = 1/72 inch). Two formats consume this
 * sheet:
 *   - A4 (595pt wide, 40pt page padding ≈ 555pt content width).
 *   - Ticket (80mm thermal, 227pt wide, 16pt padding ≈ 211pt content).
 *
 * Token namespaces:
 *   - `modern` — the Stripe/Shopify/Square-inspired token set used by the
 *     receipt-a4 / receipt-ticket templates and the quotation-a4 pilot.
 *     Clean hierarchy, zero table grid lines, single blue accent, the
 *     grand total as the focal point. Palette: ink #111827, grays
 *     #6B7280/#9CA3AF/#E5E7EB, accent blue #2563EB. No yellow. Spacing
 *     follows the 4/8/12/16/24/32 scale.
 *   - `modern.ticket` — the compact 80mm-ticket overrides. Same palette,
 *     same Inter family, same visual language, but a reduced spacing
 *     scale (4/6/8/12) and smaller type so everything fits the 227pt
 *     width without the A4 cards (which carry padding 16).
 *
 * Typography: Inter (static weights 400/600/700/800, registered in
 * pdf-generation.constants). The design value here is 'Inter'; the
 * runtime family is resolved through `getModernFontFamily()` so a
 * font-CDN outage falls back to Helvetica instead of failing renders.
 */

export const SHARED_STYLES = {
  // ─── Modern design tokens (quotation-a4 pilot + receipt redesign) ───
  //
  // Direction: clean hierarchy, single blue accent, the grand total as
  // the visual focal point. Palette: ink #111827, grays
  // #6B7280/#9CA3AF/#E5E7EB, accent blue #2563EB. No yellow. Cards are
  // light surfaces (#F9FAFB + hairline border + 8pt radius) standing in
  // for box-shadows (not supported by react-pdf). Spacing uses the
  // 4/8/12/16/24/32 scale.
  modern: {
    palette: {
      ink: '#111827',
      inkSoft: '#374151',
      gray: '#6B7280',
      grayLight: '#9CA3AF',
      border: '#E5E7EB',
      surface: '#F9FAFB',
      accent: '#2563EB',
      white: '#FFFFFF',
    },
    fontFamily: 'Inter',
    // 4/8/12/16/24/32 spacing scale.
    spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
    page: {
      padding: 20,
      fontFamily: 'Inter',
      fontSize: 10,
      color: '#111827',
      lineHeight: 1.5,
    },
    // Small uppercase section/meta label.
    eyebrow: {
      fontSize: 8,
      fontWeight: 600,
      color: '#6B7280',
      letterSpacing: 0.5,
      textTransform: 'uppercase',
    },
    // Card surface — substitutes for box-shadow (not supported by
    // react-pdf) via a light fill + hairline border.
    card: {
      backgroundColor: '#F9FAFB',
      border: '1 solid #E5E7EB',
      borderRadius: 8,
      padding: 16,
    },
    cardCompact: {
      backgroundColor: '#F9FAFB',
      border: '1 solid #E5E7EB',
      borderRadius: 8,
      paddingVertical: 8,
      paddingHorizontal: 12,
    },
    header: {
      row: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        marginBottom: 24,
      },
      brandRow: {
        flexDirection: 'row',
        alignItems: 'center',
      },
      logo: {
        width: 28,
        height: 28,
        marginRight: 10,
        objectFit: 'contain',
      },
      companyName: {
        fontSize: 16,
        fontWeight: 700,
        color: '#111827',
      },
      companySub: {
        fontSize: 9,
        color: '#6B7280',
        marginTop: 2,
      },
      metaTitle: {
        fontSize: 8,
        fontWeight: 600,
        color: '#6B7280',
        letterSpacing: 0.6,
        textTransform: 'uppercase',
      },
      metaFolio: {
        fontSize: 10,
        fontWeight: 600,
        color: '#111827',
        marginTop: 4,
      },
      metaDate: {
        fontSize: 9,
        color: '#6B7280',
        marginTop: 2,
      },
    },
    // Operator meta row (cashier / seller) — small gray uppercase labels
    // next to ink values, rendered as label/value pairs by the receipt
    // documents.
    operator: {
      label: {
        fontSize: 8,
        fontWeight: 600,
        color: '#6B7280',
        letterSpacing: 0.5,
        textTransform: 'uppercase',
      },
      value: {
        fontSize: 10.5,
        fontWeight: 600,
        color: '#111827',
      },
    },
    customer: {
      block: {
        marginBottom: 24,
      },
      name: {
        fontSize: 12,
        fontWeight: 600,
        color: '#111827',
        marginTop: 4,
      },
      email: {
        fontSize: 9.5,
        color: '#6B7280',
        marginTop: 2,
      },
    },
    items: {
      block: {
        marginBottom: 24,
      },
      // One item = one row, separated by vertical rhythm, no grid lines.
      row: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        marginBottom: 12,
      },
      productName: {
        fontSize: 11,
        fontWeight: 600,
        color: '#111827',
      },
      productVariant: {
        fontSize: 9,
        color: '#6B7280',
        marginTop: 2,
      },
      qtyLine: {
        fontSize: 9,
        color: '#6B7280',
        textAlign: 'right',
      },
      lineTotal: {
        fontSize: 11,
        fontWeight: 700,
        color: '#111827',
        textAlign: 'right',
        marginTop: 2,
      },
      empty: {
        fontSize: 10,
        color: '#6B7280',
        fontStyle: 'italic',
        marginTop: 4,
      },
    },
    totals: {
      block: {
        marginBottom: 24,
      },
      row: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        marginBottom: 8,
      },
      label: {
        fontSize: 10,
        color: '#6B7280',
      },
      value: {
        fontSize: 10.5,
        fontWeight: 600,
        color: '#111827',
        textAlign: 'right',
      },
      divider: {
        borderBottomWidth: 1,
        borderBottomColor: '#E5E7EB',
        borderBottomStyle: 'solid',
        marginVertical: 12,
      },
      // Highlighted grand-total card — the visual focal point.
      totalCard: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        backgroundColor: '#F9FAFB',
        border: '1 solid #E5E7EB',
        borderRadius: 8,
        paddingHorizontal: 16,
        paddingVertical: 12,
      },
      totalLabel: {
        fontSize: 11,
        fontWeight: 600,
        color: '#374151',
      },
      totalValue: {
        fontSize: 18,
        fontWeight: 800,
        color: '#2563EB',
        textAlign: 'right',
      },
    },
    payments: {
      block: {
        marginBottom: 24,
      },
      // One payment = one clean row: method (bold) + meta on the left,
      // amount on the right. No divider lines — vertical rhythm only.
      row: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        marginBottom: 8,
      },
      method: {
        fontSize: 10.5,
        fontWeight: 600,
        color: '#111827',
      },
      reference: {
        fontSize: 8.5,
        color: '#6B7280',
        marginTop: 2,
      },
      timestamp: {
        fontSize: 8.5,
        color: '#9CA3AF',
        marginTop: 2,
      },
      amount: {
        fontSize: 11,
        fontWeight: 700,
        color: '#111827',
        textAlign: 'right',
      },
      empty: {
        fontSize: 10,
        color: '#6B7280',
        fontStyle: 'italic',
        marginTop: 4,
      },
    },
    footer: {
      expiry: {
        fontSize: 9.5,
        color: '#6B7280',
        textAlign: 'center',
        marginBottom: 16,
      },
      thanks: {
        fontSize: 11,
        fontWeight: 600,
        color: '#111827',
        textAlign: 'center',
        marginBottom: 4,
      },
      disclaimer: {
        fontSize: 8.5,
        color: '#6B7280',
        textAlign: 'center',
      },
    },

    // ─── Ticket (80mm thermal) compact overrides ─────────────────────
    //
    // RULE OF GOLD: the ticket CANNOT reuse the A4 cards (padding 16 —
    // they do not fit the 227pt width). This namespace is the compact
    // twin of `modern`: same palette, same Inter family, same visual
    // language, but a reduced spacing scale (4/6/8/12) and smaller type.
    // Page height is computed by `getTicketHeight()` in the ticket
    // document and the page uses `wrap={false}` — every token here must
    // stay tight enough that real content never exceeds that height.
    ticket: {
      page: {
        padding: 8,
        fontFamily: 'Inter',
        fontSize: 8,
        color: '#111827',
        lineHeight: 1.35,
      },
      eyebrow: {
        fontSize: 6.5,
        fontWeight: 600,
        color: '#6B7280',
        letterSpacing: 0.5,
        textTransform: 'uppercase',
        marginBottom: 4,
      },
      header: {
        container: {
          marginBottom: 8,
        },
        row: {
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
        },
        brandRow: {
          flexDirection: 'row',
          alignItems: 'center',
          flexShrink: 1,
        },
        logo: {
          width: 18,
          height: 18,
          marginRight: 6,
          objectFit: 'contain',
        },
        companyName: {
          fontSize: 12,
          fontWeight: 700,
          color: '#111827',
        },
        companySub: {
          fontSize: 7,
          color: '#6B7280',
          marginTop: 1,
        },
        // Compact meta card — padding 4-6 (NOT the A4 card's 16) and a
        // subtle hairline border, so it stays inside the 227pt width.
        metaCard: {
          backgroundColor: '#F9FAFB',
          border: '1 solid #E5E7EB',
          borderRadius: 6,
          paddingVertical: 4,
          paddingHorizontal: 6,
          alignItems: 'flex-end',
          flexShrink: 0,
          marginLeft: 6,
        },
        metaTitle: {
          fontSize: 6.5,
          fontWeight: 600,
          color: '#6B7280',
          letterSpacing: 0.5,
          textTransform: 'uppercase',
        },
        metaFolio: {
          fontSize: 7.5,
          fontWeight: 700,
          color: '#111827',
          marginTop: 2,
        },
        metaDate: {
          fontSize: 6.5,
          color: '#6B7280',
          marginTop: 1,
        },
      },
      operator: {
        row: {
          flexDirection: 'row',
          marginBottom: 6,
        },
        field: {
          flexDirection: 'row',
          alignItems: 'baseline',
          marginRight: 10,
          flexShrink: 1,
        },
        label: {
          fontSize: 6.5,
          fontWeight: 600,
          color: '#6B7280',
          letterSpacing: 0.5,
          textTransform: 'uppercase',
          marginRight: 3,
        },
        value: {
          fontSize: 7.5,
          fontWeight: 600,
          color: '#111827',
        },
      },
      customer: {
        block: {
          marginBottom: 8,
        },
        row: {
          flexDirection: 'row',
          alignItems: 'baseline',
        },
        label: {
          fontSize: 6.5,
          fontWeight: 600,
          color: '#6B7280',
          letterSpacing: 0.5,
          textTransform: 'uppercase',
          marginRight: 4,
        },
        value: {
          fontSize: 8,
          fontWeight: 600,
          color: '#111827',
        },
      },
      items: {
        block: {
          marginBottom: 8,
        },
        row: {
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: 6,
        },
        productName: {
          fontSize: 8,
          fontWeight: 600,
          color: '#111827',
        },
        productVariant: {
          fontSize: 6.5,
          color: '#6B7280',
          marginTop: 1,
        },
        qtyLine: {
          fontSize: 6.5,
          color: '#6B7280',
          textAlign: 'right',
        },
        lineTotal: {
          fontSize: 8,
          fontWeight: 700,
          color: '#111827',
          textAlign: 'right',
          marginTop: 1,
        },
        empty: {
          fontSize: 8,
          color: '#6B7280',
          fontStyle: 'italic',
          marginTop: 2,
        },
      },
      totals: {
        block: {
          marginBottom: 8,
        },
        row: {
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 4,
        },
        label: {
          fontSize: 8,
          color: '#6B7280',
        },
        value: {
          fontSize: 8,
          fontWeight: 600,
          color: '#111827',
          textAlign: 'right',
        },
        divider: {
          borderBottomWidth: 1,
          borderBottomColor: '#E5E7EB',
          borderBottomStyle: 'solid',
          marginVertical: 6,
        },
        // Grand total — no card fill on the ticket (it would eat the
        // narrow width); the blue bold value is the focal point.
        totalRow: {
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
        },
        totalLabel: {
          fontSize: 9,
          fontWeight: 700,
          color: '#374151',
        },
        totalValue: {
          fontSize: 15,
          fontWeight: 800,
          color: '#2563EB',
          textAlign: 'right',
        },
      },
      payments: {
        block: {
          marginBottom: 4,
        },
        row: {
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: 5,
        },
        method: {
          fontSize: 8,
          fontWeight: 600,
          color: '#111827',
        },
        reference: {
          fontSize: 6.5,
          color: '#6B7280',
          marginTop: 1,
        },
        timestamp: {
          fontSize: 6.5,
          color: '#9CA3AF',
          marginTop: 1,
        },
        amount: {
          fontSize: 8.5,
          fontWeight: 700,
          color: '#111827',
          textAlign: 'right',
        },
        empty: {
          fontSize: 8,
          color: '#6B7280',
          fontStyle: 'italic',
          marginTop: 2,
        },
      },
      footer: {
        thanks: {
          fontSize: 9,
          fontWeight: 600,
          color: '#111827',
          textAlign: 'center',
          marginTop: 8,
          marginBottom: 3,
        },
        disclaimer: {
          fontSize: 6.5,
          color: '#6B7280',
          textAlign: 'center',
        },
      },
    },
  },
} as const;
