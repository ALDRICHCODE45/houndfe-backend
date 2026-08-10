/**
 * QuotationA4Document — A4 PDF template for the `quotation-a4` format key.
 *
 * PILOT — redesigned with the modern Stripe/Shopify-style token set
 * (`SHARED_STYLES.modern`). The receipt templates (receipt-a4 / receipt-
 * ticket) are untouched and keep the legacy shared tokens; this template
 * is the only consumer of the `modern` namespace.
 *
 * Visible contract (unchanged from the legacy layout):
 *   - Header title "COTIZACIÓN" + folio (quotation id) + creation date.
 *   - Seller display name ("VENDEDOR …") in the header meta card.
 *   - Customer name AND email (the email travels with the PDF send).
 *   - Line items with product name + variant; discount lines are folded
 *     into the per-line quantity/unit subtotal (see `ItemsList`).
 *   - Totals: Subtotal / Descuentos rows + a highlighted grand TOTAL card
 *     (no IVA row — IVA is informational here, the total already includes it).
 *   - Footer: expiry line ("Válido hasta: …" / "Sin fecha de expiración"),
 *     "Gracias por confiar en HoundFe", and the fiscal disclaimer.
 *
 * Font handling: the page binds to `getModernFontFamily()` so a font-CDN
 * outage degrades to Helvetica instead of failing the render (react-pdf
 * throws on unreachable font weights — see `templates/shared/modern-font.ts`).
 *
 * Spec coverage:
 *   - `quotations/send-and-pdf/spec.md` PDF Preview for Quotation.
 *   - `pdf-generation/delta.md` Quotation-A4 Format Registration.
 */
import { Document, Image, Page, Text, View } from '@react-pdf/renderer';
import { PAPER_SIZES } from '../../pdf-generation.constants';
import {
  getModernFontFamily,
  SHARED_STYLES,
  type LineItem,
} from '../shared';

/**
 * View-model for the Quotation A4 template. Mirrors `ReceiptDocumentProps`
 * minus the payment surface, plus a `customer.email` field the receipt
 * doesn't carry. Deliberately unchanged from the legacy template so the
 * service-side prop mapping stays stable.
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
  /** Seller display name (the person who brought in the client). */
  seller: { name: string } | null;
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
  seller,
  items,
  totals,
}: QuotationDocumentProps) {
  return (
    <Document title={`Cotización ${quotation.id}`}>
      <Page
        size={{ width: PAPER_SIZES.A4.width, height: PAPER_SIZES.A4.height }}
        style={[
          SHARED_STYLES.modern.page,
          // Runtime font family — cascades to every Text on the page.
          { fontFamily: getModernFontFamily() },
        ]}
      >
        <View>
          <QuotationHeader
            logoUrl={business.logoUrl}
            companyName={business.companyName}
            folio={quotation.id}
            date={quotation.date}
            sellerName={seller?.name ?? null}
          />

          <CustomerCard customer={customer} />

          <ItemsList items={items} />

          <Totals {...totals} />

          <Footer expiresAt={quotation.expiresAt} />
        </View>
      </Page>
    </Document>
  );
}

/**
 * Header — brand block on the left (logo + company name + "Punto de Venta"),
 * and a light-gray meta card on the right carrying COTIZACIÓN / FOLIO / FECHA
 * / VENDEDOR.
 */
function QuotationHeader({
  logoUrl,
  companyName,
  folio,
  date,
  sellerName,
}: {
  logoUrl?: string;
  companyName: string;
  folio: string;
  date: string;
  sellerName: string | null;
}) {
  return (
    <View style={SHARED_STYLES.modern.header.row}>
      <View style={SHARED_STYLES.modern.header.brandRow}>
        {logoUrl ? (
          <Image
            src={logoUrl}
            style={SHARED_STYLES.modern.header.logo}
            cache={false}
          />
        ) : null}
        <View>
          <Text style={SHARED_STYLES.modern.header.companyName}>
            {companyName}
          </Text>
          <Text style={SHARED_STYLES.modern.header.companySub}>
            Punto de Venta
          </Text>
        </View>
      </View>

      <View style={SHARED_STYLES.modern.cardCompact}>
        <Text style={SHARED_STYLES.modern.header.metaTitle}>COTIZACIÓN</Text>
        <Text style={SHARED_STYLES.modern.header.metaFolio}>
          FOLIO #{folio}
        </Text>
        <Text style={SHARED_STYLES.modern.header.metaDate}>
          FECHA {formatDateEsMX(date)}
        </Text>
        {sellerName ? (
          <Text style={SHARED_STYLES.modern.header.metaDate}>
            VENDEDOR {sellerName}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * Customer card — light-gray surface with the "Cliente" eyebrow label, the
 * name (or "Público en General"), and the email when present.
 */
function CustomerCard({
  customer,
}: {
  customer: { name: string | null; email: string | null };
}) {
  return (
    <View
      style={[
        SHARED_STYLES.modern.card,
        SHARED_STYLES.modern.customer.block,
      ]}
    >
      <Text style={SHARED_STYLES.modern.eyebrow}>Cliente</Text>
      <Text style={SHARED_STYLES.modern.customer.name}>
        {customer.name ?? 'Público en General'}
      </Text>
      {customer.email ? (
        <Text style={SHARED_STYLES.modern.customer.email}>
          {customer.email}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Items list — one row per line item, separated by vertical rhythm instead
 * of table grid lines. Left: product name + variant. Right: `qty × unit`
 * and the bold line total.
 */
function ItemsList({ items }: { items: LineItem[] }) {
  return (
    <View style={SHARED_STYLES.modern.items.block}>
      <Text style={SHARED_STYLES.modern.eyebrow}>Productos</Text>

      {items.length === 0 ? (
        <Text style={SHARED_STYLES.modern.items.empty}>---</Text>
      ) : (
        items.map((item, index) => (
          <View
            key={`${item.productName}-${index}`}
            style={SHARED_STYLES.modern.items.row}
          >
            <View>
              <Text style={SHARED_STYLES.modern.items.productName}>
                {item.productName}
              </Text>
              {item.variantName ? (
                <Text style={SHARED_STYLES.modern.items.productVariant}>
                  {item.variantName}
                </Text>
              ) : null}
            </View>
            <View>
              <Text style={SHARED_STYLES.modern.items.qtyLine}>
                {formatQuantity(item.quantity)} ×{' '}
                {formatCurrency(item.unitPriceCents)}
              </Text>
              <Text style={SHARED_STYLES.modern.items.lineTotal}>
                {formatCurrency(item.subtotalCents)}
              </Text>
            </View>
          </View>
        ))
      )}
    </View>
  );
}

/**
 * Totals — Subtotal / Descuentos as plain rows, a subtle divider, then the
 * grand TOTAL on a highlighted card (the document's focal point, 24pt 800).
 * No IVA row: IVA is informational and already included in the total.
 */
function Totals({
  subtotalCents,
  discountCents,
  totalCents,
}: {
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
}) {
  return (
    <View style={SHARED_STYLES.modern.totals.block}>
      <View style={SHARED_STYLES.modern.totals.row}>
        <Text style={SHARED_STYLES.modern.totals.label}>Subtotal</Text>
        <Text style={SHARED_STYLES.modern.totals.value}>
          {formatCurrency(subtotalCents)}
        </Text>
      </View>
      <View style={SHARED_STYLES.modern.totals.row}>
        <Text style={SHARED_STYLES.modern.totals.label}>Descuentos</Text>
        <Text style={SHARED_STYLES.modern.totals.value}>
          {discountCents > 0
            ? `-${formatCurrency(discountCents)}`
            : formatCurrency(discountCents)}
        </Text>
      </View>

      <View style={SHARED_STYLES.modern.totals.divider} />

      <View style={SHARED_STYLES.modern.totals.totalCard}>
        <Text style={SHARED_STYLES.modern.totals.totalLabel}>TOTAL</Text>
        <Text style={SHARED_STYLES.modern.totals.totalValue}>
          {formatCurrency(totalCents)}
        </Text>
      </View>
    </View>
  );
}

/**
 * Footer — expiry line (when set), thank-you line, and the fiscal disclaimer
 * in small gray type.
 */
function Footer({ expiresAt }: { expiresAt: string | null }) {
  return (
    <View>
      <Text style={SHARED_STYLES.modern.footer.expiry}>
        {expiresAt
          ? `Válido hasta: ${formatDateEsMX(expiresAt)}`
          : 'Sin fecha de expiración'}
      </Text>
      <Text style={SHARED_STYLES.modern.footer.thanks}>
        Gracias por confiar en HoundFe
      </Text>
      <Text style={SHARED_STYLES.modern.footer.disclaimer}>
        Este comprobante no constituye una factura fiscal.
      </Text>
    </View>
  );
}

/**
 * Format cents as a fixed-decimal currency string. We avoid Intl.NumberFormat
 * for bit-stable output across Node ICU builds (receipts/quotes are docs).
 */
function formatCurrency(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents) / 100;
  return `${sign}$${abs.toFixed(2)}`;
}

/**
 * Render an integer quantity as a trimmed string; fractional quantities
 * (kg, meters) keep two decimals with trailing zeros removed.
 */
function formatQuantity(qty: number): string {
  if (Number.isInteger(qty)) {
    return qty.toString();
  }
  return qty.toFixed(2).replace(/\.?0+$/, '');
}

/**
 * Format an ISO timestamp as a short Spanish date, e.g. `06 AGO 2026`.
 *
 * Rendered in UTC so a quote date never shifts by the server's time zone
 * (an expiry set to midnight UTC would otherwise display as the previous
 * day in UTC-negative zones). Falls back to the raw input when unparseable.
 */
function formatDateEsMX(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  try {
    return new Intl.DateTimeFormat('es-MX', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    })
      .format(date)
      .replace(/\./g, '')
      .toUpperCase();
  } catch {
    // Older Node builds without full ICU data fall back to ISO date.
    return date.toISOString().slice(0, 10);
  }
}
