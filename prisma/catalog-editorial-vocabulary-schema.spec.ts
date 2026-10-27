import { readFileSync } from 'node:fs';
import { join } from 'node:path';

it('backfills vocabulary before constraints without defaults or destructive SQL', () => {
  const sql = readFileSync(
    join(
      __dirname,
      'migrations/20261027080000_editorial_vocabulary/migration.sql',
    ),
    'utf8',
  );
  const schema = readFileSync(join(__dirname, 'schema.prisma'), 'utf8');
  for (const table of ['families', 'definitions', 'options', 'units']) {
    expect(sql).toContain(
      `ALTER TABLE editorial_${table} ADD COLUMN label TEXT`,
    );
    expect(sql).toMatch(
      new RegExp(`UPDATE editorial_${table} SET label = CASE`),
    );
    expect(sql).toContain(`ALTER TABLE editorial_${table} ADD CONSTRAINT`);
  }
  expect(sql).toContain('ELSE "definitionId" END');
  expect(sql).toContain('WHEN "unitCode" IS NULL THEN NULL');
  expect(sql).toContain('(label IS NULL) = ("unitCode" IS NULL)');
  expect(sql).toContain('label IS NULL OR btrim(label) <>');
  for (const table of ['families', 'definitions', 'options']) {
    expect(sql.indexOf(`UPDATE editorial_${table}`)).toBeLessThan(
      sql.indexOf(
        `ALTER TABLE editorial_${table} ALTER COLUMN label SET NOT NULL`,
      ),
    );
  }
  for (const table of ['bindings', 'options', 'units']) {
    expect(sql).toContain(`UPDATE editorial_${table} SET "sortOrder" = 0`);
    expect(sql).toContain(
      `ALTER TABLE editorial_${table} ALTER COLUMN "sortOrder" SET NOT NULL`,
    );
  }
  for (const model of ['Family', 'Definition', 'Option', 'Unit', 'Binding']) {
    const block = new RegExp(`model Editorial${model} \\{[^}]*`).exec(
      schema,
    )![0];
    if (model !== 'Binding') {
      expect(block).toMatch(/label\s+String/);
      expect(block.includes('String?')).toBe(model === 'Unit');
    }
    if (['Option', 'Unit', 'Binding'].includes(model)) {
      expect(block).toMatch(/sortOrder\s+Int\s/);
      expect(block).not.toMatch(/sortOrder[^\n]*@default/);
    }
  }
  expect(sql).not.toMatch(/\b(DROP|DELETE|TRUNCATE|DEFAULT)\b/i);
});
