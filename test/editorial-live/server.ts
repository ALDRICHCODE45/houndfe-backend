/**
 * editorial-live harness — standalone test-support server (disposable).
 *
 * Run (parent-authorized, disposable database required) with a MINIMAL env:
 *
 *   env -i \
 *     PATH="$PATH" HOME="$HOME" \
 *     EDITORIAL_LIVE_DISPOSABLE=1 \
 *     DATABASE_URL="$EDITORIAL_LIVE_DATABASE_URL" \
 *     EDITORIAL_LIVE_DATABASE_URL="$EDITORIAL_LIVE_DATABASE_URL" \
 *     node -r ts-node/register -r tsconfig-paths/register test/editorial-live/server.ts
 *
 * FAIL-CLOSED (cash-live guards, editorial profile — see ./editorial-env):
 *   - no inherited external credential (RESEND_API_KEY, AWS_*, INNGEST_*),
 *     checked BEFORE the Nest/Prisma graph is imported and again right
 *     after (tripwire);
 *   - EDITORIAL_LIVE_DISPOSABLE=1, DATABASE_URL === EDITORIAL_LIVE_DATABASE_URL,
 *     postgresql://editorial_live@127.0.0.1:<port>/editorial_live_test,
 *     port not 5432/5433/5434, no query string / fragment.
 * It NEVER loads .env and NEVER deletes anything.
 *
 * STARTUP ORDER: this file statically imports ONLY light guard modules.
 * The heavy graph is loaded through `loadEditorialGraph()` (cash-live's
 * Prisma dotenv block) AFTER the guards pass.
 *
 * Logging contract: fixed diagnostic texts only — no error objects or
 * messages, no tokens, no URLs. stdout carries exactly one ready line.
 */
// Light, guard-only static imports. NOTHING here may reach Nest or Prisma
// (enforced by startup.spec.ts).
import { randomUUID } from 'node:crypto';
import { checkDeniedExternalEnv } from '../cash-live/disposable-env';
import {
  checkEditorialDisposableDatabase,
  loadEditorialLiveConfig,
} from './editorial-env';
import { loadEditorialGraph } from './editorial-graph';

const TAG = '[editorial-live]';

function refuse(reason: string, details: string[], label = 'guard'): never {
  for (const detail of details) console.error(`${TAG} ${label}: ${detail}`);
  const message = `editorial-live harness refused to start: ${reason}`;
  console.error(`${TAG} ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

async function main(): Promise<void> {
  // 1a. Deny inherited external-service credentials FIRST.
  const deniedEnv = checkDeniedExternalEnv(process.env);
  if (!deniedEnv.ok)
    refuse(
      'external service credentials must not be inherited',
      deniedEnv.reasons,
    );
  // 1b. Disposable editorial database.
  const guard = checkEditorialDisposableDatabase(process.env);
  if (!guard.ok) refuse('disposable-environment guards failed', guard.reasons);
  // 1c. Harness config (origin / fixture path / secret / TTL) — pure.
  let config: ReturnType<typeof loadEditorialLiveConfig>;
  try {
    config = loadEditorialLiveConfig(process.env);
  } catch (error) {
    // Config errors name env variables only (never values).
    refuse('invalid harness configuration', [
      error instanceof Error ? error.message : 'invalid configuration',
    ]);
  }

  // 2. Only NOW load the heavy graph with Prisma's dotenv load blocked.
  let graph: Awaited<ReturnType<typeof loadEditorialGraph>>;
  try {
    graph = await loadEditorialGraph();
  } catch {
    refuse(
      'module graph could not be loaded with the dotenv block (details suppressed)',
      [],
    );
  }
  //    Tripwire: the import must not have introduced a denied credential.
  const deniedAfterImport = checkDeniedExternalEnv(process.env);
  if (!deniedAfterImport.ok)
    refuse(
      'external service credentials appeared during module import',
      deniedAfterImport.reasons,
      'guard (after import)',
    );

  const {
    configureEditorialLiveApp,
    createEditorialLiveTestingModule,
    issueEditorialActorTokens,
    prismaOf,
  } = graph.liveHarness;
  const { seedEditorialLiveDataset } = graph.seed;
  const { buildEditorialFixture, writeEditorialFixtureFile } = graph.fixture;
  const logger = new graph.Logger('editorial-live');

  const resourceId = randomUUID();
  const runId = `${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;

  // 3. Real module graph; init runs the production PermissionSeeder.
  const moduleRef = await createEditorialLiveTestingModule(config);
  const nestApp = moduleRef.createNestApplication();
  configureEditorialLiveApp(nestApp, config);
  await nestApp.init();

  let closed = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closed) return;
    closed = true;
    logger.log(`Received ${signal} — closing Nest and Prisma (database kept)`);
    try {
      await nestApp.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    // 4. Seed the per-run dataset (one transaction).
    const seed = await seedEditorialLiveDataset(prismaOf(moduleRef), runId);
    // 5. Production-shaped JWTs (in memory only).
    const tokens = issueEditorialActorTokens(moduleRef, seed, config);
    const expiresAt = new Date(
      Date.now() + config.accessTokenTtlSeconds * 1000,
    );
    // 6. Random loopback port.
    await nestApp.listen(0, '127.0.0.1');
    const backendUrl = await nestApp.getUrl();
    // 7. Fixture (0600, exclusive, repository-contained).
    await writeEditorialFixtureFile(
      config.fixturePath,
      buildEditorialFixture({
        config,
        seed,
        backendUrl,
        resourceId,
        rootDir: process.cwd(),
        tokens,
        expiresAt,
      }),
    );
    // 8. Ready line — the ONLY stdout contract: no secrets, no tokens.
    process.stdout.write(
      `${JSON.stringify({
        ready: true,
        baseURL: backendUrl,
        resourceId,
        fixturePath: config.fixturePath,
      })}\n`,
    );
  } catch {
    logger.error(
      'editorial-live harness failed during seed/token/listen/fixture step (details suppressed)',
    );
    try {
      await nestApp.close();
    } catch {
      // already closing or closed
    }
    process.exitCode = 1;
  }
}

void main().catch(() => {
  // `refuse` already printed its fixed reason; keep exit code 1.
  process.exitCode = 1;
});
