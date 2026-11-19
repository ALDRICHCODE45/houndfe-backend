/**
 * QuotationA4Document — A4 PDF template for the `quotation-a4` format key.
 *
 * pdf-a4-redesign T4: rebuilt on the shared A4 kit («libro mayor» artboard,
 * page «Cotización» of design/pdf-a4-redesign/01-libro-mayor.html). One
 * wrapping page with natural pagination and the kit's fixed footer
 * («Página X de Y» through react-pdf's `render` prop).
 *
 * Visible contract (every field the legacy layout printed is kept):
 *   - Header: «Cotización» kicker + folio (the quotation id the caller
 *     passes) + the business logo when `business.logoUrl` is set.
 *   - Meta bar: «Fecha», «Vendedor» (only when a seller is known) and
 *     «Válido hasta» (only when an expiry was set).
 *   - Cliente: name («Público en General» when absent) and email.
 *   - Productos: ledger table — product name + variant, `qty × unit`, and
 *     the line amount (discount lines stay folded into the amount).
 *   - Totals: Subtotal / Descuentos / IVA incluido (only when the aggregate
 *     is known — a known zero still renders) and the accent «Total».
 *   - Closing: expiry line («Válido hasta: …» / «Sin fecha de expiración»),
 *     «Gracias por confiar en HoundFe» and the fiscal disclaimer.
 *
 * Palette (L5): the single accent (#173968) is only used by the kit for
 * titles and «Total»; discounts print as «-$X» in ink — never red.
 *
 * Spec coverage:
 *   - `quotations/send-and-pdf/spec.md` PDF Preview for Quotation.
 *   - `pdf-generation/delta.md` Quotation-A4 Format Registration.
 */
import { Document, Image, StyleSheet, Text, View } from '@react-pdf/renderer';
import {
  A4_COLORS,
  A4_FONTS,
  A4_STYLES,
  A4MetaBar,
  A4Page,
  A4PageHeader,
  A4Section,
  A4TotalsBlock,
  LedgerTable,
  px,
  type A4MetaBarItem,
  type A4TotalsLine,
  type LedgerColumn,
  type LedgerRowData,
} from '../shared/a4-kit';
import type { LineItem } from '../shared';

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
    /**
     * WU3 (T3.1) — aggregate IVA amount included in the grand total.
     * Derived from the sum of `ivaBreakdown[].amountCents` only when
     * `items.length > 0` AND `ivaBreakdown.length > 0`; `null` when
     * the snapshot is incomplete (empty items or empty breakdown).
     * Known zero (e.g. all ZERO_RATED_0 lines) renders as monetary
     * zero — the row IS shown. `null` means no row at all.
     */
    includedIvaCents: number | null;
  };
}

const SUBTITLE = 'Punto de Venta';

const ITEM_COLUMNS: readonly LedgerColumn[] = [
  { key: 'description', label: 'Descripción', flex: 5 },
  { key: 'qty', label: 'Cantidad × precio', flex: 2.4, align: 'right' },
  { key: 'amount', label: 'Importe', flex: 2, align: 'right' },
];

export function QuotationA4Document({
  business,
  quotation,
  customer,
  seller,
  items,
  totals,
}: QuotationDocumentProps) {
  const folio = `Folio #${quotation.id}`;

  return (
    <Document
      title={`Cotización ${quotation.id}`}
      author="HoundFe"
      creator="HoundFe"
      producer="HoundFe"
    >
      <A4Page
        footerLabel={`Cotización ${quotation.id}`}
        continuation={{
          kicker: 'Cotización',
          folio,
          brandSubtitle: SUBTITLE,
        }}
      >
        <QuotationHeader logoUrl={business.logoUrl} folio={folio} />
        <A4MetaBar
          items={metaItems(quotation.date, seller, quotation.expiresAt)}
        />
        <CustomerSection customer={customer} />
        <ItemsSection items={items} />
        <Totals {...totals} />
        <Closing expiresAt={quotation.expiresAt} />
      </A4Page>
    </Document>
  );
}

/**
 * Page header. The kit header only draws the «Logo» placeholder box; when the
 * business has a logo we keep printing it (legacy field) in that same box,
 * reusing the kit styles. Without a logo the stock kit header is used.
 */
function QuotationHeader({
  logoUrl,
  folio,
}: {
  logoUrl?: string;
  folio: string;
}) {
  if (!logoUrl) {
    return (
      <A4PageHeader subtitle={SUBTITLE} kicker="Cotización" folio={folio} />
    );
  }
  return (
    <View>
      <View style={A4_STYLES.header}>
        <View style={A4_STYLES.brand}>
          <View style={styles.logoFrame}>
            <Image src={logoUrl} style={styles.logoImage} cache={false} />
          </View>
          <View>
            <Text style={A4_STYLES.brandName}>HoundFe</Text>
            <Text style={A4_STYLES.brandSub}>{SUBTITLE}</Text>
          </View>
        </View>
        <View style={A4_STYLES.docMeta}>
          <Text style={A4_STYLES.kicker}>Cotización</Text>
          <Text style={A4_STYLES.folio}>{folio}</Text>
        </View>
      </View>
    </View>
  );
}

function metaItems(
  date: string,
  seller: { name: string } | null,
  expiresAt: string | null,
): A4MetaBarItem[] {
  const items: A4MetaBarItem[] = [{ label: 'Fecha', value: formatDate(date) }];
  if (seller?.name) {
    items.push({ label: 'Vendedor', value: seller.name });
  }
  if (expiresAt) {
    items.push({ label: 'Válido hasta', value: formatDate(expiresAt) });
  }
  return items;
}

/** Cliente — name («Público en General» when absent) and email when present. */
function CustomerSection({
  customer,
}: {
  customer: { name: string | null; email: string | null };
}) {
  return (
    <A4Section title="Cliente">
      <View style={styles.party} wrap={false}>
        <View style={styles.partyColumn}>
          <Text style={styles.partyName}>
            {customer.name ?? 'Público en General'}
          </Text>
        </View>
        <View style={styles.partyColumnLast}>
          {customer.email ? (
            <Text style={styles.partyEmail}>{customer.email}</Text>
          ) : null}
        </View>
      </View>
    </A4Section>
  );
}

/** Productos — ledger table; header repeats when the table spans pages. */
function ItemsSection({ items }: { items: LineItem[] }) {
  const rows: LedgerRowData[] = items.map((item, index) => ({
    key: `${item.productName}-${index}`,
    cells: {
      description: {
        text: item.productName,
        bold: true,
        sub: item.variantName ?? undefined,
      },
      qty: `${formatQuantity(item.quantity)} × ${formatCurrency(item.unitPriceCents)}`,
      amount: { text: formatCurrency(item.subtotalCents), bold: true },
    },
  }));

  return (
    <A4Section title="Productos">
      <LedgerTable columns={ITEM_COLUMNS} rows={rows} emptyText="---" />
    </A4Section>
  );
}

/**
 * Totals — Subtotal / Descuentos as ink lines and the accent «Total».
 *
 * WU3 (T3.1): one `IVA incluido` aggregate line appears when
 * `includedIvaCents` is not `null`. The row displays the monetary zero when
 * the aggregate is exactly 0 (e.g. all ZERO_RATED_0 lines). The condition
 * uses strict `!== null` — a naive truthy check would suppress the zero row.
 * No per-line or per-classification IVA rows.
 */
function Totals({
  subtotalCents,
  discountCents,
  totalCents,
  includedIvaCents,
}: QuotationDocumentProps['totals']) {
  const lines: A4TotalsLine[] = [
    { label: 'Subtotal', value: formatCurrency(subtotalCents) },
    {
      label: 'Descuentos',
      value:
        discountCents > 0
          ? `-${formatCurrency(discountCents)}`
          : formatCurrency(discountCents),
    },
  ];
  if (includedIvaCents !== null) {
    lines.push({
      label: 'IVA incluido',
      value: formatCurrency(includedIvaCents),
    });
  }
  return (
    <A4TotalsBlock
      lines={lines}
      total={{ value: formatCurrency(totalCents) }}
    />
  );
}

/** Closing — expiry line, thank-you line and the fiscal disclaimer. */
function Closing({ expiresAt }: { expiresAt: string | null }) {
  return (
    <View style={styles.closing} wrap={false}>
      <Text style={styles.closingStrong}>
        {expiresAt
          ? `Válido hasta: ${formatDate(expiresAt)}`
          : 'Sin fecha de expiración'}
      </Text>
      <Text>Gracias por confiar en HoundFe</Text>
      <Text>Este comprobante no constituye una factura fiscal.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  logoFrame: {
    width: px(36),
    height: px(36),
    borderWidth: px(1.5),
    borderColor: A4_COLORS.strong,
    borderStyle: 'solid',
    marginRight: px(12),
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoImage: { width: px(30), height: px(30), objectFit: 'contain' },
  party: { flexDirection: 'row', marginTop: px(2) },
  partyColumn: {
    flex: 1,
    paddingRight: px(22),
    paddingVertical: px(6),
    borderBottomWidth: px(1),
    borderBottomColor: A4_COLORS.border,
    borderBottomStyle: 'solid',
  },
  partyColumnLast: {
    flex: 1,
    paddingVertical: px(7),
    borderBottomWidth: px(1),
    borderBottomColor: A4_COLORS.border,
    borderBottomStyle: 'solid',
  },
  partyName: {
    fontFamily: A4_FONTS.bold,
    fontSize: px(14),
    color: A4_COLORS.ink,
  },
  partyEmail: { fontSize: px(12.5), color: A4_COLORS.ink },
  closing: {
    marginTop: px(34),
    alignItems: 'center',
    fontSize: px(11),
    lineHeight: 1.5,
    color: A4_COLORS.muted,
  },
  closingStrong: { fontFamily: A4_FONTS.bold, color: A4_COLORS.ink },
});

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
 * Format an ISO timestamp as a short Spanish date, e.g. `06 ago 2026`.
 *
 * Rendered in UTC so a quote date never shifts by the server's time zone
 * (an expiry set to midnight UTC would otherwise display as the previous
 * day in UTC-negative zones). Falls back to the raw input when unparseable.
 */
function formatDate(iso: string): string {
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
      .toLowerCase();
  } catch {
    // Older Node builds without full ICU data fall back to ISO date.
    return date.toISOString().slice(0, 10);
  }
}
