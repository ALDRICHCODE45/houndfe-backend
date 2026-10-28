import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = join(
  __dirname,
  'migrations/20261028120000_editorial_production_metadata/migration.sql',
);
const schema = readFileSync(join(__dirname, 'schema.prisma'), 'utf8');
const model = (name: string) =>
  new RegExp(`model Editorial${name} \\{[^}]*`).exec(schema)?.[0] ?? '';
const sql = () => readFileSync(migration, 'utf8');

it('adds storage artifacts without data writes or legacy key/owner changes (structural only)', () => {
  expect(existsSync(migration)).toBe(true);
  const ddl = sql().replace(/--[^\n]*/g, '');
  expect(ddl).not.toMatch(
    /\b(INSERT|TRUNCATE)\b|\bUPDATE\s+editorial_|\bDELETE\s+FROM\b/i,
  );
  expect(ddl).not.toMatch(/DROP\s+(TABLE|COLUMN)|ALTER COLUMN|RENAME/i);
  expect(model('Definition')).toMatch(/type\s+String\s/);
  expect(model('Option')).toContain('@@id([definitionId, code])');
  expect(model('Binding')).toContain('@@id([familyId, definitionId])');
  expect(model('Binding')).toMatch(/owner\s+String\s/);
  expect(model('Unit')).toMatch(
    /definitionType\s+String\s+@default\("number"\)/,
  );
  for (const name of ['Unit', 'Option']) {
    expect(model(name)).toContain(
      'references: [id, type], onDelete: Restrict, onUpdate: Restrict',
    );
  }
  expect(model('Unit')).toMatch(/unitCode\s+String\?/);
  expect(model('Family')).toMatch(
    /minimumContractVersion\s+Int\s+@default\(1\)/,
  );
  expect(model('Definition')).toMatch(/numericPolicy\s+Json\?/);
  expect(model('Binding')).toMatch(
    /exposure\s+String\s+@default\("INTERNAL"\)/,
  );
  expect(model('Binding')).toMatch(/searchable\s+Boolean\s+@default\(false\)/);
  for (const [field, type] of [
    ['policy', 'Json'],
    ['publicationCheck', 'String'],
  ]) {
    expect(model('Binding')).toMatch(new RegExp(`${field}\\s+${type}\\?`));
  }
});

it('extends only exact type/unit checks and retains null-number units and choice-only options', () => {
  const ddl = sql();
  expect(ddl.match(/DROP CONSTRAINT (?:"[^"]+"|\w+)/g)).toEqual([
    'DROP CONSTRAINT editorial_definitions_type_check',
    'DROP CONSTRAINT "editorial_units_definitionType_check"',
  ]);
  expect(ddl).toContain(
    "type IN ('text', 'boolean', 'number', 'single', 'multi', 'range')",
  );
  expect(ddl).toContain("\"definitionType\" IN ('number', 'range')");
  expect(ddl).toContain(
    '"definitionType" <> \'range\' OR "unitCode" IS NOT NULL',
  );
  expect(ddl).not.toContain('DROP CONSTRAINT editorial_options');
  expect(ddl).toContain('"minimumContractVersion" IN (1, 2)');
  expect(ddl).toContain("exposure IN ('INTERNAL', 'DETAIL', 'FACET')");
  expect(ddl).toContain("\"publicationCheck\" IN ('always', 'when_asserted')");
});

it('maps scoped identities without introducing new legacy identity restrictions', () => {
  for (const name of ['Group', 'GroupMember', 'Alias', 'VocabularyMetadata']) {
    expect(model(name)).not.toBe('');
  }
  expect(model('Group')).toContain('@@id([definitionId, code])');
  expect(model('GroupMember')).toContain(
    '@@id([definitionId, groupCode, optionCode])',
  );
  expect(model('Alias')).toContain('@@id([definitionId, label])');
  expect(sql()).not.toMatch(
    /identity_nonblank|options_code_nonblank|NOT VALID/,
  );
  // Actual FK, overlap, JSON rejection and legacy-update behavior is exercised by
  // editorial-production-metadata.integration.sh in disposable PostgreSQL.
});
