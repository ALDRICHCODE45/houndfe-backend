import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const schema = readFileSync(join(__dirname, 'schema.prisma'), 'utf8');
const sql = readFileSync(
  join(
    __dirname,
    'migrations/20261026020000_catalog_editorial_core/migration.sql',
  ),
  'utf8',
);

describe('additive editorial state artifact', () => {
  it('declares one tenant-qualified Product state and nullable editorial data', () => {
    expect(schema).toContain('model CatalogEditorialState');
    expect(schema).toContain('@@id([tenantId, productId])');
    expect(schema).toContain('draftDocument Json?');
    expect(schema).toContain('publishedDocument Json?');
    expect(sql).toContain('REFERENCES "products" ("tenantId", "id")');
    expect(sql).toContain('PRIMARY KEY ("tenantId", "productId")');
  });
  it('contains no data migration or future lifecycle tables', () => {
    expect(sql).not.toMatch(/INSERT INTO|UPDATE "|DELETE FROM|DROP TABLE|receipt/i);
  });
});
