import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { PrismaClient } from '@prisma/client';
import type { GetPrismaClientConfig } from '@prisma/client/runtime/library';
const id = '07307784d255d8cc37b8e0a3d02c727d131478b55a6f089da313075e45f2e0e1';
const image =
  'sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb';
const database = 'private_media_isolated';
function admit(): string {
  try {
    // Projection deliberately excludes Config.Env and every unrelated field.
    const fields = [
      '.Id',
      '.Name',
      '.Image',
      '.State.Running',
      '.HostConfig.Tmpfs',
      '.HostConfig.Binds',
      '.Mounts',
      '.HostConfig.PortBindings',
      '.NetworkSettings.Ports',
      '.NetworkSettings.Networks.bridge.IPAddress',
      '.HostConfig.Privileged',
      '.HostConfig.NetworkMode',
      '(index .HostConfig "Mounts")',
    ];
    const raw = execFileSync(
      'docker',
      [
        'inspect',
        '--format',
        `[${fields.map((f) => `{{json ${f}}}`).join(',')}]`,
        id,
      ],
      { encoding: 'utf8', stdio: 'pipe', timeout: 5000 },
    );
    const values = JSON.parse(raw) as unknown[];
    const expected = [
      id,
      '/private-media-offline-01a1764b-20261026',
      image,
      true,
      { '/var/lib/postgresql/data': 'rw,nosuid,noexec,size=268435456' },
      null,
      [],
      {},
      { '5432/tcp': null },
      values[9],
      false,
      'bridge',
      null,
    ];
    if (
      JSON.stringify(values) !== JSON.stringify(expected) ||
      typeof values[9] !== 'string' ||
      isIP(values[9]) !== 4
    ) {
      throw new Error('drift');
    }
    return values[9];
  } catch {
    throw new Error('Private media target admission denied');
  }
}
export interface PrivateMediaTestDatabase {
  first: PrismaClient;
  second: PrismaClient;
  schema: string;
}
/** Test-only: invoke exclusively from the documented sterile child process. */
export async function withPrivateMediaTestDatabase<T>(
  callback: (db: PrivateMediaTestDatabase) => Promise<T>,
): Promise<T> {
  const address = admit(); // No client may exist before fresh admission.
  const schema = `pm_test_${randomUUID().replaceAll('-', '')}`;
  if (!/^pm_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Invalid schema');
  let url: URL;
  try {
    url = new URL(`postgresql://${address}:5432/${database}`);
  } catch {
    throw new Error('Invalid admitted target address');
  }
  url.username = 'private_media_test';
  url.password = 'private_media_synthetic_only';
  url.searchParams.set('schema', schema);
  url.searchParams.set('connection_limit', '1');
  url.searchParams.set('connect_timeout', '3');
  url.searchParams.set('pool_timeout', '3');
  const options = {
    datasources: { db: { url: url.toString() } },
    __internal: {
      configOverride: (config: GetPrismaClientConfig) => ({
        ...config,
        relativeEnvPaths: undefined,
        injectableEdgeEnv: undefined,
      }),
    },
  };
  const clients: PrismaClient[] = [];
  let owned = false;
  try {
    for (let i = 0; i < 2; i++) {
      clients.push(
        new PrismaClient(
          options as ConstructorParameters<typeof PrismaClient>[0],
        ),
      );
    }
    const [first, second] = clients;
    await first.$connect();
    const identity = await first.$queryRawUnsafe<{ database: string }[]>(
      'SELECT current_database() AS database',
    );
    if (identity[0]?.database !== database) {
      throw new Error('Database identity mismatch');
    }
    // PostgreSQL identifiers cannot be bound; schema is strictly allowlisted above.
    const create = ['CREATE SCHEMA "', schema, '"'].join('');
    await first.$executeRawUnsafe(create);
    owned = true;
    await second.$connect();
    return await callback({ first, second, schema });
  } finally {
    try {
      if (owned) {
        const drop = ['DROP SCHEMA "', schema, '" CASCADE'].join('');
        await clients[0].$executeRawUnsafe(drop);
      }
    } finally {
      await Promise.all(clients.map((c) => c.$disconnect()));
    }
  }
}
