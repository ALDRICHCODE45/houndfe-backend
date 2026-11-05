import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const migrationName = '20261104030000_editorial_definition_description';
const schema = readFileSync(join(__dirname, 'schema.prisma'), 'utf8');
const sql = () =>
  readFileSync(
    join(__dirname, 'migrations', migrationName, 'migration.sql'),
    'utf8',
  );
const definitionModel = () =>
  schema.split('model EditorialDefinition {')[1].split('\n}')[0];

describe('editorial definition description storage', () => {
  it('adds one nullable VarChar(200) column to EditorialDefinition only', () => {
    expect(definitionModel()).toMatch(
      /^\s*description\s+String\?\s+@db\.VarChar\(200\)\s*$/m,
    );
    expect(schema.match(/@db\.VarChar\(200\)/g)).toHaveLength(1);
  });

  it('is a single additive ALTER: no default, no backfill, no other column touched', () => {
    const statements = sql()
      .replace(/--.*$/gm, '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toEqual([
      'ALTER TABLE "editorial_definitions" ADD COLUMN "description" VARCHAR(200)',
    ]);
    expect(statements.join(';')).not.toMatch(
      /\b(UPDATE|INSERT|DELETE|DROP|DEFAULT|NOT NULL)\b/i,
    );
  });

  it('is the newest migration, so deploy applies it after every existing one', () => {
    const names = readdirSync(join(__dirname, 'migrations'))
      .filter((n) => /^\d{14}_/.test(n))
      .sort();
    expect(names[names.length - 1]).toBe(migrationName);
  });
});
