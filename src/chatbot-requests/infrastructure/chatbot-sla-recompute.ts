/**
 * Recompute of OPEN requests after a settings change (human-intervention unit
 * 7a; contract §5.4). Bounded batches, each in its own short transaction on the
 * root client with an explicit `tenantId`.
 *
 * Lock order (docs/chatbot-requests-model.md): a batch takes its request rows
 * with `FOR UPDATE SKIP LOCKED` in one statement and never waits for a row a
 * command holds, then refreshes the customer groups in sorted order, which
 * every writer takes last. A row skipped because a command held it is picked
 * up by a later pass (that command also stamps the new version when it started
 * after the PUT).
 */
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { SettingsSubtype } from '../../chatbot-settings/domain/chatbot-attention-settings';
import { computeSla, type SlaAnchors } from '../domain/chatbot-sla';
import {
  refreshCustomerGroups,
  type TenantClient,
} from './chatbot-request-writes';
import {
  LAST_RELEASED,
  loadSlaPolicy,
  type TxRunner,
} from './chatbot-sla-policy';

const logger = new Logger('ChatbotSlaRecompute');

export interface RecomputeOptions {
  batchSize?: number;
  now?: () => Date;
  /** Extra passes for rows a command held during the first one. */
  retries?: number;
  retryDelayMs?: number;
}

export interface RecomputeResult {
  recomputed: number;
  /** Open rows still on an older version (held by commands, or crashed). */
  stale: number;
}

interface BatchRow {
  id: string;
  subtype: SettingsSubtype;
  status: 'NEW' | 'IN_PROGRESS';
  customerKey: string;
  createdAt: Date;
  scheduledFor: Date | null;
  overdueAt: Date | null;
  lastReleasedAt: Date | null;
}

const STALE = (version: number) =>
  Prisma.sql`(r."slaPolicyVersion" IS NULL OR r."slaPolicyVersion" < ${version})`;

/**
 * Recomputes the deadlines of the tenant's OPEN requests with the current
 * settings, in batches of `batchSize` rows, each in its own short transaction.
 * Only rows on an older `slaPolicyVersion` are read or written, so a closed
 * request is never touched and a newer recompute is never overwritten by an
 * older one that raced it.
 */
export async function recomputeOpenRequests(
  prisma: TxRunner,
  tenantId: string,
  options: RecomputeOptions = {},
): Promise<RecomputeResult> {
  const batchSize = options.batchSize ?? 200;
  const now = options.now ?? (() => new Date());
  const retries = options.retries ?? 3;
  const delay = options.retryDelayMs ?? 100;
  let recomputed = 0;
  let stale = 0;
  for (let pass = 0; pass <= retries; pass++) {
    let after = '';
    for (;;) {
      const batch = await prisma.$transaction((tx) =>
        recomputeBatch(tx, tenantId, batchSize, after, now()),
      );
      recomputed += batch.count;
      if (batch.lastId === null) break;
      after = batch.lastId;
    }
    stale = await countStale(prisma, tenantId);
    if (stale === 0) break;
    if (pass < retries) await new Promise((r) => setTimeout(r, delay));
  }
  if (stale > 0) {
    logger.warn(
      `[sla-recompute] ${stale} open request(s) still on an older policy version; the sweep or the next settings change picks them up`,
    );
  }
  return { recomputed, stale };
}

async function countStale(prisma: TxRunner, tenantId: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const policy = await loadSlaPolicy(tx, tenantId);
    const [row] = await tx.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT count(*)::int AS "n" FROM "chatbot_requests" r
      WHERE r."tenantId" = ${tenantId} AND r."status" IN ('NEW', 'IN_PROGRESS')
        AND ${STALE(policy.version)}`);
    return row.n;
  });
}

async function recomputeBatch(
  tx: Prisma.TransactionClient,
  tenantId: string,
  batchSize: number,
  after: string,
  now: Date,
): Promise<{ count: number; lastId: string | null }> {
  const policy = await loadSlaPolicy(tx, tenantId, { lock: true });
  const rows = await tx.$queryRaw<BatchRow[]>(Prisma.sql`
    SELECT r."id", r."subtype"::text AS "subtype", r."status"::text AS "status",
           r."customerKey", r."createdAt", r."scheduledFor", r."overdueAt",
           ${LAST_RELEASED} AS "lastReleasedAt"
    FROM "chatbot_requests" r
    WHERE r."tenantId" = ${tenantId} AND r."status" IN ('NEW', 'IN_PROGRESS')
      AND ${STALE(policy.version)} AND r."id" > ${after}
    ORDER BY r."id"
    LIMIT ${batchSize}
    FOR UPDATE OF r SKIP LOCKED`);
  if (rows.length === 0) return { count: 0, lastId: null };

  const ids: string[] = [];
  const setClaim: boolean[] = [];
  const claim: (string | null)[] = [];
  const resolve: (string | null)[] = [];
  const next: (string | null)[] = [];
  for (const row of rows) {
    const anchors: SlaAnchors = {
      subtype: row.subtype,
      status: row.status,
      createdAt: row.createdAt,
      scheduledFor: row.scheduledFor,
      lastReleasedAt: row.lastReleasedAt,
      overdueAt: row.overdueAt,
    };
    const sla = computeSla(policy, anchors, now);
    ids.push(row.id);
    setClaim.push(sla.claimDeadlineAt !== undefined);
    claim.push(sla.claimDeadlineAt?.toISOString() ?? null);
    resolve.push(sla.resolveDeadlineAt?.toISOString() ?? null);
    next.push(sla.nextSlaCheckAt?.toISOString() ?? null);
  }
  // Timestamps are stored as UTC wall time (`timestamp(3)`): the ISO text goes
  // in as `text[]` (null elements do not bind as `timestamp[]`) and is cast
  // without a zone.
  await tx.$executeRaw(Prisma.sql`
    UPDATE "chatbot_requests" r
    SET "claimDeadlineAt" = CASE WHEN v."setClaim" THEN v."claim"::timestamp ELSE r."claimDeadlineAt" END,
        "resolveDeadlineAt" = v."resolve"::timestamp,
        "slaPolicyVersion" = ${policy.version},
        "nextSlaCheckAt" = v."next"::timestamp
    FROM unnest(
      ${ids}::text[], ${setClaim}::boolean[], ${claim}::text[],
      ${resolve}::text[], ${next}::text[]
    ) AS v("id", "setClaim", "claim", "resolve", "next")
    WHERE r."tenantId" = ${tenantId} AND r."id" = v."id"
      AND ${STALE(policy.version)}`);
  // Every writer takes the group after its request rows, in sorted key order.
  // SAFETY: `refreshCustomerGroups` only runs raw SQL with an explicit
  // `tenantId`; the transaction client has the same `$queryRaw`/`$executeRaw`
  // as the tenant-extended client, which it is typed against.
  await refreshCustomerGroups(
    tx as unknown as TenantClient,
    tenantId,
    rows.map((r) => r.customerKey),
  );
  return {
    count: rows.length,
    lastId: rows.length < batchSize ? null : rows[rows.length - 1].id,
  };
}
