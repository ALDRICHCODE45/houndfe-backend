-- pay-in-store-pickup / T3 — sale-level items of the bot feed
-- (`sale.pickup_reminder`, `sale.pickup_expired`, `sale.pickup_extended`).
--
-- Additive only:
--   1. "chatbot_feed_items"."requestId" becomes nullable (metadata-only) and a
--      nullable "saleId" TEXT column is added (metadata-only, no default).
--      Every existing row keeps its "requestId" and gets "saleId" NULL.
--   2. CHECK "chatbot_feed_items_subject_chk": exactly one of "requestId" /
--      "saleId" is set. Every existing row satisfies it (requestId NOT NULL
--      until this file, saleId NULL).
--   3. FK ("tenantId", "saleId") -> "sales" ("tenantId", "id"): tenant-
--      consistent, so an item can only point at a sale of its own tenant.
--      ON DELETE CASCADE like the request FK (feed items are disposable).
--   4. Partial UNIQUE index "chatbot_feed_items_sale_hold_uq" on ("tenantId",
--      "saleId", "type", payload->>'holdVersion') WHERE "saleId" IS NOT NULL:
--      one reminder / expiry / extension per sale and hold version, so a
--      retry, a second sweep replica or a repeated staff edit cannot enqueue
--      it twice (the writer inserts with ON CONFLICT DO NOTHING). It also
--      serves the FK's cascade lookup by ("tenantId", "saleId").
--
-- Locks: Prisma runs this file in ONE transaction, so every ALTER TABLE takes
-- ACCESS EXCLUSIVE on "chatbot_feed_items" until commit, and VALIDATE gives no
-- lock relief here (it would only with a separate transaction). The CHECK and
-- the FK validate with one sequential scan of "chatbot_feed_items" (the FK
-- probes "sales" only for rows with "saleId" set: none). The FK also takes
-- SHARE ROW EXCLUSIVE on "sales" for the duration (blocks sale writes, not
-- reads). The new index builds over zero matching rows. Feed items are purged
-- after 30 days, so the table is small; run it at low traffic.
-- `SET LOCAL lock_timeout` bounds every lock wait to 5 s.
--
-- Rollback (manual, only while no sale item exists):
--   DELETE FROM "chatbot_feed_items" WHERE "saleId" IS NOT NULL;
--   DROP INDEX "chatbot_feed_items_sale_hold_uq";
--   ALTER TABLE "chatbot_feed_items"
--     DROP CONSTRAINT "chatbot_feed_items_tenantId_saleId_fkey",
--     DROP CONSTRAINT "chatbot_feed_items_subject_chk",
--     DROP COLUMN "saleId",
--     ALTER COLUMN "requestId" SET NOT NULL;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "chatbot_feed_items" ALTER COLUMN "requestId" DROP NOT NULL,
ADD COLUMN "saleId" TEXT;

-- Exactly one subject per item (not expressible in schema.prisma).
ALTER TABLE "chatbot_feed_items"
  ADD CONSTRAINT "chatbot_feed_items_subject_chk"
  CHECK (num_nonnulls("requestId", "saleId") = 1) NOT VALID;
ALTER TABLE "chatbot_feed_items" VALIDATE CONSTRAINT "chatbot_feed_items_subject_chk";

-- AddForeignKey
ALTER TABLE "chatbot_feed_items"
  ADD CONSTRAINT "chatbot_feed_items_tenantId_saleId_fkey"
  FOREIGN KEY ("tenantId", "saleId") REFERENCES "sales"("tenantId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "chatbot_feed_items" VALIDATE CONSTRAINT "chatbot_feed_items_tenantId_saleId_fkey";

-- CreateIndex (partial, expression; not expressible in schema.prisma, the
-- migration is authoritative)
CREATE UNIQUE INDEX "chatbot_feed_items_sale_hold_uq"
  ON "chatbot_feed_items" ("tenantId", "saleId", "type", (("payload" ->> 'holdVersion')))
  WHERE "saleId" IS NOT NULL;
