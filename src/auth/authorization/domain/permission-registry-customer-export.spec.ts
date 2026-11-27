/**
 * customers-bulk-actions / T1 (S2, owner L3) — «exportar datos de clientes
 * debe ser un permiso nuevo especial»: `export:Customer`.
 *
 * - Registered in PERMISSION_REGISTRY, so `PermissionSeeder` upserts the row
 *   on every boot (existing environments get it with the deploy, no data
 *   migration — the Backorder / CashSessionAudit precedent) and Admin → Roles
 *   lists it as assignable (it reads the `permissions` table).
 * - `prisma/seed.ts` links every registry row to Super Admin; Manager and
 *   Cashier do NOT get it by default (a special grant, assigned by hand).
 *
 * Seed side: `prisma/seed.ts` runs `main()` at module scope, so the grant
 * arrays are pinned from the source TEXT (human-decisions precedent).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AppActions } from './permission';
import { PERMISSION_REGISTRY } from './permission';

const seedText = fs.readFileSync(
  path.join(process.cwd(), 'prisma', 'seed.ts'),
  'utf8',
);

function seedKeys(arrayName: string): string[] {
  const prefix = `const ${arrayName}: SeedPermissionKey[] = [`;
  const anchor = seedText.indexOf(prefix);
  if (anchor === -1) throw new Error(`Seed array "${arrayName}" not found`);
  const start = anchor + prefix.length;
  let depth = 1;
  let cursor = start;
  while (cursor < seedText.length && depth > 0) {
    if (seedText[cursor] === '[') depth += 1;
    else if (seedText[cursor] === ']') depth -= 1;
    cursor += 1;
  }
  const body = seedText.slice(start, cursor - 1);
  return [
    ...body.matchAll(/permissionKey\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g),
  ].map((match) => `${match[1]}:${match[2]}`);
}

describe('PERMISSION_REGISTRY — export:Customer (customers bulk export)', () => {
  it("'export' is an application action", () => {
    const action: AppActions = 'export';
    expect(action).toBe('export');
  });

  it('registers exactly one export row, on Customer, with a description', () => {
    const rows = PERMISSION_REGISTRY.filter((p) => p.action === 'export');
    expect(rows).toHaveLength(1);
    expect(rows[0].subject).toBe('Customer');
    expect(rows[0].description.length).toBeGreaterThan(0);
  });

  it('keeps the existing Customer rows', () => {
    const actions = PERMISSION_REGISTRY.filter(
      (p) => p.subject === 'Customer',
    ).map((p) => p.action);
    expect(actions).toEqual([
      'create',
      'read',
      'update',
      'delete',
      'manage',
      'export',
    ]);
  });

  it('is not a default grant of Manager or Cashier', () => {
    const manager = seedKeys('managerPermissionKeys');
    const cashier = seedKeys('cashierPermissionKeys');
    expect(manager.length).toBeGreaterThan(0);
    expect(cashier.length).toBeGreaterThan(0);
    expect(manager).not.toContain('Customer:export');
    expect(cashier).not.toContain('Customer:export');
  });

  it('Super Admin gets every registry row from the seed loop (so export:Customer too)', () => {
    expect(seedText).toMatch(
      /for \(const permission of permissions\.values\(\)\) \{[\s\S]*?roleId: superAdminRole\.id/,
    );
  });
});
