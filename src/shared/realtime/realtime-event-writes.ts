/**
 * Writer of the durable realtime log (`realtime_events`, unit 8; contract
 * §5.3, §10.1 R7), always on the caller's transaction so the event commits or
 * rolls back with the change that caused it.
 *
 * Request events do NOT come through here: the deferred constraint trigger
 * `chatbot_request_events_realtime` writes them for every code path that
 * appends an audit event. This writer is for the producers the trigger cannot
 * see (the notification consumer and the read / read-all routes).
 *
 * Order guarantee: `id` is a global sequence, so two transactions of one tenant
 * could take ids 5 and 6 and commit 6 first, and a reader that saw 6 would skip
 * 5 forever. A per-tenant advisory lock taken before the insert and held to the
 * commit makes id order the commit order within a tenant. The trigger takes the
 * very same lock (same key text), at commit time. Multi-tenant batches lock in
 * ascending tenant order so two writers never cross.
 *
 * `NOTIFY` is part of the transaction: PostgreSQL delivers it at commit and
 * drops it on rollback. The payload is the tenant id only; the content is read
 * from the table.
 */
import { Prisma } from '@prisma/client';

/** `LISTEN`/`NOTIFY` channel of the realtime log; the payload is the tenant id. */
export const REALTIME_CHANNEL = 'realtime_events';

export interface RealtimeEventDraft {
  tenantId: string;
  /** `null`: everyone with `read:ChatbotRequest`; otherwise only that user. */
  userId: string | null;
  type: string;
  requestId?: string | null;
  /** Ids and numbers only, never customer data (the row is built at delivery). */
  payload: Record<string, unknown>;
}

/** The two raw methods of a Prisma transaction client the writer needs. */
export interface RealtimeTx {
  $queryRaw: (query: Prisma.Sql) => Promise<unknown>;
}

/** The advisory-lock key text of a tenant (shared with the SQL trigger). */
export const realtimeLockKey = (tenantId: string): string =>
  `realtime:${tenantId}`;

export async function emitRealtimeEvents(
  tx: RealtimeTx,
  drafts: RealtimeEventDraft[],
): Promise<void> {
  if (drafts.length === 0) return;
  const byTenant = new Map<string, RealtimeEventDraft[]>();
  for (const draft of drafts) {
    const list = byTenant.get(draft.tenantId) ?? [];
    list.push(draft);
    byTenant.set(draft.tenantId, list);
  }
  for (const tenantId of [...byTenant.keys()].sort()) {
    // Prisma cannot decode `void`; the cast keeps the transaction-scoped lock.
    await tx.$queryRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${realtimeLockKey(tenantId)}, 0))::text`,
    );
    for (const draft of byTenant.get(tenantId) ?? []) {
      await tx.$queryRaw(Prisma.sql`
        INSERT INTO "realtime_events" ("tenantId", "userId", "type", "requestId", "payload")
        VALUES (${tenantId}, ${draft.userId}, ${draft.type}, ${draft.requestId ?? null},
                ${JSON.stringify(draft.payload)}::jsonb)
        RETURNING "id"`);
    }
    await tx.$queryRaw(
      Prisma.sql`SELECT pg_notify(${REALTIME_CHANNEL}, ${tenantId})::text`,
    );
  }
}
