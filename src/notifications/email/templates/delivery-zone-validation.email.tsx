/**
 * React Email template: delivery-zone validation requested.
 *
 * shipping-zones / T1 (S3). One email per newly opened validation (an
 * unknown postal code asked by a chatbot customer). Same HoundFe brand tokens
 * and Spanish copy as the time-off template. States the 24 h deadline: the
 * WhatsApp free-text window closes 24 h after the customer's last message,
 * after which the bot must fall back to its approved template.
 *
 * Never renders the customer phone or the conversation reference.
 */
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from '@react-email/components';

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

export interface DeliveryZoneValidationEmailProps {
  branchName?: string | null;
  zipCode: string;
  state: string;
  municipality: string;
  neighborhood: string;
  /** ISO instant: customer's last message + 24 h. */
  deadlineAt: string;
  appBaseUrl?: string;
}

/** Single canonical subject, shared by the Inngest fn and `<title>`. */
export function composeDeliveryZoneValidationSubject(zipCode: string): string {
  return `Validar zona de entrega: CP ${zipCode}`;
}

function formatDeadline(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString('es-MX', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const LABEL_STYLE = {
  color: BRAND.textMuted,
  fontSize: '11px',
  lineHeight: '16px',
  margin: '0 0 4px',
  textTransform: 'uppercase',
  letterSpacing: '0.6px',
} as const;

const VALUE_STYLE = {
  color: BRAND.ink,
  fontSize: '15px',
  fontWeight: 700,
  margin: '0 0 12px',
} as const;

export function DeliveryZoneValidationEmail({
  branchName,
  zipCode,
  state,
  municipality,
  neighborhood,
  deadlineAt,
  appBaseUrl,
}: DeliveryZoneValidationEmailProps) {
  const subject = composeDeliveryZoneValidationSubject(zipCode);
  const deadline = formatDeadline(deadlineAt);

  return (
    <Html lang="es">
      <Head>
        <title>{subject}</title>
        <Preview>
          Un cliente espera respuesta para el CP {zipCode} antes de {deadline}
        </Preview>
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
          <Section style={{ padding: '28px 32px 0' }}>
            <Img
              src={LOGO_URL}
              alt="HoundFe"
              width="96"
              height="96"
              style={{ display: 'block', margin: 0 }}
            />
          </Section>

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
              Zona de entrega por validar
            </Text>
            <Heading
              style={{
                color: BRAND.ink,
                fontSize: '22px',
                fontWeight: 700,
                lineHeight: '28px',
                margin: '0 0 10px',
              }}
            >
              {subject}
            </Heading>
            <Text
              style={{
                color: BRAND.textBody,
                fontSize: '15px',
                lineHeight: '23px',
                margin: 0,
              }}
            >
              Un cliente del chatbot pidió envío a un código postal que
              {branchName ? (
                <>
                  {' '}
                  <strong style={{ color: BRAND.ink }}>{branchName}</strong>
                </>
              ) : (
                ' la sucursal'
              )}{' '}
              todavía no tiene registrado. Decide si se entrega, el tipo de
              zona, el recargo cuando aplique y los días habituales de entrega.
            </Text>
          </Section>

          <Section style={{ padding: '24px 32px 8px' }}>
            <Section
              style={{
                backgroundColor: BRAND.surface,
                border: `1px solid ${BRAND.cardBorder}`,
                borderRadius: '12px',
                padding: '18px 20px',
              }}
            >
              <Text style={LABEL_STYLE}>Código postal</Text>
              <Text style={VALUE_STYLE}>{zipCode}</Text>
              <Text style={LABEL_STYLE}>Colonia</Text>
              <Text style={VALUE_STYLE}>{neighborhood}</Text>
              <Text style={LABEL_STYLE}>Municipio y estado</Text>
              <Text style={VALUE_STYLE}>
                {municipality}, {state}
              </Text>
              <Text style={LABEL_STYLE}>Plazo para responder</Text>
              <Text style={{ ...VALUE_STYLE, color: BRAND.alert, margin: 0 }}>
                {deadline}
              </Text>
            </Section>
          </Section>

          <Section style={{ padding: '8px 32px 0' }}>
            <Text
              style={{
                color: BRAND.textBody,
                fontSize: '14px',
                lineHeight: '21px',
                margin: 0,
              }}
            >
              El cliente puede recibir la respuesta por WhatsApp sin plantilla
              solo durante las 24 horas siguientes a su último mensaje. Valida
              la zona antes del plazo para que el chatbot le conteste a tiempo.
            </Text>
          </Section>

          {appBaseUrl ? (
            <Section style={{ padding: '20px 32px 28px', textAlign: 'center' }}>
              <Link
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
                Validar zonas pendientes
              </Link>
            </Section>
          ) : (
            <Section style={{ padding: '12px 32px 0' }} />
          )}

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
              Recibiste este correo porque puedes validar zonas de entrega y
              estás registrado como destinatario de notificaciones.
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

export default DeliveryZoneValidationEmail;
