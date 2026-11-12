/**
 * DOMAIN: delivery status of an outgoing mirrored message (human-intervention
 * unit 9; contract §6.2, §12.5). A status only moves forward:
 *
 *   QUEUED -> [DEFERRED ->] SENT -> DELIVERED -> READ
 *
 * with FAILED and UNKNOWN reachable from any state before delivery (a message
 * that was delivered cannot fail afterwards), and nothing leaving FAILED,
 * UNKNOWN or READ. Meta's statuses arrive out of order and repeated, so an
 * older or equal one is simply not applied.
 *
 * The same rule lives in the database trigger of migration
 * 20261112020000_conversation_mirror (`conversation_delivery_can_advance`);
 * `conversation-mirror.integration.spec.ts` compares both for every pair.
 */
export const DELIVERY_STATUSES = [
  'QUEUED',
  'DEFERRED',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
  'UNKNOWN',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

const RANK: Partial<Record<string, number>> = {
  QUEUED: 0,
  DEFERRED: 1,
  SENT: 2,
  DELIVERED: 3,
  READ: 4,
};

export function canAdvanceDeliveryStatus(
  from: string | null,
  to: string,
): boolean {
  if (from === null) return false;
  const fromRank = RANK[from];
  // FAILED, UNKNOWN (and anything unexpected) never move again.
  if (fromRank === undefined) return false;
  if (to === 'FAILED' || to === 'UNKNOWN') return fromRank <= RANK.SENT!;
  const toRank = RANK[to];
  return toRank !== undefined && toRank > fromRank;
}

/**
 * What a message starts with. A bot message is mirrored after the bot sent it,
 * so it is already `SENT`; a staff message is born `QUEUED` (unit 11); the
 * customer's and the timeline marks have no delivery.
 */
export function initialDeliveryStatus(
  direction: 'IN' | 'OUT',
  author: 'CUSTOMER' | 'BOT' | 'STAFF' | 'SYSTEM',
): DeliveryStatus | null {
  if (direction === 'IN') return null;
  if (author === 'BOT') return 'SENT';
  if (author === 'STAFF') return 'QUEUED';
  return null;
}
