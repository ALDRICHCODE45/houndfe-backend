/**
 * CollectionReceiptTicketDocument — 80 mm thermal «Comprobante de cobro» of
 * one «Cobrar todo» (customer-collection T3 / S5; contract v1 §7, owner Q5).
 *
 * Built from the receipt ticket kit (same 1-bit «libro compacto» look as the
 * sale ticket): brand + COBRO + folio · COMPROBANTE DE COBRO · Sucursal ·
 * Fecha · Cajero · Cliente · Ventas (folio, abono; remaining debt after the
 * collection, «CANCELADA» when cancelled since) · TOTAL abonado · Pagos
 * (catalog name or method label, subtitle) · Recibido · Cambio · customer's
 * remaining debt (boxed when > 0) · closing note.
 *
 * HEIGHT: width-only page like the sale ticket — react-pdf derives the height
 * from the content, so any number of sales stays on ONE continuous page.
 */
import { Document, Page, Text, View } from '@react-pdf/renderer';
import { PAPER_SIZES } from '../../pdf-generation.constants';
import { formatA4DateTime, formatA4Money, px } from '../shared/a4-kit';
import {
  resolveTicketBrandName,
  softBreakLongTokens,
  TICKET_STYLES,
  TicketDebtBox,
  TicketEmptyRow,
  TicketFooter,
  TicketGrandTotal,
  TicketHeader,
  TicketPayment,
  TicketSectionHead,
  TicketSummaryRow,
} from '../receipt/ticket-kit';
import type {
  CollectionReceiptProps,
  CollectionReceiptSaleLine,
} from './collection-receipt.types';

const CUSTOMER_DEBT_LABEL = 'Deuda del cliente';
const CUSTOMER_DEBT_NOTE = 'Saldo pendiente del cliente';
const UNKNOWN_DEBT = 'No disponible';

/**
 * Label / value row with the kit styles, but the value takes the REMAINING
 * width (`flexBasis: 0`) so a long branch, cashier or customer name wraps
 * inside the paper. The kit's `TicketKeyValue` lets such a value push past
 * the right edge (seen in the real render), so it is not used here.
 */
function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <View style={TICKET_STYLES.kvRow} wrap={false}>
      <Text style={TICKET_STYLES.kvLabel}>{label}</Text>
      <Text
        style={[
          TICKET_STYLES.kvValue,
          { flexGrow: 1, flexShrink: 1, flexBasis: 0 },
        ]}
      >
        {softBreakLongTokens(value)}
      </Text>
    </View>
  );
}

function TicketSaleLine({
  folio,
  appliedCents,
  debtAfterCents,
  canceled,
}: CollectionReceiptSaleLine) {
  const detail = `${canceled ? 'CANCELADA · ' : ''}Resta ${formatA4Money(
    debtAfterCents,
  )}`;
  return (
    <View style={TICKET_STYLES.item} wrap={false}>
      <View style={TICKET_STYLES.itemLine}>
        <Text style={[TICKET_STYLES.itemName, { flexShrink: 1 }]}>
          {softBreakLongTokens(folio)}
        </Text>
        <Text style={TICKET_STYLES.itemAmount}>
          {formatA4Money(appliedCents)}
        </Text>
      </View>
      <Text style={TICKET_STYLES.itemDetail}>{detail}</Text>
    </View>
  );
}

function CustomerDebt({ debtCents }: { debtCents: number | null }) {
  if (debtCents === null) {
    return (
      <TicketSummaryRow label={CUSTOMER_DEBT_LABEL} value={UNKNOWN_DEBT} />
    );
  }
  if (debtCents > 0) {
    return (
      <TicketDebtBox
        debtCents={debtCents}
        label={CUSTOMER_DEBT_LABEL}
        note={CUSTOMER_DEBT_NOTE}
      />
    );
  }
  return (
    <TicketSummaryRow
      label={CUSTOMER_DEBT_LABEL}
      value={formatA4Money(0)}
      bold
    />
  );
}

export function CollectionReceiptTicketDocument({
  brandName,
  branchName,
  folio,
  date,
  cashier,
  customerName,
  sales,
  tenders,
  tenderedCents,
  appliedCents,
  changeDueCents,
  remainingCustomerDebtCents,
}: CollectionReceiptProps) {
  return (
    <Document title={`Comprobante de cobro ${folio}`}>
      <Page
        // Width only: the height is derived from the content (see header).
        size={{ width: PAPER_SIZES.TICKET.width }}
        style={TICKET_STYLES.page}
        wrap={false}
      >
        <View>
          <TicketHeader
            brandName={resolveTicketBrandName(brandName)}
            folio={folio}
            docKind="COBRO"
          />
          <Text style={[TICKET_STYLES.endThanks, { marginVertical: px(6) }]}>
            COMPROBANTE DE COBRO
          </Text>
          <KeyValue label="SUCURSAL" value={branchName} />
          <KeyValue label="FECHA" value={formatA4DateTime(date)} />
          <KeyValue label="CAJERO" value={cashier} />
          <KeyValue label="CLIENTE" value={customerName} />

          <TicketSectionHead left="VENTA" right="ABONO" />
          {sales.length === 0 ? (
            <TicketEmptyRow>---</TicketEmptyRow>
          ) : (
            sales.map((sale, index) => (
              <TicketSaleLine key={`${sale.folio}-${index}`} {...sale} />
            ))
          )}
          <TicketGrandTotal totalCents={appliedCents} />

          <TicketSectionHead left="PAGOS" right="MONTO" />
          {tenders.map((tender, index) => (
            <TicketPayment
              key={`${tender.label}-${index}`}
              method={tender.label}
              paymentMethodName={tender.label}
              paymentMethodSubtitle={tender.subtitle}
              amountCents={tender.amountCents}
            />
          ))}
          <TicketSummaryRow
            label="Recibido"
            value={formatA4Money(tenderedCents)}
          />
          {changeDueCents > 0 ? (
            <TicketSummaryRow
              label="Cambio"
              value={formatA4Money(changeDueCents)}
              bold
            />
          ) : null}
          <CustomerDebt debtCents={remainingCustomerDebtCents} />

          <TicketFooter thanks="Gracias por su pago." />
        </View>
      </Page>
    </Document>
  );
}
