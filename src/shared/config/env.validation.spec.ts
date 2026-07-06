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
      expect(error!.details.some((d) => d.path.includes('NODE_ENV'))).toBe(true);
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
        }
        const { error } = validate({ ...baseValidEnv, ...extras, NODE_ENV: env });
        expect(error).toBeUndefined();
      }
    });

    it('rejects an unknown NODE_ENV value', () => {
      const { error } = validate({ ...baseValidEnv, NODE_ENV: 'qa' });
      expect(error).toBeDefined();
      expect(error!.details.some((d) => d.path.includes('NODE_ENV'))).toBe(true);
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
      expect(error!.details.some((d) => d.path.includes('INNGEST_SIGNING_KEY'))).toBe(true);
    });

    it('is REQUIRED when NODE_ENV=staging (absent key ⇒ boot fails)', () => {
      const { error } = validate({
        ...baseValidEnv,
        NODE_ENV: 'staging',
        INNGEST_EVENT_KEY: 'evt_test',
      });
      expect(error).toBeDefined();
      expect(error!.details.some((d) => d.path.includes('INNGEST_SIGNING_KEY'))).toBe(true);
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
      expect(error!.details.some((d) => d.path.includes('INNGEST_SIGNING_KEY'))).toBe(true);
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
      expect(error!.details.some((d) => d.path.includes('INNGEST_EVENT_KEY'))).toBe(true);
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
      expect(error!.details.some((d) => d.path.includes('RESEND_API_KEY'))).toBe(true);
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
      expect(error!.details.some((d) => d.path.includes('DATABASE_URL'))).toBe(true);
    });

    it('still requires JWT_SECRET (min 32 chars)', () => {
      const { error } = validate({
        ...baseValidEnv,
        NODE_ENV: 'development',
        JWT_SECRET: 'short',
      });
      expect(error).toBeDefined();
      expect(error!.details.some((d) => d.path.includes('JWT_SECRET'))).toBe(true);
    });
  });

  describe('fail-closed composition (D.4 — Triangulation)', () => {
    it('a prod env missing ALL three keys surfaces ALL three in one shot (abortEarly:false)', () => {
      const { error } = validate({
        ...baseValidEnv,
        NODE_ENV: 'production',
      });
      expect(error).toBeDefined();
      const paths = error!.details.map((d) => d.path.join('.'));
      expect(paths).toContain('INNGEST_SIGNING_KEY');
      expect(paths).toContain('INNGEST_EVENT_KEY');
      expect(paths).toContain('RESEND_API_KEY');
    });

    it('a complete production env validates cleanly', () => {
      const { error, value } = validate({
        ...baseValidEnv,
        NODE_ENV: 'production',
        INNGEST_SIGNING_KEY: 'signkey-prod',
        INNGEST_EVENT_KEY: 'evt-prod',
        RESEND_API_KEY: 're-prod',
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
});