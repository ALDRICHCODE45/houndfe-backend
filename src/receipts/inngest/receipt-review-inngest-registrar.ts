/**
 * ReceiptReviewInngestRegistrar — registers the receipt Inngest functions
 * (transfer-receipts / T2): the RECEIPT_REVIEW_REQUESTED email and the
 * 5-year retention purge cron. Top-level AppModule provider, mirroring
 * HrTimeOffInngestRegistrar, so its dependency graph (InngestService +
 * MAILER + notification config + reviewer lookup + TenantRunner) never leaks
 * into the chatbot module chain.
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
  RECEIPT_REVIEWER_LOOKUP,
  type IReceiptReviewerLookup,
} from '../domain/receipt-reviewer-lookup.port';
import { buildReceiptReviewNotificationFunctions } from './receipt-review-notification.functions';
import { buildReceiptRetentionFunctions } from './receipt-retention.functions';
import { ReceiptRetentionService } from '../application/receipt-retention.service';

@Injectable()
export class ReceiptReviewInngestRegistrar implements OnModuleInit {
  private readonly logger = new Logger(ReceiptReviewInngestRegistrar.name);

  constructor(
    private readonly inngestService: InngestService,
    @Inject(NOTIFICATION_CONFIG_REPOSITORY)
    private readonly notificationConfigRepo: INotificationConfigRepository,
    @Inject(RECEIPT_REVIEWER_LOOKUP)
    private readonly reviewerLookup: IReceiptReviewerLookup,
    @Inject(MAILER)
    private readonly mailer: IMailer,
    private readonly tenantRunner: TenantRunnerService,
    private readonly configService: ConfigService,
    private readonly retention: ReceiptRetentionService,
  ) {}

  onModuleInit(): void {
    const appBaseUrl = this.configService.get<string>('APP_WEB_URL');
    const functions = [
      ...buildReceiptReviewNotificationFunctions({
        inngestClient: this.inngestService.getClient(),
        tenantRunner: this.tenantRunner,
        notificationConfigRepository: this.notificationConfigRepo,
        reviewerLookup: this.reviewerLookup,
        mailer: this.mailer,
        ...(appBaseUrl ? { appBaseUrl } : {}),
      }),
      ...buildReceiptRetentionFunctions({
        inngestClient: this.inngestService.getClient(),
        retention: this.retention,
      }),
    ];
    this.inngestService.registerFunctions(functions);
    this.logger.log(
      `${functions.length} receipt Inngest function(s) registered`,
    );
  }
}
