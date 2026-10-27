import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { PrismaClient } from '@prisma/client';
import type { GetPrismaClientConfig } from '@prisma/client/runtime/library';

const id = 'c5a4f914265edb542ab7506905952314dff5228d5ebd7e8efa377f49e3ae38c8';
const image =
  'sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb';
const database = 'editorial_refs_isolated';
function admit(): string {
  try {
    // Never inspect Config.Env, host credentials, or any other target.
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
      '.HostConfig.PublishAllPorts',
      '.Config.Labels',
    ];
    const raw = execFileSync(
      'docker',
      [
        '--host',
        'unix:///var/run/docker.sock',
        'inspect',
        '--format',
        `[${fields.map((f) => `{{json ${f}}}`).join(',')}]`,
        id,
      ],
      {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 5000,
        env: { PATH: '/usr/bin:/bin' },
      },
    );
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values)) throw new Error('Malformed projection');
    const expected = [
      id,
      '/editorial-refs-01a1764b-20261027',
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
      false,
      {
        'houndfe.owner': '01a1764b',
        'houndfe.test': 'editorial-reference-consistency',
      },
    ];
    // Compare objects independent of Docker's JSON key ordering; reject extra keys.
    const canonical = (value: unknown): string =>
      JSON.stringify(value, (_key, v: unknown) =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(
              Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
            )
          : v,
      );
    if (
      canonical(values) !== canonical(expected) ||
      typeof values[9] !== 'string' ||
      isIP(values[9]) !== 4
    )
      throw new Error('Drift');
    return values[9];
  } catch {
    throw new Error('Editorial reference target admission denied');
  }
}
/** Test-only. No lifecycle authority, app bootstrap, migrations, or ambient URL. */
export async function withEditorialReferenceDatabase<T>(
  callback: (db: {
    first: PrismaClient;
    second: PrismaClient;
    schema: string;
  }) => Promise<T>,
): Promise<T> {
  const address = admit(); // Fresh admission precedes every client construction.
  const schema = `er_test_${randomUUID().replaceAll('-', '')}`;
  if (!/^er_test_[a-f0-9]{32}$/.test(schema))
    throw new Error('Invalid owned schema');
  let url: URL;
  try {
    url = new URL(`postgresql://${address}:5432/${database}`);
  } catch {
    throw new Error('Invalid admitted address');
  }
  url.username = 'editorial_refs_test';
  url.password = 'editorial_refs_synthetic_only';
  url.searchParams.set('schema', schema);
  url.searchParams.set('connection_limit', '1');
  url.searchParams.set('connect_timeout', '3');
  url.searchParams.set('pool_timeout', '3');
  url.searchParams.set(
    'options',
    '-c statement_timeout=3000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=3000',
  );
  const options = {
    datasources: { db: { url: url.toString() } },
    // Accepted runner pattern: disable generated-client dotenv discovery explicitly.
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
    for (let i = 0; i < 2; i++)
      clients.push(
        new PrismaClient(
          options as ConstructorParameters<typeof PrismaClient>[0],
        ),
      );
    const [first, second] = clients;
    await first.$connect();
    const identity = await first.$queryRawUnsafe<{ database: string }[]>(
      'SELECT current_database() AS database',
    );
    if (identity[0]?.database !== database)
      throw new Error('Database identity mismatch');
    // Identifiers cannot be bound. Only the locally generated allowlisted name is used.
    await first.$executeRawUnsafe(['CREATE SCHEMA "', schema, '"'].join(''));
    owned = true;
    await second.$connect();
    return await callback({ first, second, schema });
  } finally {
    try {
      if (owned)
        await clients[0].$executeRawUnsafe(
          ['DROP SCHEMA "', schema, '" CASCADE'].join(''),
        );
    } finally {
      await Promise.allSettled(clients.map((c) => c.$disconnect())).then(
        (results) => {
          const failed = results.find((r) => r.status === 'rejected');
          if (failed?.status === 'rejected') throw failed.reason;
        },
      );
    }
  }
}
