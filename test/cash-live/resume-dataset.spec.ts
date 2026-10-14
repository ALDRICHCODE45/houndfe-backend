/**
 * cash-live harness — existing-dataset reconstruction checks (offline unit).
 *
 * The resume path is READ-ONLY by contract: it reconstructs the exact
 * `SeedResult` shape from authoritative DB rows (users, tenants,
 * memberships, role-permissions) and refuses any identity that is not
 * byte-for-byte the fictional seed:
 *   - inactive user;
 *   - missing tenant / missing user / missing or wrong-tenant membership;
 *   - system role, `Super Admin` role, or a global role;
 *   - `manage:all` (elevated);
 *   - a subset or a superset of the expected permission set.
 *
 * The session argument must match the seeded cashier's OPEN session:
 * exact tenant, exact cashier, exact register, status OPEN, opening 50000
 * cents.
 *
 * No DB, no Nest, no server start. The Prisma double exposes ONLY read
 * methods; every mutation and root transaction method is a spy that
 * throws, and each test asserts the whole spy set was never called.
 */
import type { PrismaService } from '../../src/shared/prisma/prisma.service';
import {
  CASHIER_PERMISSION_CODES,
  FOREIGN_PERMISSION_CODES,
  VERIFIER_PERMISSION_CODES,
} from './seed';
import {
  REQUIRED_OPENING_CENTS,
  restoreExistingDataset,
} from './resume-dataset';

/** Fictional run id with the seeder's lowercase-alphanumeric shape. */
const RUN_ID = 'm1abc2def345';
const SESSION_ID = '11111111-2222-4333-8444-555555555555';

interface TenantRow {
  id: string;
  name: string;
  slug: string;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  createdAt: Date;
}

interface RoleRow {
  id: string;
  name: string;
  tenantId: string | null;
  isSystem: boolean;
  permissions: Array<{ permission: { action: string; subject: string } }>;
}

interface MembershipRow {
  tenantId: string;
  role: RoleRow;
}

interface SessionRow {
  id: string;
  tenantId: string;
  registerId: string;
  cashierUserId: string;
  status: string;
  openingCents: number;
  register: { id: string; tenantId: string };
}

interface Dataset {
  tenants: TenantRow[];
  users: UserRow[];
  memberships: Record<string, MembershipRow[]>;
  session: SessionRow | null;
}

function permissionRows(
  codes: readonly string[],
): Array<{ permission: { action: string; subject: string } }> {
  return codes.map((code) => {
    const separator = code.indexOf(':');
    return {
      permission: {
        action: code.slice(0, separator),
        subject: code.slice(separator + 1),
      },
    };
  });
}

function buildDataset(): Dataset {
  const tenantA: TenantRow = {
    id: 'tenant-a',
    name: `Cash Live Tenant A ${RUN_ID}`,
    slug: `cash-live-a-${RUN_ID}`,
  };
  const tenantB: TenantRow = {
    id: 'tenant-b',
    name: `Cash Live Tenant B ${RUN_ID}`,
    slug: `cash-live-b-${RUN_ID}`,
  };
  const cashier: UserRow = {
    id: 'user-cashier',
    email: `cashier-a.${RUN_ID}@cash-live.test`,
    name: 'Cashier A (cash-live)',
    isActive: true,
    createdAt: new Date('2025-01-02T03:04:05.000Z'),
  };
  const verifier: UserRow = {
    id: 'user-verifier',
    email: `verifier-b.${RUN_ID}@cash-live.test`,
    name: 'Verifier B (cash-live)',
    isActive: true,
    createdAt: new Date('2025-01-02T03:04:06.000Z'),
  };
  const foreign: UserRow = {
    id: 'user-foreign',
    email: `foreign.${RUN_ID}@cash-live.test`,
    name: 'Foreign Cashier (cash-live)',
    isActive: true,
    createdAt: new Date('2025-01-02T03:04:07.000Z'),
  };

  return {
    tenants: [tenantA, tenantB],
    users: [cashier, verifier, foreign],
    memberships: {
      [cashier.id]: [
        {
          tenantId: tenantA.id,
          role: {
            id: 'role-cashier',
            name: `cash-live cashier ${RUN_ID}`,
            tenantId: tenantA.id,
            isSystem: false,
            permissions: permissionRows(CASHIER_PERMISSION_CODES),
          },
        },
      ],
      [verifier.id]: [
        {
          tenantId: tenantA.id,
          role: {
            id: 'role-verifier',
            name: `cash-live verifier ${RUN_ID}`,
            tenantId: tenantA.id,
            isSystem: false,
            permissions: permissionRows(VERIFIER_PERMISSION_CODES),
          },
        },
      ],
      [foreign.id]: [
        {
          tenantId: tenantB.id,
          role: {
            id: 'role-foreign',
            name: `cash-live foreign ${RUN_ID}`,
            tenantId: tenantB.id,
            isSystem: false,
            permissions: permissionRows(FOREIGN_PERMISSION_CODES),
          },
        },
      ],
    },
    session: {
      id: SESSION_ID,
      tenantId: tenantA.id,
      registerId: 'register-1',
      cashierUserId: cashier.id,
      status: 'OPEN',
      openingCents: REQUIRED_OPENING_CENTS,
      register: { id: 'register-1', tenantId: tenantA.id },
    },
  };
}

function userByEmail(dataset: Dataset, email: string): UserRow {
  const user = dataset.users.find((u) => u.email === email);
  if (!user) throw new Error(`test fixture: user ${email} missing`);
  return user;
}

function membershipOf(dataset: Dataset, userId: string): MembershipRow {
  const rows = dataset.memberships[userId];
  if (!rows || rows.length === 0) {
    throw new Error(`test fixture: membership for ${userId} missing`);
  }
  return rows[0];
}

const MODEL_MUTATIONS = [
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
] as const;

const UNSAFE_ROOT_METHODS = [
  '$transaction',
  '$executeRaw',
  '$executeRawUnsafe',
  '$queryRaw',
  '$queryRawUnsafe',
  '$connect',
  '$disconnect',
] as const;

interface PrismaDouble {
  prisma: PrismaService;
  readSpies: Record<string, jest.Mock>;
  mutationSpies: Record<string, jest.Mock>;
}

/** Read-only Prisma double: every mutation/root method throws if called. */
function createPrismaDouble(dataset: Dataset): PrismaDouble {
  const mutationSpies: Record<string, jest.Mock> = {};
  const guard = (label: string) =>
    jest.fn((): never => {
      throw new Error(`mutation attempted: ${label}`);
    });

  const readSpies: Record<string, jest.Mock> = {
    tenantFindUnique: jest.fn(
      async ({ where }: { where: { slug: string } }) =>
        dataset.tenants.find((t) => t.slug === where.slug) ?? null,
    ),
    userFindUnique: jest.fn(
      async ({ where }: { where: { email: string } }) =>
        dataset.users.find((u) => u.email === where.email) ?? null,
    ),
    tenantMembershipFindMany: jest.fn(
      async ({ where }: { where: { userId: string; tenantId: string } }) =>
        (dataset.memberships[where.userId] ?? []).filter(
          (m) => m.tenantId === where.tenantId,
        ),
    ),
    cashSessionFindUnique: jest.fn(
      async ({ where }: { where: { id: string } }) =>
        dataset.session && dataset.session.id === where.id
          ? dataset.session
          : null,
    ),
  };

  const model = (
    name: string,
    reads: Record<string, jest.Mock>,
  ): Record<string, jest.Mock> => {
    const obj: Record<string, jest.Mock> = { ...reads };
    for (const method of MODEL_MUTATIONS) {
      const spy = guard(`${name}.${method}`);
      mutationSpies[`${name}.${method}`] = spy;
      obj[method] = spy;
    }
    return obj;
  };

  const prisma: Record<string, unknown> = {
    tenant: model('tenant', { findUnique: readSpies.tenantFindUnique }),
    user: model('user', { findUnique: readSpies.userFindUnique }),
    tenantMembership: model('tenantMembership', {
      findMany: readSpies.tenantMembershipFindMany,
    }),
    cashSession: model('cashSession', {
      findUnique: readSpies.cashSessionFindUnique,
    }),
  };
  for (const method of UNSAFE_ROOT_METHODS) {
    const spy = guard(method);
    mutationSpies[method] = spy;
    prisma[method] = spy;
  }

  return {
    prisma: prisma as unknown as PrismaService,
    readSpies,
    mutationSpies,
  };
}

/** Fail with the offending method name when any mutation/root spy ran. */
function expectNoMutations(spies: Record<string, jest.Mock>): void {
  for (const [label, spy] of Object.entries(spies)) {
    expect({ label, calls: spy.mock.calls.length }).toEqual({
      label,
      calls: 0,
    });
  }
}

describe('restoreExistingDataset', () => {
  it('reconstructs the exact SeedResult from authoritative rows without mutating', async () => {
    const dataset = buildDataset();
    const { prisma, readSpies, mutationSpies } = createPrismaDouble(dataset);

    const result = await restoreExistingDataset(prisma, RUN_ID, SESSION_ID);

    expect(result.runId).toBe(RUN_ID);
    expect(result.tenants).toEqual([
      { id: 'tenant-a', name: `Cash Live Tenant A ${RUN_ID}`, slug: `cash-live-a-${RUN_ID}` },
      { id: 'tenant-b', name: `Cash Live Tenant B ${RUN_ID}`, slug: `cash-live-b-${RUN_ID}` },
    ]);
    expect(result.users.cashier).toMatchObject({
      id: 'user-cashier',
      email: `cashier-a.${RUN_ID}@cash-live.test`,
      tenantId: 'tenant-a',
      functionalRole: 'cashier',
      permissionCodes: [...CASHIER_PERMISSION_CODES],
    });
    expect(result.users.verifier).toMatchObject({
      id: 'user-verifier',
      tenantId: 'tenant-a',
      functionalRole: 'verifier',
      permissionCodes: [...VERIFIER_PERMISSION_CODES],
    });
    expect(result.users.foreign).toMatchObject({
      id: 'user-foreign',
      tenantId: 'tenant-b',
      functionalRole: 'foreign',
      permissionCodes: [...FOREIGN_PERMISSION_CODES],
    });
    expect(result.users.cashier.createdAt).toEqual(
      userByEmail(dataset, `cashier-a.${RUN_ID}@cash-live.test`).createdAt,
    );
    expect(result.permissionsSeeded).toBe(
      new Set([...CASHIER_PERMISSION_CODES, ...VERIFIER_PERMISSION_CODES]).size,
    );

    // Authoritative read path: 2 tenants, 3 users, 3 memberships, 1 session.
    expect(readSpies.tenantFindUnique).toHaveBeenCalledTimes(2);
    expect(readSpies.userFindUnique).toHaveBeenCalledTimes(3);
    expect(readSpies.tenantMembershipFindMany).toHaveBeenCalledTimes(3);
    expect(readSpies.cashSessionFindUnique).toHaveBeenCalledTimes(1);
    expectNoMutations(mutationSpies);
  });

  it.each([
    ['ABC'],
    ['has space'],
    ['semi;colon'],
    ['a/b'],
    ['x@y'],
    [''],
  ])('rejects invalid runId %p before touching the database', async (bad) => {
    const { prisma, readSpies, mutationSpies } = createPrismaDouble(
      buildDataset(),
    );

    await expect(restoreExistingDataset(prisma, bad, SESSION_ID)).rejects.toThrow(
      /runId/,
    );

    expect(readSpies.tenantFindUnique).not.toHaveBeenCalled();
    expect(readSpies.userFindUnique).not.toHaveBeenCalled();
    expect(readSpies.tenantMembershipFindMany).not.toHaveBeenCalled();
    expect(readSpies.cashSessionFindUnique).not.toHaveBeenCalled();
    expectNoMutations(mutationSpies);
  });

  it('rejects a non-empty-string sessionId before touching the database', async () => {
    const { prisma, readSpies, mutationSpies } = createPrismaDouble(
      buildDataset(),
    );

    await expect(restoreExistingDataset(prisma, RUN_ID, '')).rejects.toThrow(
      /session/i,
    );

    expect(readSpies.tenantFindUnique).not.toHaveBeenCalled();
    expectNoMutations(mutationSpies);
  });

  it('rejects when either fictional tenant is missing', async () => {
    const dataset = buildDataset();
    dataset.tenants = dataset.tenants.filter(
      (t) => t.slug !== `cash-live-b-${RUN_ID}`,
    );
    const { prisma, mutationSpies } = createPrismaDouble(dataset);

    await expect(
      restoreExistingDataset(prisma, RUN_ID, SESSION_ID),
    ).rejects.toThrow(/tenant/i);
    expectNoMutations(mutationSpies);
  });

  it('rejects a missing actor', async () => {
    const dataset = buildDataset();
    dataset.users = dataset.users.filter(
      (u) => u.email !== `verifier-b.${RUN_ID}@cash-live.test`,
    );
    const { prisma, mutationSpies } = createPrismaDouble(dataset);

    await expect(
      restoreExistingDataset(prisma, RUN_ID, SESSION_ID),
    ).rejects.toThrow(/not found/i);
    expectNoMutations(mutationSpies);
  });

  it('rejects an inactive actor', async () => {
    const dataset = buildDataset();
    userByEmail(dataset, `cashier-a.${RUN_ID}@cash-live.test`).isActive = false;
    const { prisma, mutationSpies } = createPrismaDouble(dataset);

    await expect(
      restoreExistingDataset(prisma, RUN_ID, SESSION_ID),
    ).rejects.toThrow(/inactive/i);
    expectNoMutations(mutationSpies);
  });

  it('rejects an actor whose membership is in a different tenant', async () => {
    const dataset = buildDataset();
    membershipOf(dataset, 'user-cashier').tenantId = 'tenant-b';
    const { prisma, mutationSpies } = createPrismaDouble(dataset);

    await expect(
      restoreExistingDataset(prisma, RUN_ID, SESSION_ID),
    ).rejects.toThrow(/membership|tenant/i);
    expectNoMutations(mutationSpies);
  });

  it('rejects a role that belongs to a different tenant or is global', async () => {
    const dataset = buildDataset();
    membershipOf(dataset, 'user-foreign').role.tenantId = 'tenant-a';
    const { prisma, mutationSpies } = createPrismaDouble(dataset);

    await expect(
      restoreExistingDataset(prisma, RUN_ID, SESSION_ID),
    ).rejects.toThrow(/tenant|global/i);
    expectNoMutations(mutationSpies);
  });

  it('rejects a system role', async () => {
    const dataset = buildDataset();
    membershipOf(dataset, 'user-cashier').role.isSystem = true;
    const { prisma, mutationSpies } = createPrismaDouble(dataset);

    await expect(
      restoreExistingDataset(prisma, RUN_ID, SESSION_ID),
    ).rejects.toThrow(/system/i);
    expectNoMutations(mutationSpies);
  });

  it('rejects the Super Admin role', async () => {
    const dataset = buildDataset();
    membershipOf(dataset, 'user-verifier').role.name = 'Super Admin';
    const { prisma, mutationSpies } = createPrismaDouble(dataset);

    await expect(
      restoreExistingDataset(prisma, RUN_ID, SESSION_ID),
    ).rejects.toThrow(/Super Admin/);
    expectNoMutations(mutationSpies);
  });

  it('rejects an elevated actor holding manage:all', async () => {
    const dataset = buildDataset();
    membershipOf(dataset, 'user-cashier').role.permissions.push({
      permission: { action: 'manage', subject: 'all' },
    });
    const { prisma, mutationSpies } = createPrismaDouble(dataset);

    await expect(
      restoreExistingDataset(prisma, RUN_ID, SESSION_ID),
    ).rejects.toThrow(/manage:all|elevated/i);
    expectNoMutations(mutationSpies);
  });

  it('rejects a superset of the expected permission set', async () => {
    const dataset = buildDataset();
    membershipOf(dataset, 'user-cashier').role.permissions.push({
      permission: { action: 'read', subject: 'Sale' },
    });
    const { prisma, mutationSpies } = createPrismaDouble(dataset);

    await expect(
      restoreExistingDataset(prisma, RUN_ID, SESSION_ID),
    ).rejects.toThrow(/unexpected|superset/i);
    expectNoMutations(mutationSpies);
  });

  it('rejects a subset of the expected permission set', async () => {
    const dataset = buildDataset();
    membershipOf(dataset, 'user-verifier').role.permissions.pop();
    const { prisma, mutationSpies } = createPrismaDouble(dataset);

    await expect(
      restoreExistingDataset(prisma, RUN_ID, SESSION_ID),
    ).rejects.toThrow(/missing|subset/i);
    expectNoMutations(mutationSpies);
  });

  it('rejects a missing session', async () => {
    const dataset = buildDataset();
    dataset.session = null;
    const { prisma, mutationSpies } = createPrismaDouble(dataset);

    await expect(
      restoreExistingDataset(prisma, RUN_ID, SESSION_ID),
    ).rejects.toThrow(/session/i);
    expectNoMutations(mutationSpies);
  });

  it('rejects a session in a different tenant', async () => {
    const dataset = buildDataset();
    (dataset.session as SessionRow).tenantId = 'tenant-b';
    const { prisma, mutationSpies } = createPrismaDouble(dataset);

    await expect(
      restoreExistingDataset(prisma, RUN_ID, SESSION_ID),
    ).rejects.toThrow(/tenant/i);
    expectNoMutations(mutationSpies);
  });

  it('rejects a session belonging to a different cashier', async () => {
    const dataset = buildDataset();
    (dataset.session as SessionRow).cashierUserId = 'user-verifier';
    const { prisma, mutationSpies } = createPrismaDouble(dataset);

    await expect(
      restoreExistingDataset(prisma, RUN_ID, SESSION_ID),
    ).rejects.toThrow(/cashier/i);
    expectNoMutations(mutationSpies);
  });

  it('rejects a session that is not OPEN', async () => {
    const dataset = buildDataset();
    (dataset.session as SessionRow).status = 'COUNTING';
    const { prisma, mutationSpies } = createPrismaDouble(dataset);

    await expect(
      restoreExistingDataset(prisma, RUN_ID, SESSION_ID),
    ).rejects.toThrow(/OPEN/);
    expectNoMutations(mutationSpies);
  });

  it('rejects a session whose opening amount is not 50000 cents', async () => {
    const dataset = buildDataset();
    (dataset.session as SessionRow).openingCents = 50001;
    const { prisma, mutationSpies } = createPrismaDouble(dataset);

    await expect(
      restoreExistingDataset(prisma, RUN_ID, SESSION_ID),
    ).rejects.toThrow(/50000/);
    expectNoMutations(mutationSpies);
  });

  it('rejects a session whose register is not in the cashier tenant', async () => {
    const dataset = buildDataset();
    (dataset.session as SessionRow).register = {
      id: 'register-1',
      tenantId: 'tenant-b',
    };
    const { prisma, mutationSpies } = createPrismaDouble(dataset);

    await expect(
      restoreExistingDataset(prisma, RUN_ID, SESSION_ID),
    ).rejects.toThrow(/register/i);
    expectNoMutations(mutationSpies);
  });

  it('never invokes a mutation or root transaction on any failure path', async () => {
    const cases: Dataset[] = [];
    const inactive = buildDataset();
    userByEmail(inactive, `foreign.${RUN_ID}@cash-live.test`).isActive = false;
    cases.push(inactive);
    const noSession = buildDataset();
    noSession.session = null;
    cases.push(noSession);
    const subset = buildDataset();
    membershipOf(subset, 'user-cashier').role.permissions.pop();
    cases.push(subset);

    for (const dataset of cases) {
      const { prisma, mutationSpies } = createPrismaDouble(dataset);
      await expect(
        restoreExistingDataset(prisma, RUN_ID, SESSION_ID),
      ).rejects.toThrow();
      expectNoMutations(mutationSpies);
    }
  });
});
