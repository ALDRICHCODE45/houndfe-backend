/**
 * `needsReschedule` (human-intervention unit 14; contract "Closed days and
 * hours that change", S19 Q6): after the tenant's settings change, open
 * scheduled requests whose `scheduledFor` is no longer inside the branch's open
 * hours (a closed date added, hours shortened) are flagged. Nothing moves and
 * nobody is told: staff reschedule (which clears the flag).
 *
 * It runs AFTER the settings transaction commits, like the SLA recompute: the
 * settings writer holds the settings row, and every request command takes the
 * request row first and the settings row second, so locking request rows inside
 * the settings transaction would invert that order. Each batch is one short
 * transaction on the root client: the request rows are taken `FOR UPDATE SKIP
 * LOCKED` (a command holding one means "not now", never a wait), THEN the
 * settings are read, so the verdict uses the newest committed hours. A row
 * skipped here is caught by the schedule sweep when its reminder falls due.
 *
 * Only requests that staff can still move are candidates: `NEW` (no live
 * session) and in the future. A flagged request bumps `version` (the inbox row
 * changed) and announces `request.updated` in realtime; no audit event, no
 * feed item (the customer is not told).
 */
import { Prisma } from '@prisma/client';
import {
  REALTIME_CHANNEL,
  realtimeLockKey,
} from '../../shared/realtime/realtime-event-writes';
import { isStartStillOpen } from '../domain/schedule-sweep';
import { loadSchedulingConfig } from './scheduling-store';
import type { TxRunner } from './chatbot-sla-policy';

export const NEEDS_RESCHEDULE_CAUSE = 'NEEDS_RESCHEDULE';

export interface FlagOptions {
  now?: () => Date;
  batchSize?: number;
}

interface Candidate {
  id: string;
  scheduledFor: Date;
}

/** Flags the tenant's unbookable scheduled requests; returns how many. */
export async function flagUnbookableSchedules(
  prisma: TxRunner,
  tenantId: string,
  options: FlagOptions = {},
): Promise<{ flagged: number }> {
  const batchSize = options.batchSize ?? 200;
  const now = options.now ?? (() => new Date());
  let flagged = 0;
  let after = '';
  for (;;) {
    const batch = await prisma.$transaction((tx) =>
      flagBatch(tx, tenantId, batchSize, after, now()),
    );
    flagged += batch.flagged;
    if (batch.lastId === null) break;
    after = batch.lastId;
  }
  return { flagged };
}

async function flagBatch(
  tx: Prisma.TransactionClient,
  tenantId: string,
  batchSize: number,
  after: string,
  now: Date,
): Promise<{ flagged: number; lastId: string | null }> {
  const rows = await tx.$queryRaw<Candidate[]>(Prisma.sql`
    SELECT r."id", r."scheduledFor"
    FROM "chatbot_requests" r
    WHERE r."tenantId" = ${tenantId} AND r."status" = 'NEW'
      AND r."scheduledFor" IS NOT NULL AND r."scheduledFor" > ${now}
      AND NOT r."needsReschedule" AND r."id" > ${after}
    ORDER BY r."id"
    LIMIT ${batchSize}
    FOR UPDATE OF r SKIP LOCKED`);
  if (rows.length === 0) return { flagged: 0, lastId: null };
  // Request rows first, settings second (the order every command uses).
  const { calendar } = await loadSchedulingConfig(tx, tenantId);
  const ids = rows
    .filter((row) => !isStartStillOpen(calendar, row.scheduledFor))
    .map((row) => row.id);
  const lastId = rows.length < batchSize ? null : rows[rows.length - 1].id;
  if (ids.length === 0) return { flagged: 0, lastId };
  const updated = await tx.$queryRaw<Array<{ id: string; version: number }>>(
    Prisma.sql`
    UPDATE "chatbot_requests"
    SET "needsReschedule" = true, "version" = "version" + 1, "updatedAt" = now()
    WHERE "tenantId" = ${tenantId} AND "id" = ANY(${ids}::text[])
    RETURNING "id", "version"`,
  );
  // The realtime tenant lock is the last lock of the transaction. The events
  // go in ONE statement (same lock key, same channel and same rows as
  // `emitRealtimeEvents`): one round trip per flagged row made a batch of 200
  // cost ~110 ms while holding the request rows.
  if (updated.length > 0) {
    const sorted = [...updated].sort((a, b) => (a.id < b.id ? -1 : 1));
    await tx.$queryRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${realtimeLockKey(tenantId)}, 0))::text`,
    );
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "realtime_events" ("tenantId", "userId", "type", "requestId", "payload")
      SELECT ${tenantId}, NULL, 'request.updated', u."id",
             jsonb_build_object('version', u."version", 'cause', ${NEEDS_RESCHEDULE_CAUSE}::text)
      FROM unnest(${sorted.map((row) => row.id)}::text[], ${sorted.map((row) => row.version)}::int[])
        WITH ORDINALITY AS u("id", "version", "n")
      ORDER BY u."n"`);
    await tx.$queryRaw(
      Prisma.sql`SELECT pg_notify(${REALTIME_CHANNEL}, ${tenantId})::text`,
    );
  }
  return { flagged: updated.length, lastId };
}
