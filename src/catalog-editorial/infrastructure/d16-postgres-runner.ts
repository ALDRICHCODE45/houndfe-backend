import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { GetPrismaClientConfig } from '@prisma/client/runtime/library';

const id = 'f764e05bf359e64cb912d5c3d56c11c4803ea5b6f8bd611091cbe2f35a68fb7b';
const database = 'catalog_d16_isolated';
export interface D16Database {
  first: PrismaClient;
  second: PrismaClient;
  close(): Promise<void>;
}
function docker(...args: string[]): string {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  } catch {
    throw new Error('D16 container inspection/readiness unavailable');
  }
}
/** Each invocation creates one synthetic schema, shared by two independent clients. */
export async function d16Postgres(): Promise<D16Database> {
  if (process.env.CATALOG_EDITORIAL_D16_TEST_CONTAINER !== id)
    throw new Error('Exact D16 container selection required');
  const signature = docker(
    'inspect',
    '--format',
    [
      '{{.Id}}',
      '{{.Name}}',
      '{{.Config.Image}}',
      '{{.State.Running}}',
      '{{.HostConfig.Privileged}}',
      '{{.HostConfig.NetworkMode}}',
      '{{json .HostConfig.PortBindings}}',
      '{{len .Config.Labels}}',
      '{{json .Mounts}}',
      '{{json .HostConfig.Tmpfs}}',
      '{{json .HostConfig.Binds}}',
      '{{json (index .HostConfig "Mounts")}}',
    ].join('|'),
    id,
  );
  if (
    signature !==
      `${id}|/catalog-d16-01a1764b-1793012714|postgres:16-alpine|true|false|bridge|{}|0|[]|{"/var/lib/postgresql/data":"rw"}|null|null` ||
    docker('exec', id, 'printenv', 'POSTGRES_DB') !== database
  )
    throw new Error('D16 container/database guard rejected target');
  if (
    !/\btmpfs\b/.test(
      docker('exec', id, 'df', '-T', '/var/lib/postgresql/data'),
    )
  )
    throw new Error('D16 data filesystem must be tmpfs');
  docker('exec', id, 'pg_isready', '-U', 'postgres', '-d', database);
  const ip = docker(
    'inspect',
    '--format',
    '{{.NetworkSettings.Networks.bridge.IPAddress}}',
    id,
  );
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip))
    throw new Error('No D16 bridge address');
  const password = docker('exec', id, 'printenv', 'POSTGRES_PASSWORD');
  if (!password) throw new Error('Missing ephemeral test credential');
  const schema = `ce_d16_${randomUUID().replaceAll('-', '')}`;
  let url: URL;
  try {
    url = new URL(`postgresql://postgres@${ip}/${database}`);
  } catch {
    throw new Error('Invalid D16 bridge address');
  }
  url.password = password;
  url.searchParams.set('schema', schema);
  url.searchParams.set('connection_limit', '1');
  const options = {
    datasources: { db: { url: url.toString() } },
    // Disable generated-client dotenv paths; never load an ambient database URL.
    __internal: {
      configOverride: (config: GetPrismaClientConfig) => ({
        ...config,
        relativeEnvPaths: undefined,
        injectableEdgeEnv: undefined,
      }),
    },
  };
  const first = new PrismaClient(
    options as ConstructorParameters<typeof PrismaClient>[0],
  );
  const second = new PrismaClient(
    options as ConstructorParameters<typeof PrismaClient>[0],
  );
  const close = async () => {
    await Promise.all([first.$disconnect(), second.$disconnect()]);
  };
  try {
    await first.$connect();
    const connected = await first.$queryRaw<
      { database: string }[]
    >`SELECT current_database() AS database`;
    if (connected[0]?.database !== database)
      throw new Error('Database identity mismatch');
    const migrations = [
      '20261026020000_catalog_editorial_core',
      '20261026030000_catalog_editorial_create',
      '20261026040000_catalog_editorial_save',
      '20261026050000_catalog_editorial_definitions',
      '20261026060000_catalog_editorial_options',
    ]
      .map((migration) =>
        readFileSync(
          join(
            __dirname,
            '../../../prisma/migrations',
            migration,
            'migration.sql',
          ),
          'utf8',
        ),
      )
      .join('\n');
    execFileSync(
      'docker',
      [
        'exec',
        '-i',
        id,
        'psql',
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'postgres',
        '-d',
        database,
      ],
      {
        stdio: 'pipe',
        input: `CREATE SCHEMA "${schema}";
        SET search_path TO "${schema}";
        CREATE TABLE products (id TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL,
          name TEXT NOT NULL, description TEXT);
        ${migrations}`,
      },
    );
    await second.$connect();
    for (const client of [first, second]) {
      const identity = await client.$queryRaw<
        { database: string; schema: string }[]
      >`
        SELECT current_database() AS database, current_schema() AS schema`;
      if (identity[0]?.database !== database || identity[0]?.schema !== schema)
        throw new Error('Database/schema identity mismatch');
    }
    return { first, second, close };
  } catch {
    await Promise.allSettled([first.$disconnect(), second.$disconnect()]);
    throw new Error('D16 PostgreSQL setup failed; no ambient fallback');
  }
}
