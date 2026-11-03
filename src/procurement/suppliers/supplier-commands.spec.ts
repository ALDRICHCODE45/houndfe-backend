/* eslint-disable @typescript-eslint/require-await -- Mock Prisma delegates preserve async rejection semantics. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, type ProcurementSupplier } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { SupplierCommands } from './supplier-commands';
import { hashSupplierBody } from './supplier-contract';

const tenantId = 'tenant-proof';
const actorId = 'actor-proof';
const id = '10000000-0000-4000-8000-000000000001';
const input = {
  displayName: ' Original 😀 ',
  termsText: 'Terms',
  status: 'ACTIVE',
};
const time = new Date('2026-01-02T03:04:05Z');
type Row = ProcurementSupplier;
type Receipt = {
  requestHash: string;
  responseBody: unknown;
  statusCode: number;
};
function harness() {
  let rows: Row[] = [];
  let receipts: Array<Receipt & Record<string, unknown>> = [];
  let audits: unknown[] = [];
  const events: string[] = [];
  const flags = {
    active: true,
    tenantActive: true,
    member: true,
    gate: true,
    ambient: false,
    failAudit: false,
    failReceipt: false,
    casLost: false,
  };
  let permissions = ['create', 'read', 'update', 'delete'].map((action) => ({
    action,
    subject: 'ProcurementSupplier',
  }));
  const context: Record<string, unknown> = { tenantId, userId: actorId };
  const tx = {
    $executeRaw: jest.fn(async () => {
      events.push('lifecycle');
      return 0;
    }),
    $queryRaw: jest.fn(async (sql: Prisma.Sql) => {
      const text = sql.sql;
      if (text.includes('FROM "tenants"')) {
        events.push('tenant');
        return [{ id: sql.values[0], isActive: flags.tenantActive }];
      }
      if (text.includes('FROM "users"')) {
        events.push('user');
        return flags.active ? [{ id: sql.values[0], isActive: true }] : [];
      }
      if (text.includes('FROM "tenant_memberships"')) {
        events.push('permissions');
        return flags.member ? permissions : [];
      }
      if (text.includes('pg_try_advisory_xact_lock')) {
        events.push('gate');
        return [{ acquired: flags.gate }];
      }
      if (text.includes('FROM "procurement_suppliers"')) {
        events.push('supplier');
        return rows.filter(
          (r) => r.id === sql.values[1] && r.tenantId === sql.values[0],
        );
      }
      throw new Error('Unexpected SQL');
    }),
    procurementSupplier: {
      create: jest.fn(async ({ data }: { data: Partial<Row> }) => {
        const row = {
          id: `10000000-0000-4000-8000-${String(rows.length + 1).padStart(12, '0')}`,
          tenantId,
          displayName: '',
          termsText: null,
          status: 'ACTIVE' as const,
          version: 1,
          createdAt: time,
          updatedAt: time,
          ...data,
        };
        rows.push(row);
        return row;
      }),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; tenantId: string; version: number };
          data: Omit<Partial<Row>, 'version'> & {
            version: { increment: number };
          };
        }) => {
          const row = rows.find(
            (r) =>
              r.id === where.id &&
              r.tenantId === where.tenantId &&
              r.version === where.version,
          );
          if (!row || flags.casLost) return { count: 0 };
          Object.assign(row, { ...data, version: row.version + 1 });
          return { count: 1 };
        },
      ),
      deleteMany: jest.fn(
        async ({
          where,
        }: {
          where: { tenantId: string; id: string; version: number };
        }) => {
          const before = rows.length;
          if (!flags.casLost)
            rows = rows.filter(
              (r) =>
                !(
                  r.tenantId === where.tenantId &&
                  r.id === where.id &&
                  r.version === where.version
                ),
            );
          return { count: before - rows.length };
        },
      ),
      findFirstOrThrow: jest.fn(
        async ({ where }: { where: { tenantId: string; id: string } }) => {
          const row = rows.find(
            (r) => r.id === where.id && r.tenantId === where.tenantId,
          );
          if (!row) throw new Error('Missing persisted row');
          return row;
        },
      ),
    },
    procurementSupplierReceipt: {
      findFirst: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) => {
          events.push('receipt');
          return (
            receipts.find((r) =>
              Object.entries(where).every(([k, v]) => r[k] === v),
            ) ?? null
          );
        },
      ),
      create: jest.fn(
        async ({ data }: { data: Receipt & Record<string, unknown> }) => {
          if (flags.failReceipt) throw new Error('private driver');
          receipts.push(structuredClone(data));
          return data;
        },
      ),
    },
    procurementSupplierAudit: {
      create: jest.fn(async ({ data }: { data: unknown }) => {
        if (flags.failAudit) throw new Error('private driver');
        audits.push(data);
        return data;
      }),
    },
  };
  const db = {
    isInTransaction: () => flags.ambient,
    getTenantId: () => context.tenantId,
    getClient: () => tx,
    runInTransaction: jest.fn(async (work: () => Promise<unknown>) => {
      const before = structuredClone({ rows, receipts, audits });
      try {
        return await work();
      } catch (error) {
        ({ rows, receipts, audits } = before);
        throw error;
      }
    }),
  };
  const service = new SupplierCommands(
    db as unknown as TenantPrismaService,
    {
      get: (key: string) => context[key],
    } as unknown as ClsService<TenantClsStore>,
  );
  return {
    service,
    tx,
    db,
    flags,
    context,
    events,
    setPermissions: (p: typeof permissions) => {
      permissions = p;
    },
    state: () => ({ rows, receipts, audits }),
  };
}

describe('SupplierCommands hard deletion', () => {
  const remove = (
    h: ReturnType<typeof harness>,
    key = 'd',
    expectedVersion = 1,
  ) => h.service.delete(id, key, { expectedVersion });

  it.each(['ACTIVE', 'ARCHIVED'])(
    'permanently removes %s but preserves evidence and all historical replays',
    async (status) => {
      const h = harness();
      const original = await h.service.create('c', { ...input, status });
      const patch = { expectedVersion: 1, changes: { termsText: null } };
      const edited = await h.service.update(id, 'u', patch);
      const before = structuredClone(h.state());
      expect(await remove(h, 'd', 2)).toEqual({ statusCode: 204, body: null });
      expect(h.state().rows).toEqual([]);
      expect(h.tx.procurementSupplier.deleteMany).toHaveBeenCalledWith({
        where: { tenantId, id, version: 2 },
      });
      expect(
        h.tx.procurementSupplierReceipt.create.mock.calls.at(-1)?.[0].data,
      ).toMatchObject({
        tenantId,
        actorId,
        operation: 'DELETE',
        target: id,
        supplierId: id,
        idempotencyKey: 'd',
        requestHash: hashSupplierBody('delete', { expectedVersion: 2 }),
        statusCode: 204,
        responseBody: Prisma.JsonNull,
      });
      expect(h.state().audits.slice(0, 2)).toEqual(before.audits);
      expect(h.state().receipts.slice(0, 2)).toEqual(before.receipts);
      expect(h.state().audits[2]).toMatchObject({
        actorId,
        tenantId,
        supplierId: id,
        operation: 'DELETE',
        supplierVersion: 3,
        snapshot: { ...edited.body, version: 3 },
      });
      expect(await remove(h, 'd', 2)).toEqual({ statusCode: 204, body: null });
      expect(await h.service.create('c', { ...input, status })).toEqual(
        original,
      );
      expect(await h.service.update(id, 'u', patch)).toEqual(edited);
      await expect(remove(h, 'new', 2)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(remove(h, 'd', 3)).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_CONFLICT',
      });
      expect(h.state().audits).toHaveLength(3);
      expect(h.state().receipts).toHaveLength(3);
    },
  );
  it.each([['read'], ['delete'], ['create', 'update']])(
    'requires read AND delete: %j',
    async (...actions) => {
      const h = harness();
      await h.service.create('c', input);
      h.setPermissions(
        actions.map((action) => ({ action, subject: 'ProcurementSupplier' })),
      );
      await expect(remove(h)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(h.state().rows).toHaveLength(1);
    },
  );
  it.each(['active', 'tenantActive', 'member'] as const)(
    'checks persisted %s before deleted replay',
    async (flag) => {
      const h = harness();
      await h.service.create('c', input);
      await remove(h);
      h.flags[flag] = false;
      await expect(remove(h)).rejects.toMatchObject({
        code: flag === 'active' ? 'UNAUTHORIZED' : 'FORBIDDEN',
      });
    },
  );
  it.each(['stale', 'overflow', 'casLost', 'gate', 'foreign'] as const)(
    'rejects %s without effects',
    async (kind) => {
      const h = harness();
      await h.service.create('c', input);
      if (kind === 'overflow') h.state().rows[0].version = 2147483647;
      if (kind === 'casLost') h.flags.casLost = true;
      if (kind === 'gate') h.flags.gate = false;
      if (kind === 'foreign') h.context.tenantId = 'other';
      const before = structuredClone(h.state());
      await expect(
        remove(
          h,
          'd',
          kind === 'overflow' ? 2147483647 : kind === 'stale' ? 2 : 1,
        ),
      ).rejects.toMatchObject({
        code:
          kind === 'gate'
            ? 'IDEMPOTENCY_KEY_IN_FLIGHT'
            : kind === 'foreign'
              ? 'NOT_FOUND'
              : 'SUPPLIER_VERSION_CONFLICT',
      });
      expect(h.state()).toEqual(before);
    },
  );
  it('permits the last representable deletion event version without overflow', async () => {
    const h = harness();
    await h.service.create('c', input);
    h.state().rows[0].version = 2147483646;
    expect(await remove(h, 'd', 2147483646)).toEqual({
      statusCode: 204,
      body: null,
    });
    expect(h.state().rows).toEqual([]);
    expect(h.state().audits[1]).toMatchObject({
      supplierVersion: 2147483647,
      snapshot: { version: 2147483647 },
    });
  });
  it.each(['failAudit', 'failReceipt'] as const)(
    'rolls deletion back on %s',
    async (flag) => {
      const h = harness();
      await h.service.create('c', input);
      const before = structuredClone(h.state());
      h.flags[flag] = true;
      await expect(remove(h)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
      expect(h.state()).toEqual(before);
    },
  );
});

describe('SupplierCommands public interface', () => {
  it('does not flatten real transaction clients in integration interception fixtures (offline drift guard)', () => {
    const fixtureSource = readFileSync(
      join(__dirname, 'supplier-commands.integration.spec.ts'),
      'utf8',
    );
    // Prisma raw methods use this._createPrismaPromise/this.$executeRawInternal.
    // Spreading the client or its delegates loses proxy/private receiver state.
    // This guards that regression, not real PostgreSQL lock/rollback behavior.
    expect(/\.\.\.tx\b/.test(fixtureSource)).toBe(false);
  });
  it('creates persisted wire values, atomic audit and canonical actor receipt under own ReadCommitted', async () => {
    const h = harness();
    const result = await h.service.create(' key ', input);
    expect(result).toEqual({
      statusCode: 201,
      body: {
        ...input,
        id,
        version: 1,
        createdAt: time.toISOString(),
        updatedAt: time.toISOString(),
      },
    });
    expect(h.db.runInTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      'ReadCommitted',
    );
    expect(h.events).toEqual([
      'lifecycle',
      'tenant',
      'user',
      'permissions',
      'gate',
      'receipt',
    ]);
    expect(h.state().receipts[0]).toMatchObject({
      tenantId,
      actorId,
      operation: 'CREATE',
      target: 'collection',
      idempotencyKey: ' key ',
      requestHash: hashSupplierBody('create', input),
      responseBody: result.body,
    });
    expect(h.state().audits[0]).toMatchObject({
      tenantId,
      actorId,
      supplierId: id,
      supplierVersion: 1,
      operation: 'CREATE',
      snapshot: result.body,
    });
    expect(Object.keys(h.tx).sort()).toEqual([
      '$executeRaw',
      '$queryRaw',
      'procurementSupplier',
      'procurementSupplierAudit',
      'procurementSupplierReceipt',
    ]); // no business-effect delegate
  });

  it('edits, preserves omitted terms, clears null, archives and reactivates with CAS', async () => {
    const h = harness();
    await h.service.create('c', input);
    await h.service.update(id, 'u1', {
      expectedVersion: 1,
      changes: { displayName: 'Edited' },
    });
    expect(h.state().rows[0]).toMatchObject({ termsText: 'Terms', version: 2 });
    await h.service.update(id, 'u2', {
      expectedVersion: 2,
      changes: { termsText: null, status: 'ARCHIVED' },
    });
    const result = await h.service.update(id, 'u3', {
      expectedVersion: 3,
      changes: { status: 'ACTIVE' },
    });
    expect(result.body).toMatchObject({
      termsText: null,
      displayName: 'Edited',
      status: 'ACTIVE',
      version: 4,
    });
    expect(h.state().audits).toHaveLength(4);
    expect(h.state().receipts).toHaveLength(4);
  });

  it('replays original create/update responses after later edits without current CAS/status reads', async () => {
    const h = harness();
    const created = await h.service.create('c', input);
    const patch = { expectedVersion: 1, changes: { termsText: null } };
    const edited = await h.service.update(id, 'u', patch);
    await h.service.update(id, 'archive', {
      expectedVersion: 2,
      changes: { status: 'ARCHIVED' },
    });
    h.events.length = 0;
    expect(
      await h.service.create('c', {
        status: 'ACTIVE',
        termsText: 'Terms',
        displayName: input.displayName,
      }),
    ).toEqual(created);
    expect(await h.service.update(id, 'u', patch)).toEqual(edited);
    expect(h.events).not.toContain('supplier');
    expect(h.state().audits).toHaveLength(3);
  });

  it.each(['user', 'tenant', 'membership', 'permission'])(
    'checks revoked %s before receipt disclosure',
    async (kind) => {
      const h = harness();
      await h.service.create('c', input);
      h.events.length = 0;
      if (kind === 'user') h.flags.active = false;
      if (kind === 'tenant') h.flags.tenantActive = false;
      if (kind === 'membership') h.flags.member = false;
      if (kind === 'permission') h.setPermissions([]);
      await expect(h.service.create('c', input)).rejects.toMatchObject({
        code: kind === 'user' ? 'UNAUTHORIZED' : 'FORBIDDEN',
      });
      expect(h.events).not.toContain('receipt');
    },
  );

  it.each([
    { actions: ['read'] },
    { actions: ['update'] },
    { actions: ['create'] },
  ])('update requires read AND update, not %j', async ({ actions }) => {
    const h = harness();
    h.setPermissions(
      actions.map((action) => ({ action, subject: 'ProcurementSupplier' })),
    );
    await expect(
      h.service.update(id, 'u', {
        expectedVersion: 1,
        changes: { status: 'ACTIVE' },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.events).not.toContain('receipt');
  });

  it('honors existing tenant manage:all without global/editorial bypass', async () => {
    const h = harness();
    h.setPermissions([{ action: 'manage', subject: 'all' }]);
    await expect(h.service.create('c', input)).resolves.toMatchObject({
      statusCode: 201,
    });
    h.flags.member = false;
    h.context.isSuperAdmin = true;
    await expect(h.service.create('c', input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('isolates exact keys, actors and targets; same namespace changed hash conflicts', async () => {
    const h = harness();
    await h.service.create('key', input);
    await expect(
      h.service.create('key', { ...input, termsText: null }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
    await h.service.create(' key ', input);
    h.context.userId = 'second-actor';
    await h.service.create('key', input);
    expect(h.state().receipts).toHaveLength(3);
  });

  it.each(['missing', 'foreign'])(
    'returns NOT_FOUND for %s supplier after authority',
    async (kind) => {
      const h = harness();
      if (kind === 'foreign') {
        await h.service.create('c', input);
        h.state().rows[0].tenantId = 'foreign';
      }
      await expect(
        h.service.update(id, 'u', {
          expectedVersion: 1,
          changes: { status: 'ARCHIVED' },
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(h.events.indexOf('permissions')).toBeLessThan(
        h.events.indexOf('supplier'),
      );
    },
  );

  it.each(['stale', 'max', 'race'])(
    'rejects %s CAS without partial evidence',
    async (kind) => {
      const h = harness();
      await h.service.create('c', input);
      if (kind === 'max') h.state().rows[0].version = 2147483647;
      if (kind === 'race') h.flags.casLost = true;
      await expect(
        h.service.update(id, 'u', {
          expectedVersion:
            kind === 'max' ? 2147483647 : kind === 'stale' ? 2 : 1,
          changes: { status: 'ARCHIVED' },
        }),
      ).rejects.toMatchObject({ code: 'SUPPLIER_VERSION_CONFLICT' });
      expect(h.state().audits).toHaveLength(1);
      expect(h.state().receipts).toHaveLength(1);
    },
  );

  it('qualifies complete namespaces, grant locks and stable gates, not just body hashes', async () => {
    const h = harness();
    const first = await h.service.create('same', input);
    const second = await h.service.create('other', input);
    const patch = { expectedVersion: 1, changes: { termsText: null } };
    await h.service.update(first.body.id, 'same', patch);
    await h.service.update(second.body.id, 'same', patch);
    h.context.tenantId = 'other-tenant';
    await h.service.create('same', input);
    expect(h.state().receipts).toHaveLength(5);
    expect(h.tx.procurementSupplierReceipt.findFirst).toHaveBeenLastCalledWith({
      where: {
        tenantId: 'other-tenant',
        actorId,
        operation: 'CREATE',
        target: 'collection',
        idempotencyKey: 'same',
      },
    });
    const queries = h.tx.$queryRaw.mock.calls.map(([query]) => query);
    expect(
      queries.find((q) => q.sql.includes('FROM "tenant_memberships"'))?.sql,
    ).toContain('FOR SHARE OF m, r, rp, p');
    const gates = queries
      .filter((q) => q.sql.includes('pg_try_advisory_xact_lock'))
      .map((q) => q.values[0]);
    expect(new Set(gates).size).toBe(5);
    await h.service.create('same', input);
    const last = h.tx.$queryRaw.mock.calls
      .map(([query]) => query)
      .filter((q) => q.sql.includes('pg_try_advisory_xact_lock'))
      .at(-1);
    expect(last?.values[0]).toBe(gates.at(-1));
  });

  it('includes CAS in update key conflicts before any current supplier validation', async () => {
    const h = harness();
    await h.service.create('c', input);
    await h.service.update(id, 'u', {
      expectedVersion: 1,
      changes: { termsText: null },
    });
    h.events.length = 0;
    await expect(
      h.service.update(id, 'u', {
        expectedVersion: 2,
        changes: { termsText: null },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
    expect(h.events).not.toContain('supplier');
    expect(h.state().audits).toHaveLength(2);
  });

  it('returns IN_FLIGHT on busy gate before reading receipts, without retry', async () => {
    const h = harness();
    h.flags.gate = false;
    await expect(h.service.create('c', input)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_IN_FLIGHT',
    });
    expect(h.events).not.toContain('receipt');
    expect(h.events.filter((e) => e === 'gate')).toHaveLength(1);
    expect(h.state().rows).toHaveLength(0);
  });

  it.each(['failAudit', 'failReceipt'] as const)(
    'sanitizes and rolls back %s for create and update',
    async (flag) => {
      const h = harness();
      h.flags[flag] = true;
      await expect(h.service.create('c', input)).rejects.toMatchObject({
        message: 'INTERNAL_ERROR',
        code: 'INTERNAL_ERROR',
      });
      expect(h.state()).toEqual({ rows: [], receipts: [], audits: [] });
      h.flags[flag] = false;
      await h.service.create('c', input);
      h.flags[flag] = true;
      await expect(
        h.service.update(id, 'u', {
          expectedVersion: 1,
          changes: { status: 'ARCHIVED' },
        }),
      ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
      expect(h.state().rows[0]).toMatchObject({ version: 1, status: 'ACTIVE' });
      expect(h.state().audits).toHaveLength(1);
      expect(h.state().receipts).toHaveLength(1);
    },
  );

  it.each(['', undefined, 'k\n', '😀'])(
    'validates key %j at public interface',
    async (key) => {
      const h = harness();
      await expect(h.service.create(key, input)).rejects.toMatchObject({
        code: 'MALFORMED',
      });
      expect(h.db.runInTransaction).not.toHaveBeenCalled();
    },
  );

  it('rejects malformed bodies/IDs, absent principal/tenant, ambient transactions', async () => {
    const h = harness();
    await expect(
      h.service.create('k', { ...input, tenantId }),
    ).rejects.toMatchObject({ code: 'MALFORMED' });
    await expect(
      h.service.update(id, 'k', { expectedVersion: 1, changes: {} }),
    ).rejects.toMatchObject({ code: 'MALFORMED' });
    await expect(h.service.update('bad', 'k', {})).rejects.toMatchObject({
      code: 'MALFORMED',
    });
    h.context.userId = undefined;
    await expect(h.service.create('k', input)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    h.context.userId = actorId;
    h.context.tenantId = null;
    await expect(h.service.create('k', input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    h.context.tenantId = tenantId;
    h.flags.ambient = true;
    await expect(h.service.create('k', input)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
    expect(h.db.runInTransaction).not.toHaveBeenCalled();
  });
});
