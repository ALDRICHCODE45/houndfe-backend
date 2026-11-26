/**
 * customers-listing T4 (S4, contract §6.2) — the customer page KPI strip:
 * `{ customerId, metrics }` with EXACTLY the listing row rules (§2.1). The
 * metrics come from the shared fragment `customerSalesMetricsSql` and its
 * mapper; the overdue cut-off is computed once per request with the
 * `GET /sales` rule (`overdueCutoff`, `PROMOTIONS_BUSINESS_TIMEZONE`, default
 * Mexico City). Only pure functions are imported from the customers module,
 * so `SalesModule` does not import `CustomersModule`.
 *
 * Unknown or foreign-tenant customer → `404 CUSTOMER_NOT_FOUND`, the
 * code-only envelope of the other customer sales routes.
 */
import { HttpException, Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CustomerSalesMetrics } from '../customers/listing/customer-listing.types';
import {
  DEFAULT_BUSINESS_TIMEZONE,
  overdueCutoff,
  toCustomerSalesMetrics,
} from '../customers/listing/customer-sales-metrics.sql';
import {
  CUSTOMER_SALES_SUMMARY_READER,
  type ICustomerSalesSummaryReader,
} from './customer-sales-summary.reader';
import { SALES_CLOCK } from './sales.service';

export interface CustomerSalesSummaryResponse {
  customerId: string;
  metrics: CustomerSalesMetrics;
}

function customerNotFound(): HttpException {
  return new HttpException(
    {
      statusCode: 404,
      error: 'CUSTOMER_NOT_FOUND',
      message: 'CUSTOMER_NOT_FOUND',
    },
    404,
  );
}

@Injectable()
export class CustomerSalesSummaryService {
  constructor(
    @Inject(CUSTOMER_SALES_SUMMARY_READER)
    private readonly reader: ICustomerSalesSummaryReader,
    @Optional()
    private readonly config?: ConfigService,
    @Optional()
    @Inject(SALES_CLOCK)
    private readonly clock?: () => Date,
  ) {}

  async summary(customerId: string): Promise<CustomerSalesSummaryResponse> {
    const overdueBefore = overdueCutoff(this.now(), this.timeZone());
    const raw = await this.reader.read(customerId, overdueBefore);
    if (!raw) throw customerNotFound();
    return { customerId, metrics: toCustomerSalesMetrics(raw) };
  }

  private now(): Date {
    return this.clock ? this.clock() : new Date();
  }

  private timeZone(): string {
    return (
      this.config?.get<string>('PROMOTIONS_BUSINESS_TIMEZONE') ??
      DEFAULT_BUSINESS_TIMEZONE
    );
  }
}
