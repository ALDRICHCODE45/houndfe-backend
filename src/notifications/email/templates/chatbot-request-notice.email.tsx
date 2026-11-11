/**
 * React Email template: chatbot request notices (human-intervention unit 6).
 *
 * Contract §6.3 / D5: NO customer name, phone, text or media. Only the type,
 * the branch, the folio and a deep link that opens the request in the system
 * (behind login). One request, or a batch of "new request" notices with one
 * link each. Same HoundFe brand tokens as the receipt template.
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
import {
  NOTICE_HEADLINE,
  formatFolio,
  requestDeepLink,
  subtypeLabel,
  type NoticeType,
} from '../../domain/chatbot-request-notice';

const BRAND = {
  yellow: '#f6bb13',
  ink: '#2c2434',
  white: '#ffffff',
  pageBg: '#f5f4f7',
  cardBorder: '#eceaf0',
  textBody: '#443d4e',
  textMuted: '#938c9e',
} as const;

const LOGO_URL =
  'https://houndfe.sfo3.cdn.digitaloceanspaces.com/brand/houndfe-logo-email.png';

const FONT_STACK =
  '"Baloo Thambi 2","Trebuchet MS",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif';

export interface NoticeEmailItem {
  type: NoticeType;
  requestId: string;
  folio: number;
  subtype: string;
}

export interface ChatbotRequestNoticeEmailProps {
  items: NoticeEmailItem[];
  branchName: string;
  appBaseUrl?: string;
}

/** `[HoundFe] Nueva solicitud: <tipo> (<sucursal>) · S-000123` (§5.1). */
export function composeSubject(
  items: NoticeEmailItem[],
  branchName: string,
): string {
  if (items.length === 1) {
    const [item] = items;
    return `[HoundFe] ${NOTICE_HEADLINE[item.type]}: ${subtypeLabel(item.subtype)} (${branchName}) · ${formatFolio(item.folio)}`;
  }
  return `[HoundFe] ${items.length} solicitudes nuevas (${branchName})`;
}

export function ChatbotRequestNoticeEmail({
  items,
  branchName,
  appBaseUrl,
}: ChatbotRequestNoticeEmailProps) {
  const subject = composeSubject(items, branchName);
  return (
    <Html lang="es">
      <Head>
        <title>{subject}</title>
        <Preview>{subject}</Preview>
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
            border: `1px solid ${BRAND.cardBorder}`,
          }}
        >
          <Section style={{ padding: '28px 32px 0' }}>
            <Img src={LOGO_URL} alt="HoundFe" width="96" height="96" />
          </Section>
          <Section style={{ padding: '20px 32px 8px' }}>
            <Heading
              style={{
                color: BRAND.ink,
                fontSize: '22px',
                lineHeight: '28px',
                margin: '0 0 8px',
              }}
            >
              {items.length === 1
                ? NOTICE_HEADLINE[items[0].type]
                : `${items.length} solicitudes nuevas`}
            </Heading>
            <Text
              style={{
                color: BRAND.textBody,
                fontSize: '15px',
                margin: '0 0 16px',
              }}
            >
              Sucursal: {branchName}
            </Text>
            {items.map((item) => (
              <Section key={item.requestId} style={{ margin: '0 0 12px' }}>
                <Text
                  style={{
                    color: BRAND.ink,
                    fontSize: '15px',
                    fontWeight: 700,
                    margin: '0 0 4px',
                  }}
                >
                  {subtypeLabel(item.subtype)} · {formatFolio(item.folio)}
                </Text>
                {appBaseUrl ? (
                  <Link
                    href={requestDeepLink(appBaseUrl, item.requestId)}
                    style={{
                      backgroundColor: BRAND.yellow,
                      color: BRAND.ink,
                      fontSize: '14px',
                      fontWeight: 700,
                      textDecoration: 'none',
                      padding: '10px 22px',
                      borderRadius: '10px',
                      display: 'inline-block',
                    }}
                  >
                    Abrir solicitud
                  </Link>
                ) : null}
              </Section>
            ))}
          </Section>
          <Section style={{ padding: '12px 32px 24px' }}>
            <Text
              style={{
                color: BRAND.textMuted,
                fontSize: '12px',
                lineHeight: '18px',
                margin: 0,
                textAlign: 'center',
              }}
            >
              Recibes este correo porque puedes atender solicitudes del chatbot.
              Puedes apagarlo en tus preferencias de notificaciones.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export default ChatbotRequestNoticeEmail;
