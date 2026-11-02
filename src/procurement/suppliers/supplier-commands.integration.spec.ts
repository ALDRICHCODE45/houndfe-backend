import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { normalizeTestDatabaseUrl } from '../../../test/integration/setup/test-database-url';
import { SupplierCommands } from './supplier-commands';

// Parent ONLY: integration config/global setup plus fresh disposable ownership
// preflight. Random owned fixtures intentionally remain in that disposable DB;
// no cleanup deletes, shared seed modification or existing database execution.
const describeDb =
  process.env.SKIP_DB_INTEGRATION === '1' ? describe.skip : describe;
const input = {
  displayName: 'SQL original 😀',
  termsText: 'SQL terms',
  status: 'ACTIVE',
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Keep the real Prisma proxies and method receivers: raw methods reach private
// client state through `this`. Object spread is not a transaction-client adapter.
// This fixture intercepts only one awaited delegate method; all queries stay real.
function interceptSupplierFixture(
  tx: ReturnType<TenantPrismaService['getClient']>,
  delegate: 'procurementSupplierAudit' | 'procurementSupplierReceipt',
  method: 'findFirst' | 'create',
  intercept: (proceed: () => Promise<unknown>) => Promise<unknown>,
) {
  const bindProperty = (target: object, property: PropertyKey): unknown => {
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === 'function'
      ? (value.bind(target) as unknown)
      : value;
  };
  const wrappedDelegate = new Proxy(tx[delegate], {
    get(target, property) {
      if (property !== method) return bindProperty(target, property);
      const original: unknown = Reflect.get(target, property, target);
      if (typeof original !== 'function')
        throw new Error('Missing fixture method');
      return (...args: unknown[]) =>
        intercept(() => {
          const result: unknown = Reflect.apply(original, target, args);
          return Promise.resolve(result);
        });
    },
  });
  return new Proxy(tx, {
    get(target, property) {
      return property === delegate
        ? wrappedDelegate
        : bindProperty(target, property);
    },
  });
}

describeDb('supplier commands PostgreSQL transaction boundary', () => {
  let db: PrismaClient;
  beforeAll(() => {
    normalizeTestDatabaseUrl(process.env.DATABASE_URL, '[supplier-commands]');
    db = new PrismaClient();
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  async function fixture() {
    const tenantId = randomUUID();
    const actorId = randomUUID();
    const roleId = randomUUID();
    await db.$transaction(async (tx) => {
      await tx.tenant.create({
        data: { id: tenantId, name: 'Supplier command proof', slug: tenantId },
      });
      await tx.user.create({
        data: {
          id: actorId,
          email: `${actorId}@supplier.invalid`,
          name: 'Owned proof actor',
          hashedPassword: 'not-a-login-hash',
        },
      });
      await tx.role.create({
        data: { id: roleId, tenantId, name: `Owned supplier ${roleId}` },
      });
      for (const action of ['create', 'read', 'update']) {
        const permission =
          (await tx.permission.findUnique({
            where: {
              subject_action: { subject: 'ProcurementSupplier', action },
            },
          })) ??
          (await tx.permission.create({
            data: { subject: 'ProcurementSupplier', action },
          }));
        await tx.rolePermission.create({
          data: { roleId, permissionId: permission.id },
        });
      }
      await tx.tenantMembership.create({
        data: { userId: actorId, tenantId, roleId },
      });
    });
    const cls = new ClsService<TenantClsStore>(new AsyncLocalStorage());
    // SAFETY: TenantPrismaService only uses the PrismaClient API; lifecycle
    // hooks/configuration on the Nest subclass are not part of this fixture.
    const tenantDb = new TenantPrismaService(db as PrismaService, cls);
    const service = new SupplierCommands(tenantDb, cls);
    const run = <T>(work: () => T, tenant = tenantId, actor = actorId): T =>
      cls.runWith(
        { tenantId: tenant, userId: actor, isSuperAdmin: false },
        work,
      );
    return { tenantId, actorId, roleId, tenantDb, service, run };
  }

  async function effects(tenantId: string) {
    const where = { tenantId };
    return Promise.all([
      db.product.count({ where }),
      db.sale.count({ where }),
      db.salePayment.count({ where }),
      db.outboxEvent.count({ where }),
    ]);
  }

  it('create/edit/archive/reactivate persists audit and immutable original replay with zero business effects', async () => {
    const f = await fixture();
    const created = await f.run(() => f.service.create(' original ', input));
    const id = created.body.id;
    const patch = { expectedVersion: 1, changes: { displayName: 'Edited' } };
    const edited = await f.run(() => f.service.update(id, 'edit', patch));
    expect(edited.body.termsText).toBe('SQL terms');
    await f.run(() =>
      f.service.update(id, 'archive', {
        expectedVersion: 2,
        changes: { termsText: null, status: 'ARCHIVED' },
      }),
    );
    expect(await f.run(() => f.service.create(' original ', input))).toEqual(
      created,
    );
    expect(await f.run(() => f.service.update(id, 'edit', patch))).toEqual(
      edited,
    );
    const active = await f.run(() =>
      f.service.update(id, 'activate', {
        expectedVersion: 3,
        changes: { status: 'ACTIVE' },
      }),
    );
    expect(active.body).toMatchObject({
      version: 4,
      status: 'ACTIVE',
      termsText: null,
    });
    const persisted = await db.procurementSupplier.findFirstOrThrow({
      where: { tenantId: f.tenantId, id },
    });
    expect(active.body.createdAt).toBe(persisted.createdAt.toISOString());
    expect(active.body.updatedAt).toBe(persisted.updatedAt.toISOString());
    const audits = await db.procurementSupplierAudit.findMany({
      where: { tenantId: f.tenantId },
      orderBy: { supplierVersion: 'asc' },
    });
    expect(audits.map((a) => a.supplierVersion)).toEqual([1, 2, 3, 4]);
    expect(audits[0]).toMatchObject({
      actorId: f.actorId,
      operation: 'CREATE',
      snapshot: created.body,
    });
    expect(
      await db.procurementSupplierReceipt.count({
        where: { tenantId: f.tenantId },
      }),
    ).toBe(4);
    expect(await effects(f.tenantId)).toEqual([0, 0, 0, 0]);
    await expect(
      f.run(() =>
        f.service.create(' original ', { ...input, termsText: null }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
  });

  it.each(['user', 'tenant', 'membership', 'grant'])(
    'revoked %s denies even applied replay',
    async (kind) => {
      const f = await fixture();
      await f.run(() => f.service.create('c', input));
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
        const membership = await db.tenantMembership.findFirstOrThrow({
          where: { tenantId: f.tenantId, userId: f.actorId },
        });
        await db.tenantMembership.update({
          where: { id: membership.id },
          data: { roleId: denied.id },
        });
      }
      if (kind === 'grant') {
        const grant = await db.rolePermission.findFirstOrThrow({
          where: {
            roleId: f.roleId,
            permission: { action: 'create', subject: 'ProcurementSupplier' },
          },
        });
        const unrelated = await db.permission.create({
          data: { subject: `Owned-proof-${randomUUID()}`, action: 'read' },
        });
        await db.rolePermission.update({
          where: { id: grant.id },
          data: { permissionId: unrelated.id },
        });
      }
      await expect(
        f.run(() => f.service.create('c', input)),
      ).rejects.toMatchObject({
        code: kind === 'user' ? 'UNAUTHORIZED' : 'FORBIDDEN',
      });
      expect(
        await db.procurementSupplierAudit.count({
          where: { tenantId: f.tenantId },
        }),
      ).toBe(1);
    },
  );

  it('foreign and missing roots are NOT_FOUND, while another actor cannot replay', async () => {
    const owner = await fixture();
    const other = await fixture();
    const result = await owner.run(() => owner.service.create('c', input));
    const patch = { expectedVersion: 1, changes: { status: 'ARCHIVED' } };
    for (const id of [result.body.id, randomUUID()]) {
      await expect(
        other.run(() => other.service.update(id, 'u', patch)),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    const secondActor = randomUUID();
    await db.user.create({
      data: {
        id: secondActor,
        email: `${secondActor}@supplier.invalid`,
        name: 'Other owned actor',
        hashedPassword: 'not-a-login-hash',
      },
    });
    await db.tenantMembership.create({
      data: {
        userId: secondActor,
        tenantId: owner.tenantId,
        roleId: owner.roleId,
      },
    });
    const second = await owner.run(
      () => owner.service.create('c', input),
      owner.tenantId,
      secondActor,
    );
    expect(second.body.id).not.toBe(result.body.id);
  });

  it('serializes two different-key writers by supplier CAS, including INTEGER ceiling', async () => {
    const f = await fixture();
    const created = await f.run(() => f.service.create('c', input));
    const patch = { expectedVersion: 1, changes: { status: 'ARCHIVED' } };
    const results = await Promise.allSettled(
      ['a', 'b'].map((key) =>
        f.run(() => f.service.update(created.body.id, key, patch)),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'SUPPLIER_VERSION_CONFLICT' },
    });
    expect(
      await db.procurementSupplierAudit.count({
        where: { tenantId: f.tenantId },
      }),
    ).toBe(2);
    expect(
      await db.procurementSupplierReceipt.count({
        where: { tenantId: f.tenantId },
      }),
    ).toBe(2);
    await db.procurementSupplier.update({
      where: { id: created.body.id, tenantId: f.tenantId },
      data: { version: 2147483647 },
    }); // owned negative fixture, not command behavior
    await expect(
      f.run(() =>
        f.service.update(created.body.id, 'ceiling', {
          ...patch,
          expectedVersion: 2147483647,
        }),
      ),
    ).rejects.toMatchObject({ code: 'SUPPLIER_VERSION_CONFLICT' });
  });

  it('same namespace held on a second connection is IN_FLIGHT, then replay recovers without duplication', async () => {
    const f = await fixture();
    const locked = deferred();
    const release = deferred();
    const digest = createHash('sha256')
      .update(
        JSON.stringify([
          'procurement-supplier-command-v1',
          f.tenantId,
          f.actorId,
          'CREATE',
          'collection',
          'c',
        ]),
      )
      .digest()
      .readBigInt64BE(0);
    const holder = db.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(${digest}::bigint)`,
      );
      locked.resolve();
      await release.promise;
    });
    try {
      await Promise.race([locked.promise, holder]);
      await expect(
        f.run(() => f.service.create('c', input)),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_IN_FLIGHT' });
      expect(
        await db.procurementSupplier.count({ where: { tenantId: f.tenantId } }),
      ).toBe(0);
    } finally {
      release.resolve();
      await holder;
    }
    const result = await f.run(() => f.service.create('c', input));
    expect(await f.run(() => f.service.create('c', input))).toEqual(result);
    expect(
      await db.procurementSupplierAudit.count({
        where: { tenantId: f.tenantId },
      }),
    ).toBe(1);
  });

  it('holds actual grant edges against the permission writer until command commit, then denies replay', async () => {
    const f = await fixture();
    const grant = await db.rolePermission.findFirstOrThrow({
      where: {
        roleId: f.roleId,
        permission: { subject: 'ProcurementSupplier', action: 'create' },
      },
    });
    const unrelated = await db.permission.create({
      data: { subject: `Owned-proof-${randomUUID()}`, action: 'read' },
    });
    const entered = deferred();
    const release = deferred();
    let barrierReached = false;
    const spy = jest.spyOn(f.tenantDb, 'getClient').mockImplementation(() => {
      spy.mockRestore();
      const tx = f.tenantDb.getClient();
      return interceptSupplierFixture(
        tx,
        'procurementSupplierReceipt',
        'findFirst',
        async (proceed) => {
          const receipt = await proceed();
          barrierReached = true;
          entered.resolve();
          await release.promise;
          return receipt;
        },
      );
    });
    const applying = f.run(() => f.service.create('paused', input));
    try {
      await Promise.race([entered.promise, applying]);
      expect(barrierReached).toBe(true);
      // UPDATE and the existing deleteMany permission writer both conflict with
      // the SHARE tuple lock; timeout keeps the probe bounded and rolls it back.
      await expect(
        db.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '100ms'`;
          await tx.$executeRaw(Prisma.sql`
          UPDATE "role_permissions" SET "permissionId" = ${unrelated.id}
          WHERE "id" = ${grant.id} AND "roleId" = ${f.roleId}
        `);
        }),
      ).rejects.toMatchObject({ code: 'P2010', meta: { code: '55P03' } });
    } finally {
      release.resolve();
      await applying;
      spy.mockRestore();
    }
    await db.rolePermission.update({
      where: { id: grant.id },
      data: { permissionId: unrelated.id },
    });
    await expect(
      f.run(() => f.service.create('paused', input)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each(['procurementSupplierAudit', 'procurementSupplierReceipt'] as const)(
    'real transaction rolls back when %s fails after supplier write',
    async (delegate) => {
      const f = await fixture();
      let observedWrite = false;
      const spy = jest.spyOn(f.tenantDb, 'getClient').mockImplementation(() => {
        spy.mockRestore(); // One getClient per command; restore before reading the real ambient tx.
        const tx = f.tenantDb.getClient();
        return interceptSupplierFixture(tx, delegate, 'create', async () => {
          expect(
            await tx.procurementSupplier.count({
              where: { tenantId: f.tenantId },
            }),
          ).toBe(1);
          observedWrite = true;
          throw new Error('injected private driver failure');
        });
      });
      try {
        await expect(
          f.run(() => f.service.create('c', input)),
        ).rejects.toMatchObject({
          message: 'INTERNAL_ERROR',
          code: 'INTERNAL_ERROR',
        });
      } finally {
        spy.mockRestore();
      }
      expect(observedWrite).toBe(true);
      expect(
        await db.procurementSupplier.count({ where: { tenantId: f.tenantId } }),
      ).toBe(0);
      expect(
        await db.procurementSupplierAudit.count({
          where: { tenantId: f.tenantId },
        }),
      ).toBe(0);
      expect(
        await db.procurementSupplierReceipt.count({
          where: { tenantId: f.tenantId },
        }),
      ).toBe(0);
      expect(await effects(f.tenantId)).toEqual([0, 0, 0, 0]);
    },
  );
});
