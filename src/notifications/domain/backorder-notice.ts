/**
 * restock-backorder / T2b (contract v1 §4, §9.5) — the staff notices of a
 * restock backorder:
 *
 * - `BACKORDER_RESERVED`: stock arrived and a backorder became `RESERVED`;
 * - `BACKORDER_EXPIRED`: a `RESERVED` backorder lapsed after 24 h without
 *   being confirmed (the sweep);
 * - `BACKORDER_NOTICE_UNDELIVERED`: the bot reported (`PROVIDER_REJECTED`) that
 *   `backorder.reserved` or `backorder.reservation_reminder` could not reach
 *   the customer, so staff call them before the 24 h run out (§4, «24 h start»).
 *
 * They ride the request-notice pipeline like the sale-hold notice: the producer
 * writes the same `chatbot_request.notify` outbox row on its own transaction
 * and the dedicated consumer turns it into in-app notifications + realtime
 * events. They are BACKORDER notices, not request ones: `requestId` stays null
 * on the notification, the payload names the backorder, and they send no email
 * (in-app only). Recipients: every active member with `read:Backorder` (T5
 * seeds it for Manager and Cashier; a `manage` / `all` grant counts too).
 * Small payload, no customer data (§6.3).
 */
export const BACKORDER_RESERVED_NOTICE = 'BACKORDER_RESERVED';
export const BACKORDER_EXPIRED_NOTICE = 'BACKORDER_EXPIRED';
export const BACKORDER_UNDELIVERED_NOTICE = 'BACKORDER_NOTICE_UNDELIVERED';

export const BACKORDER_NOTICE_TYPES = [
  BACKORDER_RESERVED_NOTICE,
  BACKORDER_EXPIRED_NOTICE,
  BACKORDER_UNDELIVERED_NOTICE,
] as const;
export type BackorderNoticeType = (typeof BACKORDER_NOTICE_TYPES)[number];

/** Grants of the recipients, as `[action, subject]` pairs (all of them). */
export const BACKORDER_NOTICE_GRANTS: ReadonlyArray<readonly [string, string]> =
  [['read', 'Backorder']];

/** The bot feed items whose failed delivery staff must follow up by phone. */
export const BACKORDER_UNDELIVERED_FEED_TYPES = [
  'backorder.reserved',
  'backorder.reservation_reminder',
] as const;

/** What the producer writes (outbox payload). */
export interface BackorderNotice {
  type: BackorderNoticeType;
  backorderId: string;
  folio: string;
  productName: string;
  variantName: string | null;
  quantity: number;
  /** `BACKORDER_NOTICE_UNDELIVERED` only: the item that could not be delivered. */
  feedType?: (typeof BACKORDER_UNDELIVERED_FEED_TYPES)[number];
  /** `BACKORDER_NOTICE_UNDELIVERED` only: the provider's reason (≤ 280). */
  reason?: string;
  dedupKey: string;
}

/** `payload` of the in-app notification. */
export type BackorderNoticePayload = Omit<BackorderNotice, 'type' | 'dedupKey'>;

/** One reserved notice per backorder version (a re-reservation is a new one). */
export const backorderReservedDedupKey = (
  backorderId: string,
  version: number,
) => `backorder-reserved:${backorderId}:${version}`;

/** EXPIRED is terminal: one per backorder. */
export const backorderExpiredDedupKey = (backorderId: string) =>
  `backorder-expired:${backorderId}`;

/** One terminal ACK per delivery, so one notice per delivery. */
export const backorderUndeliveredDedupKey = (deliveryId: string) =>
  `backorder-undelivered:${deliveryId}`;

export const isBackorderNoticeType = (
  value: unknown,
): value is BackorderNoticeType =>
  (BACKORDER_NOTICE_TYPES as readonly unknown[]).includes(value);

/** The outbox payload when it is a backorder notice, else `null`. */
export function asBackorderNotice(payload: unknown): BackorderNotice | null {
  const notice = payload as Partial<BackorderNotice> | null;
  if (!notice || !isBackorderNoticeType(notice.type)) return null;
  if (
    typeof notice.backorderId !== 'string' ||
    typeof notice.folio !== 'string' ||
    typeof notice.productName !== 'string' ||
    (notice.variantName !== null && typeof notice.variantName !== 'string') ||
    typeof notice.quantity !== 'number' ||
    typeof notice.dedupKey !== 'string' ||
    (notice.feedType !== undefined &&
      !(BACKORDER_UNDELIVERED_FEED_TYPES as readonly unknown[]).includes(
        notice.feedType,
      )) ||
    (notice.reason !== undefined && typeof notice.reason !== 'string')
  ) {
    throw new Error('malformed backorder notice payload');
  }
  return notice as BackorderNotice;
}

const TITLES: Record<BackorderNoticeType, string> = {
  BACKORDER_RESERVED: 'Pedido por reposición apartado',
  BACKORDER_EXPIRED: 'Apartado de pedido por reposición vencido',
  BACKORDER_NOTICE_UNDELIVERED:
    'No se pudo avisar al cliente de su pedido por reposición',
};

/** §5.2 `title` / `body` of the in-app notice; an odd payload reads as empty parts. */
export function backorderNoticeText(
  type: BackorderNoticeType,
  payload: Partial<BackorderNoticePayload>,
): { title: string; body: string } {
  const item =
    typeof payload.productName === 'string' &&
    typeof payload.quantity === 'number'
      ? `${payload.quantity} × ${payload.productName}${
          typeof payload.variantName === 'string'
            ? ` (${payload.variantName})`
            : ''
        }`
      : null;
  const parts = [
    typeof payload.folio === 'string' ? `Pedido ${payload.folio}` : null,
    item,
    type === BACKORDER_UNDELIVERED_NOTICE
      ? 'Llámale para que confirme antes de que venza el apartado'
      : null,
  ].filter((part): part is string => part !== null);
  return { title: TITLES[type], body: parts.join(' · ') };
}
