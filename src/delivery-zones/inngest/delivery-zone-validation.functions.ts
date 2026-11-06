/**
 * shipping-zones / T1 (S3) — Inngest function: delivery-zone validation email.
 *
 * Mirrors `time-off-notification.functions.ts`: one email per opened
 * validation, three checkpointed steps, each inside the tenant CLS scope:
 *   1. `load-config`        re-gate (master toggle + action key enabled).
 *   2. `resolve-recipients` configured recipients -> those that can validate
 *                           zones -> active, deduped emails.
 *   3. `send-email`         render the React Email template and send.
 * No PII in the subject; the customer phone is never in the payload.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { Inngest } from 'inngest';
import type { IMailer } from '../../notifications/email/mailer.port';
import {
  composeDeliveryZoneValidationSubject,
  DeliveryZoneValidationEmail,
} from '../../notifications/email/templates/delivery-zone-validation.email';
import type { INotificationConfigRepository } from '../../notification-config/domain/notification-config.repository';
import type { TenantRunnerService } from '../../shared/tenant/tenant-runner.service';
import type { IUserEmailLookup } from '../../stock-alerts/domain/user-email-lookup.repository';
import type { DeliveryZoneValidationRequestedPayload } from '../domain/delivery-zone-bot.repository';
import type { IDeliveryZoneValidatorLookup } from '../domain/delivery-zone-validator-lookup';

export const DELIVERY_ZONE_VALIDATION_EMAIL_FUNCTION_ID =
  'delivery-zone-validation-email';
export const DELIVERY_ZONE_VALIDATION_INNGEST_EVENT =
  'delivery-zones/validation.requested';
const ACTION_KEY = 'DELIVERY_ZONE_VALIDATION_REQUESTED';

type InngestEventContext = {
  event: {
    id: string;
    name: string;
    data: Partial<DeliveryZoneValidationRequestedPayload> | undefined;
  };
  step: {
    run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
  };
};

export interface BuildDeliveryZoneValidationFunctionsInput {
  inngestClient: Inngest;
  tenantRunner: Pick<TenantRunnerService, 'runWithTenant'>;
  notificationConfigRepository: Pick<INotificationConfigRepository, 'find'>;
  validatorLookup: IDeliveryZoneValidatorLookup;
  userEmailLookup: IUserEmailLookup;
  mailer: IMailer;
  /** Store web app base URL used as the CTA link. */
  appBaseUrl?: string;
}

export function buildDeliveryZoneValidationFunctions(
  input: BuildDeliveryZoneValidationFunctionsInput,
): unknown[] {
  const fn = input.inngestClient.createFunction(
    {
      id: DELIVERY_ZONE_VALIDATION_EMAIL_FUNCTION_ID,
      triggers: [{ event: DELIVERY_ZONE_VALIDATION_INNGEST_EVENT }],
      idempotency: 'event.id',
      retries: 3,
      concurrency: { limit: 5 },
    },
    async (ctx: InngestEventContext) => {
      const payload = ctx.event.data;
      const tenantId = payload?.tenantId;
      if (!payload || !tenantId) {
        return { skipped: 'missing-tenant' };
      }
      const inTenant = <T>(work: () => Promise<T>) =>
        input.tenantRunner.runWithTenant(tenantId, work);

      // CLS must open INSIDE each step callback (see time-off fn).
      const config = (await ctx.step.run('load-config', () =>
        inTenant(() => input.notificationConfigRepository.find()),
      )) as {
        enabled: boolean;
        recipients: string[];
        enabledActions: string[];
      };
      if (!config.enabled) {
        return { skipped: 'master-disabled' };
      }
      if (!config.enabledActions.includes(ACTION_KEY)) {
        return { skipped: 'action-disabled' };
      }
      if (config.recipients.length === 0) {
        return { skipped: 'no-recipients' };
      }

      const recipients = (await ctx.step.run('resolve-recipients', () =>
        inTenant(async () => {
          const validators = await input.validatorLookup.filterValidators(
            config.recipients,
          );
          return validators.length === 0
            ? []
            : input.userEmailLookup.resolveEmailsByUserIds(validators);
        }),
      )) as string[];
      const to = Array.from(new Set<string>(recipients));
      if (to.length === 0) {
        return { skipped: 'no-validators' };
      }

      const html = renderToStaticMarkup(
        DeliveryZoneValidationEmail({
          branchName: payload.branchName ?? null,
          zipCode: payload.zipCode ?? '',
          state: payload.state ?? '',
          municipality: payload.municipality ?? '',
          neighborhood: payload.neighborhood ?? '',
          deadlineAt: payload.deadlineAt ?? '',
          appBaseUrl: input.appBaseUrl,
        }) as ReactElement,
      );
      await ctx.step.run('send-email', () =>
        input.mailer.send({
          to,
          subject: composeDeliveryZoneValidationSubject(payload.zipCode ?? ''),
          html,
        }),
      );
      return { sent: true };
    },
  );
  return [fn];
}
