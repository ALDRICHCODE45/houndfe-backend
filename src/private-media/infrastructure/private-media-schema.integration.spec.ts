import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PrivateMediaTestDatabase,
  withPrivateMediaTestDatabase,
} from './private-media-postgres-runner';

const migration = resolve(
  __dirname,
  '../../../prisma/migrations/20261026070000_private_media_assets/migration.sql',
);
let db: PrivateMediaTestDatabase;
let release: () => void;
let owned: Promise<void>;
beforeAll(async () => {
  let ready: () => void;
  const admitted = new Promise<void>((done) => {
    ready = done;
  });
  owned = withPrivateMediaTestDatabase(async (database) => {
    db = database;
    await db.first.$executeRaw`CREATE TABLE tenants (id TEXT PRIMARY KEY)`;
    await db.first.$executeRaw`CREATE TABLE products (
      id TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL REFERENCES tenants(id),
      UNIQUE ("tenantId", id))`;
    await db.first
      .$executeRaw`INSERT INTO tenants VALUES ('tenant-a'), ('tenant-b')`;
    await db.first.$executeRaw`INSERT INTO products VALUES
      ('product-a', 'tenant-a'), ('product-b', 'tenant-b'), ('unlinked', 'tenant-a')`;
    // Trusted additive migration only; no deployment schema or seed scripts.
    for (const sql of readFileSync(migration, 'utf8')
      .split(';')
      .filter((s) => s.trim())) {
      await db.first.$executeRawUnsafe(sql);
    }
    ready();
    await new Promise<void>((done) => {
      release = done;
    });
  });
  await Promise.race([admitted, owned]);
});
afterAll(async () => {
  release?.();
  await owned;
});

function insert(id: string, overrides: Record<string, unknown> = {}) {
  const { first } = db;
  const row = {
    id,
    tenantId: 'tenant-a',
    productId: 'product-a',
    storageKey: `private/${id}`,
    mimeType: 'image/jpeg',
    sizeBytes: 1,
    createdAt: new Date('2026-10-26T00:00:00Z'),
    ...overrides,
  };
  return first.$executeRawUnsafe(
    'INSERT INTO private_media_assets (id, "tenantId", "productId", "storageKey", "mimeType", "sizeBytes", "createdAt") VALUES ($1, $2, $3, $4, $5, $6, $7)',
    row.id,
    row.tenantId,
    row.productId,
    row.storageKey,
    row.mimeType,
    row.sizeBytes,
    row.createdAt,
  );
}
async function snapshot() {
  const { second } = db;
  return {
    assets:
      await second.$queryRaw`SELECT * FROM private_media_assets ORDER BY id`,
    products: await second.$queryRaw`SELECT * FROM products ORDER BY id`,
    tenants: await second.$queryRaw`SELECT * FROM tenants ORDER BY id`,
  };
}
test.each(['image/jpeg', 'image/png', 'image/webp'])(
  'commits %s with inclusive size bounds for another session',
  async (mimeType) => {
    const { second } = db;
    for (const sizeBytes of [1, 10485760]) {
      const id = `${mimeType}-${sizeBytes}`;
      await insert(id, { mimeType, sizeBytes });
      const rows = await second.$queryRawUnsafe(
        'SELECT "tenantId", "productId", "storageKey", "mimeType", "sizeBytes", "createdAt" FROM private_media_assets WHERE id = $1',
        id,
      );
      expect(rows).toEqual([
        {
          tenantId: 'tenant-a',
          productId: 'product-a',
          storageKey: `private/${id}`,
          mimeType,
          sizeBytes,
          createdAt: new Date('2026-10-26T00:00:00Z'),
        },
      ]);
    }
  },
);
const rejections: [string, Record<string, unknown>, string][] = [
  ['missing product', { productId: 'absent' }, '23503'],
  ['cross-tenant product', { productId: 'product-b' }, '23503'],
  ['duplicate storage key', { storageKey: 'private/image/jpeg-1' }, '23505'],
  ['zero size', { sizeBytes: 0 }, '23514'],
  ['negative size', { sizeBytes: -1 }, '23514'],
  ['oversize', { sizeBytes: 10485761 }, '23514'],
  ['invalid MIME', { mimeType: 'image/gif' }, '23514'],
  ['case variant MIME', { mimeType: 'IMAGE/JPEG' }, '23514'],
  ...[
    'id',
    'tenantId',
    'productId',
    'storageKey',
    'mimeType',
    'sizeBytes',
    'createdAt',
  ].map((field): [string, Record<string, unknown>, string] => [
    `null ${field}`,
    { [field]: null },
    '23502',
  ]),
];
test.each(rejections)(
  'rejects %s without changing committed rows or counts',
  async (label, overrides, code) => {
    const before = await snapshot();
    await expect(insert(label, overrides)).rejects.toMatchObject({
      code: 'P2010',
      meta: { code },
    });
    expect(await snapshot()).toEqual(before);
  },
);
test('linked Product deletion is restricted without changes', async () => {
  const before = await snapshot();
  await expect(
    db.first.$executeRaw`DELETE FROM products WHERE id = 'product-a'`,
  ).rejects.toMatchObject({ code: 'P2010', meta: { code: '23503' } });
  expect(await snapshot()).toEqual(before);
});
test('unlinked Product remains deletable', async () => {
  expect(
    await db.first.$executeRaw`DELETE FROM products WHERE id = 'unlinked'`,
  ).toBe(1);
  expect(
    await db.second.$queryRaw`SELECT id FROM products WHERE id = 'unlinked'`,
  ).toEqual([]);
});
