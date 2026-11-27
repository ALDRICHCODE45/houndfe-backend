/**
 * customers-listing / T1 — types of `GET /customers/listing`
 * (`docs/proposals/customers-list-contract.md` §2, §3).
 */
import type { CustomersListingOptionField } from './customers-listing-options-query.dto';
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
  /**
   * Present only when a §4.4 location filter is active: the customer's
   * oldest address that matches every active location filter.
   */
  matchedAddressId?: string;
  metrics?: CustomerSalesMetrics;
}

/**
 * The filters composed into the listing WHERE (contract §4). Absent = no
 * filter; an empty CSV list is never forwarded.
 *
 * Customer-level ones (pets, location, commercial, `createdFrom/To`) become
 * `customerFilterConditions`; the metric ones (§4.1, §4.2 marked M) become
 * `metricFilterConditions` (both in `customers-listing.sql.ts`).
 */
export interface CustomerListingFilters {
  search?: string;
  // §4.1 (metric)
  hasDebt?: boolean;
  openDebtMin?: number;
  openDebtMax?: number;
  hasOverdue?: boolean;
  overdueMoreThanDays?: number;
  oldestOverdueFrom?: Date;
  oldestOverdueTo?: Date;
  // §4.2 (metric, except createdFrom/To)
  totalSoldMin?: number;
  totalSoldMax?: number;
  salesCountMin?: number;
  salesCountMax?: number;
  averageTicketMin?: number;
  averageTicketMax?: number;
  lastPurchaseFrom?: Date;
  lastPurchaseTo?: Date;
  noPurchaseMoreThanDays?: number;
  createdFrom?: Date;
  createdTo?: Date;
  // §4.3
  petSpecies?: string[];
  petSize?: string[];
  activePetsMin?: number;
  activePetsMax?: number;
  hasPets?: boolean;
  // §4.4
  neighborhood?: string[];
  municipality?: string[];
  city?: string[];
  zipCode?: string[];
  deliveryZoneType?: string[];
  deliveryZoneNone?: boolean;
  // §4.5
  priceListId?: string[];
  priceListIncludeNull?: boolean;
  isTrusted?: boolean;
  hasRfc?: boolean;
  fiscalRegime?: string[];
  hasEmail?: boolean;
  hasPhone?: boolean;
  hasChatbotRequests?: boolean;
}

/** Every key of `CustomerListingFilters`, in contract order. */
export const CUSTOMER_LISTING_FILTER_KEYS = [
  'search',
  'hasDebt',
  'openDebtMin',
  'openDebtMax',
  'hasOverdue',
  'overdueMoreThanDays',
  'oldestOverdueFrom',
  'oldestOverdueTo',
  'totalSoldMin',
  'totalSoldMax',
  'salesCountMin',
  'salesCountMax',
  'averageTicketMin',
  'averageTicketMax',
  'lastPurchaseFrom',
  'lastPurchaseTo',
  'noPurchaseMoreThanDays',
  'createdFrom',
  'createdTo',
  'petSpecies',
  'petSize',
  'activePetsMin',
  'activePetsMax',
  'hasPets',
  'neighborhood',
  'municipality',
  'city',
  'zipCode',
  'deliveryZoneType',
  'deliveryZoneNone',
  'priceListId',
  'priceListIncludeNull',
  'isTrusted',
  'hasRfc',
  'fiscalRegime',
  'hasEmail',
  'hasPhone',
  'hasChatbotRequests',
] as const satisfies ReadonlyArray<keyof CustomerListingFilters>;

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
   * of `GET /sales` (00:00Z of today's local date in the business timezone;
   * its UTC date IS the local today the §4 N-day filters count from) and that
   * timezone (local date of `lastPurchaseAt` for `noPurchaseMoreThanDays`).
   */
  metrics: { overdueBefore: Date; timeZone: string } | null;
  /**
   * customers-bulk-actions — INTERNAL id conditions of the bulk selection
   * (`src/customers/bulk`), never a public listing param. `include`: only
   * these customers (ids mode); `exclude`: never these (filter mode +
   * `excludeIds`). Absent (the listing) = no id condition at all, so the
   * `GET /customers/listing` statements are unchanged.
   */
  ids?: CustomerListingIdConditions;
}

export interface CustomerListingIdConditions {
  include?: string[];
  exclude?: string[];
}

export interface CustomersListingSummary {
  count: number;
  openDebtCents?: number;
  overdueDebtCents?: number;
}

/** Contract §5 — one selector value. */
export interface CustomersListingOption {
  value: string;
  customersCount: number;
}

export interface CustomersListingOptionsInput {
  field: CustomersListingOptionField | `${CustomersListingOptionField}`;
  /** Trimmed; `undefined` = no `contains` filter. */
  q: string | undefined;
  limit: number;
}

export interface CustomersListingOptionsResponse {
  field: CustomersListingOptionField | `${CustomersListingOptionField}`;
  data: CustomersListingOption[];
}

export interface CustomersListingReader {
  findPage(input: CustomersListingReadInput): Promise<CustomerListingRow[]>;
  summarize(input: CustomersListingReadInput): Promise<CustomersListingSummary>;
  listOptions(
    input: CustomersListingOptionsInput,
  ): Promise<CustomersListingOption[]>;
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
