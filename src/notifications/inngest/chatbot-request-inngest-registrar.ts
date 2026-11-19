/**
 * Registers the chatbot request notice email function. Top-level AppModule
 * provider, like `ReceiptReviewInngestRegistrar`, so its graph (InngestService
 * + MAILER + loader) never leaks into other module chains.
 */
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InngestService } from '../../inngest/inngest.service';
import { MAILER, type IMailer } from '../email/mailer.port';
import {
  NOTICE_EMAIL_LOADER,
  buildChatbotRequestEmailFunctions,
  type INoticeEmailLoader,
} from './chatbot-request-email.functions';

@Injectable()
export class ChatbotRequestInngestRegistrar implements OnModuleInit {
  private readonly logger = new Logger(ChatbotRequestInngestRegistrar.name);

  constructor(
    private readonly inngestService: InngestService,
    @Inject(NOTICE_EMAIL_LOADER) private readonly loader: INoticeEmailLoader,
    @Inject(MAILER) private readonly mailer: IMailer,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit(): void {
    const appBaseUrl = this.configService.get<string>('APP_WEB_URL');
    const functions = buildChatbotRequestEmailFunctions({
      inngestClient: this.inngestService.getClient(),
      loader: this.loader,
      mailer: this.mailer,
      ...(appBaseUrl ? { appBaseUrl } : {}),
    });
    this.inngestService.registerFunctions(functions);
    this.logger.log(
      `${functions.length} chatbot request notice Inngest function(s) registered`,
    );
  }
}
