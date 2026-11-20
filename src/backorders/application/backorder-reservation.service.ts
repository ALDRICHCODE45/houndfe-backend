/**
 * Backorder reservations on the stock journal (contract v1 §3, §4):
 *
 * - `releaseReservation` — the real binding of `BACKORDER_RESERVATION_RELEASER`
 *   (replaces T1's no-op): cancelling a RESERVED backorder hands its units back
 *   to the buckets they came from (`BACKORDER_RELEASE`); the journal writer then
 *   runs the allocator in the same transaction so the next WAITING backorder is
 *   served.
 * - `revalidateReservation` — the expired-lot primitive (owner Q6): the T2b
 *   sweep and the T3 checkout call it and emit the feed when it reports
 *   `RESERVATION_LOST`.
 *
 * Lock order: journal locks (`lockStock`) BEFORE the backorder row, the same as
 * the allocator (sale row → products → lots → variants → backorder rows).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { StockJournalWriter } from '../../inventory/infrastructure/stock-journal.writer';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { LowStockCrossing } from '../../stock-alerts/infrastructure/low-stock-crossing.service';
import type { BackorderStatusValue } from '../domain/backorder-status';
import {
  BACKORDER_SYSTEM_ACTOR,
  BackorderAllocator,
} from './backorder-allocator';
import type {
  BackorderReservationRef,
  BackorderReservationReleaser,
} from './ports/backorder-reservation-releaser.port';

type TenantClient = ReturnType<TenantPrismaService['getClient']>;

export type ReservationRevalidation =
  /** Not RESERVED (unknown, WAITING or terminal): nothing to validate. */
  | { outcome: 'NOT_RESERVED'; status: BackorderStatusValue | null }
  /** RESERVED but the journal holds nothing for it (data fault; reported, not repaired). */
  | { outcome: 'NOT_HELD' }
  /** No held lot has expired. */
  | { outcome: 'VALID' }
  /** An expired lot was replaced by valid stock; the backorder stays RESERVED. */
  | { outcome: 'SWAPPED' }
  /**
   * Valid stock cannot cover it: everything was released and the backorder is
   * WAITING again at its original place. The caller emits
   * `backorder.reservation_lost`; `reservedIds` are the backorders the
   * released units were allocated to right away.
   */
  | {
      outcome: 'RESERVATION_LOST';
      backorderId: string;
      productId: string;
      variantId: string | null;
      reservedIds: string[];
    };

@Injectable()
export class BackorderReservationService implements BackorderReservationReleaser {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly writer: StockJournalWriter,
    private readonly allocator: BackorderAllocator,
    private readonly crossing: LowStockCrossing,
  ) {}

  async releaseReservation(
    reservation: BackorderReservationRef,
  ): Promise<void> {
    const movements = await this.writer.releaseBackorder({
      backorderId: reservation.backorderId,
      actor: reservation.actor ?? BACKORDER_SYSTEM_ACTOR,
    });
    // Release rows first, then the allocator's reservations: the edge sees the net change.
    await this.crossing.record(movements);
  }

  /**
   * Makes sure a RESERVED backorder holds no expired lot. Must run in an
   * ambient transaction. Takes the stock locks first and the backorder row
   * second, so callers must not already hold the row (T3 checkout and the T2b
   * sweep call it before locking the backorder themselves).
   */
  async revalidateReservation(
    tx: TenantClient,
    backorderId: string,
    now: Date = new Date(),
  ): Promise<ReservationRevalidation> {
    const tenantId = this.tenantPrisma.getTenantId();
    const row = await tx.backorder.findFirst({
      where: { id: backorderId, tenantId },
      select: { status: true, productId: true, variantId: true },
    });
    if (!row || row.status !== 'RESERVED') {
      return { outcome: 'NOT_RESERVED', status: row?.status ?? null };
    }

    await this.writer.lockStock([row.productId]);
    const locked = await tx.$queryRaw<Array<{ status: BackorderStatusValue }>>(
      Prisma.sql`SELECT "status" FROM "backorders"
        WHERE "id" = ${backorderId} AND "tenantId" = ${tenantId} FOR UPDATE`,
    );
    if (locked[0]?.status !== 'RESERVED') {
      return { outcome: 'NOT_RESERVED', status: locked[0]?.status ?? null };
    }

    const result = await this.writer.revalidateBackorder(
      { backorderId, actor: BACKORDER_SYSTEM_ACTOR },
      now,
    );
    switch (result.status) {
      case 'NOT_HELD':
        return { outcome: 'NOT_HELD' };
      case 'VALID':
        return { outcome: 'VALID' };
      case 'SWAPPED':
        await this.crossing.record(result.movements);
        return { outcome: 'SWAPPED' };
      case 'LOST': {
        // Back to the front of the queue: `scheduledAt` is never touched.
        await tx.backorder.update({
          where: { id: backorderId, tenantId },
          data: {
            status: 'WAITING',
            reservedAt: null,
            reservedUntil: null,
            reminderAt: null,
            reservationStage: 0,
            currentPriceCents: null,
            finalPriceCents: null,
            version: { increment: 1 },
          },
        });
        // The row is WAITING again before the queue is walked: units released
        // from valid lots go to whoever fits (this one cannot, see the journal).
        const allocation = await this.allocator.allocate(
          tx,
          tenantId,
          row.productId,
          row.variantId,
          now,
        );
        await this.crossing.record([
          ...result.movements,
          ...allocation.movements,
        ]);
        return {
          outcome: 'RESERVATION_LOST',
          backorderId,
          productId: row.productId,
          variantId: row.variantId,
          reservedIds: allocation.reservedIds,
        };
      }
    }
  }
}
