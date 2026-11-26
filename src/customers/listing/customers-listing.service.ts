import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_BUSINESS_TIMEZONE,
  overdueCutoff,
} from './customer-sales-metrics.sql';
import {
  CUSTOMERS_LISTING_READER,
  type CustomersListingReadInput,
  type CustomersListingReader,
  type CustomersListingResponse,
} from './customer-listing.types';
import type { CustomersListingQueryDto } from './customers-listing-query.dto';
import { assertListingParamsPermitted } from './customers-listing.permissions';

/** Clock seam (`() => Date`); absent → system clock. Tests inject a fixed one. */
export const CUSTOMERS_LISTING_CLOCK = Symbol('CUSTOMERS_LISTING_CLOCK');

/** The slice of the CASL ability the listing needs (`request.ability`). */
export interface ListingAbility {
  can(action: string, subject: string): boolean;
}

/**
 * customers-listing / T1 — `GET /customers/listing`
 * (`docs/proposals/customers-list-contract.md` §2, §3, §10.1).
 */
@Injectable()
export class CustomersListingService {
  constructor(
    @Inject(CUSTOMERS_LISTING_READER)
    private readonly reader: CustomersListingReader,
    private readonly config: ConfigService,
    @Optional()
    @Inject(CUSTOMERS_LISTING_CLOCK)
    private readonly clock?: () => Date,
  ) {}

  async list(
    query: CustomersListingQueryDto,
    ability: ListingAbility,
  ): Promise<CustomersListingResponse> {
    // §10.1: read:Customer is the route guard; read:Sale decides the data.
    const canReadSale = ability.can('read', 'Sale');
    assertListingParamsPermitted(
      query as unknown as Record<string, unknown>,
      canReadSale,
    );

    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const input: CustomersListingReadInput = {
      filters: { search: query.search },
      sortBy: query.sortBy ?? 'createdAt',
      sortOrder: query.sortOrder ?? 'desc',
      page,
      limit,
      // §2.1: the cut-off is computed once per request, as GET /sales does.
      metrics: canReadSale
        ? { overdueBefore: overdueCutoff(this.now(), this.timeZone()) }
        : null,
    };

    // §12.2: the page and the totals are two statements, run in parallel.
    const [data, filterSummary] = await Promise.all([
      this.reader.findPage(input),
      this.reader.summarize(input),
    ]);
    const total = filterSummary.count;
    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      },
      filterSummary,
    };
  }

  private now(): Date {
    return this.clock ? this.clock() : new Date();
  }

  /** `PROMOTIONS_BUSINESS_TIMEZONE`, default Mexico City (as GET /sales). */
  private timeZone(): string {
    return (
      this.config.get<string>('PROMOTIONS_BUSINESS_TIMEZONE') ??
      DEFAULT_BUSINESS_TIMEZONE
    );
  }
}
