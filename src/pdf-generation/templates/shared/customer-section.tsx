/**
 * CustomerSection — short customer line on the receipt.
 *
 * Single-row component: bold "Cliente" label followed by the
 * customer name. When `customerName` is null/empty/undefined,
 * the value renders the Spanish "Público en General" placeholder
 * — the spec's mandated fallback for sales with no assigned
 * customer (POS default customer).
 *
 * Empty-string handling: per the prop type, empty string is also
 * treated as "no name" because the data layer sometimes returns
 * "" instead of null when the foreign-key column is nullable but
 * the trim normalizer doesn't kick in. All three falsy cases fall
 * back to the placeholder.
 *
 * Style: shares the row layout tokens with `customer.row` from
 * the shared stylesheet so the receipt has one consistent type
 * rhythm across header / customer / totals.
 */
import { Text, View } from '@react-pdf/renderer';
import { SHARED_STYLES } from './styles';

export interface CustomerSectionProps {
  /** Customer full name. Null/empty/undefined → "Público en General". */
  customerName: string | null | undefined;
}

export const PUBLIC_CUSTOMER_PLACEHOLDER = 'Público en General' as const;

export function CustomerSection({ customerName }: CustomerSectionProps) {
  const display =
    customerName && customerName.trim().length > 0
      ? customerName
      : PUBLIC_CUSTOMER_PLACEHOLDER;

  return (
    <View style={SHARED_STYLES.customer.row}>
      <Text style={SHARED_STYLES.customer.label}>Cliente</Text>
      <Text style={SHARED_STYLES.customer.value}>{display}</Text>
    </View>
  );
}