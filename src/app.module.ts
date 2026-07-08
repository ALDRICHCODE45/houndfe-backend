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
import { MailerModule } from './notifications/email/mailer.module';
import { TenantModule } from './shared/tenant/tenant.module';
import { StockAlertsModule } from './stock-alerts/stock-alerts.module';
import { LowStockOutboxModule } from './stock-alerts/outbox/low-stock-outbox.module';
import { LowStockInngestRegistrar } from './stock-alerts/inngest/low-stock-inngest-registrar';

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
    // F.1 — Mailer adapter (Resend + dev-logger fallback).
    MailerModule,
    // F.2 — TenantRunner for Inngest handler scope seeding.
    TenantModule,
    // F — StockAlerts (notification function + dedicated outbox poller/dispatcher).
    StockAlertsModule,
    // F.4 + F.5 — dedicated outbox poller + dispatcher in their own
    // module so the dep graph (InngestService + Mailer + TenantRunner)
    // doesn't pollute transitive module chains.
    LowStockOutboxModule,
  ],
  // Slice F.2 — the Inngest function registrar. Declared as a top-level
  // provider (not a module) so its dep graph (InngestService + MAILER +
  // NotificationConfigRepo + UserEmailLookup + TenantRunner) resolves
  // through AppModule's imports WITHOUT forcing those deps into every
  // transitive chain (e.g. ChatbotApiModule's tests).
  providers: [LowStockInngestRegistrar],
})
export class AppModule {}
