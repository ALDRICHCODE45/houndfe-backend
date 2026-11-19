// Ops › grant chatbot-request permissions: gives each tenant's existing
// Manager and Cashier roles the default chatbot-request permissions of
// contract v1 §2.5 (owner choice L2), for databases whose roles were created
// before those permissions existed. prisma/seed.ts grants the same lists to
// fresh databases (prisma/chatbot-requests-permissions.spec.ts pins both).
//
//   Manager — every chatbot-request permission except
//             update:ChatbotSettingsAllBranches
//   Cashier — read:ChatbotRequest, update:ChatbotRequest,
//             read:ChatbotConversation
//
// Super Admin keeps manage:all and is not touched. Roles are matched by name
// per tenant; a tenant without one of them is reported, never created.
//
// Run from the app root (the directory holding node_modules/ and prisma/,
// /app inside the container) AFTER the API has booted once with this release:
// the PermissionSeeder upserts the Permission rows on boot, and this script
// fails closed if one is missing. Without --apply it only reads and prints the
// plan. With --apply it upserts RolePermission rows (idempotent, no deletes).
//
//   node scripts/ops/grant-chatbot-request-permissions.cjs [--tenant <slug>] [--apply]
'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');

const ROLE_GRANTS = {
  Manager: [
    { subject: 'ChatbotRequest', action: 'read' },
    { subject: 'ChatbotRequest', action: 'update' },
    { subject: 'ChatbotRequestAssignment', action: 'update' },
    { subject: 'ChatbotConversation', action: 'read' },
    { subject: 'ChatbotEscalation', action: 'read' },
    { subject: 'CustomerPhone', action: 'read' },
    { subject: 'ChatbotSettings', action: 'read' },
    { subject: 'ChatbotSettings', action: 'update' },
  ],
  Cashier: [
    { subject: 'ChatbotRequest', action: 'read' },
    { subject: 'ChatbotRequest', action: 'update' },
    { subject: 'ChatbotConversation', action: 'read' },
  ],
};
const ROLE_NAMES = Object.keys(ROLE_GRANTS);
const USAGE =
  'node scripts/ops/grant-chatbot-request-permissions.cjs [--tenant <slug>] [--apply]';

class OpsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function parseArgs(argv) {
  const args = { apply: false, help: false, tenant: null };
  for (let i = 0; i < argv.length; i += 1) {
    const [key, inline] = argv[i].split(/=(.*)/s, 2);
    if ((key === '--apply' || key === '--help') && inline === undefined) {
      args[key.slice(2)] = true;
    } else if (key === '--tenant') {
      const value = inline ?? argv[(i += 1)];
      if (!value || value.startsWith('--')) {
        throw new OpsError('BAD_ARGS', '--tenant needs a value');
      }
      args.tenant = value.trim();
    } else {
      throw new OpsError('BAD_ARGS', `unknown argument ${argv[i]}`);
    }
  }
  return args;
}

/**
 * Pure planning: for each tenant, the RolePermission rows its Manager and
 * Cashier roles are missing and the ones they already hold.
 *
 * @param {{ tenants: { id: string, slug: string, roles: { id: string, name: string, permissionIds: string[] }[] }[],
 *           permissions: { id: string, subject: string, action: string }[] }} input
 */
function planGrants({ tenants, permissions }) {
  const idByKey = new Map(
    permissions.map((p) => [`${p.subject}:${p.action}`, p.id]),
  );
  const keys = Object.values(ROLE_GRANTS)
    .flat()
    .map((g) => `${g.subject}:${g.action}`);
  const missing = [...new Set(keys)].filter((key) => !idByKey.has(key));
  if (missing.length > 0) {
    throw new OpsError(
      'PERMISSION_MISSING',
      `${missing.join(', ')} not seeded; boot the API with this release first`,
    );
  }

  let totalToAdd = 0;
  const planned = tenants.map((tenant) => {
    const roles = [];
    const missingRoles = [];
    for (const roleName of ROLE_NAMES) {
      const role = tenant.roles.find((r) => r.name === roleName);
      if (!role) {
        missingRoles.push(roleName);
        continue;
      }
      const held = new Set(role.permissionIds);
      const add = [];
      const alreadyHeld = [];
      for (const grant of ROLE_GRANTS[roleName]) {
        const row = {
          ...grant,
          permissionId: idByKey.get(`${grant.subject}:${grant.action}`),
        };
        (held.has(row.permissionId) ? alreadyHeld : add).push(row);
      }
      totalToAdd += add.length;
      roles.push({ role: roleName, roleId: role.id, add, alreadyHeld });
    }
    return { tenantId: tenant.id, slug: tenant.slug, roles, missingRoles };
  });
  return { tenants: planned, totalToAdd };
}

/** host:port/database of DATABASE_URL — never the credentials. */
function databaseTarget() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new OpsError('ENV_MISSING', 'DATABASE_URL is not set');
  try {
    const url = new URL(raw);
    return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
  } catch {
    throw new OpsError('ENV_INVALID', 'DATABASE_URL is not a valid URL');
  }
}

async function readState(prisma, args) {
  const tenants = await prisma.tenant.findMany({
    where: args.tenant ? { slug: args.tenant } : {},
    orderBy: { slug: 'asc' },
    select: {
      id: true,
      slug: true,
      roles: {
        where: { name: { in: ROLE_NAMES } },
        select: {
          id: true,
          name: true,
          permissions: { select: { permissionId: true } },
        },
      },
    },
  });
  if (args.tenant && tenants.length === 0) {
    throw new OpsError('TENANT_NOT_FOUND', `tenant "${args.tenant}"`);
  }
  const keys = Object.values(ROLE_GRANTS).flat();
  const permissions = await prisma.permission.findMany({
    where: { OR: keys.map(({ subject, action }) => ({ subject, action })) },
    select: { id: true, subject: true, action: true },
  });
  return {
    tenants: tenants.map((t) => ({
      id: t.id,
      slug: t.slug,
      roles: t.roles.map((r) => ({
        id: r.id,
        name: r.name,
        permissionIds: r.permissions.map((p) => p.permissionId),
      })),
    })),
    permissions,
  };
}

function printPlan(plan, apply) {
  const verb = apply ? 'added' : 'would add';
  for (const tenant of plan.tenants) {
    console.log(`tenant ${tenant.slug}`);
    for (const role of tenant.roles) {
      for (const row of role.add) {
        console.log(`  ${role.role}: ${verb} ${row.action}:${row.subject}`);
      }
      for (const row of role.alreadyHeld) {
        console.log(`  ${role.role}: already has ${row.action}:${row.subject}`);
      }
    }
    for (const name of tenant.missingRoles) {
      console.log(`  ${name}: role not found, skipped`);
    }
  }
  console.log(
    `${apply ? 'Added' : 'Would add'} ${plan.totalToAdd} role permission(s) across ${plan.tenants.length} tenant(s).`,
  );
}

async function applyPlan(prisma, plan) {
  const rows = plan.tenants.flatMap((t) =>
    t.roles.flatMap((r) =>
      r.add.map((row) => ({
        roleId: r.roleId,
        permissionId: row.permissionId,
      })),
    ),
  );
  await prisma.$transaction(
    rows.map((data) =>
      prisma.rolePermission.upsert({
        where: { roleId_permissionId: data },
        update: {},
        create: data,
      }),
    ),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const appRoot = process.cwd();
  if (!process.env.DATABASE_URL) {
    // Dev convenience; production gets DATABASE_URL from the container env.
    try {
      process.loadEnvFile(path.join(appRoot, '.env'));
    } catch {
      // No .env: databaseTarget() reports the missing variable.
    }
  }
  console.log(
    `${args.apply ? 'APPLY' : 'DRY RUN'} on ${databaseTarget()} (NODE_ENV=${process.env.NODE_ENV ?? 'unset'})`,
  );

  const appRequire = createRequire(path.join(appRoot, 'package.json'));
  const { PrismaClient } = appRequire('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const plan = planGrants(await readState(prisma, args));
    if (args.apply) await applyPlan(prisma, plan);
    printPlan(plan, args.apply);
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = { ROLE_GRANTS, parseArgs, planGrants };

if (require.main === module) {
  main().then(
    () => process.exit(process.exitCode ?? 0),
    (err) => {
      const code = err?.code ?? err?.name ?? 'ERROR';
      console.error(
        `FAILED ${code}: ${String(err?.message ?? err).slice(0, 4000)}`,
      );
      process.exit(1);
    },
  );
}
