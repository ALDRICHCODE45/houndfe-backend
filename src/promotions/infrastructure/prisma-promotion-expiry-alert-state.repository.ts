/**
 * ADAPTER: PrismaPromotionExpiryAlertStateRepository — pca-3c1a.
 *
 * Implements `IPromotionExpiryAlertStateRepository` over the global
 * `PrismaService` (`$transaction`, not an ambient one): the expiry scanner
 * (`pca-3c2`) runs outside the HTTP CLS context, so there is no ambient
 * transaction and no tenant extension to inherit. The caller's explicit
 * `tenantId` is the only tenant authority, and because raw statements bypass
 * the tenant extension EVERY statement carries `"tenantId"` explicitly.
 *
 * One transaction does all four steps: locked re-read, post-lock clock read,
 * revalidation, and seed + guarded flip, then the outbox publish. A stale
 * scanner id is therefore harmless — the locked row reflects whatever the last
 * committed promotion edit wrote, so an edited (or ended, or deleted) promotion
 * can never publish an obsolete date.
 *
 * `FOR UPDATE` on the `promotions` row makes the promotion-edit path and the
 * claim serialize against each other: the claim either reads the pre-edit row
 * and blocks the edit until it commits, or reads the post-edit row. Two
 * concurrent claims for the same promotion serialize the same way, and the
 * losing one finds `alerted = TRUE` and returns `already_alerted`.
 *
 * The eligibility instant is deliberately NOT taken from the locked SELECT.
 * `NOW()` (a.k.a. `transaction_timestamp()`) is fixed at `BEGIN`, so a claim
 * that waits on the row lock behind another transaction would still read the
 * pre-wait instant and could publish an alert for a promotion that expired
 * during the wait. The claim therefore reads `clock_timestamp()` in a SEPARATE
 * statement on the SAME transaction, executed only after the lock was granted,
 * and evaluates `startDate`/`endDate`/window against that later instant.
 *
 * Raw SQL is required because Prisma cannot `RETURNING` from `updateMany`, and
 * `endDateFingerprint` identity must be read from the same locked row that was
 * validated. Prisma reconstructs raw timestamp columns from the statement's
 * column metadata, so `SELECT "endDate"` and `clock_timestamp()` come back as
 * JS `Date`s; `pca-3c1b` proves the same statements against real PostgreSQL.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { OutboxWriterService } from '../../shared/outbox/outbox-writer.service';
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import {
  PROMOTION_EXPIRY_ALERT_WINDOW_MS,
  type IPromotionExpiryAlertStateRepository,
  type PromotionExpiryAlertClaim,
  type PromotionExpiryAlertClaimResult,
  type PromotionExpiryAlertIneligibleReason,
} from '../domain/promotion-expiry-alert-state.repository';
import { PROMOTION_EXPIRING_EVENT_TYPE } from '../outbox/promotion-expiry-outbox.types';

/** The locked `promotions` projection the claim revalidates. */
type LockedPromotionRow = {
  startDate: Date | null;
  endDate: Date | null;
  manuallyEnded: boolean;
};

/** Revalidation verdict; the eligible branch carries the narrowed end date. */
type EligibilityDecision =
  | { eligible: true; endDate: Date }
  | { eligible: false; reason: PromotionExpiryAlertIneligibleReason };

/**
 * Effective-ACTIVE revalidation for the freshly locked row and the instant
 * read AFTER the lock. Dates — not the `status` column, which can be stale
 * after a date edit — decide ACTIVE, and `manuallyEnded` is the permanent
 * operator override. The window is `(readAt, readAt + 7d]`, so a promotion
 * ending exactly at the threshold is still eligible and one ending at (or
 * before) the read instant is already expired.
 */
function evaluateEligibility(
  row: LockedPromotionRow,
  readAt: Date,
): EligibilityDecision {
  if (row.manuallyEnded) {
    return { eligible: false, reason: 'manually_ended' };
  }
  const readAtMs = readAt.getTime();
  if (row.startDate !== null && row.startDate.getTime() > readAtMs) {
    return { eligible: false, reason: 'not_started' };
  }
  if (row.endDate === null) {
    return { eligible: false, reason: 'end_date_missing' };
  }
  const endDateMs = row.endDate.getTime();
  if (endDateMs <= readAtMs) {
    return { eligible: false, reason: 'expired' };
  }
  if (endDateMs > readAtMs + PROMOTION_EXPIRY_ALERT_WINDOW_MS) {
    return { eligible: false, reason: 'end_date_out_of_window' };
  }
  return { eligible: true, endDate: row.endDate };
}

@Injectable()
export class PrismaPromotionExpiryAlertStateRepository implements IPromotionExpiryAlertStateRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outboxWriter: OutboxWriterService,
  ) {}

  async claimExpiryAlert(
    claim: PromotionExpiryAlertClaim,
  ): Promise<PromotionExpiryAlertClaimResult> {
    this.validateClaim(claim);
    const { tenantId, promotionId } = claim;

    return this.prisma.$transaction<PromotionExpiryAlertClaimResult>(
      async (tx) => {
        const locked = await tx.$queryRaw<LockedPromotionRow[]>(Prisma.sql`
          SELECT "startDate", "endDate", "manuallyEnded"
            FROM "promotions"
           WHERE "id" = ${promotionId} AND "tenantId" = ${tenantId}
           FOR UPDATE
        `);
        const row = locked[0];
        if (row === undefined) {
          // Also the cross-tenant case: the predicate is tenant-qualified.
          return { outcome: 'not_eligible', reason: 'promotion_not_found' };
        }

        // The row lock is now held. `NOW()`/`transaction_timestamp()` would
        // still report the transaction's START instant — which can predate the
        // end date this statement just waited behind — so the eligibility
        // instant must come from a separate, volatile statement executed only
        // after the lock. `clock_timestamp()` reports this statement's
        // wall-clock instant, at or after the moment the locked row became
        // observable here.
        const clock = await tx.$queryRaw<Array<{ readAt: Date }>>(Prisma.sql`
          SELECT clock_timestamp() AS "readAt"
        `);
        const readAt = clock[0].readAt;

        const decision = evaluateEligibility(row, readAt);
        if (!decision.eligible) {
          return { outcome: 'not_eligible', reason: decision.reason };
        }

        // Identity is the persisted end date itself: no hashing, so returning
        // to a previously alerted date reuses that row and stays deduped.
        const endDateFingerprint = decision.endDate.toISOString();

        // Seed an armed row. `updatedAt` has no DB default and is NOT NULL, and
        // raw SQL bypasses Prisma's `@updatedAt`, so it is supplied via NOW().
        await tx.$queryRaw(Prisma.sql`
          INSERT INTO "promotion_expiry_alert_states"
            ("id", "tenantId", "promotionId", "endDateFingerprint", "alerted", "alertEpoch", "createdAt", "updatedAt")
          VALUES
            (${randomUUID()}, ${tenantId}, ${promotionId}, ${endDateFingerprint}, FALSE, 0, NOW(), NOW())
          ON CONFLICT ("tenantId", "promotionId", "endDateFingerprint") DO NOTHING
        `);

        // Flip gate: exactly one claim of this fingerprint owns the alert.
        const flipped = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          UPDATE "promotion_expiry_alert_states"
             SET "alerted" = TRUE, "alertEpoch" = "alertEpoch" + 1, "alertedAt" = NOW(), "updatedAt" = NOW()
           WHERE "tenantId" = ${tenantId}
             AND "promotionId" = ${promotionId}
             AND "endDateFingerprint" = ${endDateFingerprint}
             AND "alerted" = FALSE
          RETURNING "id"
        `);
        if (flipped.length !== 1) {
          return {
            outcome: 'already_alerted',
            endDate: endDateFingerprint,
            endDateFingerprint,
          };
        }

        // Same transaction as the flip: the event and the state row commit or
        // roll back together, so delivery can never observe one without the other.
        await this.outboxWriter.publish(
          tx,
          tenantId,
          'Promotion',
          promotionId,
          PROMOTION_EXPIRING_EVENT_TYPE,
          {
            tenantId,
            promotionId,
            endDate: endDateFingerprint,
            endDateFingerprint,
            occurredAt: readAt.toISOString(),
          },
        );

        return {
          outcome: 'claimed',
          endDate: endDateFingerprint,
          endDateFingerprint,
        };
      },
    );
  }

  private validateClaim(claim: PromotionExpiryAlertClaim): void {
    if (!claim.tenantId || !claim.promotionId) {
      throw new InvalidArgumentError(
        'Promotion expiry alert claims require a non-empty tenantId and promotionId',
        'PROMOTION_EXPIRY_ALERT_CLAIM_INVALID',
      );
    }
  }
}
