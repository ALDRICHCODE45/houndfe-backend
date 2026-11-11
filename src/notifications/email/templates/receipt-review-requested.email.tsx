/**
 * React Email template: transfer receipt waiting for review
 * (RECEIPT_REVIEW_REQUESTED, transfer-receipts / T2).
 *
 * One email per NEW receipt the chatbot uploads. Same HoundFe brand tokens
 * and Spanish copy as the time-off template. It never attaches or links the
 * file: staff open it in the system, behind the review permission. No customer
 * name or phone (contract §6.3, R10): the order folio identifies the sale.
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

export interface ReceiptReviewRequestedEmailProps {
  saleFolio: string | null;
  declaredAmountCents: number | null;
  extractedAmountCents: number | null;
  debtCents: number;
  mismatchFlagged: boolean;
  appBaseUrl?: string;
}

/** Subject shared by the Inngest function and the rendered `<title>`. */
export function composeSubject(saleFolio: string | null): string {
  return saleFolio
    ? `Comprobante por revisar · pedido ${saleFolio}`
    : 'Comprobante de transferencia por revisar';
}

const MONEY = new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'MXN',
});

function formatCents(cents: number | null): string {
  return cents === null ? 'No declarado' : MONEY.format(cents / 100);
}

const LABEL_STYLE = {
  color: BRAND.textMuted,
  fontSize: '11px',
  lineHeight: '16px',
  margin: '0 0 4px',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.6px',
};

const VALUE_STYLE = {
  color: BRAND.ink,
  fontSize: '15px',
  fontWeight: 700,
  margin: '0 0 12px',
};

export function ReceiptReviewRequestedEmail({
  saleFolio,
  declaredAmountCents,
  extractedAmountCents,
  debtCents,
  mismatchFlagged,
  appBaseUrl,
}: ReceiptReviewRequestedEmailProps) {
  const subject = composeSubject(saleFolio);
  const rows: Array<[string, string]> = [
    ['Pedido', saleFolio ?? 'Sin folio'],
    ['Monto declarado', formatCents(declaredAmountCents)],
    ['Monto leído del comprobante', formatCents(extractedAmountCents)],
    ['Saldo pendiente del pedido', formatCents(debtCents)],
  ];

  return (
    <Html lang="es">
      <Head>
        <title>{subject}</title>
        <Preview>Un cliente envió un comprobante de transferencia</Preview>
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
              Comprobante de transferencia
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
              Hay un comprobante por revisar
            </Heading>
            <Text
              style={{
                color: BRAND.textBody,
                fontSize: '15px',
                lineHeight: '23px',
                margin: 0,
              }}
            >
              El cliente envió un comprobante por WhatsApp. Revísalo en el
              sistema y confirma el monto real o recházalo.
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
              {rows.map(([label, value]) => (
                <div key={label}>
                  <Text style={LABEL_STYLE}>{label}</Text>
                  <Text style={VALUE_STYLE}>{value}</Text>
                </div>
              ))}
              {mismatchFlagged ? (
                <Text
                  style={{
                    color: BRAND.alert,
                    fontSize: '14px',
                    fontWeight: 700,
                    margin: 0,
                  }}
                >
                  No coincide con el saldo: verifica el monto antes de
                  confirmar.
                </Text>
              ) : null}
            </Section>
          </Section>

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
                Revisar comprobantes
              </Link>
            </Section>
          ) : null}

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
              destinatario de notificaciones y puede revisar comprobantes.
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

export default ReceiptReviewRequestedEmail;
