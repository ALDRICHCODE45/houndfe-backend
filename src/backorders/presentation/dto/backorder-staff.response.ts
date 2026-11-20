/**
 * `BackorderStaff` (contract v1 §9.1): the POS projection of a backorder =
 * every `BackorderBot` field plus the staff additions. Timestamps are ISO 8601
 * UTC (`…Z`), like the bot projection.
 *
 * `customer.phone` is the full international number (`+525512345678`) and is
 * NOT masked: the Cashier reads it too, because the staff notice «No se pudo
 * avisar al cliente» tells them to phone the customer, and `read:Customer`
 * already shows the same number in the customers screen. The top-level
 * `phoneCountryCode` / `phone` are the `BackorderBot` pair (national number).
 */
import type { SaleStatus } from '@prisma/client';
import { toStaffPhone } from '../../../chatbot-requests/domain/staff-phone';
import {
  toBackorderBot,
  type BackorderBot,
  type BackorderBotSource,
} from './backorder-bot.response';

export interface BackorderStaffSource extends Omit<
  BackorderBotSource,
  'customer'
> {
  version: number;
  referencePriceListId: string | null;
  etaStage: number;
  passedOverCount: number;
  chatbotRequestId: string | null;
  confirmedAt: Date | null;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
  expiredAt: Date | null;
  customer: {
    id: string;
    firstName: string;
    lastName: string | null;
    phoneCountryCode: string | null;
    phone: string | null;
  };
  cancelledBy: { id: string; name: string } | null;
  sale: { status: SaleStatus } | null;
}

export interface BackorderStaff extends BackorderBot {
  /** Optimistic-concurrency token of `POST /backorders/:id/cancel`. */
  version: number;
  customer: { id: string; name: string; phone: string | null };
  /** Every backorder comes from the chatbot in v1 (no staff creation). */
  origin: 'CHATBOT';
  chatbotRequestId: string | null;
  /** The variant's image, else the product's main image; `null` without one. */
  productImageUrl: string | null;
  /** The customer's price list that priced `referencePriceCents`; `null` = PUBLICO. */
  priceListId: string | null;
  confirmedAt: string | null;
  cancelledAt: string | null;
  expiredAt: string | null;
  /** Who cancelled it when `cancelledByKind` is `STAFF`; `null` otherwise. */
  cancelledBy: { id: string; name: string } | null;
  /** Status of the sale a CONFIRMED backorder became (`SaleStatus`); `null` before. */
  saleStatus: SaleStatus | null;
  /**
   * `WAITING`, the overdue re-estimate was already answered (`etaStage` 2) and
   * the new `estimatedAt` is in the past too: the POS highlights it.
   */
  etaOverdue: boolean;
  /** Later backorders reserved while this one kept waiting (Q1). */
  passedOverCount: number;
}

export interface BackorderStaffContext {
  /** 1-based, only meaningful (and kept) while `WAITING`. */
  queuePosition: number | null;
  productImageUrl: string | null;
  now: Date;
}

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

/** The same serializer the staff chatbot screens use, with a caller that may see every number. */
const SEES_PHONE = { can: () => true };

export function toBackorderStaff(
  source: BackorderStaffSource,
  context: BackorderStaffContext,
): BackorderStaff {
  const bot = toBackorderBot(source, context.queuePosition);
  const { customer } = source;
  return {
    ...bot,
    version: source.version,
    customer: {
      id: customer.id,
      name: [customer.firstName, customer.lastName]
        .filter((part): part is string => !!part?.trim())
        .join(' '),
      phone: toStaffPhone(
        { countryCode: customer.phoneCountryCode, phone: customer.phone },
        SEES_PHONE,
      ),
    },
    origin: 'CHATBOT',
    chatbotRequestId: source.chatbotRequestId,
    productImageUrl: context.productImageUrl,
    priceListId: source.referencePriceListId,
    confirmedAt: iso(source.confirmedAt),
    cancelledAt: iso(source.cancelledAt),
    expiredAt: iso(source.expiredAt),
    cancelledBy: source.cancelledBy,
    saleStatus: source.sale?.status ?? null,
    etaOverdue:
      source.status === 'WAITING' &&
      source.etaStage === 2 &&
      source.estimatedAt.getTime() < context.now.getTime(),
    passedOverCount: source.passedOverCount,
  };
}
