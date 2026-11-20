/**
 * Restock backorders («pedido por reposición», contract v1). T1: the model, the
 * per-tenant folio and the bot routes `POST/GET/list/cancel
 * /chatbot-api/backorders`.
 *
 * `ChatbotApiModule` supplies the bot guard and its credential repository;
 * `SalesModule` supplies `SalesService.previewBotPricing` (the same price
 * resolution the bot checkout uses). `DatabaseModule` and `ConfigModule` are
 * global providers (`TenantPrismaService`, `ConfigService`).
 *
 * `BACKORDER_RESERVATION_RELEASER` is the seam the reserve/allocate task
 * rebinds; until then no backorder can be RESERVED and the no-op adapter is
 * never asked to release anything.
 */
import { Module } from '@nestjs/common';
import { ChatbotApiModule } from '../chatbot-api/chatbot-api.module';
import { SalesModule } from '../sales/sales.module';
import { DatabaseModule } from '../shared/prisma/prisma.module';
import { BackordersBotService } from './application/backorders-bot.service';
import { BACKORDER_RESERVATION_RELEASER } from './application/ports/backorder-reservation-releaser.port';
import { BackorderCustomerResolver } from './infrastructure/backorder-customer.resolver';
import { BackorderStockReader } from './infrastructure/backorder-stock.reader';
import { NoOpBackorderReservationReleaser } from './infrastructure/no-op-backorder-reservation.releaser';
import { BackordersBotController } from './presentation/backorders-bot.controller';

@Module({
  imports: [DatabaseModule, ChatbotApiModule, SalesModule],
  controllers: [BackordersBotController],
  providers: [
    BackordersBotService,
    BackorderCustomerResolver,
    BackorderStockReader,
    {
      provide: BACKORDER_RESERVATION_RELEASER,
      useClass: NoOpBackorderReservationReleaser,
    },
  ],
  exports: [BackordersBotService, BACKORDER_RESERVATION_RELEASER],
})
export class BackordersModule {}
