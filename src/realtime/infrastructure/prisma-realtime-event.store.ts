/**
 * Reads and retention of the realtime log (unit 8; contract §5.3, §10.1 R7).
 *
 * System flows on the root client: every statement names `tenantId` itself.
 * `RealtimeEvent` and `RealtimeEventRetention` are also registered in
 * `TENANT_SCOPED_MODELS` (defense in depth: a read through
 * `TenantPrismaService` is tenant-filtered), but this store never relies on it.
 *
 * Reads:
 *   - `readAfter(tenant, null, …)`  every event of the tenant (the hub).
 *   - `readAfter(tenant, user, …)`  broadcast events plus that user's own, two
 *     index range scans merged by id (replay for one stream). Another user's
 *     personal events are never selected.
 * Both are keyset scans over `id`, oldest first, so they cost the same however
 * long the log is. Retention: `purgeExpired` deletes the oldest expired rows
 * in one statement bounded by `batch` (`FOR UPDATE SKIP LOCKED`, so two
 * replicas never fight over a row) and raises each tenant's watermark in the
 * same statement, so a cursor below it is answered with `resync`.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { REALTIME_RETENTION_HOURS } from '../domain/realtime-events';

export interface RealtimeEventRow {
  id: bigint;
  tenantId: string;
  userId: string | null;
  type: string;
  requestId: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
}

/** The only Prisma method the store needs (the root client, or a test's). */
export interface RawDb {
  $queryRaw: <T = unknown>(query: Prisma.Sql) => Promise<T>;
}

const COLUMNS = Prisma.sql`"id", "tenantId", "userId", "type", "requestId", "payload", "createdAt"`;
const HOUR_MS = 3_600_000;

/** Largest `bigint` (the id column's type): the upper end of a tenant's range. */
const MAX_ID = 9223372036854775807n;

/**
 * The two read statements, exported so the perf spec can `EXPLAIN` exactly
 * what runs: the hub's tenant-wide read (`userId` null) and one stream's replay
 * (broadcast events plus the user's own, merged by id).
 *
 * Planner note (found by the perf spec, same family as the bot feed's read):
 * with `"tenantId" = $1 AND "id" > $2` the planner may walk the primary key
 * from `$2` to the end of the table filtering by tenant, which reads every
 * newer row of every OTHER tenant (200+ buffers for "nothing new"). Written as
 * a row comparison with a closed upper bound the tenant column is no longer a
 * constant, so only `(tenantId, id)` / `(tenantId, userId, id)` can answer the
 * `ORDER BY`: one index probe whatever the neighbours wrote.
 */
export function readAfterSql(
  tenantId: string,
  userId: string | null,
  after: bigint,
  limit: number,
): Prisma.Sql {
  if (userId === null) {
    return Prisma.sql`
      SELECT ${COLUMNS} FROM "realtime_events"
      WHERE ("tenantId", "id") > (${tenantId}, ${after})
        AND ("tenantId", "id") <= (${tenantId}, ${MAX_ID})
      ORDER BY "tenantId", "id" LIMIT ${limit}`;
  }
  return Prisma.sql`
    (SELECT ${COLUMNS} FROM "realtime_events"
      WHERE "userId" IS NULL
        AND ("tenantId", "id") > (${tenantId}, ${after})
        AND ("tenantId", "id") <= (${tenantId}, ${MAX_ID})
      ORDER BY "tenantId", "id" LIMIT ${limit})
    UNION ALL
    (SELECT ${COLUMNS} FROM "realtime_events"
      WHERE "userId" IS NOT NULL
        AND ("tenantId", "userId", "id") > (${tenantId}, ${userId}, ${after})
        AND ("tenantId", "userId", "id") <= (${tenantId}, ${userId}, ${MAX_ID})
      ORDER BY "tenantId", "userId", "id" LIMIT ${limit})
    ORDER BY "id" LIMIT ${limit}`;
}

/** A tenant's newest id (NULL for none), always through `(tenantId, id)`. */
export const tenantHeadSql = (tenantId: string): Prisma.Sql => Prisma.sql`
  SELECT "id" AS "head" FROM "realtime_events"
  WHERE "tenantId" >= ${tenantId} AND "tenantId" <= ${tenantId}
  ORDER BY "tenantId" DESC, "id" DESC LIMIT 1`;

@Injectable()
export class PrismaRealtimeEventStore {
  constructor(@Inject(PrismaService) private readonly db: RawDb) {}

  /** The newest id of the tenant, `0n` when it has none. */
  async tenantHead(tenantId: string): Promise<bigint> {
    const [row] = await this.db.$queryRaw<{ head: bigint | null }[]>(
      tenantHeadSql(tenantId),
    );
    return row?.head ?? 0n;
  }

  /** Highest id the purge removed for the tenant, `0n` if it never did. */
  async purgedThrough(tenantId: string): Promise<bigint> {
    const [row] = await this.db.$queryRaw<{ mark: bigint }[]>(Prisma.sql`
      SELECT "purgedThroughId" AS "mark" FROM "realtime_event_retention"
      WHERE "tenantId" = ${tenantId}`);
    return row?.mark ?? 0n;
  }

  readAfter(
    tenantId: string,
    userId: string | null,
    after: bigint,
    limit: number,
  ): Promise<RealtimeEventRow[]> {
    return this.db.$queryRaw<RealtimeEventRow[]>(
      readAfterSql(tenantId, userId, after, limit),
    );
  }

  /**
   * One batch of retention (24 h). The watermark rows are upserted in
   * `tenantId` order: two replicas delete different rows of the same tenants,
   * and marks locked in different orders would deadlock (40P01). Returns the
   * number of rows removed.
   */
  async purgeExpired(now: Date, batch = 1000): Promise<number> {
    const cutoff = new Date(now.getTime() - REALTIME_RETENTION_HOURS * HOUR_MS);
    const [result] = await this.db.$queryRaw<{ removed: number }[]>(Prisma.sql`
      WITH doomed AS (
        SELECT "id" FROM "realtime_events"
        WHERE "createdAt" < ${cutoff}
        ORDER BY "createdAt" LIMIT ${batch}
        FOR UPDATE SKIP LOCKED),
      gone AS (
        DELETE FROM "realtime_events" e USING doomed d
        WHERE e."id" = d."id" RETURNING e."tenantId", e."id"),
      marks AS (
        INSERT INTO "realtime_event_retention" ("tenantId", "purgedThroughId")
        SELECT "tenantId", max("id") FROM gone GROUP BY "tenantId"
        ORDER BY "tenantId"
        ON CONFLICT ("tenantId") DO UPDATE SET "purgedThroughId" =
          GREATEST("realtime_event_retention"."purgedThroughId",
                   EXCLUDED."purgedThroughId")
        RETURNING 1)
      SELECT (SELECT count(*) FROM gone)::int AS "removed"`);
    return result.removed;
  }
}
