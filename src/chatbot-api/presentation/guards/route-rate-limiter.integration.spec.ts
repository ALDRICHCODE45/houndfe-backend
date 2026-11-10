/**
 * R2 against real PostgreSQL: the counters live in `service_rate_buckets`, so
 * two limiter instances (two replicas) share one budget per
 * (credential, route class).
 */
import { randomUUID } from 'crypto';
import { integrationPrisma } from '../../../../test/integration/reset-db';
import type { PrismaService } from '../../../shared/prisma/prisma.service';
import type { RateLimitDecision } from './credential-rate-limiter';
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
  const credentialId = randomUUID();
  const t0 = new Date('2026-11-10T12:00:00.000Z');
  const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

  beforeAll(async () => {
    await prisma.tenant.create({
      data: { id: tenantId, name: 'Rate', slug: `rate-${tenantId}` },
    });
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

  afterAll(async () => {
    await prisma.serviceRateBucket.deleteMany({ where: { credentialId } });
  });

  const spend = (
    limiter: PostgresRouteRateLimiter,
    routeClass: 'default' | 'write' | 'read' | 'feed',
    over: { defaultLimit?: number; now?: Date } = {},
  ) =>
    limiter.check({
      credentialId,
      routeClass,
      defaultLimit: over.defaultLimit ?? 5,
      now: over.now,
    });

  it('shares one budget between two instances under concurrency', async () => {
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        spend(i % 2 ? replicaA : replicaB, 'default', { now: at(0) }),
      ),
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(results.filter((r) => !r.allowed)).toHaveLength(19);
  });

  it('answers Retry-After from the window start and resets after the window', async () => {
    const blocked = await spend(replicaA, 'default', { now: at(20) });
    expect(blocked).toEqual({ allowed: false, retryAfterMs: 40_000 });

    const next = await spend(replicaB, 'default', { now: at(61) });
    expect(next).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it('keeps a bucket per route class', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await spend(replicaA, 'feed', { now: at(100) })).allowed).toBe(
        true,
      );
    }
    expect((await spend(replicaA, 'feed', { now: at(100) })).allowed).toBe(
      false,
    );
    expect((await spend(replicaA, 'write', { now: at(100) })).allowed).toBe(
      true,
    );
  });

  it('uses the class default of the caller unless the credential overrides it', async () => {
    expect(DEFAULT_CLASS_LIMITS.write).toBeGreaterThanOrEqual(300);
    await prisma.serviceCredential.update({
      where: { id: credentialId },
      data: { rateLimits: { read: 2, write: 'abc', feed: -4 } },
    });

    const reads: RateLimitDecision[] = [];
    for (let i = 0; i < 3; i++) {
      reads.push(await spend(replicaA, 'read', { now: at(200) }));
    }
    expect(reads.map((r) => r.allowed)).toEqual([true, true, false]);

    // garbage overrides fall back to the caller's default
    const writes: RateLimitDecision[] = [];
    for (let i = 0; i < 6; i++) {
      writes.push(await spend(replicaA, 'write', { now: at(200) }));
    }
    expect(writes.filter((r) => r.allowed)).toHaveLength(5);
  });
});
