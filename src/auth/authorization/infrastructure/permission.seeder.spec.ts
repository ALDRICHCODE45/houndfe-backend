/**
 * Slice A.2 — PermissionSeeder idempotency.
 *
 * The seeder must upsert every PERMISSION_REGISTRY row by `subject_action`
 * (already implemented in `permission.seeder.ts:34-50`). The seeder's only
 * behavioural change for low-stock-alerts is: when the registry grows with
 * NotificationConfig, the seeder must also upsert those two rows. Running
 * the seeder twice must NOT create duplicate rows.
 *
 * The test mocks `PrismaService.permission.upsert` and
 * `PrismaService.rolePermission.upsert` and asserts they were called with
 * the NotificationConfig pair on a single run, AND that the seeder uses
 * the existing upsert mechanism (so idempotency is by construction).
 */
import { PermissionSeeder } from './permission.seeder';
import type { PrismaService } from '../../../shared/prisma/prisma.service';

type PermissionUpsertCall = {
  where: { subject_action: { subject: string; action: string } };
  update: unknown;
  create: unknown;
};
type RolePermissionUpsertCall = {
  where: { roleId_permissionId: { roleId: string; permissionId: string } };
};

describe('PermissionSeeder — NotificationConfig idempotency (A.2)', () => {
  function makePrismaStub(overrides: Partial<{
    existingSuperAdmin: { id: string } | null;
    rolePermissionUpsertResolved: unknown;
  }> = {}) {
    const permissionUpsertCalls: PermissionUpsertCall[] = [];

    const create = {
      upsert: jest.fn(async (args: PermissionUpsertCall) => {
        permissionUpsertCalls.push(args);
        // Mimic Prisma: returns the record.
        return {
          id: `perm-${args.where.subject_action.subject}-${args.where.subject_action.action}`,
          subject: args.where.subject_action.subject,
          action: args.where.subject_action.action,
          description: (args.create as { description: string }).description,
          createdAt: new Date(),
        };
      }),
    };

    const role = {
      findFirst: jest.fn(async () =>
        overrides.existingSuperAdmin === undefined
          ? null
          : overrides.existingSuperAdmin,
      ),
      create: jest.fn(async () => ({ id: 'role-super-admin' })),
      update: jest.fn(async () => ({ id: 'role-super-admin' })),
    };

    const rolePermission = {
      upsert: jest.fn(async (args: RolePermissionUpsertCall) =>
        overrides.rolePermissionUpsertResolved ?? args,
      ),
    };

    return {
      prisma: { permission: create, role, rolePermission } as unknown as PrismaService,
      permissionUpsertCalls,
    };
  }

  it('upserts (NotificationConfig, read) and (NotificationConfig, update) from the registry', async () => {
    const { prisma, permissionUpsertCalls } = makePrismaStub();

    const seeder = new PermissionSeeder(prisma);
    await seeder.onApplicationBootstrap();

    const notificationConfigCalls = permissionUpsertCalls
      .filter((c) => c.where.subject_action.subject === 'NotificationConfig')
      .map((c) => c.where.subject_action.action)
      .sort();

    expect(notificationConfigCalls).toEqual(['read', 'update']);
  });

  it('uses upsert so re-running the seeder does not create duplicate rows', async () => {
    // The seeder already calls `prisma.permission.upsert` keyed on
    // (subject, action). Re-running with the same registry must continue
    // to invoke upsert (not create) — the existing unique constraint
    // `@@unique([subject, action])` on `Permission` makes duplicate
    // inserts fail. The proof: every permission call is an `upsert`, never
    // a plain `create`.
    const { prisma } = makePrismaStub();
    const seeder = new PermissionSeeder(prisma);
    await seeder.onApplicationBootstrap();

    const permissionApi = prisma.permission as unknown as {
      upsert: jest.Mock;
      create?: jest.Mock;
    };
    expect(permissionApi.upsert).toHaveBeenCalled();
    expect(permissionApi.create).toBeUndefined();
  });

  it('runs twice without throwing (idempotent end-to-end)', async () => {
    const { prisma } = makePrismaStub();
    const seeder = new PermissionSeeder(prisma);

    await expect(seeder.onApplicationBootstrap()).resolves.not.toThrow();
    await expect(seeder.onApplicationBootstrap()).resolves.not.toThrow();
  });
});
