import { Injectable } from '@nestjs/common';
import { enqueueBackorderReservedNotice } from '../../notifications/infrastructure/backorder-notice.writer';
import type {
  BackorderReservedHook,
  ReservedBackorder,
} from '../application/ports/backorder-reserved-hook.port';
import {
  backorderNoticeSubject,
  enqueueBackorderReserved,
} from './backorder-feed-writes';
import type { TenantClient } from '../../chatbot-requests/infrastructure/chatbot-request-writes';

/**
 * Binding of `BACKORDER_RESERVED_HOOK` (replaces T2a's no-op): in the very
 * transaction that reserved the backorder, enqueue `backorder.reserved` for the
 * bot (exactly once per backorder version: the feed's partial unique index) and
 * the staff notice «apartado» (contract §9.5). A throwing hook rolls the
 * reservation back with the rest of that allocation (the journal runs the
 * allocator in a savepoint, so the stock write that triggered it is kept and
 * the sweep's safety net retries). The staff notice is an outbox insert with no
 * lock; the feed item (advisory lock) goes last.
 */
@Injectable()
export class FeedBackorderReservedHook implements BackorderReservedHook {
  async onReserved(
    tx: TenantClient,
    reserved: ReservedBackorder,
  ): Promise<void> {
    const { tenantId, backorderId } = reserved;
    await enqueueBackorderReservedNotice(
      tx,
      tenantId,
      await backorderNoticeSubject(tx, tenantId, backorderId),
    );
    await enqueueBackorderReserved(tx, tenantId, backorderId);
  }
}
