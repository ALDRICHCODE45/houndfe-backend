/**
 * SalesCatalogController - HTTP Adapter for POS Catalog Search.
 *
 * Translates HTTP requests to service calls for POS catalog endpoint.
 * Handles: GET /sales/pos-catalog, GET /sales/pos-catalog/:productId
 */
import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import { SalesService } from './sales.service';
import { SearchPosCatalogDto } from './dto/search-pos-catalog.dto';

@Controller('sales')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class SalesCatalogController {
  constructor(private readonly salesService: SalesService) {}

  /**
   * GET /sales/pos-catalog — Search POS catalog
   */
  @Get('pos-catalog')
  @RequirePermissions(['read', 'Sale'])
  searchPosCatalog(@Query() dto: SearchPosCatalogDto) {
    return this.salesService.searchPosCatalog(dto);
  }

  /**
   * GET /sales/pos-catalog/:productId — Get single product detail for POS
   */
  @Get('pos-catalog/:productId')
  @RequirePermissions(['read', 'Sale'])
  getProductDetail(@Param('productId', ParseUUIDPipe) productId: string) {
    return this.salesService.getProductDetail(productId);
  }
}
