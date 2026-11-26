-- customer-collection / T2 (contract v1 §5) — «Cobrar todo»: one payment
-- spread over several open-debt sales of one customer.
--
-- Additive only, hand-written (the shared test database is never diffed):
--   1. "sale_collections": one row per collection with the totals, the change
--      (stored here, never on a sale, so cancelling a sale later never refunds
--      it) and "tendersJson" (the tenders as entered, written once).
--      FKs: tenant ON DELETE CASCADE; customer ON DELETE SET NULL (same as
--      "sales"."customerId": deleting the customer keeps the money history);
--      cash session (tenantId, id) NO ACTION (a session with collections is
--      never deleted; the tenant cascade still removes both because NO ACTION
--      is checked at statement end). "actorUserId" is an audit id without FK.
--   2. "sale_payments"."collectionId": nullable FK to "sale_collections",
--      NO ACTION on delete — a collection can never be deleted while one of
--      its payments exists, so payments never disappear nor lose their group
--      (SET NULL would silently drop the grouping; CASCADE would delete money).
--      Every existing row gets NULL (metadata-only ADD COLUMN, no rewrite).
--      The index serves the collection read (T3) and the FK check.
--   3. CHECKs mirroring the service rules: amounts >= 0, applied > 0,
--      tendered = applied + change.
--
-- Locks: Prisma runs this file in ONE transaction. ADD COLUMN takes a brief
-- ACCESS EXCLUSIVE lock on "sale_payments"; the FK validation scans it once
-- (every "collectionId" is NULL) and the index build blocks writes on it for
-- its duration; run at low traffic.
--
-- Rollback (manual, only while no collection exists or after exporting them):
--   DROP INDEX "sale_payments_collectionId_idx";
--   ALTER TABLE "sale_payments"
--     DROP CONSTRAINT "sale_payments_collectionId_fkey",
--     DROP COLUMN "collectionId";
--   DROP TABLE "sale_collections";

-- CreateTable
CREATE TABLE "sale_collections" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT,
    "actorUserId" TEXT NOT NULL,
    "cashSessionId" TEXT NOT NULL,
    "tenderedCents" INTEGER NOT NULL,
    "appliedCents" INTEGER NOT NULL,
    "changeDueCents" INTEGER NOT NULL,
    "tendersJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_collections_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sale_collections_amounts_chk" CHECK (
        "appliedCents" > 0
        AND "changeDueCents" >= 0
        AND "tenderedCents" = "appliedCents" + "changeDueCents"
    )
);

-- CreateIndex
CREATE INDEX "sale_collections_tenantId_customerId_createdAt_idx" ON "sale_collections"("tenantId", "customerId", "createdAt");

-- CreateIndex
CREATE INDEX "sale_collections_tenantId_cashSessionId_idx" ON "sale_collections"("tenantId", "cashSessionId");

-- AddForeignKey
ALTER TABLE "sale_collections" ADD CONSTRAINT "sale_collections_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_collections" ADD CONSTRAINT "sale_collections_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_collections" ADD CONSTRAINT "sale_collections_tenantId_cashSessionId_fkey" FOREIGN KEY ("tenantId", "cashSessionId") REFERENCES "cash_sessions"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "sale_payments" ADD COLUMN "collectionId" TEXT;

-- CreateIndex
CREATE INDEX "sale_payments_collectionId_idx" ON "sale_payments"("collectionId");

-- AddForeignKey
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "sale_collections"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
