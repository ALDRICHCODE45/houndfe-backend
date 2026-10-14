/**
 * cash-live harness — standalone test-support server.
 *
 * Run (parent-authorized, disposable database required) with a MINIMAL env
 * (external credentials such as RESEND_API_KEY / AWS_* are denied):
 *
 *   env -i \
 *     PATH="$PATH" HOME="$HOME" \
 *     CASH_LIVE_DISPOSABLE=1 \
 *     DATABASE_URL="$CASH_LIVE_DATABASE_URL" \
 *     CASH_LIVE_DATABASE_URL="$CASH_LIVE_DATABASE_URL" \
 *     node -r ts-node/register -r tsconfig-paths/register test/cash-live/server.ts
 *
 * (add TS_NODE_TRANSPILE_ONLY=1 if the project tsconfig makes full
 * type-checking undesirable in your terminal)
 *
 * FAIL-CLOSED: the process refuses to start unless
 *   - CASH_LIVE_DISPOSABLE is exactly "1";
 *   - DATABASE_URL === CASH_LIVE_DATABASE_URL;
 *   - the URL is postgresql://127.0.0.1:<port-not-5432-5433>/ with user
 *     `cash_proof`, database `cash_closing_proof_test`, and NO query
 *     string or fragment (no Prisma host/socket/schema/ssl overrides);
 *   - no external-service credential (RESEND_API_KEY, AWS_*, INNGEST_*)
 *     is inherited — checked BEFORE the Nest module graph compiles.
 * It NEVER loads .env and NEVER deletes the database or containers.
 *
 * RESUME (restart without reseeding): when EITHER CASH_LIVE_RESUME_* value
 * is present the request must be complete and valid —
 * CASH_LIVE_RESUME_RUN_ID, CASH_LIVE_RESUME_SESSION_ID (existing OPEN
 * session UUID) and an EXPLICIT CASH_LIVE_FIXTURE_PATH different from the
 * default fixture. Resume reads the existing dataset through
 * ./resume-dataset, never re-seeds, and replaces the PermissionSeeder
 * bootstrap writer with a no-op for that run only (real auth guards and
 * JwtStrategy stay unchanged). See test/cash-live/README.md.
 *
 * Logging contract: fixed diagnostic texts only — no error objects, no
 * error messages (they may carry secret material), no tokens, no URLs.
 */
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  checkDeniedExternalEnv,
  checkDisposableDatabaseUrl,
} from './disposable-env';
import { loadLiveHarnessConfig } from './live-config';
import {
  configureLiveApp,
  createLiveTestingModule,
  issueActorTokens,
  prismaOf,
} from './live-harness';
import { seedFictionalDataset } from './seed';
import {
  isResumeRequested,
  loadLiveDataset,
  loadResumeDatasetPeer,
  resolveResumeStartup,
  type LiveStartupRequest,
  type RestoreExistingDataset,
  type ResumeStartupConfig,
} from './resume-startup';
import { buildFixture, writeFixtureFile } from './fixture';

/**
 * Fresh mode never restores an existing dataset. `loadLiveDataset` still
 * requires the dependency, so calling it is a logic error that fails closed
 * with a fixed message (never reached on the fresh branch).
 */
const unusedFreshRestore: RestoreExistingDataset = () =>
  Promise.reject(
    new Error('restoreExistingDataset is not used in fresh mode'),
  );

function fail(message: string): never {
  console.error(`[cash-live] ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

async function main(): Promise<void> {
  // 1. Fail-closed environment guards (offline, before any module loads).
  //    1a. Deny inherited external-service credentials FIRST.
  const deniedEnv = checkDeniedExternalEnv(process.env);
  if (!deniedEnv.ok) {
    for (const reason of deniedEnv.reasons) {
      console.error(`[cash-live] guard: ${reason}`);
    }
    fail(
      'cash-live harness refused to start: external service credentials must not be inherited',
    );
    return;
  }
  //    1b. Disposable database triple.
  const guard = checkDisposableDatabaseUrl({
    disposableFlag: process.env.CASH_LIVE_DISPOSABLE,
    databaseUrl: process.env.DATABASE_URL,
    cashLiveDatabaseUrl: process.env.CASH_LIVE_DATABASE_URL,
  });
  if (!guard.ok) {
    for (const reason of guard.reasons) {
      console.error(`[cash-live] guard: ${reason}`);
    }
    fail(
      'cash-live harness refused to start: disposable-environment guards failed',
    );
    return;
  }

  // 2. Harness config (origin/fixture-path guards, in-memory JWT secret).
  const config = loadLiveHarnessConfig(process.env);

  // 2a. Resume opt-in. When EITHER resume variable is present the request
  //     MUST be complete and valid: a partial or malformed request fails
  //     closed HERE — before any module init, token signing or listen — so
  //     the harness can never silently fall back to a fresh reseed.
  let resumeConfig: ResumeStartupConfig | undefined;
  if (isResumeRequested(process.env)) {
    const resume = resolveResumeStartup({
      env: process.env,
      fixturePath: config.fixturePath,
      rootDir: process.cwd(),
    });
    if (!resume.ok) {
      for (const reason of resume.reasons) {
        console.error(`[cash-live] resume guard: ${reason}`);
      }
      fail(
        'cash-live harness refused to start: resume mode requires both CASH_LIVE_RESUME_RUN_ID and CASH_LIVE_RESUME_SESSION_ID, valid, plus an explicit new CASH_LIVE_FIXTURE_PATH',
      );
      return;
    }
    resumeConfig = resume.config;
  }

  const resourceId = randomUUID();
  const runId = resumeConfig
    ? resumeConfig.runId
    : `${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;

  // 3. Real module graph — real guards, real controllers, real Prisma.
  //    Resume passes the EXPLICIT validated option (never ambient env), so
  //    `createLiveTestingModule` replaces the PermissionSeeder bootstrap
  //    writer with a no-op for this run only. Auth guards / JwtStrategy
  //    stay real in both modes.
  const moduleRef = await createLiveTestingModule(config, {
    resume: resumeConfig !== undefined,
  });
  const nestApp = moduleRef.createNestApplication();
  configureLiveApp(nestApp, config);
  await nestApp.init(); // Fresh: PermissionSeeder upserts the registry. Resume: no-op.

  const logger = new Logger('cash-live');
  let closed = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closed) return;
    closed = true;
    logger.log(`Received ${signal} — closing Nest and Prisma (database kept)`);
    try {
      await nestApp.close(); // PrismaService.onModuleDestroy disconnects.
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    // 4. Dataset: a fresh start seeds the fictional dataset; a resume READS
    //    the existing dataset through the T1 peer (`./resume-dataset`),
    //    never reseeds, and restores the validated session. `permissionsSeeded`
    //    comes from the stored authorization, not a bootstrap write.
    const prisma = prismaOf(moduleRef);
    const datasetRequest: LiveStartupRequest = resumeConfig
      ? {
          mode: 'resume',
          runId: resumeConfig.runId,
          sessionId: resumeConfig.sessionId,
        }
      : { mode: 'fresh', runId };
    const seed = await loadLiveDataset(datasetRequest, {
      prisma,
      restoreExistingDataset: resumeConfig
        ? loadResumeDatasetPeer().restoreExistingDataset
        : unusedFreshRestore,
      seedFictionalDataset,
    });

    // 5. Sign production-shaped JWTs with the module's real JwtService.
    const tokens = issueActorTokens(moduleRef, seed, config);
    const expiresAt = new Date(
      Date.now() + config.accessTokenTtlSeconds * 1000,
    );

    // 6. Listen on a random loopback port (port 0), CORS allowlist only.
    await nestApp.listen(0, '127.0.0.1');
    const backendUrl = await nestApp.getUrl();

    // 7. Write the frontend fixture (0600, repository-contained path).
    const fixture = buildFixture({
      config,
      seed,
      backendUrl,
      resourceId,
      rootDir: process.cwd(),
      tokens,
      expiresAt,
      permissionsSeeded: seed.permissionsSeeded,
    });
    await writeFixtureFile(config.fixturePath, fixture);

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
    // Fixed diagnostic text only — error objects/messages may carry secret
    // material (connection strings, tokens, provider payloads), so they are
    // never printed.
    logger.error(
      'cash-live harness failed during seed/token/listen/fixture step (details suppressed)',
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
  console.error(
    '[cash-live] fatal: harness startup failed (details suppressed)',
  );
  process.exitCode = 1;
});
