/**
 * editorial-live harness — fictional dataset seeding (one transaction).
 *
 * Seeds ONLY the validated disposable database (`editorial_live_test` on a
 * dedicated port — enforced by ./editorial-env before this module is ever
 * imported). Per run id:
 *
 *   - `seedEditorialPostgres` (the repository's editorial fixture, reused
 *     as-is) writes tenant A + a foreign tenant, the editorial-only user
 *     with a tenant-A role holding EXACTLY ProductEditorialDraft read +
 *     update, the editorial product (variant, price, private media) in
 *     tenant A, a foreign product, and one editorial family/definition/
 *     binding/options;
 *   - the binding patch from scripts/editorial-draft-runtime/host.cjs
 *     (`publicationCheck = 'when_asserted'`, `policy = {"route":"pending"}`)
 *     so the stored vocabulary is representable (V2 family shape requires
 *     both), and the global `editorial_vocabulary_metadata` row
 *     (`editorial-production-1`), inserted only when absent;
 *   - the global Super Admin exactly as PermissionSeeder / prisma/seed.ts
 *     shape it: the system role `Super Admin` (tenantId null, isSystem)
 *     linked to manage:all, plus one membership per seeded tenant;
 *   - a tenant-A role with manage:all and its user.
 *
 * Actors (four DISTINCT users):
 *   - superadmin-global: Super Admin, token tenantId null, isSuperAdmin true;
 *   - superadmin-tenant: another Super Admin user (same system role and
 *     memberships), token tenant A + isSuperAdmin true — the shape
 *     AuthService.switchTenantAsSuperAdmin issues;
 *   - manage-all: tenant-A role with manage:all, isSuperAdmin false;
 *   - editorial-only: tenant A, ProductEditorialDraft read + update only.
 * The disposable editorial product is renamed `Editorial Live Product <runId>`.
 *
 * The harness never deletes anything; names carry the run id.
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../src/shared/prisma/prisma.service';
import { PERMISSION_REGISTRY } from '../../src/auth/authorization/domain/permission';
import { seedEditorialPostgres } from '../../src/catalog-editorial/infrastructure/editorial-coordination-postgres-fixture';

/** Frontend-agreed actor keys (fixture `actors` order). */
export const EDITORIAL_ACTOR_KEYS = [
  'superadmin-global',
  'superadmin-tenant',
  'manage-all',
  'editorial-only',
] as const;
export type EditorialActorKey = (typeof EDITORIAL_ACTOR_KEYS)[number];

export const EDITORIAL_SEMANTICS_VERSION = 'editorial-production-1';
export const SUPER_ADMIN_ROLE_NAME = 'Super Admin';
export const MANAGE_ALL_CODE = 'manage:all';
export const EDITORIAL_ONLY_CODES = [
  'read:ProductEditorialDraft',
  'update:ProductEditorialDraft',
] as const;
const RUN_ID_PATTERN = /^[a-z0-9]{1,64}$/;

export interface SeededTenant {
  id: string;
  name: string;
  slug: string;
}

export interface SeededMembership {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  roleId: string;
  roleName: string;
  /** null for the global system Super Admin role. */
  roleTenantId: string | null;
}

export interface SeededEditorialActor {
  key: EditorialActorKey;
  userId: string;
  email: string;
  name: string;
  createdAt: Date;
  /** Tenant carried by the token; null only for the global Super Admin. */
  selectedTenant: SeededTenant | null;
  isSuperAdmin: boolean;
  permissionCodes: string[];
  memberships: SeededMembership[];
}

export interface EditorialSeedResult {
  runId: string;
  tenants: { a: SeededTenant; foreign: SeededTenant };
  product: {
    id: string;
    tenantId: string;
    name: string;
    variantId: string;
    foreignProductId: string;
    foreignTenantId: string;
  };
  editorial: {
    familyCode: string;
    definitionCode: string;
    activeOptionCode: string;
    archivedOptionCode: string;
    unrelatedOptionCode: string;
    semanticsVersion: string;
  };
  actors: Record<EditorialActorKey, SeededEditorialActor>;
  permissionsSeeded: number;
}

type Tx = Prisma.TransactionClient;

function registryDescription(subject: string, action: string): string {
  const definition = PERMISSION_REGISTRY.find(
    (p) => p.subject === subject && p.action === action,
  );
  if (!definition) {
    throw new Error(
      `Permission "${action}:${subject}" is not in PERMISSION_REGISTRY — refusing to seed`,
    );
  }
  return definition.description;
}

async function randomPasswordHash(): Promise<string> {
  // Never used (tokens are signed directly); random per user, per run.
  return bcrypt.hash(randomUUID() + randomUUID(), 10);
}

/** Binding patch (host.cjs) + global vocabulary metadata (insert-if-absent). */
async function prepareVocabulary(tx: Tx, familyId: string): Promise<void> {
  await tx.$executeRaw`UPDATE "editorial_bindings" SET "publicationCheck" = 'when_asserted', "policy" = '{"route":"pending"}'::jsonb WHERE "familyId" = ${familyId}`;
  await tx.$executeRaw`INSERT INTO "editorial_vocabulary_metadata" ("id", "semanticsVersion") VALUES ('global', 'editorial-production-1') ON CONFLICT ("id") DO NOTHING`;
  const rows = await tx.$queryRaw<
    { semanticsVersion: string }[]
  >`SELECT "semanticsVersion" FROM "editorial_vocabulary_metadata" WHERE "id" = 'global'`;
  if (
    rows.length !== 1 ||
    rows[0].semanticsVersion !== EDITORIAL_SEMANTICS_VERSION
  ) {
    throw new Error(
      'editorial-live: stored vocabulary metadata is not editorial-production-1 — refusing to seed',
    );
  }
}

/** Same writes as PermissionSeeder: manage:all + system Super Admin role. */
async function ensureSuperAdminRole(
  tx: Tx,
  manageAllId: string,
): Promise<string> {
  const existing = await tx.role.findFirst({
    where: { name: SUPER_ADMIN_ROLE_NAME, tenantId: null },
  });
  const role = existing
    ? await tx.role.update({
        where: { id: existing.id },
        data: { description: 'Full system access', isSystem: true },
      })
    : await tx.role.create({
        data: {
          name: SUPER_ADMIN_ROLE_NAME,
          description: 'Full system access',
          isSystem: true,
        },
      });
  await tx.rolePermission.upsert({
    where: {
      roleId_permissionId: { roleId: role.id, permissionId: manageAllId },
    },
    update: {},
    create: { roleId: role.id, permissionId: manageAllId },
  });
  return role.id;
}

async function createUser(
  tx: Tx,
  email: string,
  name: string,
  hashedPassword: string,
) {
  return tx.user.create({
    data: { id: randomUUID(), email, name, isActive: true, hashedPassword },
    select: { id: true, email: true, name: true, createdAt: true },
  });
}

function membership(
  tenant: SeededTenant,
  roleId: string,
  roleName: string,
  roleTenantId: string | null,
): SeededMembership {
  return {
    tenantId: tenant.id,
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
    roleId,
    roleName,
    roleTenantId,
  };
}

/** Seed the full fictional editorial dataset for one run, atomically. */
export async function seedEditorialLiveDataset(
  prisma: PrismaService,
  runId: string,
): Promise<EditorialSeedResult> {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error('editorial-live: run id must match ^[a-z0-9]{1,64}$');
  }
  const manageAllDescription = registryDescription('all', 'manage');
  const superGlobalHash = await randomPasswordHash();
  const superTenantHash = await randomPasswordHash();
  const managerHash = await randomPasswordHash();

  return prisma.$transaction(
    async (tx) => {
      // 1. Repository editorial fixture (tenants, editorial-only actor,
      //    product, family/definition/binding/options).
      const f = await seedEditorialPostgres(tx, `editorial-live-${runId}`);
      await prepareVocabulary(tx, f.ids.familyId);

      // 2. Readable, run-unique tenant names (ids unchanged).
      const a = await tx.tenant.update({
        where: { id: f.ids.tenantId },
        data: {
          name: `Editorial Live Tenant A ${runId}`,
          slug: `editorial-live-a-${runId}`,
        },
      });
      const foreign = await tx.tenant.update({
        where: { id: f.ids.foreignTenantId },
        data: {
          name: `Editorial Live Foreign Tenant ${runId}`,
          slug: `editorial-live-foreign-${runId}`,
        },
      });
      const tenantA: SeededTenant = { id: a.id, name: a.name, slug: a.slug };
      const product = await tx.product.update({
        where: { id: f.ids.productId },
        data: { name: `Editorial Live Product ${runId}` },
        select: { id: true, tenantId: true, name: true },
      });
      if (product.tenantId !== tenantA.id) {
        throw new Error('editorial-live: editorial product is not in tenant A');
      }
      const tenantF: SeededTenant = {
        id: foreign.id,
        name: foreign.name,
        slug: foreign.slug,
      };

      // 3. Global Super Admin (PermissionSeeder + prisma/seed.ts shape).
      const manageAll = await tx.permission.upsert({
        where: { subject_action: { subject: 'all', action: 'manage' } },
        update: { description: manageAllDescription },
        create: {
          subject: 'all',
          action: 'manage',
          description: manageAllDescription,
        },
      });
      const superRoleId = await ensureSuperAdminRole(tx, manageAll.id);
      const superUsers = {
        global: await createUser(
          tx,
          `super-admin-global.${runId}@editorial-live.test`,
          'Super Admin Global (editorial-live)',
          superGlobalHash,
        ),
        tenant: await createUser(
          tx,
          `super-admin-tenant.${runId}@editorial-live.test`,
          'Super Admin Tenant A (editorial-live)',
          superTenantHash,
        ),
      };
      // prisma/seed.ts: one Super Admin membership per tenant.
      for (const user of [superUsers.global, superUsers.tenant]) {
        for (const tenant of [tenantA, tenantF]) {
          await tx.tenantMembership.create({
            data: { userId: user.id, tenantId: tenant.id, roleId: superRoleId },
          });
        }
      }
      const superMemberships = [tenantA, tenantF].map((t) =>
        membership(t, superRoleId, SUPER_ADMIN_ROLE_NAME, null),
      );

      // 4. Tenant-A role with manage:all.
      const managerUser = await createUser(
        tx,
        `manager-a.${runId}@editorial-live.test`,
        'Manager A (editorial-live)',
        managerHash,
      );
      const managerRoleName = `editorial-live manager ${runId}`;
      const managerRole = await tx.role.create({
        data: {
          name: managerRoleName,
          tenantId: tenantA.id,
          description: 'editorial-live disposable harness role (fictional)',
          permissions: { create: [{ permissionId: manageAll.id }] },
        },
      });
      await tx.tenantMembership.create({
        data: {
          userId: managerUser.id,
          tenantId: tenantA.id,
          roleId: managerRole.id,
        },
      });

      // 5. Editorial-only actor = the fixture's user (read + update only).
      const editorialUser = await tx.user.findUniqueOrThrow({
        where: { id: f.ids.userId },
        select: { id: true, email: true, name: true, createdAt: true },
      });

      const superAdmin = (
        user: typeof superUsers.global,
      ): Omit<SeededEditorialActor, 'key' | 'selectedTenant'> => ({
        userId: user.id,
        email: user.email,
        name: user.name,
        createdAt: user.createdAt,
        isSuperAdmin: true,
        permissionCodes: [MANAGE_ALL_CODE],
        memberships: superMemberships.map((m) => ({ ...m })),
      });
      return {
        runId,
        tenants: { a: tenantA, foreign: tenantF },
        product: {
          id: product.id,
          tenantId: product.tenantId,
          name: product.name,
          variantId: f.ids.variantId,
          foreignProductId: f.ids.foreignProductId,
          foreignTenantId: tenantF.id,
        },
        editorial: {
          // seedEditorialPostgres stores code === id for family/definition.
          familyCode: f.ids.familyId,
          definitionCode: f.ids.definitionId,
          activeOptionCode: f.values.activeOptionCode,
          archivedOptionCode: f.values.archivedOptionCode,
          unrelatedOptionCode: f.values.unrelatedOptionCode,
          semanticsVersion: EDITORIAL_SEMANTICS_VERSION,
        },
        actors: {
          'superadmin-global': {
            key: 'superadmin-global',
            ...superAdmin(superUsers.global),
            selectedTenant: null,
          },
          'superadmin-tenant': {
            key: 'superadmin-tenant',
            ...superAdmin(superUsers.tenant),
            selectedTenant: tenantA,
          },
          'manage-all': {
            key: 'manage-all',
            userId: managerUser.id,
            email: managerUser.email,
            name: managerUser.name,
            createdAt: managerUser.createdAt,
            selectedTenant: tenantA,
            isSuperAdmin: false,
            permissionCodes: [MANAGE_ALL_CODE],
            memberships: [
              membership(tenantA, managerRole.id, managerRoleName, tenantA.id),
            ],
          },
          'editorial-only': {
            key: 'editorial-only',
            userId: editorialUser.id,
            email: editorialUser.email,
            name: editorialUser.name,
            createdAt: editorialUser.createdAt,
            selectedTenant: tenantA,
            isSuperAdmin: false,
            permissionCodes: [...EDITORIAL_ONLY_CODES],
            // seedEditorialPostgres uses roleId as the role name.
            memberships: [
              membership(tenantA, f.ids.roleId, f.ids.roleId, tenantA.id),
            ],
          },
        },
        // manage:all + ProductEditorialDraft read/update.
        permissionsSeeded: 3,
      };
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
}
