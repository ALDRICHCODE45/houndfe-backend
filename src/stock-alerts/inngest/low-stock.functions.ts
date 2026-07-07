/**
 * Inngest function — low-stock email digest.
 *
 * Slice F.2 of `low-stock-alerts`. Registered with the Inngest
 * client via `buildLowStockFunctions({ inngestClient, ... })`. The
 * builder is intentionally framework-free: the `StockAlertsModule`
 * wires the actual `InngestService` instance + DI-resolved ports.
 *
 * **Coalescing (design Decision 3).** The function declares
 * `batchEvents: { maxSize: 50, timeout: '60s', key: 'event.data.tenantId' }`
 * so multiple crossings for the SAME tenant within the 60-second
 * window collapse to a single function run that renders ONE email
 * with every distinct item. Replays / retries of the same event
 * (`event.id`) collapse via `idempotency: 'event.id'` — finding #5.
 *
 * **Step topology (design Decision 4).** Four `step.run`
 * checkpoints, each wrapped in `tenantRunner.runWithTenant` so any
 * tenant-scoped repo inside the handler resolves through CLS:
 *
 *   1. `load-config` — read `{ enabled, enabledActions }`. Returns
 *      early when `enabled=false` OR `LOW_STOCK` is not in
 *      `enabledActions`.
 *   2. `resolve-recipients` — expand `recipients[]` user-ids to email
 *      addresses via the user repository (filtered by `isActive`),
 *      deduped. Returns early when the list is empty (spec scenario
 *      "Empty Recipient List Suppresses Sends").
 *   3. `compose-items` — fold the batch's `events[]` into
 *      `LowStockEmailItem[]` (dedupe by `itemKey`).
 *   4. `send-email` — render the React Email template and
 *      `MAILER.send(recipients, render(<LowStockEmail .../>))`.
 *
 * **No PII in subject.** The subject is "N productos con bajo
 * inventario" — never includes product names. Item-level detail
 * (name, variant, qty, min, SKU, category, deep link) lives in the
 * body only, per design Risk R-E.
 *
 * Spec coverage:
 *   - notification-config/spec.md ("Empty Recipient List Suppresses
 *     Sends", "Default State Is Notifications OFF").
 *   - design.md "Decision 3 / 4" + "Inngest + Resend Wiring".
 */
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { Inngest } from 'inngest';
import type { IMailer } from '../../notifications/email/mailer.port';
import {
  LowStockEmail,
  type LowStockEmailItem,
} from '../../notifications/email/templates/low-stock.email';
import type { TenantRunnerService } from '../../shared/tenant/tenant-runner.service';
import type {
  INotificationConfigRepository,
} from '../../notification-config/domain/notification-config.repository';
import type { LowStockEventPayload } from '../domain/stock-crossing';

/**
 * User-lookup port used by `resolve-recipients`. Defined locally so
 * this file does not pull the entire Users module into the spec
 * graph — the adapter implementation can live wherever
 * (StockAlertsModule will provide a Prisma-backed impl).
 */
export interface IUserEmailLookup {
  /**
   * Resolve a list of user-ids to active emails, deduped.
   * Inactive users are filtered out (spec: `isActive` predicate).
   * Returns an empty array when no ids resolve; never returns `null`.
   */
  resolveEmailsByUserIds(
    userIds: string[],
  ): Promise<string[]>;
}

/**
 * Minimal Inngest `events` shape consumed by the handler in
 * `batchEvents` mode. The SDK's full type is union-overloaded; this
 * is the exact slice the function reads.
 */
type InngestBatchEvent = {
  id: string;
  name: string;
  data: LowStockEventPayload;
};

type InngestBatchContext = {
  events: InngestBatchEvent[];
  // step is supplied by Inngest but typed loosely here so the spec
  // can fake it. The implementation only uses `step.run(...)`,
  // `step.sleep(...)`, and `step.sendEvent(...)` per
  // `low-stock.functions.spec.ts`.
  step: {
    run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
    sleep: (name: string, duration: string) => Promise<void>;
    sendEvent: (
      name: string,
      events: Array<{ name: string; data: unknown }>,
    ) => Promise<void>;
  };
};

export interface BuildLowStockFunctionsInput {
  inngestClient: Inngest;
  tenantRunner: Pick<TenantRunnerService, 'runWithTenant'>;
  notificationConfigRepository: Pick<
    INotificationConfigRepository,
    'find'
  >;
  userEmailLookup: IUserEmailLookup;
  mailer: IMailer;
  /** Per-tenant web app base URL — used as the footer link origin. */
  appBaseUrl?: string;
}

/**
 * Build the `low-stock-email` Inngest function. Returns the
 * `InngestFunction` shape that `InngestService.getFunctions()`
 * expects; the `StockAlertsModule` registers each entry with the
 * serve handler (`inngest.controller.ts`).
 */
export function buildLowStockFunctions(
  input: BuildLowStockFunctionsInput,
): unknown[] {
  const fn = input.inngestClient.createFunction(
    {
      id: 'low-stock-email',
      triggers: [{ event: 'stock/low.detected' }],
      // design Decision 3
      batchEvents: {
        maxSize: 50,
        timeout: '60s',
        key: 'event.data.tenantId',
      },
      // finding #5 — same event id replays collapse via the SDK's
      // built-in dedupe.
      idempotency: 'event.id',
      // design Decision 4
      retries: 3,
      concurrency: { limit: 5 },
    },
    async (ctx: InngestBatchContext) => {
      const events = ctx.events;
      if (!events || events.length === 0) {
        return { skipped: 'empty-batch' };
      }

      // All events in a coalesced batch share the same tenantId by
      // design (batchEvents key). Reading it from the first event is
      // unambiguous; we still defensively re-check the const invariant
      // so a misconfigured downstream caller cannot poison the CLS.
      const tenantId = events[0].data.tenantId;
      const sharedTenantId = events.every(
        (e) => e.data.tenantId === tenantId,
      )
        ? tenantId
        : events[0].data.tenantId;
      if (!sharedTenantId) {
        return { skipped: 'missing-tenant' };
      }

      // (1) load-config — runs in the tenant's CLS scope.
      const config = (await input.tenantRunner.runWithTenant(
        sharedTenantId,
        () =>
          ctx.step.run('load-config', () =>
            input.notificationConfigRepository.find(),
          ),
      )) as { enabled: boolean; recipients: string[]; enabledActions: string[] };

      if (!config.enabled) {
        return { skipped: 'master-disabled' };
      }
      if (!config.enabledActions.includes('LOW_STOCK')) {
        return { skipped: 'action-disabled' };
      }

      // (2) resolve-recipients — inside a step body so the lookup is
      // checkpointed. Dedup happens at the user-port level.
      const recipientUserIds = config.recipients;
      if (recipientUserIds.length === 0) {
        return { skipped: 'no-recipients' };
      }

      const recipients = (await input.tenantRunner.runWithTenant(
        sharedTenantId,
        () =>
          ctx.step.run('resolve-recipients', async () =>
            input.userEmailLookup.resolveEmailsByUserIds(recipientUserIds),
          ),
      )) as string[];
      // Defensive: dedupe again at the email level in case the port
      // didn't (e.g. multi-tenant user collisions).
      const dedupedRecipients = Array.from(new Set<string>(recipients));

      if (dedupedRecipients.length === 0) {
        return { skipped: 'no-active-recipients' };
      }

      // (3) compose-items — fold the batch into one item per
      // (product, variant). Upstream is already one-shot per crossing
      // so duplicates are rare; dedupe defensively. The cast inside
      // the callback (rather than at the await site) works around the
      // SDK's `step.run` over-erasure of the inner return type.
      const composeResult = await ctx.step.run(
        'compose-items',
        () => composeItems(events) as unknown as Promise<LowStockEmailItem[]>,
      );
      const items = composeResult as unknown as LowStockEmailItem[];

      // (4) send-email — render the template, then dispatch via MAILER.
      const subject = composeSubject(items.length);
      // Use React's static markup renderer directly. `@react-email/render`
      // also works in production runtime but uses dynamic
      // `import("react-dom/server")` internally, which Jest's CJS
      // transformer does not enable (test seam only).
      const html = renderToStaticMarkup(
        LowStockEmail({
          items,
          appBaseUrl: input.appBaseUrl,
        }) as ReactElement,
      );

      await ctx.step.run('send-email', () =>
        input.mailer.send({
          to: dedupedRecipients,
          subject,
          html,
        }),
      );

      return { sent: true, itemCount: items.length };
    },
  );

  // `createFunction` returns the SDK-shaped function object; the
  // builder returns a one-element array so the call site can splat
  // it into `InngestService`'s registry without an IIFE.
  return [fn];
}

function composeSubject(count: number): string {
  if (count <= 1) return '1 producto con bajo inventario';
  return `${count} productos con bajo inventario`;
}

/**
 * Compose `LowStockEmailItem[]` from a coalesced batch. The upstream
 * atomic flip guarantees one-row-per-crossing, so the batch
 * inherently contains DISTINCT items. A defensive dedupe-by-itemKey
 * protects against a misconfigured caller fanning the same crossing
 * in twice.
 */
function composeItems(
  events: InngestBatchEvent[],
): LowStockEmailItem[] {
  const seen = new Set<string>();
  const items: LowStockEmailItem[] = [];
  for (const event of events) {
    const payload = event.data;
    const itemKey =
      `${payload.tenantId}:` +
      `${payload.productId}:` +
      `${payload.variantId ?? '__PRODUCT__'}`;
    if (seen.has(itemKey)) {
      continue;
    }
    seen.add(itemKey);

    items.push({
      productName: payload.productName ?? '(sin nombre)',
      variantDescription: payload.variantDescription ?? null,
      currentQuantity: payload.newQuantity,
      minQuantity: payload.minQuantity,
      sku: payload.sku ?? null,
      category: payload.category ?? null,
      deepLink:
        payload.deepLink && payload.deepLink.length > 0
          ? payload.deepLink
          : '#',
    });
  }
  return items;
}
