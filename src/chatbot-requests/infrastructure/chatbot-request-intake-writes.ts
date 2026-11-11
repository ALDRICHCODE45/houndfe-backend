/**
 * Shared writes of the bot intake (unit 5; contract §3.2, §3.5, §6.4). The
 * direct creator (`PrismaBotRequestIntakeStore`) and the wrapper hook the
 * legacy flows call (`ChatbotRequestWrapper`, in envelope mode) run the same
 * steps on the caller's transaction, in the lock order of
 * docs/chatbot-requests-model.md ("Lock order rules", rule 2):
 *
 *   1. `lockCustomerIntake`: one advisory lock per (tenant, customer), so
 *      creators of one customer queue instead of racing the limits;
 *   2. `findOpenDedup`: the open request with the same dedup key, locked
 *      `FOR UPDATE`, so a staff command cannot close it under the merge;
 *   3. `assertIntakeLimits`, then (in the caller) the folio, the insert and
 *      the group last.
 *
 * Commands never take the customer lock, so no cycle can include it.
 */
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { CUSTOMER_REPLY_WINDOW_MS } from '../../delivery-zones/domain/delivery-zone.policy';
import { ChatbotRequestCommandError } from '../application/chatbot-request-commands.service';
import type { TenantClient } from './chatbot-request-writes';
import { slaColumnsForNew } from './chatbot-sla-policy';

/** §6.4: open requests per customer, all subtypes together. */
export const CUSTOMER_OPEN_LIMIT = 20;
/** §6.4: creations per customer per hour (a technical decision). */
export const CUSTOMER_CREATIONS_PER_HOUR = 10;

export interface IntakeLimits {
  openLimit: number;
  creationsPerHour: number;
}

export const DEFAULT_INTAKE_LIMITS: IntakeLimits = {
  openLimit: CUSTOMER_OPEN_LIMIT,
  creationsPerHour: CUSTOMER_CREATIONS_PER_HOUR,
};

/** The window of the per-customer creation limit (§6.4). */
export const CREATION_WINDOW_MS = 3_600_000;

/**
 * Thrown inside a legacy intake transaction when the request the hook was about
 * to insert must be merged into an open one (or lost the dedup race). The
 * legacy repositories rethrow anything that is not a unique violation, so the
 * transaction rolls back without leaving a wrapped row; the intake service
 * catches it outside and merges.
 */
export class IntakeMergeSignal extends Error {
  constructor() {
    super('chatbot intake must merge');
    this.name = 'IntakeMergeSignal';
  }
}

/**
 * Serializes the retries of one bot idempotency key (create or cancel), so a
 * concurrent retry waits and replays. Text-namespaced like the staff lock.
 */
export async function lockBotKey(
  tx: TenantClient,
  tenantId: string,
  kind: 'CREATE' | 'CANCEL',
  key: string,
): Promise<void> {
  const namespaced = `chatbot-bot:${tenantId}:${kind}:${key}`;
  await tx.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${namespaced}, 0))::text`,
  );
}

/** Serializes the creators of one customer; namespaced like the staff lock. */
export async function lockCustomerIntake(
  tx: TenantClient,
  tenantId: string,
  customerKey: string,
): Promise<void> {
  const key = `chatbot-intake:${tenantId}:${customerKey}`;
  await tx.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`,
  );
}

export interface OpenRequestRef {
  id: string;
  folio: number;
  status: 'NEW' | 'IN_PROGRESS';
  version: number;
}

/** The open request of this customer with this dedup key, row-locked. */
export async function findOpenDedup(
  tx: TenantClient,
  tenantId: string,
  customerKey: string,
  dedupKey: string,
): Promise<OpenRequestRef | null> {
  const rows = await tx.$queryRaw<OpenRequestRef[]>(Prisma.sql`
    SELECT "id", "folio", "status"::text AS "status", "version"
    FROM "chatbot_requests"
    WHERE "tenantId" = ${tenantId} AND "customerKey" = ${customerKey}
      AND "dedupKey" = ${dedupKey} AND "status" IN ('NEW', 'IN_PROGRESS')
    FOR UPDATE`);
  return rows[0] ?? null;
}

/**
 * §6.4: at most `openLimit` open requests and `creationsPerHour` creations an
 * hour per customer, both counted in the database. Run it under the customer
 * lock, after the dedup lookup: a repeated question merges even at the limit.
 *
 * `Retry-After` is the time until the count drops back under the limit. A
 * customer at the limit needs the oldest creation of the window to leave; one
 * over it (rows created outside this check, or a lowered limit) needs one
 * more per excess row, so the wait ends with that many creations expired.
 */
export async function assertIntakeLimits(
  tx: TenantClient,
  tenantId: string,
  customerKey: string,
  limits: IntakeLimits,
  now: Date = new Date(),
): Promise<void> {
  const since = new Date(now.getTime() - CREATION_WINDOW_MS);
  const [row] = await tx.$queryRaw<
    { open: number; recent: number }[]
  >(Prisma.sql`
    SELECT (count(*) FILTER (WHERE "status" IN ('NEW', 'IN_PROGRESS')))::int AS "open",
           (count(*) FILTER (WHERE "createdAt" > ${since}))::int AS "recent"
    FROM "chatbot_requests"
    WHERE "tenantId" = ${tenantId} AND "customerKey" = ${customerKey}`);
  if (row.open >= limits.openLimit) {
    throw new ChatbotRequestCommandError(
      'CUSTOMER_OPEN_LIMIT',
      409,
      undefined,
      { limit: limits.openLimit, open: row.open },
    );
  }
  if (row.recent >= limits.creationsPerHour) {
    // Only on the rejection path: the creation whose expiry frees a slot.
    const [expiring] = await tx.$queryRaw<{ createdAt: Date }[]>(Prisma.sql`
      SELECT "createdAt" FROM "chatbot_requests"
      WHERE "tenantId" = ${tenantId} AND "customerKey" = ${customerKey}
        AND "createdAt" > ${since}
      ORDER BY "createdAt" ASC
      OFFSET ${row.recent - limits.creationsPerHour} LIMIT 1`);
    const freedAt = expiring
      ? expiring.createdAt.getTime() + CREATION_WINDOW_MS
      : now.getTime() + CREATION_WINDOW_MS;
    throw new ChatbotRequestCommandError(
      'CUSTOMER_RATE_LIMITED',
      429,
      undefined,
      {
        limit: limits.creationsPerHour,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((freedAt - now.getTime()) / 1000),
        ),
      },
    );
  }
}

/**
 * Inserts a request row with `ON CONFLICT … DO NOTHING` on the open-dedup
 * index, so a creator that lost the race for a `(customer, dedupKey)` gets
 * `null` (and merges) instead of a unique violation that would abort its
 * transaction. The conflict target must repeat the partial index predicate or
 * PostgreSQL does not infer the index. Any other unique violation (source,
 * folio, wrapped FK) still raises. The column list is fixed: it is every
 * column an intake sets, and the rest take their database defaults.
 */
export async function insertRequestOnDedup(
  tx: TenantClient,
  data: Prisma.ChatbotRequestCreateManyInput,
  now: Date = new Date(),
): Promise<string | null> {
  // Unit 7a (§5.4): the deadlines are part of the insert. A caller that already
  // computed them (the wrapper) passes them in `data`; the direct creator does
  // not, so they are computed here, under `FOR SHARE` on the settings row.
  const sla =
    data.slaPolicyVersion === undefined || data.slaPolicyVersion === null
      ? await slaColumnsForNew(
          tx,
          data.tenantId,
          { subtype: data.subtype },
          now,
        )
      : {
          claimDeadlineAt: (data.claimDeadlineAt as Date | null) ?? null,
          resolveDeadlineAt: (data.resolveDeadlineAt as Date | null) ?? null,
          slaPolicyVersion: data.slaPolicyVersion,
          nextSlaCheckAt: (data.nextSlaCheckAt as Date | null) ?? null,
        };
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO "chatbot_requests" (
      "id", "tenantId", "folio", "kind", "subtype", "customerKey", "customerId",
      "ambiguousCustomer", "phoneCountryCode", "phone", "conversationRef",
      "lastCustomerMessageAt", "whatsappWindowClosesAt", "summary", "needs",
      "context", "dedupKey", "humanDecisionId", "deliveryZoneRequestId",
      "receiptEvidenceId", "source", "sourceRequestId", "canonicalRequestHash",
      "submittedCredentialId", "claimDeadlineAt", "resolveDeadlineAt",
      "slaPolicyVersion", "nextSlaCheckAt", "updatedAt")
    VALUES (
      ${randomUUID()}, ${data.tenantId}, ${data.folio},
      ${data.kind}::"ChatbotRequestKind", ${data.subtype}::"ChatbotRequestSubtype",
      ${data.customerKey}, ${data.customerId ?? null},
      ${data.ambiguousCustomer ?? false}, ${data.phoneCountryCode ?? null},
      ${data.phone ?? null}, ${data.conversationRef ?? null},
      ${(data.lastCustomerMessageAt as Date | undefined) ?? null},
      ${(data.whatsappWindowClosesAt as Date | undefined) ?? null},
      ${data.summary}, ${data.needs ?? null},
      ${data.context === undefined ? null : JSON.stringify(data.context)}::jsonb,
      ${data.dedupKey ?? null}, ${data.humanDecisionId ?? null},
      ${data.deliveryZoneRequestId ?? null}, ${data.receiptEvidenceId ?? null},
      ${data.source}, ${data.sourceRequestId}, ${data.canonicalRequestHash ?? null},
      ${data.submittedCredentialId ?? null}, ${sla.claimDeadlineAt},
      ${sla.resolveDeadlineAt}, ${sla.slaPolicyVersion}, ${sla.nextSlaCheckAt},
      now())
    ON CONFLICT ("tenantId", "customerKey", "dedupKey")
      WHERE "status" IN ('NEW', 'IN_PROGRESS') AND "dedupKey" IS NOT NULL
      DO NOTHING
    RETURNING "id"`);
  return rows[0]?.id ?? null;
}

/**
 * §3.5: append the repeated question to the open request's timeline. The
 * request keeps its version (a merge is not a staff command, so it must not
 * fail the CAS of someone about to claim it); a newer customer message
 * reopens the 24 h window. The caller holds the row lock.
 */
export async function recordMerge(
  tx: TenantClient,
  tenantId: string,
  target: OpenRequestRef,
  merged: {
    credentialId: string;
    sourceRequestId: string;
    triggerWaMessageId: string | null;
    lastCustomerMessageAt: Date | null;
  },
): Promise<void> {
  await tx.chatbotRequestEvent.create({
    data: {
      tenantId,
      requestId: target.id,
      type: 'MERGED',
      actorKind: 'SERVICE',
      actorId: merged.credentialId,
      fromStatus: target.status,
      toStatus: target.status,
      version: target.version,
      data: {
        sourceRequestId: merged.sourceRequestId,
        triggerWaMessageId: merged.triggerWaMessageId,
      },
    },
  });
  if (merged.lastCustomerMessageAt) {
    const last = merged.lastCustomerMessageAt;
    await tx.$executeRaw(Prisma.sql`
      UPDATE "chatbot_requests"
      SET "lastCustomerMessageAt" = ${last},
          "whatsappWindowClosesAt" = ${new Date(last.getTime() + CUSTOMER_REPLY_WINDOW_MS)},
          "updatedAt" = now()
      WHERE "tenantId" = ${tenantId} AND "id" = ${target.id}
        AND ("lastCustomerMessageAt" IS NULL OR "lastCustomerMessageAt" < ${last})`);
  }
}
