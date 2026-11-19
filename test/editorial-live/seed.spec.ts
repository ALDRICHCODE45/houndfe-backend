/**
 * editorial-live harness — seed shape (offline, recording fake Prisma).
 *
 * No DB: a recording fake stands in for PrismaService so the exact rows the
 * seed writes for each actor are asserted. The real-DB proof is the
 * parent-authorized live run (T2).
 */
import { seedEditorialLiveDataset } from './seed';

type Call = { model: string; method: string; args: Record<string, unknown> };
type Raw = {
  kind: '$executeRaw' | '$queryRaw';
  sql: string;
  values: unknown[];
};

function fakePrisma(
  options: {
    existingSuperAdminRole?: { id: string } | null;
    storedSemanticsVersion?: string;
  } = {},
) {
  const calls: Call[] = [];
  const raws: Raw[] = [];
  let transactions = 0;
  let seq = 0;
  const id = (prefix: string) => `${prefix}-${++seq}`;
  const record =
    (
      model: string,
      method: string,
      result: (args: Record<string, unknown>) => unknown,
    ) =>
    (args: Record<string, unknown>) => {
      calls.push({ model, method, args });
      return Promise.resolve(result(args));
    };
  const tx = {
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      raws.push({ kind: '$executeRaw', sql: strings.join('?'), values });
      return Promise.resolve(1);
    },
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      raws.push({ kind: '$queryRaw', sql, values });
      if (sql.includes('FROM "permissions"'))
        return Promise.resolve([{ id: `perm-${String(values[1])}` }]);
      if (sql.includes('editorial_vocabulary_metadata'))
        return Promise.resolve([
          {
            semanticsVersion:
              options.storedSemanticsVersion ?? 'editorial-production-1',
          },
        ]);
      return Promise.resolve([]);
    },
    tenant: {
      update: record('tenant', 'update', (a) => ({
        id: (a.where as { id: string }).id,
        ...(a.data as object),
      })),
    },
    permission: {
      upsert: record('permission', 'upsert', (a) => ({
        id: `perm-${(a.create as { action: string }).action}-${(a.create as { subject: string }).subject}`,
      })),
    },
    role: {
      findFirst: record('role', 'findFirst', () =>
        options.existingSuperAdminRole === undefined
          ? null
          : options.existingSuperAdminRole,
      ),
      create: record('role', 'create', (a) => ({
        id: id('role'),
        ...(a.data as object),
      })),
      update: record('role', 'update', (a) => ({
        id: (a.where as { id: string }).id,
        ...(a.data as object),
      })),
    },
    rolePermission: { upsert: record('rolePermission', 'upsert', () => ({})) },
    product: {
      update: record('product', 'update', (a) => {
        const productId = (a.where as { id: string }).id;
        const insert = raws.find(
          (r) =>
            r.sql.includes('INSERT INTO "products"') &&
            r.values[0] === productId,
        );
        return {
          id: productId,
          tenantId: insert?.values[1],
          ...(a.data as object),
        };
      }),
    },
    user: {
      create: record('user', 'create', (a) => ({
        ...(a.data as object),
        createdAt: new Date('2026-11-18T00:00:00Z'),
      })),
      findUniqueOrThrow: record('user', 'findUniqueOrThrow', (a) => ({
        id: (a.where as { id: string }).id,
        email: `${(a.where as { id: string }).id}@example.invalid`,
        name: 'Synthetic editorial user',
        createdAt: new Date('2026-11-18T00:00:00Z'),
      })),
    },
    tenantMembership: {
      create: record('tenantMembership', 'create', () => ({})),
    },
  };
  const prisma = {
    ...tx,
    $transaction: (fn: (client: typeof tx) => Promise<unknown>) => {
      transactions += 1;
      return fn(tx);
    },
  };
  return {
    prisma,
    calls,
    raws,
    transactions: () => transactions,
    find: (model: string, method: string) =>
      calls.filter((c) => c.model === model && c.method === method),
  };
}

describe('seedEditorialLiveDataset', () => {
  jest.setTimeout(30_000);

  it('seeds everything inside ONE transaction, reusing seedEditorialPostgres', async () => {
    const f = fakePrisma();
    const seed = await seedEditorialLiveDataset(f.prisma as never, 'run1');
    expect(f.transactions()).toBe(1);
    const tenantInserts = f.raws.filter((r) =>
      r.sql.includes('INSERT INTO "tenants"'),
    );
    expect(tenantInserts).toHaveLength(2);
    expect(seed.tenants.a.id).toBe(tenantInserts[0].values[0]);
    expect(seed.tenants.foreign.id).toBe(tenantInserts[1].values[0]);
    expect(seed.product.tenantId).toBe(seed.tenants.a.id);
    expect(seed.product.foreignTenantId).toBe(seed.tenants.foreign.id);
    expect(seed.runId).toBe('run1');
  });

  it('applies the draft-runtime binding patch and pins vocabulary metadata (S4)', async () => {
    const f = fakePrisma();
    const seed = await seedEditorialLiveDataset(f.prisma as never, 'run1');
    const patch = f.raws.find(
      (r) =>
        r.kind === '$executeRaw' &&
        r.sql.includes('UPDATE "editorial_bindings"'),
    );
    expect(patch?.sql).toContain(`"publicationCheck" = 'when_asserted'`);
    expect(patch?.sql).toContain(`'{"route":"pending"}'::jsonb`);
    expect(patch?.values).toEqual([seed.editorial.familyCode]);
    const metadata = f.raws.find(
      (r) =>
        r.kind === '$executeRaw' &&
        r.sql.includes('INSERT INTO "editorial_vocabulary_metadata"'),
    );
    expect(metadata?.sql).toContain('ON CONFLICT ("id") DO NOTHING');
    expect(metadata?.sql).toContain(`'editorial-production-1'`);
    expect(seed.editorial.semanticsVersion).toBe('editorial-production-1');
  });

  it('fails closed when stored vocabulary metadata has another semantics version', async () => {
    const f = fakePrisma({ storedSemanticsVersion: 'editorial-other' });
    await expect(
      seedEditorialLiveDataset(f.prisma as never, 'run1'),
    ).rejects.toThrow('vocabulary metadata');
  });

  it('global Super Admin: system "Super Admin" role with tenantId null + manage:all, member of both tenants', async () => {
    const f = fakePrisma();
    const seed = await seedEditorialLiveDataset(f.prisma as never, 'run1');
    expect(f.find('role', 'findFirst')[0].args).toEqual({
      where: { name: 'Super Admin', tenantId: null },
    });
    const created = f
      .find('role', 'create')
      .find((c) => (c.args.data as { name: string }).name === 'Super Admin');
    expect(created?.args.data).toEqual({
      name: 'Super Admin',
      description: 'Full system access',
      isSystem: true,
    });
    const manageAll = f.find('permission', 'upsert').find(
      (c) =>
        JSON.stringify(c.args.where) ===
        JSON.stringify({
          subject_action: { subject: 'all', action: 'manage' },
        }),
    );
    expect(manageAll).toBeDefined();
    const superRoleId = seed.actors['superadmin-global'].memberships[0].roleId;
    expect(f.find('rolePermission', 'upsert')[0].args).toEqual({
      where: {
        roleId_permissionId: {
          roleId: superRoleId,
          permissionId: 'perm-manage-all',
        },
      },
      update: {},
      create: { roleId: superRoleId, permissionId: 'perm-manage-all' },
    });
    const memberships = f
      .find('tenantMembership', 'create')
      .map(
        (c) =>
          c.args.data as { userId: string; tenantId: string; roleId: string },
      )
      .filter((m) => m.userId === seed.actors['superadmin-global'].userId);
    expect(memberships).toEqual([
      {
        userId: seed.actors['superadmin-global'].userId,
        tenantId: seed.tenants.a.id,
        roleId: superRoleId,
      },
      {
        userId: seed.actors['superadmin-global'].userId,
        tenantId: seed.tenants.foreign.id,
        roleId: superRoleId,
      },
    ]);
    expect(seed.actors['superadmin-global']).toMatchObject({
      selectedTenant: null,
      isSuperAdmin: true,
      permissionCodes: ['manage:all'],
    });
    expect(
      seed.actors['superadmin-global'].memberships.every(
        (m) => m.roleTenantId === null && m.roleName === 'Super Admin',
      ),
    ).toBe(true);
  });

  it('reuses an existing Super Admin role exactly like PermissionSeeder (no duplicate)', async () => {
    const f = fakePrisma({ existingSuperAdminRole: { id: 'existing-super' } });
    const seed = await seedEditorialLiveDataset(f.prisma as never, 'run1');
    expect(
      f
        .find('role', 'create')
        .some((c) => (c.args.data as { name: string }).name === 'Super Admin'),
    ).toBe(false);
    expect(f.find('role', 'update')[0].args).toEqual({
      where: { id: 'existing-super' },
      data: { description: 'Full system access', isSystem: true },
    });
    expect(seed.actors['superadmin-global'].memberships[0].roleId).toBe(
      'existing-super',
    );
  });

  it('Super Admin with tenant A selected is a DISTINCT Super Admin user with the same global role', async () => {
    const f = fakePrisma();
    const seed = await seedEditorialLiveDataset(f.prisma as never, 'run1');
    const global = seed.actors['superadmin-global'];
    const selected = seed.actors['superadmin-tenant'];
    expect(selected.userId).not.toBe(global.userId);
    expect(selected.email).not.toBe(global.email);
    expect(selected.selectedTenant).toEqual(seed.tenants.a);
    expect(selected.isSuperAdmin).toBe(true);
    const superRoleId = global.memberships[0].roleId;
    expect(
      f
        .find('tenantMembership', 'create')
        .map((c) => c.args.data)
        .filter((m) => (m as { userId: string }).userId === selected.userId),
    ).toEqual([
      {
        userId: selected.userId,
        tenantId: seed.tenants.a.id,
        roleId: superRoleId,
      },
      {
        userId: selected.userId,
        tenantId: seed.tenants.foreign.id,
        roleId: superRoleId,
      },
    ]);
  });

  it('every actor is a distinct user', async () => {
    const f = fakePrisma();
    const seed = await seedEditorialLiveDataset(f.prisma as never, 'run1');
    const ids = Object.values(seed.actors).map((a) => a.userId);
    expect(new Set(ids).size).toBe(4);
    expect(Object.keys(seed.actors)).toEqual([
      'superadmin-global',
      'superadmin-tenant',
      'manage-all',
      'editorial-only',
    ]);
  });

  it('names the disposable editorial product with the run id', async () => {
    const f = fakePrisma();
    const seed = await seedEditorialLiveDataset(f.prisma as never, 'run1');
    expect(f.find('product', 'update')[0].args).toEqual({
      where: { id: seed.product.id },
      data: { name: 'Editorial Live Product run1' },
      select: { id: true, tenantId: true, name: true },
    });
    expect(seed.product.name).toBe('Editorial Live Product run1');
  });

  it('manage:all actor: tenant A role (not global, not system) with manage:all', async () => {
    const f = fakePrisma();
    const seed = await seedEditorialLiveDataset(f.prisma as never, 'run1');
    const role = f
      .find('role', 'create')
      .find(
        (c) =>
          (c.args.data as { name: string }).name ===
          'editorial-live manager run1',
      );
    expect(role?.args.data).toEqual({
      name: 'editorial-live manager run1',
      tenantId: seed.tenants.a.id,
      description: 'editorial-live disposable harness role (fictional)',
      permissions: { create: [{ permissionId: 'perm-manage-all' }] },
    });
    expect(
      f.find('tenantMembership', 'create').map((c) => c.args.data),
    ).toContainEqual({
      userId: seed.actors['manage-all'].userId,
      tenantId: seed.tenants.a.id,
      roleId: seed.actors['manage-all'].memberships[0].roleId,
    });
    expect(seed.actors['manage-all']).toMatchObject({
      selectedTenant: seed.tenants.a,
      isSuperAdmin: false,
      permissionCodes: ['manage:all'],
    });
  });

  it('editorial-only actor: seedEditorialPostgres user with exactly ProductEditorialDraft read+update in tenant A', async () => {
    const f = fakePrisma();
    const seed = await seedEditorialLiveDataset(f.prisma as never, 'run1');
    const userInsert = f.raws.find((r) =>
      r.sql.includes('INSERT INTO "users"'),
    );
    expect(seed.actors['editorial-only'].userId).toBe(userInsert?.values[0]);
    const grants = f.raws
      .filter((r) => r.sql.includes('INSERT INTO "permissions"'))
      .map((r) => `${String(r.values[2])}:${String(r.values[1])}`);
    expect(grants).toEqual([
      'read:ProductEditorialDraft',
      'update:ProductEditorialDraft',
    ]);
    expect(seed.actors['editorial-only']).toMatchObject({
      selectedTenant: seed.tenants.a,
      isSuperAdmin: false,
      permissionCodes: [
        'read:ProductEditorialDraft',
        'update:ProductEditorialDraft',
      ],
    });
    expect(seed.actors['editorial-only'].memberships).toHaveLength(1);
    expect(seed.actors['editorial-only'].memberships[0].tenantId).toBe(
      seed.tenants.a.id,
    );
  });

  it('renames the two tenants with the run id (names/slugs never collide across runs)', async () => {
    const f = fakePrisma();
    const seed = await seedEditorialLiveDataset(f.prisma as never, 'run1');
    expect(f.find('tenant', 'update').map((c) => c.args.data)).toEqual([
      { name: 'Editorial Live Tenant A run1', slug: 'editorial-live-a-run1' },
      {
        name: 'Editorial Live Foreign Tenant run1',
        slug: 'editorial-live-foreign-run1',
      },
    ]);
    expect(seed.tenants.a.slug).toBe('editorial-live-a-run1');
  });

  it('rejects a run id outside [a-z0-9]{1,64} before touching the database', async () => {
    const f = fakePrisma();
    await expect(
      seedEditorialLiveDataset(f.prisma as never, 'Bad Run'),
    ).rejects.toThrow();
    expect(f.transactions()).toBe(0);
  });
});
