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
} from '../domain/chatbot-request-notice';

/** The tenant-extended transaction client every inbox producer holds. */
type OutboxClient = ReturnType<TenantPrismaService['getClient']>;

/**
 * Writes the notify row. A `USER` notice without a recipient, or addressed to
 * the person who caused it, has nobody to tell and writes nothing (returns
 * `false`).
 */
export async function enqueueNotice(
  tx: OutboxClient,
  tenantId: string,
  notice: ChatbotRequestNotice,
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
    },
  });
  return true;
}
