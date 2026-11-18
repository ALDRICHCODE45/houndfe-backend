import { HttpException, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { enqueuePickupExtended } from '../chatbot-requests/infrastructure/sale-feed-writes';
import {
  HOLD_DEFAULT_DURATION_MS,
  HOLD_STAGE,
  SALE_HOLD_SELECT,
  holdReminderAt,
  toSaleHoldView,
  type SaleHoldView,
} from './domain/sale-hold';

/** Code-only error envelope `{ statusCode, error, message }` (no row data). */
export function saleHoldError(statusCode: number, code: string): HttpException {
  return new HttpException(
    { statusCode, error: code, message: code },
    statusCode,
  );
}

/** Response of PATCH /chatbot-api/sales/:saleId/payment-intent. */
export interface PayInStoreResponse {
  saleId: string;
  folio: string | null;
  paymentIntent: 'IN_STORE';
  holdUntil: string;
  reminderAt: string | null;
}

/** Payload of the in-process `sale.hold.updated` event (staff edit). */
export interface SaleHoldUpdatedEvent {
  saleId: string;
  tenantId: string;
  userId: string;
  previousExpiresAt: string | null;
  expiresAt: string;
  reminderAt: string | null;
  version: number;
  occurredAt: string;
}

type LockedHoldRow = {
  status: 'DRAFT' | 'CONFIRMED' | 'CANCELED';
  paymentStatus: 'PAID' | 'PARTIAL' | 'CREDIT' | null;
  paidCents: number;
  paymentIntent: 'IN_STORE' | null;
  holdExpiresAt: Date | null;
  holdVersion: number;
};

/**
 * pay-in-store-pickup / T1 — counter-payment hold of bot PICKUP sales.
 *
 * Both writes are tenant-qualified and re-check eligibility at write time;
 * the T2 sweep re-checks `holdVersion`/`holdStage` under its own row lock, so
 * a staff edit that commits first always wins over a stale sweep decision.
 */
@Injectable()
export class SaleHoldService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Bot: mark a CONFIRMED ONLINE PICKUP unpaid sale as pay-in-store with the
   * default 24 h hold. Idempotent: a sale already marked IN_STORE (and still
   * eligible) returns its existing hold unchanged.
   */
  async markPayInStore(
    saleId: string,
    now: Date = new Date(),
  ): Promise<PayInStoreResponse> {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();
    const expiresAt = new Date(now.getTime() + HOLD_DEFAULT_DURATION_MS);

    // One conditional write: eligibility is re-checked by the predicate, so
    // a concurrent payment or cancellation can never be overwritten.
    await prisma.sale.updateMany({
      where: {
        id: saleId,
        tenantId,
        status: 'CONFIRMED',
        channel: 'ONLINE',
        fulfillmentMode: 'PICKUP',
        paymentStatus: 'CREDIT',
        paidCents: 0,
        paymentIntent: null,
      },
      data: {
        paymentIntent: 'IN_STORE',
        holdExpiresAt: expiresAt,
        holdReminderAt: holdReminderAt(expiresAt, now),
        holdStage: HOLD_STAGE.NONE,
        holdVersion: { increment: 1 },
      },
    });

    const row = await prisma.sale.findFirst({
      where: { id: saleId, tenantId },
      select: {
        id: true,
        folio: true,
        status: true,
        channel: true,
        fulfillmentMode: true,
        paymentStatus: true,
        paidCents: true,
        ...SALE_HOLD_SELECT,
      },
    });
    if (!row) throw saleHoldError(404, 'SALE_NOT_FOUND');
    if (row.status !== 'CONFIRMED')
      throw saleHoldError(409, 'PAY_IN_STORE_SALE_NOT_CONFIRMED');
    if (row.channel !== 'ONLINE')
      throw saleHoldError(422, 'PAY_IN_STORE_REQUIRES_ONLINE');
    if (row.fulfillmentMode !== 'PICKUP')
      throw saleHoldError(422, 'PAY_IN_STORE_REQUIRES_PICKUP');
    if (row.paymentStatus !== 'CREDIT' || row.paidCents !== 0)
      throw saleHoldError(409, 'PAY_IN_STORE_SALE_ALREADY_PAID');
    if (row.paymentIntent !== 'IN_STORE' || !row.holdExpiresAt)
      throw saleHoldError(500, 'PAY_IN_STORE_FAILED');

    return {
      saleId: row.id,
      folio: row.folio,
      paymentIntent: 'IN_STORE',
      holdUntil: row.holdExpiresAt.toISOString(),
      reminderAt: row.holdReminderAt?.toISOString() ?? null,
    };
  }

  /**
   * Staff: move the deadline of an IN_STORE CONFIRMED unpaid sale (S5).
   * Compare-and-set on `holdVersion` under a row lock; recomputes the
   * reminder (S3), resets `holdStage` to 0 and bumps the version.
   *
   * T3: in the same transaction, tells the bot (`sale.pickup_extended`, one
   * per new hold version) when the sale has a customer to tell. The feed lock
   * is taken after the sale row lock (the order of every enqueuer).
   */
  async updateHold(
    saleId: string,
    actorUserId: string,
    input: { expiresAt: Date; expectedVersion: number },
    now: Date = new Date(),
  ): Promise<SaleHoldView> {
    if (input.expiresAt.getTime() <= now.getTime())
      throw saleHoldError(422, 'HOLD_EXPIRY_NOT_FUTURE');

    const tenantId = this.tenantPrisma.getTenantId();
    const reminderAt = holdReminderAt(input.expiresAt, now);

    const { view, previousExpiresAt } =
      await this.tenantPrisma.runInTransaction(async () => {
        const prisma = this.tenantPrisma.getClient();
        const locked = await prisma.$queryRaw<LockedHoldRow[]>`
          SELECT "status", "paymentStatus", "paidCents", "paymentIntent",
                 "holdExpiresAt", "holdVersion"
          FROM "sales"
          WHERE "id" = ${saleId} AND "tenantId" = ${tenantId}
          FOR UPDATE
        `;
        const row = locked[0];
        // Drafts stay private to the POS draft endpoints.
        if (!row || row.status === 'DRAFT')
          throw saleHoldError(404, 'SALE_NOT_FOUND');
        if (row.paymentIntent !== 'IN_STORE')
          throw saleHoldError(409, 'SALE_NOT_PAY_IN_STORE');
        if (
          row.status !== 'CONFIRMED' ||
          row.paymentStatus !== 'CREDIT' ||
          row.paidCents !== 0
        )
          throw saleHoldError(409, 'SALE_HOLD_NOT_EDITABLE');
        if (row.holdVersion !== input.expectedVersion)
          throw saleHoldError(409, 'HOLD_VERSION_CONFLICT');

        const updated = await prisma.sale.update({
          where: { id: saleId, tenantId },
          data: {
            holdExpiresAt: input.expiresAt,
            holdReminderAt: reminderAt,
            holdStage: HOLD_STAGE.NONE,
            holdVersion: { increment: 1 },
          },
          select: { ...SALE_HOLD_SELECT, folio: true, customerId: true },
        });
        // Informational for the bot; a sale with no customer has nobody to
        // tell (the bot's checkout always sets one).
        if (updated.customerId !== null) {
          await enqueuePickupExtended(
            prisma,
            tenantId,
            {
              id: saleId,
              folio: updated.folio,
              holdExpiresAt: updated.holdExpiresAt,
              customerId: updated.customerId,
            },
            updated.holdVersion,
          );
        }
        return {
          view: toSaleHoldView(updated) as SaleHoldView,
          previousExpiresAt: row.holdExpiresAt,
        };
      });

    const event: SaleHoldUpdatedEvent = {
      saleId,
      tenantId,
      userId: actorUserId,
      previousExpiresAt: previousExpiresAt?.toISOString() ?? null,
      expiresAt: view.expiresAt as string,
      reminderAt: view.reminderAt,
      version: view.version,
      occurredAt: now.toISOString(),
    };
    this.eventEmitter.emit('sale.hold.updated', event);
    return view;
  }

  /** Current hold of a tenant sale, or null (no intent / not found). */
  async findHold(saleId: string): Promise<SaleHoldView | null> {
    const row = await this.tenantPrisma.getClient().sale.findFirst({
      where: { id: saleId, tenantId: this.tenantPrisma.getTenantId() },
      select: SALE_HOLD_SELECT,
    });
    return row ? toSaleHoldView(row) : null;
  }
}
