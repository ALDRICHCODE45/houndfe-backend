/**
 * Producer side of the notices (unit 6). A state change calls
 * `enqueueNotice` on ITS transaction: the only cost on the hot path is one
 * outbox insert, and a rollback leaves no notice behind. Recipients are
 * resolved later by the dedicated consumer (contract §5.1: "avisar nunca
 * bloquea el alta"), from the permissions held at that moment.
 */
import type { Prisma } from '@prisma/client';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  NOTICE_NOTIFY_EVENT_TYPE,
  audienceOf,
  type ChatbotRequestNotice,
  type ClosedCause,
} from '../domain/chatbot-request-notice';

/** The tenant-extended transaction client every inbox producer holds. */
export type OutboxClient = ReturnType<TenantPrismaService['getClient']>;

/**
 * Writes the notify row. A `USER` notice without a recipient, or addressed to
 * the person who caused it, has nobody to tell and writes nothing (returns
 * `false`).
 */
export async function enqueueNotice(
  tx: OutboxClient,
  tenantId: string,
  notice: ChatbotRequestNotice,
  /**
   * Hold the notice until then: it becomes the row's `nextAttemptAt`, which the
   * notify consumer already honors (`nextAttemptAt <= NOW()`), so the release
   * is durable, shared by replicas and needs no timer. `null`/absent = now.
   */
  releaseAt?: Date | null,
): Promise<boolean> {
  if (audienceOf(notice.type) === 'USER') {
    if (
      !notice.recipientUserId ||
      notice.recipientUserId === notice.actorUserId
    ) {
      return false;
    }
  }
  await tx.outboxEvent.create({
    data: {
      tenantId,
      aggregateType: 'ChatbotRequest',
      aggregateId: notice.requestId,
      eventType: NOTICE_NOTIFY_EVENT_TYPE,
      payload: { ...notice } as Prisma.InputJsonObject,
      ...(releaseAt ? { nextAttemptAt: releaseAt } : {}),
    },
  });
  return true;
}

/**
 * §5.1 «el cliente canceló o se resolvió solo → quien la atendía»: tells the
 * assignee that their request closed. Nothing is written for a request nobody
 * held, or when the assignee is the person who closed it (`actorUserId`).
 * One close per request, so the dedup key is per request.
 */
export function enqueueClosedNotice(
  tx: OutboxClient,
  tenantId: string,
  closed: {
    id: string;
    folio: number;
    subtype: string;
    assigneeUserId: string | null;
  },
  cause: ClosedCause,
  actorUserId?: string,
): Promise<boolean> {
  if (!closed.assigneeUserId) return Promise.resolve(false);
  return enqueueNotice(tx, tenantId, {
    type: 'REQUEST_CANCELLED',
    requestId: closed.id,
    folio: closed.folio,
    subtype: closed.subtype,
    dedupKey: `closed:${closed.id}`,
    recipientUserId: closed.assigneeUserId,
    cause,
    ...(actorUserId ? { actorUserId } : {}),
  });
}
