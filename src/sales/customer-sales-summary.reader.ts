/**
 * customers-listing T4 (S4, contract §6.2) — port of the KPI strip read.
 */
import type { CustomerSalesMetricsRecord } from '../customers/listing/customer-sales-metrics.sql';

export const CUSTOMER_SALES_SUMMARY_READER = Symbol(
  'CUSTOMER_SALES_SUMMARY_READER',
);

export interface ICustomerSalesSummaryReader {
  /**
   * The customer's raw §2.1 metrics row (the listing fragment), or `null`
   * when the customer does not exist in the current tenant.
   */
  read(
    customerId: string,
    overdueBefore: Date,
  ): Promise<CustomerSalesMetricsRecord | null>;
}
