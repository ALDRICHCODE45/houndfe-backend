/**
 * Ticket kit — presentational blocks of the 80 mm thermal ticket
 * (spec artboard 01-libro-compacto + the debt box of 02-clasico-centrado).
 *
 * Pure presentation: every block receives already-resolved props and prints
 * black on white. Product names WRAP (no truncation); the page height is
 * auto (see `receipt-ticket.document.tsx`), so no block estimates sizes.
 */
import { Text, View } from '@react-pdf/renderer';
import { formatA4Money, formatA4Time } from '../../shared/a4-kit';
import {
  formatTicketMethod,
  formatTicketQuantity,
  softBreakLongTokens,
} from './ticket-format';
import { TICKET_STYLES } from './ticket-styles';

/** Brand name printed when the business does not provide one. */
export const TICKET_DEFAULT_BRAND_NAME = 'HoundFe';

/** Copy under the debt amount (artboard 02). */
export const TICKET_DEBT_NOTE = 'Saldo pendiente de pago';

export function resolveTicketBrandName(
  companyName: string | null | undefined,
): string {
  const trimmed = companyName?.trim();
  return trimmed ? trimmed : TICKET_DEFAULT_BRAND_NAME;
}

export function TicketHeader({
  brandName,
  folio,
  docKind = 'RECIBO',
}: {
  brandName: string;
  folio: string;
  /** Document kind over the folio (default «RECIBO»). */
  docKind?: string;
}) {
  return (
    <View style={TICKET_STYLES.header}>
      <View style={TICKET_STYLES.wordmarkBox}>
        <Text style={TICKET_STYLES.wordmark}>{brandName}</Text>
      </View>
      <View style={TICKET_STYLES.docBox}>
        <Text style={TICKET_STYLES.docKind}>{docKind}</Text>
        <Text style={TICKET_STYLES.docFolio}>{`FOLIO #${folio}`}</Text>
      </View>
    </View>
  );
}

export function TicketKeyValue({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <View style={TICKET_STYLES.kvRow} wrap={false}>
      <Text style={TICKET_STYLES.kvLabel}>{label}</Text>
      <Text style={TICKET_STYLES.kvValue}>{value}</Text>
    </View>
  );
}

export function TicketSectionHead({
  left,
  right,
}: {
  left: string;
  right: string;
}) {
  return (
    <View style={TICKET_STYLES.sectionHead}>
      <Text style={TICKET_STYLES.sectionHeadText}>{left}</Text>
      <Text style={TICKET_STYLES.sectionHeadText}>{right}</Text>
    </View>
  );
}

export interface TicketItemProps {
  productName: string;
  variantName?: string | null;
  quantity: number;
  unitPriceCents: number;
  /** Unit price BEFORE any per-line discount; absent → `unitPriceCents`. */
  baseUnitPriceCents?: number | null;
  discountTitle?: string | null;
  discountAmountCents?: number | null;
  /** NET line subtotal (what the line costs after its own discount). */
  subtotalCents: number;
}

/**
 * One product: bold name (wraps), then `variante · cantidad × precio` with the
 * line amount on the right, then — only when the line carries a discount —
 * the promotion title and `-$importe`.
 *
 * ARITHMETIC. The visible lines must add up to the sale «Subtotal» (gross):
 *   - no discount: `qty × unit = amount` (amount = net subtotal);
 *   - with a discount: the row prints `qty × BASE unit = gross amount` and the
 *     promo row prints the line's TOTAL discount = gross − net subtotal.
 *     That covers per-unit discounts (unitPrice already net, base = pre-price,
 *     discount = per-unit × qty) and BUY_X_GET_Y (unitPrice full, discount =
 *     the whole-line reward) with one rule, derived from known fields only.
 * An order-level promotion is not per line: it only reaches «Descuentos».
 */
export function TicketItem({
  productName,
  variantName,
  quantity,
  unitPriceCents,
  baseUnitPriceCents,
  discountTitle,
  discountAmountCents,
  subtotalCents,
}: TicketItemProps) {
  const baseCents = baseUnitPriceCents ?? unitPriceCents;
  const grossCents = Math.round(baseCents * quantity);
  const lineDiscountCents = discountAmountCents
    ? Math.max(0, grossCents - subtotalCents)
    : 0;
  const hasDiscount = lineDiscountCents > 0;
  const variant = variantName?.trim()
    ? softBreakLongTokens(variantName.trim())
    : null;
  const detail = `${variant ? `${variant} · ` : ''}${formatTicketQuantity(
    quantity,
  )} × ${formatA4Money(hasDiscount ? baseCents : unitPriceCents)}`;

  return (
    <View style={TICKET_STYLES.item} wrap={false}>
      <Text style={TICKET_STYLES.itemName}>
        {softBreakLongTokens(productName)}
      </Text>
      <View style={TICKET_STYLES.itemLine}>
        <Text style={TICKET_STYLES.itemDetail}>{detail}</Text>
        <Text style={TICKET_STYLES.itemAmount}>
          {formatA4Money(hasDiscount ? grossCents : subtotalCents)}
        </Text>
      </View>
      {hasDiscount ? (
        <View style={TICKET_STYLES.itemDiscount}>
          <Text style={TICKET_STYLES.itemDiscountTitle}>
            {discountTitle?.trim() || 'Descuento'}
          </Text>
          <Text style={TICKET_STYLES.itemDiscountAmount}>
            {formatA4Money(-lineDiscountCents)}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export function TicketEmptyRow({ children }: { children: string }) {
  return <Text style={TICKET_STYLES.empty}>{children}</Text>;
}

export function TicketSummaryRow({
  label,
  value,
  bold = false,
}: {
  label: string;
  value: string;
  bold?: boolean;
}) {
  const strong = bold ? TICKET_STYLES.summaryStrong : undefined;
  return (
    <View style={TICKET_STYLES.summaryRow} wrap={false}>
      <Text style={[TICKET_STYLES.summaryLabel, strong ?? {}]}>{label}</Text>
      <Text style={[TICKET_STYLES.summaryValue, strong ?? {}]}>{value}</Text>
    </View>
  );
}

/** Outstanding balance, framed (2 px border, no fill) so it cannot be missed. */
export function TicketDebtBox({
  debtCents,
  label = 'Deuda',
  note = TICKET_DEBT_NOTE,
}: {
  debtCents: number;
  /** Left label (default «Deuda»). */
  label?: string;
  /** Centered copy under the amount (default «Saldo pendiente de pago»). */
  note?: string;
}) {
  return (
    <View style={TICKET_STYLES.debtBox} wrap={false}>
      <View style={TICKET_STYLES.debtRow}>
        <Text style={TICKET_STYLES.debtText}>{label}</Text>
        <Text style={[TICKET_STYLES.debtText, TICKET_STYLES.debtValue]}>
          {formatA4Money(debtCents)}
        </Text>
      </View>
      <Text style={TICKET_STYLES.debtNote}>{note}</Text>
    </View>
  );
}

export function TicketGrandTotal({ totalCents }: { totalCents: number }) {
  return (
    <View style={TICKET_STYLES.grand} wrap={false}>
      <Text style={TICKET_STYLES.grandLabel}>TOTAL</Text>
      <Text style={TICKET_STYLES.grandValue}>{formatA4Money(totalCents)}</Text>
    </View>
  );
}

export interface TicketPaymentProps {
  method: string;
  amountCents: number;
  reference?: string | null;
  paidAt?: string | null;
  paymentMethodName?: string | null;
  paymentMethodSubtitle?: string | null;
}

/**
 * One payment: method (or the branded custom name) + time, then
 * `subtítulo · Ref: …` below, amount on the right.
 */
export function TicketPayment({
  method,
  amountCents,
  reference,
  paidAt,
  paymentMethodName,
  paymentMethodSubtitle,
}: TicketPaymentProps) {
  const detail = [
    paymentMethodSubtitle || null,
    reference ? `Ref: ${reference}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  return (
    <View style={TICKET_STYLES.payRow} wrap={false}>
      <View style={TICKET_STYLES.payInfo}>
        <Text style={TICKET_STYLES.payMethod}>
          {paymentMethodName || formatTicketMethod(method)}
          {paidAt ? (
            <Text style={TICKET_STYLES.payTime}>
              {'  '}
              {formatA4Time(paidAt)}
            </Text>
          ) : null}
        </Text>
        {detail ? <Text style={TICKET_STYLES.payDetail}>{detail}</Text> : null}
      </View>
      <Text style={TICKET_STYLES.payAmount}>{formatA4Money(amountCents)}</Text>
    </View>
  );
}

export function TicketFooter({
  thanks = 'Gracias por su compra.',
}: {
  /** Bold closing line (default «Gracias por su compra.»). */
  thanks?: string;
} = {}) {
  return (
    <View style={TICKET_STYLES.end} wrap={false}>
      <Text style={TICKET_STYLES.endThanks}>{thanks}</Text>
      <Text style={TICKET_STYLES.endNote}>
        Este comprobante no constituye una factura fiscal.
      </Text>
    </View>
  );
}
