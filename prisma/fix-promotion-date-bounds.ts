/* eslint-disable no-console */
/**
 * Idempotent data-fix: re-normalize Promotion.startDate / Promotion.endDate
 * to business-day boundaries in the configured business timezone.
 *
 * CONTEXT
 * -------
 * Prior to the timezone-bug fix, the backend stored date-only inputs
 * (e.g. "2026-07-11" picked by the user) verbatim as UTC midnight
 * (2026-07-11T00:00:00.000Z). At UTC-6 (America/Mexico_City) that
 * meant a promotion ending 2026-07-11 was already ENDED ~6 hours
 * before the local midnight the user actually picked — and the final
 * local day was silently truncated.
 *
 * The read-time fix (commit 312ffae) re-derives status from the
 * stored bounds at query time, but the STORED instants still drift.
 * Newly created/updated promotions are written with the right
 * boundaries (see `promotion-date-range.ts`). The two known corrupt
 * rows ("Promocion chida" id=5a76a2bc-d3ab-42d2-bec2-43c909c669ea
 * and "Promo Dolor de Cabeza.") still drift until they are touched.
 *
 * This script:
 *   - Reads PROMOTIONS_BUSINESS_TIMEZONE (default
 *     "America/Mexico_City") so the fix is consistent with the
 *     runtime normalization.
 *   - For each row whose startDate or endDate falls on UTC-midnight
 *     (i.e. was created under the old contract), rewrites the bound
 *     to the local start-of-day / end-of-day in the business zone.
 *   - Is IDEMPOTENT: running it twice is a no-op on the second run
 *     (the "already normalized" check skips rows whose startDate
 *     millisecond fraction is non-zero OR whose UTC date component
 *     is not at midnight in the business zone).
 *
 * USAGE
 * -----
 *   pnpm ts-node prisma/fix-promotion-date-bounds.ts
 *   pnpm ts-node prisma/fix-promotion-date-bounds.ts --dry-run
 *
 * --dry-run prints what WOULD change without writing anything.
 *
 * NON-DESTRUCTIVE
 * ---------------
 *   - Only touches rows whose dates are NOT already normalized.
 *   - Never deletes data.
 *   - Logs every change with the row id and the before/after instants.
 *
 * NO PRISMA SCHEMA CHANGES
 * ------------------------
 *   This script does NOT call `prisma migrate` — there is no schema
 *   delta. It is a one-off data-fix, not a migration. It MUST be run
 *   once after deploying the timezone-bug fix to clean up historical
 *   rows that were stored under the old contract.
 */
import { PrismaClient } from '@prisma/client';
import {
  startOfBusinessDay,
  endOfBusinessDay,
} from '../src/promotions/domain/promotion-date-range';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');
const TZ = process.env.PROMOTIONS_BUSINESS_TIMEZONE ?? 'America/Mexico_City';

interface FixSummary {
  totalScanned: number;
  candidates: number;
  updated: number;
  skippedAlreadyNormalized: number;
  byTenant: Record<string, number>;
  changes: Array<{
    id: string;
    tenantId: string;
    title: string;
    field: 'startDate' | 'endDate';
    before: string;
    after: string;
  }>;
}

/**
 * A row is "already normalized" iff its startDate, when fed back
 * through the runtime helper, yields a Date whose ISO string equals
 * the stored value (and the same for endDate with the end helper).
 *
 * This is the simplest correctness check that survives pre-existing
 * half-broken states without false-positive re-normalization.
 */
function isNormalizedAsStart(value: Date): boolean {
  try {
    return startOfBusinessDay(value, TZ).toISOString() === value.toISOString();
  } catch {
    return false;
  }
}

function isNormalizedAsEnd(value: Date): boolean {
  try {
    return endOfBusinessDay(value, TZ).toISOString() === value.toISOString();
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  console.log(
    `[fix-promotion-date-bounds] mode=${DRY_RUN ? 'DRY-RUN' : 'WRITE'} tz=${TZ}`,
  );

  const summary: FixSummary = {
    totalScanned: 0,
    candidates: 0,
    updated: 0,
    skippedAlreadyNormalized: 0,
    byTenant: {},
    changes: [],
  };

  // Tenant-by-tenant so multi-tenant deployments get per-tenant logs.
  const tenants = await prisma.tenant.findMany({ select: { id: true } });
  for (const tenant of tenants) {
    const rows = await prisma.promotion.findMany({
      where: { tenantId: tenant.id },
      select: {
        id: true,
        tenantId: true,
        title: true,
        startDate: true,
        endDate: true,
      },
    });
    summary.totalScanned += rows.length;

    for (const row of rows) {
      const updates: { startDate?: Date; endDate?: Date } = {};

      if (row.startDate && !isNormalizedAsStart(row.startDate)) {
        updates.startDate = startOfBusinessDay(row.startDate, TZ);
        summary.changes.push({
          id: row.id,
          tenantId: row.tenantId,
          title: row.title,
          field: 'startDate',
          before: row.startDate.toISOString(),
          after: updates.startDate.toISOString(),
        });
      }
      if (row.endDate && !isNormalizedAsEnd(row.endDate)) {
        updates.endDate = endOfBusinessDay(row.endDate, TZ);
        summary.changes.push({
          id: row.id,
          tenantId: row.tenantId,
          title: row.title,
          field: 'endDate',
          before: row.endDate.toISOString(),
          after: updates.endDate.toISOString(),
        });
      }

      if (Object.keys(updates).length === 0) {
        summary.skippedAlreadyNormalized += 1;
        continue;
      }
      summary.candidates += 1;
      summary.byTenant[tenant.id] =
        (summary.byTenant[tenant.id] ?? 0) + 1;

      if (!DRY_RUN) {
        await prisma.promotion.update({
          where: { id: row.id },
          data: updates,
        });
        summary.updated += 1;
      }
    }
  }

  console.log('---');
  console.log(`scanned:        ${summary.totalScanned}`);
  console.log(`candidates:     ${summary.candidates}`);
  console.log(`updated:        ${summary.updated}${DRY_RUN ? ' (skipped — DRY-RUN)' : ''}`);
  console.log(
    `skipped:        ${summary.skippedAlreadyNormalized} (already normalized)`,
  );
  if (Object.keys(summary.byTenant).length > 0) {
    console.log('per-tenant:');
    for (const [tenantId, count] of Object.entries(summary.byTenant)) {
      console.log(`  ${tenantId}: ${count}`);
    }
  }
  if (summary.changes.length > 0) {
    console.log('---');
    console.log('changes:');
    for (const c of summary.changes) {
      console.log(
        `  [${c.id}] ${c.tenantId} "${c.title}" ${c.field}: ${c.before} -> ${c.after}`,
      );
    }
  }

  // Exit non-zero only if a write run hit an unexpected error;
  // a successful dry-run or a no-op run both exit 0.
  return 0;
}

main()
  .then((code) => {
    void prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('[fix-promotion-date-bounds] FAILED:', err);
    await prisma.$disconnect();
    process.exit(1);
  });