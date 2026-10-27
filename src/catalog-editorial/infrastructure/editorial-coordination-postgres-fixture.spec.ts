import type { Prisma, PrismaClient } from '@prisma/client';
import {
  currentBackendPid,
  readEditorialRows,
  readVariantMembership,
  readVariantPrices,
  seedEditorialPostgres,
  waitForLockWait,
  type EditorialSqlClient,
} from './editorial-coordination-postgres-fixture';

function fake() {
  const calls: { sql: string; values: unknown[] }[] = [];
  const replies: unknown[] = [];
  const capture = (strings: TemplateStringsArray, values: unknown[]) => {
    expect(Array.isArray(strings.raw)).toBe(true);
    expect(strings.length).toBe(values.length + 1);
    calls.push({ sql: strings.join('?'), values });
  };
  const query = jest.fn(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      capture(strings, values);
      const rows = strings.join('').includes('FROM "permissions"')
        ? [{ id: `existing-${String(values[1])}` }]
        : replies.shift();
      return Promise.resolve(rows);
    },
  );
  const client: EditorialSqlClient = {
    $executeRaw: (strings, ...values) => {
      capture(strings, values);
      return Promise.resolve(1);
    },
    $queryRaw: <T>(strings: TemplateStringsArray, ...values: unknown[]) =>
      query(strings, ...values).then((rows) => rows as T),
  };
  return { client, calls, query, replies };
}

describe('canonical offline seed', () => {
  it('accepts installed Prisma clients/transactions structurally without imports', () => {
    const accept = (
      client: PrismaClient | Prisma.TransactionClient,
    ): EditorialSqlClient => client;
    expect(accept).toBeInstanceOf(Function);
  });
  it('is deterministic; only resolved permission IDs overlap across keys', async () => {
    const a = await seedEditorialPostgres(fake().client, 'alpha');
    const again = await seedEditorialPostgres(fake().client, 'alpha');
    const b = await seedEditorialPostgres(fake().client, 'beta');
    expect(a).toEqual(again);
    const owned = (f: typeof a) => [
      ...Object.values(f.ids),
      ...Object.values(f.values),
    ];
    expect(new Set(Object.values(a.ids)).size).toBe(Object.keys(a.ids).length);
    expect(owned(a).filter((value) => owned(b).includes(value))).toEqual([]);
    expect(a.permissionIds).toEqual(b.permissionIds);
  });
  it('binds values, resolves shared permissions and respects declared FKs', async () => {
    const f = fake();
    const seed = await seedEditorialPostgres(f.client, "hostile-key' SQL");
    const dynamic = [...Object.values(seed.ids), ...Object.values(seed.values)];
    for (const call of f.calls) {
      expect(call.values.length).toBeGreaterThan(0);
      expect(call.sql).not.toContain('hostile-key');
      dynamic.forEach((value) => expect(call.sql).not.toContain(value));
    }
    const at = (table: string) =>
      f.calls.findIndex((c) => c.sql.includes(`INSERT INTO "${table}"`));
    const edges = [
      'tenants:roles users:tenant_memberships roles:role_permissions permissions:role_permissions roles:tenant_memberships',
      'tenants:products products:variants products:private_media_assets products:price_lists global_price_lists:price_lists',
      'variants:variant_prices price_lists:variant_prices editorial_families:editorial_bindings editorial_definitions:editorial_bindings editorial_definitions:editorial_options',
    ].join(' ');
    for (const edge of edges.split(' ')) {
      const [parent, child] = edge.split(':');
      expect(at(parent)).toBeGreaterThanOrEqual(0);
      expect(at(child)).toBeGreaterThan(at(parent));
    }
    const permissions = f.calls.filter((c) =>
      c.sql.includes('INSERT INTO "permissions"'),
    );
    expect(permissions).toHaveLength(2);
    permissions.forEach((c) =>
      expect(c.sql).toContain('ON CONFLICT ("subject", "action") DO NOTHING'),
    );
    expect(
      f.calls
        .filter((c) => c.sql.includes('FROM "permissions"'))
        .map((c) => c.values),
    ).toEqual([
      ['ProductEditorialDraft', 'read'],
      ['ProductEditorialDraft', 'update'],
    ]);
    const joins = f.calls.filter((c) =>
      c.sql.includes('INSERT INTO "role_permissions"'),
    );
    expect(joins.map((c) => c.values.at(-1))).toEqual([
      'existing-read',
      'existing-update',
    ]);
    const second = await seedEditorialPostgres(f.client, 'second');
    expect(second.permissionIds).toEqual(seed.permissionIds);
    expect(seed.permissionIds).toEqual({
      read: 'existing-read',
      update: 'existing-update',
    });
    expect(
      f.calls.filter((c) => c.sql.includes('INSERT INTO "products"')),
    ).toHaveLength(4);
  });
});

describe('bounded lock observation and readbacks', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
  const denied = new Error('Editorial lock observation failed');
  const options = { timeoutMs: 50, intervalMs: 30 };
  it('polls at the interval and returns witnessed blockers', async () => {
    const f = fake();
    f.replies.push([], [], [{ blockers: [12, 34] }]);
    const result = waitForLockWait(f.client, 91, {
      timeoutMs: 100,
      intervalMs: 20,
    });
    const tick = async (ms: number, count: number) => {
      await jest.advanceTimersByTimeAsync(ms);
      expect(f.query).toHaveBeenCalledTimes(count);
    };
    await tick(0, 1);
    await tick(19, 1);
    await tick(1, 2);
    await tick(20, 3);
    await expect(result).resolves.toEqual([12, 34]);
    expect(f.calls[0].sql).toContain("wait_event_type = 'Lock'");
    expect(f.calls[0].sql).toContain('pg_blocking_pids');
    expect(f.calls[0].values).toEqual([91]);
  });
  it.each([false, true])(
    'bounds timeout (stalled query: %s)',
    async (stall) => {
      const f = fake();
      f.query.mockImplementation(() =>
        stall ? new Promise(() => {}) : Promise.resolve([]),
      );
      const result = expect(
        waitForLockWait(f.client, 91, options),
      ).rejects.toEqual(denied);
      await jest.advanceTimersByTimeAsync(50);
      await result;
      expect(f.query).toHaveBeenCalledTimes(stall ? 1 : 2);
    },
  );
  it('redacts query errors', async () => {
    const f = fake();
    f.query.mockRejectedValue(new Error('SELECT private query text'));
    await expect(waitForLockWait(f.client, 91)).rejects.toEqual(denied);
  });
  it.each([
    { timeoutMs: 5001 },
    { timeoutMs: 0 },
    { intervalMs: 0 },
    { intervalMs: NaN },
  ])('denies invalid options %j before queries', async (invalid) => {
    const f = fake();
    await expect(waitForLockWait(f.client, 91, invalid)).rejects.toEqual(
      denied,
    );
    expect(f.query).not.toHaveBeenCalled();
  });
  it('reads backend identity and tenant-qualified persisted snapshots', async () => {
    const f = fake();
    f.replies.push(
      [{ pid: 91 }],
      ['state'],
      ['create'],
      ['save'],
      ['product'],
      ['variant'],
      ['price'],
    );
    await expect(currentBackendPid(f.client)).resolves.toBe(91);
    await expect(
      readEditorialRows(f.client, 'tenant', 'product'),
    ).resolves.toEqual({
      states: ['state'],
      createReceipts: ['create'],
      saveReceipts: ['save'],
    });
    await expect(
      readVariantMembership(f.client, 'tenant', 'product'),
    ).resolves.toEqual({ products: ['product'], variants: ['variant'] });
    await expect(
      readVariantPrices(f.client, 'tenant', 'variant'),
    ).resolves.toEqual(['price']);
    const values = f.calls.slice(1).map((c) => c.values);
    expect(values.slice(0, 5)).toEqual(
      Array.from({ length: 5 }, () => ['tenant', 'product']),
    );
    expect(values[5]).toEqual(['tenant', 'variant']);
  });
});
