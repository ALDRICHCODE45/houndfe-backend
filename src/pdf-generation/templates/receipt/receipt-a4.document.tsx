/**
 * ReceiptA4Document — A4 PDF template for the `receipt-a4` format key.
 *
 * Redesigned with the modern Stripe/Shopify-style token set
 * (`SHARED_STYLES.modern`), matching the approved quotation-a4 pilot:
 *   - Header: brand (logo + "HoundFe" + "Punto de Venta") on the left,
 *     a light-gray meta card on the right with RECIBO / FOLIO / FECHA.
 *   - Operator meta: CAJERO / VENDEDOR as small gray uppercase labels
 *     next to ink values.
 *   - Customer card (#F9FAFB surface) with "Público en General" fallback.
 *   - Line items as line-less rows (name bold, variant gray, `qty × unit`
 *     + bold line total on the right).
 *   - Totals: Subtotal / Descuentos rows, a subtle divider, and the
 *     grand TOTAL on a highlighted card (18pt 800 blue #2563EB).
 *   - Payments: clean method + amount rows with reference/timestamp in
 *     gray.
 *   - Footer: "Gracias por su compra." + the fiscal disclaimer.
 *
 * The grand total already includes IVA in this system, so there is no
 * IVA row (mirrors the quotation contract).
 *
 * Font handling: the page binds to `getModernFontFamily()` so a font-CDN
 * outage degrades to Helvetica instead of failing the render (react-pdf
 * throws on unreachable font weights — see `templates/shared/modern-font.ts`).
 */
import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import { PAPER_SIZES } from '../../pdf-generation.constants';
import {
  CustomerSection,
  getModernFontFamily,
  LineItemsTable,
  PaymentsList,
  ReceiptHeader,
  SHARED_STYLES,
  TotalsBlock,
} from '../shared';
import type { ReceiptDocumentProps } from './receipt.types';

export function ReceiptA4Document({
  business,
  sale,
  customer,
  items,
  totals,
  payments,
}: ReceiptDocumentProps) {
  return (
    <Document title={`Recibo ${sale.folio}`}>
      <Page
        size={{ width: PAPER_SIZES.A4.width, height: PAPER_SIZES.A4.height }}
        style={[
          SHARED_STYLES.modern.page,
          // Runtime font family — cascades to every Text on the page.
          { fontFamily: getModernFontFamily() },
        ]}
      >
        <View>
          <ReceiptHeader
            logoUrl={business.logoUrl}
            companyName={business.companyName}
            folio={sale.folio}
            date={sale.date}
            title="RECIBO"
            variant="a4"
          />

          <OperatorMeta cashier={sale.cashier} seller={sale.seller} />

          <CustomerSection customerName={customer.name} variant="a4" />

          <LineItemsTable items={items} variant="a4" />

          <TotalsBlock {...totals} variant="a4" />

          <PaymentsList payments={payments} variant="a4" />

          <ReceiptFooter />
        </View>
      </Page>
    </Document>
  );
}

/**
 * Operator meta — CAJERO / VENDEDOR as small gray uppercase labels
 * next to ink values, laid out in one row.
 */
function OperatorMeta({
  cashier,
  seller,
}: {
  cashier: string;
  seller: string;
}) {
  return (
    <View style={styles.operatorRow}>
      <View style={styles.operatorField}>
        <Text style={SHARED_STYLES.modern.operator.label}>CAJERO</Text>
        <Text style={SHARED_STYLES.modern.operator.value}>{cashier}</Text>
      </View>
      <View style={styles.operatorField}>
        <Text style={SHARED_STYLES.modern.operator.label}>VENDEDOR</Text>
        <Text style={SHARED_STYLES.modern.operator.value}>{seller}</Text>
      </View>
    </View>
  );
}

/**
 * Receipt footer — thank-you line + the fiscal disclaimer in small gray
 * type. The quote template renders its own footer (expiry line + same
 * disclaimer); the shared `modern.footer` tokens serve both.
 */
function ReceiptFooter() {
  return (
    <View>
      <Text style={SHARED_STYLES.modern.footer.thanks}>
        Gracias por su compra.
      </Text>
      <Text style={SHARED_STYLES.modern.footer.disclaimer}>
        Este comprobante no constituye una factura fiscal.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  operatorRow: {
    flexDirection: 'row',
    gap: 28,
    marginBottom: 16,
  },
  operatorField: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'baseline',
  },
});
