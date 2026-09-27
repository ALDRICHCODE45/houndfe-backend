/**
 * HTTP CONTROLLER: AnalyticsController (branch-analytics-summary / bas-3a;
 * OI-2 / S4 adds the daily timeseries route; seller-sales-report / v1 adds the
 * per-seller report).
 *
 * Thin adapter: class-level `@UseGuards(JwtAuthGuard, TenantContextGuard,
 * PermissionsGuard)` in that exact order and one `@Query()`/`@Param()`
 * delegation per route. Tenant scope comes from the JWT upstream — the
 * handlers read no actor or tenant ID from request parameters.
 *
 * Routes: GET /analytics/sales/summary and GET /analytics/sales/timeseries
 * → read:Analytics; GET /analytics/sales/sellers/:sellerUserId/report
 * → read:Analytics AND read:Sale (HTTP 200, Cache-Control: no-store).
 */
import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import { BranchSalesSummaryService } from '../application/branch-sales-summary.service';
import { BranchSalesTimeseriesService } from '../application/branch-sales-timeseries.service';
import { SellerSalesReportService } from '../application/seller-sales-report.service';
import { BranchSalesSummaryQueryDto } from '../dto/branch-sales-summary-query.dto';
import { BranchSalesTimeseriesQueryDto } from '../dto/branch-sales-timeseries-query.dto';
import type { BranchSalesSummaryResponseDto } from '../dto/branch-sales-summary-response.dto';
import type { BranchSalesTimeseriesResponseDto } from '../dto/branch-sales-timeseries-response.dto';
import type { SellerSalesReportResponseDto } from '../dto/seller-sales-report-response.dto';

@Controller('analytics')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class AnalyticsController {
  constructor(
    private readonly branchSalesSummaryService: BranchSalesSummaryService,
    private readonly branchSalesTimeseriesService: BranchSalesTimeseriesService,
    private readonly sellerSalesReportService: SellerSalesReportService,
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

  @Get('sales/sellers/:sellerUserId/report')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['read', 'Analytics'], ['read', 'Sale'])
  @Header('Cache-Control', 'no-store')
  getSellerSalesReport(
    @Param('sellerUserId', new ParseUUIDPipe()) sellerUserId: string,
    @Query() query: BranchSalesSummaryQueryDto,
  ): Promise<SellerSalesReportResponseDto> {
    return this.sellerSalesReportService.getSellerReport(sellerUserId, query);
  }
}
