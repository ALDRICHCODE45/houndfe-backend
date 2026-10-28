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
  it('adds scoped durable create receipts without rewriting existing data', () => {
    const create = readFileSync(
      join(__dirname, 'migrations/20261026030000_catalog_editorial_create/migration.sql'),
      'utf8',
    );
    expect(schema).toContain('model CatalogEditorialCreateReceipt');
    expect(schema).toContain('@@id([tenantId, productId, actorId, idempotencyKey])');
    expect(create).toContain(
      'PRIMARY KEY ("tenantId", "productId", "actorId", "idempotencyKey")',
    );
    expect(create).toContain(
      'REFERENCES "catalog_editorial_states" ("tenantId", "productId")',
    );
    expect(create).not.toMatch(/INSERT INTO|UPDATE "|DELETE FROM|DROP TABLE/i);
  });
  it('adds a separate save receipt namespace without data rewrites', () => {
    const save = readFileSync(
      join(__dirname, 'migrations/20261026040000_catalog_editorial_save/migration.sql'),
      'utf8',
    );
    expect(schema).toContain('model CatalogEditorialSaveReceipt');
    expect(save).toContain('PRIMARY KEY ("tenantId", "productId", "actorId", "idempotencyKey")');
    expect(save).toContain('REFERENCES "catalog_editorial_states" ("tenantId", "productId")');
    expect(save).not.toMatch(/INSERT INTO|UPDATE "|DELETE FROM|DROP TABLE/i);
  });
  it.each(['Publish', 'Discard'])('adds an analogous %s receipt namespace', (operation) => {
    const table = `catalog_editorial_${operation.toLowerCase()}_receipts`;
    const model = `CatalogEditorial${operation}Receipt`;
    const modelBody = schema.match(new RegExp(`model ${model} \\{([^}]+)\\}`))?.[1];
    const saveBody = schema.match(/model CatalogEditorialSaveReceipt \{([^}]+)\}/)?.[1];
    expect(modelBody).toBeDefined();
    expect(modelBody?.replace(table, 'catalog_editorial_save_receipts')).toBe(saveBody);
    const stateBody = schema.match(/model CatalogEditorialState \{([^}]+)\}/)?.[1];
    expect(stateBody).toContain(`${operation.toLowerCase()}Receipts ${model}[]`);

    const migration = readFileSync(
      join(__dirname, 'migrations/20261028010000_catalog_editorial_publish_discard/migration.sql'),
      'utf8',
    );
    const save = readFileSync(
      join(__dirname, 'migrations/20261026040000_catalog_editorial_save/migration.sql'),
      'utf8',
    );
    const withoutComments = (value: string) => value.replace(/--[^\n]*/g, '').trim();
    const statements = withoutComments(migration).split(';').map((value) => value.trim()).filter(Boolean);
    expect(statements).toHaveLength(2);
    expect(statements).toContain(
      withoutComments(save).replace('catalog_editorial_save_receipts', table).replace(/;$/, ''),
    );
  });
  it('contains no data migration or future lifecycle tables', () => {
    expect(sql).not.toMatch(/INSERT INTO|UPDATE "|DELETE FROM|DROP TABLE|receipt/i);
  });
});
