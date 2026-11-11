/**
 * Retention delete of `notifications` (contract §5.2: 90 days; §10.1 R11).
 *
 * One statement deletes one bounded batch: the oldest rows strictly before the
 * cutoff, picked through `notifications_createdAt_idx` and locked with
 * `FOR UPDATE SKIP LOCKED`, so two replicas (or two overlapping runs) take
 * disjoint rows: no double delete, no waiting, no error. A system operation
 * across tenants, hence the root client (it runs outside any HTTP/CLS context).
 *
 * Read or unread makes no difference: the contract retains a `Notification`
 * 90 days, and an unread badge that old is no longer actionable. Nothing else
 * is touched (requests, their events and audit are kept forever, §6.2).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';

@Injectable()
export class PrismaNotificationRetentionStore {
  constructor(private readonly prisma: PrismaService) {}

  /** Deletes up to `batch` notices created strictly before `cutoff`. */
  async purgeOlderThan(cutoff: Date, batch: number): Promise<number> {
    if (!Number.isInteger(batch) || batch <= 0) {
      throw new Error('batch must be a positive integer');
    }
    // A CTE with a locking clause is never inlined, so the batch is picked ONCE.
    // As a `USING (subquery)` the planner may re-run the subquery per row, and
    // with SKIP LOCKED each run picks different rows: a batch of 10 deleted 16.
    return this.prisma.$executeRaw(Prisma.sql`
      WITH doomed AS (
        SELECT "id" FROM "notifications"
        WHERE "createdAt" < ${cutoff}
        ORDER BY "createdAt"
        LIMIT ${batch}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM "notifications" n
      USING doomed
      WHERE n."id" = doomed."id"`);
  }
}
