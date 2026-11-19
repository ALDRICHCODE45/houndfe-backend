/**
 * human-intervention / T1 (S6, L2) — DB-free pin for the default
 * chatbot-request grants.
 *
 * Owner choice L2: Manager gets every §2.5 permission except
 * `update:ChatbotSettingsAllBranches`; Cashier gets read + update on
 * `ChatbotRequest` and read on `ChatbotConversation`; Super Admin keeps
 * `manage:all` only. The same lists drive
 * `scripts/ops/grant-chatbot-request-permissions.cjs` for databases whose
 * roles already exist, so this spec also pins the script to the seed.
 *
 * `prisma/seed.ts` runs `main()` at module scope, so its grant arrays are
 * read from the source TEXT (same bounded pin as
 * `human-decisions-permissions.spec.ts`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PERMISSION_REGISTRY } from '../src/auth/authorization/domain/permission';

// The ops script is plain CommonJS run by node in the container.
const grantScript =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../scripts/ops/grant-chatbot-request-permissions.cjs') as {
    ROLE_GRANTS: Record<string, { subject: string; action: string }[]>;
  };

const seedText = fs.readFileSync(
  path.join(process.cwd(), 'prisma', 'seed.ts'),
  'utf8',
);

const CHATBOT_SUBJECTS = new Set([
  'ChatbotRequest',
  'ChatbotRequestAssignment',
  'ChatbotConversation',
  'ChatbotEscalation',
  'CustomerPhone',
  'ChatbotSettings',
  'ChatbotSettingsAllBranches',
]);

function seedArrayKeys(arrayName: string): string[] {
  const prefix = `const ${arrayName}: SeedPermissionKey[] = [`;
  const start = seedText.indexOf(prefix);
  if (start === -1) throw new Error(`Seed array "${arrayName}" not found`);
  const end = seedText.indexOf('];', start);
  const body = seedText.slice(start + prefix.length, end);
  return [...body.matchAll(/permissionKey\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g)]
    .map((match) => `${match[1]}:${match[2]}`)
    .filter((key) => CHATBOT_SUBJECTS.has(key.split(':')[0]));
}

const sorted = (keys: string[]) => [...keys].sort();

const registryKeys = PERMISSION_REGISTRY.filter((p) =>
  CHATBOT_SUBJECTS.has(p.subject),
).map((p) => `${p.subject}:${p.action}`);

const MANAGER = sorted(
  registryKeys.filter((key) => key !== 'ChatbotSettingsAllBranches:update'),
);
const CASHIER = sorted([
  'ChatbotRequest:read',
  'ChatbotRequest:update',
  'ChatbotConversation:read',
]);

describe('prisma/seed.ts — chatbot-request default grants (S6, L2)', () => {
  it('reads the 9 §2.5 rows from the registry (anti-vacuous guard)', () => {
    expect(registryKeys).toHaveLength(9);
    expect(MANAGER).toHaveLength(8);
  });

  it('grants Manager every chatbot permission except update:ChatbotSettingsAllBranches', () => {
    expect(sorted(seedArrayKeys('managerPermissionKeys'))).toEqual(MANAGER);
  });

  it('grants Cashier exactly read/update:ChatbotRequest and read:ChatbotConversation', () => {
    expect(sorted(seedArrayKeys('cashierPermissionKeys'))).toEqual(CASHIER);
  });

  it('never seeds manage on a chatbot subject', () => {
    for (const subject of CHATBOT_SUBJECTS) {
      expect(seedText).not.toContain(`permissionKey('${subject}', 'manage')`);
    }
  });
});

describe('grant-chatbot-request-permissions.cjs — same grants as the seed', () => {
  const scriptKeys = (role: string) =>
    sorted(
      (grantScript.ROLE_GRANTS[role] ?? []).map(
        (g) => `${g.subject}:${g.action}`,
      ),
    );

  it('targets only the Manager and Cashier roles', () => {
    expect(Object.keys(grantScript.ROLE_GRANTS).sort()).toEqual([
      'Cashier',
      'Manager',
    ]);
  });

  it('grants Manager the seed list', () => {
    expect(scriptKeys('Manager')).toEqual(MANAGER);
  });

  it('grants Cashier the seed list', () => {
    expect(scriptKeys('Cashier')).toEqual(CASHIER);
  });
});
