import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma, LoginOtpChallenge } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';

const WINDOW_MS = 15 * 60 * 1000;
export type OtpIdentity = { id: string; email: string };
export type OtpReservation = {
  userId: string;
  generation: string;
  handleHash: string;
  createCodeMac: (identity: OtpIdentity) => string;
  expectedHandleHash?: string;
};
export type ReserveResult =
  | { kind: 'ok'; email: string }
  | { kind: 'invalid' }
  | { kind: 'limited'; retryAfter: number };

/** Hash all durable bucket keys, including normalized unknown email addresses. */
export function otpBucketKey(purpose: string, value: string): string {
  return createHash('sha256')
    .update(JSON.stringify([purpose, value]))
    .digest('hex');
}

@Injectable()
export class PrismaLoginOtpRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByHandle(handleHash: string) {
    return this.prisma.loginOtpChallenge.findUnique({ where: { handleHash } });
  }

  /**
   * The upsert locks the conflicting bucket row. Reset and increment are one
   * statement, so concurrent first requests cannot reset each other's counts.
   * Saturation keeps counts bounded without ever admitting an excess request.
   */
  private async consumeBucket(
    tx: Prisma.TransactionClient,
    key: string,
    limit: number,
    now: Date,
  ): Promise<number> {
    const cutoff = new Date(now.getTime() - WINDOW_MS);
    const rows = await tx.$queryRaw<
      { count: number; windowStart: Date }[]
    >(Prisma.sql`
      INSERT INTO "auth_rate_buckets" ("key", "count", "windowStart")
      VALUES (${key}, 1, ${now})
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "auth_rate_buckets"."windowStart" <= ${cutoff}
          THEN 1 ELSE LEAST("auth_rate_buckets"."count" + 1, ${limit + 1}) END,
        "windowStart" = CASE WHEN "auth_rate_buckets"."windowStart" <= ${cutoff}
          THEN ${now} ELSE "auth_rate_buckets"."windowStart" END
      RETURNING "count", "windowStart"
    `);
    const row = rows[0];
    if (!row) throw new Error('Rate bucket unavailable');
    return row.count <= limit
      ? 0
      : Math.max(
          1,
          Math.ceil(
            (row.windowStart.getTime() + WINDOW_MS - now.getTime()) / 1000,
          ),
        );
  }

  consumeRequestBudget(key: string, limit: number): Promise<number> {
    return this.prisma.$transaction((tx) =>
      this.consumeBucket(tx, key, limit, new Date()),
    );
  }

  private async lockUser(tx: Prisma.TransactionClient, userId: string) {
    // User.id is Prisma String / PostgreSQL TEXT; do not cast it to UUID.
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE`,
    );
    return tx.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, isActive: true },
    });
  }

  reserve(input: OtpReservation): Promise<ReserveResult> {
    return this.prisma.$transaction(async (tx): Promise<ReserveResult> => {
      const user = await this.lockUser(tx, input.userId);
      if (!user?.isActive) return { kind: 'invalid' };
      const now = new Date();
      const previous = await tx.loginOtpChallenge.findUnique({
        where: { userId: user.id },
      });
      if (
        input.expectedHandleHash &&
        (!previous ||
          previous.handleHash !== input.expectedHandleHash ||
          previous.state !== 'ACTIVE' ||
          previous.expiresAt <= now)
      ) {
        return { kind: 'invalid' };
      }
      const cooldown = previous
        ? Math.ceil(
            (previous.createdAt.getTime() + 60_000 - now.getTime()) / 1000,
          )
        : 0;
      if (cooldown > 0) return { kind: 'limited', retryAfter: cooldown };
      const retryAfter = await this.consumeBucket(
        tx,
        otpBucketKey('issue', user.id),
        3,
        now,
      );
      if (retryAfter) return { kind: 'limited', retryAfter };
      const data = {
        generation: input.generation,
        handleHash: input.handleHash,
        codeMac: input.createCodeMac({ id: user.id, email: user.email }),
        state: 'PENDING' as const,
        expiresAt: new Date(now.getTime() + 600_000),
        createdAt: now,
        consumedAt: null,
      };
      await tx.loginOtpChallenge.upsert({
        where: { userId: user.id },
        create: { userId: user.id, ...data },
        update: data,
      });
      return { kind: 'ok', email: user.email };
    });
  }

  complete(
    userId: string,
    generation: string,
    delivered: boolean,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const user = await this.lockUser(tx, userId);
      const now = new Date();
      const challenge = await tx.loginOtpChallenge.findUnique({
        where: { userId },
      });
      if (
        !challenge ||
        challenge.generation !== generation ||
        challenge.state !== 'PENDING'
      )
        return false;
      const active = delivered && !!user?.isActive && challenge.expiresAt > now;
      await tx.loginOtpChallenge.update({
        where: { userId },
        // Before activation expiresAt bounds pending delivery. Once activated,
        // createdAt anchors the advertised cooldown and expiresAt the full TTL.
        // Account rate windows remain anchored to their original reservations.
        data: active
          ? {
              state: 'ACTIVE',
              createdAt: now,
              expiresAt: new Date(now.getTime() + 600_000),
            }
          : { state: 'FAILED' },
      });
      return active;
    });
  }

  async verify(
    handleHash: string,
    matches: (challenge: LoginOtpChallenge, identity: OtpIdentity) => boolean,
  ): Promise<OtpIdentity | null> {
    const found = await this.findByHandle(handleHash);
    if (!found) return null;
    return this.prisma.$transaction(async (tx) => {
      const user = await this.lockUser(tx, found.userId);
      const now = new Date();
      // Count even wrong, expired and consumed submissions for a known account.
      // Return an outcome, NEVER throw 401 here: counters must commit.
      const limited = await this.consumeBucket(
        tx,
        otpBucketKey('verify', found.userId),
        5,
        now,
      );
      const current = await tx.loginOtpChallenge.findUnique({
        where: { userId: found.userId },
      });
      if (
        limited ||
        !user?.isActive ||
        !current ||
        current.handleHash !== handleHash ||
        current.state !== 'ACTIVE' ||
        current.expiresAt <= now ||
        !matches(current, { id: user.id, email: user.email })
      )
        return null;
      await tx.loginOtpChallenge.update({
        where: { userId: user.id },
        data: { state: 'CONSUMED', consumedAt: now },
      });
      return { id: user.id, email: user.email };
    });
  }
}
