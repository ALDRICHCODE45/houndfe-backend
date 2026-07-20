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
        <View style={SHARED_STYLES.receipt.outerBorder}>
          <ReceiptHeader
            {...business}
            folio={sale.folio}
            date={sale.date}
            subtitle="FARMACIA"
          />

          <View style={styles.saleMeta}>
            <Text style={styles.metaText}>CAJERO: {sale.cashier}</Text>
            <Text style={styles.metaText}>VENDEDOR: {sale.seller}</Text>
          </View>

          <View style={styles.customerBlock}>
            <CustomerSection customerName={customer.name} />
          </View>

          <View style={styles.section}>
            <LineItemsTable items={items} />
          </View>

          <View style={styles.section}>
            <TotalsBlock {...totals} />
          </View>

          <View style={styles.section}>
            <PaymentsList payments={payments} />
          </View>

          <Text style={SHARED_STYLES.receipt.footer}>
            Gracias por su compra.
          </Text>
        </View>
      </Page>
    </Document>
  );
}

function getTicketHeight(itemCount: number, paymentCount: number): number {
  const shellHeight = 380;
  const lineItemsHeight = itemCount * 32;
  const paymentsHeight = paymentCount * 28;

  return Math.max(480, shellHeight + lineItemsHeight + paymentsHeight);
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
  saleMeta: {
    marginTop: 5,
  },
  metaText: {
    color: '#493f54',
    fontSize: 7,
    marginBottom: 2,
  },
  customerBlock: {
    marginTop: 4,
  },
  section: {
    marginTop: 8,
  },
});
