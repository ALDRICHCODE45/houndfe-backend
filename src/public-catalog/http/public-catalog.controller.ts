import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  UseGuards,
  ParseUUIDPipe,
  NotFoundException,
} from '@nestjs/common';
import { PublicTenantGuard } from './guards/public-tenant.guard';
import {
  PublicTenant,
  type PublicTenantInfo,
} from './decorators/public-tenant.decorator';
import { ListPublicBranchesUseCase } from '../application/use-cases/list-public-branches.use-case';
import { ListPublicProductsUseCase } from '../application/use-cases/list-public-products.use-case';
import { ListProductsQueryDto } from './request-dto/list-products-query.dto';

@Controller('public/catalog')
@UseGuards(PublicTenantGuard)
export class PublicCatalogController {
  constructor(
    private readonly listBranches: ListPublicBranchesUseCase,
    private readonly listProducts: ListPublicProductsUseCase,
  ) {}

  @Get('branches')
  async getBranches() {
    return this.listBranches.execute();
  }

  @Get(':tenantSlug/products')
  async getProducts(@Query() query: ListProductsQueryDto) {
    return this.listProducts.execute({
      q: query.q,
      categoryId: query.categoryId,
      sort: (query.sort as 'relevance' | 'price_asc' | 'price_desc' | 'newest') ?? 'newest',
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
  }
}
