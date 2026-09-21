/**
 * APPLICATION: BranchSalesSummaryService (branch-analytics-summary / bas-3a).
 *
 * Thin composition layer: exactly ONE `aggregate({ from, to })` call plus the
 * canonical timezone/range attached to the metrics. No `tenantId` parameter
 * (tenant scope is implicit) and no accounting recomputation.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ANALYTICS_TIME_ZONE } from '../domain/analytics.constants';
import {
  BRANCH_SALES_SUMMARY_REPOSITORY,
  type IBranchSalesSummaryRepository,
} from '../domain/branch-sales-summary.repository';
import type { BranchSalesSummaryQueryDto } from '../dto/branch-sales-summary-query.dto';
import type { BranchSalesSummaryResponseDto } from '../dto/branch-sales-summary-response.dto';

@Injectable()
export class BranchSalesSummaryService {
  constructor(
    @Inject(BRANCH_SALES_SUMMARY_REPOSITORY)
    private readonly repository: IBranchSalesSummaryRepository,
  ) {}

  async summarize(
    query: BranchSalesSummaryQueryDto,
  ): Promise<BranchSalesSummaryResponseDto> {
    const metrics = await this.repository.aggregate({
      from: query.from,
      to: query.to,
    });

    return {
      timeZone: ANALYTICS_TIME_ZONE,
      from: query.from,
      to: query.to,
      grossSalesCents: metrics.grossSalesCents,
      netSalesCents: metrics.netSalesCents,
      collectedCents: metrics.collectedCents,
      outstandingDebtCents: metrics.outstandingDebtCents,
      saleCount: metrics.saleCount,
      averageTicketCents: metrics.averageTicketCents,
      settledRefundsCents: metrics.settledRefundsCents,
      pendingRefundObligationsCents: metrics.pendingRefundObligationsCents,
    };
  }
}
