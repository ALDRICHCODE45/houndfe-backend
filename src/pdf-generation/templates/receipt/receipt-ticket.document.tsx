import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import { PAPER_SIZES } from '../../pdf-generation.constants';
import {
  CustomerSection,
  LineItemsTable,
  PaymentsList,
  ReceiptHeader,
  TotalsBlock,
} from '../shared';
import type { ReceiptDocumentProps } from './receipt.types';

export function ReceiptTicketDocument({
  business,
  sale,
  customer,
  items,
  totals,
  payments,
}: ReceiptDocumentProps) {
  const height = getTicketHeight(items.length, payments.length);

  return (
    <Document title={`Ticket ${sale.folio}`}>
      <Page
        size={{ width: PAPER_SIZES.TICKET.width, height }}
        style={styles.page}
        wrap={false}
      >
        <View style={styles.headerBlock}>
          <ReceiptHeader {...business} folio={sale.folio} date={sale.date} />
          <View style={styles.saleMeta}>
            <Text style={styles.metaText}>Cajero: {sale.cashier}</Text>
            <Text style={styles.metaText}>Vendedor: {sale.seller}</Text>
          </View>
          <CustomerSection customerName={customer.name} />
        </View>

        <View style={styles.section}>
          <LineItemsTable items={items} />
        </View>

        <View style={styles.section}>
          <TotalsBlock {...totals} />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Pagos</Text>
          <PaymentsList payments={payments} />
        </View>
      </Page>
    </Document>
  );
}

function getTicketHeight(itemCount: number, paymentCount: number): number {
  const shellHeight = 330;
  const lineItemsHeight = itemCount * 32;
  const paymentsHeight = paymentCount * 28;

  return Math.max(420, shellHeight + lineItemsHeight + paymentsHeight);
}

const styles = StyleSheet.create({
  page: {
    paddingHorizontal: 10,
    paddingVertical: 12,
    color: '#2c2434',
    fontFamily: 'Helvetica',
    fontSize: 8,
    lineHeight: 1.2,
  },
  headerBlock: {
    gap: 4,
  },
  saleMeta: {
    marginTop: 5,
  },
  metaText: {
    color: '#493f54',
    fontSize: 7,
    marginBottom: 2,
  },
  section: {
    marginTop: 8,
  },
  sectionTitle: {
    borderBottomColor: '#eceaf0',
    borderBottomWidth: 1,
    color: '#493f54',
    fontFamily: 'Helvetica-Bold',
    fontSize: 7,
    marginBottom: 3,
    paddingBottom: 2,
    textTransform: 'uppercase',
  },
});
