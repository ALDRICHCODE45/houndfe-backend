import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import type { BotRouteClassName } from './route-class';
import type { RateLimitDecision } from './credential-rate-limiter';

export const ROUTE_RATE_LIMITER = Symbol('ROUTE_RATE_LIMITER');

const WINDOW_MS = 60_000;

/**
 * Per-minute budget of each new route class when the credential has no
 * override (`ServiceCredential.rateLimits`). Dimensioned for 60 inbound
 * messages per minute per branch with headroom (§6.4, §11.1): the mirror and
 * statuses run at 300 per minute, outbound and ACKs at 180, so `write` and
 * `read` start at 300. `feed` is the long-poll's own budget (§10.1 R2): a
 * consumer opens about three polls a minute, so 120 leaves room for short
 * polls and reconnect bursts. `default` is never used here: those routes pass
 * the credential's `rateLimit`.
 */
export const DEFAULT_CLASS_LIMITS: Record<
  Exclude<BotRouteClassName, 'default'>,
  number
> = { write: 300, read: 300, feed: 120 };

export interface RouteRateCheck {
  credentialId: string;
  routeClass: BotRouteClassName;
  /** The budget when the credential has no override for this class. */
  defaultLimit: number;
  now?: Date;
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
 */
@Injectable()
export class PostgresRouteRateLimiter implements RouteRateLimiter {
  constructor(private readonly prisma: PrismaService) {}

  async check(input: RouteRateCheck): Promise<RateLimitDecision> {
    const { credentialId, routeClass } = input;
    const now = input.now ?? new Date();
    const cutoff = new Date(now.getTime() - WINDOW_MS);
    const rows = await this.prisma.$queryRaw<
      { count: number; windowStart: Date; limit: number }[]
    >(Prisma.sql`
      WITH cfg AS (
        SELECT CASE WHEN ("rateLimits" ->> ${routeClass}) ~ '^[1-9][0-9]{0,6}$'
                    THEN ("rateLimits" ->> ${routeClass})::int END AS "override"
        FROM "service_credentials" WHERE "id" = ${credentialId}
      ), lim AS (
        SELECT COALESCE((SELECT "override" FROM cfg), ${input.defaultLimit}::int) AS "limit"
      )
      INSERT INTO "service_rate_buckets" AS b ("credentialId", "routeClass", "count", "windowStart")
      VALUES (${credentialId}, ${routeClass}, 1, ${now})
      ON CONFLICT ("credentialId", "routeClass") DO UPDATE SET
        "count" = CASE WHEN b."windowStart" <= ${cutoff} THEN 1
                       ELSE LEAST(b."count" + 1, (SELECT "limit" FROM lim) + 1) END,
        "windowStart" = CASE WHEN b."windowStart" <= ${cutoff} THEN ${now}
                             ELSE b."windowStart" END
      RETURNING b."count", b."windowStart", (SELECT "limit" FROM lim) AS "limit"
    `);
    const row = rows[0];
    if (!row) throw new Error('Route rate bucket unavailable');
    if (row.count <= row.limit) return { allowed: true, retryAfterMs: 0 };
    return {
      allowed: false,
      retryAfterMs: Math.max(
        0,
        row.windowStart.getTime() + WINDOW_MS - now.getTime(),
      ),
    };
  }
}
