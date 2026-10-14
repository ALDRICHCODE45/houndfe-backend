/**
 * cash-live harness — existing fictional dataset reconstruction (READ-ONLY).
 *
 * S1/S3: the authorized local restart must emit NEW tokens WITHOUT
 * recreating data — the existing fictional users, tenants, memberships,
 * role-permissions and the single pending cash session must be preserved.
 * This module reconstructs the exact `SeedResult` shape (identical to
 * `seedFictionalDataset`) from authoritative DB rows so the harness can
 * sign fresh JWTs and rebuild the fixture without a single write.
 *
 * S3 / fail-closed identity contract — every actor read from the database
 * must be byte-for-byte the fictional seed, otherwise the resume refuses:
 *   - the derived runId must be a lowercase alphanumeric fictional slug
 *     (it is embedded in tenant slugs and actor emails);
 *   - 2 tenants must exist at the seeded slugs;
 *   - each actor (cashier / verifier / foreign) must exist by the seeded
 *     email, be ACTIVE, and have exactly ONE membership in the expected
 *     tenant whose role's permission set EQUALS the corresponding
 *     `CASHIER` / `VERIFIER` / `FOREIGN` constant set;
 *   - rejects an inactive user, a missing user/tenant, a membership in a
 *     different tenant, a system role, the `Super Admin` role, a global
 *     (tenant-less) role, `manage:all` (elevated), and any subset or
 *     superset of the expected permission set;
 *   - the supplied session must exist for the exact cashier, in the exact
 *     tenant, on a register of that tenant, with status `OPEN` and
 *     `openingCents === 50000`.
 *
 * READ-ONLY: this module performs `findUnique` / `findMany` only. It never
 * creates, updates, upserts, deletes, transacts, or touches
 * `PermissionSeeder`. The unit spec doubles Prisma with read-only stubs and
 * asserts every mutation/root method stayed uncalled.
 *
 * It also NEVER reads the token fixture, never loads `.env`, never starts a
 * server, and never reaches the network — it is a pure DB-read validator.
 */
import type { PrismaService } from '../../src/shared/prisma/prisma.service';
import {
  CASHIER_PERMISSION_CODES,
  FOREIGN_PERMISSION_CODES,
  VERIFIER_PERMISSION_CODES,
  type FunctionalRole,
  type SeedResult,
  type SeededTenant,
  type SeededUser,
} from './seed';

/**
 * The seeder composes run ids from base36 timestamps and uuid hex slices,
 * so the fictional naming charset is lowercase alphanumeric. Anything else
 * (uppercase, spaces, path separators, `@`, wildcards) is refused before a
 * single query runs — the runId is embedded directly into tenant slugs and
 * actor emails.
 */
export const RUN_ID_PATTERN = /^[a-z0-9]{1,128}$/;

/** The seeded cashier opening float, in cents. */
export const REQUIRED_OPENING_CENTS = 50000;

/** The only session status the resume accepts. */
export const OPEN_SESSION_STATUS = 'OPEN';

const SUPER_ADMIN_ROLE_NAME = 'Super Admin';
const MANAGE_ALL_CODE = 'manage:all';

/** Fixed refusal channel: reason only, never a DB row or secret. */
function refuse(reason: string): never {
  throw new Error(`cash-live resume refused: ${reason}`);
}

/** Seeded tenant slug for the given side of the fictional dataset. */
function tenantSlug(runId: string, side: 'a' | 'b'): string {
  return `cash-live-${side}-${runId}`;
}

/** Seeded actor email — mirrors `seed.ts` exactly. */
function actorEmail(runId: string, functionalRole: FunctionalRole): string {
  switch (functionalRole) {
    case 'cashier':
      return `cashier-a.${runId}@cash-live.test`;
    case 'verifier':
      return `verifier-b.${runId}@cash-live.test`;
    case 'foreign':
      return `foreign.${runId}@cash-live.test`;
  }
}

interface ActorSpec {
  functionalRole: FunctionalRole;
  tenant: 'a' | 'b';
  expectedCodes: readonly string[];
}

/** The three seeded identities and their exact expected permission sets. */
const ACTOR_SPECS: readonly ActorSpec[] = [
  {
    functionalRole: 'cashier',
    tenant: 'a',
    expectedCodes: CASHIER_PERMISSION_CODES,
  },
  {
    functionalRole: 'verifier',
    tenant: 'a',
    expectedCodes: VERIFIER_PERMISSION_CODES,
  },
  {
    functionalRole: 'foreign',
    tenant: 'b',
    expectedCodes: FOREIGN_PERMISSION_CODES,
  },
];

/**
 * Structural shape of a membership read with its role and role-permissions
 * (the same nested shape `CaslAbilityFactory.queryUserPermissions` loads).
 */
interface MembershipWithRolePermissions {
  role: {
    name: string;
    tenantId: string | null;
    isSystem: boolean;
    permissions: Array<{ permission: { action: string; subject: string } }>;
  };
}

function permissionCodesOf(
  membership: MembershipWithRolePermissions,
): string[] {
  return membership.role.permissions.map(
    (rolePermission) =>
      `${rolePermission.permission.action}:${rolePermission.permission.subject}`,
  );
}

/**
 * Enforce the exact fictional authorization of one actor. Any deviation —
 * system/Super Admin/global role, `manage:all`, missing permissions
 * (subset) or extra permissions (superset) — refuses the resume.
 */
function assertActorAuthorization(
  functionalRole: FunctionalRole,
  expectedTenantId: string,
  membership: MembershipWithRolePermissions,
  expectedCodes: readonly string[],
): string[] {
  const { role } = membership;

  if (role.isSystem) {
    refuse(`${functionalRole} role "${role.name}" is a system role`);
  }
  if (role.name === SUPER_ADMIN_ROLE_NAME) {
    refuse(`${functionalRole} role is the Super Admin role`);
  }
  if (role.tenantId !== expectedTenantId) {
    refuse(
      `${functionalRole} role belongs to a different tenant or is global`,
    );
  }

  const actual = new Set(permissionCodesOf(membership));
  if (actual.has(MANAGE_ALL_CODE)) {
    refuse(`${functionalRole} holds manage:all — elevated identity rejected`);
  }

  const expected = new Set(expectedCodes);
  const missing = [...expected].filter((code) => !actual.has(code));
  if (missing.length > 0) {
    refuse(
      `${functionalRole} is missing required permissions: ${missing.join(
        ', ',
      )} — subset rejected`,
    );
  }
  const unexpected = [...actual].filter((code) => !expected.has(code));
  if (unexpected.length > 0) {
    refuse(
      `${functionalRole} holds unexpected permissions: ${unexpected.join(
        ', ',
      )} — superset rejected`,
    );
  }

  // Return the constant order, matching `seedFictionalDataset` exactly.
  return [...expectedCodes];
}

/** Read + validate one actor; returns the authoritative seeded identity. */
async function readActor(
  prisma: PrismaService,
  runId: string,
  spec: ActorSpec,
  tenantId: string,
): Promise<SeededUser> {
  const email = actorEmail(runId, spec.functionalRole);

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    refuse(`${spec.functionalRole} user "${email}" not found`);
  }
  if (!user.isActive) {
    refuse(`${spec.functionalRole} user "${email}" is inactive`);
  }

  const memberships = await prisma.tenantMembership.findMany({
    where: { userId: user.id, tenantId },
    include: {
      role: {
        include: { permissions: { include: { permission: true } } },
      },
    },
  });
  if (memberships.length !== 1) {
    refuse(
      `${spec.functionalRole} user has no single membership in the expected fictional tenant`,
    );
  }

  const permissionCodes = assertActorAuthorization(
    spec.functionalRole,
    tenantId,
    memberships[0],
    spec.expectedCodes,
  );

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    tenantId,
    permissionCodes,
    functionalRole: spec.functionalRole,
    createdAt: user.createdAt,
  };
}

/** Validate the pending OPEN 50000 session against the exact cashier. */
async function assertCashierSession(
  prisma: PrismaService,
  sessionId: string,
  cashier: SeededUser,
): Promise<void> {
  const session = await prisma.cashSession.findUnique({
    where: { id: sessionId },
    include: { register: true },
  });
  if (!session) {
    refuse(`cash session "${sessionId}" not found`);
  }
  if (session.tenantId !== cashier.tenantId) {
    refuse('cash session belongs to a different tenant');
  }
  if (session.cashierUserId !== cashier.id) {
    refuse('cash session cashier is not the validated cashier');
  }
  if (session.status !== OPEN_SESSION_STATUS) {
    refuse(`cash session status is not ${OPEN_SESSION_STATUS}`);
  }
  if (session.openingCents !== REQUIRED_OPENING_CENTS) {
    refuse(
      `cash session openingCents is not ${REQUIRED_OPENING_CENTS}`,
    );
  }
  if (!session.register || session.register.tenantId !== cashier.tenantId) {
    refuse('cash session register does not belong to the cashier tenant');
  }
}

/**
 * Reconstruct the existing fictional `SeedResult` for `runId` after
 * validating the exact seeded identities and the pending cashier session.
 *
 * READ-ONLY: never creates, updates, upserts, deletes or transacts.
 *
 * @param prisma real `PrismaService` (only read methods are used)
 * @param runId  fictional lowercase-alphanumeric run id (seeded naming)
 * @param sessionId existing OPEN session id owned by the seeded cashier
 * @returns the same shape as `seedFictionalDataset`
 */
export async function restoreExistingDataset(
  prisma: PrismaService,
  runId: string,
  sessionId: string,
): Promise<SeedResult> {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) {
    refuse(
      'runId must be a lowercase alphanumeric fictional slug used for tenant slugs and actor emails',
    );
  }
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    refuse('sessionId must be a non-empty string');
  }

  const tenantA = await prisma.tenant.findUnique({
    where: { slug: tenantSlug(runId, 'a') },
  });
  const tenantB = await prisma.tenant.findUnique({
    where: { slug: tenantSlug(runId, 'b') },
  });
  if (!tenantA || !tenantB) {
    refuse(`expected fictional tenants for runId "${runId}" were not found`);
  }

  const tenants: Record<'a' | 'b', SeededTenant> = {
    a: { id: tenantA.id, name: tenantA.name, slug: tenantA.slug },
    b: { id: tenantB.id, name: tenantB.name, slug: tenantB.slug },
  };

  const users = {} as SeedResult['users'];
  for (const spec of ACTOR_SPECS) {
    users[spec.functionalRole] = await readActor(
      prisma,
      runId,
      spec,
      tenants[spec.tenant].id,
    );
  }

  await assertCashierSession(prisma, sessionId, users.cashier);

  const permissionsSeeded = new Set([
    ...CASHIER_PERMISSION_CODES,
    ...VERIFIER_PERMISSION_CODES,
    ...FOREIGN_PERMISSION_CODES,
  ]).size;

  return {
    runId,
    tenants: [tenants.a, tenants.b],
    users,
    permissionsSeeded,
  };
}
