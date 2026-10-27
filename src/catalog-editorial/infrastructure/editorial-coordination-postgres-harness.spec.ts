import { readFile } from 'node:fs/promises';
import {
  constructEditorialPostgresClient,
  type HarnessClientOptions,
  type PinnedPostgresTarget,
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
const safeSource =
  'const config = { "relativeEnvPaths": {"rootEnvPath":null} };';
const request = () => ({
  target: { ...pinned },
  schema: 'editorial_test_0123456789abcdef',
  password: 'disposable:@/?#% password',
});
function fixture(source = safeSource) {
  const effects = {
    connect: jest.fn(),
    query: jest.fn(),
    disconnect: jest.fn(),
  };
  const constructor = jest.fn((options: HarnessClientOptions) => ({
    options,
    ...effects,
  }));
  class Client {
    constructor(options: HarnessClientOptions) {
      Object.assign(this, constructor(options));
    }
  }
  const loadClient = jest.fn(() => Promise.resolve(Client));
  const readSource = jest.fn(() => Promise.resolve(source));
  return { constructor, effects, dependencies: { loadClient, readSource } };
}

describe('offline editorial PostgreSQL foundation', () => {
  it.each([
    ['foreign host', { host: 'localhost' }],
    ['nonloopback', { host: '192.0.2.1' }],
    ['wrong port', { port: 54322 }],
    ['invalid port', { port: 0 }],
    ['database', { database: 'production' }],
    ['user', { user: 'postgres' }],
    ['container', { containerId: 'c'.repeat(64) }],
    ['short container', { containerId: 'abc' }],
    ['image', { imageId: `sha256:${'c'.repeat(64)}` }],
    ['name', { name: 'foreign' }],
    ['owner', { owner: 'foreign' }],
    ['metadata permission', { approved: true }],
  ])('denies %s before source inspection/loading', async (_label, patch) => {
    const f = fixture();
    const binding = request();
    Object.assign(binding.target, patch);
    await expect(
      constructEditorialPostgresClient(binding, pinned, f.dependencies),
    ).rejects.toThrow('denied');
    expect(f.dependencies.readSource).not.toHaveBeenCalled();
    expect(f.dependencies.loadClient).not.toHaveBeenCalled();
    expect(f.constructor).not.toHaveBeenCalled();
    Object.values(f.effects).forEach((effect) =>
      expect(effect).not.toHaveBeenCalled(),
    );
  });

  it.each([
    { schema: 'public' },
    { schema: 'editorial_test_abc;DROP' },
    { schema: 'editorial_test_ABCDEF0123456789' },
    { password: '' },
    { password: 'bad\u0000password' },
    { url: 'postgresql://ambient' },
  ])('denies malformed binding %j without ambient fallback', async (patch) => {
    const f = fixture();
    await expect(
      constructEditorialPostgresClient(
        { ...request(), ...patch },
        pinned,
        f.dependencies,
      ),
    ).rejects.toThrow('denied');
    expect(f.dependencies.readSource).not.toHaveBeenCalled();
    expect(f.dependencies.loadClient).not.toHaveBeenCalled();
  });

  it('requires a separate valid pin, not merely self-consistent metadata', async () => {
    const f = fixture();
    const binding = request();
    binding.target.database = 'production';
    await expect(
      constructEditorialPostgresClient(binding, binding.target, f.dependencies),
    ).rejects.toThrow('denied');
    await expect(
      constructEditorialPostgresClient(request(), undefined!, f.dependencies),
    ).rejects.toThrow('denied');
    expect(f.dependencies.loadClient).not.toHaveBeenCalled();
  });

  it.each([
    '{}',
    'const config = {"relativeEnvPaths": null};',
    'const config = {"relativeEnvPaths": {"rootEnvPath":".env"}};',
    'const config = {"relativeEnvPaths": {"schemaEnvPath":".env"}};',
    'const config = {"relativeEnvPaths": {"other":null}};',
    'const config = {"relativeEnvPaths": {"rootEnvPath":false}};',
    'const config = {"relativeEnvPaths": {"rootEnvPath":null,"rootEnvPath":null}};',
    'const config = {"relativeEnvPaths": process.env};',
    safeSource.repeat(2),
    'x'.repeat(2_000_001),
  ])(
    'rejects unsafe/unknown generated metadata before loading',
    async (source) => {
      const f = fixture(source);
      await expect(
        constructEditorialPostgresClient(request(), pinned, f.dependencies),
      ).rejects.toThrow('denied');
      expect(f.dependencies.loadClient).not.toHaveBeenCalled();
      expect(f.constructor).not.toHaveBeenCalled();
    },
  );

  it.each([
    safeSource,
    'const config = {"relativeEnvPaths":{"schemaEnvPath":null,"rootEnvPath":null}};',
    'const config = {"relativeEnvPaths":{}};',
  ])(
    'constructs explicitly without SQL and clears both env mechanisms',
    async (source) => {
      const f = fixture(source);
      await constructEditorialPostgresClient(request(), pinned, f.dependencies);
      expect(f.constructor).toHaveBeenCalledTimes(1);
      const options = f.constructor.mock.calls[0][0];
      const url = new URL(options.datasources.db.url);
      expect([url.protocol, url.hostname, url.port, url.pathname]).toEqual([
        'postgresql:',
        '127.0.0.1',
        '54321',
        '/editorial_test_unit',
      ]);
      expect(decodeURIComponent(url.username)).toBe(pinned.user);
      expect(decodeURIComponent(url.password)).toBe(request().password);
      expect(Object.fromEntries(url.searchParams)).toEqual({
        schema: request().schema,
        connection_limit: '1',
        connect_timeout: '5',
        pool_timeout: '5',
        socket_timeout: '10',
      });
      expect(options.transactionOptions).toEqual({
        maxWait: 5000,
        timeout: 10000,
      });
      const other = { preserved: true };
      expect(
        options.__internal.configOverride({
          other,
          relativeEnvPaths: { rootEnvPath: '.env', schemaEnvPath: '.env' },
          injectableEdgeEnv: () => ({ SECRET: 'no' }),
        }),
      ).toEqual({
        other,
        relativeEnvPaths: { rootEnvPath: null, schemaEnvPath: null },
        injectableEdgeEnv: undefined,
      });
      Object.values(f.effects).forEach((effect) =>
        expect(effect).not.toHaveBeenCalled(),
      );
    },
  );

  it('inspects installed metadata without importing the generated client', async () => {
    const f = fixture();
    f.dependencies.readSource.mockImplementation(() =>
      readFile(require.resolve('.prisma/client/index.js'), 'utf8'),
    );
    await constructEditorialPostgresClient(request(), pinned, f.dependencies);
    expect(f.constructor).toHaveBeenCalledTimes(1);
  });

  it('redacts loader/constructor failures and captures binding before await', async () => {
    const f = fixture();
    const binding = request();
    f.dependencies.readSource.mockImplementation(() => {
      binding.password = 'changed';
      binding.target.port = 1;
      return Promise.resolve(safeSource);
    });
    f.constructor.mockImplementation(() => {
      throw new Error(binding.password);
    });
    await expect(
      constructEditorialPostgresClient(binding, pinned, f.dependencies),
    ).rejects.toThrow(/^Editorial PostgreSQL harness denied$/);
    expect(
      new URL(f.constructor.mock.calls[0][0].datasources.db.url).port,
    ).toBe('54321');
    expect(
      decodeURIComponent(
        new URL(f.constructor.mock.calls[0][0].datasources.db.url).password,
      ),
    ).toBe(request().password);
  });
});
