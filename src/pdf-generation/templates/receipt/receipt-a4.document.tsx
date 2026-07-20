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
        <ReceiptHeader {...business} folio={sale.folio} date={sale.date} />

        <View style={styles.saleDetails}>
          <MetaField label="Cajero" value={sale.cashier} />
          <MetaField label="Vendedor" value={sale.seller} />
        </View>

        <View style={styles.customer}>
          <CustomerSection customerName={customer.name} />
        </View>

        <Section title="Productos">
          <LineItemsTable items={items} />
        </Section>

        <Section title="Totales">
          <TotalsBlock {...totals} />
        </Section>

        <Section title="Pagos">
          <PaymentsList payments={payments} />
        </Section>

        <Text style={styles.footer}>Gracias por su compra.</Text>
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

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
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
    marginTop: 12,
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
  section: {
    marginTop: 14,
  },
  sectionTitle: {
    borderBottomColor: '#eceaf0',
    borderBottomWidth: 1,
    color: '#493f54',
    fontFamily: 'Helvetica-Bold',
    fontSize: 9,
    marginBottom: 6,
    paddingBottom: 3,
    textTransform: 'uppercase',
  },
  footer: {
    color: '#938c9e',
    fontSize: 8,
    marginTop: 18,
    textAlign: 'center',
  },
});
