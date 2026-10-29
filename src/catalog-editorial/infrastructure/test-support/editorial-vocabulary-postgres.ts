import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export type DockerExecutor = (
  args: string[],
  input?: string,
  timeout?: number,
) => string;

// No shell, database URL, host mounts, or inherited database environment.
export const executeEditorialDocker: DockerExecutor = (
  args,
  input,
  timeout = 10000,
) => {
  const result = spawnSync('docker', args, {
    input,
    timeout,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: { PATH: process.env.PATH },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`docker ${args[0]} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
};

export interface EditorialPostgres {
  name: string;
  id: string;
  sql: (statement: string) => string;
}

export async function withEditorialPostgres<T>(
  use: (database: EditorialPostgres) => Promise<T>,
  execute: DockerExecutor = executeEditorialDocker,
): Promise<T> {
  const name = `houndfe-editorial-proof-${randomUUID()}`;
  let id: string | undefined;
  let failed = false;
  let original: unknown;
  let value: T | undefined;
  const command = (args: string[], input?: string, timeout = 10000) =>
    execute(args, input, timeout);
  try {
    try {
      id = command(
        [
          'create',
          '--name',
          name,
          '--label',
          `houndfe.editorial-proof=${name}`,
          '--network',
          'none',
          '--tmpfs',
          '/var/lib/postgresql/data',
          '-e',
          'POSTGRES_HOST_AUTH_METHOD=trust',
          'postgres:16',
        ],
        undefined,
        120000,
      ).trim();
    } catch (error) {
      // A timed-out create may have succeeded on the daemon. Reclaim only
      // the exact unique name with our per-invocation ownership label.
      try {
        const containers = JSON.parse(command(['inspect', name])) as {
          Id: string;
          Config: { Labels: Record<string, string> };
        }[];
        if (containers[0]?.Config.Labels['houndfe.editorial-proof'] === name) {
          id = containers[0].Id;
        }
      } catch {
        // Not created or ownership cannot be established: never remove by name.
      }
      throw error;
    }
    if (!id) throw new Error('Docker create returned no container identity');
    command(['start', id]);
    for (let attempt = 0; ; attempt++) {
      try {
        // The image's transient initialization server accepts sockets only.
        command(
          ['exec', id, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'],
          undefined,
          1000,
        );
        break;
      } catch (error) {
        if (attempt === 29) throw error;
        await delay(100);
      }
    }
    value = await use({
      name,
      id,
      sql: (statement) =>
        command(
          [
            'exec',
            '-i',
            id!,
            'psql',
            '-X',
            '-A',
            '-t',
            '-v',
            'ON_ERROR_STOP=1',
            '-U',
            'postgres',
            '-d',
            'postgres',
          ],
          statement,
        ),
    });
  } catch (error) {
    failed = true;
    original = error;
  }
  if (id) {
    try {
      command(['rm', '-f', id]);
      const remaining = command([
        'ps',
        '-aq',
        '--no-trunc',
        '--filter',
        `id=${id}`,
      ]);
      if (remaining.trim()) throw new Error(`Owned container remains: ${id}`);
    } catch (cleanupError) {
      if (!failed) throw cleanupError;
      // Keep the primary failure, even for frozen errors or primitive throws.
      try {
        if (original instanceof Error) {
          Object.defineProperty(original, 'cleanupError', {
            value: cleanupError,
          });
        }
      } catch {
        // A non-extensible primary error still takes precedence.
      }
    }
  }
  if (failed) throw original;
  return value as T;
}
