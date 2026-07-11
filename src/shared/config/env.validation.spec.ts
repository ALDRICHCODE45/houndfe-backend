/**
 * Slice D.4 — env validation schema tests.
 *
 * The Joi schema lives in `env.validation.ts` so it can be unit-tested
 * without booting the app. It enforces FAIL-CLOSED posture on the
 * runtime configuration:
 *
 *   - `NODE_ENV` itself is REQUIRED (no silent default — an unset
 *     `NODE_ENV` must NOT resolve to 'development', because every other
 *     fail-closed gate below keys on it; silently defaulting to dev
 *     would let an unset env degrade a deployed instance to dev
 *     posture — unsigned `/api/inngest`, PII dev-logger, etc).
 *
 *   - `INNGEST_SIGNING_KEY` and `INNGEST_EVENT_KEY` are REQUIRED in
 *     staging/production — they secure the `/api/inngest` endpoint
 *     (signing key) and the event API (event key).
 *
 *   - `RESEND_API_KEY` is REQUIRED in production — design.md finding #4:
 *     "no dev-logger fallback in prod", so a missing key in prod must
 *     fail Joi at boot, never reach a runtime path that silently
 *     swallows email failures.
 *
 *   - In dev/test the optional keys are relaxed so the app boots against
 *     the Inngest Dev Server / the redacted dev mailer fallback.
 *
 * The schema also keeps the pre-existing keys (DATABASE_URL, JWT_*,
 * SPACES_*) — D.4 only EXTENDS, never removes.
 */
import * as Joi from 'joi';
import { buildEnvValidationSchema } from './env.validation';

/**
 * Runs the schema against an env object — mirrors how @nestjs/config
 * internally validates `process.env`. Returns `{ error, value }` so
 * tests can assert either way.
 */
function validate(env: Record<string, string | undefined>): {
  error?: Joi.ValidationError;
  value: Record<string, unknown>;
} {
  return buildEnvValidationSchema().validate(env, {
    abortEarly: false,
    allowUnknown: true,
  });
}

const baseValidEnv = {
  DATABASE_URL: 'postgresql://localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
  JWT_REFRESH_SECRET: 'y'.repeat(32),
  SPACES_ENDPOINT: 'https://nyc3.digitaloceanspaces.com',
  SPACES_REGION: 'nyc3',
  SPACES_BUCKET: 'bucket',
  SPACES_ACCESS_KEY_ID: 'aki',
  SPACES_SECRET_ACCESS_KEY: 'sak',
  SPACES_PUBLIC_BASE_URL: 'https://bucket.nyc3.cdn.digitaloceanspaces.com',
};

describe('buildEnvValidationSchema (D.4)', () => {
  describe('NODE_ENV (REQUIRED — no silent default)', () => {
    it('fails when NODE_ENV is missing (fail-closed: an unset env must not degrade to dev)', () => {
      const { error } = validate({ ...baseValidEnv });
      expect(error).toBeDefined();
      expect(error!.details.some((d) => d.path.includes('NODE_ENV'))).toBe(
        true,
      );
    });

    it('accepts development, test, staging, production', () => {
      for (const env of ['development', 'test', 'staging', 'production']) {
        // For staging / production we must supply the keys the schema
        // requires at those NODE_ENV levels — this test focuses only on
        // NODE_ENV acceptance, not the key requirements.
        const extras: Record<string, string> = {};
        if (env === 'staging' || env === 'production') {
          extras.INNGEST_SIGNING_KEY = 'sk';
          extras.INNGEST_EVENT_KEY = 'ek';
        }
        if (env === 'production') {
          extras.RESEND_API_KEY = 're';
          extras.MAIL_FROM = 'Alerts <alerts@example.com>';
          extras.APP_WEB_URL = 'https://app.example.com';
        }
        const { error } = validate({
          ...baseValidEnv,
          ...extras,
          NODE_ENV: env,
        });
        expect(error).toBeUndefined();
      }
    });

    it('rejects an unknown NODE_ENV value', () => {
      const { error } = validate({ ...baseValidEnv, NODE_ENV: 'qa' });
      expect(error).toBeDefined();
      expect(error!.details.some((d) => d.path.includes('NODE_ENV'))).toBe(
        true,
      );
    });
  });

  describe('INNGEST_SIGNING_KEY (required in staging/production, optional in dev/test)', () => {
    it('is REQUIRED when NODE_ENV=production (absent key ⇒ boot fails)', () => {
      const { error } = validate({
        ...baseValidEnv,
        NODE_ENV: 'production',
        INNGEST_EVENT_KEY: 'evt_test',
        RESEND_API_KEY: 're_test',
      });
      expect(error).toBeDefined();
      expect(
        error!.details.some((d) => d.path.includes('INNGEST_SIGNING_KEY')),
      ).toBe(true);
    });

    it('is REQUIRED when NODE_ENV=staging (absent key ⇒ boot fails)', () => {
      const { error } = validate({
        ...baseValidEnv,
        NODE_ENV: 'staging',
        INNGEST_EVENT_KEY: 'evt_test',
      });
      expect(error).toBeDefined();
      expect(
        error!.details.some((d) => d.path.includes('INNGEST_SIGNING_KEY')),
      ).toBe(true);
    });

    it('is OPTIONAL when NODE_ENV=development (Inngest Dev Server does not sign)', () => {
      const { error } = validate({ ...baseValidEnv, NODE_ENV: 'development' });
      expect(error).toBeUndefined();
    });

    it('is OPTIONAL when NODE_ENV=test', () => {
      const { error } = validate({ ...baseValidEnv, NODE_ENV: 'test' });
      expect(error).toBeUndefined();
    });

    it('accepts a non-empty key in production', () => {
      const { error } = validate({
        ...baseValidEnv,
        NODE_ENV: 'production',
        INNGEST_SIGNING_KEY: 'signkey-prod-xxx',
        INNGEST_EVENT_KEY: 'evt-prod-xxx',
        RESEND_API_KEY: 're-prod-xxx',
        MAIL_FROM: 'Alerts <alerts@example.com>',
        APP_WEB_URL: 'https://app.example.com',
      });
      expect(error).toBeUndefined();
    });

    it('rejects an EMPTY key in production (whitespace-only would also fail under .required())', () => {
      const { error } = validate({
        ...baseValidEnv,
        NODE_ENV: 'production',
        INNGEST_SIGNING_KEY: '',
        INNGEST_EVENT_KEY: 'evt',
        RESEND_API_KEY: 're',
      });
      expect(error).toBeDefined();
      expect(
        error!.details.some((d) => d.path.includes('INNGEST_SIGNING_KEY')),
      ).toBe(true);
    });
  });

  describe('INNGEST_EVENT_KEY (required in staging/production)', () => {
    it('is REQUIRED when NODE_ENV=production', () => {
      const { error } = validate({
        ...baseValidEnv,
        NODE_ENV: 'production',
        INNGEST_SIGNING_KEY: 'signkey',
        RESEND_API_KEY: 're',
      });
      expect(error).toBeDefined();
      expect(
        error!.details.some((d) => d.path.includes('INNGEST_EVENT_KEY')),
      ).toBe(true);
    });

    it('is OPTIONAL in development', () => {
      const { error } = validate({ ...baseValidEnv, NODE_ENV: 'development' });
      expect(error).toBeUndefined();
    });
  });

  describe('RESEND_API_KEY (required in production only)', () => {
    it('is REQUIRED when NODE_ENV=production (no dev-logger fallback in prod — finding #4)', () => {
      const { error } = validate({
        ...baseValidEnv,
        NODE_ENV: 'production',
        INNGEST_SIGNING_KEY: 'signkey',
        INNGEST_EVENT_KEY: 'evt',
      });
      expect(error).toBeDefined();
      expect(
        error!.details.some((d) => d.path.includes('RESEND_API_KEY')),
      ).toBe(true);
    });

    it('is OPTIONAL when NODE_ENV=staging (dev-logger fallback is allowed for non-prod)', () => {
      const { error } = validate({
        ...baseValidEnv,
        NODE_ENV: 'staging',
        INNGEST_SIGNING_KEY: 'signkey',
        INNGEST_EVENT_KEY: 'evt',
      });
      expect(error).toBeUndefined();
    });

    it('is OPTIONAL when NODE_ENV=development', () => {
      const { error } = validate({ ...baseValidEnv, NODE_ENV: 'development' });
      expect(error).toBeUndefined();
    });

    it('accepts a non-empty key in production', () => {
      const { error } = validate({
        ...baseValidEnv,
        NODE_ENV: 'production',
        INNGEST_SIGNING_KEY: 'signkey',
        INNGEST_EVENT_KEY: 'evt',
        RESEND_API_KEY: 're-prod',
        MAIL_FROM: 'Alerts <alerts@example.com>',
        APP_WEB_URL: 'https://app.example.com',
      });
      expect(error).toBeUndefined();
    });

    it('rejects a missing MAIL_FROM in production (verified sender is fail-closed)', () => {
      const { error } = validate({
        ...baseValidEnv,
        NODE_ENV: 'production',
        INNGEST_SIGNING_KEY: 'signkey',
        INNGEST_EVENT_KEY: 'evt',
        RESEND_API_KEY: 're-prod',
        APP_WEB_URL: 'https://app.example.com',
        // MAIL_FROM omitted on purpose
      });
      expect(error).toBeDefined();
      expect(error!.details.some((d) => d.path.includes('MAIL_FROM'))).toBe(
        true,
      );
    });

    it('rejects a missing APP_WEB_URL in production (deep-link base is fail-closed)', () => {
      const { error } = validate({
        ...baseValidEnv,
        NODE_ENV: 'production',
        INNGEST_SIGNING_KEY: 'signkey',
        INNGEST_EVENT_KEY: 'evt',
        RESEND_API_KEY: 're-prod',
        MAIL_FROM: 'Alerts <alerts@example.com>',
        // APP_WEB_URL omitted on purpose
      });
      expect(error).toBeDefined();
      expect(error!.details.some((d) => d.path.includes('APP_WEB_URL'))).toBe(
        true,
      );
    });

    it('accepts MAIL_FROM + APP_WEB_URL as OPTIONAL in development (dev-mailer fallback covers the absence)', () => {
      const { error } = validate({
        ...baseValidEnv,
        NODE_ENV: 'development',
      });
      expect(error).toBeUndefined();
    });
  });

  describe('pre-existing keys (D.4 only extends — never removes)', () => {
    it('still requires DATABASE_URL', () => {
      const { DATABASE_URL, ...rest } = baseValidEnv;
      void DATABASE_URL;
      const { error } = validate({ ...rest, NODE_ENV: 'development' });
      expect(error).toBeDefined();
      expect(error!.details.some((d) => d.path.includes('DATABASE_URL'))).toBe(
        true,
      );
    });

    it('still requires JWT_SECRET (min 32 chars)', () => {
      const { error } = validate({
        ...baseValidEnv,
        NODE_ENV: 'development',
        JWT_SECRET: 'short',
      });
      expect(error).toBeDefined();
      expect(error!.details.some((d) => d.path.includes('JWT_SECRET'))).toBe(
        true,
      );
    });
  });

  describe('fail-closed composition (D.4 — Triangulation)', () => {
    it('a prod env missing ALL production-only keys surfaces ALL of them in one shot (abortEarly:false)', () => {
      const { error } = validate({
        ...baseValidEnv,
        NODE_ENV: 'production',
      });
      expect(error).toBeDefined();
      const paths = error!.details.map((d) => d.path.join('.'));
      expect(paths).toContain('INNGEST_SIGNING_KEY');
      expect(paths).toContain('INNGEST_EVENT_KEY');
      expect(paths).toContain('RESEND_API_KEY');
      // Slice F.1 — MAIL_FROM required in prod (verified sender).
      expect(paths).toContain('MAIL_FROM');
      // Slice F.2 — APP_WEB_URL required in prod (deep-link base).
      expect(paths).toContain('APP_WEB_URL');
    });

    it('a complete production env validates cleanly', () => {
      const { error, value } = validate({
        ...baseValidEnv,
        NODE_ENV: 'production',
        INNGEST_SIGNING_KEY: 'signkey-prod',
        INNGEST_EVENT_KEY: 'evt-prod',
        RESEND_API_KEY: 're-prod',
        MAIL_FROM: 'Alerts <alerts@example.com>',
        APP_WEB_URL: 'https://app.example.com',
      });
      expect(error).toBeUndefined();
      expect(value.NODE_ENV).toBe('production');
      expect(value.INNGEST_SIGNING_KEY).toBe('signkey-prod');
      expect(value.INNGEST_EVENT_KEY).toBe('evt-prod');
      expect(value.RESEND_API_KEY).toBe('re-prod');
    });

    it('a complete development env validates cleanly (all three keys optional)', () => {
      const { error, value } = validate({
        ...baseValidEnv,
        NODE_ENV: 'development',
      });
      expect(error).toBeUndefined();
      expect(value.NODE_ENV).toBe('development');
      // Optional keys absent in dev — they are simply undefined on value.
      expect(value.INNGEST_SIGNING_KEY).toBeUndefined();
      expect(value.INNGEST_EVENT_KEY).toBeUndefined();
      expect(value.RESEND_API_KEY).toBeUndefined();
    });
  });

  // ─── D-hardening — INNGEST_DEV fail-closed posture ─────────────────
  // The Inngest SDK derives its mode (cloud vs dev) from `options.isDev`
  // → `INNGEST_DEV` → URL → default cloud. Dev mode makes `serve()`
  // accept UNSIGNED requests — fatal on /api/inngest (no JWT guard). We
  // therefore reject a truthy INNGEST_DEV when NODE_ENV is staging/
  // production. In dev/test it is permissive (boots against the Dev
  // Server).
  describe('INNGEST_DEV (D-hardening — fail-closed in deployed envs)', () => {
    it('rejects INNGEST_DEV=true in production (the bypass the gate is closing)', () => {
      const { error } = validate({
        ...baseValidEnv,
        NODE_ENV: 'production',
        INNGEST_SIGNING_KEY: 'sk',
        INNGEST_EVENT_KEY: 'ek',
        RESEND_API_KEY: 're',
        INNGEST_DEV: 'true',
      });
      expect(error).toBeDefined();
      expect(error!.details.some((d) => d.path.includes('INNGEST_DEV'))).toBe(
        true,
      );
    });

    it('rejects INNGEST_DEV=1 in production', () => {
      const { error } = validate({
        ...baseValidEnv,
        NODE_ENV: 'production',
        INNGEST_SIGNING_KEY: 'sk',
        INNGEST_EVENT_KEY: 'ek',
        RESEND_API_KEY: 're',
        INNGEST_DEV: '1',
      });
      expect(error).toBeDefined();
      expect(error!.details.some((d) => d.path.includes('INNGEST_DEV'))).toBe(
        true,
      );
    });

    it('rejects INNGEST_DEV=true in staging', () => {
      const { error } = validate({
        ...baseValidEnv,
        NODE_ENV: 'staging',
        INNGEST_SIGNING_KEY: 'sk',
        INNGEST_EVENT_KEY: 'ek',
        INNGEST_DEV: 'true',
      });
      expect(error).toBeDefined();
      expect(error!.details.some((d) => d.path.includes('INNGEST_DEV'))).toBe(
        true,
      );
    });

    it('accepts INNGEST_DEV=false in production (explicit cloud mode is fine)', () => {
      const { error } = validate({
        ...baseValidEnv,
        NODE_ENV: 'production',
        INNGEST_SIGNING_KEY: 'sk',
        INNGEST_EVENT_KEY: 'ek',
        RESEND_API_KEY: 're',
        MAIL_FROM: 'Alerts <alerts@example.com>',
        APP_WEB_URL: 'https://app.example.com',
        INNGEST_DEV: 'false',
      });
      expect(error).toBeUndefined();
    });

    it('accepts INNGEST_DEV=0 in production (explicit cloud mode is fine)', () => {
      const { error } = validate({
        ...baseValidEnv,
        NODE_ENV: 'production',
        INNGEST_SIGNING_KEY: 'sk',
        INNGEST_EVENT_KEY: 'ek',
        RESEND_API_KEY: 're',
        MAIL_FROM: 'Alerts <alerts@example.com>',
        APP_WEB_URL: 'https://app.example.com',
        INNGEST_DEV: '0',
      });
      expect(error).toBeUndefined();
    });

    it('accepts INNGEST_DEV unset in production (default posture is fail-closed)', () => {
      const { error } = validate({
        ...baseValidEnv,
        NODE_ENV: 'production',
        INNGEST_SIGNING_KEY: 'sk',
        INNGEST_EVENT_KEY: 'ek',
        RESEND_API_KEY: 're',
        MAIL_FROM: 'Alerts <alerts@example.com>',
        APP_WEB_URL: 'https://app.example.com',
      });
      expect(error).toBeUndefined();
    });

    it('rejects non-boolean INNGEST_DEV values in production (URL form / unknown strings are fail-closed)', () => {
      // The SDK's mode-resolution falls back to "dev" when INNGEST_DEV is
      // a URL. Joi.boolean() rejects any non-boolean string outright, so
      // a misconfigured URL form also aborts boot — exactly what we want.
      const { error } = validate({
        ...baseValidEnv,
        NODE_ENV: 'production',
        INNGEST_SIGNING_KEY: 'sk',
        INNGEST_EVENT_KEY: 'ek',
        RESEND_API_KEY: 're',
        INNGEST_DEV: 'https://dev.example.com',
      });
      expect(error).toBeDefined();
      expect(error!.details.some((d) => d.path.includes('INNGEST_DEV'))).toBe(
        true,
      );
    });

    it('accepts INNGEST_DEV=true in development (Dev Server flow)', () => {
      const { error } = validate({
        ...baseValidEnv,
        NODE_ENV: 'development',
        INNGEST_DEV: 'true',
      });
      expect(error).toBeUndefined();
    });

    it('accepts INNGEST_DEV=1 in development', () => {
      const { error } = validate({
        ...baseValidEnv,
        NODE_ENV: 'development',
        INNGEST_DEV: '1',
      });
      expect(error).toBeUndefined();
    });

    it('accepts INNGEST_DEV unset in development (default)', () => {
      const { error } = validate({
        ...baseValidEnv,
        NODE_ENV: 'development',
      });
      expect(error).toBeUndefined();
    });

    it('accepts INNGEST_DEV=1 in test (parity with development)', () => {
      const { error } = validate({
        ...baseValidEnv,
        NODE_ENV: 'test',
        INNGEST_DEV: '1',
      });
      expect(error).toBeUndefined();
    });
  });

  // ─── Business timezone for promotion date-range normalization ─
  // Optional, defaults to America/Mexico_City. Used by PromotionsService
  // to compute the start-of-day / end-of-day boundaries for the
  // `startDate` / `endDate` columns. Optional everywhere — a tenant
  // can stay on the default. The key never changes the fail-closed
  // posture of any other gate.
  describe('PROMOTIONS_BUSINESS_TIMEZONE (optional — default America/Mexico_City)', () => {
    it('accepts an unset value (defaults to America/Mexico_City)', () => {
      const { error, value } = validate({
        ...baseValidEnv,
        NODE_ENV: 'production',
        INNGEST_SIGNING_KEY: 'sk',
        INNGEST_EVENT_KEY: 'ek',
        RESEND_API_KEY: 're',
        MAIL_FROM: 'Alerts <alerts@example.com>',
        APP_WEB_URL: 'https://app.example.com',
      });
      expect(error).toBeUndefined();
      // Joi honors `.default(...)` on optional keys — when the env var
      // is absent the schema populates the default.
      expect(value.PROMOTIONS_BUSINESS_TIMEZONE).toBe('America/Mexico_City');
    });

    it('accepts a custom IANA zone override', () => {
      const { error, value } = validate({
        ...baseValidEnv,
        NODE_ENV: 'production',
        INNGEST_SIGNING_KEY: 'sk',
        INNGEST_EVENT_KEY: 'ek',
        RESEND_API_KEY: 're',
        MAIL_FROM: 'Alerts <alerts@example.com>',
        APP_WEB_URL: 'https://app.example.com',
        PROMOTIONS_BUSINESS_TIMEZONE: 'America/New_York',
      });
      expect(error).toBeUndefined();
      expect(value.PROMOTIONS_BUSINESS_TIMEZONE).toBe('America/New_York');
    });

    it('accepts UTC as a valid override', () => {
      const { error, value } = validate({
        ...baseValidEnv,
        NODE_ENV: 'production',
        INNGEST_SIGNING_KEY: 'sk',
        INNGEST_EVENT_KEY: 'ek',
        RESEND_API_KEY: 're',
        MAIL_FROM: 'Alerts <alerts@example.com>',
        APP_WEB_URL: 'https://app.example.com',
        PROMOTIONS_BUSINESS_TIMEZONE: 'UTC',
      });
      expect(error).toBeUndefined();
      expect(value.PROMOTIONS_BUSINESS_TIMEZONE).toBe('UTC');
    });

    it('rejects an empty string (a typo must NOT silently fall back to the default)', () => {
      // Joi.string() rejects '' by default. Without explicit handling,
      // an unset/empty config could mask a misconfigured env.
      const { error } = validate({
        ...baseValidEnv,
        NODE_ENV: 'development',
        PROMOTIONS_BUSINESS_TIMEZONE: '',
      });
      expect(error).toBeDefined();
      expect(
        error!.details.some((d) =>
          d.path.includes('PROMOTIONS_BUSINESS_TIMEZONE'),
        ),
      ).toBe(true);
    });
  });
});
