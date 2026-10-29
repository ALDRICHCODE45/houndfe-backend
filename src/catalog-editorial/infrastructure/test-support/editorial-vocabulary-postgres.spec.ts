import {
  DockerExecutor,
  withEditorialPostgres,
} from './editorial-vocabulary-postgres';

function harness(fail?: (args: string[]) => void) {
  const commands: string[][] = [];
  const execute: DockerExecutor = jest.fn((args) => {
    commands.push(args);
    fail?.(args);
    if (args[0] === 'create') return 'owned-id';
    if (args[0] === 'inspect') return '';
    if (args[0] === 'ps') return '';
    return '42\n';
  });
  return { execute, commands };
}

it('isolates PostgreSQL 16, executes SQL, and verifies removal before returning', async () => {
  const { execute, commands } = harness();
  await expect(
    withEditorialPostgres(
      (db) => Promise.resolve(db.sql('SELECT 42')),
      execute,
    ),
  ).resolves.toBe('42\n');
  const create = commands[0];
  expect(create).toEqual(
    expect.arrayContaining([
      '--network',
      'none',
      '--tmpfs',
      '/var/lib/postgresql/data',
      'postgres:16',
    ]),
  );
  for (const flag of ['--publish', '--volume', '--mount', '-p', '-v']) {
    expect(create).not.toContain(flag);
  }
  expect(commands.find((args) => args.includes('pg_isready'))).toContain(
    '127.0.0.1',
  );
  expect(commands.find((args) => args.includes('psql'))).toEqual(
    expect.arrayContaining([
      '-X',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'postgres',
    ]),
  );
  expect(commands.slice(-2).map((args) => args[0])).toEqual(['rm', 'ps']);
  expect(commands.at(-2)).toEqual(['rm', '-f', 'owned-id']);
  expect(execute).toHaveBeenCalledWith(expect.any(Array), 'SELECT 42', 10000);
});

it('uses a different owned name on each invocation', async () => {
  const { execute, commands } = harness();
  await withEditorialPostgres(() => Promise.resolve(), execute);
  await withEditorialPostgres(() => Promise.resolve(), execute);
  const names = commands
    .filter((args) => args[0] === 'create')
    .map((args) => args[args.indexOf('--name') + 1]);
  expect(new Set(names).size).toBe(2);
});

it.each(['start', 'exec'])(
  'cleans up after %s setup failure without calling the callback',
  async (stage) => {
    const failure = new Error(stage);
    const { execute, commands } = harness((args) => {
      if (args[0] === stage) throw failure;
    });
    const use = jest.fn();
    await expect(withEditorialPostgres(use, execute)).rejects.toBe(failure);
    expect(use).not.toHaveBeenCalled();
    expect(commands).toContainEqual(['rm', '-f', 'owned-id']);
    if (stage === 'exec') {
      expect(commands.filter((args) => args[0] === 'exec')).toHaveLength(30);
    }
  },
);

it('does not clean up when create failed and ownership cannot be established', async () => {
  const failure = new Error('create failed');
  const { execute, commands } = harness((args) => {
    if (args[0] === 'create') throw failure;
  });
  await expect(withEditorialPostgres(jest.fn(), execute)).rejects.toBe(failure);
  expect(commands.some((args) => args[0] === 'rm')).toBe(false);
});

it('recovers an owned container when create times out after creation', async () => {
  const failure = new Error('create timed out');
  const execute: DockerExecutor = jest.fn((args) => {
    if (args[0] === 'create') throw failure;
    if (args[0] === 'inspect') {
      const name = args.at(-1)!;
      return JSON.stringify([
        {
          Id: 'partial-id',
          Config: { Labels: { 'houndfe.editorial-proof': name } },
        },
      ]);
    }
    return '';
  });
  await expect(withEditorialPostgres(jest.fn(), execute)).rejects.toBe(failure);
  expect(execute).toHaveBeenCalledWith(
    ['rm', '-f', 'partial-id'],
    undefined,
    10000,
  );
});

it('preserves callback failure when cleanup also fails', async () => {
  const failure = new Error('callback failed');
  const { execute } = harness((args) => {
    if (args[0] === 'rm') throw new Error('cleanup failed');
  });
  await expect(
    withEditorialPostgres(() => Promise.reject(failure), execute),
  ).rejects.toBe(failure);
  expect(
    (failure as Error & { cleanupError?: Error }).cleanupError?.message,
  ).toBe('cleanup failed');
});

it.each(['removal fails', 'container remains'])(
  'fails a successful callback when %s',
  async (mode) => {
    const execute: DockerExecutor = jest.fn((args) => {
      if (args[0] === 'create') return 'owned-id';
      if (args[0] === 'rm' && mode === 'removal fails') throw new Error(mode);
      return args[0] === 'ps' ? 'owned-id' : '';
    });
    await expect(
      withEditorialPostgres(() => Promise.resolve(), execute),
    ).rejects.toThrow();
  },
);
