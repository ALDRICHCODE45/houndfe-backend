/**
 * cash-live harness — dotenv isolation (offline, S5).
 *
 * Proves that the disposable run never loads the repository dotenv file
 * into the process: the guards run before any heavy import, and importing
 * the harness module graph (Nest + Prisma) under a MINIMAL environment
 * neither touches a `.env*` file nor defines RESEND_API_KEY.
 *
 * The module-graph checks run in a child `node` process (ts-node,
 * transpile-only) because the Prisma block hooks Node's real CommonJS
 * loader, which Jest's module registry bypasses. No DB, no Nest compile,
 * no server, no listen. The probe prints booleans/counts/typeof only.
 *
 * Run with:
 *   pnpm exec jest --config jest.config.js --roots test/cash-live
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

const repoRoot = path.resolve(__dirname, '..', '..');
const probe = path.join(__dirname, 'dotenv-isolation.probe.ts');

interface ProbeResult {
  mode: string;
  envFileTouched: boolean;
  keysAdded: number;
  resendApiKey: string;
  refusedAsAlreadyLoaded?: boolean;
  probeFailed?: boolean;
}

function runProbe(mode: string): ProbeResult {
  // MINIMAL environment, same shape as the documented `env -i` run.
  const result = spawnSync(
    process.execPath,
    [
      '-r',
      'ts-node/register',
      '-r',
      'tsconfig-paths/register',
      probe,
      mode,
    ],
    {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        TS_NODE_TRANSPILE_ONLY: '1',
      },
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  const line = (result.stdout ?? '')
    .split('\n')
    .reverse()
    .find((candidate) => candidate.startsWith('{"mode"'));
  if (!line) {
    throw new Error(`probe produced no result line (exit ${result.status})`);
  }
  return JSON.parse(line) as ProbeResult;
}

/** Non-type-only static import specifiers of a TS source file. */
function runtimeStaticImports(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const specifiers: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (clause?.isTypeOnly) continue;
    if (
      clause &&
      !clause.name &&
      clause.namedBindings &&
      ts.isNamedImports(clause.namedBindings) &&
      clause.namedBindings.elements.every((element) => element.isTypeOnly)
    ) {
      continue;
    }
    specifiers.push((statement.moduleSpecifier as ts.StringLiteral).text);
  }
  return specifiers;
}

describe('cash-live dotenv isolation (S5)', () => {
  jest.setTimeout(180_000);

  it('server.ts statically imports only the light guard modules (heavy graph is dynamic, after the guards)', () => {
    const imports = runtimeStaticImports(path.join(__dirname, 'server.ts'));
    expect(imports.sort()).toEqual(
      ['./disposable-env', './dotenv-isolation', './live-config', 'node:crypto'].sort(),
    );
  });

  it('dotenv-isolation.ts has no heavy static import (it must be loadable before the guards finish)', () => {
    const imports = runtimeStaticImports(
      path.join(__dirname, 'dotenv-isolation.ts'),
    );
    for (const specifier of imports) {
      expect(specifier).toMatch(/^node:/);
    }
  });

  it('control: importing the harness graph WITHOUT the block makes Prisma probe the dotenv file (detector works)', () => {
    const result = runProbe('control');
    expect(result.probeFailed).toBeUndefined();
    expect(result.envFileTouched).toBe(true);
  });

  it('loading the harness graph under a minimal env never touches a .env file and defines no variable', () => {
    const result = runProbe('harness');
    expect(result.probeFailed).toBeUndefined();
    expect(result.envFileTouched).toBe(false);
    expect(result.keysAdded).toBe(0);
    expect(result.resendApiKey).toBe('undefined');
  });

  it('fails closed when the generated Prisma client was already loaded before the block', () => {
    const result = runProbe('preloaded');
    expect(result.probeFailed).toBeUndefined();
    expect(result.refusedAsAlreadyLoaded).toBe(true);
  });
});
