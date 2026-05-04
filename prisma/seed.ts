import { PrismaClient, type Prisma, type Permission } from '@prisma/client';
import bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { PERMISSION_REGISTRY } from '../src/auth/authorization/domain/permission';

const prisma = new PrismaClient();

const BCRYPT_SALT_ROUNDS = 10;

const TENANTS = [
  { name: 'Sucursal Centro', slug: 'centro', isActive: true },
  { name: 'Sucursal Norte', slug: 'norte', isActive: true },
  { name: 'Sucursal Sur', slug: 'sur', isActive: true },
] as const;

const USERS = {
  superAdmin: {
    email: 'admin@houndfe.com',
    name: 'Super Admin',
    password: 'Admin123!',
  },
  manager: {
    email: 'manager@houndfe.com',
    name: 'Manager Centro',
    password: 'Manager123!',
  },
  cashier: {
    email: 'cashier@houndfe.com',
    name: 'Cajero Centro',
    password: 'Cashier123!',
  },
} as const;

type SeedPermissionKey = `${string}:${string}`;

function permissionKey(subject: string, action: string): SeedPermissionKey {
  return `${subject}:${action}`;
}

async function upsertUser(
  tx: Prisma.TransactionClient,
  user: { email: string; name: string; password: string },
) {
  const hashedPassword = await bcrypt.hash(user.password, BCRYPT_SALT_ROUNDS);

  return tx.user.upsert({
    where: { email: user.email },
    update: { name: user.name, hashedPassword, isActive: true },
    create: {
      id: randomUUID(),
      email: user.email,
      hashedPassword,
      name: user.name,
      isActive: true,
    },
  });
}

async function upsertProductByTenantAndName(
  tx: Prisma.TransactionClient,
  payload: {
    tenantId: string;
    name: string;
    categoryId: string;
    brandId: string;
    sku: string;
    barcode: string;
  },
) {
  const existing = await tx.product.findFirst({
    where: { tenantId: payload.tenantId, name: payload.name },
    select: { id: true },
  });

  if (existing) {
    return tx.product.update({
      where: { id: existing.id },
      data: {
        categoryId: payload.categoryId,
        brandId: payload.brandId,
        sku: payload.sku,
        barcode: payload.barcode,
      },
    });
  }

  return tx.product.create({
    data: {
      name: payload.name,
      tenantId: payload.tenantId,
      categoryId: payload.categoryId,
      brandId: payload.brandId,
      sku: payload.sku,
      barcode: payload.barcode,
    },
  });
}

async function upsertCustomerByTenantAndEmail(
  tx: Prisma.TransactionClient,
  payload: {
    tenantId: string;
    firstName: string;
    lastName: string;
    email: string;
    phoneCountryCode: string;
    phone: string;
  },
) {
  const existing = await tx.customer.findFirst({
    where: { tenantId: payload.tenantId, email: payload.email },
    select: { id: true },
  });

  if (existing) {
    return tx.customer.update({
      where: { id: existing.id },
      data: {
        firstName: payload.firstName,
        lastName: payload.lastName,
        phoneCountryCode: payload.phoneCountryCode,
        phone: payload.phone,
      },
    });
  }

  return tx.customer.create({
    data: {
      tenantId: payload.tenantId,
      firstName: payload.firstName,
      lastName: payload.lastName,
      email: payload.email,
      phoneCountryCode: payload.phoneCountryCode,
      phone: payload.phone,
    },
  });
}

async function main() {
  console.log('Seeding multi-tenant database...\n');

  await prisma.$transaction(async (tx) => {
    const allPermissionDefinitions = [...PERMISSION_REGISTRY];

    const permissions = new Map<SeedPermissionKey, Permission>();

    for (const definition of allPermissionDefinitions) {
      const permission = await tx.permission.upsert({
        where: {
          subject_action: {
            subject: definition.subject,
            action: definition.action,
          },
        },
        update: { description: definition.description },
        create: {
          subject: definition.subject,
          action: definition.action,
          description: definition.description,
        },
      });

      permissions.set(permissionKey(definition.subject, definition.action), permission);
    }

    const tenants = new Map<string, { id: string; name: string; slug: string }>();
    for (const tenantSeed of TENANTS) {
      const tenant = await tx.tenant.upsert({
        where: { slug: tenantSeed.slug },
        update: { name: tenantSeed.name, isActive: tenantSeed.isActive },
        create: tenantSeed,
      });
      tenants.set(tenant.slug, tenant);
    }

    const existingSuperAdminRole = await tx.role.findFirst({
      where: { tenantId: null, name: 'Super Admin' },
      select: { id: true },
    });

    const superAdminRole = existingSuperAdminRole
      ? await tx.role.update({
          where: { id: existingSuperAdminRole.id },
          data: { description: 'Global super-admin role', isSystem: true },
        })
      : await tx.role.create({
          data: {
            name: 'Super Admin',
            tenantId: null,
            description: 'Global super-admin role',
            isSystem: true,
          },
        });

    const managerRoleByTenant = new Map<string, { id: string }>();
    const cashierRoleByTenant = new Map<string, { id: string }>();

    for (const tenant of tenants.values()) {
      const managerRole = await tx.role.upsert({
        where: { tenantId_name: { tenantId: tenant.id, name: 'Manager' } },
        update: { description: `Manager role for ${tenant.name}`, isSystem: false },
        create: {
          tenantId: tenant.id,
          name: 'Manager',
          description: `Manager role for ${tenant.name}`,
          isSystem: false,
        },
      });

      const cashierRole = await tx.role.upsert({
        where: { tenantId_name: { tenantId: tenant.id, name: 'Cashier' } },
        update: { description: `Cashier role for ${tenant.name}`, isSystem: false },
        create: {
          tenantId: tenant.id,
          name: 'Cashier',
          description: `Cashier role for ${tenant.name}`,
          isSystem: false,
        },
      });

      managerRoleByTenant.set(tenant.slug, managerRole);
      cashierRoleByTenant.set(tenant.slug, cashierRole);
    }

    const superAdminUser = await upsertUser(tx, USERS.superAdmin);
    const managerUser = await upsertUser(tx, USERS.manager);
    const cashierUser = await upsertUser(tx, USERS.cashier);

    for (const permission of permissions.values()) {
      await tx.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: superAdminRole.id,
            permissionId: permission.id,
          },
        },
        update: {},
        create: {
          roleId: superAdminRole.id,
          permissionId: permission.id,
        },
      });
    }

    const managerPermissionKeys: SeedPermissionKey[] = [
      permissionKey('Product', 'create'),
      permissionKey('Product', 'read'),
      permissionKey('Product', 'update'),
      permissionKey('Product', 'delete'),
      permissionKey('Sale', 'create'),
      permissionKey('Sale', 'read'),
      permissionKey('Sale', 'update'),
      permissionKey('Sale', 'delete'),
      permissionKey('Customer', 'create'),
      permissionKey('Customer', 'read'),
      permissionKey('Customer', 'update'),
      permissionKey('Customer', 'delete'),
      permissionKey('Order', 'create'),
      permissionKey('Order', 'read'),
      permissionKey('Order', 'update'),
      permissionKey('Order', 'delete'),
      permissionKey('Role', 'read'),
    ];

    const cashierPermissionKeys: SeedPermissionKey[] = [
      permissionKey('Sale', 'create'),
      permissionKey('Sale', 'read'),
      permissionKey('Product', 'read'),
      permissionKey('Customer', 'read'),
    ];

    for (const managerRole of managerRoleByTenant.values()) {
      for (const managerPermissionKey of managerPermissionKeys) {
        const permission = permissions.get(managerPermissionKey);
        if (!permission) {
          continue;
        }
        await tx.rolePermission.upsert({
          where: {
            roleId_permissionId: {
              roleId: managerRole.id,
              permissionId: permission.id,
            },
          },
          update: {},
          create: { roleId: managerRole.id, permissionId: permission.id },
        });
      }
    }

    for (const cashierRole of cashierRoleByTenant.values()) {
      for (const cashierPermissionKey of cashierPermissionKeys) {
        const permission = permissions.get(cashierPermissionKey);
        if (!permission) {
          continue;
        }
        await tx.rolePermission.upsert({
          where: {
            roleId_permissionId: {
              roleId: cashierRole.id,
              permissionId: permission.id,
            },
          },
          update: {},
          create: { roleId: cashierRole.id, permissionId: permission.id },
        });
      }
    }

    for (const tenant of tenants.values()) {
      await tx.tenantMembership.upsert({
        where: {
          userId_tenantId_roleId: {
            userId: superAdminUser.id,
            tenantId: tenant.id,
            roleId: superAdminRole.id,
          },
        },
        update: {},
        create: {
          userId: superAdminUser.id,
          tenantId: tenant.id,
          roleId: superAdminRole.id,
        },
      });
    }

    const centroTenant = tenants.get('centro');
    const centroManagerRole = managerRoleByTenant.get('centro');
    const centroCashierRole = cashierRoleByTenant.get('centro');

    if (!centroTenant || !centroManagerRole || !centroCashierRole) {
      throw new Error('Centro tenant or roles were not created during seed');
    }

    await tx.tenantMembership.upsert({
      where: {
        userId_tenantId_roleId: {
          userId: managerUser.id,
          tenantId: centroTenant.id,
          roleId: centroManagerRole.id,
        },
      },
      update: {},
      create: {
        userId: managerUser.id,
        tenantId: centroTenant.id,
        roleId: centroManagerRole.id,
      },
    });

    await tx.tenantMembership.upsert({
      where: {
        userId_tenantId_roleId: {
          userId: cashierUser.id,
          tenantId: centroTenant.id,
          roleId: centroCashierRole.id,
        },
      },
      update: {},
      create: {
        userId: cashierUser.id,
        tenantId: centroTenant.id,
        roleId: centroCashierRole.id,
      },
    });

    const category = await tx.category.upsert({
      where: { name: 'General' },
      update: {},
      create: { name: 'General' },
    });

    const brand = await tx.brand.upsert({
      where: { name: 'Sin Marca' },
      update: {},
      create: { name: 'Sin Marca' },
    });

    await tx.globalPriceList.upsert({
      where: { name: 'PUBLICO' },
      update: { isDefault: true },
      create: {
        name: 'PUBLICO',
        isDefault: true,
      },
    });

    await upsertProductByTenantAndName(tx, {
      tenantId: centroTenant.id,
      name: 'Paracetamol 500mg',
      categoryId: category.id,
      brandId: brand.id,
      sku: 'CENTRO-PARACETAMOL-500',
      barcode: '7501234567890',
    });

    await upsertProductByTenantAndName(tx, {
      tenantId: centroTenant.id,
      name: 'Ibuprofeno 400mg',
      categoryId: category.id,
      brandId: brand.id,
      sku: 'CENTRO-IBUPROFENO-400',
      barcode: '7501234567891',
    });

    await upsertCustomerByTenantAndEmail(tx, {
      tenantId: centroTenant.id,
      firstName: 'Cliente',
      lastName: 'Centro',
      email: 'cliente.centro@houndfe.com',
      phoneCountryCode: '+52',
      phone: '5512345678',
    });
  });

  console.log('\n--- Multi-tenant seed completed ---');
  console.log(`Super Admin: ${USERS.superAdmin.email} / ${USERS.superAdmin.password}`);
  console.log(`Manager:     ${USERS.manager.email} / ${USERS.manager.password}`);
  console.log(`Cashier:     ${USERS.cashier.email} / ${USERS.cashier.password}`);
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
