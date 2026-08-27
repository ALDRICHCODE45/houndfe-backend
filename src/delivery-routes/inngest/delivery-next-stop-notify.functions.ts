/**
 * Inngest function — delivery-routes / WU3 (design §5 + §8.5).
 *
 * Registered with the Inngest client via
 * `buildDeliveryNextStopNotifyFunctions(...)`. The builder is
 * framework-free; the registrar wires the real `InngestService`
 * instance + DI-resolved ports.
 *
 * **No batching.** Delivery-route cardinality is low and per-stop
 * notification cadence is bounded; one event → one email. The
 * low-stock coalescing pattern does not apply.
 *
 * **Step topology (design §8.5).** Three `step.run` checkpoints, each
 * wrapped in `tenantRunner.runWithTenant` so any tenant-scoped repo
 * inside the handler resolves through CLS:
 *
 *   1. `load-config` — re-read `{ enabled, enabledActions }`. Returns
 *      early when `enabled=false` OR `DELIVERY_NEXT_STOP` is not in
 *      `enabledActions` (fn re-gate for config drift, design §1).
 *   2. `resolve-recipient` — `ISaleCustomerEmailLookup.findEmailBySaleId`
 *      inside `runWithTenant`. Returns early with `skipped: no-email`
 *      when the lookup resolves null (no customer email on file, or
 *      cross-tenant). The lookup is authoritative at send-time; the
 *      write-time snapshot in the payload is ignored.
 *   3. `send-email` — render the React Email template and
 *      `MAILER.send({ to: email, ... })`.
 *
 * **No PII in subject.** The subject is the literal "Tu paquete está
 * por llegar" — never includes the customer name or address.
 *
 * Spec: design.md §5 (route check-in durable pipeline) + §8.5
 * (Inngest function) + spec scenarios
 * *NotificationConfig Re-Gate at Send Time* + *Durable Next-Stop
 * Notification Pipeline*.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { Inngest } from 'inngest';
import type { IMailer } from '../../notifications/email/mailer.port';
import {
  DeliveryNextStopEmail,
  composeDeliveryNextStopSubject,
} from '../../notifications/email/templates/delivery-next-stop.email';
import type { TenantRunnerService } from '../../shared/tenant/tenant-runner.service';
import type { INotificationConfigRepository } from '../../notification-config/domain/notification-config.repository';
import type { ISaleCustomerEmailLookup } from '../domain/ports/sale-customer-email.port';

export interface DeliveryNextStopEventPayload {
  tenantId: string;
  routeId: string;
  currentStopId: string;
  nextStopId: string;
  nextSaleId: string;
  nextCustomerName: string | null;
  nextAddressLabel: string | null;
  nextCustomerEmail: string | null;
  idempotencyKey: string;
  occurredAt: string;
}

type InngestEventContext = {
  event: {
    id: string;
    name: string;
    data: DeliveryNextStopEventPayload;
  };
  step: {
    run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
    sleep: (name: string, duration: string) => Promise<void>;
    sendEvent: (
      name: string,
      events: Array<{ name: string; data: unknown }>,
    ) => Promise<void>;
  };
};

export interface BuildDeliveryNextStopNotifyFunctionsInput {
  inngestClient: Inngest;
  tenantRunner: Pick<TenantRunnerService, 'runWithTenant'>;
  notificationConfigRepository: Pick<INotificationConfigRepository, 'find'>;
  saleCustomerEmailLookup: ISaleCustomerEmailLookup;
  mailer: IMailer;
  /** Per-tenant web app base URL — used as the CTA link origin. */
  appBaseUrl?: string;
  /**
   * Tenant display name — used in the email footer. When omitted, the
   * template falls back to a generic phrasing. The lookup is
   * intentionally decoupled from `findEmailBySaleId` so the dispatcher
   * dependency graph stays minimal.
   */
  tenantName?: string;
}

/**
 * Build the `delivery-next-stop-notify` Inngest function. Returns the
 * SDK-shaped function object so the registrar can pass it to
 * `inngestService.registerFunctions([fn])`.
 *
 * **No `batchEvents`.** The function consumes ONE event per run;
 * delivery-route cardinality is bounded (one next-stop per check-in)
 * and the email template renders a single recipient per row.
 */
export function buildDeliveryNextStopNotifyFunctions(
  input: BuildDeliveryNextStopNotifyFunctionsInput,
): unknown[] {
  const fn = input.inngestClient.createFunction(
    {
      id: 'delivery-next-stop-notify',
      triggers: [{ event: 'delivery/next-stop.notify' }],
      // Idempotency — collapses replays via the SDK's built-in dedupe.
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

      // (1) load-config — runs inside the tenant's CLS scope.
      //
      // CRITICAL ordering: `runWithTenant` (which opens the CLS scope
      // via `cls.run`) MUST be INSIDE the `step.run` callback, not
      // wrapping it. Inngest re-executes the function body multiple
      // times per run and memoizes completed steps; the step callback
      // runs in a DIFFERENT async context than the outer function
      // body. If CLS were opened outside `step.run`,
      // AsyncLocalStorage would be lost by the time the Prisma query
      // inside `find()` reads `cls.get('tenantId')`. Mirrors the
      // low-stock / hr-time-off fn pattern.
      const config = (await ctx.step.run('load-config', () =>
        input.tenantRunner.runWithTenant(tenantId, () =>
          input.notificationConfigRepository.find(),
        ),
      )) as {
        enabled: boolean;
        recipients: string[];
        enabledActions: string[];
      };

      // Re-gate (design §1): the upstream `checkInStop` already gated
      // at write-time; the fn re-gates to handle config drift between
      // then and now (the tenant admin may have disabled notifications,
      // or removed DELIVERY_NEXT_STOP from enabledActions, before the
      // dispatcher claimed the row).
      if (!config.enabled) {
        return { skipped: 'master-disabled' };
      }
      if (!config.enabledActions.includes('DELIVERY_NEXT_STOP')) {
        return { skipped: 'action-disabled' };
      }

      // (2) resolve-recipient — inside a step body so the lookup is
      // checkpointed. The lookup joins through `sale.customer.email`
      // and is tenant-scoped at the `where` clause (defense in depth on
      // top of the CLS scope). Cross-tenant / missing / null-email
      // returns `null` and the fn logs `skipped: no-email` — no error.
      const email = (await ctx.step.run('resolve-recipient', () =>
        input.tenantRunner.runWithTenant(tenantId, () =>
          input.saleCustomerEmailLookup.findEmailBySaleId({
            tenantId,
            saleId: payload.nextSaleId,
          }),
        ),
      )) as string | null;

      if (!email) {
        return { skipped: 'no-email' };
      }

      // (3) send-email — render the template, then dispatch via MAILER.
      const html = renderToStaticMarkup(
        DeliveryNextStopEmail({
          nextCustomerName: payload.nextCustomerName,
          nextAddressLabel: payload.nextAddressLabel,
          ...(input.tenantName ? { tenantName: input.tenantName } : {}),
          ...(input.appBaseUrl ? { appBaseUrl: input.appBaseUrl } : {}),
        }) as ReactElement,
      );

      await ctx.step.run('send-email', () =>
        input.mailer.send({
          to: [email],
          subject: composeDeliveryNextStopSubject(),
          html,
        }),
      );

      return { sent: true };
    },
  );

  return [fn];
}
