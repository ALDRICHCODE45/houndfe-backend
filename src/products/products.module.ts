/**
 * ProductsModule - NestJS module for the Products bounded context.
 *
 * Registers:
 * - PrismaProductRepository as IProductRepository adapter
 * - ProductsService for product + subresource CRUD
 * - ProductsController for HTTP endpoints
 *
 * Imports:
 * - FilesModule for file storage integration
 *
 * Exports ProductsService so other modules (Orders) can use it.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { PrismaProductRepository } from './infrastructure/prisma-product.repository';
import { PRODUCT_REPOSITORY } from './domain/product.repository';
import { FilesModule } from '../files/files.module';

@Module({
  imports: [AuthModule, FilesModule],
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
