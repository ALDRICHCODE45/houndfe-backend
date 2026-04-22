/**
 * SalesModule - NestJS module for the Sales bounded context (POS).
 *
 * Registers:
 * - PrismaSaleRepository as ISaleRepository adapter
 * - SalesService for use case orchestration
 * - SalesController for HTTP endpoints
 *
 * Depends on ProductsModule for product/variant validation and stock checks.
 */
import { Module } from '@nestjs/common';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import { PrismaSaleRepository } from './infrastructure/prisma-sale.repository';
import { SALE_REPOSITORY } from './domain/sale.repository';
import { ProductsModule } from '../products/products.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [ProductsModule, AuthModule],
  controllers: [SalesController],
  providers: [
    SalesService,
    {
      provide: SALE_REPOSITORY,
      useClass: PrismaSaleRepository,
    },
  ],
  exports: [SalesService],
})
export class SalesModule {}
