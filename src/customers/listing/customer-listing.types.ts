/**
 * customers-listing / T1 — types of `GET /customers/listing`
 * (`docs/proposals/customers-list-contract.md` §2, §3).
 */
import type { CustomersListingSortBy } from './customers-listing-query.dto';

/** Contract §2.1 — counts/sums 0 and dates/average `null` without sales. */
export interface CustomerSalesMetrics {
  openDebtCents: number;
  overdueDebtCents: number;
  overdueCount: number;
  /** `YYYY-MM-DD`: the UTC date of the oldest overdue `dueDate`. */
  oldestOverdueDueDate: string | null;
  salesCount: number;
  totalSoldCents: number;
  /** `round(totalSoldCents / salesCount)` half up; `null` without sales. */
  averageTicketCents: number | null;
  /** Max `confirmedAt` as an ISO instant. */
  lastPurchaseAt: string | null;
}

export interface CustomerListingPrimaryAddress {
  id: string;
  neighborhood: string | null;
  municipality: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
}

/** Contract §2 row. `metrics` is ABSENT (not null) without `read:Sale`. */
export interface CustomerListingRow {
  id: string;
  firstName: string;
  lastName: string | null;
  businessName: string | null;
  phoneCountryCode: string | null;
  phone: string | null;
  email: string | null;
  globalPriceList: { id: string; name: string } | null;
  rfc: string | null;
  fiscalRegime: string | null;
  preferredPaymentMethod: string | null;
  isTrusted: boolean;
  createdAt: string;
  primaryAddress: CustomerListingPrimaryAddress | null;
  activePetsCount: number;
  petSpecies: string[];
  matchedPetName: string | null;
  metrics?: CustomerSalesMetrics;
}

/**
 * The filters composed into the listing WHERE (contract §4).
 *
 * T1 implements `search` (§4.6) only. T3 adds the §4.1–§4.5 filters here:
 * customer-level ones (pets, location, commercial, `createdFrom/To`) go into
 * `customerFilterConditions`, metric ones into `metricFilterConditions` and
 * `hasMetricFilters` (both in `customers-listing.sql.ts`).
 */
export interface CustomerListingFilters {
  search?: string;
}

export type CustomersListingSortOrder = 'asc' | 'desc';

export interface CustomersListingReadInput {
  filters: CustomerListingFilters;
  sortBy: CustomersListingSortBy | `${CustomersListingSortBy}`;
  sortOrder: CustomersListingSortOrder;
  page: number;
  limit: number;
  /**
   * `null` = the caller lacks `read:Sale`: no sales are read, rows carry no
   * `metrics` key and the summary is `{count}`. Otherwise the overdue cut-off
   * of `GET /sales` (00:00Z of today's local date in the business timezone).
   */
  metrics: { overdueBefore: Date } | null;
}

export interface CustomersListingSummary {
  count: number;
  openDebtCents?: number;
  overdueDebtCents?: number;
}

export interface CustomersListingReader {
  findPage(input: CustomersListingReadInput): Promise<CustomerListingRow[]>;
  summarize(input: CustomersListingReadInput): Promise<CustomersListingSummary>;
}

export const CUSTOMERS_LISTING_READER = Symbol('CUSTOMERS_LISTING_READER');

export interface CustomersListingResponse {
  data: CustomerListingRow[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  filterSummary: CustomersListingSummary;
}
