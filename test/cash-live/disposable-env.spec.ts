/**
 * cash-live harness — deterministic offline unit checks.
 *
 * Pure guard functions only: no DB, no Nest, no server start, no .env.
 * Run with:
 *   npx jest --config jest.config.js --roots test/cash-live
 */
import {
  checkDisposableDatabaseUrl,
  checkDeniedExternalEnv,
  resolveFixturePathWithinRoot,
  validateLoopbackHttpOrigin,
  DEFAULT_FRONTEND_ORIGIN,
  DEFAULT_FIXTURE_PATH,
  DISPOSABLE_DB_NAME,
  DISPOSABLE_DB_USER,
} from './disposable-env';

const goodUrl = `postgresql://${DISPOSABLE_DB_USER}:pw@127.0.0.1:5544/${DISPOSABLE_DB_NAME}`;

function guardInput(overrides: {
  disposableFlag?: string;
  databaseUrl?: string;
  cashLiveDatabaseUrl?: string;
}) {
  const merged = {
    disposableFlag: '1',
    databaseUrl: goodUrl,
    cashLiveDatabaseUrl: goodUrl,
    ...overrides,
  };
  // Every negative case except the explicit-mismatch test must present the
  // SAME (invalid) URL on BOTH env vars, so the asserted failure is the
  // component rule under test — never the pair-identity reason.
  if (overrides.cashLiveDatabaseUrl === undefined) {
    merged.cashLiveDatabaseUrl = merged.databaseUrl;
  }
  return merged;
}

describe('checkDisposableDatabaseUrl', () => {
  it('accepts the exact disposable target on a non-shared port', () => {
    expect(checkDisposableDatabaseUrl(guardInput({}))).toEqual({ ok: true });
  });

  it('rejects a missing opt-in flag', () => {
    const result = checkDisposableDatabaseUrl(
      guardInput({ disposableFlag: '0' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.reasons.join(' ')).toContain('CASH_LIVE_DISPOSABLE');
  });

  it('rejects unset DATABASE_URL', () => {
    const result = checkDisposableDatabaseUrl(
      guardInput({ databaseUrl: undefined }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects when DATABASE_URL and CASH_LIVE_DATABASE_URL differ', () => {
    const result = checkDisposableDatabaseUrl(
      guardInput({ cashLiveDatabaseUrl: goodUrl.replace('5544', '5545') }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons.join(' ')).toContain('identical URL');
    }
  });

  it('rejects the shared dev port 5432 and the integration port 5433', () => {
    for (const port of ['5432', '5433']) {
      const result = checkDisposableDatabaseUrl(
        guardInput({ databaseUrl: goodUrl.replace('5544', port) }),
      );
      expect(result.ok).toBe(false);
    }
  });

  it('rejects a wrong host, user, or database name', () => {
    const wrongHost = checkDisposableDatabaseUrl(
      guardInput({ databaseUrl: goodUrl.replace('127.0.0.1', '10.0.0.5') }),
    );
    const wrongUser = checkDisposableDatabaseUrl(
      guardInput({
        databaseUrl: goodUrl.replace(`${DISPOSABLE_DB_USER}:`, 'other:'),
      }),
    );
    const wrongDb = checkDisposableDatabaseUrl(
      guardInput({
        databaseUrl: goodUrl.replace(DISPOSABLE_DB_NAME, 'houndfe'),
      }),
    );
    expect(wrongHost.ok).toBe(false);
    expect(wrongUser.ok).toBe(false);
    expect(wrongDb.ok).toBe(false);
  });

  it('rejects ANY query parameters (host/schema/ssl override vectors)', () => {
    for (const query of [
      '?schema=public',
      '?host=attacker.example',
      '?sslmode=require',
      '?application_name=x',
    ]) {
      const result = checkDisposableDatabaseUrl(
        guardInput({ databaseUrl: `${goodUrl}${query}` }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reasons.join(' ')).toContain('query');
        // Component failure, not the pair-identity rule.
        expect(result.reasons.join(' ')).not.toContain('identical URL');
      }
    }
  });

  it('rejects URL fragments', () => {
    const result = checkDisposableDatabaseUrl(
      guardInput({ databaseUrl: `${goodUrl}#fragment` }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join(' ')).toContain('fragment');
  });

  it('reports a parse failure (not a mismatch) for identical invalid URLs', () => {
    const result = checkDisposableDatabaseUrl(
      guardInput({ databaseUrl: 'not-a-url', cashLiveDatabaseUrl: 'not-a-url' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons.join(' ')).toContain('not a parseable URL');
      expect(result.reasons.join(' ')).not.toContain('identical URL');
    }
  });

  it('rejects a missing port and a non-postgresql protocol', () => {
    const noPort = checkDisposableDatabaseUrl(
      guardInput({
        databaseUrl: `postgresql://${DISPOSABLE_DB_USER}:pw@127.0.0.1/${DISPOSABLE_DB_NAME}`,
      }),
    );
    const wrongProtocol = checkDisposableDatabaseUrl(
      guardInput({ databaseUrl: goodUrl.replace('postgresql:', 'mysql:') }),
    );
    expect(noPort.ok).toBe(false);
    expect(wrongProtocol.ok).toBe(false);
  });

  it('never leaks the password in rejection reasons', () => {
    const secretUrl =
      'postgresql://cash_proof:super-secret-pw@10.9.8.7:5432/prod';
    const result = checkDisposableDatabaseUrl({
      disposableFlag: '1',
      databaseUrl: secretUrl,
      cashLiveDatabaseUrl: secretUrl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const reason of result.reasons) {
        expect(reason).not.toContain('super-secret-pw');
        expect(reason).not.toContain('postgresql://');
      }
    }
  });
});

describe('checkDeniedExternalEnv', () => {
  it('accepts a minimal env with no external service credentials', () => {
    expect(checkDeniedExternalEnv({})).toEqual({ ok: true });
  });

  it.each([
    'RESEND_API_KEY',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'INNGEST_EVENT_API_KEY',
    'INNGEST_SIGNING_KEY',
  ])('rejects an inherited %s before module compile', (key) => {
    const result = checkDeniedExternalEnv({ [key]: 'super-secret-value' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reasons.join(' ')).toContain(key);
      // The VALUE must never be echoed.
      expect(result.reasons.join(' ')).not.toContain('super-secret-value');
    }
  });
});

describe('validateLoopbackHttpOrigin', () => {
  it('accepts the default loopback origin with an explicit port', () => {
    expect(validateLoopbackHttpOrigin(DEFAULT_FRONTEND_ORIGIN)).toBe(
      'http://127.0.0.1:4189',
    );
  });

  it('accepts any loopback host with an explicit numeric port', () => {
    expect(validateLoopbackHttpOrigin('http://[::1]:3000')).toBe(
      'http://[::1]:3000',
    );
  });

  it('rejects non-loopback hosts, missing ports, and non-http schemes', () => {
    expect(() =>
      validateLoopbackHttpOrigin('https://example.com:4189'),
    ).toThrow();
    expect(() => validateLoopbackHttpOrigin('http://127.0.0.1')).toThrow();
    expect(() => validateLoopbackHttpOrigin('ftp://127.0.0.1:4189')).toThrow();
    expect(() => validateLoopbackHttpOrigin('not-a-url')).toThrow();
  });
});

describe('resolveFixturePathWithinRoot', () => {
  const root = '/repo/root';

  it('defaults to the repository-contained fixture path', () => {
    expect(resolveFixturePathWithinRoot(undefined, root)).toBe(
      `${root}/${DEFAULT_FIXTURE_PATH}`,
    );
  });

  it('accepts nested paths inside the root', () => {
    expect(resolveFixturePathWithinRoot('.tmp/cash-live/f.json', root)).toBe(
      `${root}/.tmp/cash-live/f.json`,
    );
  });

  it('rejects traversal outside the root', () => {
    expect(() =>
      resolveFixturePathWithinRoot('../../etc/passwd', root),
    ).toThrow();
    expect(() => resolveFixturePathWithinRoot('/etc/passwd', root)).toThrow();
    expect(() => resolveFixturePathWithinRoot('.', root)).toThrow();
  });
});
