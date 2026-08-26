/**
 * SalesCatalogController - HTTP Adapter for POS Catalog Search.
 *
 * Translates HTTP requests to service calls for POS catalog endpoint.
 * Handles: GET /sales/pos-catalog, GET /sales/pos-catalog/:productId,
 * and GET /sales/payment-methods (custom-payment-methods / WU2 / D4).
 */
import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
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

  /**
   * GET /sales/payment-methods — Custom Payment Methods (WU2 / D4).
   * POS selector projection: returns active, tenant-scoped catalog rows
   * as `{ id, name, category, subtitle }`. Same `read:Sale` scope as
   * `pos-catalog` (NOT `read:PaymentMethod`) so the POS auth token can
   * use the endpoint without an extra role grant.
   */
  @Get('payment-methods')
  @RequirePermissions(['read', 'Sale'])
  listActivePaymentMethods() {
    return this.salesService.listActivePaymentMethods();
  }
}