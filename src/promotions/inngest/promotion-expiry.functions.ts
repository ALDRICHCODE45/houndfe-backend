/**
 * Inngest function — promotion expiring-email digest (`pca-3c4b`).
 *
 * Consumes the frozen `promotion/expiring.detected` event emitted by the
 * dedicated expiry outbox dispatcher (`pca-3c3a`/`pca-3c3b`). The builder is
 * framework-free: the (future) expiry registrar (`pca-3c4c`) injects the
 * `InngestService` client plus the DI-resolved ports and registers the returned
 * function with the serve handler. This slice does not touch the immutable
 * outbox payload, `AppModule`, or the near-capacity behavior.
 *
 * **Coalescing.** `batchEvents: { maxSize: 5, timeout: '30s',
 * key: 'event.data.tenantId' }` collapses multiple expiring promotions for the
 * SAME tenant into one run that renders ONE email listing every promotion — the
 * established low-stock / near-capacity precedent.
 *
 * **Idempotency.** `idempotency: 'event.id'` where the producer's event id is
 * the fingerprint identity `${tenantId}:${promotionId}:${endDateFingerprint}`
 * (`pca-3c3a`). A replay/retry of the same end date dedupes, while a genuinely
 * new end date (edited A -> B) carries a new identity and can alert again.
 *
 * **Step topology.** Four `step.run` checkpoints, each wrapping its
 * tenant-scoped work in `tenantRunner.runWithTenant` INSIDE the step callback
 * (AsyncLocalStorage must be alive on the same tick as the query):
 *
 *   1. `load-config` — re-read `{ enabled, enabledActions, recipients }` at
 *      send time; returns early on master-off / action-disabled.
 *   2. `resolve-recipients` — expand the shared recipient user-ids to active
 *      emails; returns early on an empty list.
 *   3. `verify-freshness` — validate each immutable payload, drop foreign
 *      tenants, then re-check EVERY event's `endDateFingerprint` through the
 *      committed `findFreshExpiryTitle` lookup. Freshness is evaluated PER
 *      EVENT, before any same-promotion collapsing.
 *   4. `send-email` — render the Spanish template and `MAILER.send(...)`.
 *
 * **Why freshness runs before collapsing (critical).** With A -> B -> A edits,
 * a batch can hold an OLDER event whose fingerprint is fresh again (A) and a
 * NEWER event whose fingerprint is now stale (B). Collapsing duplicates first
 * (keeping the latest `occurredAt`, i.e. B) would query only the stale
 * fingerprint and drop the whole promotion — silently suppressing the
 * currently valid alert. Filtering fresh events first keeps A and discards B,
 * so an obsolete later event can never suppress a valid earlier fingerprint.
 *
 * **Tenant isolation.** Every batch event whose `data.tenantId` differs from
 * the trusted (first) tenant of the batch is dropped before any lookup, so a
 * misconfigured `batchEvents.key` can never enrich or leak a foreign tenant's
 * promotion.
 *
 * **No identifiers / no PII.** The handler never passes `promotionId`,
 * `endDateFingerprint`, or any tenant/user identifier into the template; only
 * the enriched title plus the UTC end date reach the email body.
 */
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Inngest } from 'inngest';
import type { IMailer } from '../../notifications/email/mailer.port';
import {
  PromotionExpiringEmail,
  promotionExpiringSubject,
  type PromotionExpiringEmailItem,
} from '../../notifications/email/templates/promotion-expiring.email';
import type { TenantRunnerService } from '../../shared/tenant/tenant-runner.service';
import type { INotificationConfigRepository } from '../../notification-config/domain/notification-config.repository';
import type {
  NotificationActionKey,
  NotificationConfigView,
} from '../../notification-config/domain/notification-config';
import type { IPromotionAlertLookup } from '../domain/promotion-alert-lookup.repository';
import {
  PROMOTION_EXPIRING_INNGEST_EVENT,
  type PromotionExpiryOutboxPayload,
} from '../outbox/promotion-expiry-outbox.types';

/** Stable Inngest function id — never change it once deployed. */
export const PROMOTION_EXPIRY_FUNCTION_ID = 'promotion-expiring-email';

/** Notification action that gates this alert (`pca-3a2` registry). */
export const PROMOTION_EXPIRING_ACTION: NotificationActionKey =
  'PROMOTION_EXPIRING';

/**
 * User-lookup port used by `resolve-recipients`. Defined locally so this file
 * mirrors `promotion-near-capacity.functions.ts` and does not pull the
 * stock-alerts module into the promotions notification graph. The registrar
 * passes the shared `USER_EMAIL_LOOKUP` adapter.
 */
export interface IPromotionExpiryUserEmailLookup {
  /**
   * Resolve user-ids to active, deduped emails. Returns `[]` when no user
   * matches; never returns `null`.
   */
  resolveEmailsByUserIds(userIds: string[]): Promise<string[]>;
}

/**
 * Minimal Inngest `events` shape consumed by the handler in `batchEvents`
 * mode — the exact slice the function reads. `data` is the immutable outbox
 * payload (`pca-3c1a`); it is never mutated here.
 */
type InngestBatchEvent = {
  id: string;
  name: string;
  data: PromotionExpiryOutboxPayload;
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

export interface BuildPromotionExpiryFunctionsInput {
  inngestClient: Inngest;
  tenantRunner: Pick<TenantRunnerService, 'runWithTenant'>;
  notificationConfigRepository: Pick<INotificationConfigRepository, 'find'>;
  userEmailLookup: IPromotionExpiryUserEmailLookup;
  promotionAlertLookup: Pick<IPromotionAlertLookup, 'findFreshExpiryTitle'>;
  mailer: IMailer;
  /** Optional per-tenant web app base URL for the email CTA. */
  appBaseUrl?: string;
}

/**
 * A validated event reduced to the fields the email needs. `occurredAt` and
 * `eventId` exist only to collapse same-promotion duplicates deterministically.
 */
interface ExpiryCandidate {
  promotionId: string;
  endDate: string;
  endDateFingerprint: string;
  occurredAt: string;
  eventId: string;
}

/** A candidate whose failure-time freshness check returned a usable title. */
type FreshExpiryCandidate = ExpiryCandidate & { title: string };

/**
 * Build the `promotion-expiring-email` Inngest function. Returns a one-element
 * array so the registrar can splat it into
 * `InngestService.registerFunctions(...)`.
 */
export function buildPromotionExpiryFunctions(
  input: BuildPromotionExpiryFunctionsInput,
): unknown[] {
  const fn = input.inngestClient.createFunction(
    {
      id: PROMOTION_EXPIRY_FUNCTION_ID,
      triggers: [{ event: PROMOTION_EXPIRING_INNGEST_EVENT }],
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
      // (`batchEvents.key`). The FIRST event's tenantId is authoritative for
      // the batch; `collectCandidates` then drops any foreign event that
      // slipped past the SDK partition.
      const tenantId = events[0]?.data?.tenantId;
      if (!tenantId) {
        return { skipped: 'missing-tenant' };
      }

      // (1) load-config — re-check the master toggle and action at send time.
      // CLS ordering (runWithTenant INSIDE the step callback) matches the
      // low-stock / near-capacity functions: Inngest re-runs the body and the
      // step callback runs on a different tick than the outer body.
      const config = (await ctx.step.run('load-config', () =>
        input.tenantRunner.runWithTenant(tenantId, () =>
          input.notificationConfigRepository.find(),
        ),
      )) as NotificationConfigView;

      if (!config.enabled) {
        return { skipped: 'master-disabled' };
      }
      if (!config.enabledActions.includes(PROMOTION_EXPIRING_ACTION)) {
        return { skipped: 'action-disabled' };
      }

      // (2) resolve-recipients — the shared tenant recipient list is resolved
      // at send time so a removed/deactivated user never receives the alert.
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

      // Pure, deterministic validation/fold (safe outside a step).
      const candidates = collectCandidates(tenantId, events);
      if (candidates.length === 0) {
        return { skipped: 'no-candidates' };
      }

      // (3) verify-freshness — ONE tenant-qualified lookup PER EVENT, before
      // any same-promotion collapsing. A deleted/ended/edited/not-started/
      // already-expired promotion resolves to `null` and is skipped.
      const fresh = (await ctx.step.run('verify-freshness', () =>
        input.tenantRunner.runWithTenant(tenantId, () =>
          filterFreshCandidates(
            input.promotionAlertLookup,
            tenantId,
            candidates,
          ),
        ),
      )) as FreshExpiryCandidate[];

      if (fresh.length === 0) {
        return { skipped: 'all-stale' };
      }

      // Collapse same-promotion duplicates to ONE item, deterministically.
      const items = collapseByPromotion(fresh);

      const subject = promotionExpiringSubject(items.length);
      // Deterministic (pure) render — safe outside a step.
      const html = renderToStaticMarkup(
        PromotionExpiringEmail({
          items,
          ...(input.appBaseUrl ? { appBaseUrl: input.appBaseUrl } : {}),
        }) as ReactElement,
      );

      // (4) send-email — a rejection here propagates so Inngest retries the
      // durable send instead of silently dropping the alert.
      await ctx.step.run('send-email', () =>
        input.mailer.send({ to: dedupedRecipients, subject, html }),
      );

      return { sent: true, itemCount: items.length };
    },
  );

  return [fn];
}

/**
 * Validate a coalesced batch into renderable candidates.
 *
 * - Foreign-tenant events (`data.tenantId !== trustedTenantId`) are dropped
 *   before any lookup.
 * - Events with a malformed/absent payload, an empty promotion id or
 *   fingerprint, or an unparseable end date are dropped so the email can never
 *   render `NaN`/`Invalid Date`.
 * - The original payload is never read-for-write; only primitives are copied.
 */
function collectCandidates(
  trustedTenantId: string,
  events: InngestBatchEvent[],
): ExpiryCandidate[] {
  const candidates: ExpiryCandidate[] = [];
  for (const event of events) {
    const candidate = readExpiryCandidate(trustedTenantId, event);
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

/** Narrow one batch event to a valid candidate, or `null`. */
function readExpiryCandidate(
  trustedTenantId: string,
  event: InngestBatchEvent,
): ExpiryCandidate | null {
  const data = event?.data as unknown;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return null;
  }

  const record = data as Partial<PromotionExpiryOutboxPayload>;
  if (record.tenantId !== trustedTenantId) {
    return null;
  }
  if (
    typeof record.promotionId !== 'string' ||
    record.promotionId.length === 0
  ) {
    return null;
  }
  if (
    typeof record.endDateFingerprint !== 'string' ||
    record.endDateFingerprint.length === 0
  ) {
    return null;
  }
  if (typeof record.endDate !== 'string' || record.endDate.length === 0) {
    return null;
  }
  if (Number.isNaN(new Date(record.endDate).getTime())) {
    return null;
  }

  return {
    promotionId: record.promotionId,
    endDate: record.endDate,
    endDateFingerprint: record.endDateFingerprint,
    occurredAt: typeof record.occurredAt === 'string' ? record.occurredAt : '',
    eventId: typeof event?.id === 'string' ? event.id : '',
  };
}

/**
 * Re-check every candidate against the live promotion through the
 * tenant-qualified freshness lookup. A `null` (or blank) title means the
 * promotion is no longer the same live alert the claim hashed and is skipped.
 *
 * This deliberately runs per event rather than per promotion: a later, now
 * obsolete fingerprint must never shadow an earlier fingerprint that is still
 * valid (see the file header).
 */
async function filterFreshCandidates(
  lookup: Pick<IPromotionAlertLookup, 'findFreshExpiryTitle'>,
  tenantId: string,
  candidates: ExpiryCandidate[],
): Promise<FreshExpiryCandidate[]> {
  const fresh: FreshExpiryCandidate[] = [];

  for (const candidate of candidates) {
    const title = await lookup.findFreshExpiryTitle({
      tenantId,
      promotionId: candidate.promotionId,
      endDateFingerprint: candidate.endDateFingerprint,
    });
    if (title === null || title.trim().length === 0) {
      continue;
    }
    fresh.push({ ...candidate, title });
  }

  return fresh;
}

/**
 * Collapse fresh candidates to one item per promotion. Duplicates collapse to
 * the LATEST `occurredAt` snapshot with a stable tie-break, and the result is
 * sorted by promotion id, so rendering never depends on batch order.
 */
function collapseByPromotion(
  fresh: FreshExpiryCandidate[],
): PromotionExpiringEmailItem[] {
  const latestByPromotion = new Map<string, FreshExpiryCandidate>();

  for (const candidate of fresh) {
    const current = latestByPromotion.get(candidate.promotionId);
    if (!current || isLaterSnapshot(candidate, current)) {
      latestByPromotion.set(candidate.promotionId, candidate);
    }
  }

  return Array.from(latestByPromotion.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, candidate]) => ({
      title: candidate.title,
      endDate: candidate.endDate,
    }));
}

/**
 * True when `candidate` is the newer snapshot. ISO-8601 timestamps compare
 * correctly as strings. Equal timestamps break on the lexicographically smaller
 * event id — arbitrary but stable, so the rendered alert is identical
 * regardless of batch order.
 */
function isLaterSnapshot(
  candidate: FreshExpiryCandidate,
  current: FreshExpiryCandidate,
): boolean {
  if (candidate.occurredAt !== current.occurredAt) {
    return candidate.occurredAt > current.occurredAt;
  }
  return candidate.eventId < current.eventId;
}
