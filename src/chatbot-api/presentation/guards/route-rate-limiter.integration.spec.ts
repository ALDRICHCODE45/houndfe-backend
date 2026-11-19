/**
 * R2 against real PostgreSQL: the counters live in `service_rate_buckets`, so
 * two limiter instances (two replicas) share one budget per
 * (credential, route class), and the window is measured by the database clock
 * (a replica's clock never enters the decision).
 */
import { randomUUID } from 'crypto';
import { integrationPrisma } from '../../../../test/integration/reset-db';
import type { PrismaService } from '../../../shared/prisma/prisma.service';
import type { RateLimitDecision } from './credential-rate-limiter';
import type { BotRouteClassName } from './route-class';
import {
  DEFAULT_CLASS_LIMITS,
  PostgresRouteRateLimiter,
} from './route-rate-limiter';

const describeIfDb =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL
    ? describe.skip
    : describe;

describeIfDb('PostgresRouteRateLimiter (PostgreSQL)', () => {
  const prisma = integrationPrisma();
  const replicaA = new PostgresRouteRateLimiter(
    prisma as unknown as PrismaService,
  );
  const replicaB = new PostgresRouteRateLimiter(
    prisma as unknown as PrismaService,
  );
  const tenantId = randomUUID();
  let credentialId: string;
  const used: string[] = [];

  beforeEach(async () => {
    credentialId = randomUUID();
    used.push(credentialId);
    await prisma.serviceCredential.create({
      data: {
        id: credentialId,
        tenantId,
        name: 'bot',
        hashedKey: randomUUID(),
        scopes: ['requests:create'],
      },
    });
  });

  beforeAll(async () => {
    await prisma.tenant.create({
      data: { id: tenantId, name: 'Rate', slug: `rate-${tenantId}` },
    });
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
    await prisma.serviceRateBucket.deleteMany({
      where: { credentialId: { in: used } },
    });
  });

  const spend = (
    limiter: PostgresRouteRateLimiter,
    routeClass: BotRouteClassName,
    defaultLimit = 5,
  ) => limiter.check({ credentialId, routeClass, defaultLimit });

  /** Moves a bucket's window start back, as if it opened `seconds` ago. */
  const openedAgo = (routeClass: BotRouteClassName, seconds: number) =>
    prisma.$executeRaw`
      UPDATE "service_rate_buckets"
      SET "windowStart" = (now() AT TIME ZONE 'UTC') - make_interval(secs => ${seconds})
      WHERE "credentialId" = ${credentialId} AND "routeClass" = ${routeClass}`;

  const exhaust = async (
    limiter: PostgresRouteRateLimiter,
    routeClass: BotRouteClassName,
    limit: number,
  ) => {
    const decisions: RateLimitDecision[] = [];
    for (let i = 0; i < limit + 1; i++) {
      decisions.push(await spend(limiter, routeClass, limit));
    }
    return decisions;
  };

  it('shares one budget between two instances under concurrency', async () => {
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        spend(i % 2 ? replicaA : replicaB, 'default'),
      ),
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(results.filter((r) => !r.allowed)).toHaveLength(19);
  });

  it('answers Retry-After from the database clock and resets after the window', async () => {
    await exhaust(replicaA, 'default', 5);
    await openedAgo('default', 20);

    const blocked = await spend(replicaB, 'default');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(39_000);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(40_000);

    await openedAgo('default', 61);
    expect(await spend(replicaB, 'default')).toEqual({
      allowed: true,
      retryAfterMs: 0,
    });
  });

  it('ignores the replica clock: a skewed process decides the same', async () => {
    jest.useFakeTimers({
      now: new Date('2035-01-01T00:00:00.000Z'),
      doNotFake: [
        'nextTick',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
        'queueMicrotask',
        'performance',
        'hrtime',
      ],
    });
    try {
      const decisions = await exhaust(replicaA, 'write', 3);
      expect(decisions.map((d) => d.allowed)).toEqual([
        true,
        true,
        true,
        false,
      ]);
      expect(decisions[3].retryAfterMs).toBeGreaterThan(0);
      expect(decisions[3].retryAfterMs).toBeLessThanOrEqual(60_000);

      await openedAgo('write', 61);
      expect((await spend(replicaB, 'write', 3)).allowed).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps an independent bucket per route class', async () => {
    const feed = await exhaust(replicaA, 'feed', 5);
    expect(feed.map((d) => d.allowed)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);

    expect((await spend(replicaA, 'write')).allowed).toBe(true);
    expect((await spend(replicaB, 'default')).allowed).toBe(true);
  });

  it('keeps the human-decision routes and the other chatbot-api routes apart', async () => {
    const hd = await exhaust(replicaA, 'humanDecisions', 4);
    expect(hd.map((d) => d.allowed)).toEqual([true, true, true, true, false]);
    // exhausted `humanDecisions` does not touch `default` ...
    const other = await exhaust(replicaB, 'default', 4);
    expect(other.map((d) => d.allowed)).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);

    // ... and the other way round: a fresh credential spends `default` first
    credentialId = randomUUID();
    used.push(credentialId);
    await prisma.serviceCredential.create({
      data: {
        id: credentialId,
        tenantId,
        name: 'bot2',
        hashedKey: randomUUID(),
        scopes: ['requests:create'],
      },
    });
    await exhaust(replicaA, 'default', 4);
    const hdAfter = await exhaust(replicaB, 'humanDecisions', 4);
    expect(hdAfter.map((d) => d.allowed)).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  it('honors per-credential overrides of any class, `default` and `humanDecisions` included', async () => {
    expect(DEFAULT_CLASS_LIMITS.write).toBeGreaterThanOrEqual(300);
    await prisma.serviceCredential.update({
      where: { id: credentialId },
      data: {
        rateLimits: {
          read: 2,
          write: 'abc',
          feed: -4,
          default: 3,
          humanDecisions: 1,
        },
      },
    });

    const reads = await exhaust(replicaA, 'read', 5);
    expect(reads.filter((r) => r.allowed)).toHaveLength(2);
    // garbage overrides fall back to the caller's default
    const writes = await exhaust(replicaA, 'write', 5);
    expect(writes.filter((r) => r.allowed)).toHaveLength(5);
    const feed = await exhaust(replicaA, 'feed', 5);
    expect(feed.filter((r) => r.allowed)).toHaveLength(5);
    const defaults = await exhaust(replicaA, 'default', 60);
    expect(defaults.filter((r) => r.allowed)).toHaveLength(3);
    const hd = await exhaust(replicaB, 'humanDecisions', 60);
    expect(hd.filter((r) => r.allowed)).toHaveLength(1);
  });
});
