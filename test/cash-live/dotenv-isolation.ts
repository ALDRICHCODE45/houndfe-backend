/**
 * cash-live harness — dotenv isolation for the disposable run (S5).
 *
 * Diagnosis: Prisma 6's GENERATED client (`.prisma/client/index.js`, reached
 * through `src/shared/prisma/prisma.service` -> `@prisma/client`) calls
 * `warnEnvConflicts(...)` at MODULE LOAD. That runtime helper runs dotenv on
 * the schema-relative env file (the repository `.env`), so merely importing
 * the Nest/Prisma graph copied repository variables — RESEND_API_KEY
 * included — into `process.env`. `new PrismaClient()` repeats the load in its
 * constructor from `config.relativeEnvPaths`.
 *
 * Fix (test-support only, no production change): before the FIRST load of
 * the generated client, a narrow CommonJS loader hook intercepts ONLY the
 * `@prisma/client/runtime/library.js` requires issued BY the generated
 * client's `index.js`, and hands it the real runtime with two changes:
 *   - `warnEnvConflicts` is a no-op (no import-time dotenv load);
 *   - `getPrismaClient(config)` receives a copy of the generated config with
 *     `relativeEnvPaths` / `injectableEdgeEnv` removed — the same effect as
 *     the repo's `__internal.configOverride` pattern
 *     (src/catalog-editorial/infrastructure/isolated-postgres-runner.ts), but
 *     applied to EVERY PrismaClient the harness graph constructs (the real
 *     PrismaService is constructed by Nest without options).
 * Every other module and every other require is untouched.
 *
 * Fail closed:
 *   - if the generated client is already in `require.cache` before the hook
 *     is installed, the block cannot be guaranteed -> throw;
 *   - after importing the graph, BOTH interceptions must have happened (a
 *     Prisma upgrade that changes the generated shape fails closed instead
 *     of silently loading `.env` again).
 *
 * This module has NO heavy static import: server.ts runs every environment
 * guard first, then calls `loadHarnessGraph()`, which installs the block and
 * only THEN dynamically imports the Nest + Prisma graph.
 */
import Module = require('node:module');
import path = require('node:path');

export const PRISMA_ALREADY_LOADED_MESSAGE =
  'cash-live: generated Prisma client was loaded before the dotenv block';
export const PRISMA_BLOCK_NOT_APPLIED_MESSAGE =
  'cash-live: Prisma dotenv block was not applied to the generated client';

const RUNTIME_REQUEST = '@prisma/client/runtime/library.js';

interface BlockState {
  warnEnvConflictsBlocked: boolean;
  getPrismaClientWrapped: boolean;
}

type LoadFn = (request: string, parent: unknown, isMain: boolean) => unknown;
interface ModuleInternals {
  _load: LoadFn;
}

let state: BlockState | undefined;

function isGeneratedClientIndex(filename: string | undefined): boolean {
  if (!filename) return false;
  const normalized = filename.split(path.sep).join('/');
  return normalized.endsWith('/.prisma/client/index.js');
}

function generatedClientAlreadyLoaded(): boolean {
  return Object.keys(require.cache).some(isGeneratedClientIndex);
}

/**
 * Install the narrow Prisma dotenv block. Idempotent. Must run before the
 * generated Prisma client is loaded for the first time.
 */
export function installPrismaDotenvBlock(): BlockState {
  if (state) return state;
  if (generatedClientAlreadyLoaded()) {
    throw new Error(PRISMA_ALREADY_LOADED_MESSAGE);
  }
  const current: BlockState = {
    warnEnvConflictsBlocked: false,
    getPrismaClientWrapped: false,
  };
  const internals = Module as unknown as ModuleInternals;
  const originalLoad = internals._load;
  internals._load = function cashLiveLoad(
    this: unknown,
    request: string,
    parent: unknown,
    isMain: boolean,
  ): unknown {
    const loaded = originalLoad.call(this, request, parent, isMain);
    const parentFile = (parent as { filename?: string } | null)?.filename;
    if (request !== RUNTIME_REQUEST || !isGeneratedClientIndex(parentFile)) {
      return loaded;
    }
    const runtime = loaded as Record<string, unknown>;
    const realGetPrismaClient = runtime.getPrismaClient as
      | ((config: Record<string, unknown>) => unknown)
      | undefined;
    if (typeof realGetPrismaClient !== 'function') {
      // Unknown runtime shape — leave it; the post-import check fails closed.
      return loaded;
    }
    current.warnEnvConflictsBlocked = true;
    current.getPrismaClientWrapped = true;
    return {
      ...runtime,
      warnEnvConflicts: () => undefined,
      getPrismaClient: (config: Record<string, unknown>) =>
        realGetPrismaClient({
          ...config,
          relativeEnvPaths: undefined,
          injectableEdgeEnv: undefined,
        }),
    };
  };
  state = current;
  return current;
}

/**
 * Install the block, then import the heavy harness graph (Nest + Prisma).
 * Throws a FIXED message when the block cannot be guaranteed.
 */
export async function loadHarnessGraph() {
  const block = installPrismaDotenvBlock();
  const liveHarness = await import('./live-harness');
  const seed = await import('./seed');
  const resumeStartup = await import('./resume-startup');
  const fixture = await import('./fixture');
  const { Logger } = await import('@nestjs/common');
  if (!block.warnEnvConflictsBlocked || !block.getPrismaClientWrapped) {
    throw new Error(PRISMA_BLOCK_NOT_APPLIED_MESSAGE);
  }
  return { liveHarness, seed, resumeStartup, fixture, Logger };
}
