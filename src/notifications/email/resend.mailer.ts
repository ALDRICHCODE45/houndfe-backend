/**
 * ADAPTER: ResendMailer.
 *
 * Slice F.1 of `low-stock-alerts`. Production adapter for `MAILER`
 * over the Resend SDK. Two modes, gated by `RESEND_API_KEY`:
 *
 *   1. **Production (`NODE_ENV=production` + RESEND_API_KEY set).**
 *      Constructs `new Resend(apiKey)` and calls `resend.emails.send`
 *      with `(from, to[], subject, html)`. The SDK response is
 *      interpreted as:
 *        - `data` non-null AND `error` null ⇒ resolve.
 *        - `error` non-null ⇒ reject (dedicated dispatcher F.5
 *          catches and retries).
 *
 *   2. **Dev / test / staging fallback** (`RESEND_API_KEY` unset,
 *      `NODE_ENV !== production`). Emits a structured Logger entry
 *      containing the rendered HTML and a REDACTED recipient list.
 *      Per design finding #4: the dev-logger fallback MUST redact
 *      recipient addresses to avoid PII leak in shared CI / dev
 *      output. The mailer resolves successfully so the Inngest
 *      function (F.2) sees a clean send completion — the dev logger
 *      is a developer-visible surfacing of "the email would have
 *      been sent", not a synthetic failure.
 *
 *   3. **Production with RESEND_API_KEY unset** — a belt-and-braces
 *      guard: the Joi schema (env.validation.ts) makes the key
 *      REQUIRED in production at boot, so this branch only fires if
 *      a runtime mutation nullifies the env. The mailer MUST throw
 *      (NOT silently fall back to the dev logger in production) —
 *      otherwise a misconfigured deployment would silently swallow
 *      sends while Inngest thinks they succeeded. The dedicated
 *      dispatcher (F.5) catches the throw and marks PENDING + retry,
 *      surfacing the failure in logs and the prod send-failure alert
 *      path.
 *
 * **Why no PII in dev logs.** The current generic dispatcher
 * (`outbox-dispatcher.service.ts`) is fire-and-forget; this adapter
 * MUST treat every `RESEND_API_KEY`-unset send as a SUCCESSFUL send
 * (resolve) so the Inngest function is satisfied with exactly one
 * render. Logging the recipient list would let any party with
 * read-only log access enumerate your tenant's notification
 * recipients — a tenant-isolation regression we explicitly avoid.
 *
 * Spec coverage:
 *   - "DEV redacts recipients"   (F.1 spec)
 *   - "PROD without RESEND_API_KEY throws" (F.1 spec)
 *   - design.md §"Inngest + Resend Wiring" (ResendMailer paragraph)
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import type { IMailer, SendMailInput } from './mailer.port';

@Injectable()
export class ResendMailer implements IMailer {
  private readonly logger = new Logger(ResendMailer.name);
  // Resend client is constructed lazily so the dev-logger path can
  // skip it entirely (and so a `ConfigService.get('RESEND_API_KEY')`
  // that returns `undefined` doesn't propagate to the SDK ctor).
  private readonly client: Resend | null;
  private readonly fromAddress: string | undefined;
  private readonly nodeEnv: string | undefined;

  constructor(@Inject(ConfigService) configService: ConfigService) {
    const apiKey = configService.get<string>('RESEND_API_KEY');
    this.client = apiKey ? new Resend(apiKey) : null;
    this.fromAddress = configService.get<string>('MAIL_FROM');
    this.nodeEnv = configService.get<string>('NODE_ENV');
  }

  async send(input: SendMailInput): Promise<void> {
    const redactRecipients = this.shouldRedactRecipients();

    if (redactRecipients) {
      this.devLoggerFallback(input);
      return;
    }

    if (!this.client) {
      // NODE_ENV=production with no RESEND_API_KEY — see file header,
      // branch 3. The dedicated dispatcher (F.5) catches this throw,
      // marks the row PENDING, and retries. After maxRetries the row
      // is FAILED — the failure is logged AND surfaced to the prod
      // send-failure alert path.
      throw new Error(
        'ResendMailer.send: RESEND_API_KEY is unset in production. The dedicated outbox dispatcher will retry; if the env is misconfigured, fix RESEND_API_KEY.',
      );
    }

    const fromAddress = this.fromAddress;
    if (!fromAddress) {
      // Same fail-closed posture for the sender domain.
      throw new Error(
        'ResendMailer.send: MAIL_FROM is unset. The dedicated outbox dispatcher will retry.',
      );
    }

    const result = await this.client.emails.send({
      from: fromAddress,
      to: input.to,
      subject: input.subject,
      html: input.html,
    });

    if (result.error) {
      throw new Error(
        `Resend send failed: ${result.error.name ?? 'unknown'}: ${result.error.message ?? 'no message'}`,
      );
    }

    // Resend returns `data: null` on success in some SDK versions;
    // resolve on either a non-null `data` or a null `error`.
    return;
  }

  /**
   * True when the mailer should emit the redacted dev-logger fallback
   * instead of calling Resend. Gated on the absence of an API key
   * AND a non-production `NODE_ENV` — in production with the key
   * unset we throw instead (branch 3 above).
   */
  private shouldRedactRecipients(): boolean {
    if (this.client !== null) return false;
    if (this.nodeEnv === 'production') return false;
    return true;
  }

  /**
   * Dev-logger fallback. Logs ONE structured entry containing the
   * subject and html; recipient list is replaced with a length-only
   * summary. NEVER includes raw addresses in non-prod — see file
   * header + finding #4.
   */
  private devLoggerFallback(input: SendMailInput): void {
    this.logger.log({
      type: 'mailer.dev-logger',
      recipientCount: input.to.length,
      subject: input.subject,
      htmlBytes: input.html.length,
      // The full html is intentionally NOT logged in production;
      // in dev we emit a truncated preview so the developer can spot
      // obvious render bugs without flooding the log.
      htmlPreview:
        input.html.length > 512
          ? `${input.html.slice(0, 512)}…[truncated]`
          : input.html,
    });
  }
}
