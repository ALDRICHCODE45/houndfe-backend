/**
 * SLA persistence helpers (human-intervention unit 7a; contract §5.4). Raw SQL
 * with an explicit `tenantId` on every statement, so the same code runs on the
 * tenant-scoped client of a request and on the root client the settings
 * service uses to reach other tenants (apply-to-all).
 *
 *   `loadSlaPolicy`          the tenant's settings (or the defaults, version 0).
 *                            Inside a transaction pass `lock: true`: it takes
 *                            `FOR SHARE` on the settings row, so a concurrent
 *                            `PUT` waits for the writer that read the old
 *                            version, and the rows it stamps with that version
 *                            are always found stale by the recompute that
 *                            follows the PUT. With no settings row the lock is
 *                            taken on the tenant row instead (see
 *                            `readSettingsRow`).
 *   `slaColumnsForNew`       deadlines of a request being inserted.
 *   `slaColumnsForTransition` claim / release: restarts the clock that moves.
 *
 * The recompute of open requests after a settings change lives in
 * `chatbot-sla-recompute.ts` (it needs the group refresh of the writes file,
 * which itself imports this one).
 */
import { Prisma } from '@prisma/client';
import {
  defaultSettings,
  type AttentionSettings,
  type SettingsSubtype,
} from '../../chatbot-settings/domain/chatbot-attention-settings';
import {
  computeSla,
  policyFromSettings,
  type SlaColumns,
  type SlaPolicy,
} from '../domain/chatbot-sla';

/** The raw SQL surface of any Prisma client or transaction client. */
export interface RawDb {
  $queryRaw<T = unknown>(query: Prisma.Sql): Prisma.PrismaPromise<T>;
  $executeRaw(query: Prisma.Sql): Prisma.PrismaPromise<number>;
}

/** Runs `work` in one transaction (READ COMMITTED) on the root client. */
export interface TxRunner {
  $transaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T>;
}

export interface SettingsRow {
  version: number;
  timeZone: string;
  days: unknown;
  closedDates: string[];
  slas: unknown;
  windowWarningMinutes: number;
  templateName: string | null;
  templateCostText: string;
  enabledSubtypes: string[];
  receiptCloseMarginMinutes: number;
  schedulingEnabled: boolean;
  slotMinutes: number;
  slotsOffered: number;
  maxScheduledPerSlot: number;
}

/** The stored row as the domain value (the row is written normalized). */
export function rowToSettings(row: SettingsRow): AttentionSettings {
  return {
    openingHours: {
      timeZone: row.timeZone,
      days: row.days as AttentionSettings['openingHours']['days'],
    },
    closedDates: [...row.closedDates],
    slas: row.slas as AttentionSettings['slas'],
    windowWarningMinutes: row.windowWarningMinutes,
    templateName: row.templateName,
    templateCostText: row.templateCostText,
    enabledSubtypes: row.enabledSubtypes as SettingsSubtype[],
    receiptCloseMarginMinutes: row.receiptCloseMarginMinutes,
    scheduling: {
      enabled: row.schedulingEnabled,
      slotMinutes: row.slotMinutes,
      slotsOffered: row.slotsOffered,
      maxScheduledPerSlot: row.maxScheduledPerSlot,
    },
  };
}

/**
 * The settings row of a tenant, or null while it uses the defaults.
 *
 * With a lock and no row there is nothing to lock, which would let a creator
 * that read the defaults (version 0) commit after the first `PUT` and its
 * recompute, unnoticed. So when the row is missing the lock moves to the
 * tenant row, which always exists: readers of the defaults take `FOR SHARE`,
 * a writer (`UPDATE`) takes `FOR NO KEY UPDATE` (conflicts with SHARE, not with
 * the `FOR KEY SHARE` that foreign keys take), and then the settings row is
 * read again, because a first writer may have committed while we waited. Row
 * locks do not queue a new SHARE behind a waiting writer (unlike advisory
 * locks), so a creator holding another lock can never be part of a cycle with
 * it. A tenant that already has a row pays nothing extra and no create writes.
 */
export async function readSettingsRow(
  db: RawDb,
  tenantId: string,
  lock?: 'SHARE' | 'UPDATE',
): Promise<SettingsRow | null> {
  const mode =
    lock === 'SHARE'
      ? Prisma.sql`FOR SHARE`
      : lock === 'UPDATE'
        ? Prisma.sql`FOR UPDATE`
        : Prisma.empty;
  const read = async () => {
    const rows = await db.$queryRaw<SettingsRow[]>(Prisma.sql`
      SELECT "version", "timeZone", "days", "closedDates", "slas",
             "windowWarningMinutes", "templateName", "templateCostText",
             "enabledSubtypes"::text[] AS "enabledSubtypes",
             "receiptCloseMarginMinutes", "schedulingEnabled", "slotMinutes",
             "slotsOffered", "maxScheduledPerSlot"
      FROM "chatbot_attention_settings"
      WHERE "tenantId" = ${tenantId}
      ${mode}`);
    return rows[0] ?? null;
  };
  const row = await read();
  if (row || !lock) return row;
  await db.$queryRaw(Prisma.sql`
    SELECT 1 AS "locked" FROM "tenants" WHERE "id" = ${tenantId}
    ${lock === 'SHARE' ? Prisma.sql`FOR SHARE` : Prisma.sql`FOR NO KEY UPDATE`}`);
  return read();
}

export async function loadSlaPolicy(
  db: RawDb,
  tenantId: string,
  options: { lock?: boolean } = {},
): Promise<SlaPolicy> {
  const row = await readSettingsRow(
    db,
    tenantId,
    options.lock ? 'SHARE' : undefined,
  );
  return row
    ? policyFromSettings(rowToSettings(row), row.version)
    : policyFromSettings(defaultSettings(), 0);
}

/** Deadline columns of a request that is being inserted (status NEW). */
export async function slaColumnsForNew(
  db: RawDb,
  tenantId: string,
  request: {
    subtype: SettingsSubtype;
    createdAt?: Date;
    scheduledFor?: Date | null;
  },
  now: Date = new Date(),
): Promise<Required<SlaColumns>> {
  const policy = await loadSlaPolicy(db, tenantId, { lock: true });
  return computeSla(
    policy,
    {
      subtype: request.subtype,
      status: 'NEW',
      createdAt: request.createdAt ?? now,
      scheduledFor: request.scheduledFor ?? null,
      lastReleasedAt: null,
      overdueAt: null,
    },
    now,
  ) as Required<SlaColumns>;
}

/**
 * Columns for a claim (to IN_PROGRESS) or a release (to NEW) of a request the
 * caller has locked. A release restarts the claim clock at `now`.
 */
export async function slaColumnsForTransition(
  db: RawDb,
  tenantId: string,
  requestId: string,
  nextStatus: 'NEW' | 'IN_PROGRESS',
  now: Date = new Date(),
): Promise<SlaColumns | null> {
  const [row] = await db.$queryRaw<
    {
      subtype: SettingsSubtype;
      createdAt: Date;
      scheduledFor: Date | null;
      overdueAt: Date | null;
      lastReleasedAt: Date | null;
    }[]
  >(Prisma.sql`
    SELECT r."subtype"::text AS "subtype", r."createdAt", r."scheduledFor",
           r."overdueAt", ${LAST_RELEASED} AS "lastReleasedAt"
    FROM "chatbot_requests" r
    WHERE r."tenantId" = ${tenantId} AND r."id" = ${requestId}`);
  if (!row) return null;
  const policy = await loadSlaPolicy(db, tenantId, { lock: true });
  return computeSla(
    policy,
    {
      subtype: row.subtype,
      status: nextStatus,
      createdAt: row.createdAt,
      scheduledFor: row.scheduledFor,
      lastReleasedAt: nextStatus === 'NEW' ? now : row.lastReleasedAt,
      overdueAt: row.overdueAt,
    },
    now,
  );
}

/** The last time someone released the request (a fresh claim window). */
export const LAST_RELEASED = Prisma.sql`(
  SELECT max(e."createdAt") FROM "chatbot_request_events" e
  WHERE e."tenantId" = r."tenantId" AND e."requestId" = r."id"
    AND e."type" IN ('RELEASED', 'AUTO_RELEASED'))`;
