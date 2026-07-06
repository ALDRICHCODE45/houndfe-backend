/**
 * Environment-variable validation schema (Joi).
 *
 * This is the single source of truth for runtime configuration. It is
 * extracted from `src/app.module.ts` so it can be unit-tested in isolation
 * (D.4 spec: `env.validation.spec.ts`).
 *
 * ## Fail-closed posture (design.md "Inngest serve endpoint auth" + finding #4)
 *
 *   - `NODE_ENV` is REQUIRED — no silent default. Every other fail-closed
 *     gate below keys on `NODE_ENV`, so an unset value must NOT resolve
 *     to 'development' (which would degrade a deployed instance to dev
 *     posture: unsigned `/api/inngest`, PII dev-logger, etc). Joi
 *     throws at boot instead.
 *
 *   - `INNGEST_SIGNING_KEY` and `INNGEST_EVENT_KEY` are REQUIRED when
 *     `NODE_ENV` is `staging` or `production`. The signing key secures
 *     the `/api/inngest` endpoint (Inngest signature verification); the
 *     event key authorizes outbound events to Inngest Cloud.
 *
 *   - `RESEND_API_KEY` is REQUIRED when `NODE_ENV` is `production` —
 *     finding #4: no dev-logger fallback in prod. Staging may use the
 *     redacted dev-logger fallback, so it stays optional there.
 *
 *   - In dev / test, the optional keys are relaxed so the app boots
 *     against the Inngest Dev Server and the dev-mailer fallback without
 *     leaking prod-only secrets into the developer environment.
 *
 * Pre-existing keys (DATABASE_URL, JWT_*, SPACES_*) are preserved
 * verbatim — D.4 ONLY EXTENDS.
 */
import * as Joi from 'joi';

/**
 * Build the Joi schema used by `@nestjs/config`'s `validationSchema`
 * option. Exposed as a function so it can be re-evaluated in tests with
 * arbitrary env objects (the schema itself is otherwise a singleton).
 */
export function buildEnvValidationSchema(): Joi.ObjectSchema {
  return Joi.object({
    DATABASE_URL: Joi.string().required(),
    JWT_SECRET: Joi.string().required().min(32),
    JWT_REFRESH_SECRET: Joi.string().required().min(32),
    JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
    JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),
    SPACES_ENDPOINT: Joi.string().uri().required(),
    SPACES_REGION: Joi.string().required(),
    SPACES_BUCKET: Joi.string().required(),
    SPACES_ACCESS_KEY_ID: Joi.string().required(),
    SPACES_SECRET_ACCESS_KEY: Joi.string().required(),
    SPACES_PUBLIC_BASE_URL: Joi.string().uri().required(),
    SPACES_UPLOAD_MAX_MB: Joi.number()
      .integer()
      .min(1)
      .max(100)
      .default(10),

    // ─── D.4 — Inngest + Resend fail-closed posture ──────────────────────
    NODE_ENV: Joi.string()
      .valid('development', 'test', 'staging', 'production')
      // .required() — NO silent default. An unset NODE_ENV must NOT
      // resolve to 'development'; every fail-closed gate below keys on
      // it, so a missing value would degrade a deployed instance to dev
      // posture (unsigned /api/inngest, PII dev-logger). Requiring it
      // makes an unset env fail Joi at boot — fail-closed.
      .required(),

    // Signs /api/inngest — the Inngest SDK refuses unsigned prod requests.
    INNGEST_SIGNING_KEY: Joi.string().when('NODE_ENV', {
      is: Joi.valid('staging', 'production'),
      then: Joi.required(),
      otherwise: Joi.optional(),
    }),

    // Authorizes outbound events to Inngest Cloud.
    INNGEST_EVENT_KEY: Joi.string().when('NODE_ENV', {
      is: Joi.valid('staging', 'production'),
      then: Joi.required(),
      otherwise: Joi.optional(),
    }),

    // Resend API key — required only in production (finding #4: no
    // dev-logger fallback in prod). Staging may use the redacted dev
    // logger, so it stays optional there.
    RESEND_API_KEY: Joi.string().when('NODE_ENV', {
      is: Joi.valid('production'),
      then: Joi.required(),
      otherwise: Joi.optional(),
    }),
  });
}