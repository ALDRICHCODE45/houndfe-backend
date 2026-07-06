/**
 * AppModule - Root module of the application.
 *
 * Imports:
 * - ConfigModule: Global configuration with Joi validation (extended in
 *                 D.4 with fail-closed NODE_ENV + Inngest + Resend keys)
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
import { ScheduleModule } from '@nestjs/schedule';
import { ClsModule } from 'nestjs-cls';
import { buildEnvValidationSchema } from './shared/config/env.validation';
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
import { TenantsModule } from './tenants/tenants.module';
import { OutboxModule } from './shared/outbox/outbox.module';
import { UsersModule } from './users/users.module';
import { EmployeesModule } from './employees/employees.module';
import { ChatbotApiModule } from './chatbot-api/chatbot-api.module';
import { PublicCatalogModule } from './public-catalog/public-catalog.module';
import { SatCatalogModule } from './sat-catalog/sat-catalog.module';
import { NotificationConfigModule } from './notification-config/notification-config.module';
import { InngestModule } from './inngest/inngest.module';

@Module({
  imports: [
    // Configuration (MUST be first for global availability)
    ConfigModule.forRoot({
      isGlobal: true,
      // D.4 — extracted to shared/config/env.validation.ts so the schema
      // can be unit-tested in isolation (abortEarly:false surfaces every
      // missing key in a single shot — fail-closed composition).
      validationSchema: buildEnvValidationSchema(),
    }),

    // Infrastructure
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
      },
    }),
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
    TenantsModule,
    UsersModule,
    EmployeesModule,
    ChatbotApiModule,
    PublicCatalogModule,
    SatCatalogModule,
    NotificationConfigModule,
    OutboxModule,
    // D — Inngest infra (controller + service). JWT-excluded serve handler.
    // Functions are registered in Slice F (low-stock.functions.ts).
    InngestModule,
  ],
})
export class AppModule {}
