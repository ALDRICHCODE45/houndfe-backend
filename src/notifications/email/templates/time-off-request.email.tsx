/**
 * React Email template: time-off request notification.
 *
 * Slice 6 of `hr-validation-notifications`. Renders one email per
 * HR time-off request (no batch — Design D2 per-request single email).
 * The template matches the low-stock visual convention (HoundFe brand
 * tokens, Spanish copy, same Inngest-time render path).
 *
 * Spanish subject (Design.md contracts): "Nueva solicitud de tiempo libre".
 * No PII / no employee internal IDs in the subject — the body carries
 * the employee name + type + dates + requester.
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

/** Brand tokens — same palette as low-stock.email.tsx so the family
 * looks identical in the inbox. */
const BRAND = {
  yellow: '#f6bb13',
  ink: '#2c2434',
  inkSoft: '#493f54',
  black: '#000000',
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

export interface TimeOffRequestEmailProps {
  tenantName?: string;
  employeeName: string;
  type: string;
  startDate: string;
  endDate: string;
  requestedByUserId?: string | null;
  appBaseUrl?: string;
}

/** Compose the Spanish subject — single canonical literal used by the
 * Inngest fn AND rendered into the email's `<title>`. Pin it here so
 * a refactor cannot drift the subject across the two surfaces. */
export function composeSubject(): string {
  return 'Nueva solicitud de tiempo libre';
}

const TYPE_LABELS: Record<string, string> = {
  VACATION: 'Vacaciones',
  SICK: 'Permiso médico',
  PERSONAL: 'Permiso personal',
};

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('es-MX', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

export function TimeOffRequestEmail({
  tenantName,
  employeeName,
  type,
  startDate,
  endDate,
  requestedByUserId,
  appBaseUrl,
}: TimeOffRequestEmailProps) {
  const subject = composeSubject();
  const typeLabel = TYPE_LABELS[type] ?? type;

  return (
    <Html lang="es">
      <Head>
        <title>{subject}</title>
        <Preview>
          {employeeName} solicita {typeLabel.toLowerCase()}
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
          {/* Header — same brand signature as low-stock */}
          <Section style={{ padding: '28px 32px 0' }}>
            <Img
              src={LOGO_URL}
              alt="HoundFe"
              width="96"
              height="96"
              style={{ display: 'block', margin: 0 }}
            />
          </Section>

          {/* Title */}
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
              Solicitud de tiempo libre
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
              {employeeName} solicita {typeLabel.toLowerCase()}
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
                  un colaborador ha enviado una nueva solicitud de tiempo
                  libre para tu revisión.
                </>
              ) : (
                <>
                  Un colaborador ha enviado una nueva solicitud de tiempo
                  libre para tu revisión.
                </>
              )}
            </Text>
          </Section>

          {/* Detail card */}
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
                  lineHeight: '16px',
                  margin: '0 0 4px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.6px',
                }}
              >
                Tipo
              </Text>
              <Text
                style={{
                  color: BRAND.ink,
                  fontSize: '15px',
                  fontWeight: 700,
                  margin: '0 0 12px',
                }}
              >
                {typeLabel}
              </Text>

              <Text
                style={{
                  color: BRAND.textMuted,
                  fontSize: '11px',
                  lineHeight: '16px',
                  margin: '0 0 4px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.6px',
                }}
              >
                Fechas
              </Text>
              <Text
                style={{
                  color: BRAND.ink,
                  fontSize: '15px',
                  fontWeight: 700,
                  margin: '0 0 12px',
                }}
              >
                {formatDate(startDate)} — {formatDate(endDate)}
              </Text>

              <Text
                style={{
                  color: BRAND.textMuted,
                  fontSize: '11px',
                  lineHeight: '16px',
                  margin: '0 0 4px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.6px',
                }}
              >
                Solicitante
              </Text>
              <Text
                style={{
                  color: BRAND.textBody,
                  fontSize: '14px',
                  margin: 0,
                }}
              >
                {requestedByUserId
                  ? `ID de usuario: ${requestedByUserId}`
                  : 'No registrado'}
              </Text>
            </Section>
          </Section>

          {/* Primary CTA */}
          {appBaseUrl ? (
            <Section style={{ padding: '8px 32px 28px', textAlign: 'center' }}>
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
                Revisar solicitudes
              </Link>
            </Section>
          ) : null}

          {/* Footer */}
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
              destinatario de notificaciones de tiempo libre.
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

export default TimeOffRequestEmail;