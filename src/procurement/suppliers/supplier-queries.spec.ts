/* eslint-disable @typescript-eslint/require-await -- Async database doubles. */
import { ConfigService } from '@nestjs/config';
import { Prisma, type ProcurementSupplier } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { SupplierQueries } from './supplier-queries';
import { SupplierCursor } from './supplier-cursor';

const id = '10000000-0000-4000-8000-000000000001';
const time = new Date('2026-01-02T03:04:05.123Z');
const row: ProcurementSupplier = {
  id,
  tenantId: 'tenant-a',
  displayName: 'É_%\\',
  termsText: null,
  status: 'ARCHIVED',
  version: 7,
  createdAt: time,
  updatedAt: time,
};
function harness() {
  const events: string[] = [];
  const context: Record<string, unknown> = {
    userId: 'actor',
    tenantId: 'tenant-a',
  };
  const flags = {
    active: true,
    tenantActive: true,
    member: true,
    ambient: false,
  };
  let grants = [{ action: 'read', subject: 'ProcurementSupplier' }];
  let rows = [row];
  const queries: Prisma.Sql[] = [];
  const tx = {
    $executeRaw: jest.fn(async () => {
      events.push('lifecycle');
      return 0;
    }),
    $queryRaw: jest.fn(async (sql: Prisma.Sql) => {
      if (sql.sql.includes('FROM "tenants"')) {
        events.push('tenant');
        return [{ id: sql.values[0], isActive: flags.tenantActive }];
      }
      if (sql.sql.includes('FROM "users"')) {
        events.push('user');
        return [{ id: sql.values[0], isActive: flags.active }];
      }
      if (sql.sql.includes('FROM "tenant_memberships"')) {
        events.push('authority');
        return flags.member ? grants : [];
      }
      if (sql.sql.includes('FROM "procurement_suppliers"')) {
        events.push('read');
        queries.push(sql);
        return rows;
      }
      throw new Error('Unexpected SQL');
    }),
  };
  const db = {
    getTenantId: () => context.tenantId,
    isInTransaction: () => flags.ambient,
    getClient: () => tx,
    runInTransaction: jest.fn(async (work: () => Promise<unknown>) => work()),
  };
  const cls = { get: (key: string) => context[key] };
  const cursor = new SupplierCursor(
    new ConfigService({ JWT_SECRET: 'offline-only' }),
  );
  return {
    service: new SupplierQueries(
      db as unknown as TenantPrismaService,
      cls as ClsService<TenantClsStore>,
      cursor,
    ),
    db,
    tx,
    cursor,
    queries,
    flags,
    context,
    events,
    rows: (value: ProcurementSupplier[]) => {
      rows = value;
    },
    grants: (value: typeof grants) => {
      grants = value;
    },
  };
}
describe('supplier current-authority queries', () => {
  it('reads persisted wire detail only after lifecycle/tenant/user/grants', async () => {
    const h = harness();
    expect(await h.service.detail(id)).toEqual({
      id,
      displayName: row.displayName,
      termsText: null,
      status: 'ARCHIVED',
      version: 7,
      createdAt: time.toISOString(),
      updatedAt: time.toISOString(),
    });
    expect(h.events).toEqual([
      'lifecycle',
      'tenant',
      'user',
      'authority',
      'read',
    ]);
    expect(h.queries[0].values).toEqual(['tenant-a', id]);
    expect(h.db.runInTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      Prisma.TransactionIsolationLevel.ReadCommitted,
    );
  });
  it('returns 404 for tenant-qualified absence after authority', async () => {
    const h = harness();
    h.rows([]);
    await expect(h.service.detail(id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(h.events.at(-1)).toBe('read');
  });
  it.each([
    ['inactive user', 'active', 'UNAUTHORIZED'],
    ['inactive tenant', 'tenantActive', 'FORBIDDEN'],
    ['removed membership', 'member', 'FORBIDDEN'],
  ] as const)(
    'denies %s without supplier reads/effects',
    async (_name, flag, code) => {
      const h = harness();
      h.flags[flag] = false;
      await expect(h.service.list({ status: 'ALL' })).rejects.toMatchObject({
        code,
      });
      expect(h.queries).toHaveLength(0);
    },
  );
  it.each(['create', 'update'])(
    'does not infer read from %s or super-admin claims',
    async (action) => {
      const h = harness();
      h.context.isSuperAdmin = true;
      h.grants([{ action, subject: 'ProcurementSupplier' }]);
      await expect(h.service.detail(id)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(h.queries).toHaveLength(0);
    },
  );
  it('honors existing manage:all implication, but rechecks revocation on each call', async () => {
    const h = harness();
    h.grants([{ action: 'manage', subject: 'all' }]);
    await expect(h.service.detail(id)).resolves.toHaveProperty('id', id);
    h.grants([]);
    await expect(h.service.detail(id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(h.queries).toHaveLength(1);
  });
  it.each([
    ['userId', undefined, 'UNAUTHORIZED'],
    ['tenantId', undefined, 'FORBIDDEN'],
  ])('requires trusted CLS %s', async (key, value, code) => {
    const h = harness();
    h.context[key] = value;
    await expect(h.service.list({ status: 'ALL' })).rejects.toMatchObject({
      code,
    });
    expect(h.tx.$queryRaw).not.toHaveBeenCalled();
  });
  it('rejects ambient transactions and sanitizes unexpected failures', async () => {
    const h = harness();
    h.flags.ambient = true;
    await expect(h.service.detail(id)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
    expect(h.db.runInTransaction).not.toHaveBeenCalled();
    h.flags.ambient = false;
    h.tx.$queryRaw.mockRejectedValueOnce(new Error('private driver detail'));
    await expect(h.service.detail(id)).rejects.toMatchObject({
      message: 'INTERNAL_ERROR',
    });
  });
  it.each([
    {},
    { status: 'ALL', limit: '101' },
    { status: 'ALL', tenantId: 'other' },
    { status: ['ALL'] },
  ])('rejects malformed query %j before DB', async (query) => {
    const h = harness();
    await expect(h.service.list(query)).rejects.toMatchObject({
      code: 'MALFORMED',
    });
    expect(h.db.runInTransaction).not.toHaveBeenCalled();
  });
  it('rejects malformed UUID before DB', async () => {
    const h = harness();
    await expect(h.service.detail('invalid')).rejects.toMatchObject({
      code: 'MALFORMED',
    });
    expect(h.db.runInTransaction).not.toHaveBeenCalled();
  });
  it('uses literal escaped ILIKE, status, tenant and limit+1, no count', async () => {
    const h = harness();
    const page = await h.service.list({
      status: 'ARCHIVED',
      search: '  É_%\\  ',
      limit: '1',
    });
    expect(page).toEqual({
      items: [expect.objectContaining({ id })],
      nextCursor: null,
    });
    expect(h.queries[0].sql).toContain('ILIKE');
    expect(h.queries[0].sql).toContain('ESCAPE');
    expect(h.queries[0].sql).toContain(
      'ORDER BY s."createdAt" DESC, s."id" DESC',
    );
    expect(h.queries[0].values).toEqual([
      'tenant-a',
      'ARCHIVED',
      '%É\\_\\%\\\\%',
      2,
    ]);
    expect(h.queries).toHaveLength(1);
  });
  it('bounds pages, continues by last returned row, and binds normalized scope', async () => {
    const h = harness();
    h.rows([row, { ...row, id: '10000000-0000-4000-8000-000000000002' }]);
    const first = await h.service.list({ status: 'ALL', limit: '1' });
    expect(first.items).toHaveLength(1);
    expect(Object.keys(first)).toEqual(['items', 'nextCursor']);
    expect(first.nextCursor).toEqual(expect.any(String));
    h.rows([]);
    expect(
      await h.service.list({
        status: 'ALL',
        limit: '2',
        cursor: first.nextCursor,
      }),
    ).toEqual({ items: [], nextCursor: null });
    expect(h.queries[1].sql).toContain('(s."createdAt", s."id") <');
    expect(h.queries[1].values).toEqual(['tenant-a', time, id, 3]);
    await expect(
      h.service.list({ status: 'ACTIVE', cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: 'MALFORMED' });
    expect(h.queries).toHaveLength(2);
  });
  it('defaults to 25 and omits ALL/blank search predicates', async () => {
    const h = harness();
    h.rows([]);
    expect(await h.service.list({ status: 'ALL', search: '  ' })).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(h.queries[0].values).toEqual(['tenant-a', 26]);
  });
});
