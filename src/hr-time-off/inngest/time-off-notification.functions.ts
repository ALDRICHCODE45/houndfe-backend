/**
 * Inngest function — HR time-off request email.
 *
 * Slice 6 of `hr-validation-notifications`. Registered with the
 * Inngest client via `buildTimeOffNotificationFunctions(...)`. The
 * builder is framework-free; the registrar (Slice 6.4) wires the
 * real `InngestService` instance + DI-resolved ports.
 *
 * **No batching (Design D2).** HR cardinality is low; one email per
 * request covers every recipient. The low-stock `batchEvents` pattern
 * is intentionally absent.
 *
 * **Step topology.** Three `step.run` checkpoints, each wrapped in
 * `tenantRunner.runWithTenant` so any tenant-scoped repo inside the
 * handler resolves through CLS:
 *
 *   1. `load-config` — re-read `{ enabled, enabledActions }`. Returns
 *      early when `enabled=false` OR `TIME_OFF_REQUESTED` is not in
 *      `enabledActions` (fn re-gate for config drift, Design D1).
 *   2. `resolve-recipients` — expand `recipients[]` user-ids to email
 *      addresses via the user repository (filtered by `isActive`),
 *      deduped. Returns early when the list is empty (spec scenario
 *      "Recipients Empty or Unresolved → No Send").
 *   3. `send-email` — render the React Email template and
 *      `MAILER.send(recipients, render(<TimeOffRequestEmail .../>))`.
 *
 * **No PII in subject.** The subject is the literal "Nueva solicitud
 * de tiempo libre" — never includes the employee name or type.
 *
 * Spec: time-off-notifications 'Recipients Are Resolved Within the
 * Correct Tenant' + 'Recipients Empty or Unresolved → No Send' +
 * 'Emit Gate' (fn re-gate).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { Inngest } from 'inngest';
import type { IMailer } from '../../notifications/email/mailer.port';
import {
  TimeOffRequestEmail,
  composeSubject,
} from '../../notifications/email/templates/time-off-request.email';
import type { TenantRunnerService } from '../../shared/tenant/tenant-runner.service';
import type { INotificationConfigRepository } from '../../notification-config/domain/notification-config.repository';
import type { IUserEmailLookup } from '../../stock-alerts/domain/user-email-lookup.repository';

export interface TimeOffEventPayload {
  tenantId: string;
  timeOffId: string;
  employeeId: string;
  type: string;
  startDate: string;
  endDate: string;
  employeeName: string;
  requestedByUserId: string | null;
}

type InngestEventContext = {
  event: {
    id: string;
    name: string;
    data: TimeOffEventPayload;
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

export interface BuildTimeOffNotificationFunctionsInput {
  inngestClient: Inngest;
  tenantRunner: Pick<TenantRunnerService, 'runWithTenant'>;
  notificationConfigRepository: Pick<INotificationConfigRepository, 'find'>;
  userEmailLookup: IUserEmailLookup;
  mailer: IMailer;
  /** Per-tenant web app base URL — used as the CTA link origin. */
  appBaseUrl?: string;
}

/**
 * Build the `time-off-request-email` Inngest function. Returns the
 * SDK-shaped function object so the registrar can pass it to
 * `inngestService.registerFunctions([fn])`.
 *
 * **No `batchEvents` (Design D2).** The function consumes ONE event
 * per run; HR cardinality is low enough that per-request single-email
 * semantics are correct (and avoids the complexity of cross-tenant
 * coalescing).
 */
export function buildTimeOffNotificationFunctions(
  input: BuildTimeOffNotificationFunctionsInput,
): unknown[] {
  const fn = input.inngestClient.createFunction(
    {
      id: 'time-off-request-email',
      triggers: [{ event: 'hr/timeoff.requested' }],
      // Design D1 — fn re-gates for config drift between write-time
      // and send-time. Inngest's built-in dedupe handles replays.
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
      // low-stock fn pattern at `low-stock.functions.ts:165`.
      const config = (await ctx.step.run('load-config', () =>
        input.tenantRunner.runWithTenant(tenantId, () =>
          input.notificationConfigRepository.find(),
        ),
      )) as {
        enabled: boolean;
        recipients: string[];
        enabledActions: string[];
      };

      // Re-gate (Design D1): the upstream `request()` already gated at
      // write-time; the fn re-gates to handle config drift between
      // then and now (the user may have disabled notifications, or
      // removed TIME_OFF_REQUESTED from enabledActions, before the
      // dispatcher claimed the row).
      if (!config.enabled) {
        return { skipped: 'master-disabled' };
      }
      if (!config.enabledActions.includes('TIME_OFF_REQUESTED')) {
        return { skipped: 'action-disabled' };
      }

      const recipientUserIds = config.recipients;
      if (recipientUserIds.length === 0) {
        return { skipped: 'no-recipients' };
      }

      // (2) resolve-recipients — inside a step body so the lookup is
      // checkpointed. The lookup joins through TenantMembership +
      // User.isActive (filtered to the calling tenant — cross-tenant
      // rows never resolve). Dedup happens at the user-port level.
      const recipients = (await ctx.step.run('resolve-recipients', () =>
        input.tenantRunner.runWithTenant(tenantId, () =>
          input.userEmailLookup.resolveEmailsByUserIds(recipientUserIds),
        ),
      )) as string[];
      const dedupedRecipients = Array.from(new Set<string>(recipients));

      if (dedupedRecipients.length === 0) {
        return { skipped: 'no-active-recipients' };
      }

      // (3) send-email — render the template, then dispatch via MAILER.
      const html = renderToStaticMarkup(
        TimeOffRequestEmail({
          employeeName: payload.employeeName,
          type: payload.type,
          startDate: payload.startDate,
          endDate: payload.endDate,
          requestedByUserId: payload.requestedByUserId,
          appBaseUrl: input.appBaseUrl,
        }) as ReactElement,
      );

      await ctx.step.run('send-email', () =>
        input.mailer.send({
          to: dedupedRecipients,
          subject: composeSubject(),
          html,
        }),
      );

      return { sent: true };
    },
  );

  return [fn];
}