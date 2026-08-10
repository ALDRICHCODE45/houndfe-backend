/**
 * ReceiptTicketDocument — 80mm thermal ticket PDF template for the
 * `receipt-ticket` format key.
 *
 * Compact twin of the modern A4 receipt. Same palette (ink #111827,
 * grays, blue #2563EB on the total), same Inter family, same visual
 * language — but a reduced spacing scale (4/6/8/12) so everything fits
 * the 227pt page width.
 *
 * RULE OF GOLD: the ticket does NOT copy the A4 cards (padding 16) —
 * they do not fit 227pt. The header meta block uses a compact card with
 * padding 4-6 and a subtle hairline border; every other section is
 * vertical rhythm with no card fills.
 *
 * The page uses `wrap={false}` with a height computed by
 * `getTicketHeight()` — the height MUST cover every section or content
 * is clipped. The formula below mirrors the compact vertical rhythm:
 * shell (header + operator + customer + totals + footer + gaps) plus a
 * per-item and per-payment allowance.
 */
import { Document, Page, Text, View } from '@react-pdf/renderer';
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

export function ReceiptTicketDocument({
  business,
  sale,
  customer,
  items,
  totals,
  payments,
}: ReceiptDocumentProps) {
  const height = getTicketHeight(items.length, payments.length);

  return (
    <Document title={`Ticket ${sale.folio}`}>
      <Page
        size={{ width: PAPER_SIZES.TICKET.width, height }}
        style={[
          SHARED_STYLES.modern.ticket.page,
          // Runtime font family — cascades to every Text on the page.
          { fontFamily: getModernFontFamily() },
        ]}
        wrap={false}
      >
        <View>
          <ReceiptHeader
            companyName={business.companyName}
            folio={sale.folio}
            date={sale.date}
            title="RECIBO"
            variant="ticket"
          />

          <OperatorMeta cashier={sale.cashier} seller={sale.seller} />

          <CustomerSection customerName={customer.name} variant="ticket" />

          <LineItemsTable items={items} variant="ticket" />

          <TotalsBlock {...totals} variant="ticket" />

          <PaymentsList payments={payments} variant="ticket" />

          <ReceiptFooter />
        </View>
      </Page>
    </Document>
  );
}

/**
 * Operator meta — CAJERO / VENDEDOR in one compact row (tiny gray
 * labels + ink values), reusing the ticket operator tokens.
 */
function OperatorMeta({
  cashier,
  seller,
}: {
  cashier: string;
  seller: string;
}) {
  return (
    <View style={SHARED_STYLES.modern.ticket.operator.row}>
      <View style={SHARED_STYLES.modern.ticket.operator.field}>
        <Text style={SHARED_STYLES.modern.ticket.operator.label}>CAJERO</Text>
        <Text style={SHARED_STYLES.modern.ticket.operator.value}>
          {cashier}
        </Text>
      </View>
      <View style={SHARED_STYLES.modern.ticket.operator.field}>
        <Text style={SHARED_STYLES.modern.ticket.operator.label}>VENDEDOR</Text>
        <Text style={SHARED_STYLES.modern.ticket.operator.value}>{seller}</Text>
      </View>
    </View>
  );
}

/**
 * Ticket footer — compact thank-you line + fiscal disclaimer in small
 * gray type.
 */
function ReceiptFooter() {
  return (
    <View>
      <Text style={SHARED_STYLES.modern.ticket.footer.thanks}>
        Gracias por su compra.
      </Text>
      <Text style={SHARED_STYLES.modern.ticket.footer.disclaimer}>
        Este comprobante no constituye una factura fiscal.
      </Text>
    </View>
  );
}

/**
 * Compute the ticket page height from content length.
 *
 * The ticket renders with `wrap={false}` (thermal rolls cannot paginate)
 * so this number MUST be large enough to fit every section. The formula
 * is a deliberate over-estimate of the compact vertical rhythm:
 *
 *   shellHeight = fixed sections (header + operator + customer + items
 *     eyebrow + totals + payments eyebrow + footer) + section gaps +
 *     page padding. Generous so multi-line items (name wraps) stay inside.
 *   lineItemsHeight = per-item allowance (name line + optional variant
 *     line + row margin).
 *   paymentsHeight = per-payment allowance (method line + optional
 *     reference/timestamp lines + row margin).
 *
 * A floor keeps minimal receipts from looking absurdly short.
 */
function getTicketHeight(itemCount: number, paymentCount: number): number {
  const shellHeight = 280;
  const lineItemsHeight = itemCount * 24;
  const paymentsHeight = paymentCount * 26;

  return Math.max(480, shellHeight + lineItemsHeight + paymentsHeight);
}
