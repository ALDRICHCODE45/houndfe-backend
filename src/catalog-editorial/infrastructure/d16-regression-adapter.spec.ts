import { d16Postgres } from './d16-postgres-runner';
import { isolatedPostgres } from './d16-regression-adapter';

jest.mock('./d16-postgres-runner');
const open = jest.mocked(d16Postgres);
afterEach(() => jest.resetAllMocks());
it('returns only the new target first client after disconnecting the unused second', async () => {
  const db = {
    first: { $disconnect: jest.fn() },
    second: { $disconnect: jest.fn().mockResolvedValue(undefined) },
    close: jest.fn(),
  };
  open.mockResolvedValue(
    db as unknown as Awaited<ReturnType<typeof d16Postgres>>,
  );
  expect(await isolatedPostgres()).toBe(db.first);
  expect(open).toHaveBeenCalledTimes(1);
  expect(db.second.$disconnect).toHaveBeenCalledTimes(1);
  expect(db.first.$disconnect).not.toHaveBeenCalled();
});
it('disconnects both clients and propagates failure without fallback', async () => {
  const error = new Error('disconnect failed');
  const db = {
    first: { $disconnect: jest.fn().mockResolvedValue(undefined) },
    second: { $disconnect: jest.fn().mockRejectedValue(error) },
    close: jest.fn(),
  };
  open.mockResolvedValue(
    db as unknown as Awaited<ReturnType<typeof d16Postgres>>,
  );
  await expect(isolatedPostgres()).rejects.toBe(error);
  expect(db.first.$disconnect).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledTimes(1);
});
