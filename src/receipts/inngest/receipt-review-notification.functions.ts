/**
 * Inngest function — RECEIPT_REVIEW_REQUESTED staff email
 * (transfer-receipts / T2). Mirrors the time-off request function: one
 * email per event, three checkpointed steps, each inside the tenant's CLS
 * scope (opened INSIDE `step.run`, never around it).
 *
 *   1. `load-config` — re-gate for config drift: master toggle and action.
 *   2. `resolve-recipients` — configured recipients narrowed to active
 *      members who can review receipts, deduped.
 *   3. `send-email` — render and send. The file is never attached.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { Inngest } from 'inngest';
import type { IMailer } from '../../notifications/email/mailer.port';
import {
  ReceiptReviewRequestedEmail,
  composeSubject,
} from '../../notifications/email/templates/receipt-review-requested.email';
import type { TenantRunnerService } from '../../shared/tenant/tenant-runner.service';
import type { INotificationConfigRepository } from '../../notification-config/domain/notification-config.repository';
import type { IReceiptReviewerLookup } from '../domain/receipt-reviewer-lookup.port';
import {
  RECEIPT_REVIEW_REQUESTED_INNGEST_EVENT,
  type ReceiptReviewRequestedPayload,
} from '../domain/receipt-review-requested.event';

export const RECEIPT_REVIEW_REQUESTED_FUNCTION_ID =
  'receipt-review-requested-email';

type InngestEventContext = {
  event: { id: string; name: string; data: ReceiptReviewRequestedPayload };
  step: {
    run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
  };
};

export interface BuildReceiptReviewNotificationFunctionsInput {
  inngestClient: Inngest;
  tenantRunner: Pick<TenantRunnerService, 'runWithTenant'>;
  notificationConfigRepository: Pick<INotificationConfigRepository, 'find'>;
  reviewerLookup: IReceiptReviewerLookup;
  mailer: IMailer;
  /** Web app origin for the CTA link. */
  appBaseUrl?: string;
}

export function buildReceiptReviewNotificationFunctions(
  input: BuildReceiptReviewNotificationFunctionsInput,
): unknown[] {
  const fn = input.inngestClient.createFunction(
    {
      id: RECEIPT_REVIEW_REQUESTED_FUNCTION_ID,
      triggers: [{ event: RECEIPT_REVIEW_REQUESTED_INNGEST_EVENT }],
      idempotency: 'event.id',
      retries: 3,
      concurrency: { limit: 5 },
    },
    async (ctx: InngestEventContext) => {
      const payload = ctx.event.data;
      const tenantId = payload?.tenantId;
      if (!tenantId) {
        return { skipped: 'missing-tenant' };
      }

      const config = (await ctx.step.run('load-config', () =>
        input.tenantRunner.runWithTenant(tenantId, () =>
          input.notificationConfigRepository.find(),
        ),
      )) as {
        enabled: boolean;
        recipients: string[];
        enabledActions: string[];
      };
      if (!config.enabled) {
        return { skipped: 'master-disabled' };
      }
      if (!config.enabledActions.includes('RECEIPT_REVIEW_REQUESTED')) {
        return { skipped: 'action-disabled' };
      }
      if (config.recipients.length === 0) {
        return { skipped: 'no-recipients' };
      }

      const emails = (await ctx.step.run('resolve-recipients', () =>
        input.tenantRunner.runWithTenant(tenantId, () =>
          input.reviewerLookup.resolveReviewerEmails(config.recipients),
        ),
      )) as string[];
      const recipients = Array.from(new Set<string>(emails));
      if (recipients.length === 0) {
        return { skipped: 'no-reviewer-recipients' };
      }

      const html = renderToStaticMarkup(
        ReceiptReviewRequestedEmail({
          saleFolio: payload.saleFolio,
          declaredAmountCents: payload.declaredAmountCents,
          extractedAmountCents: payload.extractedAmountCents,
          debtCents: payload.debtCents,
          mismatchFlagged: payload.mismatchFlagged,
          appBaseUrl: input.appBaseUrl,
        }) as ReactElement,
      );

      await ctx.step.run('send-email', () =>
        input.mailer.send({
          to: recipients,
          subject: composeSubject(payload.saleFolio),
          html,
        }),
      );

      return { sent: true };
    },
  );

  return [fn];
}
