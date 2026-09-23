/**
 * React Email template: promotion expiring digest (pca-3c4b).
 *
 * Rendered by the expiration Inngest function at
 * `step.run('send-email')`. One coalesced per-tenant batch renders ONE
 * message listing every promotion that is still effectively ACTIVE and
 * ends within the 7-day alert window.
 *
 * **Brand.** Follows the HoundFe brand manual (docs/hounfeLogos): primary
 * golden #f6bb13, dark purple #2c2434 / #493f54, hosted wordmark PNG, and
 * a rounded system font stack. Tokens stay local so the template is a
 * self-contained unit.
 *
 * **No internal identifiers / no PII.** The template never receives the
 * promotion id, the end-date fingerprint, or any tenant/user identifier,
 * so none can be rendered. Only the tenant-qualified promotion title and
 * the precise end date reach the body. The single call to action is the
 * tenant web app root.
 *
 * **Explicit UTC.** The tenant timezone is unavailable, so the end date is
 * formatted with a FIXED `es-AR` locale and an explicit `timeZone: 'UTC'`,
 * and the rendered string carries a literal `UTC` suffix. A reader can
 * never mistake the instant for their local wall clock, and the rendering
 * is deterministic for the same ISO input regardless of server locale.
 *
 * **Spanish copy.** Product-facing email copy is Spanish; the component
 * API, type names, and this documentation stay English.
 *
 * **Accessibility.** Semantic headings, an `alt` on the logo, high
 * contrast, and inline styles (inbox clients strip most CSS).
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
 * Brand tokens (HoundFe manual). Kept local so the email is a
 * self-contained unit — no cross-module color imports.
 */
const BRAND = {
  yellow: '#f6bb13',
  ink: '#2c2434',
  inkSoft: '#493f54',
  white: '#ffffff',
  alert: '#c2410c',
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
 * View-model for one expiring promotion. Carries only what the email body
 * needs: a display title plus the immutable end-date instant as an ISO-8601
 * string. Pre-stringified/primitive values only — no rich objects, no
 * identifiers, and no fingerprint cross the boundary into the template.
 */
export interface PromotionExpiringEmailItem {
  title: string;
  /** ISO-8601 UTC instant from the immutable outbox payload (`pca-3c1a`). */
  endDate: string;
}

export interface PromotionExpiringEmailProps {
  tenantName?: string;
  items: PromotionExpiringEmailItem[];
  /** Per-tenant base URL of the web app; renders the optional CTA. */
  appBaseUrl?: string;
}

/**
 * Format an ISO instant as a precise Spanish date/time string with an
 * explicit `UTC` suffix.
 *
 * The locale is pinned to `es-AR` and the zone to `UTC`, so the output is a
 * pure function of the input string on any host. An unparseable input
 * returns `''` instead of `Invalid Date`, so a malformed snapshot can never
 * render a broken line.
 */
export function formatPromotionEndDateUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const formatted = new Intl.DateTimeFormat('es-AR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
  }).format(date);
  return `${formatted} UTC`;
}

/**
 * Spanish subject/headline for a promotion count. Exported so the Inngest
 * function's `send-email` step and the HTML `<title>`/heading can never
 * drift apart.
 */
export function promotionExpiringSubject(count: number): string {
  if (count <= 1) return '1 promoción vence pronto';
  return `${count} promociones vencen pronto`;
}

export function PromotionExpiringEmail({
  tenantName,
  items,
  appBaseUrl,
}: PromotionExpiringEmailProps) {
  const headline = promotionExpiringSubject(items.length);

  return (
    <Html lang="es">
      <Head>
        <title>{headline}</title>
        <Preview>{`${headline} — vencen en los próximos 7 días`}</Preview>
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

          {/* ── Title block: hierarchy carries urgency, not color ── */}
          <Section style={{ padding: '20px 32px 0' }}>
            <Text
              style={{
                color: BRAND.alert,
                fontSize: '12px',
                fontWeight: 700,
                letterSpacing: '0.8px',
                lineHeight: '16px',
                margin: '0 0 6px',
                textTransform: 'uppercase',
              }}
            >
              Aviso de vencimiento
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
              {headline}
            </Heading>
            <Text
              style={{
                color: BRAND.textBody,
                fontSize: '15px',
                lineHeight: '23px',
                margin: 0,
              }}
            >
              {tenantName ? (
                <>
                  En <strong style={{ color: BRAND.ink }}>{tenantName}</strong>,
                  estas promociones están por vencer.
                </>
              ) : (
                <>Estas promociones están por vencer.</>
              )}{' '}
              Las fechas y horas se muestran en UTC. Revisá su configuración si
              querés extenderlas.
            </Text>
          </Section>

          {/* ── Items ────────────────────────────────────────────── */}
          <Section style={{ padding: '24px 32px 8px' }}>
            {items.map((item, index) => (
              <Section
                key={index}
                style={{
                  backgroundColor: BRAND.surface,
                  border: `1px solid ${BRAND.cardBorder}`,
                  borderRadius: '12px',
                  padding: '18px 20px',
                  marginBottom: index === items.length - 1 ? 0 : '14px',
                }}
              >
                <Heading
                  as="h3"
                  style={{
                    color: BRAND.ink,
                    fontSize: '16px',
                    fontWeight: 700,
                    lineHeight: '21px',
                    margin: '0 0 6px',
                  }}
                >
                  {item.title}
                </Heading>
                <Text
                  style={{
                    color: BRAND.textBody,
                    fontSize: '14px',
                    lineHeight: '20px',
                    margin: 0,
                  }}
                >
                  <span style={{ color: BRAND.textMuted }}>Vence: </span>
                  <strong style={{ color: BRAND.alert }}>
                    {formatPromotionEndDateUtc(item.endDate)}
                  </strong>
                </Text>
              </Section>
            ))}
          </Section>

          {/* ── Primary CTA — the one place brand yellow leads ───── */}
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
                Ver promociones
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
              Recibiste este correo porque tu usuario está registrado como
              destinatario de notificaciones de promociones.
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

export default PromotionExpiringEmail;
