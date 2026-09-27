/**
 * AnalyticsModule — read-only analytics bounded context
 * (branch-analytics-summary / bas-3a; OI-2 / S4 adds the timeseries slice;
 * seller-sales-report / v1 adds the per-seller report slice).
 *
 * Imports `DatabaseModule` + `AuthModule`; binds
 * `BRANCH_SALES_SUMMARY_REPOSITORY` to `PrismaBranchSalesSummaryRepository`,
 * `BRANCH_SALES_TIMESERIES_REPOSITORY` to
 * `PrismaBranchSalesTimeseriesRepository` and
 * `SELLER_SALES_REPORT_REPOSITORY` to
 * `PrismaSellerSalesReportRepository`, alongside the three application
 * services. Registered once in `src/app.module.ts`; nothing is exported because
 * no other module consumes these providers.
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AnalyticsController } from './presentation/analytics.controller';
import { BranchSalesSummaryService } from './application/branch-sales-summary.service';
import { BranchSalesTimeseriesService } from './application/branch-sales-timeseries.service';
import { SellerSalesReportService } from './application/seller-sales-report.service';
import { PrismaBranchSalesSummaryRepository } from './infrastructure/prisma-branch-sales-summary.repository';
import { PrismaBranchSalesTimeseriesRepository } from './infrastructure/prisma-branch-sales-timeseries.repository';
import { PrismaSellerSalesReportRepository } from './infrastructure/prisma-seller-sales-report.repository';
import { BRANCH_SALES_SUMMARY_REPOSITORY } from './domain/branch-sales-summary.repository';
import { BRANCH_SALES_TIMESERIES_REPOSITORY } from './domain/branch-sales-timeseries.repository';
import { SELLER_SALES_REPORT_REPOSITORY } from './domain/seller-sales-report.repository';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [AnalyticsController],
  providers: [
    BranchSalesSummaryService,
    BranchSalesTimeseriesService,
    SellerSalesReportService,
    {
      provide: BRANCH_SALES_SUMMARY_REPOSITORY,
      useClass: PrismaBranchSalesSummaryRepository,
    },
    {
      provide: BRANCH_SALES_TIMESERIES_REPOSITORY,
      useClass: PrismaBranchSalesTimeseriesRepository,
    },
    {
      provide: SELLER_SALES_REPORT_REPOSITORY,
      useClass: PrismaSellerSalesReportRepository,
    },
  ],
})
export class AnalyticsModule {}
