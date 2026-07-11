/**
 * DOMAIN VIEW: NotificationConfigView.
 *
 * Aggregate projection returned by the notification-config port. Decouples
 * the domain/service/controller layers from the persistence shape
 * (3 tables: settings + recipients + actions). Pure type — no framework
 * or Prisma deps. v1 ships `LOW_STOCK` only; the adapter rejects anything
 * outside `NOTIFICATION_ACTION_KEYS` with `UNKNOWN_ACTION_KEY` (HTTP 400).
 */
export type NotificationActionKey = 'LOW_STOCK';

export const NOTIFICATION_ACTION_KEYS: readonly NotificationActionKey[] = [
  'LOW_STOCK',
] as const;

export interface NotificationConfigView {
  enabled: boolean;
  recipients: string[];
  enabledActions: NotificationActionKey[];
}
