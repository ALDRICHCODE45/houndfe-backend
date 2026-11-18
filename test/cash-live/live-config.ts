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
  DEFAULT_FIXTURE_PATH,
  DEFAULT_FRONTEND_ORIGIN,
  resolveFixturePathWithinRoot,
  validateLoopbackHttpOrigin,
} from './disposable-env';

/** Access-token TTL for the harness session (frontend-agreed, 2 hours). */
export const ACCESS_TOKEN_TTL_SECONDS = 7200;
export const ACCESS_TOKEN_EXPIRES_IN = '2h';

/** Minimum JWT secret length in characters (mirrors production policy). */
const JWT_SECRET_MIN_LENGTH = 32;

/**
 * Env-name prefix + defaults of a harness. cash-live uses the default
 * profile (`CASH_LIVE_*`, `.tmp/cash-live/fixture.json`, 4189); sibling
 * harnesses pass their own. The validation rules are identical for every
 * profile (loopback origin, repository-contained fixture, >=32-char secret,
 * TTL 60..86400).
 */
export interface LiveHarnessConfigProfile {
  envPrefix: string;
  defaultFixturePath: string;
  /** Loopback origin used when `<PREFIX>_FRONTEND_ORIGIN` is unset. */
  defaultFrontendOrigin: string;
}

export const CASH_LIVE_CONFIG_PROFILE: LiveHarnessConfigProfile = Object.freeze(
  {
    envPrefix: 'CASH_LIVE',
    defaultFixturePath: DEFAULT_FIXTURE_PATH,
    defaultFrontendOrigin: DEFAULT_FRONTEND_ORIGIN,
  },
);

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
 * Resolve the JWT secret: `<PREFIX>_JWT_SECRET` when it meets the
 * 32-character minimum, otherwise a locally generated random secret.
 */
function resolveJwtSecret(
  env: NodeJS.ProcessEnv,
  prefix: string,
): {
  secret: string;
  fromEnv: boolean;
} {
  const fromEnv = env[`${prefix}_JWT_SECRET`];
  if (fromEnv && fromEnv.length >= JWT_SECRET_MIN_LENGTH) {
    return { secret: fromEnv, fromEnv: true };
  }
  return { secret: randomBytes(48).toString('base64url'), fromEnv: false };
}

/** Build the full harness configuration; throws on any invalid input. */
export function loadLiveHarnessConfig(
  env: NodeJS.ProcessEnv,
  profile: LiveHarnessConfigProfile = CASH_LIVE_CONFIG_PROFILE,
): LiveHarnessConfig {
  const prefix = profile.envPrefix;
  const frontendOrigin = validateLoopbackHttpOrigin(
    env[`${prefix}_FRONTEND_ORIGIN`] ?? profile.defaultFrontendOrigin,
    `${prefix}_FRONTEND_ORIGIN`,
  );
  const fixturePath = resolveFixturePathWithinRoot(
    env[`${prefix}_FIXTURE_PATH`],
    process.cwd(),
    {
      defaultPath: profile.defaultFixturePath,
      envName: `${prefix}_FIXTURE_PATH`,
    },
  );
  const { secret, fromEnv } = resolveJwtSecret(env, prefix);

  const ttlRaw = env[`${prefix}_ACCESS_TTL_SECONDS`];
  let ttlSeconds = ACCESS_TOKEN_TTL_SECONDS;
  if (ttlRaw !== undefined) {
    const parsed = Number(ttlRaw);
    if (!Number.isInteger(parsed) || parsed < 60 || parsed > 86400) {
      throw new Error(
        `${prefix}_ACCESS_TTL_SECONDS must be an integer between 60 and 86400`,
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
