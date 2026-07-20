import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import { PAPER_SIZES } from '../../pdf-generation.constants';
import {
  CustomerSection,
  LineItemsTable,
  PaymentsList,
  ReceiptHeader,
  SHARED_STYLES,
  TotalsBlock,
} from '../shared';
import type { ReceiptDocumentProps } from './receipt.types';

export function ReceiptA4Document({
  business,
  sale,
  customer,
  items,
  totals,
  payments,
}: ReceiptDocumentProps) {
  return (
    <Document title={`Recibo ${sale.folio}`}>
      <Page
        size={{ width: PAPER_SIZES.A4.width, height: PAPER_SIZES.A4.height }}
        style={styles.page}
      >
        <View style={SHARED_STYLES.receipt.outerBorder}>
          <View style={SHARED_STYLES.receipt.brandAccentBar} />
          <ReceiptHeader
            {...business}
            folio={sale.folio}
            date={sale.date}
            subtitle="FARMACIA"
          />

          <View style={styles.saleDetails}>
            <MetaField label="CAJERO" value={sale.cashier} />
            <MetaField label="VENDEDOR" value={sale.seller} />
          </View>

          <View style={styles.customer}>
            <CustomerSection customerName={customer.name} />
          </View>

          <LineItemsTable items={items} variant="a4" />
          <TotalsBlock {...totals} />
          <PaymentsList payments={payments} />

          <Text style={SHARED_STYLES.receipt.footer}>
            Gracias por su compra.
          </Text>
        </View>
      </Page>
    </Document>
  );
}

function MetaField({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaField}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    padding: 28,
    color: '#2c2434',
    fontFamily: 'Helvetica',
    fontSize: 10,
  },
  saleDetails: {
    flexDirection: 'row',
    gap: 28,
    marginTop: 8,
    marginBottom: 4,
  },
  metaField: {
    flexDirection: 'row',
    gap: 5,
  },
  metaLabel: {
    color: '#938c9e',
    fontFamily: 'Helvetica-Bold',
    fontSize: 8,
    textTransform: 'uppercase',
  },
  metaValue: {
    fontSize: 9,
  },
  customer: {
    marginTop: 8,
  },
});
