/**
 * APPLICATION: SellerSalesReportService (seller-sales-report / v1).
 *
 * Thin composition layer: exactly ONE `findBySeller` call, then a strict
 * projection into the frozen response. The confirmed summary is derived from
 * the complete bounded rows (never a separate count), every cent is validated
 * as a non-negative safe integer, and `generatedAt` is the generation time.
 * `dailyTotals` is derived from the same confirmed rows (one zero-filled entry
 * per local day), so it always agrees with `confirmed.summary`; `topProducts`
 * and `previousPeriod` are validated projections of the same snapshot.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  ANALYTICS_TIME_ZONE,
  SELLER_REPORT_ATTRIBUTION,
  SELLER_REPORT_BALANCES,
  SELLER_SALES_REPORT_ROW_LIMIT,
  SELLER_SALES_REPORT_TOP_PRODUCTS_LIMIT,
} from '../domain/analytics.constants';
import { enumerateLocalCalendarDates } from '../domain/local-calendar-dates';
import {
  SELLER_SALES_REPORT_REPOSITORY,
  SellerSalesReportContractError,
  type ISellerSalesReportRepository,
  type SellerReportPaymentStatus,
  type SellerSalesReportCanceledRow,
  type SellerSalesReportConfirmedRow,
  type SellerSalesReportPreviousPeriod,
  type SellerSalesReportTopProduct,
} from '../domain/seller-sales-report.repository';
import type { BranchSalesSummaryQueryDto } from '../dto/branch-sales-summary-query.dto';
import type {
  SellerSalesReportCanceledRowDto,
  SellerSalesReportConfirmedRowDto,
  SellerSalesReportCustomerDto,
  SellerSalesReportDailyTotalDto,
  SellerSalesReportPreviousPeriodDto,
  SellerSalesReportResponseDto,
  SellerSalesReportSummaryDto,
  SellerSalesReportTopProductDto,
} from '../dto/seller-sales-report-response.dto';

const PAYMENT_STATUSES: readonly SellerReportPaymentStatus[] = [
  'PAID',
  'PARTIAL',
  'CREDIT',
];

/** Single non-negative safe-integer gate for every cent, count and sum. */
function nonNegativeSafeInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SellerSalesReportContractError(
      `Invalid non-negative integer for ${label}`,
    );
  }
  return value;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new SellerSalesReportContractError(`Invalid string for ${label}`);
  }
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : requiredText(value, label);
}

function customer(
  value: unknown,
  label: string,
): SellerSalesReportCustomerDto | null {
  if (value === null) return null;
  if (typeof value !== 'object') {
    throw new SellerSalesReportContractError(`Invalid customer for ${label}`);
  }
  const { id, name } = value as Record<string, unknown>;
  return {
    id: requiredText(id, `${label}.customer.id`),
    name: requiredText(name, `${label}.customer.name`),
  };
}

function validDate(value: unknown, label: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new SellerSalesReportContractError(`Invalid date for ${label}`);
  }
  return value;
}

function paymentStatus(
  value: unknown,
  label: string,
): SellerReportPaymentStatus {
  if (
    typeof value !== 'string' ||
    !PAYMENT_STATUSES.includes(value as SellerReportPaymentStatus)
  ) {
    throw new SellerSalesReportContractError(
      `Invalid paymentStatus for ${label}`,
    );
  }
  return value as SellerReportPaymentStatus;
}

@Injectable()
export class SellerSalesReportService {
  constructor(
    @Inject(SELLER_SALES_REPORT_REPOSITORY)
    private readonly repository: ISellerSalesReportRepository,
  ) {}

  async getSellerReport(
    sellerUserId: string,
    query: BranchSalesSummaryQueryDto,
  ): Promise<SellerSalesReportResponseDto> {
    const result = await this.repository.findBySeller(sellerUserId, {
      from: query.from,
      to: query.to,
    });

    if (result.seller.id !== sellerUserId) {
      throw new SellerSalesReportContractError(
        'Snapshot seller identity does not match the requested seller',
      );
    }

    const rows = result.confirmed.map((row) => this.confirmedRow(row));
    const canceledRows = result.canceled.map((row) => this.canceledRow(row));
    const rowCount = nonNegativeSafeInt(result.rowCount, 'rowCount');
    if (rowCount !== rows.length + canceledRows.length) {
      throw new SellerSalesReportContractError(
        'rowCount does not match the materialized rows',
      );
    }
    if (rowCount > SELLER_SALES_REPORT_ROW_LIMIT) {
      throw new SellerSalesReportContractError(
        'rowCount above the report cap reached the service',
      );
    }

    return {
      seller: {
        id: requiredText(result.seller.id, 'seller.id'),
        name: requiredText(result.seller.name, 'seller.name'),
      },
      tenantId: requiredText(result.tenantId, 'tenantId'),
      timeZone: ANALYTICS_TIME_ZONE,
      from: query.from,
      to: query.to,
      generatedAt: new Date().toISOString(),
      attribution: SELLER_REPORT_ATTRIBUTION,
      balances: SELLER_REPORT_BALANCES,
      rowLimit: SELLER_SALES_REPORT_ROW_LIMIT,
      rowCount,
      confirmed: {
        dateBasis: 'confirmedAt',
        summary: this.summarize(result.confirmed),
        rows,
      },
      canceled: {
        dateBasis: 'canceledAt',
        saleCount: canceledRows.length,
        rows: canceledRows,
      },
      topProducts: this.topProducts(result.topProducts),
      dailyTotals: this.dailyTotals(result.confirmed, query),
      previousPeriod: this.previousPeriod(result.previousPeriod, query),
    };
  }

  private confirmedRow(
    row: SellerSalesReportConfirmedRow,
  ): SellerSalesReportConfirmedRowDto {
    return {
      id: requiredText(row.id, 'confirmed.id'),
      folio: nullableText(row.folio, 'confirmed.folio'),
      confirmedAt: validDate(row.confirmedAt, 'confirmedAt').toISOString(),
      totalCents: nonNegativeSafeInt(row.totalCents, 'totalCents'),
      paidCents: nonNegativeSafeInt(row.paidCents, 'paidCents'),
      debtCents: nonNegativeSafeInt(row.debtCents, 'debtCents'),
      paymentStatus: paymentStatus(row.paymentStatus, 'confirmed'),
      customer: customer(row.customer, 'confirmed'),
    };
  }

  private canceledRow(
    row: SellerSalesReportCanceledRow,
  ): SellerSalesReportCanceledRowDto {
    return {
      id: requiredText(row.id, 'canceled.id'),
      folio: nullableText(row.folio, 'canceled.folio'),
      confirmedAt:
        row.confirmedAt === null
          ? null
          : validDate(row.confirmedAt, 'confirmedAt').toISOString(),
      canceledAt: validDate(row.canceledAt, 'canceledAt').toISOString(),
      totalCents: nonNegativeSafeInt(row.totalCents, 'totalCents'),
      customer: customer(row.customer, 'canceled'),
    };
  }

  private topProducts(
    rows: SellerSalesReportTopProduct[],
  ): SellerSalesReportTopProductDto[] {
    if (rows.length > SELLER_SALES_REPORT_TOP_PRODUCTS_LIMIT) {
      throw new SellerSalesReportContractError('Too many topProducts');
    }
    return rows.map((row) => ({
      productId: requiredText(row.productId, 'top.productId'),
      variantId: nullableText(row.variantId, 'top.variantId'),
      productName: requiredText(row.productName, 'top.productName'),
      variantName: nullableText(row.variantName, 'top.variantName'),
      quantity: nonNegativeSafeInt(row.quantity, 'top.quantity'),
      netSalesCents: nonNegativeSafeInt(row.netSalesCents, 'top.netSalesCents'),
    }));
  }

  /** One zero-filled entry per local day of `[from, to)`, summed like `summary`. */
  private dailyTotals(
    rows: SellerSalesReportConfirmedRow[],
    query: BranchSalesSummaryQueryDto,
  ): SellerSalesReportDailyTotalDto[] {
    const days = enumerateLocalCalendarDates(query.from, query.to).map(
      (date) => ({ date, saleCount: 0, netSalesCents: 0 }),
    );
    const byDate = new Map(days.map((day) => [day.date, day]));
    for (const row of rows) {
      const day = byDate.get(row.localDate);
      if (!day) {
        throw new SellerSalesReportContractError(
          'Confirmed row local date outside the requested range',
        );
      }
      day.saleCount += 1;
      day.netSalesCents = nonNegativeSafeInt(
        day.netSalesCents + nonNegativeSafeInt(row.totalCents, 'totalCents'),
        'dailyTotals.netSalesCents',
      );
    }
    return days;
  }

  private previousPeriod(
    period: SellerSalesReportPreviousPeriod,
    query: BranchSalesSummaryQueryDto,
  ): SellerSalesReportPreviousPeriodDto {
    if (period.to !== query.from || !(period.from < query.from)) {
      throw new SellerSalesReportContractError(
        'previousPeriod does not end at the report start',
      );
    }
    return {
      from: requiredText(period.from, 'previous.from'),
      to: period.to,
      saleCount: nonNegativeSafeInt(period.saleCount, 'previous.saleCount'),
      netSalesCents: nonNegativeSafeInt(
        period.netSalesCents,
        'previous.netSalesCents',
      ),
    };
  }

  private summarize(
    rows: SellerSalesReportConfirmedRow[],
  ): SellerSalesReportSummaryDto {
    let netSalesCents = 0;
    let collectedCents = 0;
    let outstandingDebtCents = 0;
    for (const row of rows) {
      netSalesCents += nonNegativeSafeInt(row.totalCents, 'totalCents');
      collectedCents += nonNegativeSafeInt(row.paidCents, 'paidCents');
      outstandingDebtCents += nonNegativeSafeInt(row.debtCents, 'debtCents');
    }
    const saleCount = rows.length;
    return {
      saleCount,
      netSalesCents: nonNegativeSafeInt(netSalesCents, 'netSalesCents'),
      collectedCents: nonNegativeSafeInt(collectedCents, 'collectedCents'),
      outstandingDebtCents: nonNegativeSafeInt(
        outstandingDebtCents,
        'outstandingDebtCents',
      ),
      averageTicketCents:
        saleCount === 0 ? 0 : Math.round(netSalesCents / saleCount),
    };
  }
}
