/**
 * shipping-zones / T2 — CASL registry check for the `ShippingSettings`
 * subject (standard boxes + shipping origin per sucursal).
 *
 * Exactly `read` + `update`, mirroring `TenantCatalogSettings`: `update`
 * covers creating, editing and deleting boxes and replacing the origin.
 * Seed grants (Manager read+update, Cashier none) are pinned from the
 * `prisma/seed.ts` source text, like `prisma/human-decisions-permissions.spec.ts`
 * (importing the seed would execute it).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AppSubjects } from './permission';
import { PERMISSION_REGISTRY } from './permission';

describe('PERMISSION_REGISTRY — ShippingSettings (shipping T2)', () => {
  const entries = () =>
    PERMISSION_REGISTRY.filter((p) => p.subject === 'ShippingSettings');

  it("registers 'ShippingSettings' as an application subject", () => {
    const subject: AppSubjects = 'ShippingSettings';
    expect(subject).toBe('ShippingSettings');
  });

  it('registers exactly read and update with descriptions', () => {
    expect(entries()).toEqual([
      {
        subject: 'ShippingSettings',
        action: 'read',
        description: 'View standard shipping boxes and the shipping origin',
      },
      {
        subject: 'ShippingSettings',
        action: 'update',
        description: 'Manage standard shipping boxes and the shipping origin',
      },
    ]);
  });
});

describe('prisma/seed.ts — ShippingSettings role grants (shipping T2)', () => {
  const seedText = fs.readFileSync(
    path.join(process.cwd(), 'prisma', 'seed.ts'),
    'utf8',
  );
  const keysOf = (arrayName: string): string[] => {
    const prefix = `const ${arrayName}: SeedPermissionKey[] = [`;
    const start = seedText.indexOf(prefix);
    expect(start).toBeGreaterThan(-1);
    const body = seedText.slice(
      start + prefix.length,
      seedText.indexOf('];', start),
    );
    return [...body.matchAll(/permissionKey\('([^']+)', '([^']+)'\)/g)].map(
      (m) => `${m[1]}:${m[2]}`,
    );
  };

  it('grants Manager read + update on ShippingSettings', () => {
    const manager = keysOf('managerPermissionKeys');
    expect(manager).toContain('Product:read');
    expect(manager).toContain('ShippingSettings:read');
    expect(manager).toContain('ShippingSettings:update');
  });

  it('grants Cashier nothing on ShippingSettings', () => {
    const cashier = keysOf('cashierPermissionKeys');
    expect(cashier).toContain('Sale:create');
    expect(cashier.filter((k) => k.startsWith('ShippingSettings:'))).toEqual(
      [],
    );
  });
});
