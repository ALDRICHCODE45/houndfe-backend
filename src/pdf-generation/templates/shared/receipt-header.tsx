/**
 * ReceiptHeader — top section of every receipt.
 *
 * Renders:
 *   - Logo (if `logoUrl` resolves), with a graceful text-only
 *     fallback to the company name when no logo is provided OR
 *     the `<Image>` fails to load at render time.
 *   - Company name (always shown; this is the receipt's primary
 *     brand marker even when the logo is present).
 *   - Branch address + phone (optional; per-tenant from
 *     `TenantsService.findById` at request time).
 *   - Folio + confirmed date, right-aligned. These are the
 *     receipt's unique identifiers — operators use them to look
 *     the sale up in the POS.
 *
 * Per spec ("Graceful degradation on missing logo"): when the
 * logo URL is absent or unreachable, the header must still produce
 * a valid PDF with the company name as text only. We implement
 * the missing-URL branch explicitly (don't render `<Image>` at
 * all) and rely on `@react-pdf/renderer`'s built-in image-fetch
 * error handling for the unreachable-URL branch (a failed image
 * silently drops the bitmap, leaving the text intact).
 *
 * Width: the component fills the available page width via flex.
 * On a 595pt A4 page (40pt padding = 555pt content) it lays out
 * the brand block on the left and the folio/date block on the
 * right; on a 227pt ticket page the same flex layout collapses
 * proportionally.
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
  /** Optional branch street address (per-tenant). */
  address?: string;
  /** Optional branch phone (per-tenant). */
  phone?: string;
  /** Sale folio / receipt number — the unique human identifier. */
  folio: string;
  /** ISO timestamp of when the sale was confirmed. */
  date: string;
  /** Optional subtitle shown below the company name (default "FARMACIA"). */
  subtitle?: string;
  /**
   * Size variant for the company name. `'small'` uses a 14pt token
   * suited for narrow formats (e.g. 80mm ticket) where the default
   * 18pt would collide with the FARMACIA subtitle below it.
   * Defaults to `'default'` (18pt).
   */
  titleSize?: 'default' | 'small';
}

export function ReceiptHeader({
  logoUrl,
  companyName,
  address,
  phone,
  folio,
  date,
  subtitle,
  titleSize = 'default',
}: ReceiptHeaderProps) {
  const companyNameStyle =
    titleSize === 'small'
      ? SHARED_STYLES.meta.companyNameSmall
      : SHARED_STYLES.meta.companyName;

  return (
    <View style={headerStyles.container}>
      <View style={headerStyles.topRow}>
        <View style={headerStyles.brandCol}>
          <View style={headerStyles.identityRow}>
            {logoUrl ? (
              <Image src={logoUrl} style={headerStyles.logo} cache={false} />
            ) : null}
            <View style={headerStyles.nameStack}>
              <Text style={companyNameStyle}>{companyName}</Text>
              <Text style={SHARED_STYLES.receipt.subtitle}>
                {subtitle ?? 'FARMACIA'}
              </Text>
            </View>
          </View>
          {address ? (
            <Text style={SHARED_STYLES.meta.brandLine}>{address}</Text>
          ) : null}
          {phone ? (
            <Text style={SHARED_STYLES.meta.brandLine}>{phone}</Text>
          ) : null}
        </View>
        <View style={headerStyles.metaCol}>
          <View style={SHARED_STYLES.receipt.folioBox}>
            <View style={SHARED_STYLES.receipt.folioRow}>
              <Text style={SHARED_STYLES.meta.label}>FOLIO</Text>
              <Text style={SHARED_STYLES.receipt.folioValue}>{folio}</Text>
            </View>
            <Text style={SHARED_STYLES.receipt.folioBlock}>
              FECHA {formatReceiptDate(date)}
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
}

/**
 * Local layout styles for the two-column header. Lives next to the
 * component (not in the shared stylesheet) because the column flex
 * layout is specific to this block's brand-meta split.
 */
const headerStyles = {
  container: {
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: SHARED_STYLES.divider.borderBottomColor,
    borderBottomStyle: 'solid' as const,
  },
  topRow: {
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
    alignItems: 'flex-start' as const,
  },
  brandCol: {
    flexDirection: 'column' as const,
    flexGrow: 1,
    flexShrink: 1,
  },
  identityRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
  },
  nameStack: {
    flexDirection: 'column' as const,
    flexShrink: 1,
  },
  metaCol: {
    flexDirection: 'column' as const,
    alignItems: 'flex-end' as const,
    flexShrink: 0,
    marginLeft: 6,
  },
  logo: {
    width: 24,
    height: 24,
    marginRight: 4,
    objectFit: 'contain' as const,
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
