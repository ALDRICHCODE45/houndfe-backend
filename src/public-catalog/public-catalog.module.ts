import { Module } from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { PublicCatalogController } from './http/public-catalog.controller';
import { PublicTenantGuard } from './http/guards/public-tenant.guard';
import { ListPublicBranchesUseCase } from './application/use-cases/list-public-branches.use-case';
import { ListPublicProductsUseCase } from './application/use-cases/list-public-products.use-case';
import { GetPublicProductDetailUseCase } from './application/use-cases/get-public-product-detail.use-case';
import { PrismaPublicCatalogRepository } from './infrastructure/prisma-public-catalog.repository';
import { PUBLIC_CATALOG_REPOSITORY } from './application/ports/public-catalog.repository';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      { name: 'public-browse', ttl: 60_000, limit: 60 },
      { name: 'public-validate', ttl: 60_000, limit: 20 },
    ]),
  ],
  controllers: [PublicCatalogController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    PublicTenantGuard,
    ListPublicBranchesUseCase,
    ListPublicProductsUseCase,
    GetPublicProductDetailUseCase,
    {
      provide: PUBLIC_CATALOG_REPOSITORY,
      useClass: PrismaPublicCatalogRepository,
    },
  ],
})
export class PublicCatalogModule {}
