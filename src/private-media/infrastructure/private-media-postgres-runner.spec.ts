import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { withPrivateMediaTestDatabase } from './private-media-postgres-runner';
jest.mock('node:child_process', () => ({ execFileSync: jest.fn() }));
jest.mock('@prisma/client', () => ({ PrismaClient: jest.fn() }));
const id = '07307784d255d8cc37b8e0a3d02c727d131478b55a6f089da313075e45f2e0e1';
const image =
  'sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb';
const inspect = jest.mocked(execFileSync);
const construct = jest.mocked(PrismaClient);
const metadata = (): unknown[] => [
  id,
  '/private-media-offline-01a1764b-20261026',
  image,
  true,
  { '/var/lib/postgresql/data': 'rw,nosuid,noexec,size=268435456' },
  null,
  [],
  {},
  { '5432/tcp': null },
  '172.17.0.2',
  false,
  'bridge',
  null,
];
const client = () => ({
  $connect: jest.fn().mockResolvedValue(undefined),
  $disconnect: jest.fn().mockResolvedValue(undefined),
  $executeRawUnsafe: jest.fn<Promise<number>, [string]>().mockResolvedValue(0),
  $queryRawUnsafe: jest
    .fn()
    .mockResolvedValue([{ database: 'private_media_isolated' }]),
});
let first: ReturnType<typeof client>;
let second: ReturnType<typeof client>;
beforeEach(() => {
  jest.resetAllMocks();
  inspect.mockReturnValue(JSON.stringify(metadata()));
  first = client();
  second = client();
  construct
    .mockImplementationOnce(() => first as unknown as PrismaClient)
    .mockImplementationOnce(() => second as unknown as PrismaClient);
});
test.each<[string, number, unknown]>([
  ['id', 0, 'wrong'],
  ['name', 1, '/wrong'],
  ['image', 2, 'wrong'],
  ['stopped', 3, false],
  ['tmpfs', 4, {}],
  ['binds', 5, ['/host:/data']],
  ['mounts', 6, [{}]],
  ['bindings', 7, { '5432/tcp': [{}] }],
  ['ports', 8, { '5432/tcp': [{ HostPort: '5432' }] }],
  ['address', 9, 'not-an-ip'],
  ['privileged', 10, true],
  ['network', 11, 'host'],
  ['host mounts', 12, [{}]],
])('rejects %s before any client/SQL', async (_label, index, value) => {
  const snapshot = metadata();
  snapshot[index] = value;
  inspect.mockReturnValue(JSON.stringify(snapshot));
  const callback = jest.fn();
  await expect(withPrivateMediaTestDatabase(callback)).rejects.toEqual(
    new Error('Private media target admission denied'),
  );
  expect(construct).not.toHaveBeenCalled();
  expect(callback).not.toHaveBeenCalled();
  for (const db of [first, second]) {
    expect(db.$connect).not.toHaveBeenCalled();
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
  }
});
test.each(['missing', 'malformed'])(
  'rejects %s inspection',
  async (failure) => {
    inspect.mockImplementation(() => {
      if (failure === 'missing') throw new Error('missing');
      return 'invalid-json';
    });
    await expect(withPrivateMediaTestDatabase(jest.fn())).rejects.toEqual(
      new Error('Private media target admission denied'),
    );
    expect(construct).not.toHaveBeenCalled();
  },
);
test('returns callback result and cleans only its own random schema', async () => {
  await expect(
    withPrivateMediaTestDatabase(({ first: a, second: b, schema }) => {
      expect(a).toBe(first);
      expect(b).toBe(second);
      expect(schema).toMatch(/^pm_test_[a-f0-9]{32}$/);
      return Promise.resolve(42);
    }),
  ).resolves.toBe(42);
  expect(inspect.mock.calls[0][1]?.at(-1)).toBe(id);
  expect(construct).toHaveBeenCalledTimes(2);
  const options = construct.mock.calls[0][0] as unknown as {
    datasources: { db: { url: string } };
    __internal: { configOverride: (config: object) => object };
  };
  expect(options.datasources.db.url).toContain('connection_limit=1');
  expect(options.datasources.db.url).toContain(
    '@172.17.0.2:5432/private_media_isolated?',
  );
  expect(
    options.__internal.configOverride({
      relativeEnvPaths: {},
      injectableEdgeEnv: {},
    }),
  ).toEqual({ relativeEnvPaths: undefined, injectableEdgeEnv: undefined });
  const create = first.$executeRawUnsafe.mock.calls[0][0];
  expect(first.$executeRawUnsafe.mock.calls.at(-1)?.[0]).toBe(
    create.replace('CREATE SCHEMA', 'DROP SCHEMA') + ' CASCADE',
  );
  for (const db of [first, second]) {
    expect(db.$disconnect).toHaveBeenCalledTimes(1);
  }
});
test.each([
  'callback',
  'first connect',
  'second connect',
  'identity',
  'create',
  'second constructor',
  'drop',
])('cleans/disconnects after %s failure', async (failure) => {
  if (failure === 'first connect') {
    first.$connect.mockRejectedValueOnce(new Error(failure));
  }
  if (failure === 'second connect') {
    second.$connect.mockRejectedValueOnce(new Error(failure));
  }
  if (failure === 'identity') {
    first.$queryRawUnsafe.mockResolvedValueOnce([{ database: 'wrong' }]);
  }
  if (failure === 'create') {
    first.$executeRawUnsafe.mockRejectedValueOnce(new Error(failure));
  }
  if (failure === 'drop') {
    first.$executeRawUnsafe
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(new Error(failure));
  }
  if (failure === 'second constructor') {
    construct
      .mockReset()
      .mockImplementationOnce(() => first as unknown as PrismaClient)
      .mockImplementationOnce(() => {
        throw new Error(failure);
      });
  }
  await expect(
    withPrivateMediaTestDatabase(() => {
      if (failure === 'callback') return Promise.reject(new Error(failure));
      return Promise.resolve();
    }),
  ).rejects.toThrow();
  expect(first.$disconnect).toHaveBeenCalledTimes(1);
  if (failure !== 'second constructor') {
    expect(second.$disconnect).toHaveBeenCalledTimes(1);
  }
  const shouldDrop = ['callback', 'second connect', 'drop'].includes(failure);
  expect(
    first.$executeRawUnsafe.mock.calls.some(([sql]) => sql.startsWith('DROP')),
  ).toBe(shouldDrop);
});
