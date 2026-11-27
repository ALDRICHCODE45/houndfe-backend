/**
 * customers-bulk-actions / T3 (S5) — `POST /customers/bulk/statements`
 * (`docs/proposals/customers-bulk-actions-contract.md` §3 + owner L2,
 * frontend L3.3).
 *
 * 1. One run per process (`CustomerBulkStatementsRunGuard` → `429
 *    BULK_EXPORT_BUSY`), held for the whole run and time-bounded: the run
 *    (each render included) is raced against a 120 s deadline (`503
 *    BULK_EXPORT_TIMEOUT`) and the client abort, so a stuck read / render or
 *    a disconnect frees the slot at once (review R4-001).
 * 2. The selection is resolved by the shared resolver: cap 50 (owner L2.1),
 *    `name` order (`lower(firstName)`, `lower(lastName)`, `id`), 0 customers
 *    → `400 BULK_SELECTION_EMPTY`; ids mode is strict (`404
 *    BULK_CUSTOMERS_NOT_FOUND`).
 * 3. Every resolved customer gets a PDF, movements or not (owner L2.3),
 *    through `renderCustomerStatementPdfFor` — the single route's path, so
 *    each entry is what `GET /customers/:id/statement/pdf` returns for that
 *    customer and period (owner L2.2). One render at a time, yielding to the
 *    event loop between renders (`setImmediate`), so other requests run in
 *    between. After a deadline or client abort the run signal fires: the
 *    loop never starts another render, and a late render result is ignored.
 * 4. A customer deleted mid-run (the single path's `404 CUSTOMER_NOT_FOUND`)
 *    → `404 BULK_CUSTOMERS_NOT_FOUND` with that id (§3.5). A render failure
 *    → `500 PDF_GENERATION_FAILED` for the whole request. The ZIP is built in
 *    memory before anything is sent: never half a ZIP.
 * 5. One structured log line per run (`customers.bulk.statements`): user,
 *    tenant, mode, period, count, outcome / code, size, render and total
 *    durations. No customer data and no customer ids (owner L5: no audit
 *    table for now).
 */
import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  bulkCustomersNotFound,
  CustomerBulkSelectionResolver,
  type CustomerBulkSelectionOptions,
} from '../customers/bulk';
import { PdfGenerationService } from '../pdf-generation/pdf-generation.service';
import { buildZip, type ZipEntryInput } from '../shared/zip';
import {
  BulkExportBusyException,
  BulkExportTimeoutException,
  BulkStatementsAbortedError,
  BULK_STATEMENTS_RUN_DEADLINE_MS,
  CustomerBulkStatementsRunGuard,
} from './customer-bulk-statements.busy-guard';
import {
  allocateStatementEntryNames,
  buildBulkStatementsZipFilename,
  businessWallClock,
} from './customer-bulk-statements.naming';
import { CustomerStatementService } from './customer-statement.service';
import type { CustomerBulkStatementsBodyDto } from './dto/customer-bulk-statements.dto';
import { renderCustomerStatementPdfFor } from './sales-customer-statement.controller';
import { SALES_CLOCK } from './sales.service';

/** Owner L2.1: 50 PDFs per download. */
export const BULK_STATEMENTS_MAX_CUSTOMERS = 50;

const DEFAULT_BUSINESS_TIMEZONE = 'America/Mexico_City';
const LOG_EVENT = 'customers.bulk.statements';

// Defined next to the run guard (which raises it); re-exported for callers.
export { BulkStatementsAbortedError };

export interface CustomerBulkStatementsActor {
  userId: string;
  tenantId: string | null;
}

export interface CustomerBulkStatementsResult {
  filename: string;
  zip: Buffer;
  count: number;
  entryNames: string[];
}

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

function errorCode(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (response && typeof response === 'object') {
      const body = response as {
        code?: unknown;
        error?: unknown;
        message?: unknown;
      };
      if (typeof body.code === 'string') return body.code;
      if (typeof body.message === 'string' && /^[A-Z_]+$/.test(body.message)) {
        return body.message;
      }
      if (typeof body.error === 'string') return body.error;
    }
    return `HTTP_${error.getStatus()}`;
  }
  return error instanceof Error ? error.name : 'UNKNOWN';
}

function isCustomerNotFound(error: unknown): boolean {
  if (!(error instanceof HttpException) || error.getStatus() !== 404) {
    return false;
  }
  const response = error.getResponse();
  return (
    typeof response === 'object' &&
    response !== null &&
    (response as { error?: unknown }).error === 'CUSTOMER_NOT_FOUND'
  );
}

@Injectable()
export class CustomerBulkStatementsService {
  private readonly logger = new Logger('CustomersBulkStatements');

  constructor(
    private readonly resolver: CustomerBulkSelectionResolver,
    private readonly statementService: CustomerStatementService,
    private readonly pdfGenerationService: PdfGenerationService,
    private readonly runGuard: CustomerBulkStatementsRunGuard,
    @Optional()
    private readonly config?: ConfigService,
    @Optional()
    @Inject(SALES_CLOCK)
    private readonly clock?: () => Date,
  ) {}

  async build(
    body: CustomerBulkStatementsBodyDto,
    ability: CustomerBulkSelectionOptions['ability'],
    actor: CustomerBulkStatementsActor,
    options: { signal?: AbortSignal } = {},
  ): Promise<CustomerBulkStatementsResult> {
    const startedAt = performance.now();
    const base = {
      event: LOG_EVENT,
      userId: actor.userId,
      tenantId: actor.tenantId,
      mode: body.selection.mode,
      from: body.from,
      to: body.to,
    };
    const renderMs: number[] = [];
    const elapsed = () => Math.round(performance.now() - startedAt);
    try {
      const result = await this.runGuard.run(
        (runSignal) => this.run(body, ability, renderMs, runSignal),
        {
          signal: options.signal,
          deadlineMs: BULK_STATEMENTS_RUN_DEADLINE_MS,
        },
      );
      this.logger.log(
        JSON.stringify({
          ...base,
          outcome: 'ok',
          count: result.count,
          zipBytes: result.zip.length,
          renderMsTotal: Math.round(sum(renderMs)),
          renderMsMax: Math.round(Math.max(0, ...renderMs)),
          durationMs: elapsed(),
        }),
      );
      return result;
    } catch (error) {
      const outcome =
        error instanceof BulkExportBusyException
          ? 'busy'
          : error instanceof BulkStatementsAbortedError
            ? 'aborted'
            : error instanceof BulkExportTimeoutException
              ? 'timeout'
              : error instanceof HttpException && error.getStatus() < 500
                ? 'rejected'
                : 'failed';
      this.logger.warn(
        JSON.stringify({
          ...base,
          outcome,
          code: errorCode(error),
          rendered: renderMs.length,
          durationMs: elapsed(),
        }),
      );
      throw error;
    }
  }

  private async run(
    body: CustomerBulkStatementsBodyDto,
    ability: CustomerBulkSelectionOptions['ability'],
    renderMs: number[],
    /** Fires on the run deadline or the client abort (run guard). */
    signal: AbortSignal,
  ): Promise<CustomerBulkStatementsResult> {
    const resolved = await this.resolver.resolve(body.selection, {
      ability,
      max: BULK_STATEMENTS_MAX_CUSTOMERS,
      sortBy: 'name',
      sortOrder: 'asc',
      rejectEmpty: true,
    });
    if (signal.aborted) throw new BulkStatementsAbortedError();
    const customers = await this.resolver.readRows(resolved);
    const names = allocateStatementEntryNames(customers);
    const range = { from: body.from, to: body.to };
    const deps = {
      statementService: this.statementService,
      pdfGenerationService: this.pdfGenerationService,
    };

    const entries: ZipEntryInput[] = [];
    for (const [index, customer] of customers.entries()) {
      if (signal.aborted) throw new BulkStatementsAbortedError();
      const t0 = performance.now();
      let data: Buffer;
      try {
        data = await renderCustomerStatementPdfFor(deps, customer.id, range);
      } catch (error) {
        if (isCustomerNotFound(error))
          throw bulkCustomersNotFound([customer.id]);
        throw error;
      }
      // Stopped while this render was stuck: drop its late result.
      if (signal.aborted) throw new BulkStatementsAbortedError();
      renderMs.push(performance.now() - t0);
      entries.push({ name: names[index], data });
      // Let other requests run between two renders (contract §3.3 guard 1).
      await yieldToEventLoop();
    }
    if (signal.aborted) throw new BulkStatementsAbortedError();

    const zip = buildZip(entries, {
      compression: 'deflate',
      now: businessWallClock(this.now(), this.timeZone()),
    });
    return {
      filename: buildBulkStatementsZipFilename(range),
      zip,
      count: entries.length,
      entryNames: names,
    };
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

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
