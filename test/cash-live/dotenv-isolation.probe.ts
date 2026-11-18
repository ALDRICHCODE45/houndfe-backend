/**
 * cash-live harness — child-process probe for the dotenv-isolation spec.
 *
 * NOT a test and NOT a server: it only IMPORTS the harness module graph
 * (no Nest compile, no Prisma connect, no DB, no listen) under whatever
 * minimal environment the spec spawned it with, then prints ONE JSON line
 * of booleans/counts/`typeof` results. It never prints an env value, a
 * file content or a path.
 *
 * Modes (argv[2]):
 *   - `harness`  — the real startup path (`loadHarnessGraph`). `.env*`
 *                  access is RECORDED but passed through, so a dotenv file
 *                  present in the repository would really be loaded if
 *                  anything tried.
 *   - `control`  — imports `./live-harness` directly (the pre-fix shape)
 *                  to prove the probe detects Prisma's import-time dotenv
 *                  attempt. `.env*` access is recorded and DENIED, so no
 *                  file content is ever read in this mode.
 *   - `preloaded`— loads the generated Prisma client first (with `.env*`
 *                  denied), then calls `loadHarnessGraph`, which must fail
 *                  closed because the block can no longer be guaranteed.
 *
 * Run only through `dotenv-isolation.spec.ts`.
 */
import fs = require('node:fs');
import path = require('node:path');

const mode = process.argv[2];
const denyEnvFiles = mode === 'control' || mode === 'preloaded';
let envFileTouched = false;

function isEnvFile(target: unknown): boolean {
  if (typeof target !== 'string' && !(target instanceof URL)) return false;
  return path.basename(String(target)).startsWith('.env');
}

const originalExistsSync = fs.existsSync;
const originalReadFileSync = fs.readFileSync;
const originalOpenSync = fs.openSync;

function denied(): never {
  const error = new Error('probe: .env access denied') as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  throw error;
}

(fs as { existsSync: typeof fs.existsSync }).existsSync = ((target) => {
  if (isEnvFile(target)) {
    envFileTouched = true;
    if (denyEnvFiles) return false;
  }
  return originalExistsSync(target);
}) as typeof fs.existsSync;

(fs as { readFileSync: unknown }).readFileSync = function readFileSync(
  this: unknown,
  target: unknown,
  ...rest: unknown[]
) {
  if (isEnvFile(target)) {
    envFileTouched = true;
    if (denyEnvFiles) denied();
  }
  return (originalReadFileSync as (...a: unknown[]) => unknown).call(
    this,
    target,
    ...rest,
  );
};

(fs as { openSync: unknown }).openSync = function openSync(
  this: unknown,
  target: unknown,
  ...rest: unknown[]
) {
  if (isEnvFile(target)) {
    envFileTouched = true;
    if (denyEnvFiles) denied();
  }
  return (originalOpenSync as (...a: unknown[]) => unknown).call(
    this,
    target,
    ...rest,
  );
};

async function run(): Promise<Record<string, unknown>> {
  const keysBefore = new Set(Object.keys(process.env));
  let refusedAsAlreadyLoaded: boolean | undefined;
  if (mode === 'harness') {
    const { loadHarnessGraph } = await import('./dotenv-isolation');
    await loadHarnessGraph();
  } else if (mode === 'control') {
    await import('./live-harness');
  } else if (mode === 'preloaded') {
    await import('@prisma/client');
    const { loadHarnessGraph, PRISMA_ALREADY_LOADED_MESSAGE } = await import(
      './dotenv-isolation'
    );
    refusedAsAlreadyLoaded = false;
    try {
      await loadHarnessGraph();
    } catch (error) {
      // Compare against the FIXED message only — never print the error.
      refusedAsAlreadyLoaded =
        error instanceof Error &&
        error.message === PRISMA_ALREADY_LOADED_MESSAGE;
    }
  } else {
    throw new Error('probe: unknown mode');
  }
  const keysAdded = Object.keys(process.env).filter(
    (key) => !keysBefore.has(key),
  ).length;
  return {
    mode,
    envFileTouched,
    keysAdded,
    resendApiKey: typeof process.env.RESEND_API_KEY,
    refusedAsAlreadyLoaded,
  };
}

run().then(
  (result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  },
  () => {
    process.stdout.write(`${JSON.stringify({ mode, probeFailed: true })}\n`);
    process.exitCode = 1;
  },
);
