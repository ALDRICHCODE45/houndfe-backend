import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { InventoryCommands } from './http/inventory-commands';
import { InventoryCursor } from './http/inventory-cursor';
import { InventoryController } from './http/inventory.controller';
import { InventoryQueries } from './http/inventory-queries';
import { InventoryStockReader } from './http/inventory-stock-reader';
import { StockJournalWriter } from './infrastructure/stock-journal.writer';

/** Inventory journal: single stock writer plus the stock/movements/adjustments HTTP surface. */
@Module({
  imports: [AuthModule, ConfigModule],
  controllers: [InventoryController],
  providers: [
    StockJournalWriter,
    InventoryStockReader,
    InventoryCommands,
    InventoryQueries,
    {
      provide: InventoryCursor,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new InventoryCursor(config.getOrThrow<string>('JWT_SECRET')),
    },
    TenantContextGuard,
  ],
  exports: [StockJournalWriter],
})
export class InventoryModule {}
