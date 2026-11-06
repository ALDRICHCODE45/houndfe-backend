/**
 * shipping-zones / T2 (S4) — packaging sub-resource of products.
 *
 * Lives outside `ProductsController` so product/variant DTOs (and the FE
 * strict decoders built on them) stay untouched. Guarded by the same
 * read/update:Product permissions as the other product sub-resources.
 *
 *   GET    /products/:productId/packaging
 *   PUT    /products/:productId/packaging
 *   DELETE /products/:productId/packaging
 *   GET    /products/:productId/variants/:variantId/packaging
 *   PUT    /products/:productId/variants/:variantId/packaging
 *   DELETE /products/:productId/variants/:variantId/packaging
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import { RequirePermissions } from '../../../auth/authorization/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../../auth/authorization/guards/permissions.guard';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../../shared/tenant/tenant-context.guard';
import { ProductPackagingService } from '../application/product-packaging.service';
import { PutPackagingDto } from '../dto/packaging.dto';

@Controller('products/:productId')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class ProductPackagingController {
  constructor(private readonly packaging: ProductPackagingService) {}

  @Get('packaging')
  @RequirePermissions(['read', 'Product'])
  getProduct(@Param('productId', ParseUUIDPipe) productId: string) {
    return this.packaging.getProduct(productId);
  }

  @Put('packaging')
  @RequirePermissions(['update', 'Product'])
  putProduct(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: PutPackagingDto,
  ) {
    return this.packaging.putProduct(productId, dto);
  }

  @Delete('packaging')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(['update', 'Product'])
  deleteProduct(@Param('productId', ParseUUIDPipe) productId: string) {
    return this.packaging.deleteProduct(productId);
  }

  @Get('variants/:variantId/packaging')
  @RequirePermissions(['read', 'Product'])
  getVariant(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
  ) {
    return this.packaging.getVariant(productId, variantId);
  }

  @Put('variants/:variantId/packaging')
  @RequirePermissions(['update', 'Product'])
  putVariant(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: PutPackagingDto,
  ) {
    return this.packaging.putVariant(productId, variantId, dto);
  }

  @Delete('variants/:variantId/packaging')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(['update', 'Product'])
  deleteVariant(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
  ) {
    return this.packaging.deleteVariant(productId, variantId);
  }
}
