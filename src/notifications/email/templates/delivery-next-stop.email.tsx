/**
 * React Email template — delivery-routes / WU3.
 *
 * Renders the "Tu paquete está por llegar" notification email when the
 * driver checks in a stop and a NEXT stop exists. Mirrors the brand
 * posture of the low-stock / time-off templates:
 *   - HoundFe brand colors (yellow `#f6bb13`, ink `#2c2434`, etc.).
 *   - Hosted logo (Spaces CDN) — inboxes strip SVG / local images.
 *   - Single template, no per-stop progress content (design §2 Q2).
 *
 * **No PII / no internal IDs in the subject.** The subject and heading
 * use the customer's name + a generic Spanish subject. Internal route /
 * stop ids stay out of the visible copy.
 *
 * **Body fields** (per design §2 Q2 + §8.5):
 *   - `nextCustomerName`
 *   - `nextAddressLabel`  (the formatted shipping address from the
 *                          customer's `CustomerAddress` row)
 *   - `tenantName`
 *   - `appBaseUrl`         (CTA link origin)
 *
 * Spec: design.md §2 (Resolved product defaults #2) + §8.5 (Inngest
 * function step 3 — `send-email`).
 */
import {
  Body,
  Button,
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
 * Brand tokens (HoundFe manual). Kept local to the template so the
 * email is a self-contained unit — no cross-module color imports.
 * Mirrors `low-stock.email.tsx` / `time-off-request.email.tsx`.
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
 * View-model for the delivery-next-stop email. Carries ONLY the
 * pre-stringified fields the Inngest function (WU3 §3.6) hands to the
 * template — no Date objects, no rich objects cross the boundary.
 */
export interface DeliveryNextStopEmailProps {
  nextCustomerName: string | null;
  nextAddressLabel: string | null;
  tenantName?: string;
  appBaseUrl?: string;
}

const SUBJECT = 'Tu paquete está por llegar';

export function composeDeliveryNextStopSubject(): string {
  return SUBJECT;
}

export function DeliveryNextStopEmail({
  nextCustomerName,
  nextAddressLabel,
  tenantName,
  appBaseUrl,
}: DeliveryNextStopEmailProps) {
  const greetingName = nextCustomerName?.trim() || 'Hola';

  return (
    <Html lang="es">
      <Head>
        <title>{SUBJECT}</title>
        <Preview>{`${SUBJECT} — pronto te visitaremos`}</Preview>
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
              alt="HoundFe"
              width="96"
              height="96"
              style={{ display: 'block', margin: 0 }}
            />
          </Section>

          {/* ── Title block: hierarchy carries the news, not color ── */}
          <Section style={{ padding: '20px 32px 0' }}>
            <Text
              style={{
                color: BRAND.yellow,
                fontSize: '12px',
                fontWeight: 700,
                letterSpacing: '0.8px',
                lineHeight: '16px',
                margin: '0 0 6px',
                textTransform: 'uppercase',
              }}
            >
              Aviso de entrega
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
              {SUBJECT}
            </Heading>
            <Text
              style={{
                color: BRAND.textBody,
                fontSize: '15px',
                lineHeight: '23px',
                margin: 0,
              }}
            >
              {greetingName}, el siguiente paquete de tu ruta está por
              llegar a tu domicilio. Por favor, asegúrate de que haya
              alguien disponible para recibirlo.
            </Text>
          </Section>

          {/* ── Address card: the only concrete data on the page ── */}
          {nextAddressLabel ? (
            <Section style={{ padding: '24px 32px 8px' }}>
              <Section
                style={{
                  backgroundColor: BRAND.surface,
                  border: `1px solid ${BRAND.cardBorder}`,
                  borderRadius: '12px',
                  padding: '18px 20px',
                }}
              >
                <Text
                  style={{
                    color: BRAND.textMuted,
                    fontSize: '11px',
                    fontWeight: 700,
                    letterSpacing: '0.8px',
                    textTransform: 'uppercase',
                    margin: '0 0 6px',
                  }}
                >
                  Dirección de entrega
                </Text>
                <Text
                  style={{
                    color: BRAND.ink,
                    fontSize: '15px',
                    lineHeight: '22px',
                    margin: 0,
                    whiteSpace: 'pre-line',
                  }}
                >
                  {nextAddressLabel}
                </Text>
              </Section>
            </Section>
          ) : null}

          {/* ── Primary CTA — open the web app for full details ── */}
          {appBaseUrl ? (
            <Section style={{ padding: '8px 32px 28px', textAlign: 'center' }}>
              <Button
                href={appBaseUrl}
                style={{
                  backgroundColor: BRAND.yellow,
                  color: BRAND.ink,
                  fontSize: '14px',
                  fontWeight: 700,
                  textDecoration: 'none',
                  padding: '12px 28px',
                  borderRadius: '10px',
                  display: 'inline-block',
                }}
              >
                Ver detalles de la entrega
              </Button>
            </Section>
          ) : null}

          {/* ── Footer: quiet, neutral, no heavy color block ─────── */}
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
              {tenantName ? (
                <>
                  Recibiste este correo porque tienes una entrega pendiente
                  en <strong style={{ color: BRAND.inkSoft }}>{tenantName}</strong>.
                </>
              ) : (
                <>
                  Recibiste este correo porque tienes una entrega pendiente.
                </>
              )}
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
              <strong style={{ color: BRAND.inkSoft }}>HoundFe</strong> ·
              Gestión inteligente para tu negocio
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export default DeliveryNextStopEmail;
