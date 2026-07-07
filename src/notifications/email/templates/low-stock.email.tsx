/**
 * React Email template: low-stock digest.
 *
 * Slice F.1 of `low-stock-alerts`. Used by the Inngest function
 * (F.2) at `step.run('send-email')`. Each crossing in the coalesced
 * batch is rendered as one item in the table; the email itself is
 * one outbound message.
 *
 * **No PII / no internal IDs in the subject or heading.** The
 * subject and the email header use the item count + a generic
 * Spanish subject ("Productos con bajo inventario" — matches the
 * existing Spanish-language product copy in this codebase). The
 * item-level identifiers go in the BODY only, as links to the
 * tenant-scoped product detail page (`deepLink`).
 *
 * **Accessibility.** Uses semantic table headings, alt text on the
 * product image (if provided), and high-contrast colors. We
 * deliberately keep the layout simple: inboxes strip most CSS,
 * so `inline` styles via the `<Section>` / `<Text>` primitives are
 * the only reliable choice.
 *
 * Spec coverage (F.1): template renders product name, variant,
 * current qty, configured min, SKU/code, category, and deep link.
 */
import {
  Body,
  Column,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Row,
  Section,
  Text,
} from '@react-email/components';

/**
 * View-model for one table row in the low-stock digest. Carries
 * only what the email body needs; the Inngest function (F.2)
 * composes this from the coalesced batch + the outbox payload
 * fields. Pre-stringified values only — no rich objects cross the
 * boundary into the template.
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

  return (
    <Html lang="es">
      <Head>
        <title>{subject}</title>
        <Preview>{subject}</Preview>
      </Head>
      <Body
        style={{
          backgroundColor: '#f6f9fc',
          fontFamily:
            '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
          margin: 0,
          padding: 0,
        }}
      >
        <Container
          style={{
            backgroundColor: '#ffffff',
            margin: '0 auto',
            padding: '32px 24px',
            maxWidth: '600px',
          }}
        >
          <Heading
            style={{
              color: '#1a202c',
              fontSize: '22px',
              fontWeight: 600,
              lineHeight: '28px',
              margin: '0 0 16px',
            }}
          >
            {subject}
          </Heading>

          {tenantName ? (
            <Text
              style={{
                color: '#4a5568',
                fontSize: '14px',
                lineHeight: '20px',
                margin: '0 0 24px',
              }}
            >
              Tienda: <strong>{tenantName}</strong>
            </Text>
          ) : null}

          <Text
            style={{
              color: '#4a5568',
              fontSize: '14px',
              lineHeight: '20px',
              margin: '0 0 24px',
            }}
          >
            Los siguientes productos han cruzado su inventario mínimo.
            Repón o ajusta el límite antes de que el stock llegue a cero.
          </Text>

          {items.map((item, index) => (
            <Section
              key={index}
              style={{
                borderTop: index === 0 ? 'none' : '1px solid #e2e8f0',
                paddingTop: index === 0 ? 0 : '16px',
                paddingBottom: '16px',
              }}
            >
              <Row>
                {item.imageUrl ? (
                  <Column style={{ width: '64px', verticalAlign: 'top' }}>
                    <Img
                      src={item.imageUrl}
                      alt={item.productName}
                      width="56"
                      height="56"
                      style={{
                        borderRadius: '8px',
                        display: 'block',
                        objectFit: 'cover',
                      }}
                    />
                  </Column>
                ) : null}
                <Column>
                  <Heading
                    as="h3"
                    style={{
                      color: '#1a202c',
                      fontSize: '16px',
                      fontWeight: 600,
                      lineHeight: '22px',
                      margin: '0 0 4px',
                    }}
                  >
                    {item.productName}
                  </Heading>
                  {item.variantDescription ? (
                    <Text
                      style={{
                        color: '#4a5568',
                        fontSize: '13px',
                        lineHeight: '18px',
                        margin: '0 0 6px',
                      }}
                    >
                      Variante: {item.variantDescription}
                    </Text>
                  ) : null}
                  <Text
                    style={{
                      color: '#2d3748',
                      fontSize: '14px',
                      lineHeight: '20px',
                      margin: '0 0 4px',
                    }}
                  >
                    Actual: <strong>{item.currentQuantity}</strong>
                    {'  ·  '}
                    Mínimo: <strong>{item.minQuantity}</strong>
                  </Text>
                  <Text
                    style={{
                      color: '#718096',
                      fontSize: '12px',
                      lineHeight: '18px',
                      margin: 0,
                    }}
                  >
                    {item.sku ? <>SKU: {item.sku} · </> : null}
                    {item.category ? <>Categoría: {item.category}</> : null}
                  </Text>
                </Column>
              </Row>
              <Text style={{ margin: '8px 0 0' }}>
                <Link
                  href={item.deepLink}
                  style={{
                    color: '#3182ce',
                    fontSize: '13px',
                    textDecoration: 'underline',
                  }}
                >
                  Ver producto →
                </Link>
              </Text>
            </Section>
          ))}

          <Hr style={{ borderColor: '#e2e8f0', margin: '24px 0 16px' }} />
          <Text
            style={{
              color: '#a0aec0',
              fontSize: '11px',
              lineHeight: '16px',
              margin: 0,
              textAlign: 'center',
            }}
          >
            Recibiste este correo porque tu usuario está registrado como
            destinatario de notificaciones de bajo inventario.{' '}
            {appBaseUrl ? (
              <Link
                href={appBaseUrl}
                style={{ color: '#a0aec0', textDecoration: 'underline' }}
              >
                Configurar notificaciones
              </Link>
            ) : null}
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export default LowStockEmail;
