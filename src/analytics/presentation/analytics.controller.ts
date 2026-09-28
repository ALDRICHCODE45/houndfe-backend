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
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import { PdfGenerationService } from '../../pdf-generation/pdf-generation.service';
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
    private readonly pdfGenerationService: PdfGenerationService,
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

  /** Branded PDF: one snapshot read, rendered before any response header. */
  @Get('sales/sellers/:sellerUserId/report/pdf')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['read', 'Analytics'], ['read', 'Sale'])
  @Header('Cache-Control', 'no-store')
  async getSellerSalesReportPdf(
    @Param('sellerUserId', new ParseUUIDPipe()) sellerUserId: string,
    @Query() query: BranchSalesSummaryQueryDto,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    const report = await this.sellerSalesReportService.getSellerReport(
      sellerUserId,
      query,
    );
    const pdf =
      await this.pdfGenerationService.renderSellerSalesReportPdf(report);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${buildSellerReportPdfFilename(
        sellerUserId,
        query,
      )}"`,
      'Cache-Control': 'no-store',
    });
    res.send(pdf);
  }
}

/** Fixed, user-data-free filename; every component is re-sanitized here. */
export function buildSellerReportPdfFilename(
  sellerUserId: string,
  query: Pick<BranchSalesSummaryQueryDto, 'from' | 'to'>,
): string {
  const safe = (value: string): string => value.replace(/[^a-zA-Z0-9-]/g, '');
  return `reporte-ventas-${safe(sellerUserId)}-${safe(query.from)}-${safe(query.to)}.pdf`;
}
