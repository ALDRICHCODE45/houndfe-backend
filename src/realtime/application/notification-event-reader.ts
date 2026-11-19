/**
 * What the realtime shaper reads about notifications (unit 8; contract §12.8),
 * in BATCHES: a batch of events costs one query for the notices and one for the
 * unread counts, however many people or events it holds. Both run inside the
 * tenant scope the shaper opened (the tenant comes from it, never from a
 * caller's argument).
 */
import type { NotificationView } from '../../notifications/application/notifications.service';

export interface NotificationEventReader {
  /**
   * The notices by id. Only a notice that exists AND belongs to the wanted
   * user is returned (a purged or foreign id is simply absent).
   */
  views(
    wanted: ReadonlyArray<{ userId: string; id: string }>,
  ): Promise<Map<string, NotificationView>>;
  /** Unread count per user; a user with none unread maps to 0. */
  unreadCounts(userIds: readonly string[]): Promise<Map<string, number>>;
}

export const REALTIME_NOTIFICATION_READER = Symbol(
  'REALTIME_NOTIFICATION_READER',
);
