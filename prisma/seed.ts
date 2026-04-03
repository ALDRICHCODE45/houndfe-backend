/**
 * Prisma Seed - Creates Super Admin user for development/testing.
 *
 * Creates:
 * 1. All permissions from the registry
 * 2. "Super Admin" role (isSystem: true) with manage:all
 * 3. Admin user with that role assigned
 *
 * IDEMPOTENT: Safe to run multiple times (uses upsert).
 *
 * Usage: pnpm exec prisma db seed
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const ADMIN_USER = {
  email: 'admin@hounfe.com',
  password: 'Admin123!',
  name: 'Super Admin',
};

const BCRYPT_SALT_ROUNDS = 10;

async function main() {
  console.log('Seeding database...\n');

  // 1. Upsert "manage:all" permission
  const manageAllPermission = await prisma.permission.upsert({
    where: { subject_action: { subject: 'all', action: 'manage' } },
    update: { description: 'Full system access' },
    create: {
      subject: 'all',
      action: 'manage',
      description: 'Full system access',
    },
  });
  console.log(`  Permission "manage:all" -> ${manageAllPermission.id}`);

  // 2. Upsert Super Admin role
  const superAdminRole = await prisma.role.upsert({
    where: { name: 'Super Admin' },
    update: { description: 'Full system access', isSystem: true },
    create: {
      name: 'Super Admin',
      description: 'Full system access',
      isSystem: true,
    },
  });
  console.log(`  Role "Super Admin"      -> ${superAdminRole.id}`);

  // 3. Link permission to role
  await prisma.rolePermission.upsert({
    where: {
      roleId_permissionId: {
        roleId: superAdminRole.id,
        permissionId: manageAllPermission.id,
      },
    },
    update: {},
    create: { roleId: superAdminRole.id, permissionId: manageAllPermission.id },
  });
  console.log('  Linked "manage:all" to "Super Admin" role');

  // 4. Upsert admin user
  const hashedPassword = await bcrypt.hash(
    ADMIN_USER.password,
    BCRYPT_SALT_ROUNDS,
  );
  const adminUser = await prisma.user.upsert({
    where: { email: ADMIN_USER.email },
    update: { name: ADMIN_USER.name, hashedPassword, isActive: true },
    create: {
      id: crypto.randomUUID(),
      email: ADMIN_USER.email,
      hashedPassword,
      name: ADMIN_USER.name,
      isActive: true,
    },
  });
  console.log(`  User "${ADMIN_USER.email}" -> ${adminUser.id}`);

  // 5. Assign Super Admin role to user
  await prisma.userRole.upsert({
    where: {
      userId_roleId: {
        userId: adminUser.id,
        roleId: superAdminRole.id,
      },
    },
    update: {},
    create: { userId: adminUser.id, roleId: superAdminRole.id },
  });
  console.log('  Assigned "Super Admin" role to admin user');

  // 6. Ensure default global PUBLICO price list exists
  const publicoPriceList = await prisma.globalPriceList.upsert({
    where: { name: 'PUBLICO' },
    update: { isDefault: true },
    create: {
      name: 'PUBLICO',
      isDefault: true,
    },
  });
  console.log(
    `  Global price list "PUBLICO" -> ${publicoPriceList.id} (default)`,
  );

  console.log('\n--- Seed completed ---');
  console.log(`\n  Email:    ${ADMIN_USER.email}`);
  console.log(`  Password: ${ADMIN_USER.password}`);
  console.log(`  Role:     Super Admin (manage:all)\n`);
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
