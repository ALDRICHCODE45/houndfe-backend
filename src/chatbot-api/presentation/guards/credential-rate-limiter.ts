export type RateLimitDecision = {
  allowed: boolean;
  retryAfterMs: number;
};

type CredentialRateLimitCheck = {
  credentialId: string;
  limit: number;
  now?: Date;
};

type CredentialRateLimiterOptions = {
  windowMs?: number;
};

const DEFAULT_WINDOW_MS = 60_000;

export class CredentialRateLimiter {
  private readonly windowMs: number;

  private readonly attempts = new Map<string, number[]>();

  constructor(options: CredentialRateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  }

  check(input: CredentialRateLimitCheck): RateLimitDecision {
    const nowMs = (input.now ?? new Date()).getTime();
    const windowStart = nowMs - this.windowMs;
    const activeAttempts = (this.attempts.get(input.credentialId) ?? []).filter(
      (attemptedAt) => attemptedAt > windowStart,
    );

    if (activeAttempts.length >= input.limit) {
      const oldestAttempt = activeAttempts[0] ?? nowMs;
      return {
        allowed: false,
        retryAfterMs: Math.max(0, oldestAttempt + this.windowMs - nowMs),
      };
    }

    activeAttempts.push(nowMs);
    this.attempts.set(input.credentialId, activeAttempts);

    return { allowed: true, retryAfterMs: 0 };
  }
}
