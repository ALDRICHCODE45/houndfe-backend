/**
 * editorial-live harness — startup order + dotenv isolation (offline).
 *
 * Proves, without a DB or a listening server:
 *   - server.ts statically imports ONLY light guard modules; the heavy
 *     Nest/Prisma graph is loaded dynamically, AFTER both guards, through
 *     cash-live's Prisma dotenv block, followed by the credential tripwire;
 *   - the real graph loads and the Nest module COMPILES under a minimal env
 *     without touching a `.env*` file or adding variables, with the offline
 *     MAILER and storage overrides in place;
 *   - the server refuses to start (exit 1, no ready line) for missing
 *     opt-in, inherited credentials, or a forbidden DB port — the refusal
 *     happens before any DB access, so no database is ever contacted.
 *
 * Run with: pnpm exec jest --config jest.config.js --roots test/editorial-live
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

const repoRoot = path.resolve(__dirname, '..', '..');
const minimalEnv = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  TS_NODE_TRANSPILE_ONLY: '1',
};

function spawnTs(file: string, args: string[], env: Record<string, string>) {
  return spawnSync(
    process.execPath,
    ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register', file, ...args],
    { cwd: repoRoot, env, encoding: 'utf8', timeout: 150_000 },
  );
}

function runProbe(mode: string): Record<string, unknown> {
  const result = spawnTs(
    path.join(__dirname, 'startup.probe.ts'),
    [mode],
    minimalEnv,
  );
  const line = (result.stdout ?? '')
    .split('\n')
    .reverse()
    .find((candidate) => candidate.startsWith('{"mode"'));
  if (!line)
    throw new Error(`probe produced no result line (exit ${result.status})`);
  return JSON.parse(line) as Record<string, unknown>;
}

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
    )
      continue;
    specifiers.push((statement.moduleSpecifier as ts.StringLiteral).text);
  }
  return specifiers;
}

describe('editorial-live startup order and dotenv isolation', () => {
  jest.setTimeout(240_000);

  it('server.ts statically imports only light guard modules', () => {
    expect(
      runtimeStaticImports(path.join(__dirname, 'server.ts')).sort(),
    ).toEqual(
      [
        '../cash-live/disposable-env',
        './editorial-env',
        './editorial-graph',
        'node:crypto',
      ].sort(),
    );
  });

  it('editorial-graph.ts and editorial-env.ts have no heavy static import', () => {
    for (const specifier of runtimeStaticImports(
      path.join(__dirname, 'editorial-graph.ts'),
    ))
      expect(['../cash-live/dotenv-isolation']).toContain(specifier);
    for (const specifier of runtimeStaticImports(
      path.join(__dirname, 'editorial-env.ts'),
    ))
      expect([
        '../cash-live/disposable-env',
        '../cash-live/live-config',
      ]).toContain(specifier);
  });

  it('main() runs both guards, then the blocked graph import, then the tripwire', () => {
    const source = readFileSync(path.join(__dirname, 'server.ts'), 'utf8');
    const body = source.slice(source.indexOf('async function main('));
    const denied = body.indexOf('checkDeniedExternalEnv(process.env)');
    const disposable = body.indexOf(
      'checkEditorialDisposableDatabase(process.env)',
    );
    const graph = body.indexOf('loadEditorialGraph()');
    const tripwire = body.indexOf('checkDeniedExternalEnv(process.env)', graph);
    expect(denied).toBeGreaterThan(-1);
    expect(disposable).toBeGreaterThan(denied);
    expect(graph).toBeGreaterThan(disposable);
    expect(tripwire).toBeGreaterThan(graph);
  });

  it('loads the graph and compiles the module without touching .env, offline overrides in place', () => {
    const result = runProbe('harness');
    expect(result).toEqual({
      mode: 'harness',
      envFileTouched: false,
      keysAdded: 0,
      resendApiKey: 'undefined',
      corsOrigin: 'http://127.0.0.1:4191',
      corsCredentials: true,
      compiled: true,
      controllers: true,
      offlineMailer: true,
      storageRefused: true,
    });
  });

  it('fails closed when the generated Prisma client was loaded before the block', () => {
    expect(runProbe('preloaded')).toMatchObject({
      refusedAsAlreadyLoaded: true,
    });
  });

  const server = path.join(__dirname, 'server.ts');
  const dbUrl = (port: string) =>
    `postgresql://editorial_live:pw@127.0.0.1:${port}/editorial_live_test`;
  it.each([
    ['no opt-in / no URL', {}, 'disposable-environment guards failed'],
    [
      'an inherited RESEND_API_KEY',
      {
        RESEND_API_KEY: 'fake-not-a-key',
        EDITORIAL_LIVE_DISPOSABLE: '1',
        DATABASE_URL: dbUrl('55440'),
        EDITORIAL_LIVE_DATABASE_URL: dbUrl('55440'),
      },
      'external service credentials must not be inherited',
    ],
    [
      'forbidden port 5434',
      {
        EDITORIAL_LIVE_DISPOSABLE: '1',
        DATABASE_URL: dbUrl('5434'),
        EDITORIAL_LIVE_DATABASE_URL: dbUrl('5434'),
      },
      'disposable-environment guards failed',
    ],
  ])(
    'server refuses to start with %s (exit 1, no ready line)',
    (_, extra, message) => {
      const result = spawnTs(server, [], { ...minimalEnv, ...extra });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `[editorial-live] editorial-live harness refused to start: ${message}`,
      );
      expect(result.stdout).not.toContain('"ready"');
      expect(result.stderr).not.toContain('fake-not-a-key');
      expect(result.stderr).not.toContain('postgresql://');
    },
  );
});
