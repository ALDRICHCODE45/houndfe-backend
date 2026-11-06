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

    // No commercial default: absent means bot shipping remains disabled.
    // The signed-32-bit bound reflects the Prisma INTEGER storage columns.
    BOT_SHIPPING_CHARGE_MAX_CENTS: Joi.number()
      .integer()
      .min(1)
      .max(2_147_483_647)
      .optional(),

    // shipping-zones / T3, T8 — quote engine (docs/shipping-quotes.md §6).
    // Optional: absent keeps the default in `readShippingQuotesConfig`; a
    // present but malformed or out-of-range value fails boot instead of
    // silently falling back. Ranges mirror that reader.
    SHIPPING_QUOTE_TTL_MINUTES: Joi.number()
      .integer()
      .min(1)
      .max(1440)
      .optional(),
    SHIPPING_CARRIER_TIMEOUT_MS: Joi.number()
      .integer()
      .min(100)
      .max(120000)
      .optional(),
    SHIPPING_CREDIT_PER_UNIT_CENTS: Joi.number()
      .integer()
      .min(0)
      .max(100_000_000)
      .optional(),
    SHIPPING_CREDIT_UNIT_PRICE_THRESHOLD_CENTS: Joi.number()
      .integer()
      .min(0)
      .max(100_000_000)
      .optional(),
    // POR CONFIRMAR by the owner (credit on own-zone surcharge).
    SHIPPING_CREDIT_APPLIES_TO_SURCHARGE: Joi.boolean()
      .truthy('1', 1)
      .falsy('0', 0)
      .optional(),
    // Never honored when NODE_ENV=production (see shipping-quotes.module).
    SHIPPING_FAKE_CARRIER_ENABLED: Joi.boolean()
      .truthy('1', 1)
      .falsy('0', 0)
      .optional(),

    // shipping-zones / T6 — Skydropx carrier (docs/shipping-quotes.md §6.1).
    // All optional: without both credentials the carrier is not registered.
    // Empty values are allowed so `KEY=` in a .env means "not configured".
    SKYDROPX_CLIENT_ID: Joi.string().allow('').optional(),
    SKYDROPX_CLIENT_SECRET: Joi.string().allow('').optional(),
    SKYDROPX_BASE_URL: Joi.string()
      .uri({ scheme: ['https'] })
      .allow('')
      .optional(),
    SKYDROPX_REQUEST_TIMEOUT_MS: Joi.number()
      .integer()
      .min(500)
      .max(60000)
      .allow('')
      .optional(),
    SKYDROPX_POLL_INTERVAL_MS: Joi.number()
      .integer()
      .min(500)
      .max(10000)
      .allow('')
      .optional(),
    SKYDROPX_QUOTE_DEADLINE_MS: Joi.number()
      .integer()
      .min(1000)
      .max(120000)
      .allow('')
      .optional(),

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

    // Promotion date-range normalization — business timezone.
    //
    // PromotionsService normalizes `startDate`/`endDate` to the local
    // start-of-day / end-of-day in this IANA timezone before
    // persisting. The frontend sends date-only picks as UTC-midnight,
    // and storing that instant verbatim makes the effective-status
    // comparison drift by the business-tz offset (Mexico City is
    // UTC-6, so the final local day is silently truncated by ~6h).
    //
    // Optional everywhere — the default matches the production
    // tenant location. The PromotionsService validates the zone is a
    // known IANA name at first use, so a typo fails loudly at boot.
    PROMOTIONS_BUSINESS_TIMEZONE: Joi.string().default('America/Mexico_City'),

    // CORS — comma-separated list of allowed origins (production).
    // Absent → open CORS with a boot warning (dev fallback).
    CORS_ORIGINS: Joi.string().optional().default(''),
  });
}
