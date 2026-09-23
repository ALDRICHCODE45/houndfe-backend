/**
 * AnalyticsModule — read-only analytics bounded context
 * (branch-analytics-summary / bas-3a; OI-2 / S4 adds the timeseries slice).
 *
 * Imports `DatabaseModule` + `AuthModule`; binds
 * `BRANCH_SALES_SUMMARY_REPOSITORY` to `PrismaBranchSalesSummaryRepository`
 * and `BRANCH_SALES_TIMESERIES_REPOSITORY` to
 * `PrismaBranchSalesTimeseriesRepository`, alongside both application
 * services. Registered once in `src/app.module.ts`; nothing is exported because
 * no other module consumes these providers.
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AnalyticsController } from './presentation/analytics.controller';
import { BranchSalesSummaryService } from './application/branch-sales-summary.service';
import { BranchSalesTimeseriesService } from './application/branch-sales-timeseries.service';
import { PrismaBranchSalesSummaryRepository } from './infrastructure/prisma-branch-sales-summary.repository';
import { PrismaBranchSalesTimeseriesRepository } from './infrastructure/prisma-branch-sales-timeseries.repository';
import { BRANCH_SALES_SUMMARY_REPOSITORY } from './domain/branch-sales-summary.repository';
import { BRANCH_SALES_TIMESERIES_REPOSITORY } from './domain/branch-sales-timeseries.repository';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [AnalyticsController],
  providers: [
    BranchSalesSummaryService,
    BranchSalesTimeseriesService,
    {
      provide: BRANCH_SALES_SUMMARY_REPOSITORY,
      useClass: PrismaBranchSalesSummaryRepository,
    },
    {
      provide: BRANCH_SALES_TIMESERIES_REPOSITORY,
      useClass: PrismaBranchSalesTimeseriesRepository,
    },
  ],
})
export class AnalyticsModule {}
