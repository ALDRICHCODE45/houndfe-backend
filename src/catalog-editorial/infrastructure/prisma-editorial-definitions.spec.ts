import { PrismaEditorialDefinitions } from './prisma-editorial-definitions';

it('queries the current persisted source rather than fabricating empty data', async () => {
  const snapshot = {
    families: [{ id: 'f', code: 'family', bindings: [] }],
    definitions: [],
  };
  const query = jest.fn().mockResolvedValue([{ snapshot }]);
  const reader = new PrismaEditorialDefinitions({ $queryRaw: query });
  expect(await reader.read()).toEqual(snapshot);
  expect(query).toHaveBeenCalledTimes(1);
});
it('returns an observed empty catalogue without inventing vocabulary', async () => {
  const empty = { families: [], definitions: [] };
  const query = jest.fn().mockResolvedValue([{ snapshot: empty }]);
  expect(
    await new PrismaEditorialDefinitions({ $queryRaw: query }).read(),
  ).toEqual(empty);
  expect(query).toHaveBeenCalledTimes(1);
});
it('propagates dependency failures instead of returning an empty success', async () => {
  const failure = new Error('database unavailable');
  const query = jest.fn().mockRejectedValue(failure);
  await expect(
    new PrismaEditorialDefinitions({ $queryRaw: query }).read(),
  ).rejects.toBe(failure);
});
it('does not cache a prior observation across reads', async () => {
  const query = jest
    .fn()
    .mockResolvedValueOnce([{ snapshot: { families: [], definitions: [] } }])
    .mockRejectedValueOnce(new Error('later unavailable'));
  const reader = new PrismaEditorialDefinitions({ $queryRaw: query });
  await expect(reader.read()).resolves.toEqual({
    families: [],
    definitions: [],
  });
  await expect(reader.read()).rejects.toThrow('later unavailable');
  expect(query).toHaveBeenCalledTimes(2);
});
