/**
 * human-intervention / T1 — CASL registry pin for the chatbot-request
 * permissions (contract v1 §2.5).
 *
 * The contract reuses the existing `AppActions` verbs on new subjects (the
 * cash-register precedent) instead of widening the action list, because the
 * frontend mirrors that list in `ability.ts`. `manage` is never registered on
 * these subjects: in CASL it is a wildcard, so only the super admin's
 * `manage:all` may imply them.
 *
 * Registry values are read through a string-typed view so the spec fails on
 * the missing rows (RED) instead of on the not-yet-extended `AppSubjects`.
 */
import type { PrismaService } from '../../../shared/prisma/prisma.service';
import { PermissionSeeder } from '../infrastructure/permission.seeder';
import { PERMISSION_REGISTRY } from './permission';

type RegistryEntry = { subject: string; action: string; description: string };

const entries = PERMISSION_REGISTRY as readonly RegistryEntry[];

const EXPECTED: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['ChatbotRequest', ['read', 'update']],
  ['ChatbotRequestAssignment', ['update']],
  ['ChatbotConversation', ['read']],
  ['ChatbotEscalation', ['read']],
  ['CustomerPhone', ['read']],
  ['ChatbotSettings', ['read', 'update']],
  ['ChatbotSettingsAllBranches', ['update']],
];

const CHATBOT_SUBJECTS = EXPECTED.map(([subject]) => subject);

const chatbotEntries = () =>
  entries.filter((entry) => CHATBOT_SUBJECTS.includes(entry.subject));

describe('PERMISSION_REGISTRY — chatbot-request permissions (§2.5)', () => {
  it.each(EXPECTED)(
    'registers exactly the §2.5 actions for %s',
    (subject, actions) => {
      const registered = entries
        .filter((entry) => entry.subject === subject)
        .map((entry) => entry.action);

      expect(registered).toEqual(actions);
    },
  );

  it('registers exactly the 9 §2.5 rows and never manage on these subjects', () => {
    const keys = chatbotEntries().map((e) => `${e.action}:${e.subject}`);

    expect(keys).toHaveLength(9);
    expect(new Set(keys).size).toBe(9);
    expect(chatbotEntries().filter((e) => e.action === 'manage')).toEqual([]);
  });

  it('uses only read/update (no new AppActions verb)', () => {
    for (const entry of chatbotEntries()) {
      expect(['read', 'update']).toContain(entry.action);
    }
  });

  it('gives every chatbot-request permission a non-empty description', () => {
    for (const entry of chatbotEntries()) {
      expect(entry.description.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('PermissionSeeder — chatbot-request permissions on boot', () => {
  it('upserts every §2.5 row and links none of them to a role', async () => {
    const upserted: string[] = [];
    const prisma = {
      permission: {
        upsert: jest.fn(
          (args: {
            where: { subject_action: { subject: string; action: string } };
          }) => {
            const { subject, action } = args.where.subject_action;
            upserted.push(`${action}:${subject}`);
            return { id: `perm-${subject}-${action}`, subject, action };
          },
        ),
      },
      role: {
        findFirst: jest.fn(() => null),
        create: jest.fn(() => ({ id: 'role-super-admin' })),
      },
      rolePermission: { upsert: jest.fn() },
    } as unknown as PrismaService;

    await new PermissionSeeder(prisma).onApplicationBootstrap();

    const expected = EXPECTED.flatMap(([subject, actions]) =>
      actions.map((action) => `${action}:${subject}`),
    );
    expect(upserted).toEqual(expect.arrayContaining(expected));

    const linked = (prisma.rolePermission.upsert as jest.Mock).mock.calls.map(
      (call: [{ create: { permissionId: string } }]) =>
        call[0].create.permissionId,
    );
    expect(linked).toEqual(['perm-all-manage']);
  });
});
