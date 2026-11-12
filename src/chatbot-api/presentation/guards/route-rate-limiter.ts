import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import type { BotRouteClassName } from './route-class';
import type { RateLimitDecision } from './credential-rate-limiter';

export const ROUTE_RATE_LIMITER = Symbol('ROUTE_RATE_LIMITER');

/** The window is `interval '60 seconds'` in the statement below. */

/**
 * Per-minute budget of each new route class when the credential has no
 * override (`ServiceCredential.rateLimits`; the key of the unit 11 `control`
 * class works the same way). Dimensioned for 60 inbound
 * messages per minute per branch with headroom (§6.4, §11.1): the mirror and
 * statuses run at 300 per minute, outbound and ACKs at 180, so `write` and
 * `read` start at 300. `feed` is the long-poll's own budget (§10.1 R2): a
 * consumer opens about three polls a minute, so 120 leaves room for short
 * polls and reconnect bursts. `default` is never used here: those routes pass
 * the credential's `rateLimit`.
 */
export const DEFAULT_CLASS_LIMITS: Record<
  Exclude<BotRouteClassName, 'default' | 'humanDecisions'>,
  number
> = { write: 300, read: 300, feed: 120, control: 120 };

export interface RouteRateCheck {
  credentialId: string;
  routeClass: BotRouteClassName;
  /** The budget when the credential has no override for this class. */
  defaultLimit: number;
}

export interface RouteRateLimiter {
  check(input: RouteRateCheck): Promise<RateLimitDecision>;
}

/**
 * R2: PostgreSQL counters per (credential, route class), shared by every
 * replica. One statement reads the credential's override, resets an expired
 * window and increments, so the upsert's row lock makes concurrent checks
 * exact. The count is capped at `limit + 1` so a flood cannot overflow it. The
 * window opens at its first request and lasts one minute; `Retry-After` is the
 * time left in it.
 *
 * Every instant comes from the database clock (`now()` inside the statement,
 * as UTC wall time to match the `timestamp` column), never from the replica,
 * so replicas with skewed clocks cannot open, expire or shorten each other's
 * windows. The time left is computed in the same statement.
 */
@Injectable()
export class PostgresRouteRateLimiter implements RouteRateLimiter {
  constructor(private readonly prisma: PrismaService) {}

  async check(input: RouteRateCheck): Promise<RateLimitDecision> {
    const { credentialId, routeClass } = input;
    const rows = await this.prisma.$queryRaw<
      { count: number; limit: number; retryAfterMs: number }[]
    >(Prisma.sql`
      WITH cfg AS (
        SELECT CASE WHEN ("rateLimits" ->> ${routeClass}) ~ '^[1-9][0-9]{0,6}$'
                    THEN ("rateLimits" ->> ${routeClass})::int END AS "override"
        FROM "service_credentials" WHERE "id" = ${credentialId}
      ), lim AS (
        SELECT COALESCE((SELECT "override" FROM cfg), ${input.defaultLimit}::int) AS "limit"
      )
      INSERT INTO "service_rate_buckets" AS b ("credentialId", "routeClass", "count", "windowStart")
      VALUES (${credentialId}, ${routeClass}, 1, now() AT TIME ZONE 'UTC')
      ON CONFLICT ("credentialId", "routeClass") DO UPDATE SET
        "count" = CASE WHEN b."windowStart" <= (now() AT TIME ZONE 'UTC') - interval '60 seconds' THEN 1
                       ELSE LEAST(b."count" + 1, (SELECT "limit" FROM lim) + 1) END,
        "windowStart" = CASE WHEN b."windowStart" <= (now() AT TIME ZONE 'UTC') - interval '60 seconds' THEN now() AT TIME ZONE 'UTC'
                             ELSE b."windowStart" END
      RETURNING b."count", (SELECT "limit" FROM lim) AS "limit",
        GREATEST(0, (EXTRACT(EPOCH FROM (b."windowStart" + interval '60 seconds' - (now() AT TIME ZONE 'UTC'))) * 1000))::float8 AS "retryAfterMs"
    `);
    const row = rows[0];
    if (!row) throw new Error('Route rate bucket unavailable');
    return row.count <= row.limit
      ? { allowed: true, retryAfterMs: 0 }
      : { allowed: false, retryAfterMs: row.retryAfterMs };
  }
}
