/**
 * CustomerSection — customer block on the receipt (modern design).
 *
 * Renders the "Cliente" eyebrow label plus the customer name. When
 * `customerName` is null/empty/undefined, the value renders the Spanish
 * "Público en General" placeholder — the spec's mandated fallback for
 * sales with no assigned customer (POS default customer).
 *
 * Empty-string handling: per the prop type, empty string is also
 * treated as "no name" because the data layer sometimes returns
 * "" instead of null when the foreign-key column is nullable but
 * the trim normalizer doesn't kick in. All three falsy cases fall
 * back to the placeholder.
 *
 * Variants:
 *   - `a4` — a light-gray card (surface #F9FAFB + hairline border +
 *     8pt radius) with the name in 12pt 600, mirroring the quotation's
 *     CustomerCard.
 *   - `ticket` — compact inline row (eyebrow + name on one line) so it
 *     fits the 227pt thermal width without card padding.
 */
import { Text, View } from '@react-pdf/renderer';
import { SHARED_STYLES } from './styles';

export interface CustomerSectionProps {
  /** Customer full name. Null/empty/undefined → "Público en General". */
  customerName: string | null | undefined;
  /** Layout variant: A4 (card) or ticket (compact inline row). */
  variant?: 'a4' | 'ticket';
}

export const PUBLIC_CUSTOMER_PLACEHOLDER = 'Público en General' as const;

export function CustomerSection({
  customerName,
  variant = 'a4',
}: CustomerSectionProps) {
  const display =
    customerName && customerName.trim().length > 0
      ? customerName
      : PUBLIC_CUSTOMER_PLACEHOLDER;

  if (variant === 'ticket') {
    return (
      <View style={SHARED_STYLES.modern.ticket.customer.block}>
        <View style={SHARED_STYLES.modern.ticket.customer.row}>
          <Text style={SHARED_STYLES.modern.ticket.customer.label}>
            Cliente
          </Text>
          <Text style={SHARED_STYLES.modern.ticket.customer.value}>
            {display}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View
      style={[SHARED_STYLES.modern.card, SHARED_STYLES.modern.customer.block]}
    >
      <Text style={SHARED_STYLES.modern.eyebrow}>Cliente</Text>
      <Text style={SHARED_STYLES.modern.customer.name}>{display}</Text>
    </View>
  );
}
