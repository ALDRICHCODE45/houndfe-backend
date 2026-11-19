/**
 * Inngest function: chatbot request notice email (unit 6; contract §5.1, §6.3).
 * One email per event (a batch event carries several notifications), two
 * checkpointed steps, in the style of `receipt-review-notification.functions.ts`:
 *
 *   1. `load`  — the person's address and preference, the branch name and the
 *      notices (type, request id, folio, subtype). Re-checked here because the
 *      email may leave minutes after it was queued: an inactive person, one
 *      who lost the tenant, or one who turned email off since gets nothing.
 *   2. `send-email` — render and send through the `IMailer` port (Resend).
 *
 * The email never has the customer's name or phone: the loader does not even
 * read them (§6.3).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { Inngest } from 'inngest';
import type { IMailer } from '../email/mailer.port';
import {
  ChatbotRequestNoticeEmail,
  composeSubject,
  type NoticeEmailItem,
} from '../email/templates/chatbot-request-notice.email';
import { NOTICE_EMAIL_INNGEST_EVENT } from '../domain/chatbot-request-notice';
import type { NoticeEmailEvent } from '../outbox/chatbot-request-email.dispatcher';

export const NOTICE_EMAIL_FUNCTION_ID = 'chatbot-request-notice-email';

export interface NoticeEmailLoad {
  email: string;
  branchName: string;
  items: NoticeEmailItem[];
}

export interface INoticeEmailLoader {
  /** `null` when nobody should be emailed (see the file header). */
  load(event: NoticeEmailEvent): Promise<NoticeEmailLoad | null>;
}

export const NOTICE_EMAIL_LOADER = Symbol.for('NoticeEmailLoader');

type InngestEventContext = {
  event: { id: string; name: string; data: NoticeEmailEvent };
  step: {
    run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
  };
};

export interface BuildNoticeEmailFunctionsInput {
  inngestClient: Inngest;
  loader: INoticeEmailLoader;
  mailer: IMailer;
  /** Web app origin for the deep links (`APP_WEB_URL`). */
  appBaseUrl?: string;
}

export function buildChatbotRequestEmailFunctions(
  input: BuildNoticeEmailFunctionsInput,
): unknown[] {
  const fn = input.inngestClient.createFunction(
    {
      id: NOTICE_EMAIL_FUNCTION_ID,
      triggers: [{ event: NOTICE_EMAIL_INNGEST_EVENT }],
      idempotency: 'event.id',
      retries: 3,
      concurrency: { limit: 5 },
    },
    async (ctx: InngestEventContext) => {
      const event = ctx.event.data;
      if (!event?.tenantId || !event.userId || !event.notificationIds?.length) {
        return { skipped: 'malformed-event' };
      }
      const loaded = (await ctx.step.run('load', () =>
        input.loader.load(event),
      )) as NoticeEmailLoad | null;
      if (!loaded || loaded.items.length === 0) {
        return { skipped: 'nobody-to-email' };
      }
      const html = renderToStaticMarkup(
        ChatbotRequestNoticeEmail({
          items: loaded.items,
          branchName: loaded.branchName,
          ...(input.appBaseUrl ? { appBaseUrl: input.appBaseUrl } : {}),
        }) as ReactElement,
      );
      await ctx.step.run('send-email', () =>
        input.mailer.send({
          to: [loaded.email],
          subject: composeSubject(loaded.items, loaded.branchName),
          html,
        }),
      );
      return { sent: true, notices: loaded.items.length };
    },
  );
  return [fn];
}
