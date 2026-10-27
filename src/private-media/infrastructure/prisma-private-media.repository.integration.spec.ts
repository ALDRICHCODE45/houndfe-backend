import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { withPrivateMediaTestDatabase } from './private-media-postgres-runner';
import { PrismaPrivateMediaRepository } from './prisma-private-media.repository';

test('real repository commits scoped metadata visible to another client; invalid input changes nothing', async () => {
  await withPrivateMediaTestDatabase(async ({ first, second }) => {
    await first.$executeRaw`CREATE TABLE tenants (id TEXT PRIMARY KEY)`;
    await first.$executeRaw`CREATE TABLE products (
      id TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL REFERENCES tenants(id),
      UNIQUE ("tenantId", id))`;
    await first.$executeRaw`INSERT INTO tenants VALUES ('tenant'), ('foreign')`;
    await first.$executeRaw`INSERT INTO products VALUES
      ('product', 'tenant'), ('other-product', 'tenant'), ('foreign-product', 'foreign')`;
    const migration = resolve(
      __dirname,
      '../../../prisma/migrations/20261026070000_private_media_assets/migration.sql',
    );
    for (const sql of readFileSync(migration, 'utf8').split(';')) {
      if (sql.trim()) await first.$executeRawUnsafe(sql);
    }
    const writer = new PrismaPrivateMediaRepository(first);
    const reader = new PrismaPrivateMediaRepository(second);
    const asset = {
      id: "asset'; SELECT 1; --",
      tenantId: 'tenant',
      productId: 'product',
      storageKey: "private/key'",
      mimeType: 'image/webp' as const,
      sizeBytes: 10485760,
      createdAt: new Date('2026-10-26T00:00:00Z'),
    };
    expect(await writer.create(asset)).toEqual(asset);
    expect(await reader.find(asset)).toEqual(asset);
    for (const change of [
      { tenantId: 'foreign' },
      { productId: 'other-product' },
      { id: 'missing' },
    ]) {
      expect(await reader.find({ ...asset, ...change })).toBeNull();
    }
    const before = await second.$queryRaw`SELECT * FROM private_media_assets`;
    for (const change of [
      { sizeBytes: 0 },
      { mimeType: 'text/plain' },
      { storageKey: '' },
      { createdAt: new Date(NaN) },
    ]) {
      expect(await writer.create({ ...asset, ...change } as never)).toBeNull();
    }
    expect(
      await writer.create({
        ...asset,
        id: 'bad',
        tenantId: 'foreign',
        storageKey: 'private/foreign',
      }),
    ).toBeNull();
    expect(await second.$queryRaw`SELECT * FROM private_media_assets`).toEqual(
      before,
    );
  });
});
