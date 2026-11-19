/**
 * pay-in-store-pickup / T2 (S4) — producer of the sale-hold staff notice. Same
 * contract as `enqueueNotice`: one outbox insert on the caller's transaction
 * (the hold sweep's), so a rollback leaves no notice behind, and recipients
 * are resolved later by `ChatbotRequestNotifyConsumer` from the permissions
 * held at that moment.
 */
import type { Prisma } from '@prisma/client';
import { NOTICE_NOTIFY_EVENT_TYPE } from '../domain/chatbot-request-notice';
import {
  SALE_HOLD_REVIEW_NOTICE,
  saleHoldReviewDedupKey,
  type SaleHoldReviewNotice,
  type SaleHoldReviewReason,
} from '../domain/sale-hold-notice';
import type { OutboxClient } from './chatbot-request-notice.writer';

export async function enqueueSaleHoldReviewNotice(
  tx: Pick<OutboxClient, 'outboxEvent'>,
  tenantId: string,
  sale: {
    id: string;
    folio: string | null;
    holdVersion: number;
    reason: SaleHoldReviewReason;
  },
): Promise<void> {
  const notice: SaleHoldReviewNotice = {
    type: SALE_HOLD_REVIEW_NOTICE,
    saleId: sale.id,
    saleFolio: sale.folio,
    holdVersion: sale.holdVersion,
    reason: sale.reason,
    dedupKey: saleHoldReviewDedupKey(sale.id, sale.holdVersion),
  };
  await tx.outboxEvent.create({
    data: {
      tenantId,
      aggregateType: 'Sale',
      aggregateId: sale.id,
      eventType: NOTICE_NOTIFY_EVENT_TYPE,
      payload: { ...notice } as Prisma.InputJsonObject,
    },
  });
}
