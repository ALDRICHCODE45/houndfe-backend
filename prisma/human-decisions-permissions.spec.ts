/**
 * human-decisions-restock-v1 / HD-04a — DB-free pin for the human-decision
 * reviewer RBAC surface.
 *
 * Registry side: `src/auth/authorization/domain/permission.ts` is a pure
 * module and is imported directly.
 *
 * Seed side: `prisma/seed.ts` instantiates `PrismaClient`, imports bcrypt and
 * calls `main()` at module scope, so importing it would execute the seeder
 * (DB + env side effects). The role-grant arrays are therefore pinned
 * structurally from the seed source TEXT.
 *
 * LIMITATION (bounded source-text pin): this proves the static grant lists and
 * the per-tenant loop wiring inside one file. It does NOT prove that the
 * upserts run, are idempotent, or land in PostgreSQL — that stays an
 * integration concern, never asserted here.
 *
 * Least privilege (owner decision): Manager read+update, Cashier read-only,
 * Super Admin keeps the global `manage:all`. Bot intake owns `create`, so
 * `create`/`delete`/`manage` must stay out of the reviewer registry surface.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AppSubjects } from '../src/auth/authorization/domain/permission';
import { PERMISSION_REGISTRY } from '../src/auth/authorization/domain/permission';

const SEED_PATH = path.join(process.cwd(), 'prisma', 'seed.ts');
const seedText = fs.readFileSync(SEED_PATH, 'utf8');

/**
 * Extracts the full source text of `const <name>: SeedPermissionKey[] = [ ... ]`
 * by bracket matching, so a later array or an unrelated `]` cannot bleed in.
 */
function extractSeedArray(arrayName: string): string {
  const prefix = `const ${arrayName}: SeedPermissionKey[] = [`;
  const anchorIndex = seedText.indexOf(prefix);
  if (anchorIndex === -1) {
    throw new Error(`Seed array "${arrayName}" not found in prisma/seed.ts`);
  }

  const start = anchorIndex + prefix.length;
  let depth = 1;
  let cursor = start;
  while (cursor < seedText.length && depth > 0) {
    const char = seedText[cursor];
    if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
    }
    cursor += 1;
  }

  if (depth !== 0) {
    throw new Error(`Seed array "${arrayName}" is unterminated`);
  }

  return seedText.slice(start, cursor - 1);
}

function extractPermissionKeys(arrayText: string): string[] {
  const pattern = /permissionKey\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g;
  const keys: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(arrayText)) !== null) {
    keys.push(`${match[1]}:${match[2]}`);
  }
  return keys;
}

function countOccurrences(value: string): number {
  return seedText.split(value).length - 1;
}

describe('PERMISSION_REGISTRY — HumanDecision (HD-04a)', () => {
  it("registers 'HumanDecision' as an application subject", () => {
    const subject: AppSubjects = 'HumanDecision';
    expect(subject).toBe('HumanDecision');
  });

  it("registers exactly the ['read', 'update'] actions for HumanDecision", () => {
    const actions = PERMISSION_REGISTRY.filter(
      (p) => p.subject === 'HumanDecision',
    ).map((p) => p.action);

    expect(actions).toEqual(['read', 'update']);
  });

  it('gives every HumanDecision permission a non-empty description', () => {
    const entries = PERMISSION_REGISTRY.filter(
      (p) => p.subject === 'HumanDecision',
    );

    expect(entries).toHaveLength(2);

    for (const entry of entries) {
      expect(typeof entry.description).toBe('string');
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('does NOT register create / delete / batch_delete / manage', () => {
    const actions = PERMISSION_REGISTRY.filter(
      (p) => p.subject === 'HumanDecision',
    ).map((p) => p.action);

    expect(actions).not.toEqual(
      expect.arrayContaining(['create', 'delete', 'batch_delete', 'manage']),
    );
  });
});

describe('prisma/seed.ts — HumanDecision role grants (HD-04a)', () => {
  const managerKeys = extractPermissionKeys(
    extractSeedArray('managerPermissionKeys'),
  );
  const cashierKeys = extractPermissionKeys(
    extractSeedArray('cashierPermissionKeys'),
  );

  it('extracts non-empty Manager and Cashier grant lists (anti-vacuous guard)', () => {
    expect(managerKeys.length).toBeGreaterThan(0);
    expect(cashierKeys.length).toBeGreaterThan(0);
    expect(managerKeys).toContain('Product:read');
    expect(cashierKeys).toContain('Sale:create');
  });

  it('grants Manager read + update on HumanDecision', () => {
    expect(managerKeys).toContain('HumanDecision:read');
    expect(managerKeys).toContain('HumanDecision:update');
  });

  it('grants Cashier read ONLY on HumanDecision (no update)', () => {
    expect(cashierKeys).toContain('HumanDecision:read');
    expect(cashierKeys).not.toContain('HumanDecision:update');
  });

  it('never seeds a HumanDecision create / delete / manage grant', () => {
    for (const action of [
      'create',
      'delete',
      'batch_delete',
      'manage',
    ] as const) {
      expect(seedText).not.toContain(
        `permissionKey('HumanDecision', '${action}')`,
      );
    }
  });

  it('applies each grant list to every tenant role of that kind', () => {
    expect(
      countOccurrences(
        'for (const managerRole of managerRoleByTenant.values())',
      ),
    ).toBe(1);
    expect(
      countOccurrences(
        'for (const cashierRole of cashierRoleByTenant.values())',
      ),
    ).toBe(1);
    expect(seedText).toContain('for (const tenant of tenants.values()) {');
    expect(seedText).toContain(
      'managerRoleByTenant.set(tenant.slug, managerRole);',
    );
    expect(seedText).toContain(
      'cashierRoleByTenant.set(tenant.slug, cashierRole);',
    );
  });
});
