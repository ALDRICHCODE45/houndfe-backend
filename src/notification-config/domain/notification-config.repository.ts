/**
 * PORT: INotificationConfigRepository (Driven Port).
 *
 * Contract that the notification-config domain DEMANDS for persistence.
 * Mirrors `src/sat-catalog/domain/sat-key.repository.ts` and the
 * employee port. Tenant scoping is handled by the adapter via the
 * tenant-scoped Prisma client extension (A.1).
 *
 * Spec coverage (notification-config/spec.md):
 *   - "Existing config returned verbatim"     → find()
 *   - "Unconfigured tenant returns safe defaults" → find() empty view
 *   - "Tenant isolation on read"              → adapter's tenant-scoped client
 *   - "Full overwrite succeeds"               → replace() (Prisma tx)
 *   - "Unknown action key rejected"           → replace() throws BadRequestException(UNKNOWN_ACTION_KEY)
 */
import type {
  NotificationActionKey,
  NotificationConfigView,
} from './notification-config';

export interface INotificationConfigRepository {
  /**
   * Read the current tenant's notification config. Returns the safe empty
   * defaults (`{ enabled: false, recipients: [], enabledActions: [] }`)
   * when the tenant has no `NotificationSettings` row.
   */
  find(): Promise<NotificationConfigView>;

  /**
   * Overwrite the calling tenant's notification config atomically.
   * Throws `BadRequestException({ error: 'UNKNOWN_ACTION_KEY', ... })`
   * when `input.enabledActions` contains a key outside the v1 recognized
   * set — the transaction MUST NOT be started until validation passes
   * (spec: "no rows are written").
   */
  replace(input: {
    enabled: boolean;
    recipientUserIds: string[];
    enabledActions: NotificationActionKey[];
  }): Promise<NotificationConfigView>;
}

/**
 * NestJS injection token. `Symbol.for(...)` so identical tokens are
 * deduped across module instances (matches the receipt-review port).
 */
export const NOTIFICATION_CONFIG_REPOSITORY = Symbol.for(
  'NotificationConfigRepository',
);
