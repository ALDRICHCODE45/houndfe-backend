/**
 * ProductsModule - NestJS module for the Products bounded context.
 *
 * Registers:
 * - PrismaProductRepository as IProductRepository adapter
 * - ProductsService for product + subresource CRUD
 * - ProductsController for HTTP endpoints
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
  exports: [ProductsService],
})
export class ProductsModule {}
