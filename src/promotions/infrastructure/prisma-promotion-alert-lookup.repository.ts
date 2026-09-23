/**
 * ADAPTER: PrismaPromotionAlertLookupRepository — pca-3b4a.
 *
 * Implements `IPromotionAlertLookup` against the global `PrismaService`
 * (not `TenantPrismaService`) so the lookup can run OUTSIDE the HTTP CLS
 * context, exactly like `PrismaSaleCustomerEmailRepository`. The explicit
 * `tenantId` argument is the only tenant authority, so both `id` and
 * `tenantId` go into the `where` clause (defense in depth): a stale or
 * tampered promotion id can never resolve a title from another tenant.
 *
 * The projection asks for `title` ONLY. The alert email needs a label,
 * not the promotion aggregate, so no `include` or relation hydration may
 * be added here; the unit spec's projection-driven Prisma double fails
 * if the title-only `select` is widened.
 *
 * `findFreshExpiryTitle` (pca-3c4a) is the expiration-email sibling. It
 * reads the title AND the freshness evidence (`endDate`, `startDate`,
 * `manuallyEnded`) in ONE tenant-qualified `findFirst`, then decides in
 * memory. Splitting it into an existence/freshness check plus a second
 * title read would reopen the edit race the method exists to close: the
 * promotion could be edited between the two statements.
 *
 * UTC ISO semantics: Prisma hydrates the `DateTime` columns as JS `Date`
 * values, which are absolute UTC instants. The fingerprint from the claim
 * is `endDate.toISOString()` (UTC, millisecond precision), and the current
 * instant is `Date.now()` (epoch milliseconds). All comparisons are exact
 * `getTime()` epoch comparisons and exact fingerprint string equality,
 * with no local-timezone arithmetic anywhere.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { IPromotionAlertLookup } from '../domain/promotion-alert-lookup.repository';

/** The single-read projection `findFreshExpiryTitle` decides on. */
type FreshExpiryPromotionRow = {
  title: string | null;
  endDate: Date | null;
  startDate: Date | null;
  manuallyEnded: boolean;
};

/**
 * Send-time truthfulness check for one alerted end date. `evaluatedAtMs` is
 * captured once, after the row read, so the whole verdict uses one consistent
 * instant. A missing end date can never match a persisted fingerprint.
 */
function resolveFreshExpiryTitle(
  row: FreshExpiryPromotionRow,
  endDateFingerprint: string,
  evaluatedAtMs: number,
): string | null {
  if (row.manuallyEnded || row.endDate === null) {
    return null;
  }
  // Identity equality on the live UTC ISO rendering the claim persisted.
  if (row.endDate.toISOString() !== endDateFingerprint) {
    return null;
  }
  // `endDate` at or before now is already expired; a started promotion is one
  // whose `startDate` is null (starts immediately) or not in the future.
  if (row.endDate.getTime() <= evaluatedAtMs) {
    return null;
  }
  if (row.startDate !== null && row.startDate.getTime() > evaluatedAtMs) {
    return null;
  }
  if (row.title === null || row.title.trim() === '') {
    return null;
  }
  return row.title;
}

@Injectable()
export class PrismaPromotionAlertLookupRepository implements IPromotionAlertLookup {
  constructor(private readonly prisma: PrismaService) {}

  async findTitle(input: {
    tenantId: string;
    promotionId: string;
  }): Promise<string | null> {
    if (!input.tenantId || !input.promotionId) {
      return null;
    }

    const row = await this.prisma.promotion.findFirst({
      where: { id: input.promotionId, tenantId: input.tenantId },
      select: { title: true },
    });

    return row?.title ?? null;
  }

  async findFreshExpiryTitle(input: {
    tenantId: string;
    promotionId: string;
    endDateFingerprint: string;
  }): Promise<string | null> {
    if (!input.tenantId || !input.promotionId || !input.endDateFingerprint) {
      return null;
    }

    // ONE read: title plus freshness evidence, tenant-qualified. No soft skip
    // distinction is needed between "not found" and "not fresh" — both are
    // `null` for the caller.
    const row = await this.prisma.promotion.findFirst({
      where: { id: input.promotionId, tenantId: input.tenantId },
      select: {
        title: true,
        endDate: true,
        startDate: true,
        manuallyEnded: true,
      },
    });
    if (row === null) {
      return null;
    }

    // Captured after the read so the verdict reflects the latest observable
    // instant, never a pre-read timestamp that could still admit a row that
    // expired during the roundtrip.
    const evaluatedAtMs = Date.now();
    return resolveFreshExpiryTitle(
      row,
      input.endDateFingerprint,
      evaluatedAtMs,
    );
  }
}
