import { Module } from '@nestjs/common';
import { StockJournalWriter } from './infrastructure/stock-journal.writer';

/** Inventory journal core. HTTP routes arrive with T5. */
@Module({
  providers: [StockJournalWriter],
  exports: [StockJournalWriter],
})
export class InventoryModule {}
