/**
 * online-catalog-publishing / WU3 — CASL registry check for the
 * `TenantCatalogSettings` subject (mirrors the `PaymentDetail` precedent in
 * `permission-registry-payment-detail.spec.ts`).
 *
 * Guards that:
 *   - `TenantCatalogSettings` is in the `AppSubjects` union (otherwise
 *     `@RequirePermissions` decorators throw a TS error).
 *   - EXACTLY two rows exist: `read` and `update` (design ADR-5).
 *   - `create` / `delete` / `manage` / `batch_delete` stay out, so
 *     `manage:all` remains the only implicit authorization path.
 */
import type { AppSubjects } from './permission';
import { PERMISSION_REGISTRY } from './permission';

describe('PERMISSION_REGISTRY — TenantCatalogSettings (WU3)', () => {
  const entries = () =>
    PERMISSION_REGISTRY.filter((p) => p.subject === 'TenantCatalogSettings');

  it("registers 'TenantCatalogSettings' as an application subject", () => {
    const subject: AppSubjects = 'TenantCatalogSettings';
    expect(subject).toBe('TenantCatalogSettings');
  });

  it('registers exactly read and update for TenantCatalogSettings', () => {
    const actions = entries()
      .map((p) => p.action)
      .sort();

    expect(actions).toEqual(['read', 'update']);
  });

  it('does NOT register create, delete, manage or batch_delete', () => {
    const actions = entries().map((p) => p.action);

    for (const forbidden of ['create', 'delete', 'manage', 'batch_delete']) {
      expect(actions).not.toContain(forbidden);
    }
  });

  it('carries the approved descriptions for both rows', () => {
    expect(entries()).toEqual([
      {
        subject: 'TenantCatalogSettings',
        action: 'read',
        description: 'View tenant online catalog publication settings',
      },
      {
        subject: 'TenantCatalogSettings',
        action: 'update',
        description: 'Publish or update tenant online catalog settings',
      },
    ]);
  });
});
