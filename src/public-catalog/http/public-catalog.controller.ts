import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  UseGuards,
  UseInterceptors,
  ParseUUIDPipe,
} from '@nestjs/common';
import { SkipThrottle, Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { PublicTenantGuard } from './guards/public-tenant.guard';
import {
  PublicTenant,
  type PublicTenantInfo,
} from './decorators/public-tenant.decorator';
import {
  CacheControlInterceptor,
  CacheControl,
} from './interceptors/cache-control.interceptor';
import { ListPublicBranchesUseCase } from '../application/use-cases/list-public-branches.use-case';
import { ListPublicProductsUseCase } from '../application/use-cases/list-public-products.use-case';
import { GetPublicProductDetailUseCase } from '../application/use-cases/get-public-product-detail.use-case';
import { ValidatePublicCartUseCase } from '../application/use-cases/validate-public-cart.use-case';
import { ListProductsQueryDto } from './request-dto/list-products-query.dto';
import { ValidateCartBodyDto } from './request-dto/validate-cart-body.dto';
import { PublicPriceContextQueryDto } from './request-dto/public-price-context-query.dto';
import { PublicPriceContextResolver } from '../application/services/public-price-context-resolver';

@Controller('public/catalog')
@SkipThrottle({ 'public-validate': true })
@UseGuards(PublicTenantGuard, ThrottlerGuard)
@UseInterceptors(CacheControlInterceptor)
export class PublicCatalogController {
  constructor(
    private readonly listBranches: ListPublicBranchesUseCase,
    private readonly listProducts: ListPublicProductsUseCase,
    private readonly getProductDetail: GetPublicProductDetailUseCase,
    private readonly validateCart: ValidatePublicCartUseCase,
    private readonly priceContext: PublicPriceContextResolver,
  ) {}

  @Get('branches')
  @CacheControl('public, max-age=300')
  async getBranches() {
    return this.listBranches.execute();
  }

  @Get(':tenantSlug/products')
  @CacheControl('public, max-age=60')
  async getProducts(
    @Param('tenantSlug') tenantSlug: string,
    @PublicTenant() tenant: PublicTenantInfo,
    @Query() query: ListProductsQueryDto,
  ) {
    // F2.WU6 slice 5b — one guarded-tenant context resolution per
    // request; every miss maps to the single generic 404 via the
    // DomainExceptionFilter. No legacy execute() call, retry, catch,
    // or default-list fallback. `branchId` stays accepted as a
    // compatibility-only no-op and is never passed downstream.
    const context = await this.priceContext.resolve(
      tenantSlug,
      query.priceListId,
    );

    return this.listProducts.executeForContext({
      tenant,
      context,
      filters: {
        q: query.q,
        categoryId: query.categoryId,
        sort:
          (query.sort as
            | 'relevance'
            | 'price_asc'
            | 'price_desc'
            | 'newest'
            | 'rating_desc') ?? 'newest',
        page: query.page ?? 1,
        limit: query.limit ?? 20,
      },
    });
  }

  @Get(':tenantSlug/products/:productId')
  @CacheControl('public, max-age=60')
  async getProduct(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('tenantSlug') tenantSlug: string,
    @PublicTenant() tenant: PublicTenantInfo,
    @Query() query: PublicPriceContextQueryDto,
  ) {
    // F2.WU6 slice 5c — one guarded-tenant context resolution per detail
    // request; every miss maps to the single generic 404 via the
    // DomainExceptionFilter. No legacy execute() call, retry, catch, or
    // default-list fallback; the flat contextual response passes
    // through unchanged.
    const context = await this.priceContext.resolve(
      tenantSlug,
      query.priceListId,
    );

    return this.getProductDetail.executeForContext({
      productId,
      tenant,
      context,
    });
  }

  @Post(':tenantSlug/cart/validate')
  @CacheControl('no-store')
  @SkipThrottle({ 'public-browse': true, 'public-validate': false })
  @Throttle({ 'public-validate': { ttl: 60_000, limit: 20 } })
  async validateCartEndpoint(
    @Param('tenantSlug') tenantSlug: string,
    @PublicTenant() tenant: PublicTenantInfo,
    @Body() body: ValidateCartBodyDto,
  ) {
    const context = await this.priceContext.resolve(
      tenantSlug,
      body.priceListId,
    );

    return this.validateCart.executeForContext({
      tenant,
      context,
      items: body.items,
    });
  }
}
