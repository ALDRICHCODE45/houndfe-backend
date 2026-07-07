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
 *     the `/api/inngest` endpoint (Inngest signature verification — only
 *     enforced while the SDK is in CLOUD mode); the event key authorizes
 *     outbound events to Inngest Cloud.
 *
 *   - `RESEND_API_KEY` is REQUIRED when `NODE_ENV` is `production` —
 *     finding #4: no dev-logger fallback in prod. Staging may use the
 *     redacted dev-logger fallback, so it stays optional there.
 *
 *   - `INNGEST_DEV` (D-hardening) is FAIL-CLOSED when `NODE_ENV` is
 *     `staging` or `production`: it must be absent or explicitly
 *     `false`/`0`. The Inngest SDK derives its `mode` (cloud vs dev)
 *     from a priority chain — `options.isDev` → `INNGEST_DEV` env var →
 *     explicit URL → default cloud — and DEV mode silently disables
 *     signature verification on `serve()`. Since `/api/inngest` has no
 *     JWT guard (see `inngest.controller.ts`), a truthy `INNGEST_DEV`
 *     in a deployed environment would expose the endpoint to
 *     unauthenticated function execution. The Joi schema rejects it at
 *     boot. In dev/test the value is permissive so the Inngest Dev
 *     Server flow works.
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
    SPACES_UPLOAD_MAX_MB: Joi.number().integer().min(1).max(100).default(10),

    // ─── D.4 — Inngest + Resend fail-closed posture ──────────────────────
    NODE_ENV: Joi.string()
      .valid('development', 'test', 'staging', 'production')
      // .required() — NO silent default. An unset NODE_ENV must NOT
      // resolve to 'development'; every fail-closed gate below keys on
      // it, so a missing value would degrade a deployed instance to dev
      // posture (unsigned /api/inngest, PII dev-logger). Requiring it
      // makes an unset env fail Joi at boot — fail-closed.
      .required(),

    // Signs /api/inngest. The Inngest SDK only enforces signature
    // verification while the client is in CLOUD mode (see `INNGEST_DEV`
    // and `isDev` below). The schema enforces presence; the SDK enforces
    // the actual verification.
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

    // D-hardening — INNGEST_DEV fail-closed posture.
    //
    // The SDK's mode-resolution chain is:
    //   1. options.isDev (we pin this in `inngest.service.ts`)
    //   2. INNGEST_DEV env var (`true`/`1` → dev, anything else → cloud)
    //   3. INNGEST_DEV as a URL → dev with that URL
    //   4. default → cloud
    //
    // In deployed envs (staging/production) we reject any truthy
    // INNGEST_DEV at boot so a misconfigured env cannot demote the
    // client to dev mode (which would silently disable signature
    // verification on /api/inngest — fatal since the endpoint is
    // JWT-excluded). `.truthy('1', 1)` / `.falsy('0', 0)` extend the
    // default Joi.boolean() coercion to match the SDK's parseAsBoolean
    // (which accepts both `true`/`1` and `false`/`0`). These keywords
    // exist for dev/test parse parity — so `INNGEST_DEV=1` in a local
    // env is understood as a boolean rather than crashing boot on a
    // plain Joi.boolean(). In staging/production every truthy value is
    // rejected (boot aborts — the fail-closed outcome) with or without
    // these keywords; URL form or any other non-boolean string is also
    // rejected outright. In dev/test the value is permissive — needed
    // for the Inngest Dev Server.
    INNGEST_DEV: Joi.boolean()
      .truthy('1', 1)
      .falsy('0', 0)
      .when('NODE_ENV', {
        is: Joi.valid('staging', 'production'),
        then: Joi.valid(false).default(false),
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

    // Slice F.1 — verified sender for outbound low-stock alerts.
    // Required in production so the ResendMailer can't be silently
    // constructed without a working `from:` address (which Resend
    // rejects at send time anyway — surface the misconfig at boot
    // instead). Dev / staging may use the redacted dev-logger
    // fallback without a real sender domain.
    MAIL_FROM: Joi.string().when('NODE_ENV', {
      is: Joi.valid('production'),
      then: Joi.required(),
      otherwise: Joi.optional(),
    }),

    // Slice F.2 — per-tenant web app base URL used to construct
    // the `deepLink` in the low-stock email + the footer link in
    // the email body. Optional in dev/staging (the email template
    // still renders without it, just no footer link) — required in
    // production so a misconfigured deploy can't silently ship a
    // batch of emails with a missing deep-link / footer.
    APP_WEB_URL: Joi.string()
      .uri()
      .when('NODE_ENV', {
        is: Joi.valid('production'),
        then: Joi.required(),
        otherwise: Joi.optional(),
      }),
  });
}
