/**
 * APPLICATION: SellerSalesReportService (seller-sales-report / v1).
 *
 * Thin composition layer: exactly ONE `findBySeller` call, then a strict
 * projection into the frozen response. The confirmed summary is derived from
 * the complete bounded rows (never a separate count), every cent is validated
 * as a non-negative safe integer, and `generatedAt` is the generation time.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  ANALYTICS_TIME_ZONE,
  SELLER_REPORT_ATTRIBUTION,
  SELLER_REPORT_BALANCES,
  SELLER_SALES_REPORT_ROW_LIMIT,
} from '../domain/analytics.constants';
import {
  SELLER_SALES_REPORT_REPOSITORY,
  SellerSalesReportContractError,
  type ISellerSalesReportRepository,
  type SellerReportPaymentStatus,
  type SellerSalesReportCanceledRow,
  type SellerSalesReportConfirmedRow,
} from '../domain/seller-sales-report.repository';
import type { BranchSalesSummaryQueryDto } from '../dto/branch-sales-summary-query.dto';
import type {
  SellerSalesReportCanceledRowDto,
  SellerSalesReportConfirmedRowDto,
  SellerSalesReportResponseDto,
  SellerSalesReportSummaryDto,
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
