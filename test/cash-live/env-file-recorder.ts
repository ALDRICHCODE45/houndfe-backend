/**
 * Probe-only `.env*` access recorder shared by the dotenv-isolation probes
 * of the disposable harnesses (cash-live, editorial-live).
 *
 * Patches `fs.existsSync`, `fs.readFileSync` and `fs.openSync` so any access
 * to a path whose basename starts with `.env` is RECORDED. With
 * `deny: true` the access is also refused (ENOENT / `false`), so no dotenv
 * content is ever read in that mode. Never prints a path or a value.
 *
 * Must be installed BEFORE the Nest/Prisma graph is imported (call it at the
 * top of a probe; this module only imports `node:` builtins).
 */
// `import x = require()` keeps the REAL module object (a namespace import
// would be a transpiled copy), which is what the probe must patch.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import fs = require('node:fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import path = require('node:path');

export interface EnvFileRecorder {
  touched(): boolean;
}

function isEnvFile(target: unknown): boolean {
  if (typeof target !== 'string' && !(target instanceof URL)) return false;
  return path.basename(String(target)).startsWith('.env');
}

function denied(): never {
  const error = new Error('probe: .env access denied') as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  throw error;
}

export function installEnvFileRecorder(options: {
  deny: boolean;
}): EnvFileRecorder {
  let envFileTouched = false;
  const originalExistsSync = fs.existsSync;
  const originalReadFileSync = fs.readFileSync;
  const originalOpenSync = fs.openSync;

  (fs as { existsSync: typeof fs.existsSync }).existsSync = ((target) => {
    if (isEnvFile(target)) {
      envFileTouched = true;
      if (options.deny) return false;
    }
    return originalExistsSync(target);
  }) as typeof fs.existsSync;

  (fs as { readFileSync: unknown }).readFileSync = function readFileSync(
    this: unknown,
    target: unknown,
    ...rest: unknown[]
  ): unknown {
    if (isEnvFile(target)) {
      envFileTouched = true;
      if (options.deny) denied();
    }
    const result: unknown = (
      originalReadFileSync as (...a: unknown[]) => unknown
    ).call(this, target, ...rest);
    return result;
  };

  (fs as { openSync: unknown }).openSync = function openSync(
    this: unknown,
    target: unknown,
    ...rest: unknown[]
  ): unknown {
    if (isEnvFile(target)) {
      envFileTouched = true;
      if (options.deny) denied();
    }
    const result: unknown = (
      originalOpenSync as (...a: unknown[]) => unknown
    ).call(this, target, ...rest);
    return result;
  };

  return { touched: () => envFileTouched };
}
