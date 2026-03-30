/**
 * AppModule - Root module of the application.
 *
 * Imports:
 * - ConfigModule: Global configuration with Joi validation
 * - EventEmitterModule: NestJS event bus for domain events
 * - DatabaseModule: Global Prisma connection
 * - ProductsModule: Products bounded context
 * - OrdersModule: Orders bounded context
 * - AuthModule: Authentication bounded context
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import * as Joi from 'joi';
import { DatabaseModule } from './shared/prisma/prisma.module';
import { ProductsModule } from './products/products.module';
import { OrdersModule } from './orders/orders.module';
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';

@Module({
  imports: [
    // Configuration (MUST be first for global availability)
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        DATABASE_URL: Joi.string().required(),
        JWT_SECRET: Joi.string().required().min(32),
        JWT_REFRESH_SECRET: Joi.string().required().min(32),
        JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
        JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),
      }),
    }),

    // Infrastructure
    EventEmitterModule.forRoot(),
    DatabaseModule,

    // Bounded Contexts
    ProductsModule,
    OrdersModule,
    AuthModule,
    AdminModule,
  ],
})
export class AppModule {}
