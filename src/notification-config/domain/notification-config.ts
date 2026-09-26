/**
 * DOMAIN VIEW: NotificationConfigView.
 *
 * Aggregate projection returned by the notification-config port. Decouples
 * the domain/service/controller layers from the persistence shape
 * (3 tables: settings + recipients + actions). Pure type — no framework
 * or Prisma deps. v1 ships `LOW_STOCK` only; the adapter rejects anything
 * outside `NOTIFICATION_ACTION_KEYS` with `UNKNOWN_ACTION_KEY` (HTTP 400).
 * delivery-routes / WU1 adds `DELIVERY_NEXT_STOP` (next-stop arriving-soon
 * email from the route check-in pipeline).
 *
 * promotion-capacity-alerts / pca-3a (action registry) adds the two flat
 * promotion alert actions. Both are ordinary enum members — the `Promociones`
 * grouping is frontend-only — and no rows are seeded, so both stay disabled
 * until a tenant opts in through `replace()`.
 *
 * delivery-thank-you-email / DTE-1 adds `DELIVERY_THANK_YOU`, a sixth flat
 * registry member for the customer-facing thank-you email produced after a
 * successful delivery-route check-in. It is registered here so a tenant can
 * opt in through `replace()`, but no producer, sender, or event exists yet:
 * the key ships dormant, stays disabled for every tenant (no seed rows), and
 * `NotificationConfig.recipients` remains the STAFF list — it is never the
 * customer address for this action.
 */
export type NotificationActionKey =
  | 'LOW_STOCK'
  | 'TIME_OFF_REQUESTED'
  | 'DELIVERY_NEXT_STOP'
  | 'PROMOTION_EXPIRING'
  | 'PROMOTION_NEAR_CAPACITY'
  | 'DELIVERY_THANK_YOU';

export const NOTIFICATION_ACTION_KEYS: readonly NotificationActionKey[] = [
  'LOW_STOCK',
  'TIME_OFF_REQUESTED',
  'DELIVERY_NEXT_STOP',
  'PROMOTION_EXPIRING',
  'PROMOTION_NEAR_CAPACITY',
  'DELIVERY_THANK_YOU',
] as const;

export interface NotificationConfigView {
  enabled: boolean;
  recipients: string[];
  enabledActions: NotificationActionKey[];
}
