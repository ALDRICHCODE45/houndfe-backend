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
});
