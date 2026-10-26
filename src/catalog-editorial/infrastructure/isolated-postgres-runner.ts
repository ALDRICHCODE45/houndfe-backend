import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { GetPrismaClientConfig } from '@prisma/client/runtime/library';

const id = '256a679dca7808e9ceb3f4e3e6489a56a384b5faa0f836d178040ad302b9d372';
const database = 'catalog_editorial_isolated';
function docker(...args: string[]): string {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  } catch {
    throw new Error('Isolated container inspection/readiness unavailable');
  }
}
export async function isolatedPostgres(): Promise<PrismaClient> {
  if (process.env.CATALOG_EDITORIAL_TEST_CONTAINER !== id)
    throw new Error('Exact isolated container selection required');
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
      '{{len .Mounts}}',
      '{{range .Mounts}}{{.Type}}:{{.Destination}}{{end}}',
    ].join('|'),
    id,
  );
  if (
    signature !==
      `${id}|/catalog-draft-core-01a175b8-test|postgres:16-alpine|true|false|bridge|{}|0|1|tmpfs:/var/lib/postgresql/data` ||
    docker('exec', id, 'printenv', 'POSTGRES_DB') !== database
  )
    throw new Error('Isolated container/database guard rejected target');
  docker('exec', id, 'pg_isready', '-U', 'postgres', '-d', database);
  const ip = docker(
    'inspect',
    '--format',
    '{{.NetworkSettings.Networks.bridge.IPAddress}}',
    id,
  );
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip))
    throw new Error('No isolated bridge address');
  const password = docker('exec', id, 'printenv', 'POSTGRES_PASSWORD');
  if (!password) throw new Error('Missing ephemeral test credential');
  const schema = `ce_read_${randomUUID().replaceAll('-', '')}`;
  let url: URL;
  try {
    url = new URL(`postgresql://postgres@${ip}/${database}`);
  } catch {
    throw new Error('Invalid isolated bridge address');
  }
  url.password = password;
  url.searchParams.set('schema', schema);
  const options = {
    datasources: { db: { url: url.toString() } },
    // Prisma 6 otherwise loads generated-client dotenv paths at construction.
    __internal: {
      configOverride: (config: GetPrismaClientConfig) => ({
        ...config,
        relativeEnvPaths: undefined,
        injectableEdgeEnv: undefined,
      }),
    },
  };
  const prisma = new PrismaClient(
    options as ConstructorParameters<typeof PrismaClient>[0],
  );
  try {
    await prisma.$connect();
    const connected = await prisma.$queryRaw<{ database: string }[]>`
      SELECT current_database() AS database`;
    if (connected[0]?.database !== database)
      throw new Error('Database identity mismatch');
    const migration = readFileSync(
      join(
        __dirname,
        '../../../prisma/migrations/20261026020000_catalog_editorial_core/migration.sql',
      ),
      'utf8',
    );
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
          ${migration}`,
      },
    );
    const identity = await prisma.$queryRaw<
      { database: string; schema: string }[]
    >`
      SELECT current_database() AS database, current_schema() AS schema`;
    if (identity[0]?.database !== database || identity[0]?.schema !== schema)
      throw new Error('Database identity mismatch');
    return prisma;
  } catch {
    await prisma.$disconnect();
    throw new Error('Isolated PostgreSQL setup failed; no ambient fallback');
  }
}
