/**
 * React Email template: near-capacity promotion alert.
 *
 * pca-3b4b. Rendered by the near-capacity Inngest function at
 * `step.run('send-email')`. One coalesced per-tenant batch renders ONE
 * message listing every promotion that crossed the configured 80% of a
 * finite capacity.
 *
 * **Brand.** Follows the HoundFe brand manual (docs/hounfeLogos): primary
 * golden #f6bb13, dark purple #2c2434 / #493f54, hosted wordmark PNG, and
 * a rounded system font stack. Tokens stay local so the template is a
 * self-contained unit.
 *
 * **No internal identifiers / no PII.** The template never receives the
 * sale id or the promotion id from the alert pipeline, so neither can be
 * rendered. Only the tenant-qualified promotion title and the capacity
 * counters (consumed + max) reach the body. The single call to action is
 * the tenant web app root.
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
  Column,
  Container,
  Head,
  Heading,
  Html,
  Img,
  Preview,
  Row,
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
 * View-model for one near-capacity promotion. Carries only what the
 * email body needs: a display title plus the consumed/max counters.
 * Pre-stringified/primitive values only — no rich objects and no
 * identifiers cross the boundary into the template.
 */
export interface NearCapacityPromotionEmailItem {
  title: string;
  consumedProductUnits: number;
  maxProductUnits: number;
}

export interface PromotionNearCapacityEmailProps {
  tenantName?: string;
  items: NearCapacityPromotionEmailItem[];
  /** Per-tenant base URL of the web app; renders the optional CTA. */
  appBaseUrl?: string;
}

/**
 * Spanish subject/headline for a promotion count. Exported so the
 * Inngest function's `send-email` step and the HTML `<title>`/heading
 * can never drift apart.
 */
export function promotionNearCapacitySubject(count: number): string {
  if (count <= 1) return '1 promoción cerca de su capacidad';
  return `${count} promociones cerca de su capacidad`;
}

/**
 * Integer percentage of a finite capacity, clamped to 0–100. A zero,
 * negative, or non-finite max yields 0 instead of `NaN`/`Infinity` so a
 * malformed snapshot can never render a broken line.
 */
function consumedPercentage(consumed: number, max: number): number {
  if (!Number.isFinite(consumed) || !Number.isFinite(max) || max <= 0) {
    return 0;
  }
  const rounded = Math.round((consumed / max) * 100);
  if (!Number.isFinite(rounded)) return 0;
  return Math.max(0, Math.min(100, rounded));
}

export function PromotionNearCapacityEmail({
  tenantName,
  items,
  appBaseUrl,
}: PromotionNearCapacityEmailProps) {
  const headline = promotionNearCapacitySubject(items.length);

  return (
    <Html lang="es">
      <Head>
        <title>{headline}</title>
        <Preview>{`${headline} — quedan pocas unidades disponibles`}</Preview>
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
              Alerta de capacidad
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
                  estas promociones ya consumieron al menos el 80% de su
                  capacidad configurada.
                </>
              ) : (
                <>
                  Estas promociones ya consumieron al menos el 80% de su
                  capacidad configurada.
                </>
              )}{' '}
              Revisá la configuración antes de que se agoten.
            </Text>
          </Section>

          {/* ── Items ────────────────────────────────────────────── */}
          <Section style={{ padding: '24px 32px 8px' }}>
            {items.map((item, index) => {
              const percentage = consumedPercentage(
                item.consumedProductUnits,
                item.maxProductUnits,
              );

              return (
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
                  <Row>
                    <Column style={{ verticalAlign: 'top' }}>
                      <Heading
                        as="h3"
                        style={{
                          color: BRAND.ink,
                          fontSize: '16px',
                          fontWeight: 700,
                          lineHeight: '21px',
                          margin: '0 0 2px',
                        }}
                      >
                        {item.title}
                      </Heading>
                    </Column>
                    <Column
                      style={{
                        verticalAlign: 'top',
                        textAlign: 'right',
                        width: '72px',
                      }}
                    >
                      <Text
                        style={{
                          color: BRAND.alert,
                          fontSize: '16px',
                          fontWeight: 700,
                          lineHeight: '21px',
                          margin: 0,
                        }}
                      >
                        {percentage}%
                      </Text>
                    </Column>
                  </Row>

                  <Row style={{ margin: '14px 0 0' }}>
                    <Column style={{ verticalAlign: 'middle' }}>
                      <Text
                        style={{
                          color: BRAND.textBody,
                          fontSize: '14px',
                          lineHeight: '20px',
                          margin: 0,
                        }}
                      >
                        <span style={{ color: BRAND.textMuted }}>
                          Consumido{' '}
                        </span>
                        <strong style={{ color: BRAND.alert }}>
                          {item.consumedProductUnits}
                        </strong>
                        <span style={{ color: BRAND.textMuted }}> de </span>
                        <strong style={{ color: BRAND.ink }}>
                          {item.maxProductUnits}
                        </strong>
                        <span style={{ color: BRAND.textMuted }}>
                          {' '}
                          unidades
                        </span>
                      </Text>
                    </Column>
                  </Row>
                </Section>
              );
            })}
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

export default PromotionNearCapacityEmail;
