'use strict';
// O1 inventory-journal showcase seed for the dev DB (disposable by human decision).
// Idempotent by natural keys (tenant slug, role name, permission subject+action,
// product name inside the tenant). Products are created through the REAL HTTP API so
// their INITIAL movements and bucket versions are genuine. Never prints secrets.
//   INVENTORY_DEV_PASSWORD=… node scripts/inventory-runtime/seed.cjs   (app must be running)
const assert = require('node:assert/strict');
const {
  TENANT_NAME,
  DEV_EMAIL,
  NOPERM_EMAIL,
  BASE_URL,
  prismaClient,
  requireEnv,
  http,
  login,
  tenantBySlug,
} = require('./lib.cjs');

const GRANTS = [
  ['InventoryJournal', 'read', 'View product stock and the inventory journal'],
  ['InventoryAdjustment', 'create', 'Create stock adjustments'],
];
// The dev user's tenant role (prisma/seed.ts creates one «Manager» role per tenant).
const GRANTED_ROLE = 'Manager';

// Expiry dates are fixed calendar dates: 2026-10-15 is already expired on 2026-11-04.
const SHOWCASE = [
  {
    key: 'croquetas',
    name: 'Croquetas Adulto 15 kg',
    untracked: 12,
    body: {
      sku: 'CROQ-AD-15',
      useStock: true,
      useLotsAndExpirations: true,
      // A lots-enabled product ignores the top-level quantity (the lots hold the stock),
      // so its 12 untracked units are added with an adjustment (see ensureUntracked).
      minQuantity: 10,
      priceCents: 125000,
      lots: [
        { lotNumber: 'L-2026-08', quantity: 8, expirationDate: '2026-10-15' },
        { lotNumber: 'L-2027-01', quantity: 22, expirationDate: '2027-01-15' },
        { lotNumber: 'L-2027-06', quantity: 30, expirationDate: '2027-06-30' },
      ],
    },
  },
  {
    key: 'desparasitante',
    name: 'Desparasitante Canino 10 ml',
    body: {
      sku: 'DESP-CAN-10',
      useStock: true,
      quantity: 40,
      minQuantity: 5,
      priceCents: 18900,
    },
  },
  {
    key: 'collar',
    name: 'Collar ajustable',
    body: {
      sku: 'COLLAR-AJ',
      useStock: true,
      hasVariants: true,
      priceCents: 24900,
      variants: [
        { name: 'Chico · Azul', quantity: 15, minQuantity: 3 },
        { name: 'Mediano · Rojo', quantity: 9, minQuantity: 3 },
      ],
    },
  },
  {
    key: 'placa',
    name: 'Placa de identificación grabada',
    body: {
      sku: 'PLACA-ID',
      useStock: false,
      priceCents: 12000,
    },
  },
];

async function grantPermissions(prisma, tenant) {
  const role = await prisma.role.findUnique({
    where: { tenantId_name: { tenantId: tenant.id, name: GRANTED_ROLE } },
  });
  assert(role, `role ${GRANTED_ROLE} not found in ${tenant.slug}`);
  for (const [subject, action, description] of GRANTS) {
    const permission = await prisma.permission.upsert({
      where: { subject_action: { subject, action } },
      update: {},
      create: { subject, action, description },
    });
    await prisma.rolePermission.upsert({
      where: {
        roleId_permissionId: { roleId: role.id, permissionId: permission.id },
      },
      update: {},
      create: { roleId: role.id, permissionId: permission.id },
    });
  }
  return role;
}

// POST /products unless a product with that name already exists in the tenant.
async function ensureProduct(prisma, tenantId, token, spec, name = spec.name) {
  const existing = await prisma.product.findFirst({
    where: { tenantId, name },
    select: { id: true },
  });
  if (existing) return { id: existing.id, created: false };
  const res = await http('POST', '/products', {
    token,
    body: { name, ...spec.body },
  });
  assert.equal(
    res.status,
    201,
    `create ${name}: HTTP ${res.status} ${JSON.stringify(res.body)}`,
  );
  return { id: res.body.id, created: true };
}

// Adds the untracked units through the real adjustment endpoint. The key is natural
// (product + purpose), so a re-run replays instead of writing a second movement.
async function ensureUntracked(token, productId, wanted) {
  const stock = await stockOf(token, productId);
  if (stock.product.untracked.quantity >= wanted) return;
  const res = await http('POST', '/inventory/adjustments', {
    token,
    headers: { 'idempotency-key': `seed-untracked-${productId}` },
    body: {
      target: { productId },
      expectedVersion: stock.product.untracked.version,
      delta: wanted - stock.product.untracked.quantity,
      reason: 'PHYSICAL_COUNT',
      note: 'Conteo inicial de unidades sueltas',
    },
  });
  assert.equal(
    res.status,
    201,
    `untracked adjustment: HTTP ${res.status} ${JSON.stringify(res.body)}`,
  );
}

async function stockOf(token, productId) {
  const res = await http('GET', `/inventory/products/${productId}/stock`, {
    token,
  });
  assert.equal(res.status, 200, `stock ${productId}: HTTP ${res.status}`);
  return res.body;
}

async function main() {
  const prisma = prismaClient();
  try {
    const tenant = await tenantBySlug(prisma);
    assert.equal(tenant.name, TENANT_NAME);
    const role = await grantPermissions(prisma, tenant);
    const token = await login(
      DEV_EMAIL,
      requireEnv('INVENTORY_DEV_PASSWORD'),
      tenant.id,
    );
    const summary = [];
    for (const spec of SHOWCASE) {
      const { id, created } = await ensureProduct(
        prisma,
        tenant.id,
        token,
        spec,
      );
      if (spec.untracked) await ensureUntracked(token, id, spec.untracked);
      summary.push({
        key: spec.key,
        name: spec.name,
        id,
        created,
        stock: await stockOf(token, id),
      });
    }
    console.log(
      JSON.stringify(
        {
          baseUrl: BASE_URL,
          tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
          devUser: DEV_EMAIL,
          noPermissionUser: NOPERM_EMAIL,
          grantedRole: {
            id: role.id,
            name: role.name,
            permissions: GRANTS.map(([s, a]) => `${s}:${a}`),
          },
          products: summary,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = {
  SHOWCASE,
  GRANTS,
  GRANTED_ROLE,
  grantPermissions,
  ensureProduct,
  stockOf,
};
