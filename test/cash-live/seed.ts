/**
 * cash-live harness — fictional dataset seeding.
 *
 * Seeds ONLY the validated disposable database (`cash_closing_proof_test`
 * on a dedicated port — enforced by `disposable-env.ts` before this module
 * is ever reached):
 *
 *   - 2 uniquely named tenants;
 *   - 3 active users: `cashier` and `verifier` in tenant A, `foreign`
 *     (cashier-scoped) in tenant B;
 *   - one dynamic role per actor, composed EXPLICITLY from permission codes
 *     selected out of the real `PERMISSION_REGISTRY` — never `manage:all`,
 *     never the Super Admin role, never any default role assignment.
 *
 * All names/emails/slugs carry the run id so repeated runs against the same
 * disposable database never collide (the harness never drops the database).
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { PERMISSION_REGISTRY } from '../../src/auth/authorization/domain/permission';

/** Cashier duty set — register create/read, session create/read, counts, in/out, handovers. */
export const CASHIER_PERMISSION_CODES = [
  'create:CashRegister',
  'read:CashRegister',
  'create:CashSession',
  'read:CashSession',
  'create:CashCount',
  'create:CashIn',
  'create:CashOut',
  'create:CashHandover',
  'read:CashHandover',
  'update:CashHandover',
] as const;

/**
 * Verifier duty set — session read + audit read (wider visibility of other
 * users' sessions), independent verification, handover read/receipt.
 *
 * SCOPE: cash closing and PDF generation are explicitly OUT OF SCOPE for
 * this harness — no `CashClosing` (or any other closing/PDF) permission is
 * seeded to any actor. Session close routes will 403 for every seeded
 * actor by design.
 */
export const VERIFIER_PERMISSION_CODES = [
  'read:CashSession',
  'read:CashSessionAudit',
  'create:CashVerification',
  'read:CashHandover',
  'update:CashHandover',
] as const;

/** Foreign tenant actor — same cashier-scoped rights inside its own tenant. */
export const FOREIGN_PERMISSION_CODES: readonly string[] =
  CASHIER_PERMISSION_CODES;

// NOTE: no actor receives `create:CashClosing`/`read:CashClosing` — closing
// and PDF are out of scope for this harness (see verifier set comment).

export type PermissionCode = `${string}:${string}`;
export type FunctionalRole = 'cashier' | 'verifier' | 'foreign';

export interface SeededTenant {
  id: string;
  name: string;
  slug: string;
}

export interface SeededUser {
  id: string;
  email: string;
  name: string;
  tenantId: string;
  permissionCodes: string[];
  functionalRole: FunctionalRole;
  createdAt: Date;
}

export interface SeedResult {
  runId: string;
  tenants: SeededTenant[];
  users: { cashier: SeededUser; verifier: SeededUser; foreign: SeededUser };
  permissionsSeeded: number;
}

/** A code like "create:CashRegister" — action and registry subject. */
function parsePermissionCode(code: string): {
  action: string;
  subject: string;
} {
  const separator = code.indexOf(':');
  if (separator <= 0 || separator === code.length - 1) {
    throw new Error(`Invalid permission code "${code}"`);
  }
  return {
    action: code.slice(0, separator),
    subject: code.slice(separator + 1),
  };
}

/** Verify every requested code exists in the real registry; no inventions. */
function assertCodesInRegistry(codes: readonly string[]): void {
  const registry = new Set(
    PERMISSION_REGISTRY.map((p) => `${p.action}:${p.subject}`),
  );
  for (const code of codes) {
    if (!registry.has(code)) {
      throw new Error(
        `Permission code "${code}" is not in PERMISSION_REGISTRY — refusing to seed`,
      );
    }
  }
}

/** Upsert the registry rows for exactly the codes the actors need. */
async function ensurePermissions(
  prisma: PrismaService,
  codes: readonly string[],
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const code of codes) {
    const { action, subject } = parsePermissionCode(code);
    const definition = PERMISSION_REGISTRY.find(
      (p) => p.action === action && p.subject === subject,
    );
    if (!definition) {
      throw new Error(`Permission "${code}" missing from registry description`);
    }
    const row = await prisma.permission.upsert({
      where: { subject_action: { subject, action } },
      update: { description: definition.description },
      create: { subject, action, description: definition.description },
    });
    ids.set(code, row.id);
  }
  return ids;
}

async function seedTenant(
  prisma: PrismaService,
  name: string,
  slug: string,
): Promise<SeededTenant> {
  const tenant = await prisma.tenant.create({ data: { name, slug } });
  return { id: tenant.id, name: tenant.name, slug: tenant.slug };
}

async function seedUser(
  prisma: PrismaService,
  email: string,
  name: string,
): Promise<{ id: string; email: string; name: string; createdAt: Date }> {
  // The password is never used by the harness (JWTs are signed directly);
  // it exists only to satisfy the User model and is random per run.
  const randomPassword = randomUUID() + randomUUID();
  const user = await prisma.user.create({
    data: {
      id: randomUUID(),
      email,
      name,
      isActive: true,
      hashedPassword: await bcrypt.hash(randomPassword, 10),
    },
    select: { id: true, email: true, name: true, createdAt: true },
  });
  return user;
}

async function seedRoleWithPermissions(
  prisma: PrismaService,
  tenantId: string,
  roleName: string,
  codes: readonly string[],
  permissionIds: Map<string, string>,
): Promise<string> {
  const role = await prisma.role.create({
    data: {
      name: roleName,
      tenantId,
      description: 'cash-live disposable harness role (fictional)',
      permissions: {
        create: codes.map((code) => ({
          permissionId: permissionIds.get(code) as string,
        })),
      },
    },
  });
  return role.id;
}

async function seedMembership(
  prisma: PrismaService,
  userId: string,
  tenantId: string,
  roleId: string,
): Promise<void> {
  await prisma.tenantMembership.create({ data: { userId, tenantId, roleId } });
}

interface ActorSeedInput {
  functionalRole: FunctionalRole;
  email: string;
  name: string;
  tenant: SeededTenant;
  codes: readonly string[];
  permissionIds: Map<string, string>;
  runId: string;
}

async function seedActor(
  prisma: PrismaService,
  input: ActorSeedInput,
): Promise<SeededUser> {
  const user = await seedUser(prisma, input.email, input.name);
  const roleId = await seedRoleWithPermissions(
    prisma,
    input.tenant.id,
    `cash-live ${input.functionalRole} ${input.runId}`,
    input.codes,
    input.permissionIds,
  );
  await seedMembership(prisma, user.id, input.tenant.id, roleId);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    tenantId: input.tenant.id,
    permissionCodes: [...input.codes],
    functionalRole: input.functionalRole,
    createdAt: user.createdAt,
  };
}

/** Seed the full fictional dataset. Idempotent across runs via unique names. */
export async function seedFictionalDataset(
  prisma: PrismaService,
  runId: string,
): Promise<SeedResult> {
  const allCodes = [
    ...new Set([...CASHIER_PERMISSION_CODES, ...VERIFIER_PERMISSION_CODES]),
  ];
  assertCodesInRegistry(allCodes);

  const permissionIds = await ensurePermissions(prisma, allCodes);
  const permissionsSeeded = permissionIds.size;

  const tenantA = await seedTenant(
    prisma,
    `Cash Live Tenant A ${runId}`,
    `cash-live-a-${runId}`,
  );
  const tenantB = await seedTenant(
    prisma,
    `Cash Live Tenant B ${runId}`,
    `cash-live-b-${runId}`,
  );

  const cashier = await seedActor(prisma, {
    functionalRole: 'cashier',
    email: `cashier-a.${runId}@cash-live.test`,
    name: 'Cashier A (cash-live)',
    tenant: tenantA,
    codes: CASHIER_PERMISSION_CODES,
    permissionIds,
    runId,
  });
  const verifier = await seedActor(prisma, {
    functionalRole: 'verifier',
    email: `verifier-b.${runId}@cash-live.test`,
    name: 'Verifier B (cash-live)',
    tenant: tenantA,
    codes: VERIFIER_PERMISSION_CODES,
    permissionIds,
    runId,
  });
  const foreign = await seedActor(prisma, {
    functionalRole: 'foreign',
    email: `foreign.${runId}@cash-live.test`,
    name: 'Foreign Cashier (cash-live)',
    tenant: tenantB,
    codes: FOREIGN_PERMISSION_CODES,
    permissionIds,
    runId,
  });

  return {
    runId,
    tenants: [tenantA, tenantB],
    users: { cashier, verifier, foreign },
    permissionsSeeded,
  };
}
