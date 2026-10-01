import { normalizeTestDatabaseUrl } from '../../../test/integration/setup/test-database-url';

describe('integration database target guard (offline)', () => {
  const localTestUrl =
    'postgresql://admin:secret@localhost:5433/nest-practice-test?schema=public';

  it('normalizes the dedicated loopback test DB without changing its identity', () => {
    expect(normalizeTestDatabaseUrl(localTestUrl, '[test]')).toBe(
      'postgresql://admin:secret@127.0.0.1:5433/nest-practice-test?schema=public',
    );
  });

  it('allows a named test DB on a separate CI host', () => {
    expect(
      normalizeTestDatabaseUrl(
        'postgresql://admin:secret@postgres-test:5432/nest-practice-test',
        '[test]',
      ),
    ).toContain('@postgres-test:5432/nest-practice-test');
  });

  it.each([
    [
      'wrong name on dev port',
      'postgresql://admin:secret@127.0.0.1:5432/nest-practice',
    ],
    [
      'wrong name on test port',
      'postgresql://admin:secret@127.0.0.1:5433/other',
    ],
    [
      'wrong name on remote host',
      'postgresql://admin:secret@postgres-test:5432/production',
    ],
    [
      'non-PostgreSQL protocol',
      'http://admin:secret@127.0.0.1:5433/nest-practice-test',
    ],
    [
      'test name on dev port',
      'postgresql://admin:secret@127.0.0.1:5432/nest-practice-test',
    ],
    [
      'test name without a loopback port',
      'postgresql://admin:secret@localhost/nest-practice-test',
    ],
  ])('rejects %s without exposing credentials', (_, url) => {
    expect(() => normalizeTestDatabaseUrl(url, '[test]')).toThrow();
    try {
      normalizeTestDatabaseUrl(url, '[test]');
    } catch (error) {
      expect((error as Error).message).not.toContain('secret');
    }
  });

  it('rejects a missing or malformed URL', () => {
    expect(() => normalizeTestDatabaseUrl(undefined, '[test]')).toThrow(
      'DATABASE_URL is unset',
    );
    expect(() => normalizeTestDatabaseUrl('not-a-url', '[test]')).toThrow(
      'not a valid connection URL',
    );
  });

  // Triangulation: the new strict RESTOCK guard must not narrow the legacy
  // target. The legacy `postgres:` protocol alias stays accepted and only
  // the ambiguous `localhost` host is rewritten.
  it('still accepts the legacy postgres:// alias and rewrites only localhost', () => {
    expect(
      normalizeTestDatabaseUrl(
        'postgres://admin:secret@localhost:5433/nest-practice-test',
        '[test]',
      ),
    ).toBe('postgres://admin:secret@127.0.0.1:5433/nest-practice-test');
  });
});

describe('isolated RESTOCK database target guard (offline)', () => {
  const restockTestUrl =
    'postgresql://admin:secret@127.0.0.1:5433/nest-practice-restock-test?schema=public';

  it('accepts only the exact RESTOCK tuple with credentials and query preserved', () => {
    expect(normalizeTestDatabaseUrl(restockTestUrl, '[test]')).toBe(
      restockTestUrl,
    );
  });

  // Triangulation: the query string is optional; the tuple without one is
  // still the accepted target, returned verbatim.
  it('accepts the exact RESTOCK tuple without a query string', () => {
    expect(
      normalizeTestDatabaseUrl(
        'postgresql://admin:secret@127.0.0.1:5433/nest-practice-restock-test',
        '[test]',
      ),
    ).toBe(
      'postgresql://admin:secret@127.0.0.1:5433/nest-practice-restock-test',
    );
  });

  it.each([
    [
      'a remote host',
      'postgresql://admin:secret@postgres-test:5433/nest-practice-restock-test',
    ],
    [
      'the dev port',
      'postgresql://admin:secret@127.0.0.1:5432/nest-practice-restock-test',
    ],
    [
      'a wrong loopback port',
      'postgresql://admin:secret@127.0.0.1:5434/nest-practice-restock-test',
    ],
    [
      'a missing port',
      'postgresql://admin:secret@127.0.0.1/nest-practice-restock-test',
    ],
    [
      'the localhost alias',
      'postgresql://admin:secret@localhost:5433/nest-practice-restock-test',
    ],
    [
      'the IPv6 loopback host',
      'postgresql://admin:secret@[::1]:5433/nest-practice-restock-test',
    ],
    [
      'the postgres protocol alias',
      'postgres://admin:secret@127.0.0.1:5433/nest-practice-restock-test',
    ],
    [
      'a non-PostgreSQL protocol',
      'http://admin:secret@127.0.0.1:5433/nest-practice-restock-test',
    ],
    [
      'a wrong database name',
      'postgresql://admin:secret@127.0.0.1:5433/nest-practice-restock-typo',
    ],
  ])(
    'rejects the RESTOCK tuple on %s without exposing credentials',
    (_, url) => {
      expect(() => normalizeTestDatabaseUrl(url, '[test]')).toThrow();
      try {
        normalizeTestDatabaseUrl(url, '[test]');
      } catch (error) {
        expect((error as Error).message).not.toContain('secret');
      }
    },
  );
});
