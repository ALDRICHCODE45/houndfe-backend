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

  it('preserves query error identity', async () => {
    const { reader, query } = setup([]);
    const error = new Error('database failed');
    query.mockRejectedValue(error);
    await expect(reader.read()).rejects.toBe(error);
  });
});
