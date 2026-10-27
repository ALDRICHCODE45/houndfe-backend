import child from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { withEditorialReferenceDatabase } from '../infrastructure/editorial-reference-experiment-runner';

jest.mock('@prisma/client', () => ({ PrismaClient: jest.fn() }));
const id = 'c5a4f914265edb542ab7506905952314dff5228d5ebd7e8efa377f49e3ae38c8';
const image =
  'sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb';
const database = 'editorial_refs_isolated';
const admitted = () => [
  id,
  '/editorial-refs-01a1764b-20261027',
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
  false,
  {
    'houndfe.test': 'editorial-reference-consistency',
    'houndfe.owner': '01a1764b',
  },
];
const construct = PrismaClient as jest.Mock;
let inspect: jest.SpyInstance;
const client = () => ({
  $connect: jest.fn().mockResolvedValue(undefined),
  $disconnect: jest.fn().mockResolvedValue(undefined),
  $queryRawUnsafe: jest.fn().mockResolvedValue([{ database }]),
  $executeRawUnsafe: jest.fn().mockResolvedValue(0),
});
beforeEach(() => {
  inspect = jest
    .spyOn(child, 'execFileSync')
    .mockReturnValue(JSON.stringify(admitted()));
  construct.mockReset().mockImplementation(client);
});
afterEach(() => inspect.mockRestore());

test.each([
  [0, 'another-id'],
  [1, '/collision'],
  [2, 'another-image'],
  [3, false],
  [4, { '/var/lib/postgresql/data': 'rw' }],
  [5, ['/host:/data']],
  [6, [{ Type: 'volume' }]],
  [7, { '5432/tcp': [{ HostPort: '5432' }] }],
  [8, { '5432/tcp': [{ HostPort: '5432' }] }],
  [9, 'not-an-ip'],
  [10, true],
  [11, 'host'],
  [12, []],
  [13, true],
  [14, {}],
])(
  'rejects drift at projection field %s before constructing clients',
  async (index, value) => {
    const fields = admitted();
    fields[index] = value as never;
    inspect.mockReturnValue(JSON.stringify(fields));
    const callback = jest.fn();
    await expect(withEditorialReferenceDatabase(callback)).rejects.toThrow(
      'admission denied',
    );
    expect(construct).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  },
);
test.each(['not-json', 'null', '{}', '[]'])(
  'rejects malformed inspection %s',
  async (raw) => {
    inspect.mockReturnValue(raw);
    await expect(withEditorialReferenceDatabase(jest.fn())).rejects.toThrow(
      'admission denied',
    );
    expect(construct).not.toHaveBeenCalled();
  },
);
test('inspection error/missing target cannot construct or invoke callback', async () => {
  inspect.mockImplementation(() => {
    throw new Error('missing target');
  });
  const callback = jest.fn();
  await expect(withEditorialReferenceDatabase(callback)).rejects.toThrow(
    'admission denied',
  );
  expect(construct).not.toHaveBeenCalled();
  expect(callback).not.toHaveBeenCalled();
});
test.each([false, true])(
  'owns schema and disconnects independent clients; callback failure=%s',
  async (fail) => {
    const first = client(),
      second = client();
    construct
      .mockReset()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    let schema = '';
    const run = withEditorialReferenceDatabase(async (db) => {
      await Promise.resolve();
      schema = db.schema;
      expect(db.first).not.toBe(db.second);
      if (fail) throw new Error('callback failure');
      return 'ok';
    });
    if (fail) await expect(run).rejects.toThrow('callback failure');
    else await expect(run).resolves.toBe('ok');
    expect(first.$executeRawUnsafe.mock.calls).toEqual([
      [`CREATE SCHEMA "${schema}"`],
      [`DROP SCHEMA "${schema}" CASCADE`],
    ]);
    expect(first.$disconnect).toHaveBeenCalledTimes(1);
    expect(second.$disconnect).toHaveBeenCalledTimes(1);
    const [, args, execution] = inspect.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(args).toEqual(
      expect.arrayContaining(['--host', 'unix:///var/run/docker.sock', id]),
    );
    expect(execution.env).toEqual({ PATH: '/usr/bin:/bin' });
    const [options] = construct.mock.calls[0] as [
      {
        __internal: {
          configOverride: (
            config: Record<string, unknown>,
          ) => Record<string, unknown>;
        };
      },
    ];
    expect(
      options.__internal.configOverride({
        relativeEnvPaths: 'forbidden',
        injectableEdgeEnv: 'forbidden',
      }),
    ).toEqual({ relativeEnvPaths: undefined, injectableEdgeEnv: undefined });
  },
);
test('cleanup failure still disconnects both clients', async () => {
  const first = client(),
    second = client();
  first.$executeRawUnsafe
    .mockResolvedValueOnce(0)
    .mockRejectedValueOnce(new Error('drop failure'));
  construct.mockReset().mockReturnValueOnce(first).mockReturnValueOnce(second);
  await expect(
    withEditorialReferenceDatabase(() => Promise.resolve(undefined)),
  ).rejects.toThrow('drop failure');
  expect(first.$disconnect).toHaveBeenCalled();
  expect(second.$disconnect).toHaveBeenCalled();
});
test('identity failure does not create a schema or call SQL callback', async () => {
  const first = client();
  first.$queryRawUnsafe.mockResolvedValue([{ database: 'wrong' }]);
  construct
    .mockReset()
    .mockReturnValueOnce(first)
    .mockReturnValueOnce(client());
  const callback = jest.fn();
  await expect(withEditorialReferenceDatabase(callback)).rejects.toThrow(
    'Database identity mismatch',
  );
  expect(first.$executeRawUnsafe).not.toHaveBeenCalled();
  expect(callback).not.toHaveBeenCalled();
});

(process.env.EDITORIAL_REFERENCE_SMOKE === '1' ? test : test.skip)(
  'NEW target public SQL smoke: database, sessions, shared owned schema, cleanup',
  async () => {
    inspect.mockRestore();
    const Actual =
      jest.requireActual<typeof import('@prisma/client')>(
        '@prisma/client',
      ).PrismaClient;
    construct.mockImplementation(
      (options: ConstructorParameters<typeof Actual>[0]) => new Actual(options),
    );
    const schemas: string[] = [];
    for (const fail of [false, true]) {
      const run = withEditorialReferenceDatabase(
        async ({ first, second, schema }) => {
          schemas.push(schema);
          const sql =
            'SELECT current_database() AS database, current_schema() AS schema, pg_backend_pid() AS pid';
          const a =
            await first.$queryRawUnsafe<
              { database: string; schema: string; pid: number }[]
            >(sql);
          const b = await second.$queryRawUnsafe<typeof a>(sql);
          expect(a[0]).toMatchObject({ database, schema });
          expect(b[0]).toMatchObject({ database, schema });
          expect(a[0].pid).not.toBe(b[0].pid);
          // Both current schemas were verified above; no dynamic SQL identifiers.
          await first.$executeRawUnsafe('CREATE TABLE smoke (value integer)');
          await first.$executeRawUnsafe('INSERT INTO smoke VALUES (7)');
          expect(
            await second.$queryRawUnsafe('SELECT value FROM smoke'),
          ).toEqual([{ value: 7 }]);
          if (fail) throw new Error('smoke callback failure');
        },
      );
      if (fail) await expect(run).rejects.toThrow('smoke callback failure');
      else await run;
    }
    await withEditorialReferenceDatabase(async ({ first }) => {
      for (const schema of schemas) {
        expect(
          await first.$queryRawUnsafe(
            'SELECT nspname FROM pg_namespace WHERE nspname = $1',
            schema,
          ),
        ).toEqual([]);
      }
    });
  },
);
