/**
 * PORT CONTRACT SPEC — INotificationConfigRepository (B.1).
 *
 * Mirrors `src/sales/review/domain/receipt-review.repository.spec.ts`:
 * a structural assertion that the port defines the contract domain code
 * is allowed to depend on. Adapter behavior (empty defaults, full
 * overwrite, UNKNOWN_ACTION_KEY rejection) is exercised in B.2.
 */
import {
  NOTIFICATION_CONFIG_REPOSITORY,
  type INotificationConfigRepository,
} from './notification-config.repository';

describe('NotificationConfigRepository port (B.1)', () => {
  it('exports a stable NestJS injection token', () => {
    expect(NOTIFICATION_CONFIG_REPOSITORY).toEqual(
      Symbol.for('NotificationConfigRepository'),
    );
  });

  it('defines the per-tenant notification config data-access contract', () => {
    const repository: INotificationConfigRepository = {
      find: jest.fn(),
      replace: jest.fn(),
    };
    expect(typeof repository.find).toBe('function');
    expect(typeof repository.replace).toBe('function');
  });
});
