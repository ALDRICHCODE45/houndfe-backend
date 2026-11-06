// Dev showcase › organisation: sucursales (address + phone), roles with Spanish
// descriptions and demo users for every UI persona (admin, gerente, cajero,
// repartidor, vendedor without inventory access). Prisma only (no HTTP flow
// exists for seeding people); every change is additive and idempotent.
'use strict';

const bcrypt = require('bcrypt');
const { randomUUID } = require('node:crypto');

const BCRYPT_SALT_ROUNDS = 10;
// Login password of the demo users this module creates. Existing users keep
// theirs unless SHOWCASE_RESET_PASSWORDS=1 sets it again. Never printed.
const DEMO_PASSWORD = process.env.SHOWCASE_DEMO_PASSWORD || 'Demo123!';
const RESET_PASSWORDS = process.env.SHOWCASE_RESET_PASSWORDS === '1';

const TENANT_PROFILES = {
  centro: {
    address:
      'Av. Insurgentes Sur 1458, Del Valle Centro, 03100 Ciudad de México',
    phone: '+52 55 5543 2100',
  },
  norte: {
    address: 'Calzada Vallejo 980, Industrial Vallejo, 07700 Ciudad de México',
    phone: '+52 55 5567 8890',
  },
  sur: {
    address:
      'Av. Canal de Miramontes 2310, Residencial Acoxpa, 14300 Ciudad de México',
    phone: '+52 55 5603 4417',
  },
};

const ROLE_DESCRIPTIONS = {
  'Super Admin': 'Administrador general: acceso total al sistema',
  Manager: 'Gerente: acceso completo a la sucursal',
  Cashier: 'Cajero: ventas, cobros y caja',
  repartidor: 'Repartidor: rutas y entregas asignadas',
  Vendedor:
    'Vendedor de mostrador: consulta catálogo y ventas, sin acceso a inventario',
};

// Descriptions written by the base seed; only these (or none) are replaced.
const ENGLISH_DEFAULT_DESCRIPTIONS = [
  'Global super-admin role',
  'Full system access',
  ...['Sucursal Centro', 'Sucursal Norte', 'Sucursal Sur'].flatMap((name) => [
    `Manager role for ${name}`,
    `Cashier role for ${name}`,
  ]),
];

// Inventory permissions the base seed does not grant to the Manager role.
const MANAGER_EXTRA_GRANTS = [
  ['InventoryJournal', 'read'],
  ['InventoryAdjustment', 'create'],
];
// A pure driver: read + update on routes only (no create/delete, see users.service).
const DRIVER_GRANTS = [
  ['DeliveryRoute', 'read'],
  ['DeliveryRoute', 'update'],
];
// Counter seller: deliberately without InventoryJournal/InventoryAdjustment so the
// inventory screens answer 403. Commerce never touches this role.
const SELLER_GRANTS = [
  ['Product', 'read'],
  ['Category', 'read'],
  ['Brand', 'read'],
  ['Customer', 'read'],
  ['Sale', 'read'],
  ['GlobalPriceList', 'read'],
];

const DEMO_USERS = [
  {
    email: 'repartidor@houndfe.com',
    name: 'Luis Hernández',
    tenant: 'centro',
    role: 'repartidor',
  },
  {
    email: 'vendedor@houndfe.com',
    name: 'Sofía Ramírez',
    tenant: 'centro',
    role: 'Vendedor',
  },
  {
    email: 'gerente.norte@houndfe.com',
    name: 'Andrea Torres',
    tenant: 'norte',
    role: 'Manager',
  },
  {
    email: 'cajero.norte@houndfe.com',
    name: 'Valeria Núñez',
    tenant: 'norte',
    role: 'Cashier',
  },
];

async function ensureTenantProfile(prisma, slug) {
  const tenant = await prisma.tenant.findUnique({ where: { slug } });
  if (!tenant) return null;
  const profile = TENANT_PROFILES[slug];
  if (tenant.address !== profile.address || tenant.phone !== profile.phone) {
    return prisma.tenant.update({ where: { id: tenant.id }, data: profile });
  }
  return tenant;
}

async function ensureRole(prisma, tenant, name) {
  return prisma.role.upsert({
    where: { tenantId_name: { tenantId: tenant.id, name } },
    update: {},
    create: {
      tenantId: tenant.id,
      name,
      description: ROLE_DESCRIPTIONS[name],
      isSystem: false,
    },
  });
}

/** Additive grants: missing permission rows are a hard error (app boot seeds them). */
async function grant(prisma, role, grants) {
  let created = 0;
  for (const [subject, action] of grants) {
    const permission = await prisma.permission.findUnique({
      where: { subject_action: { subject, action } },
    });
    if (!permission) {
      throw new Error(`Permission ${subject}:${action} is not registered`);
    }
    const key = {
      roleId_permissionId: { roleId: role.id, permissionId: permission.id },
    };
    const existing = await prisma.rolePermission.findUnique({ where: key });
    if (existing) continue;
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: permission.id },
    });
    created += 1;
  }
  return created;
}

/** Returns `{ created, passwordReset }`; the reset applies only to existing users. */
async function ensureUser(
  prisma,
  spec,
  tenant,
  role,
  { resetPassword = RESET_PASSWORDS } = {},
) {
  let user = await prisma.user.findUnique({ where: { email: spec.email } });
  let created = false;
  let passwordReset = false;
  if (user && resetPassword) {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        hashedPassword: await bcrypt.hash(DEMO_PASSWORD, BCRYPT_SALT_ROUNDS),
      },
    });
    passwordReset = true;
  }
  if (!user) {
    user = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: spec.email,
        name: spec.name,
        hashedPassword: await bcrypt.hash(DEMO_PASSWORD, BCRYPT_SALT_ROUNDS),
        isActive: true,
      },
    });
    created = true;
  }
  await prisma.tenantMembership.upsert({
    where: {
      userId_tenantId_roleId: {
        userId: user.id,
        tenantId: tenant.id,
        roleId: role.id,
      },
    },
    update: {},
    create: { userId: user.id, tenantId: tenant.id, roleId: role.id },
  });
  return { created, passwordReset };
}

async function run(ctx) {
  const { prisma } = ctx;
  const summary = {
    tenants: {},
    roleGrantsCreated: 0,
    usersCreated: [],
    passwordsReset: [],
  };

  const tenants = {};
  for (const slug of Object.keys(TENANT_PROFILES)) {
    tenants[slug] = await ensureTenantProfile(prisma, slug);
  }

  // Spanish descriptions for the roles that exist in the three sucursales.
  const tenantIds = Object.values(tenants)
    .filter(Boolean)
    .map((tenant) => tenant.id);
  for (const [name, description] of Object.entries(ROLE_DESCRIPTIONS)) {
    await prisma.role.updateMany({
      where: {
        name,
        AND: [{ OR: [{ tenantId: { in: tenantIds } }, { tenantId: null }] }],
        OR: [
          { description: null },
          { description: { in: ENGLISH_DEFAULT_DESCRIPTIONS } },
        ],
      },
      data: { description },
    });
  }

  const roles = {};
  for (const slug of ['centro', 'norte']) {
    const tenant = tenants[slug];
    if (!tenant) throw new Error(`Tenant ${slug} missing: run the base seed`);
    roles[slug] = {
      Manager: await ensureRole(prisma, tenant, 'Manager'),
      Cashier: await ensureRole(prisma, tenant, 'Cashier'),
    };
  }
  roles.centro.repartidor = await ensureRole(
    prisma,
    tenants.centro,
    'repartidor',
  );
  roles.centro.Vendedor = await ensureRole(prisma, tenants.centro, 'Vendedor');

  summary.roleGrantsCreated += await grant(
    prisma,
    roles.centro.Manager,
    MANAGER_EXTRA_GRANTS,
  );
  summary.roleGrantsCreated += await grant(
    prisma,
    roles.norte.Manager,
    MANAGER_EXTRA_GRANTS,
  );
  summary.roleGrantsCreated += await grant(
    prisma,
    roles.centro.repartidor,
    DRIVER_GRANTS,
  );
  summary.roleGrantsCreated += await grant(
    prisma,
    roles.centro.Vendedor,
    SELLER_GRANTS,
  );

  for (const spec of DEMO_USERS) {
    const { created, passwordReset } = await ensureUser(
      prisma,
      spec,
      tenants[spec.tenant],
      roles[spec.tenant][spec.role],
    );
    if (created) summary.usersCreated.push(spec.email);
    if (passwordReset) summary.passwordsReset.push(spec.email);
  }

  for (const [slug, tenant] of Object.entries(tenants)) {
    if (!tenant) continue;
    summary.tenants[slug] = {
      name: tenant.name,
      members: await prisma.tenantMembership.count({
        where: { tenantId: tenant.id },
      }),
    };
  }
  return summary;
}

module.exports = {
  name: 'org',
  run,
  ensureUser,
  grant,
  DEMO_PASSWORD,
  DEMO_USERS,
};
