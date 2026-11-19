// Offline: `node --test scripts/ops/grant-chatbot-request-permissions.test.cjs`
// (pure planning part: which RolePermission rows each tenant's Manager and
// Cashier roles are missing; no DB).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ROLE_GRANTS,
  planGrants,
} = require('./grant-chatbot-request-permissions.cjs');

const ALL = [
  ...ROLE_GRANTS.Manager,
  { subject: 'ChatbotSettingsAllBranches', action: 'update' },
];
const permissions = ALL.map((p) => ({
  id: `perm-${p.subject}-${p.action}`,
  subject: p.subject,
  action: p.action,
}));
const idOf = (subject, action) => `perm-${subject}-${action}`;

const tenant = (slug, roles) => ({ id: `t-${slug}`, slug, roles });
const role = (name, heldIds = []) => ({
  id: `r-${name}`,
  name,
  permissionIds: heldIds,
});

test('plans every grant for a tenant whose roles hold none', () => {
  const plan = planGrants({
    tenants: [tenant('centro', [role('Manager'), role('Cashier')])],
    permissions,
  });

  assert.equal(plan.tenants.length, 1);
  const [{ roles }] = plan.tenants;
  const manager = roles.find((r) => r.role === 'Manager');
  const cashier = roles.find((r) => r.role === 'Cashier');
  assert.equal(manager.add.length, 8);
  assert.deepEqual(manager.alreadyHeld, []);
  assert.ok(
    !manager.add.some((g) => g.subject === 'ChatbotSettingsAllBranches'),
  );
  assert.deepEqual(cashier.add.map((g) => `${g.subject}:${g.action}`).sort(), [
    'ChatbotConversation:read',
    'ChatbotRequest:read',
    'ChatbotRequest:update',
  ]);
  assert.deepEqual(cashier.add.map((g) => g.permissionId).sort(), [
    idOf('ChatbotConversation', 'read'),
    idOf('ChatbotRequest', 'read'),
    idOf('ChatbotRequest', 'update'),
  ]);
  assert.equal(plan.totalToAdd, 11);
});

test('is idempotent: rows a role already holds are reported, not re-added', () => {
  const held = ROLE_GRANTS.Cashier.map((g) => idOf(g.subject, g.action));
  const plan = planGrants({
    tenants: [
      tenant('norte', [
        role('Manager', [idOf('ChatbotRequest', 'read')]),
        role('Cashier', held),
      ]),
    ],
    permissions,
  });

  const [{ roles }] = plan.tenants;
  const manager = roles.find((r) => r.role === 'Manager');
  const cashier = roles.find((r) => r.role === 'Cashier');
  assert.equal(manager.add.length, 7);
  assert.deepEqual(
    manager.alreadyHeld.map((g) => `${g.subject}:${g.action}`),
    ['ChatbotRequest:read'],
  );
  assert.deepEqual(cashier.add, []);
  assert.equal(cashier.alreadyHeld.length, 3);
  assert.equal(plan.totalToAdd, 7);
});

test('reports a missing Manager or Cashier role instead of inventing one', () => {
  const plan = planGrants({
    tenants: [tenant('sur', [role('Manager'), role('Driver')])],
    permissions,
  });

  const [entry] = plan.tenants;
  assert.deepEqual(entry.missingRoles, ['Cashier']);
  assert.deepEqual(
    entry.roles.map((r) => r.role),
    ['Manager'],
  );
  assert.equal(plan.totalToAdd, 8);
});

test('fails closed when a permission row is not seeded yet', () => {
  assert.throws(
    () =>
      planGrants({
        tenants: [tenant('centro', [role('Manager'), role('Cashier')])],
        permissions: permissions.filter((p) => p.subject !== 'CustomerPhone'),
      }),
    (err) =>
      err.code === 'PERMISSION_MISSING' &&
      /CustomerPhone:read/.test(err.message),
  );
});

test('never plans manage nor update:ChatbotSettingsAllBranches', () => {
  for (const grants of Object.values(ROLE_GRANTS)) {
    for (const g of grants) {
      assert.notEqual(g.action, 'manage');
      assert.notEqual(g.subject, 'ChatbotSettingsAllBranches');
    }
  }
});

test('parseArgs: dry run by default, --apply writes, --tenant filters', () => {
  const { parseArgs } = require('./grant-chatbot-request-permissions.cjs');
  assert.deepEqual(parseArgs([]), { apply: false, help: false, tenant: null });
  assert.deepEqual(parseArgs(['--apply', '--tenant', 'centro']), {
    apply: true,
    help: false,
    tenant: 'centro',
  });
  assert.throws(
    () => parseArgs(['--nope']),
    (err) => err.code === 'BAD_ARGS',
  );
});
