/**
 * Slice A.2 — CASL registry seeding for NotificationConfig.
 *
 * Guards that `(NotificationConfig, read)` and `(NotificationConfig, update)`
 * are present in the registry, mirroring the `SatKey` precedent. Without
 * these, the controller-level `@RequirePermissions([...])` decorators for
 * GET/PUT `/notification-config` will throw type errors (AppSubjects union
 * does not include `NotificationConfig`) AND the seeder will never create
 * DB `Permission` rows, so no role can ever grant access.
 *
 * This is a structural test (constants + types), so triangulation is the
 * array form (both actions + typed-subject coverage).
 */
import type { AppSubjects } from './permission';
import { PERMISSION_REGISTRY } from './permission';

describe('PERMISSION_REGISTRY — NotificationConfig (A.2)', () => {
  it("registers 'NotificationConfig' as an application subject", () => {
    const subject: AppSubjects = 'NotificationConfig';
    expect(subject).toBe('NotificationConfig');
  });

  it('registers read + update actions for NotificationConfig', () => {
    const actions = PERMISSION_REGISTRY.filter(
      (p) => p.subject === 'NotificationConfig',
    ).map((p) => p.action);

    expect(actions).toEqual(['read', 'update']);
  });

  it('does NOT register create/delete/manage for NotificationConfig in v1', () => {
    const actions = PERMISSION_REGISTRY.filter(
      (p) => p.subject === 'NotificationConfig',
    ).map((p) => p.action);

    // v1 only ships read+update; create/delete/manage are explicitly out.
    // If a future contributor adds them, they must also widen the spec.
    expect(actions).not.toContain('create');
    expect(actions).not.toContain('delete');
    expect(actions).not.toContain('manage');
  });
});
