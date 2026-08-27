/**
 * DeliveryRoutesInngestRegistrar — delivery-routes / WU3 (design §8.5).
 *
 * Owns the lifecycle step that registers the
 * `delivery-next-stop-notify` Inngest function with `InngestService`
 * so the InngestController serve handler dispatches it. Extracted from
 * `DeliveryRoutesModule` so the module's dep graph stays slim and the
 * function is reachable at AppModule scope (where `InngestService`,
 * `MAILER`, `NotificationConfigRepository`, `ISaleCustomerEmailLookup`,
 * and `TenantRunnerService` all resolve).
 *
 * Mirrors `LowStockInngestRegistrar` / `HrTimeOffInngestRegistrar`
 * exactly — same ports, same construction, same
 * `registerFunctions([fn])` shape.
 *
 * Spec: design.md §8.5 — function registration.
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
  SALE_CUSTOMER_EMAIL_LOOKUP,
  type ISaleCustomerEmailLookup,
} from '../domain/ports/sale-customer-email.port';
import { buildDeliveryNextStopNotifyFunctions } from './delivery-next-stop-notify.functions';

@Injectable()
export class DeliveryRoutesInngestRegistrar implements OnModuleInit {
  private readonly logger = new Logger(DeliveryRoutesInngestRegistrar.name);

  constructor(
    private readonly inngestService: InngestService,
    @Inject(NOTIFICATION_CONFIG_REPOSITORY)
    private readonly notificationConfigRepo: INotificationConfigRepository,
    @Inject(SALE_CUSTOMER_EMAIL_LOOKUP)
    private readonly saleCustomerEmailLookup: ISaleCustomerEmailLookup,
    @Inject(MAILER)
    private readonly mailer: IMailer,
    private readonly tenantRunner: TenantRunnerService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit(): void {
    const appBaseUrl = this.configService.get<string>('APP_WEB_URL');
    const tenantName = this.configService.get<string>('TENANT_NAME');
    const [fn] = buildDeliveryNextStopNotifyFunctions({
      inngestClient: this.inngestService.getClient(),
      tenantRunner: this.tenantRunner,
      notificationConfigRepository: this.notificationConfigRepo,
      saleCustomerEmailLookup: this.saleCustomerEmailLookup,
      mailer: this.mailer,
      ...(appBaseUrl ? { appBaseUrl } : {}),
      ...(tenantName ? { tenantName } : {}),
    });
    this.inngestService.registerFunctions([fn]);
    this.logger.log(
      `delivery-next-stop-notify Inngest function registered (id=${
        (fn as { id?: string }).id ?? 'unknown'
      })`,
    );
  }
}
