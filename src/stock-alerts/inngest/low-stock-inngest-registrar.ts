/**
 * LowStockInngestRegistrar — Slice F.2 wiring.
 *
 * Owns the lifecycle step that registers the `low-stock-email`
 * Inngest function with `InngestService` so the InngestController
 * serve handler dispatches it. Extracted from `StockAlertsModule`
 * so the module's constructor stays dep-light (the previous
 * in-line `OnModuleInit` pulled InngestService + MAILER +
 * NotificationConfigRepo + UserEmailLookup + TenantRunner into
 * the constructor, which broke the existing chain tests that
 * transitively imported `StockAlertsModule` from `ChatbotApiModule`
 * etc.).
 *
 * The registrar is registered as a global provider in
 * `app.module.ts` directly — never inside another module — so its
 * dependency graph is bound to AppModule's imports (NotificationConfig,
 * Mailer, Tenant, StockAlerts) without forcing those modules into
 * every transitive chain.
 *
 * Spec: design.md "Inngest + Resend Wiring" — function registration
 * + Slice F.2 wiring.
 */
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InngestService } from '../../inngest/inngest.service';
import { MAILER, type IMailer } from '../../notifications/email/mailer.port';
import {
  NOTIFICATION_CONFIG_REPOSITORY,
  type INotificationConfigRepository,
} from '../../notification-config/domain/notification-config.repository';
import { TenantRunnerService } from '../../shared/tenant/tenant-runner.service';
import {
  USER_EMAIL_LOOKUP,
  type IUserEmailLookup,
} from '../domain/user-email-lookup.repository';
import { buildLowStockFunctions } from './low-stock.functions';

@Injectable()
export class LowStockInngestRegistrar implements OnModuleInit {
  private readonly logger = new Logger(LowStockInngestRegistrar.name);

  constructor(
    private readonly inngestService: InngestService,
    @Inject(NOTIFICATION_CONFIG_REPOSITORY)
    private readonly notificationConfigRepo: INotificationConfigRepository,
    @Inject(USER_EMAIL_LOOKUP)
    private readonly userEmailLookup: IUserEmailLookup,
    @Inject(MAILER)
    private readonly mailer: IMailer,
    private readonly tenantRunner: TenantRunnerService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit(): void {
    const appBaseUrl = this.configService.get<string>('APP_WEB_URL');
    const [fn] = buildLowStockFunctions({
      inngestClient: this.inngestService.getClient(),
      tenantRunner: this.tenantRunner,
      notificationConfigRepository: this.notificationConfigRepo,
      userEmailLookup: this.userEmailLookup,
      mailer: this.mailer,
      ...(appBaseUrl ? { appBaseUrl } : {}),
    });
    this.inngestService.registerFunctions([fn]);
    this.logger.log(
      `low-stock-email Inngest function registered (id=${(fn as { id?: string }).id ?? 'unknown'})`,
    );
  }
}
