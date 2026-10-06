import {
  assertMatchesIsolatedTarget,
  createIsolatedDatabaseGuard,
} from '../../../test/integration/setup/assert-isolated-human-decisions-database';

const ISOLATED_URL =
  'postgresql://admin:secret@127.0.0.1:5433/nest-practice-restock-test';
const FILE_WITH_ISOLATED = `DATABASE_URL=${ISOLATED_URL}\n`;

function makeGuard(fileEnvText: string, activeUrl: string | undefined) {
  const reset = jest.fn(() => Promise.resolve());
  const log = jest.fn<void, [message: string]>();
  const guard = createIsolatedDatabaseGuard({
    readEnvTestFile: () => fileEnvText,
    readActiveUrl: () => activeUrl,
    reset,
    log,
  });
  return { guard, reset, log };
}

/** Run `assertTarget`-style work and return the thrown message. */
function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the guard to throw');
}

describe('isolated human-decisions database guard (offline)', () => {
  it('accepts the exact tuple for BOTH sources and delegates the guarded reset', async () => {
    const { guard, reset, log } = makeGuard(FILE_WITH_ISOLATED, ISOLATED_URL);

    expect(guard.skip).toBe(false);
    expect(() => guard.assertTarget()).not.toThrow();

    await guard.resetBaseline();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain(
      'postgresql://127.0.0.1:5433/nest-practice-restock-test',
    );
  });

  it('accepts only the exact tuple and never echoes credentials', () => {
    expect(() =>
      assertMatchesIsolatedTarget(`${ISOLATED_URL}?schema=public`, 'active'),
    ).not.toThrow();
  });

  it('does not read the env file or reset until a guard method is invoked', () => {
    const readEnvTestFile = jest.fn(() => FILE_WITH_ISOLATED);
    const reset = jest.fn(() => Promise.resolve());
    const guard = createIsolatedDatabaseGuard({
      readEnvTestFile,
      readActiveUrl: () => ISOLATED_URL,
      reset,
      log: jest.fn(),
    });

    expect(readEnvTestFile).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    guard.assertTarget();
    expect(readEnvTestFile).toHaveBeenCalledTimes(1);
  });

  it('reports the suite as skipped when the active URL is unset', () => {
    expect(makeGuard(FILE_WITH_ISOLATED, undefined).guard.skip).toBe(true);
  });

  const REJECTED: Array<[string, string]> = [
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
  ];

  it.each(REJECTED)('rejects %s redacted on the ACTIVE source', (_, url) => {
    const message = messageOf(() => assertMatchesIsolatedTarget(url, 'active'));
    expect(message).not.toContain('secret');
    expect(message).not.toContain(url);
  });

  it.each(REJECTED)(
    'fails redacted before reset on %s for BOTH sources',
    async (_, url) => {
      // ACTIVE source invalid, `.env.test` valid.
      const active = makeGuard(FILE_WITH_ISOLATED, url);
      expect(messageOf(() => active.guard.assertTarget())).not.toContain(
        'secret',
      );
      expect(active.reset).not.toHaveBeenCalled();
      await expect(active.guard.resetBaseline()).rejects.toThrow();
      expect(active.reset).not.toHaveBeenCalled();

      // `.env.test` invalid, ACTIVE source valid.
      const file = makeGuard(`DATABASE_URL=${url}\n`, ISOLATED_URL);
      expect(messageOf(() => file.guard.assertTarget())).not.toContain(
        'secret',
      );
      expect(file.reset).not.toHaveBeenCalled();
      await expect(file.guard.resetBaseline()).rejects.toThrow();
      expect(file.reset).not.toHaveBeenCalled();
    },
  );

  it('rejects an unset file URL and an unset active URL before any reset', () => {
    const noFile = makeGuard('', ISOLATED_URL);
    expect(messageOf(() => noFile.guard.assertTarget())).toContain('unset');
    expect(noFile.reset).not.toHaveBeenCalled();

    const noActive = makeGuard(FILE_WITH_ISOLATED, undefined);
    expect(messageOf(() => noActive.guard.assertTarget())).toContain('unset');
    expect(noActive.reset).not.toHaveBeenCalled();
  });

  it('rejects a malformed URL before any reset', () => {
    const { guard, reset } = makeGuard(FILE_WITH_ISOLATED, 'not-a-url');
    expect(messageOf(() => guard.assertTarget())).toContain('not a valid URL');
    expect(reset).not.toHaveBeenCalled();
  });
});
