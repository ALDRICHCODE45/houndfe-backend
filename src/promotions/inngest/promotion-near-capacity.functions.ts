/**
 * Inngest function — promotion near-capacity email (`pca-3b4b`).
 *
 * Consumes the frozen `promotion/near-capacity.detected` event emitted by
 * the dedicated capacity outbox dispatcher (`pca-3b3a`/`pca-3b3b`). The
 * builder is framework-free: `PromotionNearCapacityRegistrar`
 * (`pca-3b4c`) injects the `InngestService` client plus the DI-resolved
 * ports and registers the returned function with the serve handler. This
 * slice does not touch the immutable outbox payload nor `AppModule`.
 *
 * **Coalescing.** `batchEvents: { maxSize: 5, timeout: '30s',
 * key: 'event.data.tenantId' }` collapses multiple crossings for the
 * SAME tenant into one run that renders ONE email listing every
 * promotion — the established low-stock precedent.
 *
 * **Idempotency.** `idempotency: 'event.id'` where the producer's event
 * id is the ledger identity `${tenantId}:${promotionId}:${saleId}`
 * (`pca-3b3a`). A same-sale replay/retry dedupes, while a later sale that
 * re-crosses the threshold after a cancellation carries a new identity
 * and can alert again.
 *
 * **Step topology.** Four `step.run` checkpoints, each wrapping its
 * tenant-scoped work in `tenantRunner.runWithTenant` INSIDE the step
 * callback (AsyncLocalStorage must be alive on the same tick as the
 * query):
 *
 *   1. `load-config` — re-read `{ enabled, enabledActions, recipients }`
 *      at send time; returns early on master-off / action-disabled.
 *   2. `resolve-recipients` — expand the shared recipient user-ids to
 *      active emails; returns early on an empty list.
 *   3. `enrich-promotions` — dedupe crossings to the latest snapshot per
 *      promotion and resolve each tenant-qualified title; a missing or
 *      blank title is skipped, and an all-missing batch sends nothing.
 *   4. `send-email` — render the Spanish template and `MAILER.send(...)`.
 *
 * **Tenant isolation.** Every batch event whose `data.tenantId` differs
 * from the trusted (first) tenant of the batch is dropped before any
 * lookup, so a misconfigured `batchEvents.key` can never enrich or leak a
 * foreign tenant's promotion.
 *
 * **No identifiers / no PII.** The handler never reads `saleId` for
 * rendering and never passes `promotionId` into the template; only the
 * enriched title plus the consumed/max counters reach the email body.
 */
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Inngest } from 'inngest';
import type { IMailer } from '../../notifications/email/mailer.port';
import {
  PromotionNearCapacityEmail,
  promotionNearCapacitySubject,
  type NearCapacityPromotionEmailItem,
} from '../../notifications/email/templates/promotion-near-capacity.email';
import type { TenantRunnerService } from '../../shared/tenant/tenant-runner.service';
import type { INotificationConfigRepository } from '../../notification-config/domain/notification-config.repository';
import type {
  NotificationActionKey,
  NotificationConfigView,
} from '../../notification-config/domain/notification-config';
import type { IPromotionAlertLookup } from '../domain/promotion-alert-lookup.repository';
import {
  PROMOTION_NEAR_CAPACITY_INNGEST_EVENT,
  type PromotionCapacityOutboxPayload,
} from '../outbox/promotion-capacity-outbox.types';

/** Stable Inngest function id — never change it once deployed. */
export const PROMOTION_NEAR_CAPACITY_FUNCTION_ID =
  'promotion-near-capacity-email';

/** Notification action that gates this alert (`pca-3a2` registry). */
export const PROMOTION_NEAR_CAPACITY_ACTION: NotificationActionKey =
  'PROMOTION_NEAR_CAPACITY';

/**
 * User-lookup port used by `resolve-recipients`. Defined locally so this
 * file mirrors `low-stock.functions.ts` and does not pull the stock-alerts
 * module into the promotions notification graph. The registrar passes the
 * shared `USER_EMAIL_LOOKUP` adapter.
 */
export interface INearCapacityUserEmailLookup {
  /**
   * Resolve user-ids to active, deduped emails. Returns `[]` when no user
   * matches; never returns `null`.
   */
  resolveEmailsByUserIds(userIds: string[]): Promise<string[]>;
}

/**
 * Minimal Inngest `events` shape consumed by the handler in
 * `batchEvents` mode — the exact slice the function reads. `data` is the
 * immutable outbox payload (`pca-3b1`); it is never mutated here.
 */
type InngestBatchEvent = {
  id: string;
  name: string;
  data: PromotionCapacityOutboxPayload;
};

type InngestBatchContext = {
  events: InngestBatchEvent[];
  // Supplied by Inngest but typed loosely so the spec can fake it; the
  // implementation only uses `step.run(...)`.
  step: {
    run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
    sleep: (name: string, duration: string) => Promise<void>;
    sendEvent: (
      name: string,
      events: Array<{ name: string; data: unknown }>,
    ) => Promise<void>;
  };
};

export interface BuildPromotionNearCapacityFunctionsInput {
  inngestClient: Inngest;
  tenantRunner: Pick<TenantRunnerService, 'runWithTenant'>;
  notificationConfigRepository: Pick<INotificationConfigRepository, 'find'>;
  userEmailLookup: INearCapacityUserEmailLookup;
  promotionAlertLookup: Pick<IPromotionAlertLookup, 'findTitle'>;
  mailer: IMailer;
  /** Optional per-tenant web app base URL for the email CTA. */
  appBaseUrl?: string;
}

/**
 * A crossing reduced to the fields the email needs. `occurredAt` and
 * `eventId` exist only to pick the latest snapshot deterministically.
 */
interface SelectedCrossing {
  promotionId: string;
  consumedProductUnits: number;
  maxProductUnits: number;
  occurredAt: string;
  eventId: string;
}

/**
 * Build the `promotion-near-capacity-email` Inngest function. Returns a
 * one-element array so the registrar can splat it into
 * `InngestService.registerFunctions(...)`.
 */
export function buildPromotionNearCapacityFunctions(
  input: BuildPromotionNearCapacityFunctionsInput,
): unknown[] {
  const fn = input.inngestClient.createFunction(
    {
      id: PROMOTION_NEAR_CAPACITY_FUNCTION_ID,
      triggers: [{ event: PROMOTION_NEAR_CAPACITY_INNGEST_EVENT }],
      batchEvents: {
        maxSize: 5,
        timeout: '30s',
        key: 'event.data.tenantId',
      },
      idempotency: 'event.id',
      retries: 3,
      concurrency: { limit: 5 },
    },
    async (ctx: InngestBatchContext) => {
      const events = ctx.events;
      if (!events || events.length === 0) {
        return { skipped: 'empty-batch' };
      }

      // All events in a coalesced batch share the same tenant by design
      // (`batchEvents.key`). The FIRST event's tenantId is authoritative
      // for the batch; `selectLatestCrossings` then drops any foreign
      // event that slipped past the SDK partition.
      const tenantId = events[0].data.tenantId;
      if (!tenantId) {
        return { skipped: 'missing-tenant' };
      }

      // (1) load-config — re-check the master toggle and action at send
      // time. CLS ordering (runWithTenant INSIDE the step callback)
      // matches the low-stock function: Inngest re-runs the body and the
      // step callback runs on a different tick than the outer body.
      const config = (await ctx.step.run('load-config', () =>
        input.tenantRunner.runWithTenant(tenantId, () =>
          input.notificationConfigRepository.find(),
        ),
      )) as NotificationConfigView;

      if (!config.enabled) {
        return { skipped: 'master-disabled' };
      }
      if (!config.enabledActions.includes(PROMOTION_NEAR_CAPACITY_ACTION)) {
        return { skipped: 'action-disabled' };
      }

      // (2) resolve-recipients — the shared tenant recipient list is
      // resolved at send time so a removed/deactivated user never
      // receives the alert.
      const recipientUserIds = config.recipients;
      if (recipientUserIds.length === 0) {
        return { skipped: 'no-recipients' };
      }

      const recipients = (await ctx.step.run('resolve-recipients', () =>
        input.tenantRunner.runWithTenant(tenantId, () =>
          input.userEmailLookup.resolveEmailsByUserIds(recipientUserIds),
        ),
      )) as string[];
      const dedupedRecipients = Array.from(new Set<string>(recipients));
      if (dedupedRecipients.length === 0) {
        return { skipped: 'no-active-recipients' };
      }

      // Pure, deterministic fold (safe outside a step).
      const crossings = selectLatestCrossings(tenantId, events);
      if (crossings.length === 0) {
        return { skipped: 'no-crossings' };
      }

      // (3) enrich-promotions — tenant-qualified title lookup. Missing or
      // blank titles are skipped; an all-missing batch sends nothing.
      const items = (await ctx.step.run('enrich-promotions', () =>
        input.tenantRunner.runWithTenant(tenantId, () =>
          enrichPromotions(input.promotionAlertLookup, tenantId, crossings),
        ),
      )) as NearCapacityPromotionEmailItem[];

      if (items.length === 0) {
        return { skipped: 'no-promotions' };
      }

      const subject = promotionNearCapacitySubject(items.length);
      // Deterministic (pure) render — safe outside a step.
      const html = renderToStaticMarkup(
        PromotionNearCapacityEmail({
          items,
          ...(input.appBaseUrl ? { appBaseUrl: input.appBaseUrl } : {}),
        }) as ReactElement,
      );

      // (4) send-email — a rejection here propagates so Inngest retries
      // the durable send instead of silently dropping the alert.
      await ctx.step.run('send-email', () =>
        input.mailer.send({ to: dedupedRecipients, subject, html }),
      );

      return { sent: true, itemCount: items.length };
    },
  );

  return [fn];
}

/**
 * Fold a coalesced batch into one crossing per promotion.
 *
 * - Foreign-tenant events (`data.tenantId !== trustedTenantId`) are
 *   dropped before any lookup.
 * - Events with a malformed promotion id or non-finite/negative counters
 *   are dropped so the email can never render `NaN`.
 * - Duplicates for one promotion collapse to the LATEST `occurredAt`
 *   snapshot. Consumption is NOT assumed to rise monotonically (a
 *   cancellation can lower it), so the snapshot's own counter is what the
 *   email shows.
 * - `occurredAt` ties break on the stable event identity, and the result
 *   is sorted by promotion id, so rendering never depends on batch order.
 */
function selectLatestCrossings(
  trustedTenantId: string,
  events: InngestBatchEvent[],
): SelectedCrossing[] {
  const latestByPromotion = new Map<string, SelectedCrossing>();

  for (const event of events) {
    const crossing = readCrossing(trustedTenantId, event);
    if (!crossing) {
      continue;
    }
    const current = latestByPromotion.get(crossing.promotionId);
    if (!current || isLaterSnapshot(crossing, current)) {
      latestByPromotion.set(crossing.promotionId, crossing);
    }
  }

  return Array.from(latestByPromotion.values()).sort((a, b) =>
    a.promotionId < b.promotionId ? -1 : a.promotionId > b.promotionId ? 1 : 0,
  );
}

/** Narrow one batch event to a renderable crossing, or `null`. */
function readCrossing(
  trustedTenantId: string,
  event: InngestBatchEvent,
): SelectedCrossing | null {
  const data = event.data;

  if (data.tenantId !== trustedTenantId) {
    return null;
  }
  if (!data.promotionId) {
    return null;
  }
  if (
    !Number.isFinite(data.consumedProductUnits) ||
    data.consumedProductUnits < 0
  ) {
    return null;
  }
  if (!Number.isFinite(data.maxProductUnits) || data.maxProductUnits <= 0) {
    return null;
  }

  return {
    promotionId: data.promotionId,
    consumedProductUnits: data.consumedProductUnits,
    maxProductUnits: data.maxProductUnits,
    occurredAt: typeof data.occurredAt === 'string' ? data.occurredAt : '',
    eventId: event.id,
  };
}

/**
 * True when `candidate` is the newer snapshot. ISO-8601 timestamps
 * compare correctly as strings. Equal timestamps break on the
 * lexicographically smaller event id — arbitrary but stable, so the
 * rendered alert is identical regardless of batch order.
 */
function isLaterSnapshot(
  candidate: SelectedCrossing,
  current: SelectedCrossing,
): boolean {
  if (candidate.occurredAt !== current.occurredAt) {
    return candidate.occurredAt > current.occurredAt;
  }
  return candidate.eventId < current.eventId;
}

/**
 * Resolve tenant-qualified titles for the selected crossings. A `null` or
 * blank title means the promotion no longer exists (or has no usable
 * label) and is skipped rather than rendered as an empty row.
 */
async function enrichPromotions(
  lookup: Pick<IPromotionAlertLookup, 'findTitle'>,
  tenantId: string,
  crossings: SelectedCrossing[],
): Promise<NearCapacityPromotionEmailItem[]> {
  const items: NearCapacityPromotionEmailItem[] = [];

  for (const crossing of crossings) {
    const title = await lookup.findTitle({
      tenantId,
      promotionId: crossing.promotionId,
    });
    if (title === null || title.trim().length === 0) {
      continue;
    }
    items.push({
      title,
      consumedProductUnits: crossing.consumedProductUnits,
      maxProductUnits: crossing.maxProductUnits,
    });
  }

  return items;
}
