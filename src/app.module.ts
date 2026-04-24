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
 * - PromotionsModule: Promotions bounded context
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import * as Joi from 'joi';
import { DatabaseModule } from './shared/prisma/prisma.module';
import { ProductsModule } from './products/products.module';
import { CategoriesModule } from './categories/categories.module';
import { BrandsModule } from './brands/brands.module';
import { OrdersModule } from './orders/orders.module';
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';
import { PriceListsModule } from './price-lists/price-lists.module';
import { CustomersModule } from './customers/customers.module';
import { PromotionsModule } from './promotions/promotions.module';
import { SalesModule } from './sales/sales.module';
import { FilesModule } from './files/files.module';

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
        SPACES_ENDPOINT: Joi.string().uri().required(),
        SPACES_REGION: Joi.string().required(),
        SPACES_BUCKET: Joi.string().required(),
        SPACES_ACCESS_KEY_ID: Joi.string().required(),
        SPACES_SECRET_ACCESS_KEY: Joi.string().required(),
        SPACES_PUBLIC_BASE_URL: Joi.string().uri().required(),
        SPACES_UPLOAD_MAX_MB: Joi.number()
          .integer()
          .min(1)
          .max(100)
          .default(10),
      }),
    }),

    // Infrastructure
    EventEmitterModule.forRoot(),
    DatabaseModule,

    // Bounded Contexts
    ProductsModule,
    CategoriesModule,
    BrandsModule,
    OrdersModule,
    AuthModule,
    AdminModule,
    PriceListsModule,
    CustomersModule,
    PromotionsModule,
    SalesModule,
    FilesModule,
  ],
})
export class AppModule {}
