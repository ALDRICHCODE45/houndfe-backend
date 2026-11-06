/**
 * shipping-zones / T1 (S3) — registers `delivery-zone-validation-email`.
 * Same top-level-provider pattern as `HrTimeOffInngestRegistrar`.
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
  DELIVERY_ZONE_VALIDATOR_LOOKUP,
  type IDeliveryZoneValidatorLookup,
} from '../domain/delivery-zone-validator-lookup';
import { buildDeliveryZoneValidationFunctions } from './delivery-zone-validation.functions';

@Injectable()
export class DeliveryZoneInngestRegistrar implements OnModuleInit {
  private readonly logger = new Logger(DeliveryZoneInngestRegistrar.name);

  constructor(
    private readonly inngestService: InngestService,
    @Inject(NOTIFICATION_CONFIG_REPOSITORY)
    private readonly notificationConfigRepo: INotificationConfigRepository,
    @Inject(DELIVERY_ZONE_VALIDATOR_LOOKUP)
    private readonly validatorLookup: IDeliveryZoneValidatorLookup,
    @Inject(USER_EMAIL_LOOKUP)
    private readonly userEmailLookup: IUserEmailLookup,
    @Inject(MAILER)
    private readonly mailer: IMailer,
    private readonly tenantRunner: TenantRunnerService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit(): void {
    const appBaseUrl = this.configService.get<string>('APP_WEB_URL');
    const [fn] = buildDeliveryZoneValidationFunctions({
      inngestClient: this.inngestService.getClient(),
      tenantRunner: this.tenantRunner,
      notificationConfigRepository: this.notificationConfigRepo,
      validatorLookup: this.validatorLookup,
      userEmailLookup: this.userEmailLookup,
      mailer: this.mailer,
      ...(appBaseUrl ? { appBaseUrl } : {}),
    });
    this.inngestService.registerFunctions([fn]);
    this.logger.log(
      `delivery-zone-validation-email Inngest function registered (id=${
        (fn as { id?: string }).id ?? 'unknown'
      })`,
    );
  }
}
