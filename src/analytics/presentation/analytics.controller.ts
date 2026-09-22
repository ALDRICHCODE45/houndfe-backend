/**
 * HTTP CONTROLLER: AnalyticsController (branch-analytics-summary / bas-3a;
 * OI-2 / S4 adds the daily timeseries route).
 *
 * Thin adapter: class-level `@UseGuards(JwtAuthGuard, TenantContextGuard,
 * PermissionsGuard)` in that exact order, `@RequirePermissions(['read',
 * 'Analytics'])`, and one `@Query()` delegation per route
 * (`BranchSalesSummaryService.summarize` for the summary,
 * `BranchSalesTimeseriesService.getTimeseries` for the timeseries). Tenant
 * scope comes from the JWT upstream — the handlers read no actor or tenant ID
 * from request parameters.
 *
 * Routes: GET /analytics/sales/summary and GET /analytics/sales/timeseries
 * → read:Analytics (HTTP 200).
 */
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import { BranchSalesSummaryService } from '../application/branch-sales-summary.service';
import { BranchSalesTimeseriesService } from '../application/branch-sales-timeseries.service';
import { BranchSalesSummaryQueryDto } from '../dto/branch-sales-summary-query.dto';
import { BranchSalesTimeseriesQueryDto } from '../dto/branch-sales-timeseries-query.dto';
import type { BranchSalesSummaryResponseDto } from '../dto/branch-sales-summary-response.dto';
import type { BranchSalesTimeseriesResponseDto } from '../dto/branch-sales-timeseries-response.dto';

@Controller('analytics')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class AnalyticsController {
  constructor(
    private readonly branchSalesSummaryService: BranchSalesSummaryService,
    private readonly branchSalesTimeseriesService: BranchSalesTimeseriesService,
  ) {}

  @Get('sales/summary')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['read', 'Analytics'])
  getSalesSummary(
    @Query() query: BranchSalesSummaryQueryDto,
  ): Promise<BranchSalesSummaryResponseDto> {
    return this.branchSalesSummaryService.summarize(query);
  }

  @Get('sales/timeseries')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['read', 'Analytics'])
  getSalesTimeseries(
    @Query() query: BranchSalesTimeseriesQueryDto,
  ): Promise<BranchSalesTimeseriesResponseDto> {
    return this.branchSalesTimeseriesService.getTimeseries(query);
  }
}
