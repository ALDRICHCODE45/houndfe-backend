/**
 * React Email template — delivery-routes / DTE-3.
 *
 * Customer-facing "gracias por tu compra" email for a CONFIRMED + DELIVERED
 * delivery-route sale, rendered from the DTE-2 projection
 * (`SaleDeliverySummary`); it never re-reads a catalog or promotion.
 * Honesty rules: the per-line amount is the persisted NET `lineTotalCents`
 * (never re-subtracted), totals are persisted labels, and nothing claims a
 * payment or renders an id, email, address, platform logo or platform copy.
 * `tenantName` is optional and caller-resolved — the global `TENANT_NAME`
 * env var is never read — so without it the copy stays neutral. The DTE-2
 * type import is type-only, so no runtime dependency links the modules.
 */
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Text,
} from '@react-email/components';
import type { CSSProperties } from 'react';
import type { SaleDeliverySummary } from '../../../delivery-routes/domain/ports/sale-delivery-summary.port';

/** Brand tokens (HoundFe manual), kept local like the sibling templates. */
const BRAND = {
  ink: '#2c2434',
  body: '#443d4e',
  muted: '#938c9e',
  line: '#eceaf0',
  surface: '#fbfafc',
  page: '#f5f4f7',
  white: '#ffffff',
} as const;

const FONT_STACK =
  '"Baloo Thambi 2","Trebuchet MS",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif';

const SUBJECT = 'Gracias por tu compra';

/** Shared box model for the header and body rows of the single table. */
const HEAD_CELL = {
  color: BRAND.muted,
  fontSize: '11px',
  padding: '0 0 8px',
  borderBottom: `1px solid ${BRAND.line}`,
} as const;

const BODY_CELL = {
  color: BRAND.body,
  fontSize: '14px',
  verticalAlign: 'top',
  padding: '10px 0',
  borderBottom: `1px solid ${BRAND.line}`,
} as const;

/** Email-safe inline styles (no external stylesheet, no media queries). */
const styles = {
  body: {
    backgroundColor: BRAND.page,
    fontFamily: FONT_STACK,
    margin: 0,
    padding: '32px 0',
  },
  container: {
    backgroundColor: BRAND.white,
    margin: '0 auto',
    maxWidth: '600px',
    borderRadius: '14px',
  },
  block: { padding: '28px 32px 0' },
  card: {
    backgroundColor: BRAND.surface,
    border: `1px solid ${BRAND.line}`,
    borderRadius: '12px',
    padding: '18px 20px',
  },
  heading: {
    color: BRAND.ink,
    fontSize: '24px',
    fontWeight: 700,
    margin: '0 0 10px',
  },
  paragraph: {
    color: BRAND.body,
    fontSize: '15px',
    lineHeight: '23px',
    margin: 0,
  },
  table: { width: '100%', borderCollapse: 'collapse' },
  thLeft: { ...HEAD_CELL, textAlign: 'left' },
  thRight: { ...HEAD_CELL, textAlign: 'right' },
  tdLeft: { ...BODY_CELL, textAlign: 'left' },
  tdRight: { ...BODY_CELL, textAlign: 'right' },
  itemName: { color: BRAND.ink, fontSize: '14px', fontWeight: 700, margin: 0 },
  itemNote: { color: BRAND.muted, fontSize: '12px', margin: '2px 0 0' },
  sumCell: {
    color: BRAND.body,
    fontSize: '14px',
    // Neutralizes the bold default of `<th>`; only Total stays bold.
    fontWeight: 400,
    textAlign: 'right',
    padding: '4px 0',
  },
  totalCell: {
    color: BRAND.ink,
    fontSize: '15px',
    fontWeight: 700,
    textAlign: 'right',
    padding: '8px 0 0',
    borderTop: `1px solid ${BRAND.line}`,
  },
  footer: {
    borderTop: `1px solid ${BRAND.line}`,
    marginTop: '28px',
    padding: '20px 32px',
  },
  footerText: {
    color: BRAND.muted,
    fontSize: '12px',
    lineHeight: '18px',
    margin: 0,
    textAlign: 'center',
  },
} as const satisfies Record<string, CSSProperties>;

/** `summary` is the DTE-2 projection; `tenantName` is optional. */
export interface DeliveryThankYouEmailProps {
  summary: SaleDeliverySummary;
  tenantName?: string | null;
}

/** Static Spanish subject; the send step must reuse this composer. */
export function composeDeliveryThankYouSubject(): string {
  return SUBJECT;
}

export function DeliveryThankYouEmail({
  summary,
  tenantName,
}: DeliveryThankYouEmailProps) {
  const customerName = summary.customerName?.trim();
  const merchantName = tenantName?.trim() || null;
  const folio = summary.folio?.trim();
  const greeting = customerName ? `Hola, ${customerName}.` : 'Hola.';
  const paragraph =
    `${greeting} Tu pedido fue entregado; este es el resumen de tu compra.` +
    (folio ? ` Folio: ${folio}.` : '');
  const footerNote = merchantName
    ? `Recibiste este correo porque realizaste una compra en ${merchantName}.`
    : 'Recibiste este correo porque realizaste una compra.';

  return (
    <Html lang="es">
      <Head>
        <title>{SUBJECT}</title>
        <Preview>{`${SUBJECT} — resumen de tu pedido`}</Preview>
      </Head>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Section style={styles.block}>
            <Heading style={styles.heading}>{SUBJECT}</Heading>
            <Text style={styles.paragraph}>{paragraph}</Text>
          </Section>

          <Section style={styles.block}>
            <Section style={styles.card}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th scope="col" style={styles.thLeft}>
                      Producto
                    </th>
                    <th scope="col" style={styles.thRight}>
                      Cant.
                    </th>
                    <th scope="col" style={styles.thRight}>
                      {`Importe (${summary.currency})`}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {summary.items.map((item, index) => {
                    const variant = item.variantName?.trim();
                    const discount =
                      (item.discountAmountCents ?? 0) > 0
                        ? item.discountTitle?.trim()
                        : null;
                    return (
                      <tr key={`line-${index}`}>
                        <td style={styles.tdLeft}>
                          <Text style={styles.itemName}>
                            {item.productName}
                          </Text>
                          {variant ? (
                            <Text style={styles.itemNote}>{variant}</Text>
                          ) : null}
                          {discount ? (
                            <Text
                              style={styles.itemNote}
                            >{`Descuento: ${discount}`}</Text>
                          ) : null}
                        </td>
                        <td style={styles.tdRight}>{item.quantity}</td>
                        <td style={styles.tdRight}>
                          {formatMxnCents(item.lineTotalCents)}
                        </td>
                      </tr>
                    );
                  })}

                  {/* Totals share the table so amounts stay in the Importe
                      column. Labels are row headers with `colSpan` so they
                      stay aligned to that column. */}
                  <tr>
                    <th scope="row" colSpan={2} style={styles.sumCell}>
                      Subtotal
                    </th>
                    <td style={styles.sumCell}>
                      {formatMxnCents(summary.subtotalCents)}
                    </td>
                  </tr>
                  {summary.discountCents > 0 ? (
                    <tr>
                      <th scope="row" colSpan={2} style={styles.sumCell}>
                        Descuento
                      </th>
                      <td style={styles.sumCell}>
                        {`-${formatMxnCents(summary.discountCents)}`}
                      </td>
                    </tr>
                  ) : null}
                  <tr>
                    <th scope="row" colSpan={2} style={styles.totalCell}>
                      Total
                    </th>
                    <td style={styles.totalCell}>
                      {formatMxnCents(summary.totalCents)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </Section>
          </Section>

          {/* Merchant-specific only when the caller resolved a name. */}
          <Section style={styles.footer}>
            <Text style={styles.footerText}>{footerNote}</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

/**
 * Format persisted MXN cents as a fixed 2-decimal peso string with es-MX
 * grouping (`$12,345.67`). Hand-rolled instead of `Intl.NumberFormat` for
 * the same reason as the PDF templates — ICU output varies across Node
 * builds and an outbound email should be byte-stable. Non-finite input
 * degrades to `$0.00`, never `$NaN`.
 */
export function formatMxnCents(cents: number): string {
  const value = Number.isFinite(cents) ? Math.trunc(cents) : 0;
  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  const units = Math.floor(absolute / 100);
  const grouped = units.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const decimal = (absolute % 100).toString().padStart(2, '0');
  return `${sign}$${grouped}.${decimal}`;
}

export default DeliveryThankYouEmail;
