/**
 * restock-backorder / T3 (contract v1 §7) — the backorder side of the bot
 * checkout. Binds `BackorderCheckoutPort` (see the sales port for why it is a
 * registration) and gives each checkout transaction a `BotBackorderCheckout`.
 *
 * LOCK ORDER (L7/L10): every product of the cart (`lockStock`: products → lots
 * → variants, id order) BEFORE any backorder row; backorder rows in id order;
 * nothing here takes a backorder row after the feed's advisory lock. The
 * checkout calls `lockAndVerify` right before the stock charge, after its other
 * locks (customer, address, shipping quote, promotion capacity), so the order
 * every other writer uses is kept: sale → products → lots → variants → rows.
 *
 * `backorder.reservation_lost` (owner Q6) must survive a refused checkout: the
 * expired-lot settlement therefore runs in its OWN short transactions before
 * the checkout transaction (`settleExpiredLots`). The in-checkout re-check
 * still reports a loss it finds (a lot that expired in the meantime), but that
 * rolls back with the checkout; the checkout service then settles it again
 * outside, and the sweep is the backstop.
 */
import { Injectable, Logger } from '@nestjs/common';
import { BackorderCheckoutRegistry } from '../../chatbot-api/application/backorder-checkout.registry';
import { StockJournalWriter } from '../../inventory/infrastructure/stock-journal.writer';
import {
  BackorderCheckoutError,
  type BackorderCheckoutLine,
  type BackorderCheckoutPort,
  type BotBackorderCheckout,
} from '../../sales/domain/backorder-checkout.port';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { BackorderReservationService } from '../application/backorder-reservation.service';
import {
  assertBackorderCheckoutable,
  type CheckoutBackorderRow,
} from '../domain/backorder-checkout-rules';
import { enqueueBackorderReservationLost } from './backorder-feed-writes';

const ROW_SELECT = {
  id: true,
  status: true,
  customerId: true,
  productId: true,
  variantId: true,
  quantity: true,
  finalPriceCents: true,
  reservedUntil: true,
} as const;

@Injectable()
export class BackorderCheckoutService implements BackorderCheckoutPort {
  private readonly logger = new Logger(BackorderCheckoutService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly writer: StockJournalWriter,
    private readonly reservations: BackorderReservationService,
    registry: BackorderCheckoutRegistry,
  ) {
    // Constructor, not `onModuleInit`: the pca-5b boot harness fails closed on
    // unreviewed lifecycle hooks (same as `BackorderAllocator`).
    registry.register(this);
  }

  async settleExpiredLots(backorderIds: string[]): Promise<string | null> {
    const tenantId = this.tenantPrisma.getTenantId();
    let lost: string | null = null;
    // One short transaction per backorder: its loss and its feed item commit
    // together, and the feed lock (taken last) never precedes another row lock.
    for (const id of [...new Set(backorderIds)].sort()) {
      const outcome = await this.tenantPrisma.runInTransaction(async () => {
        const tx = this.tenantPrisma.getClient();
        const now = new Date();
        // Only a live reservation: an expired or settled one is refused by the
        // checkout's own rules, with no stock writes here.
        const row = await tx.backorder.findFirst({
          where: {
            id,
            tenantId,
            status: 'RESERVED',
            reservedUntil: { gt: now },
          },
          select: { id: true },
        });
        if (!row) return null;
        const result = await this.reservations.revalidateReservation(
          tx,
          id,
          now,
        );
        if (result.outcome === 'RESERVATION_LOST') {
          await enqueueBackorderReservationLost(tx, tenantId, id);
        }
        return result.outcome;
      });
      if (outcome === 'RESERVATION_LOST') lost ??= id;
    }
    return lost;
  }

  forCheckout(input: {
    customerId: string;
    lines: BackorderCheckoutLine[];
    productIds: string[];
  }): BotBackorderCheckout {
    const { customerId, productIds } = input;
    const lines = [...input.lines].sort((a, b) =>
      a.backorderId < b.backorderId
        ? -1
        : a.backorderId > b.backorderId
          ? 1
          : 0,
    );
    const read = (id: string): Promise<CheckoutBackorderRow | null> =>
      this.tenantPrisma.getClient().backorder.findFirst({
        where: { id, tenantId: this.tenantPrisma.getTenantId() },
        select: ROW_SELECT,
      });

    return {
      inspect: async (now) => {
        const prices = new Map<string, number>();
        for (const line of lines) {
          prices.set(
            line.backorderId,
            assertBackorderCheckoutable(
              await read(line.backorderId),
              line,
              customerId,
              now,
            ),
          );
        }
        return prices;
      },

      lockAndVerify: async (now) => {
        const tx = this.tenantPrisma.getClient();
        // Every product of the cart, id order, BEFORE any backorder row.
        await this.writer.lockStock(productIds);
        for (const line of lines) {
          // Lot check first (owner Q6: never sell an expired lot). It takes the
          // row lock (stock is already ours) when the backorder is RESERVED.
          const outcome = await this.reservations.revalidateReservation(
            tx,
            line.backorderId,
            now,
          );
          switch (outcome.outcome) {
            case 'NOT_RESERVED':
              throw outcome.status === null
                ? new BackorderCheckoutError('BACKORDER_NOT_FOUND')
                : new BackorderCheckoutError('BACKORDER_NOT_RESERVED', {
                    status: outcome.status,
                  });
            case 'NOT_HELD':
              this.logger.error(
                `backorder ${line.backorderId} is RESERVED but the journal holds nothing for it; checkout refused`,
              );
              throw new BackorderCheckoutError(
                'BACKORDER_RESERVATION_UNAVAILABLE',
              );
            case 'RESERVATION_LOST':
              // Rolls back with this checkout; the caller settles it again outside.
              throw new BackorderCheckoutError('BACKORDER_RESERVATION_LOST');
            case 'VALID':
            case 'SWAPPED':
              break;
          }
          // The row is locked since the revalidation: the rules see its final state.
          assertBackorderCheckoutable(
            await read(line.backorderId),
            line,
            customerId,
            now,
          );
        }
      },

      markConfirmed: async (saleId, confirmedAt) => {
        const tx = this.tenantPrisma.getClient();
        const tenantId = this.tenantPrisma.getTenantId();
        for (const line of lines) {
          const updated = await tx.backorder.updateMany({
            where: { id: line.backorderId, tenantId, status: 'RESERVED' },
            data: {
              status: 'CONFIRMED',
              saleId,
              confirmedAt,
              version: { increment: 1 },
            },
          });
          if (updated.count !== 1) {
            // Unreachable under the row lock; roll the whole checkout back.
            throw new Error(
              `backorder ${line.backorderId} left RESERVED while its checkout held the lock`,
            );
          }
        }
      },
    };
  }
}
