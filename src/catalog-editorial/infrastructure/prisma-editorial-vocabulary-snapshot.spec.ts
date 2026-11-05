import type { PrismaClient } from '@prisma/client';
import { PrismaEditorialVocabularySnapshot } from './prisma-editorial-vocabulary-snapshot';

describe('PrismaEditorialVocabularySnapshot', () => {
  const setup = (rows: unknown) => {
    const query = jest.fn().mockResolvedValue(rows);
    const reader = new PrismaEditorialVocabularySnapshot({
      $queryRaw: query,
    } as unknown as Pick<PrismaClient, '$queryRaw'>);
    return { reader, query };
  };

  it('returns the raw root by identity in one parameter-free statement', async () => {
    const snapshot = { metadata: null, families: [], definitions: [] };
    const { reader, query } = setup([{ snapshot }]);
    expect(await reader.read()).toBe(snapshot);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]).toHaveLength(1);
  });

  it.each([[], [{ snapshot: {} }, { snapshot: {} }], null])(
    'rejects invalid result cardinality: %j',
    async (rows) => {
      await expect(setup(rows).reader.read()).rejects.toThrow(
        'snapshot result',
      );
    },
  );

  it.each([null, [], {}, { families: [], definitions: [] }])(
    'rejects malformed roots without claiming semantic validation: %j',
    async (snapshot) => {
      await expect(setup([{ snapshot }]).reader.read()).rejects.toThrow(
        'snapshot result',
      );
    },
  );

  describe('definition descriptions (display help, outside every digest)', () => {
    const root = { metadata: null, families: [], definitions: [] };
    const statement = (query: jest.Mock) =>
      (query.mock.calls[0] as [TemplateStringsArray])[0].join('');

    it('keeps the raw definition image free of the description column', async () => {
      const { reader, query } = setup([{ snapshot: root }]);
      await reader.read();
      // Install before-image hashes this raw root: the new column must not enter it.
      expect(statement(query)).toContain("to_jsonb(d) - 'description'");
    });

    it('reads descriptions from the same single statement', async () => {
      const { reader, query } = setup([
        { snapshot: root, descriptions: { 'a.b': 'Texto', 'c.d': 'Otro' } },
      ]);
      const observed = await reader.readWithDescriptions();
      expect(observed.snapshot).toBe(root);
      expect([...observed.descriptions]).toEqual([
        ['a.b', 'Texto'],
        ['c.d', 'Otro'],
      ]);
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0]).toHaveLength(1);
      expect(statement(query)).toMatch(
        /description IS NOT NULL[\s\S]*AS descriptions/,
      );
    });

    it('read() ignores the descriptions column and still returns the root by identity', async () => {
      const { reader } = setup([
        { snapshot: root, descriptions: { 'a.b': 'Texto' } },
      ]);
      expect(await reader.read()).toBe(root);
    });

    it.each([[{}], [undefined], [null]])(
      'treats absent or empty descriptions as none: %j',
      async (descriptions) => {
        const { reader } = setup([{ snapshot: root, descriptions }]);
        expect((await reader.readWithDescriptions()).descriptions.size).toBe(0);
      },
    );

    it.each([[[]], ['x'], [{ 'a.b': null }], [{ 'a.b': 3 }], [{ 'a.b': {} }]])(
      'rejects malformed descriptions without claiming validity: %j',
      async (descriptions) => {
        const { reader } = setup([{ snapshot: root, descriptions }]);
        await expect(reader.readWithDescriptions()).rejects.toThrow(
          'description',
        );
      },
    );

    it('still rejects a malformed root through readWithDescriptions', async () => {
      const { reader } = setup([{ snapshot: null, descriptions: {} }]);
      await expect(reader.readWithDescriptions()).rejects.toThrow(
        'snapshot result',
      );
    });
  });

  it('preserves query error identity', async () => {
    const { reader, query } = setup([]);
    const error = new Error('database failed');
    query.mockRejectedValue(error);
    await expect(reader.read()).rejects.toBe(error);
  });
});
