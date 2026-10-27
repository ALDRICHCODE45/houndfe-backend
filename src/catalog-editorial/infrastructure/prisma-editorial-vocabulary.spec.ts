import { PrismaEditorialVocabulary } from './prisma-editorial-vocabulary';

it('reads one company snapshot with contract order, nulls and archives', async () => {
  const snapshot = { families: [], definitions: [] };
  const query = jest.fn().mockResolvedValue([{ snapshot }]);
  const reader = new PrismaEditorialVocabulary({ $queryRaw: query });
  expect(await reader.read()).toEqual(snapshot);
  expect(query).toHaveBeenCalledTimes(1);
  const [strings, ...values] = query.mock.calls[0] as [
    TemplateStringsArray,
    ...unknown[],
  ];
  const sql = strings.join('').replace(/\s+/g, ' ');
  expect(values).toEqual([]);
  expect(sql).not.toMatch(/tenant|product|LIMIT|OFFSET/i);
  for (const order of [
    'f.label, f.code',
    'b."sortOrder", d.code',
    'd.code',
    'o."sortOrder", o.code',
    'u."sortOrder", u."unitCode" NULLS FIRST',
  ])
    expect(sql).toContain(`ORDER BY ${order}`);
  expect(sql).toContain('o."archivedAt" IS NOT NULL');
  expect(sql).not.toMatch(/WHERE[^)]*archivedAt/);
  expect(sql.match(/'\[\]'::jsonb/g)).toHaveLength(5);
  expect(sql).toContain("'definitionId', d.id, 'definitionCode', d.code");
});
it('does not cache successes or fabricate empty data on failures', async () => {
  const empty = { families: [], definitions: [] };
  const query = jest
    .fn()
    .mockResolvedValueOnce([{ snapshot: empty }])
    .mockRejectedValueOnce(new Error('unavailable'));
  const reader = new PrismaEditorialVocabulary({ $queryRaw: query });
  await expect(reader.read()).resolves.toEqual(empty);
  await expect(reader.read()).rejects.toThrow('unavailable');
});
