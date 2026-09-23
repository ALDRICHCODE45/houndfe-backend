/**
 * PromotionExpiryInngestRegistrar — pca-3c4c wiring.
 *
 * Owns the lifecycle step that registers the `promotion-expiring-email`
 * Inngest function (`pca-3c4b`) with `InngestService` so the InngestController
 * serve handler dispatches it. Declared as a top-level provider in
 * `app.module.ts` — never inside another module — so its dependency graph
 * (InngestService + MAILER + NotificationConfigRepo + UserEmailLookup +
 * PromotionAlertLookup + TenantRunner) resolves through AppModule's imports
 * without forcing those deps into every transitive chain.
 *
 * Mirrors `PromotionCapacityInngestRegistrar` /
 * `LowStockInngestRegistrar` / `HrTimeOffInngestRegistrar` /
 * `DeliveryRoutesInngestRegistrar` exactly — same ports, same construction,
 * same `registerFunctions([fn])` shape.
 *
 * The registration is intentionally idempotent-safe: the builder returns a
 * one-element array and `InngestService.registerFunctions` rejects a duplicate
 * id at boot, so a double wiring is impossible without failing fast. This
 * slice changes no event, schema, payload, or digest.
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
} from '../../stock-alerts/domain/user-email-lookup.repository';
import {
  PROMOTION_ALERT_LOOKUP,
  type IPromotionAlertLookup,
} from '../domain/promotion-alert-lookup.repository';
import { buildPromotionExpiryFunctions } from './promotion-expiry.functions';

@Injectable()
export class PromotionExpiryInngestRegistrar implements OnModuleInit {
  private readonly logger = new Logger(PromotionExpiryInngestRegistrar.name);

  constructor(
    private readonly inngestService: InngestService,
    @Inject(NOTIFICATION_CONFIG_REPOSITORY)
    private readonly notificationConfigRepo: INotificationConfigRepository,
    @Inject(USER_EMAIL_LOOKUP)
    private readonly userEmailLookup: IUserEmailLookup,
    @Inject(PROMOTION_ALERT_LOOKUP)
    private readonly promotionAlertLookup: IPromotionAlertLookup,
    @Inject(MAILER)
    private readonly mailer: IMailer,
    private readonly tenantRunner: TenantRunnerService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit(): void {
    const appBaseUrl = this.configService.get<string>('APP_WEB_URL');
    const [fn] = buildPromotionExpiryFunctions({
      inngestClient: this.inngestService.getClient(),
      tenantRunner: this.tenantRunner,
      notificationConfigRepository: this.notificationConfigRepo,
      userEmailLookup: this.userEmailLookup,
      promotionAlertLookup: this.promotionAlertLookup,
      mailer: this.mailer,
      ...(appBaseUrl ? { appBaseUrl } : {}),
    });
    this.inngestService.registerFunctions([fn]);
    this.logger.log(
      `promotion-expiring-email Inngest function registered (id=${
        (fn as { id?: string }).id ?? 'unknown'
      })`,
    );
  }
}
