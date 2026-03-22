/**
 * ProductsModule - NestJS module for the Products bounded context.
 *
 * This is where Dependency Inversion happens:
 * - Domain defines IProductRepository (port)
 * - We register PrismaProductRepository (adapter)
 * - NestJS injects the adapter when the port is requested
 *
 * Exports ProductsService so other modules (Orders) can use it.
 */
import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { PrismaProductRepository } from './infrastructure/prisma-product.repository';
import { PRODUCT_REPOSITORY } from './domain/product.repository';

@Module({
  controllers: [ProductsController],
  providers: [
    ProductsService,
    {
      provide: PRODUCT_REPOSITORY,
      useClass: PrismaProductRepository,
    },
  ],
  exports: [ProductsService], // Other modules use the SERVICE, not the repo directly
})
export class ProductsModule {}
