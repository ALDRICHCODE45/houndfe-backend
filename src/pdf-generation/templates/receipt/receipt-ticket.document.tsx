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
        <View>
          <View style={SHARED_STYLES.receipt.brandAccentBar} />
          <ReceiptHeader
            companyName={business.companyName}
            folio={sale.folio}
            date={sale.date}
            subtitle="PUNTO DE VENTA"
            titleSize="small"
          />

          <View style={styles.saleMeta}>
            <MetaField label="CAJERO" value={sale.cashier} />
            <MetaField label="VENDEDOR" value={sale.seller} />
          </View>

          <View style={styles.customerBlock}>
            <CustomerSection customerName={customer.name} />
          </View>

          <View style={styles.section}>
            <LineItemsTable items={items} variant="ticket" />
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

function MetaField({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaField}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
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
    paddingHorizontal: 8,
    paddingVertical: 8,
    color: '#2c2434',
    fontFamily: 'Helvetica',
    fontSize: 8,
    lineHeight: 1.2,
  },
  saleMeta: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 5,
  },
  metaField: {
    flexDirection: 'row',
    gap: 3,
    flexShrink: 1,
  },
  metaLabel: {
    color: '#938c9e',
    fontFamily: 'Helvetica-Bold',
    fontSize: 6.5,
    textTransform: 'uppercase',
  },
  metaValue: {
    color: '#2c2434',
    fontFamily: 'Helvetica',
    fontSize: 7,
  },
  customerBlock: {
    marginTop: 4,
  },
  section: {
    marginTop: 8,
  },
});
