-- Add additive column distinguishing operator-initiated ENDED from
-- date-derived ENDED. The `status` column remains a write-through hint;
-- `manuallyEnded` is the authoritative manual override flag consulted by
-- `getEffectiveStatus()` at read time.
ALTER TABLE "promotions" ADD COLUMN     "manuallyEnded" BOOLEAN NOT NULL DEFAULT false;