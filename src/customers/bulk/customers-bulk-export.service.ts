/**
 * customers-bulk-actions / T1 (S2) — `POST /customers/bulk/export`
 * (`docs/proposals/customers-bulk-actions-contract.md` §4, owner L2.1, L2.5,
 * L5).
 *
 * The selection is resolved with the listing SQL (count first, then one
 * statement for the rows), the CSV is built in memory, and nothing is sent
 * before it is complete. Above 10,000 rows the request fails with
 * `400 BULK_SELECTION_TOO_LARGE` instead of a truncated file. One structured
 * log line per export (no audit table for now, owner L5): who, branch, mode,
 * row count, sort, duration, outcome — never customer data or ids. A caller
 * the route guard lets through but the explicit `export:Customer` check
 * rejects is logged by `logDenied` (outcome `forbidden`).
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DEFAULT_BUSINESS_TIMEZONE } from '../listing/customer-sales-metrics.sql';
import {
  CUSTOMERS_LISTING_CLOCK,
  type ListingAbility,
} from '../listing/customers-listing.service';
import { CustomerBulkSelectionResolver } from './customer-bulk-selection.resolver';
import { buildCustomersCsv, formatLocalDate } from './customers-csv';
import type { CustomersBulkExportBodyDto } from './customers-bulk-export.dto';

/** Owner L2.1: «10.000 filas por CSV». */
export const CUSTOMERS_CSV_MAX_ROWS = 10_000;

export interface CustomersBulkExportActor {
  userId: string;
  tenantId: string | null;
}

export interface CustomersBulkExportResult {
  /** `clientes-<local YYYY-MM-DD>.csv`. */
  filename: string;
  csv: Buffer;
  rowCount: number;
  withMetrics: boolean;
}

function errorCode(error: unknown): string {
  const response = (
    error as { getResponse?: () => unknown } | null
  )?.getResponse?.();
  if (response && typeof response === 'object' && 'code' in response) {
    return String((response as { code: unknown }).code);
  }
  return error instanceof Error ? error.name : 'UNKNOWN';
}

@Injectable()
export class CustomersBulkExportService {
  private readonly logger = new Logger('CustomersBulkExport');

  constructor(
    private readonly resolver: CustomerBulkSelectionResolver,
    private readonly config: ConfigService,
    @Optional()
    @Inject(CUSTOMERS_LISTING_CLOCK)
    private readonly clock?: () => Date,
  ) {}

  async export(
    body: CustomersBulkExportBodyDto,
    ability: ListingAbility,
    actor: CustomersBulkExportActor,
  ): Promise<CustomersBulkExportResult> {
    const startedAt = Date.now();
    const sortBy = body.sortBy ?? 'createdAt';
    const sortOrder = body.sortOrder ?? 'desc';
    const base = {
      event: 'customers.bulk.export',
      tenantId: actor.tenantId,
      userId: actor.userId,
      mode: body.selection.mode,
      sortBy,
      sortOrder,
    };
    try {
      const resolved = await this.resolver.resolve(body.selection, {
        ability,
        max: CUSTOMERS_CSV_MAX_ROWS,
        sortBy: body.sortBy,
        sortOrder: body.sortOrder,
      });
      const rows = await this.resolver.readRows(resolved);
      const timeZone = this.timeZone();
      const csv = buildCustomersCsv(rows, {
        withMetrics: resolved.canReadSale,
        timeZone,
      });
      const result: CustomersBulkExportResult = {
        filename: `clientes-${formatLocalDate(this.now(), timeZone)}.csv`,
        csv,
        rowCount: rows.length,
        withMetrics: resolved.canReadSale,
      };
      this.logger.log(
        JSON.stringify({
          ...base,
          outcome: 'ok',
          rowCount: result.rowCount,
          withMetrics: result.withMetrics,
          bytes: csv.length,
          durationMs: Date.now() - startedAt,
        }),
      );
      return result;
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          ...base,
          outcome: 'rejected',
          code: errorCode(error),
          durationMs: Date.now() - startedAt,
        }),
      );
      throw error;
    }
  }

  /**
   * One `forbidden` warn line for a request rejected by the explicit
   * `export:Customer` check (R3-denied-export-unlogged): who, branch, mode and
   * a reason code — never the selection itself.
   */
  logDenied(
    body: CustomersBulkExportBodyDto,
    actor: CustomersBulkExportActor,
    reason: string,
  ): void {
    this.logger.warn(
      JSON.stringify({
        event: 'customers.bulk.export',
        tenantId: actor.tenantId,
        userId: actor.userId,
        mode: body.selection.mode,
        outcome: 'forbidden',
        code: 'INSUFFICIENT_PERMISSIONS',
        reason,
      }),
    );
  }

  private now(): Date {
    return this.clock ? this.clock() : new Date();
  }

  private timeZone(): string {
    return (
      this.config.get<string>('PROMOTIONS_BUSINESS_TIMEZONE') ??
      DEFAULT_BUSINESS_TIMEZONE
    );
  }
}
