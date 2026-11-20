-- restock-backorder / T2b — backorder-level items of the bot feed
-- (`backorder.reserved`, `backorder.reservation_reminder`,
-- `backorder.reservation_expired`, `backorder.cancelled_by_staff`,
-- `backorder.eta_updated`, `backorder.eta_unavailable`,
-- `backorder.reservation_lost`; contract v1 §10), the new terminal feed outcome
-- `PROVIDER_REJECTED` and the two partial indexes of the backorder sweep.
--
-- Additive only, hand-written (the shared test database is never diffed):
--   1. "chatbot_feed_items": nullable "backorderId" TEXT and nullable
--      "outcomeReason" VARCHAR(280) (both metadata-only, no default). Every
--      existing row keeps its subject and gets both NULL.
--   2. CHECK "chatbot_feed_items_subject_chk" is WIDENED to exactly one of
--      "requestId" / "saleId" / "backorderId". Every existing row satisfies it
--      (requestId XOR saleId today, backorderId NULL). The old constraint is
--      dropped and the new one added in this same transaction, so there is no
--      window without a subject guarantee.
--   3. CHECK "chatbot_feed_items_outcome_reason_chk": a reason only exists for
--      a PROVIDER_REJECTED outcome. Existing rows have no reason.
--   4. FK ("tenantId", "backorderId") -> "backorders" ("tenantId", "id"):
--      tenant-consistent, so an item can only point at a backorder of its own
--      tenant (MATCH SIMPLE skips it while "backorderId" is NULL). ON DELETE
--      CASCADE like the request and sale FKs: feed items are disposable, and a
--      backorder only disappears with its customer (T1b) or its tenant.
--   5. Partial UNIQUE index "chatbot_feed_items_backorder_stage_uq" on
--      ("tenantId", "backorderId", "type", payload->>'version') WHERE
--      "backorderId" IS NOT NULL: exactly one item per backorder, type and
--      backorder `version`, so a retry, a second sweep replica or a repeated
--      call cannot enqueue it twice (the writer inserts with ON CONFLICT DO
--      NOTHING) while a second reservation of the same backorder after
--      `backorder.reservation_lost` (a later version) is a new item. It also
--      serves the FK's cascade lookup and the recovery pointer.
--   6. Partial index "backorders_reservation_due_idx" on ("reservedUntil", "id")
--      WHERE "status" = 'RESERVED' AND "reservationStage" < 2: the sweep's due
--      candidates (reminder and expiry) and the lot-expiry scan read only
--      RESERVED rows, oldest deadline first.
--   7. Partial index "backorders_waiting_idx" on ("tenantId", "productId",
--      "variantId") WHERE "status" = 'WAITING': the sweep's safety-net
--      allocation lists the products that have a queue without scanning
--      terminal backorders.
--
-- Locks: Prisma runs this file in ONE transaction, so every ALTER TABLE takes
-- ACCESS EXCLUSIVE on "chatbot_feed_items" until commit; the CHECKs and the FK
-- validate with one sequential scan of that table (the FK probes "backorders"
-- only for rows with "backorderId" set: none). The FK also takes SHARE ROW
-- EXCLUSIVE on "backorders" and the two indexes on "backorders" take SHARE (they
-- block backorder writes, not reads) for their build. Feed items are purged
-- after 30 days and backorders are few, so both are small; run it at low
-- traffic. `SET LOCAL lock_timeout` bounds every lock wait to 5 s.
--
-- Rollback (manual, only while no backorder item exists):
--   DELETE FROM "chatbot_feed_items" WHERE "backorderId" IS NOT NULL;
--   DROP INDEX "backorders_waiting_idx";
--   DROP INDEX "backorders_reservation_due_idx";
--   DROP INDEX "chatbot_feed_items_backorder_stage_uq";
--   ALTER TABLE "chatbot_feed_items"
--     DROP CONSTRAINT "chatbot_feed_items_tenantId_backorderId_fkey",
--     DROP CONSTRAINT "chatbot_feed_items_outcome_reason_chk",
--     DROP CONSTRAINT "chatbot_feed_items_subject_chk",
--     DROP COLUMN "outcomeReason",
--     DROP COLUMN "backorderId";
--   ALTER TABLE "chatbot_feed_items"
--     ADD CONSTRAINT "chatbot_feed_items_subject_chk"
--     CHECK (num_nonnulls("requestId", "saleId") = 1);
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "chatbot_feed_items"
  ADD COLUMN "backorderId" TEXT,
  ADD COLUMN "outcomeReason" VARCHAR(280);

-- Exactly one subject per item (not expressible in schema.prisma): widened.
ALTER TABLE "chatbot_feed_items" DROP CONSTRAINT "chatbot_feed_items_subject_chk";
ALTER TABLE "chatbot_feed_items"
  ADD CONSTRAINT "chatbot_feed_items_subject_chk"
  CHECK (num_nonnulls("requestId", "saleId", "backorderId") = 1) NOT VALID;
ALTER TABLE "chatbot_feed_items" VALIDATE CONSTRAINT "chatbot_feed_items_subject_chk";

-- Only a PROVIDER_REJECTED outcome carries a reason.
ALTER TABLE "chatbot_feed_items"
  ADD CONSTRAINT "chatbot_feed_items_outcome_reason_chk"
  CHECK ("outcomeReason" IS NULL OR "outcome" = 'PROVIDER_REJECTED') NOT VALID;
ALTER TABLE "chatbot_feed_items" VALIDATE CONSTRAINT "chatbot_feed_items_outcome_reason_chk";

-- AddForeignKey (tenant-qualified)
ALTER TABLE "chatbot_feed_items"
  ADD CONSTRAINT "chatbot_feed_items_tenantId_backorderId_fkey"
  FOREIGN KEY ("tenantId", "backorderId") REFERENCES "backorders"("tenantId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "chatbot_feed_items" VALIDATE CONSTRAINT "chatbot_feed_items_tenantId_backorderId_fkey";

-- CreateIndex (partial, expression; not expressible in schema.prisma, the
-- migration is authoritative)
CREATE UNIQUE INDEX "chatbot_feed_items_backorder_stage_uq"
  ON "chatbot_feed_items" ("tenantId", "backorderId", "type", (("payload" ->> 'version')))
  WHERE "backorderId" IS NOT NULL;

-- CreateIndex (partial; the sweep's due candidates)
CREATE INDEX "backorders_reservation_due_idx"
  ON "backorders" ("reservedUntil", "id")
  WHERE "status" = 'RESERVED' AND "reservationStage" < 2;

-- CreateIndex (partial; the sweep's products with a queue)
CREATE INDEX "backorders_waiting_idx"
  ON "backorders" ("tenantId", "productId", "variantId")
  WHERE "status" = 'WAITING';
