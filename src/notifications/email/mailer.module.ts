/**
 * MailerModule — NestJS module for the outbound email port.
 *
 * Slice F.1 of `low-stock-alerts`. Wires the `MAILER` injection
 * token → `ResendMailer`. The port is consumed by the Inngest
 * `low-stock-email` function (Slice F.2) at the `send-email` step.
 *
 * The adapter implements the dev-logger fallback (per design.md
 * finding #4): when `RESEND_API_KEY` is unset and `NODE_ENV !==
 * 'production'`, the rendered email is logged but recipient
 * addresses are REDACTED — this keeps dev / CI output PII-free.
 *
 * Decoupled from `NotificationConfigModule`: the mailer is a
 * primitive capability (one outbound API call) that any future
 * notification channel (push, Slack, etc.) may also use. Feature
 * modules import `MailerModule` to inject `@Inject(MAILER)`.
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MAILER } from './mailer.port';
import { ResendMailer } from './resend.mailer';

@Module({
  imports: [ConfigModule],
  providers: [
    ResendMailer,
    {
      provide: MAILER,
      useExisting: ResendMailer,
    },
  ],
  exports: [MAILER],
})
export class MailerModule {}
