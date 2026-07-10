/**
 * React Email template: low-stock digest.
 *
 * Slice F.1 of `low-stock-alerts`. Used by the Inngest function
 * (F.2) at `step.run('send-email')`. Each crossing in the coalesced
 * batch is rendered as one item in the list; the email itself is
 * one outbound message.
 *
 * **Brand.** Follows the HoundFe brand manual (docs/hounfeLogos):
 * primary golden #f6bb13, dark purple #2c2434 / #493f54, black
 * outlines, rounded friendly type. The header carries the hosted
 * wordmark logo (Spaces CDN) — email clients render hosted PNGs
 * reliably (SVG / local images do not). Fonts fall back to a
 * rounded system stack because most inbox clients ignore web fonts;
 * brand identity is carried by color + the logo image.
 *
 * **Alert-with-brand tone.** This is an operational alert, so the
 * design leans on urgency: a red alert band under the header, the
 * critical stock numbers in the alert red, and a clear branded CTA.
 * The brand yellow stays reserved for the header + primary action.
 *
 * **No PII / no internal IDs in the subject or heading.** The
 * subject and header use the item count + a generic Spanish subject.
 * Item-level identifiers go in the BODY only, as links to the
 * tenant-scoped product detail page (`deepLink`).
 *
 * **Accessibility.** Semantic headings, alt text on images, and
 * high-contrast colors. Inline styles via the `@react-email`
 * primitives — inboxes strip most CSS, so inline is the only
 * reliable choice.
 *
 * Spec coverage (F.1): template renders product name, variant,
 * current qty, configured min, SKU/code, category, and deep link.
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
  Link,
  Preview,
  Row,
  Section,
  Text,
} from '@react-email/components';

/**
 * Brand tokens (HoundFe manual). Kept local to the template so the
 * email is a self-contained unit — no cross-module color imports.
 */
const BRAND = {
  yellow: '#f6bb13',
  ink: '#2c2434',
  inkSoft: '#493f54',
  black: '#000000',
  white: '#ffffff',
  // Urgency is communicated with restraint: a muted amber-red used ONLY
  // on the critical number + a thin accent line, never as a filled
  // banner. Keeps the design sober instead of "circus" yellow-vs-red.
  alert: '#c2410c',
  // Soft neutral surfaces — the design leans on whitespace + type
  // hierarchy for a premium/SaaS feel, not blocks of flat color.
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
 * View-model for one item in the low-stock digest. Carries only what
 * the email body needs; the Inngest function (F.2) composes this from
 * the coalesced batch + the outbox payload fields. Pre-stringified
 * values only — no rich objects cross the boundary into the template.
 */
export interface LowStockEmailItem {
  productName: string;
  variantDescription: string | null;
  currentQuantity: number;
  minQuantity: number;
  sku: string | null;
  category: string | null;
  deepLink: string;
  imageUrl?: string | null;
}

export interface LowStockEmailProps {
  tenantName?: string;
  items: LowStockEmailItem[];
  /**
   * Per-tenant base URL for the web app (used as the canonical
   * landing link in the footer). Inferred from the items'
   * `deepLink` origin when not provided.
   */
  appBaseUrl?: string;
}

export function LowStockEmail({
  tenantName,
  items,
  appBaseUrl,
}: LowStockEmailProps) {
  const subjectCount = items.length;
  const subject =
    subjectCount === 1
      ? '1 producto con bajo inventario'
      : `${subjectCount} productos con bajo inventario`;

  const alertHeadline =
    subjectCount === 1
      ? '1 producto necesita atención'
      : `${subjectCount} productos necesitan atención`;

  return (
    <Html lang="es">
      <Head>
        <title>{subject}</title>
        <Preview>{`${alertHeadline} — repón antes de quedarte sin stock`}</Preview>
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
              Alerta de inventario
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
              {alertHeadline}
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
                  los siguientes productos cruzaron su inventario mínimo.
                </>
              ) : (
                <>Los siguientes productos cruzaron su inventario mínimo.</>
              )}{' '}
              Repón o ajusta el límite antes de que el stock llegue a cero.
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
                <Row>
                  {item.imageUrl ? (
                    <Column style={{ width: '64px', verticalAlign: 'top' }}>
                      <Img
                        src={item.imageUrl}
                        alt={item.productName}
                        width="52"
                        height="52"
                        style={{
                          borderRadius: '10px',
                          display: 'block',
                          objectFit: 'cover',
                          border: `1px solid ${BRAND.cardBorder}`,
                        }}
                      />
                    </Column>
                  ) : null}
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
                      {item.productName}
                    </Heading>
                    {item.variantDescription ? (
                      <Text
                        style={{
                          color: BRAND.textBody,
                          fontSize: '12px',
                          lineHeight: '17px',
                          margin: '0 0 2px',
                        }}
                      >
                        {item.variantDescription}
                      </Text>
                    ) : null}
                    {item.sku || item.category ? (
                      <Text
                        style={{
                          color: BRAND.textMuted,
                          fontSize: '11px',
                          lineHeight: '16px',
                          margin: 0,
                        }}
                      >
                        {item.sku ? <>SKU {item.sku}</> : null}
                        {item.sku && item.category ? ' · ' : null}
                        {item.category ? <>{item.category}</> : null}
                      </Text>
                    ) : null}
                  </Column>
                </Row>

                {/* Stock summary — a single inline line, muted labels,
                    only the critical number is tinted. Restrained. */}
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
                      <span style={{ color: BRAND.textMuted }}>Quedan </span>
                      <strong style={{ color: BRAND.alert, fontSize: '16px' }}>
                        {item.currentQuantity}
                      </strong>
                      <span style={{ color: BRAND.textMuted }}>
                        {' '}
                        de un mínimo de{' '}
                      </span>
                      <strong style={{ color: BRAND.ink }}>
                        {item.minQuantity}
                      </strong>
                    </Text>
                  </Column>
                  <Column
                    style={{ verticalAlign: 'middle', textAlign: 'right' }}
                  >
                    <Link
                      href={item.deepLink}
                      style={{
                        color: BRAND.ink,
                        fontSize: '13px',
                        fontWeight: 700,
                        textDecoration: 'none',
                        borderBottom: `2px solid ${BRAND.yellow}`,
                        paddingBottom: '1px',
                      }}
                    >
                      Ver producto →
                    </Link>
                  </Column>
                </Row>
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
                Ir al inventario
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
              destinatario de notificaciones de bajo inventario.
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

export default LowStockEmail;
