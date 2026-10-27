import { Prisma } from '@prisma/client';
import { seedEditorialVocabulary } from './editorial-vocabulary-seed';
import { STARTER_V1 } from './editorial-vocabulary-seed.data';

it('upserts the starter in dependency order, deterministically, without deletes', async () => {
  const rows = new Map<string, unknown[]>();
  const calls: Prisma.Sql[] = [];
  const client = {
    $executeRaw: jest.fn((sql: Prisma.Sql) => {
      calls.push(sql);
      const table = /INSERT INTO (editorial_\w+)/.exec(sql.text)?.[1];
      expect(table).toBeDefined();
      expect(sql.text).toContain('ON CONFLICT');
      expect(sql.text).not.toMatch(/DELETE|TRUNCATE|DROP/);
      rows.set(
        `${table}:${String(sql.values[0])}:${String(sql.values[1])}`,
        sql.values,
      );
      return Promise.resolve(1);
    }),
  };
  await seedEditorialVocabulary(client);
  const first = [...rows.entries()];
  const firstCalls = calls.map((sql) => [sql.text, sql.values]);
  await seedEditorialVocabulary(client);
  expect([...rows.entries()]).toEqual(first);
  expect(
    calls.slice(firstCalls.length).map((sql) => [sql.text, sql.values]),
  ).toEqual(firstCalls);
  expect(calls[0].text).toContain('INSERT INTO editorial_families');
  for (let i = 0; i < STARTER_V1.definitions.length; i++) {
    expect(calls[1 + i * 2].text).toContain(
      'INSERT INTO editorial_definitions',
    );
    const binding = calls[2 + i * 2];
    expect(binding.text).toContain('INSERT INTO editorial_bindings');
    expect(binding.values).toContain(STARTER_V1.definitions[i].sortOrder);
    expect(binding.values).toContain(STARTER_V1.definitions[i].owner);
  }
  const options = calls.filter((sql) =>
    sql.text.includes('INSERT INTO editorial_options'),
  );
  expect(options.length).toBeGreaterThan(0);
  const lastBinding = 2 * STARTER_V1.definitions.length;
  expect(calls[lastBinding + 1].text).toContain(
    'INSERT INTO editorial_options',
  );
  expect(calls[lastBinding + 1 + STARTER_V1.options.length].text).toContain(
    'INSERT INTO editorial_units',
  );
  for (const sql of options) {
    expect(sql.text).toContain('ELSE editorial_options."archivedAt" END');
    expect(sql.values).toContain(false);
  }
  expect(STARTER_V1.definitions.map((d) => d.type).sort()).toEqual([
    'boolean',
    'multi',
    'number',
    'single',
    'text',
  ]);
  expect(calls.some((sql) => sql.values.includes(null))).toBe(true);
});

it('archives only when explicitly requested by versioned data', async () => {
  const execute = jest.fn((sql: Prisma.Sql) => {
    expect(sql).toBeDefined();
    return Promise.resolve(1);
  });
  const data = structuredClone(STARTER_V1);
  data.options[0].archived = true;
  await seedEditorialVocabulary({ $executeRaw: execute }, data);
  const option = execute.mock.calls
    .map(([sql]) => sql)
    .find((sql) => sql.text.includes('INSERT INTO editorial_options'))!;
  expect(option.values).toContain(true);
  expect(option.text).toContain('COALESCE(editorial_options."archivedAt",');
});

it('retains omitted records and parameterizes edited labels and order', async () => {
  const execute = jest.fn((sql: Prisma.Sql) => {
    expect(sql.text).not.toMatch(/DELETE|TRUNCATE|DROP/);
    return Promise.resolve(1);
  });
  const data = structuredClone(STARTER_V1);
  data.definitions[0].label = "Quoted ' label";
  data.definitions[0].sortOrder = -7;
  data.options = [];
  data.units = [];
  await seedEditorialVocabulary({ $executeRaw: execute }, data);
  const calls = execute.mock.calls.map(([sql]) => sql);
  expect(calls).toHaveLength(1 + 2 * data.definitions.length);
  expect(calls[1].values).toContain("Quoted ' label");
  expect(calls[1].text).not.toContain("Quoted ' label");
  expect(calls[2].values).toContain(-7);
  expect(calls[2].text).toContain('owner = EXCLUDED.owner');
  expect(calls[2].text).toContain('"sortOrder" = EXCLUDED."sortOrder"');
});
