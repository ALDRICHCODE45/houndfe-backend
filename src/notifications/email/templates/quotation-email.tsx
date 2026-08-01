/**
 * React Email template: quotation email.
 *
 * WU4 — Sent by `QuotationsService.send()` with the rendered PDF as a
 * Resend attachment. The recipient is the quotation's assigned customer
 * (a 422 `QUOTATION_CUSTOMER_HAS_NO_EMAIL` is thrown upstream when the
 * customer has no email address).
 *
 * Brand identity matches the existing email templates
 * (`low-stock.email.tsx`, `time-off-request.email.tsx`) — same logo
 * asset, same color tokens, same rounded system font stack — so the
 * outbound communications feel like one product.
 *
 * Tone: this is a TRANSACTIONAL email — a sales rep sent a quote to a
 * customer. We keep the layout restrained (no alert banner, no big
 * CTA): the value is the PDF attachment, and the body just orients
 * the recipient to the contents.
 *
 * Subject is intentionally composed in the service (not here) so the
 * email body and the Resend `Subject:` header share the same string
 * — one source of truth, no template drift between the rendered body
 * and the inbox preview.
 */
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Img,
  Preview,
  Section,
  Text,
} from '@react-email/components';

/**
 * Brand tokens (HoundFe manual). Kept local so the template is a
 * self-contained unit — same pattern as `low-stock.email.tsx`.
 */
const BRAND = {
  yellow: '#f6bb13',
  ink: '#2c2434',
  inkSoft: '#493f54',
  white: '#ffffff',
  pageBg: '#f5f4f7',
  surface: '#fbfafc',
  cardBorder: '#eceaf0',
  divider: '#eceaf0',
  textBody: '#443d4e',
  textMuted: '#938c9e',
} as const;

const LOGO_URL =
  'https://houndfe.sfo3.cdn.digitaloceanspaces.com/brand/houndfe-logo-email.png';

const FONT_STACK =
  '"Baloo Thambi 2","Trebuchet MS",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif';

/**
 * View-model for the quotation email. Carries only what the body
 * needs: identity, item summary, expiry. The PDF rides as a Resend
 * attachment — not part of the email view-model.
 */
export interface QuotationEmailProps {
  /** Tenant brand name shown in the header. */
  businessName: string;
  /** Quotation id (rendered as the document reference). */
  quotationId: string;
  /** Quotation creation date (already localized — service is responsible). */
  quotationDate: string;
  /** Number of items on the quotation (line count, not unit count). */
  itemCount: number;
  /** Total amount, formatted as a fixed-decimal currency string. */
  totalFormatted: string;
  /** ISO expiry date string. Null = no expiry was set on the draft. */
  expiresAtIso: string | null;
  /**
   * Customer name. Null when the quotation was sent without a
   * customer assigned (the customer section then renders
   * "Público en General" — same fallback the PDF receipt uses).
   */
  customerName: string | null;
  /** Sender display name (the seller's user name). */
  sellerName: string;
}

export function QuotationEmail({
  businessName,
  quotationId,
  quotationDate,
  itemCount,
  totalFormatted,
  expiresAtIso,
  customerName,
  sellerName,
}: QuotationEmailProps) {
  const greeting = customerName ? `Hola, ${customerName}` : 'Hola';
  const expiryLine = expiresAtIso
    ? `Esta cotización es válida hasta el ${formatExpiry(expiresAtIso)}.`
    : 'Esta cotización no tiene fecha de expiración.';
  const itemLabel =
    itemCount === 1
      ? '1 producto'
      : `${itemCount} productos`;

  return (
    <Html lang="es">
      <Head>
        <title>{`Cotización ${shortId(quotationId)} — ${businessName}`}</title>
        <Preview>{`Tu cotización de ${businessName} — ${totalFormatted}`}</Preview>
      </Head>
      <Body
        style={{
          backgroundColor: BRAND.pageBg,
          fontFamily: FONT_STACK,
          margin: 0,
          padding: '32px 0',
        }}
      >
        <Container
          style={{
            backgroundColor: BRAND.white,
            margin: '0 auto',
            maxWidth: '600px',
            borderRadius: '14px',
            overflow: 'hidden',
            border: `1px solid ${BRAND.cardBorder}`,
          }}
        >
          {/* ── Header: clean white, small logo as a signature ───── */}
          <Section style={{ padding: '28px 32px 0' }}>
            <Img
              src={LOGO_URL}
              alt={businessName}
              width="96"
              height="96"
              style={{ display: 'block', margin: 0 }}
            />
          </Section>

          {/* ── Title block ─────────────────────────────────────────── */}
          <Section style={{ padding: '20px 32px 0' }}>
            <Text
              style={{
                color: BRAND.ink,
                fontSize: '12px',
                fontWeight: 700,
                letterSpacing: '0.8px',
                lineHeight: '16px',
                margin: '0 0 6px',
                textTransform: 'uppercase',
              }}
            >
              Cotización
            </Text>
            <Heading
              style={{
                color: BRAND.ink,
                fontSize: '24px',
                fontWeight: 700,
                lineHeight: '30px',
                margin: '0 0 10px',
              }}
            >
              {greeting}, te enviamos tu cotización
            </Heading>
            <Text
              style={{
                color: BRAND.textBody,
                fontSize: '15px',
                lineHeight: '23px',
                margin: 0,
              }}
            >
              Adjuntamos el detalle de tu cotización{' '}
              <strong style={{ color: BRAND.ink }}>#{shortId(quotationId)}</strong>{' '}
              con {itemLabel} por un total de{' '}
              <strong style={{ color: BRAND.ink }}>{totalFormatted}</strong>.
              {' '}Revisa el PDF adjunto para ver el desglose completo.
            </Text>
          </Section>

          {/* ── Summary card ─────────────────────────────────────────── */}
          <Section style={{ padding: '24px 32px 8px' }}>
            <Section
              style={{
                backgroundColor: BRAND.surface,
                border: `1px solid ${BRAND.cardBorder}`,
                borderRadius: '12px',
                padding: '18px 20px',
              }}
            >
              <SummaryRow label="Fecha" value={quotationDate} />
              <SummaryRow label="Total" value={totalFormatted} highlight />
              <SummaryRow
                label="Vendedor"
                value={sellerName}
              />
              <SummaryRow
                label="Vigencia"
                value={
                  expiresAtIso
                    ? `Hasta ${formatExpiry(expiresAtIso)}`
                    : 'Sin fecha de expiración'
                }
              />
            </Section>
          </Section>

          {/* ── Expiry note ─────────────────────────────────────────── */}
          <Section style={{ padding: '8px 32px 8px' }}>
            <Text
              style={{
                color: BRAND.textBody,
                fontSize: '14px',
                lineHeight: '21px',
                margin: 0,
              }}
            >
              {expiryLine}
            </Text>
          </Section>

          {/* ── Footer ─────────────────────────────────────────────── */}
          <Section
            style={{
              borderTop: `1px solid ${BRAND.divider}`,
              padding: '20px 32px',
            }}
          >
            <Text
              style={{
                color: BRAND.textMuted,
                fontSize: '12px',
                lineHeight: '18px',
                margin: '0 0 4px',
                textAlign: 'center',
              }}
            >
              Si tienes dudas sobre esta cotización, responde a este
              correo y nos pondremos en contacto contigo.
            </Text>
            <Text
              style={{
                color: BRAND.textMuted,
                fontSize: '11px',
                lineHeight: '16px',
                margin: 0,
                textAlign: 'center',
              }}
            >
              <strong style={{ color: BRAND.inkSoft }}>{businessName}</strong> ·
              Gestión inteligente para tu negocio
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

function SummaryRow({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <Text
      style={{
        color: highlight ? BRAND.ink : BRAND.textBody,
        fontSize: '14px',
        lineHeight: '22px',
        margin: '0 0 4px',
        fontWeight: highlight ? 700 : 400,
      }}
    >
      <span style={{ color: BRAND.textMuted, fontWeight: 400 }}>{label}: </span>
      {value}
    </Text>
  );
}

/**
 * Format an ISO date string as a Spanish short date (`DD/MM/YYYY`).
 * Mirrors the helper in `quotation-a4.document.tsx` — kept private to
 * each template so neither depends on the other for layout typography.
 * (T062 refactor check: no shared layout constants — only the brand
 * color tokens above, which are intentionally duplicated from the
 * sibling email templates.)
 */
function formatExpiry(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${d.getUTCFullYear()}`;
}

/**
 * Render the first 8 characters of the UUID as a friendly short id.
 * Stable identifier on the wire (the full UUID), short for display.
 */
function shortId(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

export default QuotationEmail;
