/**
 * AppModule - Root module of the application.
 *
 * Imports:
 * - EventEmitterModule: NestJS event bus for domain events
 * - DatabaseModule: Global Prisma connection
 * - ProductsModule: Products bounded context
 * - OrdersModule: Orders bounded context
 */
import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { DatabaseModule } from './shared/prisma/prisma.module';
import { ProductsModule } from './products/products.module';
import { OrdersModule } from './orders/orders.module';

@Module({
  imports: [
    // Infrastructure
    EventEmitterModule.forRoot(),
    DatabaseModule,

    // Bounded Contexts
    ProductsModule,
    OrdersModule,
  ],
})
export class AppModule {}
