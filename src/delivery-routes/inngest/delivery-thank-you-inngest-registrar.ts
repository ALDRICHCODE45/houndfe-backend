/**
 * DeliveryThankYouInngestRegistrar — delivery-routes / DTE-4e.registration.
 *
 * Owns the boot-time lifecycle step that registers the
 * `delivery-thank-you-notify` Inngest function (DTE-4d) with
 * `InngestService` so the InngestController serve handler dispatches it.
 * Declared as a top-level provider in `app.module.ts` — never inside
 * another module — so its dependency graph (InngestService + MAILER +
 * NotificationConfigRepository + the three delivery-routes sale ports +
 * TenantRunner) resolves through AppModule's imports without forcing
 * those deps into every transitive chain.
 *
 * It composes the application `DeliveryThankYouSender` (DTE-4c) from the
 * injected ports and hands it to the framework-free
 * `buildDeliveryThankYouNotifyFunctions` (DTE-4d) builder. It reads NO
 * global tenant display name (`TENANT_NAME`) and no `ConfigService`:
 * there is no authoritative tenant brand lookup today, so the sender
 * keeps its neutral footer (`merchantName` omitted).
 *
 * Idempotence: `InngestService.registerFunctions` rejects a duplicate id
 * atomically, so a double wiring fails fast at boot instead of running
 * two handlers for the same trigger. The sibling
 * `delivery-next-stop-notify` registration is untouched and keeps its own
 * distinct id. This slice changes no event, schema, dispatcher or
 * migration.
 *
 * Mirrors `DeliveryRoutesInngestRegistrar` / `LowStockInngestRegistrar`
 * for the registration shape.
 */
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InngestService } from '../../inngest/inngest.service';
import { MAILER, type IMailer } from '../../notifications/email/mailer.port';
import {
  NOTIFICATION_CONFIG_REPOSITORY,
  type INotificationConfigRepository,
} from '../../notification-config/domain/notification-config.repository';
import { TenantRunnerService } from '../../shared/tenant/tenant-runner.service';
import { DeliveryThankYouSender } from '../application/delivery-thank-you-sender';
import {
  SALE_CUSTOMER_EMAIL_LOOKUP,
  type ISaleCustomerEmailLookup,
} from '../domain/ports/sale-customer-email.port';
import {
  SALE_DELIVERY_STOP_PROVENANCE,
  type ISaleDeliveryStopProvenance,
} from '../domain/ports/sale-delivery-stop-provenance.port';
import {
  SALE_DELIVERY_SUMMARY_READER,
  type ISaleDeliverySummaryReader,
} from '../domain/ports/sale-delivery-summary.port';
import {
  DELIVERY_THANK_YOU_NOTIFY_FUNCTION_ID,
  buildDeliveryThankYouNotifyFunctions,
} from './delivery-thank-you-notify.functions';

@Injectable()
export class DeliveryThankYouInngestRegistrar implements OnModuleInit {
  private readonly logger = new Logger(DeliveryThankYouInngestRegistrar.name);

  constructor(
    private readonly inngestService: InngestService,
    @Inject(NOTIFICATION_CONFIG_REPOSITORY)
    private readonly notificationConfigRepo: INotificationConfigRepository,
    @Inject(SALE_DELIVERY_STOP_PROVENANCE)
    private readonly stopProvenance: ISaleDeliveryStopProvenance,
    @Inject(SALE_DELIVERY_SUMMARY_READER)
    private readonly summaryReader: ISaleDeliverySummaryReader,
    @Inject(SALE_CUSTOMER_EMAIL_LOOKUP)
    private readonly customerEmailLookup: ISaleCustomerEmailLookup,
    @Inject(MAILER)
    private readonly mailer: IMailer,
    private readonly tenantRunner: TenantRunnerService,
  ) {}

  onModuleInit(): void {
    const sender = new DeliveryThankYouSender({
      tenantRunner: this.tenantRunner,
      notificationConfig: this.notificationConfigRepo,
      stopProvenance: this.stopProvenance,
      summaryReader: this.summaryReader,
      customerEmailLookup: this.customerEmailLookup,
      mailer: this.mailer,
    });

    const [fn] = buildDeliveryThankYouNotifyFunctions({
      inngestClient: this.inngestService.getClient(),
      sender,
    });

    this.inngestService.registerFunctions([fn]);
    this.logger.log(
      `delivery-thank-you-notify Inngest function registered (id=${DELIVERY_THANK_YOU_NOTIFY_FUNCTION_ID})`,
    );
  }
}
