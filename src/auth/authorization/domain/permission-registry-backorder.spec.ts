/**
 * restock-backorder / T5a (contract v1 §9) — CASL registry and seed pin for the
 * `Backorder` subject: `read` (list + detail, receives the staff notices) and
 * `update` (staff cancel). `manage` is never registered: in CASL it is a
 * wildcard, so only the super admin's `manage:all` implies it. Seeded defaults:
 * Manager read + update, Cashier read only.
 *
 * Seed side: `prisma/seed.ts` instantiates `PrismaClient` and calls `main()` at
 * module scope, so the grant arrays are pinned from the source TEXT (the
 * human-decisions precedent): it proves the static lists, not the upserts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AppSubjects } from './permission';
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

describe('PERMISSION_REGISTRY — Backorder (restock-backorder T5a)', () => {
  const rows = PERMISSION_REGISTRY.filter((p) => p.subject === 'Backorder');

  it("registers 'Backorder' as an application subject", () => {
    const subject: AppSubjects = 'Backorder';
    expect(subject).toBe('Backorder');
  });

  it('registers exactly read then update', () => {
    expect(rows.map((row) => row.action)).toEqual(['read', 'update']);
  });

  it('never registers create / delete / manage on Backorder', () => {
    const actions = rows.map((row) => row.action as string);
    for (const action of ['create', 'delete', 'batch_delete', 'manage']) {
      expect(actions).not.toContain(action);
    }
  });

  it('describes every Backorder permission', () => {
    for (const row of rows) {
      expect(row.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate subject/action pair in the whole registry', () => {
    const keys = PERMISSION_REGISTRY.map((p) => `${p.action}:${p.subject}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('prisma/seed.ts — Backorder role grants (restock-backorder T5a)', () => {
  const manager = seedKeys('managerPermissionKeys');
  const cashier = seedKeys('cashierPermissionKeys');

  it('extracts non-empty grant lists (anti-vacuous guard)', () => {
    expect(manager).toContain('Product:read');
    expect(cashier).toContain('Sale:create');
  });

  it('grants Manager read + update on Backorder', () => {
    expect(manager).toContain('Backorder:read');
    expect(manager).toContain('Backorder:update');
  });

  it('grants Cashier read ONLY on Backorder', () => {
    expect(cashier).toContain('Backorder:read');
    expect(cashier).not.toContain('Backorder:update');
  });

  it('never seeds a Backorder create / delete / manage grant', () => {
    for (const action of ['create', 'delete', 'batch_delete', 'manage']) {
      expect(seedText).not.toContain(`permissionKey('Backorder', '${action}')`);
    }
  });
});
