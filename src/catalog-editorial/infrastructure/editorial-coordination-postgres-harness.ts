import { readFile, stat } from 'node:fs/promises';
import type { Prisma, PrismaClient } from '@prisma/client';

export interface PinnedPostgresTarget {
  containerId: string;
  imageId: string;
  name: string;
  owner: string;
  host: '127.0.0.1';
  port: number;
  database: string;
  user: string;
}
export interface PostgresBinding {
  target: PinnedPostgresTarget;
  schema: string;
  password: string;
}
export interface HarnessClientOptions {
  datasources: { db: { url: string } };
  transactionOptions: { maxWait: number; timeout: number };
  __internal: {
    configOverride: (
      config: Record<string, unknown>,
    ) => Record<string, unknown>;
  };
}
export interface HarnessDependencies<T> {
  readSource: () => Promise<string>;
  loadClient: () => Promise<new (options: HarnessClientOptions) => T>;
}
const denied = () => new Error('Editorial PostgreSQL harness denied');
const targetKeys = [
  'containerId',
  'imageId',
  'name',
  'owner',
  'host',
  'port',
  'database',
  'user',
] as const;
function closed(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function validTarget(value: unknown): value is PinnedPostgresTarget {
  if (!closed(value, targetKeys)) return false;
  return (
    typeof value.containerId === 'string' &&
    /^[a-f0-9]{64}$/.test(value.containerId) &&
    typeof value.imageId === 'string' &&
    /^sha256:[a-f0-9]{64}$/.test(value.imageId) &&
    typeof value.name === 'string' &&
    /^editorial-coordination-[a-z0-9-]{1,60}$/.test(value.name) &&
    typeof value.owner === 'string' &&
    /^[a-zA-Z0-9_-]{1,80}$/.test(value.owner) &&
    value.host === '127.0.0.1' &&
    Number.isInteger(value.port) &&
    Number(value.port) > 0 &&
    Number(value.port) <= 65535 &&
    ['database', 'user'].every(
      (key) =>
        typeof value[key] === 'string' &&
        /^editorial_test_[a-z0-9_]{1,32}$/.test(value[key]),
    )
  );
}

// Static inspection only: deliberately accepts the audited JSON-shaped metadata,
// not arbitrary generated JavaScript. Unknown formats require a new source audit.
function inspectEnvPaths(source: string): void {
  if (source.length > 2_000_000 || !source.includes('const config = {'))
    throw denied();
  const declarations = [...source.matchAll(/"relativeEnvPaths"\s*:/g)];
  const match = /"relativeEnvPaths"\s*:\s*(\{[^{}]{0,256}\})/.exec(source);
  if (declarations.length !== 1 || !match) throw denied();
  let paths: unknown;
  try {
    paths = JSON.parse(match[1]);
  } catch {
    throw denied();
  }
  if (!paths || typeof paths !== 'object' || Array.isArray(paths))
    throw denied();
  const keys = Object.keys(paths);
  const fieldCount = [...match[1].matchAll(/"[^"\\]*"\s*:/g)].length;
  if (
    keys.length !== fieldCount ||
    !Object.entries(paths).every(
      ([key, value]) =>
        ['rootEnvPath', 'schemaEnvPath'].includes(key) && value === null,
    )
  )
    throw denied();
}

const installedDependencies: HarnessDependencies<PrismaClient> = {
  readSource: async () => {
    const path = require.resolve('.prisma/client/index.js');
    if ((await stat(path)).size > 2_000_000) throw denied();
    return readFile(path, 'utf8');
  },
  loadClient: async () => {
    const { PrismaClient } = await import('@prisma/client');
    return class extends PrismaClient {
      constructor(options: HarnessClientOptions) {
        // Structural assignment retains the audited runtime-only __internal option;
        // Prisma's public generic constructor otherwise rejects its hidden key.
        const publicShape: Prisma.PrismaClientOptions = options;
        super(publicShape);
      }
    };
  },
};

export function constructEditorialPostgresClient(
  binding: PostgresBinding,
  pinned: PinnedPostgresTarget,
): Promise<PrismaClient>;
export function constructEditorialPostgresClient<T>(
  binding: PostgresBinding,
  pinned: PinnedPostgresTarget,
  dependencies: HarnessDependencies<T>,
): Promise<T>;
export async function constructEditorialPostgresClient(
  binding: PostgresBinding,
  pinned: PinnedPostgresTarget,
  dependencies: HarnessDependencies<unknown> = installedDependencies,
): Promise<unknown> {
  try {
    if (
      !closed(binding, ['target', 'schema', 'password']) ||
      !validTarget(binding.target) ||
      !validTarget(pinned) ||
      !targetKeys.every((key) => binding.target[key] === pinned[key]) ||
      typeof binding.schema !== 'string' ||
      !/^editorial_test_[a-f0-9]{16}$/.test(binding.schema) ||
      typeof binding.password !== 'string' ||
      binding.password.length < 1 ||
      binding.password.length > 256 ||
      [...binding.password].some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      )
    )
      throw denied();
    const target = binding.target;
    const url = new URL(
      `postgresql://127.0.0.1:${target.port}/${target.database}`,
    );
    url.username = encodeURIComponent(target.user);
    url.password = encodeURIComponent(binding.password);
    url.search = new URLSearchParams({
      schema: binding.schema,
      connection_limit: '1',
      connect_timeout: '5',
      pool_timeout: '5',
      socket_timeout: '10',
    }).toString();
    // URL is captured before any injectable asynchronous dependency can mutate inputs.
    const options: HarnessClientOptions = {
      datasources: { db: { url: url.href } },
      transactionOptions: { maxWait: 5000, timeout: 10000 },
      __internal: {
        configOverride: (config) => ({
          ...config,
          relativeEnvPaths: { rootEnvPath: null, schemaEnvPath: null },
          injectableEdgeEnv: undefined,
        }),
      },
    };
    inspectEnvPaths(await dependencies.readSource());
    const Client = await dependencies.loadClient();
    return new Client(options);
  } catch {
    // Never forward dependency errors: they can contain URLs/passwords.
    throw denied();
  }
}
