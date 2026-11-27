/**
 * customers-bulk-actions / T1 (S1) — resolves a bulk selection
 * (`docs/proposals/customers-bulk-actions-contract.md` §2) into the customers
 * it designates, reusing the `GET /customers/listing` SQL, filter semantics,
 * validation errors and §10.1 metric-param permission rule.
 *
 * Shared by `POST /customers/bulk/export` (this module) and the bulk
 * statements (T3), which imports it from `CustomersModule`'s exports.
 *
 * Check order (contract §7): filter validation → permission params →
 * selection resolution (ids mode: strict 404) → size → (caller) generation.
 *
 * Usage:
 *   const resolved = await resolver.resolve(dto.selection, {
 *     ability: req.ability, max: 50, sortBy: 'name', sortOrder: 'asc',
 *     rejectEmpty: true,
 *   });
 *   const ids = await resolver.readIds(resolved);     // or readRows(resolved)
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_BUSINESS_TIMEZONE,
  overdueCutoff,
} from '../listing/customer-sales-metrics.sql';
import {
  CUSTOMERS_LISTING_READER,
  type CustomerListingRow,
  type CustomersListingReadInput,
  type CustomersListingReader,
  type CustomersListingSortOrder,
} from '../listing/customer-listing.types';
import type { CustomersListingSortBy } from '../listing/customers-listing-query.dto';
import { assertListingParamsPermitted } from '../listing/customers-listing.permissions';
import {
  CUSTOMERS_LISTING_CLOCK,
  type ListingAbility,
} from '../listing/customers-listing.service';
import { parseCustomerBulkFilter } from './customer-bulk-filter';
import {
  CustomerBulkSelectionMode,
  type CustomerBulkSelectionDto,
} from './customer-bulk-selection.dto';
import {
  CUSTOMER_BULK_SELECTION_READER,
  type CustomerBulkSelectionReader,
} from './customer-bulk-selection.reader';
import {
  bulkCustomersNotFound,
  bulkSelectionEmpty,
  bulkSelectionTooLarge,
} from './customer-bulk.errors';

export interface CustomerBulkSelectionOptions {
  /** `request.ability`: `read:Sale` decides metrics and metric params. */
  ability: ListingAbility;
  /** The action's cap: more resolved customers → `400 BULK_SELECTION_TOO_LARGE`. */
  max: number;
  /** Listing sort key; default `createdAt`. Metric keys need `read:Sale`. */
  sortBy?: CustomersListingSortBy | `${CustomersListingSortBy}`;
  /** Default `desc`. */
  sortOrder?: CustomersListingSortOrder;
  /** `true` → 0 resolved customers is `400 BULK_SELECTION_EMPTY`. */
  rejectEmpty?: boolean;
}

export interface ResolvedCustomerSelection {
  mode: `${CustomerBulkSelectionMode}`;
  /** Resolved customers (after filter, exclusions, dedupe); 0 ≤ count ≤ max. */
  count: number;
  /** The caller holds `read:Sale`: rows carry `metrics`. */
  canReadSale: boolean;
  max: number;
  /** The listing read input (page 1, limit max + 1) the rows are read with. */
  input: CustomersListingReadInput;
}

/** Order-preserving dedupe. */
function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

@Injectable()
export class CustomerBulkSelectionResolver {
  constructor(
    @Inject(CUSTOMERS_LISTING_READER)
    private readonly reader: CustomersListingReader,
    @Inject(CUSTOMER_BULK_SELECTION_READER)
    private readonly selectionReader: CustomerBulkSelectionReader,
    private readonly config: ConfigService,
    @Optional()
    @Inject(CUSTOMERS_LISTING_CLOCK)
    private readonly clock?: () => Date,
  ) {}

  /**
   * Validates the selection against the listing rules and the caller's
   * permissions, checks ids-mode existence and the cap. Reads only ids and a
   * count; the rows are read by `readRows` / `readIds`.
   */
  async resolve(
    selection: CustomerBulkSelectionDto,
    options: CustomerBulkSelectionOptions,
  ): Promise<ResolvedCustomerSelection> {
    const isIds = selection.mode === CustomerBulkSelectionMode.ids;
    const filters = isIds
      ? {}
      : parseCustomerBulkFilter(selection.filter ?? {});
    const sortBy = options.sortBy ?? 'createdAt';
    const sortOrder = options.sortOrder ?? 'desc';

    // §10.1 (listing rule): `field` = first metric filter, then `sortBy`.
    const canReadSale = options.ability.can('read', 'Sale');
    assertListingParamsPermitted({ ...filters, sortBy }, canReadSale);

    let ids: CustomersListingReadInput['ids'];
    if (isIds) {
      const requested = unique(selection.customerIds ?? []);
      const existing = new Set(
        await this.selectionReader.findExistingIds(requested),
      );
      const missing = requested.filter((id) => !existing.has(id));
      if (missing.length > 0) throw bulkCustomersNotFound(missing);
      ids = { include: requested };
    } else {
      const exclude = unique(selection.excludeIds ?? []);
      ids = exclude.length > 0 ? { exclude } : undefined;
    }

    const input: CustomersListingReadInput = {
      filters,
      ...(ids ? { ids } : {}),
      sortBy,
      sortOrder,
      page: 1,
      // One past the cap: `readRows` detects customers created after the count.
      limit: options.max + 1,
      metrics: canReadSale
        ? {
            overdueBefore: overdueCutoff(this.now(), this.timeZone()),
            timeZone: this.timeZone(),
          }
        : null,
    };

    // §4.5: count first with the listing summary statement, so an oversized
    // selection fails before any row is read.
    const { count } = await this.reader.summarize(input);
    if (count > options.max) throw bulkSelectionTooLarge(count, options.max);
    if (count === 0 && options.rejectEmpty) throw bulkSelectionEmpty();

    return {
      mode: selection.mode,
      count,
      canReadSale,
      max: options.max,
      input,
    };
  }

  /**
   * The listing rows of the selection, in the requested order (`metrics`
   * only with `read:Sale`). Re-checks the cap and, in ids mode, that no
   * customer was deleted since `resolve`.
   */
  async readRows(
    resolved: ResolvedCustomerSelection,
  ): Promise<CustomerListingRow[]> {
    const rows = await this.reader.findPage(resolved.input);
    if (rows.length > resolved.max) {
      throw bulkSelectionTooLarge(rows.length, resolved.max);
    }
    const include = resolved.input.ids?.include;
    if (include && rows.length < include.length) {
      const read = new Set(rows.map((row) => row.id));
      throw bulkCustomersNotFound(include.filter((id) => !read.has(id)));
    }
    return rows;
  }

  /** The customer ids of the selection, in the requested order. */
  async readIds(resolved: ResolvedCustomerSelection): Promise<string[]> {
    return (await this.readRows(resolved)).map((row) => row.id);
  }

  private now(): Date {
    return this.clock ? this.clock() : new Date();
  }

  /** `PROMOTIONS_BUSINESS_TIMEZONE`, default Mexico City (as the listing). */
  private timeZone(): string {
    return (
      this.config.get<string>('PROMOTIONS_BUSINESS_TIMEZONE') ??
      DEFAULT_BUSINESS_TIMEZONE
    );
  }
}
