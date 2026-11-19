/**
 * editorial-live harness — offline guard wiring checks (no DB, no Nest).
 *
 * The guard LOGIC is cash-live's (imported, not copied); these checks prove
 * the editorial profile wires it to its OWN disposable target and env names.
 */
import * as path from 'node:path';
import {
  EDITORIAL_LIVE_DATABASE_PROFILE,
  EDITORIAL_LIVE_DB_NAME,
  EDITORIAL_LIVE_DB_USER,
  EDITORIAL_LIVE_DEFAULT_FIXTURE_PATH,
  checkEditorialDisposableDatabase,
  loadEditorialLiveConfig,
} from './editorial-env';
import {
  DISPOSABLE_DB_NAME,
  DISPOSABLE_DB_USER,
} from '../cash-live/disposable-env';

const url = (
  port = '55440',
  user = EDITORIAL_LIVE_DB_USER,
  db = EDITORIAL_LIVE_DB_NAME,
) => `postgresql://${user}:s3cr3t-pw@127.0.0.1:${port}/${db}`;

const env = (overrides: Record<string, string | undefined> = {}) =>
  ({
    EDITORIAL_LIVE_DISPOSABLE: '1',
    DATABASE_URL: url(),
    EDITORIAL_LIVE_DATABASE_URL: url(),
    ...overrides,
  }) as NodeJS.ProcessEnv;

describe('editorial-live disposable database guard', () => {
  it('uses its own database name and user (never cash-live)', () => {
    expect(EDITORIAL_LIVE_DB_NAME).toBe('editorial_live_test');
    expect(EDITORIAL_LIVE_DB_USER).toBe('editorial_live');
    expect(EDITORIAL_LIVE_DATABASE_PROFILE.flagName).toBe(
      'EDITORIAL_LIVE_DISPOSABLE',
    );
    expect(EDITORIAL_LIVE_DATABASE_PROFILE.urlEnvName).toBe(
      'EDITORIAL_LIVE_DATABASE_URL',
    );
    expect(Object.isFrozen(EDITORIAL_LIVE_DATABASE_PROFILE)).toBe(true);
  });

  it('accepts the exact editorial disposable target on a dedicated port', () => {
    expect(checkEditorialDisposableDatabase(env())).toEqual({ ok: true });
  });

  it.each(['5432', '5433', '5434'])('always rejects port %s', (port) => {
    const result = checkEditorialDisposableDatabase(
      env({ DATABASE_URL: url(port), EDITORIAL_LIVE_DATABASE_URL: url(port) }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects the cash-live target, opt-in and URL env names', () => {
    const cashUrl = url('55440', DISPOSABLE_DB_USER, DISPOSABLE_DB_NAME);
    expect(
      checkEditorialDisposableDatabase(
        env({ DATABASE_URL: cashUrl, EDITORIAL_LIVE_DATABASE_URL: cashUrl }),
      ).ok,
    ).toBe(false);
    expect(
      checkEditorialDisposableDatabase(
        env({
          EDITORIAL_LIVE_DISPOSABLE: undefined,
          CASH_LIVE_DISPOSABLE: '1',
        }),
      ).ok,
    ).toBe(false);
    expect(
      checkEditorialDisposableDatabase(
        env({
          EDITORIAL_LIVE_DATABASE_URL: undefined,
          CASH_LIVE_DATABASE_URL: url(),
        }),
      ).ok,
    ).toBe(false);
  });

  it.each([
    ['a mismatched pair', { EDITORIAL_LIVE_DATABASE_URL: url('55441') }],
    [
      'a query string',
      {
        DATABASE_URL: `${url()}?host=/tmp`,
        EDITORIAL_LIVE_DATABASE_URL: `${url()}?host=/tmp`,
      },
    ],
    [
      'a non-loopback host',
      {
        DATABASE_URL: url().replace('127.0.0.1', '10.0.0.5'),
        EDITORIAL_LIVE_DATABASE_URL: url().replace('127.0.0.1', '10.0.0.5'),
      },
    ],
    ['a flag other than "1"', { EDITORIAL_LIVE_DISPOSABLE: 'true' }],
  ])('rejects %s and never echoes the password', (_, overrides) => {
    const result = checkEditorialDisposableDatabase(env(overrides));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const text = result.reasons.join('\n');
      expect(text).not.toContain('s3cr3t-pw');
      expect(text).not.toContain('postgresql://');
    }
  });

  it('names the editorial env variables in its reasons', () => {
    const result = checkEditorialDisposableDatabase({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const text = result.reasons.join('\n');
      expect(text).toContain('EDITORIAL_LIVE_DISPOSABLE');
      expect(text).toContain('EDITORIAL_LIVE_DATABASE_URL');
      expect(text).not.toContain('CASH_LIVE');
    }
  });
});

describe('editorial-live harness config', () => {
  const root = process.cwd();

  it('defaults: FE origin http://127.0.0.1:4191 and a repo-contained fixture', () => {
    const config = loadEditorialLiveConfig({});
    expect(EDITORIAL_LIVE_DEFAULT_FIXTURE_PATH).toBe(
      '.tmp/editorial-live/fixture.json',
    );
    expect(config.frontendOrigin).toBe('http://127.0.0.1:4191');
    expect(config.fixturePath).toBe(
      path.resolve(root, '.tmp/editorial-live/fixture.json'),
    );
    expect(config.jwtSecretFromEnv).toBe(false);
    expect(config.jwtSecret.length).toBeGreaterThanOrEqual(32);
    expect(config.accessTokenTtlSeconds).toBe(7200);
  });

  it('reads EDITORIAL_LIVE_* names only (CASH_LIVE_* is ignored)', () => {
    const config = loadEditorialLiveConfig({
      EDITORIAL_LIVE_FRONTEND_ORIGIN: 'http://127.0.0.1:5199',
      CASH_LIVE_FRONTEND_ORIGIN: 'http://127.0.0.1:4189',
      EDITORIAL_LIVE_FIXTURE_PATH: '.tmp/editorial-live/other.json',
      EDITORIAL_LIVE_JWT_SECRET: 'x'.repeat(40),
      CASH_LIVE_ACCESS_TTL_SECONDS: '61',
      EDITORIAL_LIVE_ACCESS_TTL_SECONDS: '600',
    });
    expect(config.frontendOrigin).toBe('http://127.0.0.1:5199');
    expect(config.fixturePath).toBe(
      path.resolve(root, '.tmp/editorial-live/other.json'),
    );
    expect(config.jwtSecretFromEnv).toBe(true);
    expect(config.accessTokenTtlSeconds).toBe(600);
  });

  it.each([
    [
      { EDITORIAL_LIVE_FRONTEND_ORIGIN: 'https://example.com:4189' },
      'EDITORIAL_LIVE_FRONTEND_ORIGIN',
    ],
    [
      { EDITORIAL_LIVE_FRONTEND_ORIGIN: 'http://127.0.0.1' },
      'EDITORIAL_LIVE_FRONTEND_ORIGIN',
    ],
    [
      { EDITORIAL_LIVE_FIXTURE_PATH: '../outside.json' },
      'EDITORIAL_LIVE_FIXTURE_PATH',
    ],
    [
      { EDITORIAL_LIVE_FIXTURE_PATH: '/etc/fixture.json' },
      'EDITORIAL_LIVE_FIXTURE_PATH',
    ],
    [
      { EDITORIAL_LIVE_ACCESS_TTL_SECONDS: '5' },
      'EDITORIAL_LIVE_ACCESS_TTL_SECONDS',
    ],
  ])('rejects %p naming %s', (input, name) => {
    expect(() => loadEditorialLiveConfig(input)).toThrow(name);
  });

  it('ignores a short EDITORIAL_LIVE_JWT_SECRET (generates one instead)', () => {
    const config = loadEditorialLiveConfig({
      EDITORIAL_LIVE_JWT_SECRET: 'short',
    });
    expect(config.jwtSecretFromEnv).toBe(false);
    expect(config.jwtSecret).not.toBe('short');
  });
});
