import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { normalizeTestDatabaseUrl } from '../../../test/integration/setup/test-database-url';
import { SupplierQueries } from './supplier-queries';
import { SupplierCursor } from './supplier-cursor';

// Parent ONLY: existing integration config + fresh disposable ownership check.
// No execution is claimed by authoring this spec. Random owned fixtures remain
// in the disposable database; no cleanup deletion or shared role grants.
const describeDb =
  process.env.SKIP_DB_INTEGRATION === '1' ? describe.skip : describe;
describeDb('supplier reads PostgreSQL boundary', () => {
  let db: PrismaClient;
  beforeAll(() => {
    normalizeTestDatabaseUrl(process.env.DATABASE_URL, '[supplier-queries]');
    db = new PrismaClient();
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  async function fixture() {
    const tenantId = randomUUID();
    const otherTenantId = randomUUID();
    const actorId = randomUUID();
    const roleId = randomUUID();
    await db.$transaction(async (tx) => {
      for (const id of [tenantId, otherTenantId]) {
        await tx.tenant.create({
          data: { id, name: 'Owned supplier read proof', slug: id },
        });
      }
      await tx.user.create({
        data: {
          id: actorId,
          email: `${actorId}@supplier.invalid`,
          name: 'Owned reader',
          hashedPassword: 'not-a-login-hash',
        },
      });
      await tx.role.create({
        data: { id: roleId, tenantId, name: `Owned reader ${roleId}` },
      });
      const permission =
        (await tx.permission.findUnique({
          where: {
            subject_action: { subject: 'ProcurementSupplier', action: 'read' },
          },
        })) ??
        (await tx.permission.create({
          data: { subject: 'ProcurementSupplier', action: 'read' },
        }));
      await tx.rolePermission.create({
        data: { roleId, permissionId: permission.id },
      });
      await tx.tenantMembership.create({
        data: { tenantId, userId: actorId, roleId },
      });
    });
    const cls = new ClsService<TenantClsStore>(new AsyncLocalStorage());
    // SAFETY: Nest subclass lifecycle/configuration is not used by this fixture;
    // TenantPrismaService consumes only the real PrismaClient API.
    const tenantDb = new TenantPrismaService(db as PrismaService, cls);
    const cursor = new SupplierCursor(
      new ConfigService({ JWT_SECRET: 'offline-proof-only' }),
    );
    const service = new SupplierQueries(tenantDb, cls, cursor);
    const run = <T>(work: () => T, tenant = tenantId): T =>
      cls.runWith(
        { tenantId: tenant, userId: actorId, isSuperAdmin: false },
        work,
      );
    const time = new Date('2026-01-02T03:04:05.123Z');
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort().reverse();
    for (const [index, id] of ids.entries()) {
      await db.procurementSupplier.create({
        data: {
          id,
          tenantId,
          displayName: index === 1 ? 'Other supplier' : 'É_LITERAL%_\\supplier',
          termsText: null,
          status: index === 2 ? 'ARCHIVED' : 'ACTIVE',
          createdAt: time,
        },
      });
    }
    const foreign = await db.procurementSupplier.create({
      data: {
        tenantId: otherTenantId,
        displayName: 'É_LITERAL%_\\supplier',
        termsText: null,
        status: 'ACTIVE',
      },
    });
    return {
      tenantId,
      otherTenantId,
      actorId,
      roleId,
      ids,
      time,
      foreign,
      run,
      service,
    };
  }

  it('paginates tied timestamps descending by id without duplicates, count or business changes', async () => {
    const f = await fixture();
    const before = await db.procurementSupplier.findMany({
      where: { tenantId: f.tenantId },
      orderBy: { id: 'asc' },
    });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const result = await f.run(() =>
        f.service.list({
          status: 'ALL',
          limit: '1',
          ...(cursor ? { cursor } : {}),
        }),
      );
      expect(Object.keys(result)).toEqual(['items', 'nextCursor']);
      expect(result.items).toHaveLength(1);
      seen.push(result.items[0].id);
      expect(result.items[0].createdAt).toBe(f.time.toISOString());
      expect(Object.keys(result.items[0]).sort()).toEqual(
        [
          'id',
          'displayName',
          'termsText',
          'status',
          'version',
          'createdAt',
          'updatedAt',
        ].sort(),
      );
      if (page < 2) expect(result.nextCursor).toEqual(expect.any(String));
      else expect(result.nextCursor).toBeNull();
      cursor = result.nextCursor ?? undefined;
    }
    expect(seen).toEqual(f.ids);
    expect(
      await db.procurementSupplier.findMany({
        where: { tenantId: f.tenantId },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(before);
    const where = { tenantId: f.tenantId };
    expect(
      await Promise.all([
        db.procurementSupplierAudit.count({ where }),
        db.procurementSupplierReceipt.count({ where }),
        db.product.count({ where }),
        db.sale.count({ where }),
        db.salePayment.count({ where }),
        db.outboxEvent.count({ where }),
      ]),
    ).toEqual([0, 0, 0, 0, 0, 0]);
  });
  it('orders createdAt before id and continues across different millisecond timestamps', async () => {
    const f = await fixture();
    const oldest = await db.procurementSupplier.create({
      data: {
        tenantId: f.tenantId,
        displayName: 'Older',
        termsText: null,
        status: 'ACTIVE',
        createdAt: new Date('2026-01-02T03:04:05.122Z'),
      },
    });
    const newest = await db.procurementSupplier.create({
      data: {
        tenantId: f.tenantId,
        displayName: 'Newer',
        termsText: null,
        status: 'ACTIVE',
        createdAt: new Date('2026-01-02T03:04:05.124Z'),
      },
    });
    const first = await f.run(() =>
      f.service.list({ status: 'ALL', limit: '2' }),
    );
    expect(first.items.map((s) => s.id)).toEqual([newest.id, f.ids[0]]);
    const second = await f.run(() =>
      f.service.list({ status: 'ALL', limit: '2', cursor: first.nextCursor }),
    );
    expect(second.items.map((s) => s.id)).toEqual([f.ids[1], f.ids[2]]);
    const third = await f.run(() =>
      f.service.list({ status: 'ALL', limit: '2', cursor: second.nextCursor }),
    );
    expect(third.items.map((s) => s.id)).toEqual([oldest.id]);
    expect(third.nextCursor).toBeNull();
  });

  it('searches literal percent/underscore/backslash, trimmed case-insensitive Unicode, with explicit status', async () => {
    const f = await fixture();
    const list = (status: string, search: string) =>
      f.run(() => f.service.list({ status, search }));
    expect(
      (await list('ALL', '  é_literal%_\\SUPPLIER  ')).items.map((s) => s.id),
    ).toEqual([f.ids[0], f.ids[2]]);
    expect((await list('ARCHIVED', '%_\\')).items.map((s) => s.id)).toEqual([
      f.ids[2],
    ]);
    expect((await list('ACTIVE', '%_\\')).items.map((s) => s.id)).toEqual([
      f.ids[0],
    ]);
    expect((await list('ALL', '  ')).items.map((s) => s.id)).toEqual(f.ids);
    expect((await list('ALL', "' OR 1=1 --")).items).toEqual([]);
  });
  it('detail is tenant-qualified, returns persisted wire, and invalid/cross-scope cursors are closed', async () => {
    const f = await fixture();
    expect(await f.run(() => f.service.detail(f.ids[2]))).toMatchObject({
      id: f.ids[2],
      status: 'ARCHIVED',
      version: 1,
    });
    await expect(
      f.run(() => f.service.detail(f.foreign.id)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const page = await f.run(() =>
      f.service.list({ status: 'ALL', limit: '1' }),
    );
    for (const query of [
      { status: 'ACTIVE', cursor: page.nextCursor },
      { status: 'ALL', search: 'other', cursor: page.nextCursor },
      { status: 'ALL', cursor: `${page.nextCursor}tampered` },
    ])
      await expect(f.run(() => f.service.list(query))).rejects.toMatchObject({
        code: 'MALFORMED',
      });
    // Same actor legitimately belongs to both tenants; binding, not authority,
    // must reject the cursor when switching to another authorized tenant.
    const role = await db.role.create({
      data: { tenantId: f.otherTenantId, name: randomUUID() },
    });
    const grants = await db.rolePermission.findMany({
      where: { roleId: f.roleId },
    });
    await db.rolePermission.create({
      data: { roleId: role.id, permissionId: grants[0].permissionId },
    });
    await db.tenantMembership.create({
      data: { tenantId: f.otherTenantId, userId: f.actorId, roleId: role.id },
    });
    await expect(
      f.run(
        () => f.service.list({ status: 'ALL', cursor: page.nextCursor }),
        f.otherTenantId,
      ),
    ).rejects.toMatchObject({ code: 'MALFORMED' });
  });
  it.each(['user', 'tenant', 'membership'] as const)(
    'rechecks persisted revoked %s instead of trusting JWT/ability cache',
    async (kind) => {
      const f = await fixture();
      await f.run(() => f.service.detail(f.ids[0]));
      if (kind === 'user')
        await db.user.update({
          where: { id: f.actorId },
          data: { isActive: false },
        });
      if (kind === 'tenant')
        await db.tenant.update({
          where: { id: f.tenantId },
          data: { isActive: false },
        });
      if (kind === 'membership') {
        const denied = await db.role.create({
          data: { name: randomUUID(), tenantId: f.tenantId },
        });
        const member = await db.tenantMembership.findFirstOrThrow({
          where: { tenantId: f.tenantId, userId: f.actorId },
        });
        await db.tenantMembership.update({
          where: { id: member.id },
          data: { roleId: denied.id },
        });
      }
      const code = kind === 'user' ? 'UNAUTHORIZED' : 'FORBIDDEN';
      await expect(
        f.run(() => f.service.detail(f.ids[0])),
      ).rejects.toMatchObject({ code });
      await expect(
        f.run(() => f.service.list({ status: 'ALL' })),
      ).rejects.toMatchObject({ code });
    },
  );
});
