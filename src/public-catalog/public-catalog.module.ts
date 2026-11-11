import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { ShippingPickupModule } from '../shipping/pickup/shipping-pickup.module';
import { PublicCatalogController } from './http/public-catalog.controller';
import { PublicBranchController } from './http/public-branch.controller';
import {
  SharePreviewController,
  SharePreviewMissFilter,
} from './http/share-preview.controller';
import { PublicTenantGuard } from './http/guards/public-tenant.guard';
import { ListPublicBranchesUseCase } from './application/use-cases/list-public-branches.use-case';
import { ListPublicPriceContextsUseCase } from './application/use-cases/list-public-price-contexts.use-case';
import { ListPublicProductsUseCase } from './application/use-cases/list-public-products.use-case';
import { GetPublicProductDetailUseCase } from './application/use-cases/get-public-product-detail.use-case';
import { ValidatePublicCartUseCase } from './application/use-cases/validate-public-cart.use-case';
import { GetPublicBranchUseCase } from './application/use-cases/get-public-branch.use-case';
import { PublicCatalogConfig } from './application/services/public-catalog-config';
import { PublicPriceContextResolver } from './application/services/public-price-context-resolver';
import { PrismaPublicCatalogRepository } from './infrastructure/prisma-public-catalog.repository';
import { PUBLIC_CATALOG_REPOSITORY } from './application/ports/public-catalog.repository';

@Module({
  imports: [
    // S4 — PickupLocationService for the public branch card.
    ShippingPickupModule,
    ThrottlerModule.forRoot([
      { name: 'public-browse', ttl: 60_000, limit: 60 },
      { name: 'public-validate', ttl: 60_000, limit: 20 },
    ]),
  ],
  controllers: [
    PublicCatalogController,
    PublicBranchController,
    SharePreviewController,
  ],
  providers: [
    PublicTenantGuard,
    ListPublicBranchesUseCase,
    ListPublicPriceContextsUseCase,
    ListPublicProductsUseCase,
    GetPublicProductDetailUseCase,
    ValidatePublicCartUseCase,
    PublicPriceContextResolver,
    GetPublicBranchUseCase,
    PublicCatalogConfig,
    SharePreviewMissFilter,
    {
      provide: PUBLIC_CATALOG_REPOSITORY,
      useClass: PrismaPublicCatalogRepository,
    },
  ],
})
export class PublicCatalogModule {}
