/**
 * restock-backorder / T2b — producer of the backorder staff notices (reserved,
 * expired, undelivered). Same contract as `enqueueSaleHoldReviewNotice`: one
 * outbox insert on the caller's transaction (the allocator's, the sweep's or
 * the feed ACK's), so a rollback leaves no notice behind, and recipients are
 * resolved later by `ChatbotRequestNotifyConsumer` from the permissions held at
 * that moment. No lock is taken here.
 */
import type { Prisma } from '@prisma/client';
import { NOTICE_NOTIFY_EVENT_TYPE } from '../domain/chatbot-request-notice';
import {
  BACKORDER_EXPIRED_NOTICE,
  BACKORDER_RESERVED_NOTICE,
  BACKORDER_UNDELIVERED_NOTICE,
  backorderExpiredDedupKey,
  backorderReservedDedupKey,
  backorderUndeliveredDedupKey,
  type BackorderNotice,
  type BackorderNoticeType,
} from '../domain/backorder-notice';
import type { OutboxClient } from './chatbot-request-notice.writer';

export interface BackorderNoticeSubject {
  id: string;
  folio: string;
  productName: string;
  variantName: string | null;
  quantity: number;
}

async function enqueue(
  tx: Pick<OutboxClient, 'outboxEvent'>,
  tenantId: string,
  type: BackorderNoticeType,
  backorder: BackorderNoticeSubject,
  dedupKey: string,
  extra: Pick<BackorderNotice, 'feedType' | 'reason'> = {},
): Promise<void> {
  const notice: BackorderNotice = {
    type,
    backorderId: backorder.id,
    folio: backorder.folio,
    productName: backorder.productName,
    variantName: backorder.variantName,
    quantity: backorder.quantity,
    ...extra,
    dedupKey,
  };
  await tx.outboxEvent.create({
    data: {
      tenantId,
      aggregateType: 'Backorder',
      aggregateId: backorder.id,
      eventType: NOTICE_NOTIFY_EVENT_TYPE,
      payload: { ...notice } as Prisma.InputJsonObject,
    },
  });
}

/** A backorder became RESERVED (`version` = its version after the reservation). */
export function enqueueBackorderReservedNotice(
  tx: Pick<OutboxClient, 'outboxEvent'>,
  tenantId: string,
  backorder: BackorderNoticeSubject & { version: number },
): Promise<void> {
  return enqueue(
    tx,
    tenantId,
    BACKORDER_RESERVED_NOTICE,
    backorder,
    backorderReservedDedupKey(backorder.id, backorder.version),
  );
}

/** A RESERVED backorder lapsed (RESERVED → EXPIRED, §9.5). */
export function enqueueBackorderExpiredNotice(
  tx: Pick<OutboxClient, 'outboxEvent'>,
  tenantId: string,
  backorder: BackorderNoticeSubject,
): Promise<void> {
  return enqueue(
    tx,
    tenantId,
    BACKORDER_EXPIRED_NOTICE,
    backorder,
    backorderExpiredDedupKey(backorder.id),
  );
}

/**
 * The bot could not deliver `backorder.reserved` / `backorder.reservation_reminder`
 * (`PROVIDER_REJECTED`): staff call the customer (§4).
 */
export function enqueueBackorderUndeliveredNotice(
  tx: Pick<OutboxClient, 'outboxEvent'>,
  tenantId: string,
  backorder: BackorderNoticeSubject,
  delivery: {
    deliveryId: string;
    feedType: NonNullable<BackorderNotice['feedType']>;
    reason: string;
  },
): Promise<void> {
  return enqueue(
    tx,
    tenantId,
    BACKORDER_UNDELIVERED_NOTICE,
    backorder,
    backorderUndeliveredDedupKey(delivery.deliveryId),
    { feedType: delivery.feedType, reason: delivery.reason },
  );
}
