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
 * - StockAlertsModule (Slice E.2): provides STOCK_ALERT_STATE_REPOSITORY
 *   injected into PrismaProductRepository so the decrement path can run
 *   the conditional flip + outbox write in the same transaction.
 * - Shared OutboxModule for OutboxWriterService (the in-tx outbox write).
 *
 * Exports ProductsService so other modules (Orders, Sales) can use it.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { PrismaProductRepository } from './infrastructure/prisma-product.repository';
import { PRODUCT_REPOSITORY } from './domain/product.repository';
import { FilesModule } from '../files/files.module';
import { SatCatalogModule } from '../sat-catalog/sat-catalog.module';
import { StockAlertsModule } from '../stock-alerts/stock-alerts.module';
import { OutboxModule } from '../shared/outbox/outbox.module';

@Module({
  imports: [
    AuthModule,
    FilesModule,
    SatCatalogModule,
    StockAlertsModule,
    OutboxModule,
  ],
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
