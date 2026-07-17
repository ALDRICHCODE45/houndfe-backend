/**
 * HrTimeOffInngestRegistrar — Slice 6 wiring.
 *
 * Owns the lifecycle step that registers the `time-off-request-email`
 * Inngest function with `InngestService` so the InngestController
 * serve handler dispatches it. Extracted so its dep graph (InngestService
 * + MAILER + NotificationConfigRepo + UserEmailLookup + TenantRunner)
 * resolves through AppModule's imports WITHOUT forcing those deps
 * into every transitive chain.
 *
 * Mirrors `LowStockInngestRegistrar` exactly — same ports, same
 * construction, same `registerFunctions([fn])` shape.
 *
 * Spec: design.md D5 — reuse tokens. NOTIFICATION_CONFIG_REPOSITORY /
 * USER_EMAIL_LOOKUP / MAILER / TenantRunnerService all resolve at
 * AppModule scope; no new adapters.
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
import { buildTimeOffNotificationFunctions } from './time-off-notification.functions';

@Injectable()
export class HrTimeOffInngestRegistrar implements OnModuleInit {
  private readonly logger = new Logger(HrTimeOffInngestRegistrar.name);

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
    const [fn] = buildTimeOffNotificationFunctions({
      inngestClient: this.inngestService.getClient(),
      tenantRunner: this.tenantRunner,
      notificationConfigRepository: this.notificationConfigRepo,
      userEmailLookup: this.userEmailLookup,
      mailer: this.mailer,
      ...(appBaseUrl ? { appBaseUrl } : {}),
    });
    this.inngestService.registerFunctions([fn]);
    this.logger.log(
      `time-off-request-email Inngest function registered (id=${
        (fn as { id?: string }).id ?? 'unknown'
      })`,
    );
  }
}