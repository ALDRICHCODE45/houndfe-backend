/**
 * shipping-zones / T1 — CASL registry + seed defaults for `DeliveryZone`.
 *
 * Pins exactly `read`, `manage` and the new `validate` verb, and the seeded
 * defaults: Manager gets all three, Cashier gets none. Super Admin keeps the
 * global `manage:all`, which CASL treats as a wildcard over `validate` too.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMongoAbility } from '@casl/ability';
import type { AppActions, AppSubjects } from './permission';
import { PERMISSION_REGISTRY } from './permission';

const seedSource = readFileSync(
  join(__dirname, '..', '..', '..', '..', 'prisma', 'seed.ts'),
  'utf8',
);

function seedArray(name: string): string {
  const start = seedSource.indexOf(`const ${name}: SeedPermissionKey[] = [`);
  if (start === -1) throw new Error(`missing ${name}`);
  return seedSource.slice(start, seedSource.indexOf('];', start));
}

describe('PERMISSION_REGISTRY — DeliveryZone (shipping-zones T1)', () => {
  it('registers the DeliveryZone subject and the validate action', () => {
    const subject: AppSubjects = 'DeliveryZone';
    const action: AppActions = 'validate';
    expect([subject, action]).toEqual(['DeliveryZone', 'validate']);
  });

  it('registers exactly read, manage and validate with descriptions', () => {
    const entries = PERMISSION_REGISTRY.filter(
      (p) => p.subject === 'DeliveryZone',
    );
    expect(entries.map((p) => p.action)).toEqual([
      'read',
      'manage',
      'validate',
    ]);
    for (const entry of entries) {
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('seeds Manager with read, validate and manage, and Cashier with none', () => {
    const manager = seedArray('managerPermissionKeys');
    expect(manager).toContain("permissionKey('DeliveryZone', 'read')");
    expect(manager).toContain("permissionKey('DeliveryZone', 'validate')");
    expect(manager).toContain("permissionKey('DeliveryZone', 'manage')");
    expect(seedArray('cashierPermissionKeys')).not.toContain(
      "permissionKey('DeliveryZone'",
    );
  });

  it('treats manage:DeliveryZone and manage:all as granting validate', () => {
    const manager = createMongoAbility([
      { action: 'manage', subject: 'DeliveryZone' },
    ]);
    const admin = createMongoAbility([{ action: 'manage', subject: 'all' }]);
    const reader = createMongoAbility([
      { action: 'read', subject: 'DeliveryZone' },
    ]);
    expect(manager.can('validate', 'DeliveryZone')).toBe(true);
    expect(admin.can('validate', 'DeliveryZone')).toBe(true);
    expect(reader.can('validate', 'DeliveryZone')).toBe(false);
  });
});
