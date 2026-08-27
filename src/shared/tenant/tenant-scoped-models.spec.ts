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
 *
 * delivery-routes / WU1 — adds the two new bounded-context tables
 * (`DeliveryRoute`, `DeliveryRouteStop`) to the allowlist so the ADR-7
 * partial unique index `(tenantId, saleId) WHERE activeRouteId IS NOT NULL`
 * is reachable through the tenant-scoped Prisma client (defense in depth:
 * the Prisma adapter also passes `where: { id, tenantId }` explicitly).
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
    const overlaps = REQUIRED.filter((model) =>
      TENANT_SCOPED_MODELS.has(model),
    );
    expect(overlaps).toEqual([...REQUIRED]);
  });
});

describe('TENANT_SCOPED_MODELS — delivery-routes registration (WU1)', () => {
  const REQUIRED = ['DeliveryRoute', 'DeliveryRouteStop'] as const;

  it.each(REQUIRED)(
    'registers %s so tenant-scoped reads inject where.tenantId',
    (model) => {
      expect(TENANT_SCOPED_MODELS.has(model)).toBe(true);
    },
  );

  it('contains both required models', () => {
    const overlaps = REQUIRED.filter((model) =>
      TENANT_SCOPED_MODELS.has(model),
    );
    expect(overlaps).toEqual([...REQUIRED]);
  });
});
