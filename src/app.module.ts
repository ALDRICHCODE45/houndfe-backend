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
 * - PdfGenerationModule: PDF receipts/tickets (WU5)
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
// HD-03b2 — bot RESTOCK human-decision intake (`POST
// /chatbot-api/human-decisions`). Self-contained: imports ChatbotApiModule
// (exported ServiceAuthGuard + credentials provider) and DatabaseModule.
import { HumanDecisionsModule } from './human-decisions/human-decisions.module';
import { PublicCatalogModule } from './public-catalog/public-catalog.module';
import { SatCatalogModule } from './sat-catalog/sat-catalog.module';
import { NotificationConfigModule } from './notification-config/notification-config.module';
import { InngestModule } from './inngest/inngest.module';
import { MailerModule } from './notifications/email/mailer.module';
import { TenantModule } from './shared/tenant/tenant.module';
import { StockAlertsModule } from './stock-alerts/stock-alerts.module';
import { LowStockOutboxModule } from './stock-alerts/outbox/low-stock-outbox.module';
import { LowStockInngestRegistrar } from './stock-alerts/inngest/low-stock-inngest-registrar';
import { HrTimeOffOutboxModule } from './hr-time-off/outbox/hr-time-off-outbox.module';
import { HrTimeOffInngestRegistrar } from './hr-time-off/inngest/hr-time-off-inngest-registrar';
// WU5 — PDF generation for confirmed sales (rebranded receipts/tickets).
// Lives in its own module so the template registry stays decoupled from
// the sales bounded context (future invoice/report/quote templates land here).
import { PdfGenerationModule } from './pdf-generation/pdf-generation.module';
import { QuotationsModule } from './quotations/quotations.module';
// WU2 — delivery-routes bounded context (bounded-context skeleton +
// CASL/guard extension + Sale mirror). Outbox/Inngest/email wiring +
// the dedicated poller/dispatcher + React Email template + DTO timeline
// + read model land in WU3 (own module + registrar in app.module.ts).
import { DeliveryRoutesModule } from './delivery-routes/delivery-routes.module';
// WU3 - dedicated delivery-routes outbox poller + dispatcher. Own
// module so the Inngest dep graph doesn't pollute transitive chains.
import { DeliveryRoutesOutboxModule } from './delivery-routes/outbox/delivery-routes-outbox.module';
// WU3 - registers the delivery-next-stop-notify Inngest function.
// Top-level provider so the dep graph resolves through AppModule.
import { DeliveryRoutesInngestRegistrar } from './delivery-routes/inngest/delivery-routes-inngest-registrar';
// online-catalog-publishing / WU3A3 - catalog-settings bounded context
// (GET /tenants/:tenantId/catalog-settings). Hexagonal wiring mirrors
// SatCatalogModule / NotificationConfigModule.
import { CatalogSettingsModule } from './catalog-settings/catalog-settings.module';
// pca-3b3b - dedicated promotion-capacity outbox poller + dispatcher.
// Own module so the Inngest dep graph doesn't pollute transitive chains
// (mirrors the low-stock / hr-time-off / delivery-routes wiring).
import { PromotionCapacityOutboxModule } from './promotions/outbox/promotion-capacity-outbox.module';
// pca-3b4c - registers the promotion-near-capacity-email Inngest function.
// Top-level provider so the dep graph resolves through AppModule.
import { PromotionCapacityInngestRegistrar } from './promotions/inngest/promotion-capacity-inngest-registrar';
// pca-3c4c - activates the complete promotion-expiry delivery path: the
// bounded scanner publishes `promotion.expiring.detected` rows, the
// dedicated outbox module owns their durable poller/dispatcher, and the
// top-level registrar registers the email consumer.
import { PromotionExpiryModule } from './promotions/expiry/promotion-expiry.module';
import { PromotionExpiryOutboxModule } from './promotions/outbox/promotion-expiry-outbox.module';
import { PromotionExpiryInngestRegistrar } from './promotions/inngest/promotion-expiry-inngest-registrar';
// branch-analytics-summary / bas-3a — read-only branch sales summary
// bounded context. Imports DatabaseModule + AuthModule only.
import { AnalyticsModule } from './analytics/analytics.module';

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
    HumanDecisionsModule,
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
    // Slice 5 + Slice 6 — HR time-off outbox poller/dispatcher +
    // Inngest fn registrar. Mirrors the low-stock wiring: own module
    // for the outbox pipeline, top-level provider for the Inngest
    // registrar.
    HrTimeOffOutboxModule,
    // WU5 — PDF generation module. Reuses SalesModule (via DI for
    // `SalesService.getSaleDetail`) and TenantsModule. Placed at the
    // end of the bounded-context list because it has no outbound
    // dependencies on the time-off/stock-alert pipelines.
    PdfGenerationModule,
    // WU2 — Quotations bounded context (service core + draft CRUD +
    // customer + price list). WU3 widens the engine dependency,
    // WU4 adds the PDF/email wiring through PdfGenerationModule.
    QuotationsModule,
    // delivery-routes / WU2 — bounded-context skeleton + CASL/guard
    // extension + Sale mirror. Self-contained: imports AuthModule +
    // SalesModule, exports DeliveryRoutesService for future read-
    // model consumers (WU3). WU3 adds the outbox/Inngest/email
    // module + the top-level Inngest registrar alongside this line.
    DeliveryRoutesModule,
    // delivery-routes / WU3 — dedicated poller/dispatcher for the
    // delivery.next_stop.notify outbox rows. Mirrors
    // LowStockOutboxModule / HrTimeOffOutboxModule placement.
    DeliveryRoutesOutboxModule,
    // pca-3b3b — dedicated poller/dispatcher for the
    // promotion.near_capacity.detected outbox rows. The generic poller
    // excludes this eventType in the same change, so the crossing row is
    // owned by exactly one poller. pca-3b4 registers the Inngest function
    // that consumes the dispatched event.
    PromotionCapacityOutboxModule,
    // pca-3c4c — activates the promotion-expiry path. The scanner module
    // is imported here (it is inert until now) so it actually produces
    // `promotion.expiring.detected` rows, and the dedicated outbox module
    // is imported so those rows have a durable poller/dispatcher. The
    // generic poller already excludes this eventType, so exactly one
    // consumer owns each row.
    PromotionExpiryModule,
    PromotionExpiryOutboxModule,
    // online-catalog-publishing / WU3A3 — catalog-settings bounded
    // context. Self-contained: imports DatabaseModule + AuthModule only.
    CatalogSettingsModule,
    // branch-analytics-summary / bas-3a — read-only branch sales summary
    // (GET /analytics/sales/summary behind read:Analytics).
    AnalyticsModule,
  ],
  // Slice F.2 — the Inngest function registrar. Declared as a top-level
  // provider (not a module) so its dep graph (InngestService + MAILER +
  // NotificationConfigRepo + UserEmailLookup + TenantRunner) resolves
  // through AppModule's imports WITHOUT forcing those deps into every
  // transitive chain (e.g. ChatbotApiModule's tests).
  providers: [
    LowStockInngestRegistrar,
    HrTimeOffInngestRegistrar,
    // delivery-routes / WU3 — Inngest function registrar for the
    // delivery-next-stop-notify event. Same registration pattern as
    // the low-stock / hr-time-off registrars.
    DeliveryRoutesInngestRegistrar,
    // pca-3b4c — Inngest function registrar for the
    // promotion.near_capacity.detected event. Same registration pattern
    // as the low-stock / hr-time-off / delivery-routes registrars.
    PromotionCapacityInngestRegistrar,
    // pca-3c4c — Inngest function registrar for the
    // promotion.expiring.detected event. Same registration pattern as the
    // low-stock / hr-time-off / delivery-routes / capacity registrars.
    PromotionExpiryInngestRegistrar,
  ],
})
export class AppModule {}
