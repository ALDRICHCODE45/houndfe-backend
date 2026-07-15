-- Slice 2 / WU5 — D4 wire discriminator (design.md Decision 4;
-- spec.md MODIFIED Requirement: `rewardKind: 'advanced'` Wire Discriminator).
-- The column-derived `isBuyXGetYReward()` predicate (prePriceCentsBeforeDiscount
-- === unitPriceCents + promotionId set + discountAmountCents > 0) is byte-
-- identical for BUY_X_GET_Y and ADVANCED lines — both reuse the
-- `applyBuyXGetYReward` rail. Without a persisted discriminator, the
-- receipt mapper cannot distinguish an ADVANCED row from a BXGY row
-- (the Slice 1 stub at sales.service.ts:515-525 silently relabeled both
-- kinds as BXGY on the wire). This migration is fully additive:
-- new enum type + nullable column + backfill of all existing reward rows
-- to BUY_X_GET_Y. Reversible (DROP COLUMN + DROP TYPE).

-- CreateEnum
CREATE TYPE "SaleItemRewardKind" AS ENUM ('BUY_X_GET_Y', 'ADVANCED');

-- AlterTable
ALTER TABLE "sale_items" ADD COLUMN     "rewardKind" "SaleItemRewardKind";

-- Backfill: every reward-shaped row in the DB today is BXGY by definition
-- (the ADVANCED engine pass was previously rejected at the engine gate;
-- Slice 1 lifted the gate but no rows have yet been written by the WU6
-- ADVANCED arm — this migration is the only writer at migrate-deploy time).
-- The same predicate the receipt mapper reads (prePriceCentsBeforeDiscount
-- is set, equals unitPriceCents, and discountAmountCents > 0). Rows with
-- `promotionId IS NULL` (manual free-form) are NOT reward rows and stay
-- NULL — the wire must keep emitting rewardKind=null on those.
UPDATE "sale_items"
SET    "rewardKind" = 'BUY_X_GET_Y'
WHERE  "promotionId" IS NOT NULL
  AND  "prePriceCentsBeforeDiscount" IS NOT NULL
  AND  "unitPriceCents" = "prePriceCentsBeforeDiscount"
  AND  "discountAmountCents" IS NOT NULL
  AND  "discountAmountCents" > 0;
