/**
 * Shared writes for every chatbot-request command and creator (staff commands
 * now; intake, wrapping and the SLA sweep in units 3, 5 and 7). Each helper
 * runs on the caller's transaction client.
 */
import { Prisma } from '@prisma/client';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { ChatbotRequestCommandError } from '../application/chatbot-request-commands.service';

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
