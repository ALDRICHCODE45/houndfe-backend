import { CredentialRateLimiter } from './credential-rate-limiter';

describe('CredentialRateLimiter', () => {
  it('allows requests while the credential remains under its sliding-window limit', () => {
    const limiter = new CredentialRateLimiter({ windowMs: 60_000 });

    const firstAttempt = limiter.check({
      credentialId: 'cred-1',
      limit: 2,
      now: new Date('2026-06-11T12:00:00.000Z'),
    });
    const secondAttempt = limiter.check({
      credentialId: 'cred-1',
      limit: 2,
      now: new Date('2026-06-11T12:00:10.000Z'),
    });

    expect(firstAttempt).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(secondAttempt).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it('rejects requests that exceed the credential limit inside the active window', () => {
    const limiter = new CredentialRateLimiter({ windowMs: 60_000 });

    limiter.check({
      credentialId: 'cred-1',
      limit: 2,
      now: new Date('2026-06-11T12:00:00.000Z'),
    });
    limiter.check({
      credentialId: 'cred-1',
      limit: 2,
      now: new Date('2026-06-11T12:00:10.000Z'),
    });

    const blockedAttempt = limiter.check({
      credentialId: 'cred-1',
      limit: 2,
      now: new Date('2026-06-11T12:00:20.000Z'),
    });

    expect(blockedAttempt.allowed).toBe(false);
    expect(blockedAttempt.retryAfterMs).toBe(40_000);
  });

  it('expires older requests so the credential can resume after the window resets', () => {
    const limiter = new CredentialRateLimiter({ windowMs: 60_000 });

    limiter.check({
      credentialId: 'cred-1',
      limit: 1,
      now: new Date('2026-06-11T12:00:00.000Z'),
    });

    const resumedAttempt = limiter.check({
      credentialId: 'cred-1',
      limit: 1,
      now: new Date('2026-06-11T12:01:01.000Z'),
    });

    expect(resumedAttempt).toEqual({ allowed: true, retryAfterMs: 0 });
  });
});
