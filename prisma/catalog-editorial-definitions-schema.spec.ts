import { readFileSync } from 'node:fs';
import { join } from 'node:path';

it('keeps common vocabulary artifacts additive and separate from Product', () => {
  const schema = readFileSync(join(__dirname, 'schema.prisma'), 'utf8');
  const sql = readFileSync(
    join(
      __dirname,
      'migrations/20261026050000_catalog_editorial_definitions/migration.sql',
    ),
    'utf8',
  );
  for (const name of [
    'EditorialFamily',
    'EditorialDefinition',
    'EditorialBinding',
  ]) {
    expect(schema).toContain(`model ${name} {`);
  }
  expect(schema).toContain('@@id([familyId, definitionId])');
  expect(sql).not.toMatch(
    /\b(INSERT|DELETE FROM|DROP|ALTER)\b|REFERENCES (products|tenants)/i,
  );
});
