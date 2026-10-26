import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PRIVATE_MEDIA_MAX_SIZE_BYTES,
  PRIVATE_MEDIA_MIME_TYPES,
  PrivateMediaAsset,
  PrivateMediaMetadata,
} from '../src/private-media/domain/private-media';

const schema = readFileSync(resolve(__dirname, 'schema.prisma'), 'utf8');
const sql = readFileSync(
  resolve(__dirname, 'migrations/20261026070000_private_media_assets/migration.sql'),
  'utf8',
);
test('Prisma and SQL align required types and compound Product binding', () => {
  const model = /model PrivateMediaAsset \{([^}]+)\}/.exec(schema)?.[1] ?? '';
  const fields = {
    id: 'String',
    tenantId: 'String',
    productId: 'String',
    storageKey: 'String',
    mimeType: 'String',
    sizeBytes: 'Int',
    createdAt: 'DateTime',
  };
  for (const [field, type] of Object.entries(fields)) {
    expect(model).toMatch(new RegExp(`\\b${field}\\s+${type}(?![?\\w])`));
    const sqlType =
      type === 'Int' ? 'INTEGER' : type === 'DateTime' ? 'TIMESTAMP(3)' : 'TEXT';
    expect(sql).toContain(`"${field}" ${sqlType} NOT NULL`);
  }
  expect(model).toContain('storageKey String @unique');
  expect(model).toContain('@@index([tenantId, productId])');
  expect(model).toContain('@@map("private_media_assets")');
  expect(model).toContain(
    'product Product @relation(fields: [tenantId, productId], references: [tenantId, id], onDelete: Restrict, onUpdate: Cascade)',
  );
  expect(schema).toMatch(
    /model Product \{[^}]*privateMediaAssets PrivateMediaAsset\[\]/,
  );
  expect(sql).toContain(
    'FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE',
  );
  expect(sql).toContain(
    'CREATE UNIQUE INDEX "private_media_assets_storageKey_key"',
  );
  expect(sql).toContain(
    'CREATE INDEX "private_media_assets_tenantId_productId_idx"',
  );
  expect(sql).toContain('PRIMARY KEY ("id")');
});
test('domain and SQL share bounded metadata policy and safe public shape', () => {
  expect(PRIVATE_MEDIA_MAX_SIZE_BYTES).toBe(10485760);
  expect(PRIVATE_MEDIA_MIME_TYPES).toEqual([
    'image/jpeg',
    'image/png',
    'image/webp',
  ]);
  expect(sql).toContain(
    'CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 10485760)',
  );
  expect(sql).toContain(
    `CHECK ("mimeType" IN (${PRIVATE_MEDIA_MIME_TYPES.map((mime) => `'${mime}'`).join(', ')}))`,
  );
  const asset: PrivateMediaAsset = {
    id: 'asset',
    tenantId: 'tenant',
    productId: 'product',
    storageKey: 'opaque-key',
    mimeType: 'image/png',
    sizeBytes: 1,
    createdAt: new Date(0),
  };
  const { storageKey, ...metadata } = asset;
  const publicView: PrivateMediaMetadata = metadata;
  expect(storageKey).toBe('opaque-key');
  expect(publicView).not.toHaveProperty('storageKey');
  expect(publicView).not.toHaveProperty('url');
  expect(publicView).not.toHaveProperty('publicURL');
});
