/**
 * editorial-live harness — child-process probe for startup.spec.ts.
 *
 * NOT a test and NOT a server: it IMPORTS the editorial graph and COMPILES
 * the Nest testing module (no `init`, so no Prisma connect, no DB, no
 * listen) under the minimal env the spec spawned it with, then prints ONE
 * JSON line of booleans/counts/`typeof`. Never prints values or paths.
 *
 * Modes (argv[2]):
 *   - `harness`   — real startup path (`loadEditorialGraph`) + module
 *                   compile. `.env*` access is recorded (passed through).
 *   - `preloaded` — loads the generated Prisma client first (`.env*`
 *                   denied), then `loadEditorialGraph` must fail closed.
 */
import { installEnvFileRecorder } from '../cash-live/env-file-recorder';

const mode = process.argv[2];
// Installed before ANY dynamic import of the Nest/Prisma graph below.
const recorder = installEnvFileRecorder({ deny: mode === 'preloaded' });

async function harness(): Promise<Record<string, unknown>> {
  const { loadEditorialGraph } = await import('./editorial-graph');
  const graph = await loadEditorialGraph();
  const moduleRef = await graph.liveHarness.createEditorialLiveTestingModule({
    frontendOrigin: 'http://127.0.0.1:4191',
    fixturePath: '/unused',
    jwtSecret: 'probe-secret-0123456789abcdefghijklmnop',
    jwtSecretFromEnv: false,
    accessTokenTtlSeconds: 7200,
    accessTokenExpiresIn: '7200s',
  });
  const { EditorialReadController } =
    await import('../../src/catalog-editorial/http/editorial-read.controller');
  const { EditorialWriteController, EditorialPublishedController } =
    await import('../../src/catalog-editorial/http/editorial-write.controller');
  const { EditorialVocabularyController } =
    await import('../../src/catalog-editorial/http/editorial-vocabulary.controller');
  const { EditorialContextController } =
    await import('../../src/catalog-editorial/http/editorial-context.controller');
  const { ProductsController } =
    await import('../../src/products/products.controller');
  const { MAILER } = await import('../../src/notifications/email/mailer.port');
  const { STORAGE_PORT } = await import('../../src/files/domain/storage.port');
  const { OfflineNoSendMailer } = await import('../cash-live/offline-mailer');
  const has = (token: unknown) => {
    try {
      return moduleRef.get(token as never, { strict: false }) !== undefined;
    } catch {
      return false;
    }
  };
  const mailer: unknown = moduleRef.get(MAILER, { strict: false });
  const storage: { upload(): Promise<unknown> } = moduleRef.get(STORAGE_PORT, {
    strict: false,
  });
  let storageRefused = false;
  try {
    await storage.upload();
  } catch {
    storageRefused = true;
  }
  // CORS wiring: capture the delegate the harness installs (no listen).
  let corsDelegate: unknown;
  graph.liveHarness.configureEditorialLiveApp(
    {
      useGlobalPipes: () => undefined,
      useGlobalFilters: () => undefined,
      enableCors: (options: unknown) => {
        corsDelegate = options;
      },
    } as never,
    {
      frontendOrigin: 'http://127.0.0.1:4191',
      fixturePath: '/unused',
      jwtSecret: 'unused-unused-unused-unused-unused-unused',
      jwtSecretFromEnv: false,
      accessTokenTtlSeconds: 7200,
      accessTokenExpiresIn: '7200s',
    },
  );
  const cors = await new Promise<{ origin?: unknown; credentials?: unknown }>(
    (resolve) =>
      (
        corsDelegate as (
          req: unknown,
          cb: (
            e: unknown,
            o: { origin?: unknown; credentials?: unknown },
          ) => void,
        ) => void
      )(
        {
          method: 'GET',
          originalUrl: '/products/x/editorial',
          get: () => undefined,
        },
        (_e, options) => resolve(options),
      ),
  );
  const result = {
    corsOrigin: cors.origin,
    corsCredentials: cors.credentials,
    compiled: true,
    controllers: [
      EditorialReadController,
      EditorialWriteController,
      EditorialPublishedController,
      EditorialVocabularyController,
      EditorialContextController,
      ProductsController,
    ].every(has),
    offlineMailer: mailer instanceof OfflineNoSendMailer,
    storageRefused,
  };
  await moduleRef.close();
  return result;
}

async function run(): Promise<Record<string, unknown>> {
  const keysBefore = new Set(Object.keys(process.env));
  let extra: Record<string, unknown> = {};
  if (mode === 'harness') {
    extra = await harness();
  } else if (mode === 'preloaded') {
    await import('@prisma/client');
    const { loadEditorialGraph } = await import('./editorial-graph');
    const { PRISMA_ALREADY_LOADED_MESSAGE } =
      await import('../cash-live/dotenv-isolation');
    let refusedAsAlreadyLoaded = false;
    try {
      await loadEditorialGraph();
    } catch (error) {
      // Compare against the FIXED message only — never print the error.
      refusedAsAlreadyLoaded =
        error instanceof Error &&
        error.message === PRISMA_ALREADY_LOADED_MESSAGE;
    }
    extra = { refusedAsAlreadyLoaded };
  } else {
    throw new Error('probe: unknown mode');
  }
  return {
    mode,
    envFileTouched: recorder.touched(),
    keysAdded: Object.keys(process.env).filter((key) => !keysBefore.has(key))
      .length,
    resendApiKey: typeof process.env.RESEND_API_KEY,
    ...extra,
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
