import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import {
  loadEditorialPostgresClient,
  type BindingLoaderDependencies,
} from './editorial-coordination-postgres-binding';
import type {
  PinnedPostgresTarget,
  PostgresBinding,
} from './editorial-coordination-postgres-harness';

const pinned: PinnedPostgresTarget = {
  containerId: 'a'.repeat(64),
  imageId: `sha256:${'b'.repeat(64)}`,
  name: 'editorial-coordination-unit',
  owner: 'offline-parent',
  host: '127.0.0.1',
  port: 54321,
  database: 'editorial_test_unit',
  user: 'editorial_test_unit',
};
const payload = {
  binding: {
    target: pinned,
    schema: 'editorial_test_0123456789abcdef',
    password: 'SYNTHETIC-PRIVATE-CONTENT',
  },
  pinned,
};
const denied = 'Editorial PostgreSQL binding denied';

describe('offline binding file admission', () => {
  let directory: string;
  let path: string;
  let dependencies: Partial<BindingLoaderDependencies>;
  const client = {} as PrismaClient;
  const construct = jest.fn<
    Promise<PrismaClient>,
    [PostgresBinding, PinnedPostgresTarget]
  >(() => Promise.resolve(client));
  const env = jest.fn((): string | undefined => path);

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'editorial-binding-'));
    path = join(directory, 'binding.json');
    await writeFile(path, JSON.stringify(payload), { mode: 0o600 });
    construct.mockClear();
    env.mockReset().mockImplementation(() => path);
    dependencies = { env, construct };
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function reject(patch: Partial<BindingLoaderDependencies> = {}) {
    await expect(
      loadEditorialPostgresClient({ ...dependencies, ...patch }),
    ).rejects.toEqual(new Error(denied));
    expect(construct).not.toHaveBeenCalled();
  }

  it('returns the admitted client exactly once, without connecting or querying', async () => {
    const opened = jest.fn(open);
    await expect(
      loadEditorialPostgresClient({ ...dependencies, open: opened }),
    ).resolves.toBe(client);
    expect(env.mock.calls).toEqual([['EDITORIAL_COORDINATION_PG_BINDING']]);
    expect(construct.mock.calls).toEqual([[payload.binding, payload.pinned]]);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  });
  it.each([undefined, ''])(
    'denies missing/empty variable %s before filesystem effects',
    async (value) => {
      env.mockReturnValue(value);
      const stat = jest.fn((file: string) => lstat(file));
      const opened = jest.fn(open);
      await reject({ lstat: stat, open: opened });
      expect(stat).not.toHaveBeenCalled();
      expect(opened).not.toHaveBeenCalled();
    },
  );
  it('denies relative paths', async () => {
    path = 'binding.json';
    await reject();
  });
  it('denies a path inside the real repository root', async () => {
    await reject({ repoRoot: dirname(directory) });
  });
  it('denies symlink files', async () => {
    const link = join(directory, 'link');
    await symlink(path, link);
    path = link;
    await reject();
  });
  it('denies directories', async () => {
    path = directory;
    await reject();
  });
  it('denies a parent symlink resolving into the repository', async () => {
    await symlink(directory, join(directory, 'alias'));
    path = join(directory, 'alias', 'binding.json');
    await reject({ repoRoot: directory });
  });
  it('accepts a sibling whose name shares the repository prefix', async () => {
    const root = join(directory, 'binding');
    await mkdir(root);
    await expect(
      loadEditorialPostgresClient({ ...dependencies, repoRoot: root }),
    ).resolves.toBe(client);
  });
  it.each([0o644, 0o640, 0o4600])('denies mode %s', async (mode) => {
    await chmod(path, mode);
    await reject();
  });
  it('denies the wrong owner', async () => {
    await reject({ uid: () => (process.getuid?.() ?? 0) + 1 });
  });
  it('denies an unavailable uid', async () => {
    await reject({ uid: () => undefined });
  });
  it('denies files over 4 KiB', async () => {
    await writeFile(path, 'x'.repeat(4097));
    await reject();
  });
  it.each([
    'not-json-SYNTHETIC-PRIVATE-CONTENT',
    '{}',
    '[]',
    'null',
    JSON.stringify({ ...payload, extra: true }),
    JSON.stringify({ binding: payload.binding }),
    JSON.stringify({ pinned }),
    JSON.stringify({ binding: null, pinned }),
    JSON.stringify({ binding: [], pinned }),
    JSON.stringify({ binding: payload.binding, pinned: 'invalid' }),
  ])('denies malformed/closed-shape violations (case %#)', async (text) => {
    await writeFile(path, text);
    await reject();
  });
  it('redacts file errors, paths and constructor errors', async () => {
    construct.mockRejectedValueOnce(
      new Error(`${path}: ${payload.binding.password}`),
    );
    await expect(loadEditorialPostgresClient(dependencies)).rejects.toEqual(
      new Error(denied),
    );
    construct.mockClear();
    await reject({
      open: () =>
        Promise.reject(new Error(`${path}: ${payload.binding.password}`)),
    });
  });
  it.each(['dev', 'ino'] as const)(
    'rejects a replaced %s and closes the opened descriptor',
    async (field) => {
      const handle = await open(path, constants.O_RDONLY);
      const close = jest.fn(() => handle.close());
      try {
        await reject({
          open: () =>
            Promise.resolve({
              stat: async () => {
                const stat = await handle.stat();
                stat[field] += 1;
                return stat;
              },
              read: (...args) => handle.read(...args),
              close,
            }),
        });
        expect(close).toHaveBeenCalledTimes(1);
      } finally {
        if (!close.mock.calls.length) await handle.close();
      }
    },
  );
  it('rechecks permissions on the opened descriptor and closes on rejection', async () => {
    const close = jest.fn<Promise<void>, []>();
    await reject({
      open: async () => {
        await chmod(path, 0o644);
        const handle = await open(path, constants.O_RDONLY);
        close.mockImplementation(() => handle.close());
        return {
          stat: () => handle.stat(),
          read: (...args) => handle.read(...args),
          close,
        };
      },
    });
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('bounds reading even if the file grows after fstat', async () => {
    await reject({
      open: async () => {
        const handle = await open(path, constants.O_RDONLY);
        return {
          stat: () => handle.stat(),
          close: () => handle.close(),
          read: async (...args) => {
            await writeFile(path, 'x'.repeat(4097));
            return handle.read(...args);
          },
        };
      },
    });
  });
  it('accepts exactly 4 KiB with partial reads, closing before construction', async () => {
    await writeFile(path, JSON.stringify(payload).padEnd(4096, ' '));
    const handle = await open(path, constants.O_RDONLY);
    const close = jest.fn(() => handle.close());
    construct.mockImplementationOnce(() => {
      expect(close).toHaveBeenCalledTimes(1);
      return Promise.resolve(client);
    });
    await expect(
      loadEditorialPostgresClient({
        ...dependencies,
        open: () =>
          Promise.resolve({
            stat: () => handle.stat(),
            read: (buffer, offset, length, position) =>
              handle.read(buffer, offset, Math.min(length, 17), position),
            close,
          }),
      }),
    ).resolves.toBe(client);
  });
  it.each(['read', 'close'])(
    'redacts %s failures and closes the descriptor',
    async (failure) => {
      const handle = await open(path, constants.O_RDONLY);
      const close = jest.fn(async () => {
        await handle.close();
        if (failure === 'close') throw new Error(payload.binding.password);
      });
      await reject({
        open: () =>
          Promise.resolve({
            stat: () => handle.stat(),
            read: (...args) =>
              failure === 'read'
                ? Promise.reject(new Error(payload.binding.password))
                : handle.read(...args),
            close,
          }),
      });
      expect(close).toHaveBeenCalledTimes(1);
    },
  );
  it('delegates nested admission to U5a and redacts its rejection', async () => {
    await writeFile(path, JSON.stringify({ binding: {}, pinned: {} }));
    construct.mockRejectedValueOnce(new Error(payload.binding.password));
    await expect(loadEditorialPostgresClient(dependencies)).rejects.toEqual(
      new Error(denied),
    );
    expect(construct.mock.calls).toEqual([[{}, {}]]);
  });
  it('resolves both paths before comparing containment', async () => {
    const resolvePath = jest.fn((file: string) => realpath(file));
    await reject({ realpath: resolvePath, repoRoot: directory });
    expect(resolvePath).toHaveBeenCalledWith(directory);
    expect(resolvePath).toHaveBeenCalledWith(path);
  });
});
