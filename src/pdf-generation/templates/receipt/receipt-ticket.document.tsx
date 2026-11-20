/**
 * ReceiptTicketDocument — 80 mm thermal ticket PDF template for the
 * `receipt-ticket` format key (pdf-ticket-redesign T2, S1-S3).
 *
 * Spec artboard: design/pdf-ticket-redesign/01-libro-compacto.html («libro
 * compacto», the thermal twin of the A4 ledger) plus the framed Deuda box of
 * 02-clasico-centrado.html (owner choice). 1-bit friendly: only #000 on #fff,
 * Helvetica / Helvetica-Bold, text wordmark instead of the image logo.
 *
 * Section order (every field the previous ticket printed is kept):
 * brand + RECIBO + folio · Fecha · Cajero · Vendedor · Cliente · Productos
 * (names wrap; variant · qty × price; per-line promo) · Subtotal ·
 * Descuentos · Envío · Pagado · Deuda (boxed) · Cambio · TOTAL · Pagos ·
 * closing note.
 *
 * HEIGHT: the page is declared with a WIDTH ONLY (227 pt). react-pdf 4.5
 * resolves the page height from the laid-out content (single page, exact fit),
 * so wrapped names, promo lines, payments and the debt box can never be clipped
 * or spill onto a second page — there is no height estimate to keep in sync.
 * (Proved with a real render in the T2 probe: 3 / 12 / 40 items → 1 page.)
 */
import { Document, Page, View } from '@react-pdf/renderer';
import { PAPER_SIZES } from '../../pdf-generation.constants';
import { formatA4DateTime, formatA4Money } from '../shared/a4-kit';
import {
  resolveTicketBrandName,
  TICKET_STYLES,
  TicketDebtBox,
  TicketEmptyRow,
  TicketFooter,
  TicketGrandTotal,
  TicketHeader,
  TicketItem,
  TicketKeyValue,
  TicketPayment,
  TicketSectionHead,
  TicketSummaryRow,
} from './ticket-kit';
import type { ReceiptDocumentProps } from './receipt.types';

/** Customer placeholder for sales without an assigned customer. */
const PUBLIC_CUSTOMER = 'Público en General';

export function ReceiptTicketDocument({
  business,
  sale,
  customer,
  items,
  totals,
  payments,
}: ReceiptDocumentProps) {
  const customerName = customer.name?.trim() ? customer.name : PUBLIC_CUSTOMER;
  const shipping = totals.shippingChargeCents ?? 0;

  return (
    <Document title={`Ticket ${sale.folio}`}>
      <Page
        // Width only: the height is derived from the content (see header).
        size={{ width: PAPER_SIZES.TICKET.width }}
        style={TICKET_STYLES.page}
        wrap={false}
      >
        <View>
          <TicketHeader
            brandName={resolveTicketBrandName(business.companyName)}
            folio={sale.folio}
          />
          <TicketKeyValue label="FECHA" value={formatA4DateTime(sale.date)} />
          <TicketKeyValue label="CAJERO" value={sale.cashier} />
          <TicketKeyValue label="VENDEDOR" value={sale.seller} />
          <TicketKeyValue label="CLIENTE" value={customerName} />

          <TicketSectionHead left="PRODUCTO" right="IMPORTE" />
          {items.length === 0 ? (
            <TicketEmptyRow>---</TicketEmptyRow>
          ) : (
            items.map((item, index) => (
              <TicketItem key={`${item.productName}-${index}`} {...item} />
            ))
          )}

          <TicketSummaryRow
            label="Subtotal"
            value={formatA4Money(totals.subtotalCents)}
          />
          <TicketSummaryRow
            label="Descuentos"
            value={formatA4Money(
              totals.discountCents > 0
                ? -totals.discountCents
                : totals.discountCents,
            )}
          />
          {shipping > 0 ? (
            <TicketSummaryRow label="Envío" value={formatA4Money(shipping)} />
          ) : null}
          {totals.paidCents > 0 ? (
            <TicketSummaryRow
              label="Pagado"
              value={formatA4Money(totals.paidCents)}
            />
          ) : null}
          {totals.debtCents > 0 ? (
            <TicketDebtBox debtCents={totals.debtCents} />
          ) : null}
          {totals.changeDueCents > 0 ? (
            <TicketSummaryRow
              label="Cambio"
              value={formatA4Money(totals.changeDueCents)}
              bold
            />
          ) : null}
          <TicketGrandTotal totalCents={totals.totalCents} />

          <TicketSectionHead left="PAGOS" right="MONTO" />
          {payments.length === 0 ? (
            <TicketEmptyRow>Sin pagos registrados.</TicketEmptyRow>
          ) : (
            payments.map((payment, index) => (
              <TicketPayment key={`${payment.method}-${index}`} {...payment} />
            ))
          )}

          <TicketFooter />
        </View>
      </Page>
    </Document>
  );
}
