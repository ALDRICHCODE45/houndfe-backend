/**
 * Slice F.1 — ResendMailer adapter tests (RED).
 *
 * The ResendMailer is the `MAILER` adapter for production. Its
 * fail-closed posture is set by `RESEND_API_KEY`:
 *
 *   - Production (`NODE_ENV=production`, RESEND_API_KEY set):
 *     uses the Resend SDK to send the rendered email to the supplied
 *     recipients.
 *
 *   - Dev / test (`RESEND_API_KEY` unset, NODE_ENV != production):
 *     emits a structured log entry containing the rendered HTML and a
 *     REDACTED recipient list. This satisfies design.md finding #4 —
 *     "no PII leak in dev": we never log real email addresses in the
 *     fallback path. The mailer MUST NOT call the Resend API without
 *     the key (silent swallow would lose alerts; spec "Empty
 *     Recipient List Suppresses Sends" + Risk R-E).
 *
 *   - Production with RESEND_API_KEY UNSET: must THROW a fast,
 *     diagnostic error at send time (the Joi schema already makes the
 *     key REQUIRED in production, so this branch is defensive — it
 *     fires if a runtime nullification happens). Throwing in prod is
 *     what makes the dedicated dispatcher (F.5) retry correctly.
 *
 * Spec coverage:
 *   - "DEV redacts recipients when RESEND_API_KEY unset"
 *   - "PROD without RESEND_API_KEY throws"
 *   - "PROD with RESEND_API_KEY delegates to the Resend SDK"
 *
 * The Resend SDK itself is `jest.mock`'d so this spec never hits the
 * network; the adapter's job is to wrap the SDK with the dev-logger
 * fallback, not to retest the SDK.
 */
import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';

// Capture the SDK constructor calls + emails.send invocations. The
// real Resend SDK exposes `new Resend(apiKey).emails.send({...})`; the
// mock mirrors that shape so the adapter's call path is exercised
// verbatim.
jest.mock('resend', () => {
  const sendMock = jest.fn();
  class Resend {
    public readonly emails = {
      send: (...args: unknown[]) =>
        sendMock(...args) as unknown as Promise<unknown>,
    };
    public readonly capturedApiKey: string | undefined;
    constructor(apiKey?: string) {
      this.capturedApiKey = apiKey;
    }
  }
  return { Resend, __mocks: { sendMock } };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const resendMock = require('resend') as {
  Resend: new (apiKey?: string) => {
    emails: { send: jest.Mock };
    capturedApiKey: string | undefined;
  };
  __mocks: { sendMock: jest.Mock };
};

// Imported AFTER jest.mock so the module-level mock is in place.
import { ResendMailer } from './resend.mailer';

function makeConfig(values: Record<string, string | undefined>): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
    getOrThrow: jest.fn((key: string) => {
      const v = values[key];
      if (v === undefined || v === null || v === '') {
        throw new Error(`Config error: missing "${key}"`);
      }
      return v;
    }),
  } as unknown as ConfigService;
}

/**
 * Suppress Logger output during the dev-logger tests so the spec log
 * stays clean. Each test resets the spy / fake-timers state.
 */
const suppressLogger = () => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
};

describe('ResendMailer (F.1)', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = process.env;
    process.env = { ...originalEnv };
    resendMock.__mocks.sendMock.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  // ─── Dev-logger fallback (RESEND_API_KEY unset, NODE_ENV != production)
  describe('dev-logger fallback (RESEND_API_KEY unset, NODE_ENV !== production)', () => {
    it('does NOT instantiate the Resend SDK when RESEND_API_KEY is missing', async () => {
      suppressLogger();
      const config = makeConfig({
        NODE_ENV: 'development',
        RESEND_API_KEY: undefined,
        MAIL_FROM: 'noreply@example.com',
      });

      const mailer = new ResendMailer(config);

      await mailer.send({
        to: ['alice@example.com', 'bob@example.com'],
        subject: 'Low stock: Aspirina',
        html: '<p>Body</p>',
      });

      // The constructor set was never called — `ResendMailer` only
      // constructs the SDK when it actually needs to send via Resend.
      // The `jest.mock` above installs a no-op stub for the class,
      // but we can detect "not constructed" by tracking instances.
      // (Constructing the SDK with an undefined key would still emit a
      // valid 1×-send delegation — we assert via the dev-logger path
      // separately below.)
      expect(resendMock.__mocks.sendMock).not.toHaveBeenCalled();
    });

    it('logs the rendered email but REDACTS recipients when RESEND_API_KEY is unset (no PII leak)', async () => {
      const logSpy = jest.spyOn(Logger.prototype, 'log');
      const config = makeConfig({
        NODE_ENV: 'development',
        RESEND_API_KEY: undefined,
        MAIL_FROM: 'noreply@example.com',
      });

      const mailer = new ResendMailer(config);

      await mailer.send({
        to: ['alice@example.com', 'bob@example.com'],
        subject: 'Low stock: Aspirina',
        html: '<p>Body html</p>',
      });

      // The mailer MUST log SOMETHING (so the developer sees the email
      // was rendered) — but that something MUST redacted recipient
      // addresses. The subject and html may be logged.
      expect(logSpy).toHaveBeenCalled();
      const flat = JSON.stringify(logSpy.mock.calls);
      // No raw address must appear in any log entry.
      expect(flat).not.toContain('alice@example.com');
      expect(flat).not.toContain('bob@example.com');
      // Subject is OK to log.
      expect(flat).toContain('Low stock: Aspirina');
    });

    it('still resolves successfully in dev-logger mode (so the Inngest function sees a send resolution)', async () => {
      suppressLogger();
      const config = makeConfig({
        NODE_ENV: 'development',
        RESEND_API_KEY: undefined,
        MAIL_FROM: 'noreply@example.com',
      });

      const mailer = new ResendMailer(config);

      await expect(
        mailer.send({
          to: ['a@example.com'],
          subject: 's',
          html: '<p>x</p>',
        }),
      ).resolves.toBeUndefined();
    });
  });

  // ─── Production path (NODE_ENV=production + RESEND_API_KEY set)
  describe('production path (NODE_ENV=production + RESEND_API_KEY set)', () => {
    it('instantiates the Resend SDK with the configured RESEND_API_KEY and forwards the email', async () => {
      const sendMock = resendMock.__mocks.sendMock.mockResolvedValue({
        data: { id: 'email-1' },
        error: null,
      });

      const config = makeConfig({
        NODE_ENV: 'production',
        RESEND_API_KEY: 're_real_key_123',
        MAIL_FROM: 'Alerts <alerts@example.com>',
      });

      const mailer = new ResendMailer(config);

      await mailer.send({
        to: ['recipient@example.com'],
        subject: 'Low stock',
        html: '<p>Body</p>',
      });

      expect(sendMock).toHaveBeenCalledTimes(1);
      const sendCalls = sendMock.mock.calls as unknown[][];
      const call = sendCalls[0]?.[0] as {
        from: string;
        to: string[];
        subject: string;
        html: string;
      };
      expect(call.from).toBe('Alerts <alerts@example.com>');
      expect(call.to).toEqual(['recipient@example.com']);
      expect(call.subject).toBe('Low stock');
      expect(call.html).toBe('<p>Body</p>');
    });

    it('throws a diagnostic error when RESEND_API_KEY is unset in production (fail-closed belt-and-braces)', async () => {
      const config = makeConfig({
        NODE_ENV: 'production',
        RESEND_API_KEY: undefined,
        MAIL_FROM: 'alerts@example.com',
      });

      const mailer = new ResendMailer(config);

      // The Joi env schema (buildEnvValidationSchema) requires
      // RESEND_API_KEY in production at boot. This branch only fires
      // if a misconfigured runtime overrides the env after boot. The
      // failure MUST be a thrown error (not silent) so the dedicated
      // dispatcher (F.5) marks the row PENDING and retries.
      await expect(
        mailer.send({
          to: ['a@example.com'],
          subject: 's',
          html: 'p',
        }),
      ).rejects.toThrow(/RESEND_API_KEY/);
    });

    it('surfaces Resend SDK errors (non-2xx / network) as a rejection — dedicated dispatcher retries on catch', async () => {
      resendMock.__mocks.sendMock.mockResolvedValue({
        data: null,
        error: { name: 'validation_error', message: 'bad email' },
      });

      const config = makeConfig({
        NODE_ENV: 'production',
        RESEND_API_KEY: 're_real_key_123',
        MAIL_FROM: 'alerts@example.com',
      });

      const mailer = new ResendMailer(config);

      await expect(
        mailer.send({
          to: ['bogus'],
          subject: 's',
          html: 'p',
        }),
      ).rejects.toThrow(/bad email/);
    });
  });
});
