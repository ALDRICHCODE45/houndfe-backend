/**
 * QuotationA4Document — A4 PDF template for the `quotation-a4` format key.
 *
 * Mirrors `ReceiptA4Document` (the `receipt-a4` template) on the
 * `<Document>`/`<Page>`/`<View>` shell and on the shared style tokens
 * (`SHARED_STYLES`). The visible contract is intentionally narrower:
 *
 *   - The header title is "COTIZACIÓN" (not "RECIBO").
 *   - The folio block carries the quotation id + creation date (no
 *     register, no cashier, no seller — quotations are pre-sale documents
 *     and don't reference a POS register or cashier).
 *   - The customer section shows the assigned customer's name AND email
 *     (the email is needed because the PDF travels alongside the email
 *     send — a recipient viewing the PDF wants the address visible).
 *   - The line-items table is shared with the receipt via `LineItemsTable`.
 *   - The totals block is bespoke (`QuotationTotalsBlock` below) — it
 *     carries only subtotal/discount/total and explicitly omits the
 *     payment/cambio rows that the receipt's `TotalsBlock` prints.
 *   - The footer prints the expiry date as "Válido hasta: ..." or
 *     "Sin fecha de expiración" when `expiresAt` is null.
 *
 * Spec coverage:
 *   - `quotations/send-and-pdf/spec.md` PDF Preview for Quotation
 *     (header, items table, totals, expiry footer; no payment/cambio).
 *   - `pdf-generation/delta.md` Quotation-A4 Format Registration
 *     (template renders "COTIZACIÓN"; footer has no payment lines).
 */
import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import { PAPER_SIZES } from '../../pdf-generation.constants';
import {
  CustomerSection,
  LineItemsTable,
  ReceiptHeader,
  SHARED_STYLES,
  type LineItem,
} from '../shared';

/**
 * View-model for the Quotation A4 template. Mirrors `ReceiptDocumentProps`
 * minus the payment surface, plus a `customer.email` field the receipt
 * doesn't carry.
 */
export interface QuotationDocumentProps {
  business: {
    logoUrl?: string;
    companyName: string;
    address?: string;
    phone?: string;
  };
  quotation: {
    id: string;
    /** Date the quotation was created (ISO string). */
    date: string;
    /** Optional expiry date the cashier set on the draft (ISO string). */
    expiresAt: string | null;
  };
  customer: {
    name: string | null;
    email: string | null;
  };
  items: LineItem[];
  totals: {
    subtotalCents: number;
    discountCents: number;
    totalCents: number;
  };
}

export function QuotationA4Document({
  business,
  quotation,
  customer,
  items,
  totals,
}: QuotationDocumentProps) {
  return (
    <Document title={`Cotización ${quotation.id}`}>
      <Page
        size={{ width: PAPER_SIZES.A4.width, height: PAPER_SIZES.A4.height }}
        style={styles.page}
      >
        <View>
          {/* Brand accent bar — same primary brand element as the receipt. */}
          <View style={SHARED_STYLES.receipt.brandAccentBar} />

          <ReceiptHeader
            {...business}
            folio={quotation.id}
            date={quotation.date}
            subtitle="PUNTO DE VENTA"
          />

          <View style={styles.customer}>
            <CustomerSection customerName={customer.name} />
            {/* Email row — only when the customer has an email address. */}
            {customer.email ? (
              <View style={styles.customerEmailRow}>
                <Text style={SHARED_STYLES.customer.label}>EMAIL</Text>
                <Text style={SHARED_STYLES.customer.value}>
                  {customer.email}
                </Text>
              </View>
            ) : null}
          </View>

          <LineItemsTable items={items} variant="a4" />

          <QuotationTotalsBlock {...totals} />

          {/* Footer — expiry date line + closing. */}
          <Text style={styles.expiryLine}>
            {quotation.expiresAt
              ? `Válido hasta: ${formatExpiry(quotation.expiresAt)}`
              : 'Sin fecha de expiración'}
          </Text>

          <Text style={SHARED_STYLES.receipt.footer}>
            Gracias por su preferencia.
          </Text>
        </View>
      </Page>
    </Document>
  );
}

/**
 * Quotation-specific totals block.
 *
 * Carries only the three rows that make sense on a quotation:
 *   1. Subtotal   — pre-discount sum.
 *   2. Descuentos — total discounts (positive cents, prefixed "-").
 *   3. Total      — post-discount grand total (brand yellow).
 *
 * The receipt's `TotalsBlock` also renders Pagado / Deuda / Cambio —
 * those rows are explicitly omitted because a quotation is a pricing
 * promise, not a paid transaction.
 */
function QuotationTotalsBlock({
  subtotalCents,
  discountCents,
  totalCents,
}: {
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
}) {
  return (
    <View>
      <Text style={SHARED_STYLES.receipt.sectionHeader}>TOTALES</Text>
      <View style={SHARED_STYLES.totals.row}>
        <Text style={SHARED_STYLES.totals.label}>Subtotal</Text>
        <Text style={SHARED_STYLES.totals.value}>
          {formatCurrency(subtotalCents)}
        </Text>
      </View>
      <View style={SHARED_STYLES.totals.row}>
        <Text style={SHARED_STYLES.totals.label}>Descuentos</Text>
        <Text style={SHARED_STYLES.totals.value}>
          {discountCents > 0
            ? `-${formatCurrency(discountCents)}`
            : formatCurrency(discountCents)}
        </Text>
      </View>
      <View style={SHARED_STYLES.totals.grandTotalRow}>
        <Text style={SHARED_STYLES.totals.grandTotalLabel}>Total</Text>
        <Text style={SHARED_STYLES.totals.grandTotalValue}>
          {formatCurrency(totalCents)}
        </Text>
      </View>
    </View>
  );
}

/**
 * Format an ISO date string as a Spanish short date (`DD/MM/YYYY`).
 * Falls back to the raw input if `Date` parsing fails (defensive — the
 * source is the quotation's `createdAt`/`expiresAt`, both guaranteed
 * Date instances by the entity layer, but we never want a render crash
 * from a malformed wire value).
 */
function formatExpiry(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${d.getUTCFullYear()}`;
}

/**
 * Format cents as a fixed-decimal currency string. Mirrors the helper
 * in `line-items-table.tsx` — duplicated here (not exported from the
 * shared module) because `LineItemsTable`'s helper is intentionally
 * scoped to that file and the `QuotationTotalsBlock` is a self-
 * contained component that doesn't share the receipt's full payment
 * surface. If a third caller appears we should hoist this into the
 * shared utilities; right now T062's refactor check confirms no
 * layout/typography constants leak between the PDF and email
 * templates.
 */
function formatCurrency(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents) / 100;
  return `${sign}$${abs.toFixed(2)}`;
}

const styles = StyleSheet.create({
  page: {
    padding: 28,
    color: '#2c2434',
    fontFamily: 'Helvetica',
    fontSize: 10,
  },
  customer: {
    marginTop: 8,
  },
  customerEmailRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    paddingVertical: 2,
  },
  expiryLine: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 9,
    color: '#493f54',
    textAlign: 'center',
    marginTop: 14,
    letterSpacing: 0.4,
  },
});
