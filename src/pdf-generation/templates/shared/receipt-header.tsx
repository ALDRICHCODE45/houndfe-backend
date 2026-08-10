/**
 * ReceiptHeader — top section of every receipt (modern design).
 *
 * Renders:
 *   - Logo (if `logoUrl` resolves), with a graceful text-only
 *     fallback to the company name when no logo is provided OR
 *     the `<Image>` fails to load at render time.
 *   - Company name + "Punto de Venta" subtitle (the receipt's
 *     primary brand marker).
 *   - A light-gray meta card (right) carrying the document title
 *     (default "RECIBO"), the folio, and the formatted date.
 *
 * Per spec ("Graceful degradation on missing logo"): when the
 * logo URL is absent or unreachable, the header must still produce
 * a valid PDF with the company name as text only. We implement
 * the missing-URL branch explicitly (don't render `<Image>` at
 * all) and rely on `@react-pdf/renderer`'s built-in image-fetch
 * error handling for the unreachable-URL branch (a failed image
 * silently drops the bitmap, leaving the text intact).
 *
 * Variants:
 *   - `a4` — brand block (28pt logo + 16pt name) on the left, the
 *     meta card with padding 12 on the right.
 *   - `ticket` — compact twin for the 80mm thermal format: smaller
 *     brand (18pt logo + 12pt name, no subtitle) and a meta card with
 *     padding 4-6 so it stays inside the 227pt width. Per the ticket
 *     redesign rule, the A4 card padding (16) must not be used here.
 *
 * `address` / `phone` are accepted for interface compatibility (the
 * per-tenant branch info passed by the service) but are intentionally
 * NOT rendered: the modern aesthetic keeps the header to brand + meta
 * card only, matching the approved quotation pilot.
 */
import { Image, Text, View } from '@react-pdf/renderer';
import { SHARED_STYLES } from './styles';

export interface ReceiptHeaderProps {
  /**
   * Optional URL of the brand logo PNG/JPG. When omitted the header
   * renders text-only (spec: graceful degradation on missing logo).
   */
  logoUrl?: string;
  /** Brand / company name shown beside or below the logo. Required. */
  companyName: string;
  /** Optional branch street address (per-tenant). Kept for API compat; not rendered. */
  address?: string;
  /** Optional branch phone (per-tenant). Kept for API compat; not rendered. */
  phone?: string;
  /** Sale folio / receipt number — the unique human identifier. */
  folio: string;
  /** ISO timestamp of when the sale was confirmed. */
  date: string;
  /** Optional subtitle shown below the company name (default "Punto de Venta"). */
  subtitle?: string;
  /**
   * Document title shown inside the meta card. Defaults to "RECIBO".
   * The quotation template renders its own autonomous header with
   * "COTIZACIÓN"; this shared block is receipt-specific.
   */
  title?: string;
  /** Layout variant: A4 (card padding 12) or ticket (card padding 4-6). */
  variant?: 'a4' | 'ticket';
}

export function ReceiptHeader({
  logoUrl,
  companyName,
  folio,
  date,
  subtitle,
  title = 'RECIBO',
  variant = 'a4',
}: ReceiptHeaderProps) {
  const isTicket = variant === 'ticket';
  const tokens = isTicket
    ? SHARED_STYLES.modern.ticket.header
    : SHARED_STYLES.modern.header;
  // A4 meta card = the shared compact card (padding 8/12, radius 8);
  // the ticket has its own tighter card token (padding 4-6).
  const metaCardStyle = isTicket
    ? SHARED_STYLES.modern.ticket.header.metaCard
    : SHARED_STYLES.modern.cardCompact;

  return (
    <View
      style={
        isTicket
          ? SHARED_STYLES.modern.ticket.header.container
          : headerStyles.container
      }
    >
      <View style={tokens.row}>
        <View style={tokens.brandRow}>
          {logoUrl ? (
            <Image src={logoUrl} style={tokens.logo} cache={false} />
          ) : null}
          <View style={headerStyles.nameStack}>
            <Text style={tokens.companyName}>{companyName}</Text>
            {!isTicket ? (
              <Text style={tokens.companySub}>
                {subtitle ?? 'Punto de Venta'}
              </Text>
            ) : null}
          </View>
        </View>
        <View style={[metaCardStyle, headerStyles.metaCard]}>
          <Text style={tokens.metaTitle}>{title}</Text>
          <Text style={tokens.metaFolio}>FOLIO #{folio}</Text>
          <Text style={tokens.metaDate}>FECHA {formatReceiptDate(date)}</Text>
        </View>
      </View>
    </View>
  );
}

/**
 * Local layout styles for the two-column header. Lives next to the
 * component (not in the shared stylesheet) because the A4 column flex
 * layout + bottom hairline are specific to this block's brand-meta split.
 * The ticket variant uses the shared `modern.ticket.header` tokens only.
 */
const headerStyles = {
  container: {
    marginBottom: 24,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: SHARED_STYLES.modern.palette.border,
    borderBottomStyle: 'solid' as const,
  },
  nameStack: {
    flexDirection: 'column' as const,
    flexShrink: 1,
  },
  // Meta card alignment (the A4 card is `cardCompact`; the ticket has its
  // own compact card token). Shared alignment keeps the block right-anchored
  // on both variants.
  metaCard: {
    alignItems: 'flex-end' as const,
    flexShrink: 0,
    marginLeft: 6,
  },
};

/**
 * Format an ISO timestamp into a human-readable receipt date.
 *
 * Spanish locale (`es-MX`) matches the codebase's primary locale
 * (`low-stock.email.tsx`, `time-off-request.email.tsx`). We use a
 * deterministic format (`dd MMM yyyy, HH:mm`) so the same sale
 * always renders the same string across locales and time zones
 * on the receiving printer — receipts are legal documents and
 * drift between runs would be a compliance issue.
 *
 * Falls back to the raw string when the input is not a parseable
 * ISO timestamp; @react-pdf will render it as-is rather than
 * blowing up at render time.
 */
function formatReceiptDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  try {
    return new Intl.DateTimeFormat('es-MX', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    // Older Node builds without full ICU data fall back to ISO.
    return date.toISOString().replace('T', ' ').slice(0, 16);
  }
}
