/**
 * OrdersModule - NestJS module for the Orders bounded context.
 *
 * Imports ProductsModule because OrdersService needs ProductsService
 * to coordinate stock operations across bounded contexts.
 */
import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PrismaOrderRepository } from './infrastructure/prisma-order.repository';
import { ORDER_REPOSITORY } from './domain/order.repository';
import { OrderEventListener } from './listeners/order-event.listener';
import { ProductsModule } from '../products/products.module';

@Module({
  imports: [ProductsModule],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    {
      provide: ORDER_REPOSITORY,
      useClass: PrismaOrderRepository,
    },
    OrderEventListener,
  ],
})
export class OrdersModule {}
