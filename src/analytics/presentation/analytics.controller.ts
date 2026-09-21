/**
 * HTTP CONTROLLER: AnalyticsController (branch-analytics-summary / bas-3a).
 *
 * Thin adapter: class-level `@UseGuards(JwtAuthGuard, TenantContextGuard,
 * PermissionsGuard)` in that exact order, `@RequirePermissions(['read',
 * 'Analytics'])`, and `@Query() BranchSalesSummaryQueryDto` delegation to
 * `BranchSalesSummaryService.summarize`. Tenant scope comes from the JWT
 * upstream — the handler reads no actor or tenant ID from request parameters.
 *
 * Route: GET /analytics/sales/summary → read:Analytics (HTTP 200).
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
import { BranchSalesSummaryQueryDto } from '../dto/branch-sales-summary-query.dto';
import type { BranchSalesSummaryResponseDto } from '../dto/branch-sales-summary-response.dto';

@Controller('analytics')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class AnalyticsController {
  constructor(
    private readonly branchSalesSummaryService: BranchSalesSummaryService,
  ) {}

  @Get('sales/summary')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['read', 'Analytics'])
  getSalesSummary(
    @Query() query: BranchSalesSummaryQueryDto,
  ): Promise<BranchSalesSummaryResponseDto> {
    return this.branchSalesSummaryService.summarize(query);
  }
}
