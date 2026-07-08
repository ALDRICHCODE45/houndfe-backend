/**
 * Tenant scoping is ALLOWLIST-BASED and FAILS OPEN.
 *
 * `createTenantScopedPrisma` (`tenant-prisma.factory.ts:28`) skips the
 * `tenantId` where-injection for any model NOT in `TENANT_SCOPED_MODELS`.
 * The four new low-stock-alerts models MUST be registered, otherwise every
 * normal-client read leaks across tenants (finding #1, BLOCKER).
 *
 * This spec guards that registration. If a future contributor removes a model
 * from the allowlist, this spec MUST fail.
 */
import { TENANT_SCOPED_MODELS } from './tenant-scoped-models.constant';

describe('TENANT_SCOPED_MODELS — low-stock-alerts registration (A.1)', () => {
  const REQUIRED = [
    'NotificationSettings',
    'NotificationRecipient',
    'NotificationAction',
    'StockAlertState',
  ] as const;

  it.each(REQUIRED)(
    'registers %s so tenant-scoped reads inject where.tenantId',
    (model) => {
      expect(TENANT_SCOPED_MODELS.has(model)).toBe(true);
    },
  );

  it('contains all four required models exactly once', () => {
    const overlaps = REQUIRED.filter((model) => TENANT_SCOPED_MODELS.has(model));
    expect(overlaps).toEqual([...REQUIRED]);
  });
});
