/**
 * Shared writes for every chatbot-request command and creator (staff commands
 * now; intake, wrapping and the SLA sweep in units 3, 5 and 7). Each helper
 * runs on the caller's transaction client.
 */
import { Prisma } from '@prisma/client';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  ChatbotRequestCommandError,
  type ChatbotRequestRow,
} from '../application/chatbot-request-commands.service';
import type {
  ChatbotRequestEventDraft,
  ChatbotRequestPatch,
} from '../domain/chatbot-request.commands';
import { slaColumnsForTransition } from './chatbot-sla-policy';
import { releaseSeat } from './scheduling-store';

export type TenantClient = ReturnType<TenantPrismaService['getClient']>;

/** Next per-tenant folio (`S-000123`); the upsert row lock serializes it. */
export async function allocateFolio(
  tx: TenantClient,
  tenantId: string,
): Promise<number> {
  const [row] = await tx.$queryRaw<{ lastNumber: number }[]>(Prisma.sql`
    INSERT INTO "chatbot_request_folio_counters" ("tenantId", "lastNumber", "updatedAt")
    VALUES (${tenantId}, 1, now())
    ON CONFLICT ("tenantId") DO UPDATE
      SET "lastNumber" = "chatbot_request_folio_counters"."lastNumber" + 1,
          "updatedAt" = now()
    RETURNING "lastNumber"`);
  return row.lastNumber;
}

/**
 * A block of `count` consecutive folios in one statement (the backfill wraps
 * up to a batch at once). Returns the first; the block is `first..first+count-1`.
 * Same counter row and lock as `allocateFolio`, so hooks and backfill never
 * hand out the same number.
 */
export async function allocateFolios(
  tx: TenantClient,
  tenantId: string,
  count: number,
): Promise<number> {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error('allocateFolios needs a positive integer count');
  }
  const [row] = await tx.$queryRaw<{ lastNumber: number }[]>(Prisma.sql`
    INSERT INTO "chatbot_request_folio_counters" ("tenantId", "lastNumber", "updatedAt")
    VALUES (${tenantId}, ${count}, now())
    ON CONFLICT ("tenantId") DO UPDATE
      SET "lastNumber" = "chatbot_request_folio_counters"."lastNumber" + ${count},
          "updatedAt" = now()
    RETURNING "lastNumber"`);
  return row.lastNumber - count + 1;
}

/**
 * The group refresh needs a fresh snapshot per statement (READ COMMITTED).
 * Under REPEATABLE READ or SERIALIZABLE the aggregate would read the snapshot
 * taken before the group lock and lose a concurrent command's update, so any
 * other level fails the command instead of writing a stale count.
 */
export async function assertReadCommitted(tx: TenantClient): Promise<void> {
  const [row] = await tx.$queryRaw<{ transaction_isolation: string }[]>(
    Prisma.sql`SHOW transaction_isolation`,
  );
  if (row?.transaction_isolation !== 'read committed') {
    throw new Error(
      'chatbot customer group refresh requires READ COMMITTED isolation',
    );
  }
}

/**
 * Recomputes the customer's inbox group (§10.1) after a request changed.
 *
 * The first statement locks (or creates) the group row. Only then does the
 * aggregate run: under READ COMMITTED each statement takes a new snapshot, so
 * it sees every command that held the lock before, and two commands on
 * different requests of one customer cannot both write a stale count. Callers
 * already hold their request row lock, so the order is always request, then
 * group. `mostUrgentAt` is the nearest current deadline (claim deadline while
 * NEW, resolve deadline while IN_PROGRESS), NULL while no SLA is set.
 */
export async function refreshCustomerGroup(
  tx: TenantClient,
  tenantId: string,
  customerKey: string,
): Promise<void> {
  await assertReadCommitted(tx);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "chatbot_customer_groups" ("tenantId", "customerKey", "openCount", "updatedAt")
    VALUES (${tenantId}, ${customerKey}, 1, now())
    ON CONFLICT ("tenantId", "customerKey") DO UPDATE SET "updatedAt" = now()`);
  const [open] = await tx.$queryRaw<
    { openCount: number; mostUrgentAt: Date | null; hasOverdue: boolean }[]
  >(Prisma.sql`
    SELECT count(*)::int AS "openCount",
           min(CASE WHEN "status" = 'NEW' THEN "claimDeadlineAt"
                    ELSE "resolveDeadlineAt" END) AS "mostUrgentAt",
           coalesce(bool_or("overdueAt" IS NOT NULL), false) AS "hasOverdue"
    FROM "chatbot_requests"
    WHERE "tenantId" = ${tenantId} AND "customerKey" = ${customerKey}
      AND "status" IN ('NEW', 'IN_PROGRESS')`);
  if (open.openCount === 0) {
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "chatbot_customer_groups"
      WHERE "tenantId" = ${tenantId} AND "customerKey" = ${customerKey}`);
    return;
  }
  await tx.$executeRaw(Prisma.sql`
    UPDATE "chatbot_customer_groups"
    SET "openCount" = ${open.openCount}, "mostUrgentAt" = ${open.mostUrgentAt},
        "hasOverdue" = ${open.hasOverdue}, "updatedAt" = now()
    WHERE "tenantId" = ${tenantId} AND "customerKey" = ${customerKey}`);
}

export interface ChatbotRequestLinks {
  customerId?: string | null;
  humanDecisionId?: string | null;
  deliveryZoneRequestId?: string | null;
  receiptEvidenceId?: string | null;
}

/**
 * M3 (docs/chatbot-requests-model.md, "Known deviations"): those FKs are
 * single-column, so the application proves each linked row belongs to the
 * request's tenant. A foreign id answers 404 like a missing one (§6.1).
 */
export async function assertTenantLinks(
  tx: TenantClient,
  tenantId: string,
  links: ChatbotRequestLinks,
): Promise<void> {
  const checks = [
    links.customerId &&
      tx.customer.count({ where: { tenantId, id: links.customerId } }),
    links.humanDecisionId &&
      tx.humanDecision.count({
        where: { tenantId, id: links.humanDecisionId },
      }),
    links.deliveryZoneRequestId &&
      tx.deliveryZoneRequest.count({
        where: { tenantId, id: links.deliveryZoneRequestId },
      }),
    links.receiptEvidenceId &&
      tx.receiptEvidence.count({
        where: { tenantId, id: links.receiptEvidenceId },
      }),
  ];
  for (const check of checks) {
    if (check && (await check) !== 1) {
      throw new ChatbotRequestCommandError('NOT_FOUND', 404);
    }
  }
}

/** The `chatbot_requests` columns a command reads, shared by every lock. */
const REQUEST_ROW = Prisma.sql`
  SELECT cr."id", cr."folio", cr."kind"::text AS "kind",
         cr."subtype"::text AS "subtype", cr."status"::text AS "status",
         cr."version", cr."customerKey", cr."conversationRef", cr."assigneeUserId",
         cr."assigneeDisplayName", cr."claimedAt", cr."overdueAt", cr."closedAt",
         cr."humanDecisionId", cr."deliveryZoneRequestId", cr."receiptEvidenceId",
         cr."scheduledFor", cr."scheduleVersion", cr."needsReschedule",
         -- Unit 11: the request-level session state of §4.2/§12.4. An ENDED
         -- session on an open request is WAITING (reverted or released).
         CASE WHEN ls."state" IS NULL THEN NULL
              WHEN ls."state" <> 'ENDED' THEN ls."state"
              WHEN cr."status" IN ('NEW', 'IN_PROGRESS') THEN 'WAITING'
              ELSE 'ENDED' END AS "liveSessionState"
  FROM "chatbot_requests" cr
  LEFT JOIN LATERAL (
    SELECT s."state" FROM "chatbot_live_sessions" s
    WHERE s."tenantId" = cr."tenantId" AND s."requestId" = cr."id"
    ORDER BY s."epoch" DESC LIMIT 1) ls ON TRUE`;

/** `SELECT … FOR UPDATE` on one tenant request; `null` for a missing id. */
export async function lockRequestRow(
  tx: TenantClient,
  tenantId: string,
  id: string,
): Promise<ChatbotRequestRow | null> {
  const rows = await tx.$queryRaw<ChatbotRequestRow[]>(Prisma.sql`
    ${REQUEST_ROW}
    WHERE cr."tenantId" = ${tenantId} AND cr."id" = ${id}
    FOR UPDATE OF cr`);
  return rows[0] ?? null;
}

/** Unlocked read of several tenant requests (immutable facts, error bodies). */
export function peekRequestRows(
  tx: TenantClient,
  tenantId: string,
  ids: string[],
): Promise<ChatbotRequestRow[]> {
  return tx.$queryRaw<ChatbotRequestRow[]>(Prisma.sql`
    ${REQUEST_ROW}
    WHERE cr."tenantId" = ${tenantId} AND cr."id" IN (${Prisma.join(ids)})
    ORDER BY cr."id"`);
}

/**
 * Locks several tenant requests in `id` order (§12.11, lock-order rule 3). One
 * statement, so the order is the sort order and two callers can never cross.
 */
export function lockRequestRows(
  tx: TenantClient,
  tenantId: string,
  ids: string[],
): Promise<ChatbotRequestRow[]> {
  return tx.$queryRaw<ChatbotRequestRow[]>(Prisma.sql`
    ${REQUEST_ROW}
    WHERE cr."tenantId" = ${tenantId} AND cr."id" IN (${Prisma.join(ids)})
    ORDER BY cr."id"
    FOR UPDATE OF cr`);
}

export type WrappedLink =
  | { humanDecisionId: string }
  | { receiptEvidenceId: string }
  | { validationId: string };

/**
 * Locks the OPEN requests that wrap a legacy row (id order, §12.11). A zone
 * validation wraps one request per customer that asked for the postal code.
 * Closed requests are skipped: they never change again.
 */
export async function lockOpenWrapping(
  tx: TenantClient,
  tenantId: string,
  link: WrappedLink,
): Promise<ChatbotRequestRow[]> {
  const where =
    'humanDecisionId' in link
      ? Prisma.sql`cr."humanDecisionId" = ${link.humanDecisionId}`
      : 'receiptEvidenceId' in link
        ? Prisma.sql`cr."receiptEvidenceId" = ${link.receiptEvidenceId}`
        : Prisma.sql`cr."deliveryZoneRequestId" IN (
            SELECT dzr."id" FROM "delivery_zone_requests" dzr
            WHERE dzr."tenantId" = ${tenantId}
              AND dzr."validationId" = ${link.validationId})`;
  return tx.$queryRaw<ChatbotRequestRow[]>(Prisma.sql`
    ${REQUEST_ROW}
    WHERE cr."tenantId" = ${tenantId} AND ${where}
      AND cr."status" IN ('NEW', 'IN_PROGRESS')
    ORDER BY cr."id"
    FOR UPDATE OF cr`);
}

/**
 * CAS patch plus its audit event, on a request row the caller has locked. A
 * claim or release also stamps the SLA columns (`now` is the injected clock).
 */
export async function applyRequestPatch(
  tx: TenantClient,
  tenantId: string,
  row: Pick<ChatbotRequestRow, 'id' | 'version'>,
  patch: ChatbotRequestPatch,
  event: ChatbotRequestEventDraft,
  now: Date = new Date(),
): Promise<void> {
  const { resolution, ...columns } = patch;
  // Unit 14: a request that closes stops its schedule; a cancel gives the seat
  // back (one hook for the bot cancel, the staff cancel and a merge source).
  const closing =
    patch.status === 'CANCELLED' || patch.status === 'RESOLVED'
      ? await settleSchedule(tx, tenantId, row.id, patch.status === 'CANCELLED')
      : null;
  // Unit 7a (§5.4): a claim moves the active clock to "resolve" and a release
  // restarts the claim clock, so both recompute the deadlines with the policy
  // read under `FOR SHARE` (a concurrent PUT of the settings waits for us).
  const sla =
    patch.status === 'NEW' || patch.status === 'IN_PROGRESS'
      ? await slaColumnsForTransition(tx, tenantId, row.id, patch.status, now)
      : null;
  // The row is locked, so the CAS cannot lose; a miss is a broken invariant.
  const { count } = await tx.chatbotRequest.updateMany({
    where: { tenantId, id: row.id, version: row.version },
    data: {
      ...columns,
      ...(closing ?? {}),
      ...(sla ?? {}),
      ...(resolution
        ? { resolution: resolution as Prisma.InputJsonObject }
        : {}),
    },
  });
  if (count !== 1) throw new Error('chatbot request CAS missed a locked row');
  await tx.chatbotRequestEvent.create({
    data: {
      ...event,
      tenantId,
      requestId: row.id,
      data: event.data as Prisma.InputJsonObject,
    },
  });
}

/**
 * Unit 14: the schedule columns a closing request gets. A scheduled request
 * stops being due; a CANCELLED one releases its seat and bumps `scheduleVersion`
 * (S20 6). The caller holds the request row lock (then the counter row: the
 * lock order of docs/chatbot-requests-model.md). `null` for an unscheduled one.
 */
async function settleSchedule(
  tx: TenantClient,
  tenantId: string,
  requestId: string,
  cancelled: boolean,
): Promise<{ scheduleDueAt: null; scheduleVersion?: number } | null> {
  const [row] = await tx.$queryRaw<
    Array<{ scheduledFor: Date | null; scheduleVersion: number }>
  >(Prisma.sql`
    SELECT "scheduledFor", "scheduleVersion" FROM "chatbot_requests"
    WHERE "tenantId" = ${tenantId} AND "id" = ${requestId}`);
  if (!row?.scheduledFor) return null;
  if (!cancelled) return { scheduleDueAt: null };
  await releaseSeat(tx, tenantId, row.scheduledFor);
  return { scheduleDueAt: null, scheduleVersion: row.scheduleVersion + 1 };
}

/**
 * Refreshes each customer's group in sorted `customerKey` order (lock-order
 * rule 3). Call it after every request row of the transaction is written.
 */
export async function refreshCustomerGroups(
  tx: TenantClient,
  tenantId: string,
  customerKeys: Iterable<string>,
): Promise<void> {
  for (const key of [...new Set(customerKeys)].sort()) {
    await refreshCustomerGroup(tx, tenantId, key);
  }
}

export interface ZoneImpact {
  validationId: string;
  requests: number;
  customers: number;
  setVersion: number;
}

/**
 * What resolving a zone validation settles (R9). `setVersion` counts every
 * time the set changed: each request that ever joined (+1) and each one that
 * left by cancelling (+1). It only grows, so a requester that arrived or
 * withdrew after the preview always yields a different number, and it needs
 * no column on `delivery_zone_validations`.
 */
export async function readZoneImpact(
  tx: TenantClient,
  tenantId: string,
  validationId: string,
): Promise<ZoneImpact> {
  const [row] = await tx.$queryRaw<
    Omit<ZoneImpact, 'validationId'>[]
  >(Prisma.sql`
    SELECT
      (count(*) FILTER (WHERE cr."status" IN ('NEW', 'IN_PROGRESS')))::int AS "requests",
      (count(DISTINCT cr."customerKey")
        FILTER (WHERE cr."status" IN ('NEW', 'IN_PROGRESS')))::int AS "customers",
      (count(*) + count(*) FILTER (WHERE cr."status" = 'CANCELLED'))::int AS "setVersion"
    FROM "chatbot_requests" cr
    JOIN "delivery_zone_requests" dzr ON dzr."id" = cr."deliveryZoneRequestId"
    WHERE cr."tenantId" = ${tenantId} AND dzr."tenantId" = ${tenantId}
      AND dzr."validationId" = ${validationId}`);
  return { validationId, ...row };
}

/** Zone validation and postal code behind a DELIVERY_ZONE request, if any. */
export async function findZoneOf(
  tx: TenantClient,
  tenantId: string,
  requestId: string,
): Promise<{ validationId: string; zipCode: string } | null> {
  const rows = await tx.$queryRaw<{ validationId: string; zipCode: string }[]>(
    Prisma.sql`
    SELECT dzr."validationId", dzr."zipCode"
    FROM "chatbot_requests" cr
    JOIN "delivery_zone_requests" dzr ON dzr."id" = cr."deliveryZoneRequestId"
    WHERE cr."tenantId" = ${tenantId} AND cr."id" = ${requestId}
      AND dzr."tenantId" = ${tenantId} AND dzr."validationId" IS NOT NULL`,
  );
  return rows[0] ?? null;
}
