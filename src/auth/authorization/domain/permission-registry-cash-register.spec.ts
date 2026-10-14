/**
 * cash-register-closing / T2 — CASL registry guard for the granular cash
 * permissions (S3).
 *
 * The registry is the single source of truth seeded on boot, and roles are
 * arbitrary compositions of these rows. There are therefore:
 *   - NO named-role checks and NO default role assignment in this task;
 *   - NO new action verbs: only the existing `AppActions` members are used;
 *   - NO blanket `manage` grant: each subject exposes exactly the granular
 *     action set the workflow needs, so a role can be composed per duty
 *     (register admin can differ from counter, verifier or closer).
 *   - NO broad `update:CashSession`: session lifecycle is driven by the
 *     granular subjects below.
 *
 * The registry values are read through a string-typed view so this spec can
 * fail on the missing rows before the implementation exists (RED) instead of
 * failing TypeScript compilation on the not-yet-extended `AppSubjects` union.
 */
import { PERMISSION_REGISTRY } from './permission';

type RegistryEntry = { subject: string; action: string; description: string };

const entries = PERMISSION_REGISTRY as readonly RegistryEntry[];

const EXPECTED: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['CashRegister', ['create', 'read', 'update']],
  ['CashSession', ['create', 'read']],
  ['CashCount', ['create']],
  ['CashIn', ['create']],
  ['CashOut', ['create']],
  ['CashVerification', ['create']],
  ['CashHandover', ['create', 'read', 'update']],
  ['CashClosing', ['create', 'read']],
  ['CashSessionAudit', ['read']],
];

const CASH_SUBJECTS = EXPECTED.map(([subject]) => subject);

const EXISTING_APP_ACTIONS = new Set([
  'create',
  'read',
  'update',
  'delete',
  'batch_delete',
  'manage',
]);

describe('PERMISSION_REGISTRY — cash-register-closing granular permissions (S3)', () => {
  it.each(EXPECTED)(
    'registers exactly the granular actions for %s',
    (subject, actions) => {
      const registered = entries
        .filter((entry) => entry.subject === subject)
        .map((entry) => entry.action);

      expect(registered).toEqual(actions);
    },
  );

  it('uses only existing AppActions and never invents count/verify/close verbs', () => {
    const cashEntries = entries.filter((entry) =>
      CASH_SUBJECTS.includes(entry.subject),
    );

    expect(cashEntries.length).toBeGreaterThan(0);
    for (const entry of cashEntries) {
      expect(EXISTING_APP_ACTIONS.has(entry.action)).toBe(true);
    }
  });

  it('never grants manage on a cash subject (granularity over catch-all)', () => {
    const managed = entries
      .filter((entry) => CASH_SUBJECTS.includes(entry.subject))
      .filter((entry) => entry.action === 'manage');

    expect(managed).toEqual([]);
  });

  it('never exposes a broad update on CashSession', () => {
    const sessionUpdates = entries.filter(
      (entry) => entry.subject === 'CashSession' && entry.action === 'update',
    );

    expect(sessionUpdates).toEqual([]);
  });

  it('gives every cash permission a non-empty description', () => {
    const cashEntries = entries.filter((entry) =>
      CASH_SUBJECTS.includes(entry.subject),
    );

    expect(cashEntries.length).toBeGreaterThan(0);
    for (const entry of cashEntries) {
      expect(typeof entry.description).toBe('string');
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });
});
