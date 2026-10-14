/**
 * cash-live harness — runtime configuration resolved from process.env.
 *
 * The harness NEVER loads `.env` (ConfigModule uses `ignoreEnvFile: true`).
 * Everything here comes from the explicit run environment the operator
 * provides, or from safe local generation (the JWT secret).
 *
 * Secrets discipline: the JWT secret is returned in-memory only and is
 * never logged, never written to the fixture, and never included in any
 * error message.
 */
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_FRONTEND_ORIGIN,
  resolveFixturePathWithinRoot,
  validateLoopbackHttpOrigin,
} from './disposable-env';

/** Access-token TTL for the harness session (frontend-agreed, 2 hours). */
export const ACCESS_TOKEN_TTL_SECONDS = 7200;
export const ACCESS_TOKEN_EXPIRES_IN = '2h';

/** Minimum JWT secret length in characters (mirrors production policy). */
const JWT_SECRET_MIN_LENGTH = 32;

export interface LiveHarnessConfig {
  /** Validated loopback origin allowed by CORS (single value). */
  frontendOrigin: string;
  /** Absolute fixture path, guaranteed inside the repository root. */
  fixturePath: string;
  /** In-memory JWT secret (env-provided or locally generated). */
  jwtSecret: string;
  /** True when the secret came from the environment. */
  jwtSecretFromEnv: boolean;
  /** Access-token lifetime in seconds (fixture `ttlSeconds`). */
  accessTokenTtlSeconds: number;
  /** Nest `signOptions.expiresIn` matching the TTL. */
  accessTokenExpiresIn: string;
}

/**
 * Resolve the JWT secret: `CASH_LIVE_JWT_SECRET` when it meets the
 * 32-character minimum, otherwise a locally generated random secret.
 */
function resolveJwtSecret(env: NodeJS.ProcessEnv): {
  secret: string;
  fromEnv: boolean;
} {
  const fromEnv = env.CASH_LIVE_JWT_SECRET;
  if (fromEnv && fromEnv.length >= JWT_SECRET_MIN_LENGTH) {
    return { secret: fromEnv, fromEnv: true };
  }
  return { secret: randomBytes(48).toString('base64url'), fromEnv: false };
}

/** Build the full harness configuration; throws on any invalid input. */
export function loadLiveHarnessConfig(
  env: NodeJS.ProcessEnv,
): LiveHarnessConfig {
  const frontendOrigin = validateLoopbackHttpOrigin(
    env.CASH_LIVE_FRONTEND_ORIGIN ?? DEFAULT_FRONTEND_ORIGIN,
  );
  const fixturePath = resolveFixturePathWithinRoot(
    env.CASH_LIVE_FIXTURE_PATH,
    process.cwd(),
  );
  const { secret, fromEnv } = resolveJwtSecret(env);

  const ttlRaw = env.CASH_LIVE_ACCESS_TTL_SECONDS;
  let ttlSeconds = ACCESS_TOKEN_TTL_SECONDS;
  if (ttlRaw !== undefined) {
    const parsed = Number(ttlRaw);
    if (!Number.isInteger(parsed) || parsed < 60 || parsed > 86400) {
      throw new Error(
        'CASH_LIVE_ACCESS_TTL_SECONDS must be an integer between 60 and 86400',
      );
    }
    ttlSeconds = parsed;
  }

  return {
    frontendOrigin,
    fixturePath,
    jwtSecret: secret,
    jwtSecretFromEnv: fromEnv,
    accessTokenTtlSeconds: ttlSeconds,
    accessTokenExpiresIn: `${ttlSeconds}s`,
  };
}
