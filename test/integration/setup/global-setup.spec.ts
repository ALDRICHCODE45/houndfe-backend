// Offline: never import reset-db's real client or dotenv's filesystem loader.
jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('node:fs', () => ({ existsSync: jest.fn() }));
jest.mock('node:child_process', () => ({ spawnSync: jest.fn() }));
jest.mock('../reset-db', () => ({
  BASELINE_TENANT_ID: 'baseline',
  BASELINE_TENANT_NAME: 'Baseline',
  BASELINE_TENANT_SLUG: 'baseline',
}));
jest.mock('@prisma/client', () => ({ PrismaClient: jest.fn() }));

import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import globalSetup from './global-setup';

const shellUrl =
  'postgresql://synthetic:synthetic@localhost:5433/nest-practice-test?schema=public';
const normalizedUrl = shellUrl.replace('localhost', '127.0.0.1');
const cli = require.resolve('prisma/build/index.js');
const exists = jest.mocked(fs.existsSync);
const spawn = jest.mocked(spawnSync);
const Client = jest.mocked(PrismaClient);
const upsert = jest.fn();
const disconnect = jest.fn();

describe('integration globalSetup installed CLI confinement (no DB)', () => {
  let originalEnv: NodeJS.ProcessEnv;
  beforeEach(() => {
    originalEnv = process.env;
    process.env = {
      DATABASE_URL: shellUrl,
      HOUNDFE_TEST_DATABASE_URL_FROM_SHELL: '1',
      PATH: '/deliberately/no/package-manager',
    };
    jest.clearAllMocks();
    exists.mockImplementation((file) => file === cli);
    spawn.mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);
    upsert.mockResolvedValue({});
    disconnect.mockResolvedValue(undefined);
    Client.mockImplementation(
      () =>
        ({
          tenant: { upsert },
          $disconnect: disconnect,
        }) as unknown as PrismaClient,
    );
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('executes only installed Prisma with this Node, binding normalized URL to child and seed', async () => {
    await globalSetup();
    expect(spawn.mock.calls).toEqual([
      [
        process.execPath,
        [cli, 'migrate', 'deploy'],
        {
          cwd: process.cwd(),
          stdio: 'inherit',
          env: { ...process.env, DATABASE_URL: normalizedUrl },
        },
      ],
    ]);
    expect(Client).toHaveBeenCalledWith({
      datasources: { db: { url: normalizedUrl } },
    });
    expect(upsert).toHaveBeenCalledWith({
      where: { id: 'baseline' },
      update: { name: 'Baseline', slug: 'baseline', isActive: true },
      create: {
        id: 'baseline',
        name: 'Baseline',
        slug: 'baseline',
        isActive: true,
      },
    });
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(dotenv.config).not.toHaveBeenCalled();
  });

  it('fails before spawn or seed when the installed CLI is unavailable', async () => {
    exists.mockReturnValue(false);
    await expect(globalSetup()).rejects.toThrow(
      'Installed Prisma CLI unavailable',
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(Client).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each([
    { status: 1 },
    { status: null, signal: 'SIGTERM' },
    { status: null, error: new Error('synthetic spawn failure') },
    { status: 0, error: new Error('synthetic spawn failure') },
  ])('does not seed or retry after child failure %j', async (result) => {
    spawn.mockReturnValue(result as ReturnType<typeof spawnSync>);
    await expect(globalSetup()).rejects.toThrow('prisma migrate deploy failed');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(Client).not.toHaveBeenCalled();
  });

  it('keeps .env.test override precedence and explicit seed binding', async () => {
    exists.mockReturnValue(true);
    jest.mocked(dotenv.config).mockImplementation(() => {
      process.env.DATABASE_URL = normalizedUrl;
      return { parsed: { DATABASE_URL: normalizedUrl } };
    });
    process.env.DATABASE_URL = 'invalid shell value';
    delete process.env.HOUNDFE_TEST_DATABASE_URL_FROM_SHELL;
    await globalSetup();
    expect(dotenv.config).toHaveBeenCalledWith({
      path: `${process.cwd()}/.env.test`,
      override: true,
    });
    expect(spawn.mock.calls[0][2]?.env?.DATABASE_URL).toBe(normalizedUrl);
    expect(Client).toHaveBeenCalledWith({
      datasources: { db: { url: normalizedUrl } },
    });
  });

  it('rejects unmarked shell URLs before spawn or seed', async () => {
    delete process.env.HOUNDFE_TEST_DATABASE_URL_FROM_SHELL;
    await expect(globalSetup()).rejects.toThrow('explicitly for a test DB');
    expect(spawn).not.toHaveBeenCalled();
    expect(Client).not.toHaveBeenCalled();
  });

  it('disconnects and propagates a seed failure without retry', async () => {
    upsert.mockRejectedValueOnce(new Error('synthetic seed failure'));
    await expect(globalSetup()).rejects.toThrow('synthetic seed failure');
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
