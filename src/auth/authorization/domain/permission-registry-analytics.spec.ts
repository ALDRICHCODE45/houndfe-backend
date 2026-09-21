/**
 * branch-analytics-summary / bas-1 — CASL registry check for the
 * `Analytics` subject (mirrors the `PaymentDetail` / `TenantCatalogSettings`
 * precedents).
 *
 * Guards that:
 *   - `Analytics` is in the `AppSubjects` union (otherwise
 *     `@RequirePermissions` decorators throw a TS error).
 *   - EXACTLY one row exists: `read:Analytics`.
 *   - `create` / `update` / `delete` / `batch_delete` / `manage` stay out.
 *   - No seeded tenant role array references `permissionKey('Analytics', ...)`,
 *     so the grant is never automatic (decision: no auto-grant to
 *     Manager/Cashier).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppSubjects } from './permission';
import { PERMISSION_REGISTRY } from './permission';

describe('PERMISSION_REGISTRY — Analytics (bas-1)', () => {
  const entries = () =>
    PERMISSION_REGISTRY.filter((p) => p.subject === 'Analytics');

  it("registers 'Analytics' as an application subject", () => {
    const subject: AppSubjects = 'Analytics';
    expect(subject).toBe('Analytics');
  });

  it('registers exactly the single read action', () => {
    expect(entries().map((p) => p.action)).toEqual(['read']);
  });

  it('carries a non-empty English description', () => {
    const analyticsEntries = entries();
    expect(analyticsEntries).toHaveLength(1);
    expect(analyticsEntries[0].description).toBe(
      'View tenant sales analytics summaries',
    );
  });

  it('does NOT register create / update / delete / batch_delete / manage', () => {
    const actions = entries().map((p) => p.action);
    for (const forbidden of [
      'create',
      'update',
      'delete',
      'batch_delete',
      'manage',
    ]) {
      expect(actions).not.toContain(forbidden);
    }
  });

  it('is not granted automatically to any seeded tenant role', () => {
    const seedSource = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'prisma', 'seed.ts'),
      'utf8',
    );

    expect(seedSource).not.toMatch(/permissionKey\(\s*'Analytics'/);
  });
});
