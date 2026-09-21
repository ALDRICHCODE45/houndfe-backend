/**
 * AnalyticsModule — read-only analytics bounded context
 * (branch-analytics-summary / bas-3a).
 *
 * Imports `DatabaseModule` + `AuthModule`; binds
 * `BRANCH_SALES_SUMMARY_REPOSITORY` to `PrismaBranchSalesSummaryRepository`
 * alongside `BranchSalesSummaryService`. Registered once in `src/app.module.ts`.
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AnalyticsController } from './presentation/analytics.controller';
import { BranchSalesSummaryService } from './application/branch-sales-summary.service';
import { PrismaBranchSalesSummaryRepository } from './infrastructure/prisma-branch-sales-summary.repository';
import { BRANCH_SALES_SUMMARY_REPOSITORY } from './domain/branch-sales-summary.repository';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [AnalyticsController],
  providers: [
    BranchSalesSummaryService,
    {
      provide: BRANCH_SALES_SUMMARY_REPOSITORY,
      useClass: PrismaBranchSalesSummaryRepository,
    },
  ],
})
export class AnalyticsModule {}
